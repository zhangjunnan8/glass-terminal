import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileSecretStore } from './file-secret-store';
import { isAllowedCredentialReference } from './secret-store';

describe('Windows Credential Manager reference validation', () => {
  it('allows only Provider and SSH UUID targets', () => {
    expect(isAllowedCredentialReference(
      'AI Terminal/provider/00000000-0000-4000-8000-000000000001',
    )).toBe(true);
    expect(isAllowedCredentialReference(
      'AI Terminal/ssh/00000000-0000-4000-8000-000000000001',
    )).toBe(true);
    expect(isAllowedCredentialReference('AI Terminal/ssh/not-a-uuid')).toBe(false);
    expect(isAllowedCredentialReference(
      'AI Terminal/ssh/00000000-0000-4000-8000-000000000001/extra',
    )).toBe(false);
    expect(isAllowedCredentialReference(
      'Other App/ssh/00000000-0000-4000-8000-000000000001',
    )).toBe(false);
  });
});

describe('FileSecretStore', () => {
  const roots: string[] = [];

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-file-secret-'));
    roots.push(root);
    return join(root, 'config', 'secrets.json');
  }

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('persists set values and reloads them from a fresh instance', async () => {
    const path = fixture();
    const first = new FileSecretStore(path);
    await first.set('AI Terminal/provider/00000000-0000-4000-8000-000000000001', 'api-key');
    await first.set('AI Terminal/ssh/00000000-0000-4000-8000-000000000002', 'host-pass');

    const second = new FileSecretStore(path);
    expect(await second.get('AI Terminal/provider/00000000-0000-4000-8000-000000000001'))
      .toBe('api-key');
    expect(await second.get('AI Terminal/ssh/00000000-0000-4000-8000-000000000002'))
      .toBe('host-pass');
  });

  it('removes values durably and never persists an empty credential', async () => {
    const path = fixture();
    const store = new FileSecretStore(path);
    await store.set('AI Terminal/ssh/00000000-0000-4000-8000-000000000003', 'secret');
    await store.remove('AI Terminal/ssh/00000000-0000-4000-8000-000000000003');
    expect(await store.get('AI Terminal/ssh/00000000-0000-4000-8000-000000000003'))
      .toBeUndefined();

    await expect(store.set(
      'AI Terminal/ssh/00000000-0000-4000-8000-000000000004',
      '',
    )).rejects.toThrow('cannot be empty');
  });

  it('enumerates every stored entry for export', async () => {
    const path = fixture();
    const store = new FileSecretStore(path);
    await store.set('AI Terminal/provider/00000000-0000-4000-8000-000000000001', 'one');
    await store.set('AI Terminal/ssh/00000000-0000-4000-8000-000000000002', 'two');

    const entries = await store.entries!();
    expect(new Map(entries.map((entry) => [entry.reference, entry.secret]))).toEqual(new Map([
      ['AI Terminal/provider/00000000-0000-4000-8000-000000000001', 'one'],
      ['AI Terminal/ssh/00000000-0000-4000-8000-000000000002', 'two'],
    ]));
  });

  it('atomically replaces one credential namespace without touching the other', async () => {
    const path = fixture();
    const store = new FileSecretStore(path);
    await store.set('AI Terminal/provider/00000000-0000-4000-8000-000000000001', 'old-provider');
    await store.set('AI Terminal/provider/00000000-0000-4000-8000-000000000002', 'stale-provider');
    await store.set('AI Terminal/ssh/00000000-0000-4000-8000-000000000003', 'host-secret');

    await store.replaceNamespace!('AI Terminal/provider/', [{
      reference: 'AI Terminal/provider/00000000-0000-4000-8000-000000000001',
      secret: 'new-provider',
    }]);

    const reloaded = new FileSecretStore(path);
    expect(await reloaded.get(
      'AI Terminal/provider/00000000-0000-4000-8000-000000000001',
    )).toBe('new-provider');
    expect(await reloaded.get(
      'AI Terminal/provider/00000000-0000-4000-8000-000000000002',
    )).toBeUndefined();
    expect(await reloaded.get(
      'AI Terminal/ssh/00000000-0000-4000-8000-000000000003',
    )).toBe('host-secret');
  });

  it('encrypts secrets at rest and never writes plaintext', async () => {
    const path = fixture();
    const store = new FileSecretStore(path);
    await store.set('AI Terminal/ssh/00000000-0000-4000-8000-000000000005', 'top-secret-value');
    const persisted = readFileSync(path, 'utf8');
    expect(persisted).toContain('v1:');
    expect(persisted).not.toContain('top-secret-value');
  });

  it('migrates a legacy plaintext store to encryption on load', async () => {
    const path = fixture();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      'AI Terminal/ssh/00000000-0000-4000-8000-000000000006': 'legacy-secret',
    }), 'utf8');

    const store = new FileSecretStore(path);
    expect(await store.get('AI Terminal/ssh/00000000-0000-4000-8000-000000000006'))
      .toBe('legacy-secret');
    const persisted = readFileSync(path, 'utf8');
    expect(persisted).not.toContain('legacy-secret');
  });
});
