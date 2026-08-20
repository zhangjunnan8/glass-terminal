// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decryptBackupPayload,
  encryptBackupPayload,
  isEncryptedBackupPayload,
  validateBackupPassphrase,
  writeBackupFileAtomic,
} from './backup-crypto';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('whole-backup encryption', () => {
  it('uses random salt/IV, hides canary data, and authenticates the full payload', async () => {
    const plaintext = Buffer.from('manifest.json\0provider-secrets.json\0canary-api-key', 'utf8');
    const passphrase = 'a sufficiently long backup passphrase';

    const first = await encryptBackupPayload(plaintext, passphrase);
    const second = await encryptBackupPayload(plaintext, passphrase);

    expect(isEncryptedBackupPayload(first)).toBe(true);
    expect(first.equals(second)).toBe(false);
    expect(first.includes(Buffer.from('manifest.json'))).toBe(false);
    expect(first.includes(Buffer.from('canary-api-key'))).toBe(false);
    expect(await decryptBackupPayload(first, passphrase)).toEqual(plaintext);
  });

  it('rejects a wrong passphrase, ciphertext/tag tampering, and truncation', async () => {
    const passphrase = 'another secure backup passphrase';
    const encrypted = await encryptBackupPayload(Buffer.from('authenticated payload'), passphrase);

    await expect(decryptBackupPayload(encrypted, 'wrong password'))
      .rejects.toThrow('口令错误');

    const tamperedCiphertext = Buffer.from(encrypted);
    tamperedCiphertext[tamperedCiphertext.length - 17] ^= 0x01;
    await expect(decryptBackupPayload(tamperedCiphertext, passphrase))
      .rejects.toThrow('篡改');

    const tamperedTag = Buffer.from(encrypted);
    tamperedTag[tamperedTag.length - 1] ^= 0x01;
    await expect(decryptBackupPayload(tamperedTag, passphrase))
      .rejects.toThrow('篡改');

    await expect(decryptBackupPayload(encrypted.subarray(0, -8), passphrase))
      .rejects.toThrow('截断');
  });

  it('requires a confirmed 12-character passphrase for new encrypted exports', () => {
    expect(() => validateBackupPassphrase('short', 'short')).toThrow('12');
    expect(() => validateBackupPassphrase(
      'long enough password',
      'different password',
    )).toThrow('不一致');
    expect(validateBackupPassphrase(
      'long enough password',
      'long enough password',
    )).toBe('long enough password');
  });

  it('writes only the final encrypted bytes through an atomic sibling file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'glass-backup-crypto-'));
    roots.push(root);
    const target = join(root, 'encrypted.aitbak');
    const encrypted = await encryptBackupPayload(
      Buffer.from('disk-canary-secret'),
      'atomic encrypted backup password',
    );

    writeBackupFileAtomic(target, encrypted);

    expect(readFileSync(target)).toEqual(encrypted);
    expect(readFileSync(target).includes(Buffer.from('disk-canary-secret'))).toBe(false);
  });
});
