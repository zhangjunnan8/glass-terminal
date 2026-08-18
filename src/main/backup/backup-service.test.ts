// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  writeFileSync(p.providers, JSON.stringify([{ id: 'provider-1' }]), 'utf8');
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
});
