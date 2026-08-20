import {
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
import { MemorySecretStore } from '../providers/secret-store';
import { HostBackupService } from './host-backup-service';
import { decryptBackupPayload } from './backup-crypto';

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
  writeFileSync(path, JSON.stringify({
    version: 3,
    folders: [],
    hosts: [{
      id: '00000000-0000-4000-8000-000000000001',
      protocol: 'ssh',
      name: 'Test',
      hostname: '192.0.2.10',
      port: 22,
      username: 'tester',
      authMethod: 'password',
      favorite: false,
      shellKind: 'posix',
      credentialConfigured: true,
      credentialReference: 'AI Terminal/ssh/00000000-0000-4000-8000-000000000001',
      fullTakeoverPreference: false,
      sortOrder: 0,
      revision: 1,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }],
  }), 'utf8');
}

class FailOnceSecretStore extends MemorySecretStore {
  failNextSet = false;

  override async set(reference: string, secret: string): Promise<void> {
    if (this.failNextSet) {
      this.failNextSet = false;
      throw new Error('injected host secret failure');
    }
    await super.set(reference, secret);
  }
}

function portableManifest(sections: Record<string, { schemaVersion: number; data: unknown }>) {
  return {
    formatVersion: 1,
    appVersion: '1.0.0',
    exportedAt: new Date(0).toISOString(),
    sections,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('HostBackupService', () => {
  it('excludes SSH credentials from the default plaintext Host export', async () => {
    const source = fixture();
    seedHosts(source);
    const secrets = new MemorySecretStore();
    await secrets.set('AI Terminal/ssh/00000000-0000-4000-8000-000000000001', 'host-canary');
    const bundlePath = join(source, 'hosts-no-credentials.aithosts');

    const exported = await new HostBackupService(hostsPath(source), secrets, '1.0.0')
      .exportToFile(bundlePath);

    expect(exported).toMatchObject({ encrypted: false, credentialsIncluded: false });
    expect(new HostBackupService(hostsPath(source), secrets, '1.0.0').inspectImportFile(bundlePath))
      .toMatchObject({ encrypted: false, legacyPlaintextCredentials: false });
    expect(exported.sections).toEqual(['hosts']);
    expect(readFileSync(bundlePath, 'utf8')).not.toContain('host-canary');
    expect(JSON.parse(readFileSync(bundlePath, 'utf8')).sections).not.toHaveProperty('hostSecrets');
  });

  it('encrypts Host credentials as a whole bundle, then imports them cleanly', async () => {
    const source = fixture();
    seedHosts(source);
    const secrets = new MemorySecretStore();
    await secrets.set('AI Terminal/ssh/00000000-0000-4000-8000-000000000001', 'host-pass');
    await secrets.set('AI Terminal/provider/00000000-0000-4000-8000-000000000002', 'api-key');

    const bundlePath = join(source, 'hosts.aithosts');
    const passphrase = 'host backup encryption password';
    const exported = await new HostBackupService(
      hostsPath(source),
      secrets,
      '1.0.0',
    ).exportToFile(bundlePath, {
      includeCredentials: true,
      passphrase,
      passphraseConfirmation: passphrase,
    });

    expect(exported.sections).toEqual(['hosts', 'hostSecrets']);
    expect(exported).toMatchObject({ encrypted: true, credentialsIncluded: true });
    expect(new HostBackupService(hostsPath(source), secrets, '1.0.0')
      .inspectImportFile(bundlePath)).toMatchObject({
      encrypted: true,
      legacyPlaintextCredentials: false,
    });
    const encrypted = readFileSync(bundlePath);
    expect(encrypted.includes(Buffer.from('host-pass'))).toBe(false);
    expect(encrypted.includes(Buffer.from('hostSecrets'))).toBe(false);
    const bundle = JSON.parse((await decryptBackupPayload(encrypted, passphrase)).toString('utf8')) as {
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
    ).importFromFile(bundlePath, { passphrase });

    expect(imported.sectionsImported).toEqual(['hosts', 'hostSecrets']);
    expect(JSON.parse(readFileSync(hostsPath(target), 'utf8')).hosts[0]).toMatchObject({
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Test',
      credentialConfigured: true,
    });
    expect(await targetSecrets.get(
      'AI Terminal/ssh/00000000-0000-4000-8000-000000000001',
    )).toBe('host-pass');
  });

  it('detects old plaintext Host credentials and requires explicit risk consent', async () => {
    const target = fixture();
    seedHosts(target);
    const before = readFileSync(hostsPath(target));
    const secrets = new MemorySecretStore();
    await secrets.set(
      'AI Terminal/ssh/00000000-0000-4000-8000-000000000001',
      'existing-host-secret',
    );
    const legacyPath = join(fixture(), 'legacy-plaintext.aithosts');
    writeFileSync(legacyPath, JSON.stringify(portableManifest({
      hosts: {
        schemaVersion: 1,
        data: JSON.parse(readFileSync(hostsPath(target), 'utf8')) as unknown,
      },
      hostSecrets: {
        schemaVersion: 1,
        data: {
          'AI Terminal/ssh/00000000-0000-4000-8000-000000000001': 'plaintext-host-secret',
        },
      },
    })));
    const service = new HostBackupService(hostsPath(target), secrets, '1.0.0');

    expect(service.inspectImportFile(legacyPath)).toMatchObject({
      encrypted: false,
      legacyPlaintextCredentials: true,
    });
    await expect(service.importFromFile(legacyPath)).rejects.toThrow('显式确认风险');
    expect(readFileSync(hostsPath(target))).toEqual(before);
    expect(await secrets.get(
      'AI Terminal/ssh/00000000-0000-4000-8000-000000000001',
    )).toBe('existing-host-secret');
  });

  it('replaces stale SSH secrets without touching Provider secrets', async () => {
    const source = fixture();
    seedHosts(source);
    const sourceSecrets = new MemorySecretStore();
    await sourceSecrets.set('AI Terminal/ssh/00000000-0000-4000-8000-000000000001', 'new-pass');
    const bundlePath = join(source, 'hosts.aithosts');
    const passphrase = 'stale host credential password';
    await new HostBackupService(hostsPath(source), sourceSecrets, '1.0.0')
      .exportToFile(bundlePath, {
        includeCredentials: true,
        passphrase,
        passphraseConfirmation: passphrase,
      });

    const targetSecrets = new MemorySecretStore();
    await targetSecrets.set('AI Terminal/ssh/00000000-0000-4000-8000-000000000001', 'old-pass');
    await targetSecrets.set('AI Terminal/ssh/00000000-0000-4000-8000-000000000003', 'stale');
    await targetSecrets.set('AI Terminal/provider/00000000-0000-4000-8000-000000000004', 'api-key');

    await new HostBackupService(hostsPath(fixture()), targetSecrets, '1.0.0')
      .importFromFile(bundlePath, { passphrase });

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

  it('rejects malformed Host data and credential-reference mismatches before commit', async () => {
    const target = fixture();
    seedHosts(target);
    const before = readFileSync(hostsPath(target));
    const secrets = new MemorySecretStore();
    await secrets.set('AI Terminal/ssh/00000000-0000-4000-8000-000000000001', 'old-pass');

    const malformedPath = join(fixture(), 'malformed.aithosts');
    writeFileSync(malformedPath, JSON.stringify(portableManifest({
      hosts: { schemaVersion: 1, data: [{ id: 'broken' }] },
      hostSecrets: { schemaVersion: 1, data: {} },
    })));
    await expect(new HostBackupService(hostsPath(target), secrets, '1.0.0')
      .importFromFile(malformedPath, {
        allowLegacyPlaintextCredentials: true,
      })).rejects.toThrow('Host store');
    expect(readFileSync(hostsPath(target))).toEqual(before);

    const source = fixture();
    seedHosts(source);
    const sourceManifest = portableManifest({
      hosts: {
        schemaVersion: 1,
        data: JSON.parse(readFileSync(hostsPath(source), 'utf8')) as unknown,
      },
      hostSecrets: { schemaVersion: 1, data: {} },
    });
    const missingSecretPath = join(fixture(), 'missing-secret.aithosts');
    writeFileSync(missingSecretPath, JSON.stringify(sourceManifest));
    await expect(new HostBackupService(hostsPath(target), secrets, '1.0.0')
      .importFromFile(missingSecretPath, {
        allowLegacyPlaintextCredentials: true,
      })).rejects.toThrow('缺少元数据声明为已配置的凭据');
    expect(readFileSync(hostsPath(target))).toEqual(before);
    expect(await secrets.get(
      'AI Terminal/ssh/00000000-0000-4000-8000-000000000001',
    )).toBe('old-pass');
  });

  it('rolls back Host metadata and secrets when the SecretStore write fails', async () => {
    const source = fixture();
    seedHosts(source);
    const sourceSecrets = new MemorySecretStore();
    await sourceSecrets.set(
      'AI Terminal/ssh/00000000-0000-4000-8000-000000000001',
      'new-pass',
    );
    const bundlePath = join(source, 'hosts.aithosts');
    const passphrase = 'host secret rollback password';
    await new HostBackupService(hostsPath(source), sourceSecrets, '1.0.0')
      .exportToFile(bundlePath, {
        includeCredentials: true,
        passphrase,
        passphraseConfirmation: passphrase,
      });

    const target = fixture();
    seedHosts(target);
    const original = JSON.parse(readFileSync(hostsPath(target), 'utf8')) as {
      hosts: Array<Record<string, unknown>>;
    };
    original.hosts[0].name = 'Original target';
    writeFileSync(hostsPath(target), JSON.stringify(original));
    const before = readFileSync(hostsPath(target));
    const targetSecrets = new FailOnceSecretStore();
    await targetSecrets.set(
      'AI Terminal/ssh/00000000-0000-4000-8000-000000000001',
      'old-pass',
    );
    targetSecrets.failNextSet = true;

    await expect(new HostBackupService(hostsPath(target), targetSecrets, '1.0.0')
      .importFromFile(bundlePath, { passphrase })).rejects.toThrow('host secret failure');
    expect(readFileSync(hostsPath(target))).toEqual(before);
    expect(await targetSecrets.get(
      'AI Terminal/ssh/00000000-0000-4000-8000-000000000001',
    )).toBe('old-pass');
    expect(readdirSync(dirname(hostsPath(target))).filter((name) => name.includes('.backup-import-')))
      .toEqual([]);
  });

  it('imports a valid legacy Host array through staging and migrates it safely', async () => {
    const timestamp = new Date(0).toISOString();
    const bundlePath = join(fixture(), 'legacy.aithosts');
    writeFileSync(bundlePath, JSON.stringify(portableManifest({
      hosts: {
        schemaVersion: 1,
        data: [{
          id: 'legacy-host',
          protocol: 'ssh',
          name: 'Legacy Host',
          hostname: '192.0.2.20',
          port: 22,
          username: 'tester',
          authMethod: 'password',
          favorite: false,
          credentialConfigured: false,
          fullTakeover: true,
          createdAt: timestamp,
          updatedAt: timestamp,
        }],
      },
      hostSecrets: { schemaVersion: 1, data: {} },
    })));
    const target = fixture();

    await new HostBackupService(
      hostsPath(target),
      new MemorySecretStore(),
      '1.0.0',
    ).importFromFile(bundlePath, {
      allowLegacyPlaintextCredentials: true,
    });

    const migrated = JSON.parse(readFileSync(hostsPath(target), 'utf8')) as {
      version: number;
      hosts: Array<Record<string, unknown>>;
    };
    expect(migrated.version).toBe(3);
    expect(migrated.hosts[0]).toMatchObject({
      id: 'legacy-host',
      fullTakeoverPreference: true,
    });
    expect(migrated.hosts[0]).not.toHaveProperty('fullTakeover');
  });
});
