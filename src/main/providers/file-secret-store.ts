import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SecretEntry, SecretStore } from './secret-store';

/**
 * App-owned, file-backed secret store. It keeps Provider API keys and SSH
 * host credentials in a single JSON file so the whole credential set can be
 * exported/imported with the rest of the configuration.
 *
 * Security note: this trades the OS credential vault's protection for
 * portability. The file is written atomically and never logs its contents,
 * but callers are responsible for the secrecy of the directory that hosts it.
 */
export class FileSecretStore implements SecretStore {
  private readonly values = new Map<string, string>();

  constructor(private readonly path: string) {
    this.load();
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Secret store file is malformed.');
    }
    for (const [reference, secret] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof secret === 'string' && secret) this.values.set(reference, secret);
    }
  }

  async get(reference: string): Promise<string | undefined> {
    return this.values.get(reference);
  }

  async set(reference: string, secret: string): Promise<void> {
    if (!secret) throw new Error('Credential cannot be empty.');
    this.values.set(reference, secret);
    this.persist();
  }

  async remove(reference: string): Promise<void> {
    if (!this.values.delete(reference)) return;
    this.persist();
  }

  async entries(): Promise<SecretEntry[]> {
    return [...this.values.entries()].map(([reference, secret]) => ({ reference, secret }));
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify(Object.fromEntries(this.values), null, 2)}\n`,
      'utf8',
    );
    renameSync(temporary, this.path);
  }
}
