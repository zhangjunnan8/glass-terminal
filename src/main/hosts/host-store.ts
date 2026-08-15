import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { HostInput, HostProfile, SshAuthMethod } from '../../shared/host';

const AUTH_METHODS = new Set<SshAuthMethod>([
  'password',
  'private-key',
  'agent',
  'keyboard-interactive',
]);

interface NormalizedHostInput {
  name: string;
  hostname: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  privateKeyPath?: string;
  group?: string;
  favorite: boolean;
}

interface StoredHostProfile extends HostProfile {
  credentialReference?: string;
  revision: number;
}

export interface HostSaveResult {
  host: HostProfile;
  retiredCredentialReference?: string;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeInput(input: HostInput): NormalizedHostInput {
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Port must be an integer from 1 to 65535.');
  }
  if (!AUTH_METHODS.has(input.authMethod)) {
    throw new Error('Unsupported SSH authentication method.');
  }
  const privateKeyPath = optionalText(input.privateKeyPath);
  if (input.authMethod === 'private-key' && !privateKeyPath) {
    throw new Error('A private key path is required.');
  }
  return {
    name: requiredText(input.name, 'Host name'),
    hostname: requiredText(input.hostname, 'Hostname'),
    port,
    username: requiredText(input.username, 'Username'),
    authMethod: input.authMethod,
    privateKeyPath,
    group: optionalText(input.group),
    favorite: Boolean(input.favorite),
  };
}

function publicHost(host: StoredHostProfile): HostProfile {
  const {
    credentialReference: _credentialReference,
    revision: _revision,
    ...profile
  } = host;
  return { ...profile };
}

function identityChanged(
  existing: StoredHostProfile,
  normalized: NormalizedHostInput,
): boolean {
  return existing.hostname !== normalized.hostname
    || existing.port !== normalized.port
    || existing.username !== normalized.username
    || existing.authMethod !== normalized.authMethod
    || (
      (existing.authMethod === 'private-key' || normalized.authMethod === 'private-key')
      && existing.privateKeyPath !== normalized.privateKeyPath
    );
}

function parseHost(value: unknown): StoredHostProfile {
  if (!value || typeof value !== 'object') throw new Error('Invalid Host profile.');
  const candidate = value as Partial<StoredHostProfile>;
  const id = requiredText(candidate.id, 'Host id');
  const normalized = normalizeInput({
    name: candidate.name ?? '',
    hostname: candidate.hostname ?? '',
    port: candidate.port ?? 0,
    username: candidate.username ?? '',
    authMethod: candidate.authMethod as SshAuthMethod,
    privateKeyPath: candidate.privateKeyPath,
    group: candidate.group,
    favorite: candidate.favorite,
  });
  const expectedReference = `AI Terminal/ssh/${id}`;
  const credentialReference = candidate.credentialReference === expectedReference
    ? expectedReference
    : undefined;
  return {
    id,
    ...normalized,
    hostKeyFingerprint: optionalText(candidate.hostKeyFingerprint),
    credentialConfigured: candidate.credentialConfigured === true && Boolean(credentialReference),
    credentialReference,
    revision: Number.isSafeInteger(candidate.revision) && Number(candidate.revision) > 0
      ? Number(candidate.revision)
      : 1,
    createdAt: requiredText(candidate.createdAt, 'Host createdAt'),
    updatedAt: requiredText(candidate.updatedAt, 'Host updatedAt'),
  };
}

export class HostStore {
  private hosts: StoredHostProfile[];

  constructor(private readonly filePath: string) {
    this.hosts = this.read();
  }

  list(): HostProfile[] {
    return [...this.hosts].sort((left, right) => {
      if (left.favorite !== right.favorite) return left.favorite ? -1 : 1;
      return left.name.localeCompare(right.name);
    }).map(publicHost);
  }

  get(hostId: string): HostProfile {
    return publicHost(this.getStored(hostId));
  }

  credentialReference(hostId: string): string | undefined {
    const host = this.getStored(hostId);
    return host.credentialConfigured ? host.credentialReference : undefined;
  }

  revision(hostId: string): number {
    return this.getStored(hostId).revision;
  }

  connectionIdentityChanged(input: HostInput): boolean {
    const normalized = normalizeInput(input);
    const existing = input.id
      ? this.hosts.find((host) => host.id === input.id)
      : undefined;
    return existing ? identityChanged(existing, normalized) : false;
  }

  save(input: HostInput): HostProfile {
    return this.saveWithCredentialRetirement(input).host;
  }

  saveWithCredentialRetirement(input: HostInput): HostSaveResult {
    const now = new Date().toISOString();
    const existing = input.id
      ? this.hosts.find((host) => host.id === input.id)
      : undefined;
    const normalized = normalizeInput(input);
    const connectionChanged = existing ? identityChanged(existing, normalized) : false;
    const targetChanged = existing
      ? existing.hostname !== normalized.hostname || existing.port !== normalized.port
      : false;
    const host: StoredHostProfile = {
      id: existing?.id ?? randomUUID(),
      ...normalized,
      hostKeyFingerprint: targetChanged ? undefined : existing?.hostKeyFingerprint,
      credentialConfigured: connectionChanged ? false : existing?.credentialConfigured ?? false,
      credentialReference: connectionChanged ? undefined : existing?.credentialReference,
      revision: (existing?.revision ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const next = existing
      ? this.hosts.map((item) => item.id === host.id ? host : item)
      : [...this.hosts, host];
    this.commit(next);
    return {
      host: publicHost(host),
      ...(connectionChanged && existing?.credentialReference
        ? { retiredCredentialReference: existing.credentialReference }
        : {}),
    };
  }

  configureCredential(
    hostId: string,
    reference: string,
    expectedRevision?: number,
  ): HostProfile {
    const host = this.getStored(hostId);
    this.assertRevision(host, expectedRevision);
    if (reference !== `AI Terminal/ssh/${host.id}`) {
      throw new Error('Invalid Host credential reference.');
    }
    const updated: StoredHostProfile = {
      ...host,
      credentialConfigured: true,
      credentialReference: reference,
      revision: host.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    this.replace(updated);
    return publicHost(updated);
  }

  retireCredential(hostId: string, expectedRevision?: number): string | undefined {
    const host = this.getStored(hostId);
    this.assertRevision(host, expectedRevision);
    const reference = host.credentialReference;
    if (!reference && !host.credentialConfigured) return undefined;
    const updated: StoredHostProfile = {
      ...host,
      credentialConfigured: false,
      credentialReference: undefined,
      revision: host.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    this.replace(updated);
    return reference;
  }

  remove(hostId: string): void {
    const next = this.hosts.filter((host) => host.id !== hostId);
    if (next.length === this.hosts.length) throw new Error(`Host not found: ${hostId}`);
    this.commit(next);
  }

  trustFingerprint(
    hostId: string,
    fingerprint: string,
    expectedRevision?: number,
  ): HostProfile {
    const host = this.getStored(hostId);
    this.assertRevision(host, expectedRevision);
    const updated: StoredHostProfile = {
      ...host,
      hostKeyFingerprint: requiredText(fingerprint, 'Host key fingerprint'),
      revision: host.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    this.replace(updated);
    return publicHost(updated);
  }

  private getStored(hostId: string): StoredHostProfile {
    const host = this.hosts.find((item) => item.id === hostId);
    if (!host) throw new Error(`Host not found: ${hostId}`);
    return host;
  }

  private assertRevision(host: StoredHostProfile, expectedRevision: number | undefined): void {
    if (expectedRevision !== undefined && host.revision !== expectedRevision) {
      throw new Error('Host profile changed during the SSH operation.');
    }
  }

  private replace(host: StoredHostProfile): void {
    this.commit(this.hosts.map((item) => item.id === host.id ? host : item));
  }

  private read(): StoredHostProfile[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed.map(parseHost);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(`Unable to read Host store: ${(error as Error).message}`);
    }
  }

  private commit(hosts: StoredHostProfile[]): void {
    this.write(hosts);
    this.hosts = hosts;
  }

  private write(hosts: StoredHostProfile[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp-${process.pid}`;
    writeFileSync(temporaryPath, `${JSON.stringify(hosts, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporaryPath, this.filePath);
  }
}
