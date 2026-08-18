import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const MAGIC_PREFIX = 'v1:';

/**
 * App-owned AES-256-GCM cipher for the local secret store. Each write uses a
 * fresh random IV, so the persisted blob never repeats even for equal payloads.
 */
export class SecretCipher {
  constructor(private readonly key: Buffer) {}

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${MAGIC_PREFIX}${Buffer.concat([iv, tag, encrypted]).toString('base64')}`;
  }

  decrypt(encoded: string): string {
    const payload = Buffer.from(encoded.slice(MAGIC_PREFIX.length), 'base64');
    const iv = payload.subarray(0, IV_LENGTH);
    const tag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }
}

/** Loads the 32-byte key, generating and persisting one on first use. */
export function loadOrCreateSecretKey(keyPath: string): Buffer {
  try {
    const encoded = readFileSync(keyPath, 'utf8').trim();
    const key = Buffer.from(encoded, 'base64');
    if (key.length === KEY_LENGTH) return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const key = randomBytes(KEY_LENGTH);
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, key.toString('base64'), { encoding: 'utf8', mode: 0o600 });
  return key;
}
