import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HostStore } from './host-store';

const temporaryDirectories: string[] = [];

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), 'ai-terminal-hosts-'));
  temporaryDirectories.push(directory);
  const filePath = join(directory, 'hosts.json');
  return { store: new HostStore(filePath), filePath };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('HostStore', () => {
  it('persists only non-secret host fields', () => {
    const { store, filePath } = createStore();
    const host = store.save({
      name: 'Ubuntu Lab',
      hostname: '192.168.31.93',
      port: 22,
      username: 'zjn',
      authMethod: 'password',
    });
    expect(store.get(host.id).hostname).toBe('192.168.31.93');
    expect(store.get(host.id).credentialConfigured).toBe(false);
    const persisted = readFileSync(filePath, 'utf8');
    expect(persisted).not.toContain('password": "');
    expect(persisted).not.toContain('passphrase');
  });

  it('keeps a trusted fingerprint across profile edits', () => {
    const { store } = createStore();
    const host = store.save({
      name: 'Ubuntu Lab',
      hostname: '192.168.31.93',
      port: 22,
      username: 'zjn',
      authMethod: 'password',
    });
    store.trustFingerprint(host.id, 'SHA256:example');
    const updated = store.save({ ...host, name: 'Ubuntu Debug' });
    expect(updated.hostKeyFingerprint).toBe('SHA256:example');
  });

  it('keeps credential references internal and retires them before identity changes', () => {
    const { store, filePath } = createStore();
    const host = store.save({
      name: 'Ubuntu Lab',
      hostname: '192.168.31.93',
      port: 22,
      username: 'zjn',
      authMethod: 'password',
    });
    const reference = `AI Terminal/ssh/${host.id}`;
    const configured = store.configureCredential(host.id, reference);
    expect(configured.credentialConfigured).toBe(true);
    expect(configured).not.toHaveProperty('credentialReference');
    expect(configured).not.toHaveProperty('revision');
    expect(store.list()[0]).not.toHaveProperty('credentialReference');
    expect(readFileSync(filePath, 'utf8')).toContain(reference);

    const renamed = store.saveWithCredentialRetirement({ ...host, name: 'Renamed' });
    expect(renamed.retiredCredentialReference).toBeUndefined();
    expect(renamed.host.credentialConfigured).toBe(true);

    const changed = store.saveWithCredentialRetirement({
      ...renamed.host,
      username: 'another-user',
    });
    expect(changed.retiredCredentialReference).toBe(reference);
    expect(changed.host.credentialConfigured).toBe(false);
    expect(store.credentialReference(host.id)).toBeUndefined();
    expect(readFileSync(filePath, 'utf8')).not.toContain(reference);
  });

  it('rebuilds old Host JSON through an allowlist before exposing it', () => {
    const { store: initial, filePath } = createStore();
    const host = initial.save({
      name: 'Ubuntu Lab',
      hostname: '192.168.31.93',
      port: 22,
      username: 'zjn',
      authMethod: 'password',
    });
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Array<Record<string, unknown>>;
    parsed[0].password = 'must-not-cross-ipc';
    parsed[0].credentialReference = 'AI Terminal/ssh/not-the-host-id';
    writeFileSync(filePath, JSON.stringify(parsed), 'utf8');

    const reloaded = new HostStore(filePath);
    expect(reloaded.get(host.id)).not.toHaveProperty('password');
    expect(reloaded.get(host.id)).not.toHaveProperty('credentialReference');
    expect(reloaded.get(host.id).credentialConfigured).toBe(false);
  });
});
