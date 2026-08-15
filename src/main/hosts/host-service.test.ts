import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SSH_ERROR_CODES,
  type HostInput,
  type HostProfile,
  type SshConnectRequest,
} from '../../shared/host';
import type { TerminalDescriptor } from '../../shared/terminal';
import type { SecretStore } from '../providers/secret-store';
import type { SessionManager } from '../sessions/session-manager';
import type { TerminalService } from '../terminal/terminal-service';
import { HostCredentialStore, hostCredentialReference } from './host-credential-store';
import { HostService } from './host-service';
import { HostStore } from './host-store';

const temporaryDirectories: string[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

class TrackingSecretStore implements SecretStore {
  readonly values = new Map<string, string>();
  readonly order: string[];
  failSet = false;
  failRemove = false;

  constructor(order: string[]) {
    this.order = order;
  }

  async get(reference: string): Promise<string | undefined> {
    return this.values.get(reference);
  }

  async set(reference: string, secret: string): Promise<void> {
    this.order.push('credential-set');
    if (this.failSet) throw new Error('credential set failed');
    this.values.set(reference, secret);
  }

  async remove(reference: string): Promise<void> {
    this.order.push('credential-remove');
    if (this.failRemove) throw new Error('credential remove failed');
    this.values.delete(reference);
  }
}

function fixture(input: Partial<HostInput> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ai-terminal-host-service-'));
  temporaryDirectories.push(directory);
  const filePath = join(directory, 'hosts.json');
  const hosts = new HostStore(filePath);
  const host = hosts.save({
    name: 'Ubuntu Lab',
    hostname: '192.168.31.93',
    port: 22,
    username: 'zjn',
    authMethod: 'password',
    ...input,
  });
  const order: string[] = [];
  const secrets = new TrackingSecretStore(order);
  const credentials = new HostCredentialStore(secrets);
  const descriptor: TerminalDescriptor = {
    id: 'terminal-1',
    title: 'Ubuntu Lab',
    profileId: `ssh:${host.id}`,
    shellKind: 'posix',
    transport: 'ssh',
    hostId: host.id,
  };
  const createSsh = vi.fn(async (
    _owner: WebContents,
    _host: HostProfile,
    _request: SshConnectRequest,
  ) => {
    order.push('terminal-ready');
    return { descriptor, fingerprint: 'SHA256:test' };
  });
  const reconnect = vi.fn(() => {
    order.push('session-bound');
    return undefined;
  });
  const close = vi.fn();
  const service = new HostService(
    hosts,
    credentials,
    { createSsh, close } as unknown as Pick<TerminalService, 'createSsh' | 'close'>,
    { reconnect } as unknown as Pick<SessionManager, 'reconnect'>,
  );
  const owner = { id: 42 } as WebContents;
  return {
    filePath,
    host,
    hosts,
    secrets,
    credentials,
    createSsh,
    close,
    reconnect,
    service,
    owner,
    order,
    descriptor,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('HostService SSH credentials', () => {
  it('uses an active stored password when the request password is empty', async () => {
    const current = fixture();
    const reference = await current.credentials.set(current.host.id, 'stored-password');
    current.hosts.configureCredential(current.host.id, reference);
    current.order.length = 0;

    const result = await current.service.connect(current.owner, {
      hostId: current.host.id,
      password: '',
      saveCredential: true,
    });

    expect(result.status).toBe('connected');
    expect(current.createSsh.mock.calls[0]?.[2]).toMatchObject({
      hostId: current.host.id,
      password: 'stored-password',
    });
    expect(current.createSsh.mock.calls[0]?.[1]).not.toHaveProperty('credentialReference');
    expect(JSON.stringify(current.service.list())).not.toContain('stored-password');
    expect(JSON.stringify(current.service.list())).not.toContain(reference);
    expect(current.order).toEqual(['terminal-ready']);
  });

  it('does not persist an explicitly supplied password without saveCredential', async () => {
    const current = fixture();
    await current.service.connect(current.owner, {
      hostId: current.host.id,
      password: 'connection-only-password',
      saveCredential: false,
    });

    expect(current.secrets.values.size).toBe(0);
    expect(current.hosts.get(current.host.id).credentialConfigured).toBe(false);
  });

  it('persists only after SSH is ready and the requested Session is bound', async () => {
    const current = fixture();
    const result = await current.service.connect(current.owner, {
      hostId: current.host.id,
      sessionId: 'session-1',
      password: 'new-password',
      saveCredential: true,
    });

    expect(result).toMatchObject({ status: 'connected', terminal: { id: 'terminal-1' } });
    expect(result).not.toHaveProperty('credentialWarning');
    expect(current.order).toEqual(['terminal-ready', 'session-bound', 'credential-set']);
    expect(current.hosts.get(current.host.id).credentialConfigured).toBe(true);
    expect(current.hosts.get(current.host.id)).not.toHaveProperty('credentialReference');
    expect(readFileSync(current.filePath, 'utf8')).not.toContain('new-password');
    expect(readFileSync(current.filePath, 'utf8')).toContain(`AI Terminal/ssh/${current.host.id}`);
  });

  it('does not save on SSH failure or a host-key challenge', async () => {
    const failed = fixture();
    failed.createSsh.mockRejectedValueOnce(new Error('authentication failed'));
    await expect(failed.service.connect(failed.owner, {
      hostId: failed.host.id,
      password: 'wrong-password',
      saveCredential: true,
    })).rejects.toThrow('authentication failed');
    expect(failed.secrets.values.size).toBe(0);
    expect(failed.hosts.get(failed.host.id).credentialConfigured).toBe(false);

    const challenged = fixture();
    challenged.createSsh.mockRejectedValueOnce(new Error(
      `${SSH_ERROR_CODES.hostKeyRequired}:SHA256:new-host`,
    ));
    await expect(challenged.service.connect(challenged.owner, {
      hostId: challenged.host.id,
      password: 'not-yet-saved',
      saveCredential: true,
    })).resolves.toEqual({ status: 'host-key-required', fingerprint: 'SHA256:new-host' });
    expect(challenged.secrets.values.size).toBe(0);
    expect(challenged.hosts.get(challenged.host.id).credentialConfigured).toBe(false);
  });

  it('closes the exact created terminal if the Host changes while SSH connects', async () => {
    const current = fixture();
    const pending = deferred<{ descriptor: TerminalDescriptor; fingerprint: string }>();
    current.createSsh.mockReturnValueOnce(pending.promise);
    const connection = current.service.connect(current.owner, {
      hostId: current.host.id,
      password: 'password',
      saveCredential: true,
    });
    await vi.waitFor(() => expect(current.createSsh).toHaveBeenCalledOnce());
    current.hosts.save({ ...current.host, hostname: '192.168.31.94' });
    pending.resolve({ descriptor: current.descriptor, fingerprint: 'SHA256:old-host' });

    await expect(connection).rejects.toThrow('主机配置已更改');
    expect(current.close).toHaveBeenCalledWith(current.owner, current.descriptor.id);
    expect(current.hosts.get(current.host.id).hostKeyFingerprint).toBeUndefined();
    expect(current.hosts.get(current.host.id).credentialConfigured).toBe(false);
    expect(current.secrets.values.size).toBe(0);
  });

  it('closes the exact created terminal when fingerprint persistence fails', async () => {
    const current = fixture();
    vi.spyOn(current.hosts, 'trustFingerprint').mockImplementation(() => {
      throw new Error('fingerprint persistence failed');
    });

    await expect(current.service.connect(current.owner, {
      hostId: current.host.id,
      password: 'password',
    })).rejects.toThrow('fingerprint persistence failed');
    expect(current.close).toHaveBeenCalledWith(current.owner, current.descriptor.id);
  });

  it('closes the exact created terminal when Session binding fails', async () => {
    const current = fixture();
    current.hosts.trustFingerprint(current.host.id, 'SHA256:test');
    current.reconnect.mockImplementationOnce(() => {
      throw new Error('session bind failed');
    });

    await expect(current.service.connect(current.owner, {
      hostId: current.host.id,
      sessionId: 'session-1',
      password: 'password',
    })).rejects.toThrow('session bind failed');
    expect(current.close).toHaveBeenCalledWith(current.owner, current.descriptor.id);
  });

  it('keeps the connected terminal visible when credential persistence fails', async () => {
    const current = fixture();
    current.secrets.failSet = true;
    const result = await current.service.connect(current.owner, {
      hostId: current.host.id,
      password: 'password',
      saveCredential: true,
    });

    expect(result.status).toBe('connected');
    expect(result).toHaveProperty('credentialWarning');
    expect(current.hosts.get(current.host.id).credentialConfigured).toBe(false);
  });

  it('retires an old credential when replacing it fails', async () => {
    const current = fixture();
    const reference = await current.credentials.set(current.host.id, 'old-password');
    current.hosts.configureCredential(current.host.id, reference);
    current.order.length = 0;
    current.secrets.failSet = true;

    const result = await current.service.connect(current.owner, {
      hostId: current.host.id,
      password: 'new-password',
      saveCredential: true,
    });

    expect(result.status).toBe('connected');
    expect(result).toHaveProperty('credentialWarning');
    expect(current.hosts.get(current.host.id).credentialConfigured).toBe(false);
    expect(current.secrets.values.has(reference)).toBe(false);
    expect(current.order).toEqual(['terminal-ready', 'credential-set', 'credential-remove']);
  });

  it('rolls back the secret if activating Host metadata fails', async () => {
    const current = fixture();
    vi.spyOn(current.hosts, 'configureCredential').mockImplementation(() => {
      throw new Error('metadata write failed');
    });
    const result = await current.service.connect(current.owner, {
      hostId: current.host.id,
      password: 'password',
      saveCredential: true,
    });

    expect(result.status).toBe('connected');
    expect(result).toHaveProperty('credentialWarning');
    expect(current.secrets.values.size).toBe(0);
    expect(current.order).toContain('credential-remove');
  });

  it('rolls back a newly written secret when the Host revision changes during storage', async () => {
    const current = fixture();
    vi.spyOn(current.credentials, 'set').mockImplementation(async (hostId, credential) => {
      const reference = hostCredentialReference(hostId);
      current.secrets.values.set(reference, credential);
      current.hosts.save({ ...current.host, username: 'changed-during-save' });
      return reference;
    });

    const result = await current.service.connect(current.owner, {
      hostId: current.host.id,
      password: 'new-password',
      saveCredential: true,
    });

    expect(result.status).toBe('connected');
    expect(result).toHaveProperty('credentialWarning');
    expect(current.close).not.toHaveBeenCalled();
    expect(current.secrets.values.size).toBe(0);
    expect(current.hosts.get(current.host.id).username).toBe('changed-during-save');
    expect(current.hosts.get(current.host.id).credentialConfigured).toBe(false);
  });

  it('invalidates the reference before best-effort cleanup on identity changes', async () => {
    const current = fixture();
    const reference = await current.credentials.set(current.host.id, 'old-password');
    current.hosts.configureCredential(current.host.id, reference);
    current.secrets.failRemove = true;
    current.order.length = 0;

    const updated = await current.service.save({
      ...current.host,
      username: 'different-user',
    });
    expect(updated.credentialConfigured).toBe(false);
    expect(current.hosts.credentialReference(current.host.id)).toBeUndefined();
    expect(current.secrets.values.get(reference)).toBe('old-password');
    await expect(current.service.connect(current.owner, {
      hostId: current.host.id,
      password: '',
    })).rejects.toThrow('请输入密码');
    expect(current.createSsh).not.toHaveBeenCalled();
  });

  it('retires stale metadata when its Windows credential is missing', async () => {
    const current = fixture();
    const reference = await current.credentials.set(current.host.id, 'old-password');
    current.hosts.configureCredential(current.host.id, reference);
    current.secrets.values.delete(reference);

    await expect(current.service.connect(current.owner, {
      hostId: current.host.id,
      password: '',
    })).rejects.toThrow('请输入密码');
    expect(current.hosts.get(current.host.id).credentialConfigured).toBe(false);
    expect(current.hosts.credentialReference(current.host.id)).toBeUndefined();
  });

  it('continues with an unencrypted private key after retiring a missing passphrase', async () => {
    const current = fixture({ authMethod: 'private-key', privateKeyPath: 'C:\\keys\\id_ed25519' });
    const reference = await current.credentials.set(current.host.id, 'old-passphrase');
    current.hosts.configureCredential(current.host.id, reference);
    current.secrets.values.delete(reference);

    const result = await current.service.connect(current.owner, {
      hostId: current.host.id,
      passphrase: '',
    });

    expect(result.status).toBe('connected');
    expect(current.createSsh.mock.calls[0]?.[2]?.passphrase).toBeUndefined();
    expect(current.hosts.get(current.host.id).credentialConfigured).toBe(false);
  });

  it('fails closed when forgetting or deleting a credential cannot remove the secret', async () => {
    const current = fixture();
    const reference = await current.credentials.set(current.host.id, 'old-password');
    current.hosts.configureCredential(current.host.id, reference);
    current.secrets.failRemove = true;

    await expect(current.service.forgetCredential(current.host.id)).rejects.toThrow(
      'credential remove failed',
    );
    expect(current.hosts.get(current.host.id).credentialConfigured).toBe(false);
    expect(current.hosts.credentialReference(current.host.id)).toBeUndefined();

    await expect(current.service.remove(current.host.id)).rejects.toThrow(
      'credential remove failed',
    );
    expect(current.hosts.get(current.host.id).credentialConfigured).toBe(false);
  });

  it('best-effort deletes the OS secret when metadata retirement fails', async () => {
    const current = fixture();
    const reference = await current.credentials.set(current.host.id, 'old-password');
    current.hosts.configureCredential(current.host.id, reference);
    vi.spyOn(current.hosts, 'retireCredential').mockImplementation(() => {
      throw new Error('metadata retirement failed');
    });

    await expect(current.service.forgetCredential(current.host.id)).rejects.toThrow(
      'metadata retirement failed',
    );
    expect(current.secrets.values.has(reference)).toBe(false);
    await expect(current.service.connect(current.owner, {
      hostId: current.host.id,
      password: '',
    })).rejects.toThrow('metadata retirement failed');
    expect(current.createSsh).not.toHaveBeenCalled();
  });
});
