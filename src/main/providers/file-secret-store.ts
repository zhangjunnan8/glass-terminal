import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SecretEntry, SecretStore } from './secret-store';
import { loadOrCreateSecretKey, SecretCipher } from './secret-cipher';

const ENCRYPTED_PREFIX = 'v1:';

/**
 * App-owned, file-backed secret store. Provider API keys and SSH host
 * credentials are persisted to a single JSON file encrypted with AES-256-GCM;
 * the 32-byte key lives in a sibling key file so the store remains portable
 * (copy both files) without ever writing secrets in plaintext.
 *
 * The whole file is encrypted, so export/import keeps working unchanged: the
 * store decrypts into memory, and the backup service serializes those in-memory
 * entries into the portable bundle.
 */
export class FileSecretStore implements SecretStore {
  private readonly values = new Map<string, string>();
  private readonly cipher: SecretCipher;

  constructor(
    private readonly path: string,
    keyPath = `${path}.key`,
  ) {
    this.cipher = new SecretCipher(loadOrCreateSecretKey(keyPath));
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
    let parsed: unknown;
    let migratedFromPlaintext = false;
    if (raw.startsWith(ENCRYPTED_PREFIX)) {
      parsed = JSON.parse(this.cipher.decrypt(raw)) as unknown;
    } else {
      // Migrate a plaintext store written by an earlier version.
      parsed = JSON.parse(raw) as unknown;
      migratedFromPlaintext = true;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Secret store file is malformed.');
    }
    for (const [reference, secret] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof secret === 'string' && secret) this.values.set(reference, secret);
    }
    if (migratedFromPlaintext) this.persist();
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
    const encrypted = this.cipher.encrypt(JSON.stringify(Object.fromEntries(this.values)));
    writeFileSync(temporary, encrypted, 'utf8');
    renameSync(temporary, this.path);
  }
}
