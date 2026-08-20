import { randomUUID } from 'node:crypto';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt,
} from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

const MAGIC = Buffer.from('GTBAKENC', 'ascii');
const VERSION = 1;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const MAX_HEADER_BYTES = 4096;
const MAX_BACKUP_FILE_BYTES = 576 * 1024 * 1024;

interface EncryptionHeader {
  version: 1;
  kdf: 'scrypt';
  n: number;
  r: number;
  p: number;
  salt: string;
  cipher: 'aes-256-gcm';
  iv: string;
  tagBytes: number;
  plaintextBytes: number;
}

export interface LoadedBackupPayload {
  payload: Buffer;
  encrypted: boolean;
  fingerprint: string;
}

export interface BackupImportFileOptions {
  passphrase?: string;
  allowLegacyPlaintextCredentials?: boolean;
  expectedFingerprint?: string;
}

function backupCryptoError(): Error {
  return new Error('备份口令错误，或加密备份已被篡改/截断。');
}

function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, KEY_BYTES, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM,
    }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey as Buffer);
    });
  });
}

export function validateBackupPassphrase(
  passphrase: string | undefined,
  confirmation: string | undefined,
): string {
  if (
    typeof passphrase !== 'string'
    || passphrase.trim().length < 12
    || passphrase.length > 1024
  ) throw new Error('备份口令至少需要 12 个字符。');
  if (passphrase !== confirmation) throw new Error('两次输入的备份口令不一致。');
  return passphrase;
}

function validDecryptionPassphrase(passphrase: string | undefined): passphrase is string {
  return typeof passphrase === 'string' && passphrase.length > 0 && passphrase.length <= 1024;
}

export function isEncryptedBackupPayload(payload: Buffer): boolean {
  return payload.byteLength >= MAGIC.byteLength
    && payload.subarray(0, MAGIC.byteLength).equals(MAGIC);
}

export async function encryptBackupPayload(
  plaintext: Buffer,
  passphrase: string,
): Promise<Buffer> {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const header: EncryptionHeader = {
    version: VERSION,
    kdf: 'scrypt',
    n: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    salt: salt.toString('base64'),
    cipher: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tagBytes: TAG_BYTES,
    plaintextBytes: plaintext.byteLength,
  };
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.alloc(MAGIC.byteLength + 4);
  MAGIC.copy(prefix, 0);
  prefix.writeUInt32BE(headerBytes.byteLength, MAGIC.byteLength);
  const aad = Buffer.concat([prefix, headerBytes]);
  const key = await deriveKey(passphrase, salt);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad, { plaintextLength: plaintext.byteLength });
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([aad, ciphertext, tag]);
  } finally {
    key.fill(0);
    salt.fill(0);
    iv.fill(0);
  }
}

export async function decryptBackupPayload(
  encrypted: Buffer,
  passphrase: string | undefined,
): Promise<Buffer> {
  if (!validDecryptionPassphrase(passphrase)) throw backupCryptoError();
  try {
    if (!isEncryptedBackupPayload(encrypted) || encrypted.byteLength < MAGIC.byteLength + 4) {
      throw backupCryptoError();
    }
    const headerLength = encrypted.readUInt32BE(MAGIC.byteLength);
    if (headerLength < 2 || headerLength > MAX_HEADER_BYTES) throw backupCryptoError();
    const headerStart = MAGIC.byteLength + 4;
    const headerEnd = headerStart + headerLength;
    if (headerEnd + TAG_BYTES > encrypted.byteLength) throw backupCryptoError();
    const parsed = JSON.parse(encrypted.subarray(headerStart, headerEnd).toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw backupCryptoError();
    const header = parsed as Partial<EncryptionHeader>;
    if (
      header.version !== VERSION
      || header.kdf !== 'scrypt'
      || header.n !== SCRYPT_N
      || header.r !== SCRYPT_R
      || header.p !== SCRYPT_P
      || header.cipher !== 'aes-256-gcm'
      || header.tagBytes !== TAG_BYTES
      || !Number.isSafeInteger(header.plaintextBytes)
      || Number(header.plaintextBytes) < 0
      || typeof header.salt !== 'string'
      || typeof header.iv !== 'string'
    ) throw backupCryptoError();
    const salt = Buffer.from(header.salt, 'base64');
    const iv = Buffer.from(header.iv, 'base64');
    if (salt.byteLength !== SALT_BYTES || iv.byteLength !== IV_BYTES) throw backupCryptoError();
    const ciphertextEnd = encrypted.byteLength - TAG_BYTES;
    const ciphertext = encrypted.subarray(headerEnd, ciphertextEnd);
    if (ciphertext.byteLength !== header.plaintextBytes) throw backupCryptoError();
    const tag = encrypted.subarray(ciphertextEnd);
    const aad = encrypted.subarray(0, headerEnd);
    const key = await deriveKey(passphrase, salt);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(aad, { plaintextLength: ciphertext.byteLength });
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      if (plaintext.byteLength !== header.plaintextBytes) throw backupCryptoError();
      return plaintext;
    } finally {
      key.fill(0);
      salt.fill(0);
      iv.fill(0);
    }
  } catch {
    throw backupCryptoError();
  }
}

export function readBackupFile(path: string): Buffer {
  const size = statSync(path).size;
  if (size > MAX_BACKUP_FILE_BYTES) throw new Error('备份文件过大。');
  return readFileSync(path);
}

export async function loadBackupPayload(
  path: string,
  passphrase?: string,
): Promise<LoadedBackupPayload> {
  const source = readBackupFile(path);
  const fingerprint = backupPayloadFingerprint(source);
  if (!isEncryptedBackupPayload(source)) {
    return { payload: source, encrypted: false, fingerprint };
  }
  try {
    const payload = await decryptBackupPayload(source, passphrase);
    return { payload, encrypted: true, fingerprint };
  } finally {
    source.fill(0);
  }
}

export function backupPayloadFingerprint(payload: Buffer): string {
  return createHash('sha256').update(payload).digest('hex');
}

export function writeBackupFileAtomic(path: string, payload: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, payload, { flag: 'wx', mode: 0o600 });
    const descriptor = openSync(temporary, fsConstants.O_RDWR);
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
    if (process.platform !== 'win32') {
      const directory = openSync(dirname(path), fsConstants.O_RDONLY);
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best-effort failed-write cleanup */ }
    throw error;
  }
}
