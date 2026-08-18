import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '../providers/secret-store';
import { HostBackupService } from './host-backup-service';

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ai-terminal-host-backup-'));
  roots.push(root);
  return root;
}

function hostsPath(root: string) {
  return join(root, 'config', 'hosts.json');
}

function seedHosts(root: string) {
  const path = hostsPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify([{ id: 'host-1', name: 'Test' }]), 'utf8');
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('HostBackupService', () => {
  it('exports hosts plus SSH secrets, then imports them cleanly', async () => {
    const source = fixture();
    seedHosts(source);
    const secrets = new MemorySecretStore();
    await secrets.set('AI Terminal/ssh/00000000-0000-4000-8000-000000000001', 'host-pass');
    await secrets.set('AI Terminal/provider/00000000-0000-4000-8000-000000000002', 'api-key');

    const bundlePath = join(source, 'hosts.aithosts');
    const exported = await new HostBackupService(
      hostsPath(source),
      secrets,
      '1.0.0',
    ).exportToFile(bundlePath);

    expect(exported.sections).toEqual(['hosts', 'hostSecrets']);
    const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as {
      sections: Record<string, { schemaVersion: number; data: unknown }>;
    };
    expect(bundle.sections.hostSecrets.data).toEqual({
      'AI Terminal/ssh/00000000-0000-4000-8000-000000000001': 'host-pass',
    });

    const target = fixture();
    const targetSecrets = new MemorySecretStore();
    const imported = await new HostBackupService(
      hostsPath(target),
      targetSecrets,
      '1.0.0',
    ).importFromFile(bundlePath);

    expect(imported.sectionsImported).toEqual(['hosts', 'hostSecrets']);
    expect(JSON.parse(readFileSync(hostsPath(target), 'utf8'))).toEqual([
      { id: 'host-1', name: 'Test' },
    ]);
    expect(await targetSecrets.get(
      'AI Terminal/ssh/00000000-0000-4000-8000-000000000001',
    )).toBe('host-pass');
  });

  it('replaces stale SSH secrets without touching Provider secrets', async () => {
    const source = fixture();
    seedHosts(source);
    const sourceSecrets = new MemorySecretStore();
    await sourceSecrets.set('AI Terminal/ssh/00000000-0000-4000-8000-000000000001', 'new-pass');
    const bundlePath = join(source, 'hosts.aithosts');
    await new HostBackupService(hostsPath(source), sourceSecrets, '1.0.0')
      .exportToFile(bundlePath);

    const targetSecrets = new MemorySecretStore();
    await targetSecrets.set('AI Terminal/ssh/00000000-0000-4000-8000-000000000001', 'old-pass');
    await targetSecrets.set('AI Terminal/ssh/00000000-0000-4000-8000-000000000003', 'stale');
    await targetSecrets.set('AI Terminal/provider/00000000-0000-4000-8000-000000000004', 'api-key');

    await new HostBackupService(hostsPath(fixture()), targetSecrets, '1.0.0')
      .importFromFile(bundlePath);

    expect(await targetSecrets.get(
      'AI Terminal/ssh/00000000-0000-4000-8000-000000000001',
    )).toBe('new-pass');
    expect(await targetSecrets.get(
      'AI Terminal/ssh/00000000-0000-4000-8000-000000000003',
    )).toBeUndefined();
    expect(await targetSecrets.get(
      'AI Terminal/provider/00000000-0000-4000-8000-000000000004',
    )).toBe('api-key');
  });
});
