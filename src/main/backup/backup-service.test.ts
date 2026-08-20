// @vitest-environment node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { MemorySecretStore } from '../providers/secret-store';
import { BackupService } from './backup-service';

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ai-terminal-backup-'));
  roots.push(root);
  return root;
}

function paths(root: string) {
  return {
    settings: join(root, 'config', 'app-settings.json'),
    providers: join(root, 'config', 'providers.json'),
    codexAppServer: join(root, 'config', 'codex-app-server.json'),
    sessions: join(root, 'sessions'),
  };
}

function seedConfig(root: string) {
  const p = paths(root);
  mkdirSync(dirname(p.settings), { recursive: true });
  writeFileSync(p.settings, JSON.stringify({ schemaVersion: 1, theme: 'light' }), 'utf8');
  writeFileSync(p.providers, JSON.stringify([{
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Provider 1',
    kind: 'generic-openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    modelId: 'model-1',
    contextWindowTokens: 128_000,
    apiKeyReference: 'AI Terminal/provider/00000000-0000-4000-8000-000000000001',
    recipientTransitionPending: false,
    recipientRevision: 'recipient-1',
    apiKeyConfigured: false,
    isDefault: true,
    status: 'ready',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }]), 'utf8');
  writeFileSync(p.codexAppServer, JSON.stringify({ bound: true }), 'utf8');
}

function readManifest(bundlePath: string) {
  const zip = new AdmZip(bundlePath);
  const entry = zip.getEntry('manifest.json');
  expect(entry).toBeTruthy();
  return JSON.parse(entry!.getData().toString('utf8')) as {
    formatVersion: number;
    sections: Record<string, { schemaVersion: number; data?: unknown; file?: string }>;
  };
}

function configSnapshot(root: string): Record<string, Buffer> {
  const p = paths(root);
  return Object.fromEntries([
    ['settings', readFileSync(p.settings)],
    ['providers', readFileSync(p.providers)],
    ['codexAppServer', readFileSync(p.codexAppServer)],
  ]);
}

function expectConfigSnapshot(root: string, expected: Record<string, Buffer>) {
  const actual = configSnapshot(root);
  for (const [name, content] of Object.entries(expected)) {
    expect(actual[name]).toEqual(content);
  }
  expect(readdirSync(join(root, 'config')).filter((name) => name.includes('.backup-import-')))
    .toEqual([]);
}

function manifest(sections: Record<string, { schemaVersion: number; file?: string }>) {
  return {
    formatVersion: 1,
    appVersion: '1.0.0',
    exportedAt: new Date(0).toISOString(),
    sections,
  };
}

class FailOnceSecretStore extends MemorySecretStore {
  failNextSet = false;

  override async set(reference: string, secret: string): Promise<void> {
    if (this.failNextSet) {
      this.failNextSet = false;
      throw new Error('injected secret write failure');
    }
    await super.set(reference, secret);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('BackupService', () => {
  it('exports config and only Provider secrets, then imports them cleanly', async () => {
    const source = fixture();
    seedConfig(source);
    const secrets = new MemorySecretStore();
    await secrets.set('AI Terminal/provider/00000000-0000-4000-8000-000000000001', 'api-key');
    await secrets.set('AI Terminal/ssh/00000000-0000-4000-8000-000000000002', 'host-pass');

    const service = new BackupService(paths(source), secrets, '1.0.0');
    const bundlePath = join(source, 'backup.aitbak');
    const exported = await service.exportToFile(bundlePath);

    expect(exported.sections).toEqual([
      'settings',
      'providers',
      'codexAppServer',
      'providerSecrets',
    ]);
    const manifest = readManifest(bundlePath);
    expect(manifest.sections.providerSecrets.file).toBe('sections/provider-secrets.json');
    const secretsEntry = new AdmZip(bundlePath).getEntry('sections/provider-secrets.json')!;
    expect(JSON.parse(secretsEntry.getData().toString('utf8'))).toEqual({
      'AI Terminal/provider/00000000-0000-4000-8000-000000000001': 'api-key',
    });

    const target = fixture();
    const targetSecrets = new MemorySecretStore();
    const imported = await new BackupService(paths(target), targetSecrets, '1.0.0')
      .importFromFile(bundlePath);

    expect(imported.sectionsImported).toEqual([
      'settings',
      'providers',
      'codexAppServer',
      'providerSecrets',
    ]);
    expect(imported.needsRestart).toBe(true);
    expect(JSON.parse(readFileSync(paths(target).settings, 'utf8'))).toMatchObject({
      theme: 'light',
    });
    expect(await targetSecrets.get(
      'AI Terminal/provider/00000000-0000-4000-8000-000000000001',
    )).toBe('api-key');
  });

  it('removes stale Provider secrets on import without touching Host secrets', async () => {
    const source = fixture();
    seedConfig(source);
    const sourceSecrets = new MemorySecretStore();
    await sourceSecrets.set('AI Terminal/provider/00000000-0000-4000-8000-000000000001', 'new-key');
    const bundlePath = join(source, 'backup.aitbak');
    await new BackupService(paths(source), sourceSecrets, '1.0.0').exportToFile(bundlePath);

    const targetSecrets = new MemorySecretStore();
    await targetSecrets.set('AI Terminal/provider/00000000-0000-4000-8000-000000000001', 'old-key');
    await targetSecrets.set('AI Terminal/provider/00000000-0000-4000-8000-000000000003', 'stale');
    await targetSecrets.set('AI Terminal/ssh/00000000-0000-4000-8000-000000000004', 'host-pass');

    await new BackupService(paths(fixture()), targetSecrets, '1.0.0').importFromFile(bundlePath);

    expect(await targetSecrets.get(
      'AI Terminal/provider/00000000-0000-4000-8000-000000000001',
    )).toBe('new-key');
    expect(await targetSecrets.get(
      'AI Terminal/provider/00000000-0000-4000-8000-000000000003',
    )).toBeUndefined();
    expect(await targetSecrets.get(
      'AI Terminal/ssh/00000000-0000-4000-8000-000000000004',
    )).toBe('host-pass');
  });

  it('bundles and restores session logs only when requested', async () => {
    const source = fixture();
    seedConfig(source);
    mkdirSync(join(paths(source).sessions, 'sess-1', 'terminal'), { recursive: true });
    writeFileSync(join(paths(source).sessions, 'sess-1', 'audit.jsonl'), '{"type":"x"}\n', 'utf8');
    writeFileSync(
      join(paths(source).sessions, 'sess-1', 'terminal', 'output.jsonl.gz'),
      Buffer.from([0x1f, 0x8b, 0x08, 0x00]),
    );

    const bundlePath = join(source, 'backup.aitbak');
    const exported = await new BackupService(
      paths(source),
      new MemorySecretStore(),
      '1.0.0',
    ).exportToFile(bundlePath, true);
    expect(exported.sections).toContain('sessions');

    const target = fixture();
    mkdirSync(paths(target).sessions, { recursive: true });
    writeFileSync(join(paths(target).sessions, 'stale-before-import.txt'), 'stale');
    const imported = await new BackupService(
      paths(target),
      new MemorySecretStore(),
      '1.0.0',
    ).importFromFile(bundlePath);
    expect(imported.sectionsImported).toContain('sessions');
    expect(readFileSync(join(paths(target).sessions, 'sess-1', 'audit.jsonl'), 'utf8'))
      .toBe('{"type":"x"}\n');
    expect(readFileSync(join(paths(target).sessions, 'sess-1', 'terminal', 'output.jsonl.gz')))
      .toEqual(Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
    expect(existsSync(join(paths(target).sessions, 'stale-before-import.txt'))).toBe(false);
  });

  it('skips unknown and unsupported sections instead of failing', async () => {
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify({
      formatVersion: 1,
      appVersion: '1.0.0',
      exportedAt: new Date(0).toISOString(),
      sections: {
        settings: { schemaVersion: 1, file: 'sections/settings.json' },
        futureSection: { schemaVersion: 9, file: 'sections/future.json' },
        providers: { schemaVersion: 2, file: 'sections/providers.json' },
      },
    }), 'utf8'));
    zip.addFile('sections/settings.json', Buffer.from(JSON.stringify({ theme: 'dark' }), 'utf8'));
    zip.addFile('sections/providers.json', Buffer.from('[]', 'utf8'));
    const bundlePath = join(fixture(), 'backup.aitbak');
    zip.writeZip(bundlePath);

    const target = fixture();
    const imported = await new BackupService(
      paths(target),
      new MemorySecretStore(),
      '1.0.0',
    ).importFromFile(bundlePath);

    expect(imported.sectionsImported).toEqual(['settings']);
    expect(imported.sectionsSkipped).toEqual([
      { section: 'providers', reason: 'schemaVersion 2 不受支持' },
    ]);
    expect(JSON.parse(readFileSync(paths(target).settings, 'utf8'))).toMatchObject({
      theme: 'dark',
    });
  });

  it('rejects an unsupported format version', async () => {
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify({ formatVersion: 99, sections: {} }), 'utf8'));
    const bundlePath = join(fixture(), 'backup.aitbak');
    zip.writeZip(bundlePath);
    await expect(new BackupService(
      paths(fixture()),
      new MemorySecretStore(),
      '1.0.0',
    ).importFromFile(bundlePath)).rejects.toThrow('格式版本');
  });

  it('rejects traversal, mixed separators, duplicate entries, and zip bombs before staging', async () => {
    for (const [name, mutate] of [
      ['traversal', (entry: AdmZip.IZipEntry) => { entry.entryName = '../escape.txt'; }],
      ['mixed-separator', (entry: AdmZip.IZipEntry) => { entry.entryName = 'sessions\\..\\escape.txt'; }],
    ] as const) {
      const zip = new AdmZip();
      zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest({})), 'utf8'));
      const entry = zip.addFile('safe.txt', Buffer.from('payload', 'utf8'));
      mutate(entry);
      const bundlePath = join(fixture(), `${name}.aitbak`);
      zip.writeZip(bundlePath);
      await expect(new BackupService(
        paths(fixture()),
        new MemorySecretStore(),
        '1.0.0',
      ).importFromFile(bundlePath)).rejects.toThrow(/ZIP entry|路径/);
    }

    const duplicateZip = new AdmZip();
    duplicateZip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest({})), 'utf8'));
    duplicateZip.addFile('duplicate-a.txt', Buffer.from('a'));
    const duplicate = duplicateZip.addFile('duplicate-b.txt', Buffer.from('b'));
    duplicate.entryName = 'duplicate-a.txt';
    const duplicatePath = join(fixture(), 'duplicate.aitbak');
    duplicateZip.writeZip(duplicatePath);
    await expect(new BackupService(
      paths(fixture()),
      new MemorySecretStore(),
      '1.0.0',
    ).importFromFile(duplicatePath)).rejects.toThrow('重复 entry');

    const bombZip = new AdmZip();
    bombZip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest({})), 'utf8'));
    bombZip.addFile('unused-bomb.txt', Buffer.alloc(1024 * 1024, 0x41));
    const bombPath = join(fixture(), 'bomb.aitbak');
    bombZip.writeZip(bombPath);
    await expect(new BackupService(
      paths(fixture()),
      new MemorySecretStore(),
      '1.0.0',
    ).importFromFile(bombPath)).rejects.toThrow('压缩率');
  });

  it('leaves every live section unchanged when later JSON or Session validation fails', async () => {
    const target = fixture();
    seedConfig(target);
    const before = configSnapshot(target);

    const invalidProviderZip = new AdmZip();
    invalidProviderZip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest({
      settings: { schemaVersion: 1, file: 'sections/settings.json' },
      providers: { schemaVersion: 1, file: 'sections/providers.json' },
    })), 'utf8'));
    invalidProviderZip.addFile('sections/settings.json', Buffer.from('{"theme":"dark"}'));
    invalidProviderZip.addFile('sections/providers.json', Buffer.from('{broken'));
    const invalidProviderPath = join(fixture(), 'invalid-provider.aitbak');
    invalidProviderZip.writeZip(invalidProviderPath);
    await expect(new BackupService(
      paths(target),
      new MemorySecretStore(),
      '1.0.0',
    ).importFromFile(invalidProviderPath)).rejects.toThrow('不是有效 JSON');
    expectConfigSnapshot(target, before);

    const invalidSessionZip = new AdmZip();
    invalidSessionZip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest({
      settings: { schemaVersion: 1, file: 'sections/settings.json' },
      sessions: { schemaVersion: 1, file: 'sessions/' },
    })), 'utf8'));
    invalidSessionZip.addFile('sections/settings.json', Buffer.from('{"theme":"dark"}'));
    invalidSessionZip.addFile('sessions/session-1/audit.jsonl', Buffer.from('{broken\n'));
    const invalidSessionPath = join(fixture(), 'invalid-session.aitbak');
    invalidSessionZip.writeZip(invalidSessionPath);
    await expect(new BackupService(
      paths(target),
      new MemorySecretStore(),
      '1.0.0',
    ).importFromFile(invalidSessionPath)).rejects.toThrow('Session JSONL');
    expectConfigSnapshot(target, before);
    expect(existsSync(paths(target).sessions)).toBe(false);
  });

  it('rolls back an exact byte-for-byte snapshot after a mid-commit filesystem failure', async () => {
    const source = fixture();
    seedConfig(source);
    const sourceSecrets = new MemorySecretStore();
    await sourceSecrets.set(
      'AI Terminal/provider/00000000-0000-4000-8000-000000000001',
      'new-key',
    );
    const bundlePath = join(source, 'transaction.aitbak');
    await new BackupService(paths(source), sourceSecrets, '1.0.0').exportToFile(bundlePath);

    const target = fixture();
    seedConfig(target);
    writeFileSync(paths(target).settings, '{"schemaVersion":1,"theme":"dark","marker":"old"}\n');
    const before = configSnapshot(target);
    const targetSecrets = new MemorySecretStore();
    await targetSecrets.set(
      'AI Terminal/provider/00000000-0000-4000-8000-000000000001',
      'old-key',
    );
    const service = new BackupService(paths(target), targetSecrets, '1.0.0', {
      beforeInstall: (_target, index) => {
        if (index === 1) throw new Error('injected mid-commit failure');
      },
    });

    await expect(service.importFromFile(bundlePath)).rejects.toThrow('mid-commit');
    expectConfigSnapshot(target, before);
    expect(await targetSecrets.get(
      'AI Terminal/provider/00000000-0000-4000-8000-000000000001',
    )).toBe('old-key');
  });

  it('restores files and Provider secrets when the final SecretStore commit fails', async () => {
    const source = fixture();
    seedConfig(source);
    const sourceSecrets = new MemorySecretStore();
    await sourceSecrets.set(
      'AI Terminal/provider/00000000-0000-4000-8000-000000000001',
      'new-key',
    );
    const bundlePath = join(source, 'secret-failure.aitbak');
    await new BackupService(paths(source), sourceSecrets, '1.0.0').exportToFile(bundlePath);

    const target = fixture();
    seedConfig(target);
    writeFileSync(paths(target).settings, '{"schemaVersion":1,"theme":"dark","marker":"old"}\n');
    const before = configSnapshot(target);
    const targetSecrets = new FailOnceSecretStore();
    await targetSecrets.set(
      'AI Terminal/provider/00000000-0000-4000-8000-000000000001',
      'old-key',
    );
    targetSecrets.failNextSet = true;

    await expect(new BackupService(paths(target), targetSecrets, '1.0.0')
      .importFromFile(bundlePath)).rejects.toThrow('secret write failure');
    expectConfigSnapshot(target, before);
    expect(await targetSecrets.get(
      'AI Terminal/provider/00000000-0000-4000-8000-000000000001',
    )).toBe('old-key');
  });

  it('rejects Provider credentials that are not bound by validated metadata', async () => {
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest({
      providers: { schemaVersion: 1, file: 'sections/providers.json' },
      providerSecrets: { schemaVersion: 1, file: 'sections/provider-secrets.json' },
    })), 'utf8'));
    zip.addFile('sections/providers.json', readFileSync(paths((() => {
      const root = fixture();
      seedConfig(root);
      return root;
    })()).providers));
    zip.addFile('sections/provider-secrets.json', Buffer.from(JSON.stringify({
      'AI Terminal/provider/00000000-0000-4000-8000-000000000099': 'orphan',
    })));
    const bundlePath = join(fixture(), 'orphan-secret.aitbak');
    zip.writeZip(bundlePath);

    await expect(new BackupService(
      paths(fixture()),
      new MemorySecretStore(),
      '1.0.0',
    ).importFromFile(bundlePath)).rejects.toThrow('没有元数据引用');
  });
});
