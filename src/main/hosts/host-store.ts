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

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export class HostStore {
  private hosts: HostProfile[];

  constructor(private readonly filePath: string) {
    this.hosts = this.read();
  }

  list(): HostProfile[] {
    return [...this.hosts].sort((left, right) => {
      if (left.favorite !== right.favorite) return left.favorite ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
  }

  get(hostId: string): HostProfile {
    const host = this.hosts.find((item) => item.id === hostId);
    if (!host) throw new Error(`Host not found: ${hostId}`);
    return host;
  }

  save(input: HostInput): HostProfile {
    const now = new Date().toISOString();
    const existing = input.id
      ? this.hosts.find((host) => host.id === input.id)
      : undefined;
    const port = Number(input.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('Port must be an integer from 1 to 65535.');
    }
    if (!AUTH_METHODS.has(input.authMethod)) {
      throw new Error('Unsupported SSH authentication method.');
    }
    if (input.authMethod === 'private-key' && !optionalText(input.privateKeyPath)) {
      throw new Error('A private key path is required.');
    }

    const host: HostProfile = {
      id: existing?.id ?? randomUUID(),
      name: requiredText(input.name, 'Host name'),
      hostname: requiredText(input.hostname, 'Hostname'),
      port,
      username: requiredText(input.username, 'Username'),
      authMethod: input.authMethod,
      privateKeyPath: optionalText(input.privateKeyPath),
      hostKeyFingerprint: existing?.hostKeyFingerprint,
      group: optionalText(input.group),
      favorite: Boolean(input.favorite),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.hosts = existing
      ? this.hosts.map((item) => item.id === host.id ? host : item)
      : [...this.hosts, host];
    this.write();
    return host;
  }

  remove(hostId: string): void {
    const next = this.hosts.filter((host) => host.id !== hostId);
    if (next.length === this.hosts.length) throw new Error(`Host not found: ${hostId}`);
    this.hosts = next;
    this.write();
  }

  trustFingerprint(hostId: string, fingerprint: string): HostProfile {
    const host = this.get(hostId);
    const updated = {
      ...host,
      hostKeyFingerprint: requiredText(fingerprint, 'Host key fingerprint'),
      updatedAt: new Date().toISOString(),
    };
    this.hosts = this.hosts.map((item) => item.id === hostId ? updated : item);
    this.write();
    return updated;
  }

  private read(): HostProfile[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      return Array.isArray(parsed) ? parsed as HostProfile[] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(`Unable to read Host store: ${(error as Error).message}`);
    }
  }

  private write(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp-${process.pid}`;
    writeFileSync(temporaryPath, `${JSON.stringify(this.hosts, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporaryPath, this.filePath);
  }
}
