import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  BACKUP_FORMAT_VERSION,
  HOST_SECRET_PREFIX,
} from '../../shared/backup';
import type {
  BackupExportResult,
  BackupImportResult,
  BackupManifest,
} from '../../shared/backup';
import type { SecretEntry, SecretStore } from '../providers/secret-store';

const HOSTS_SECTION = 'hosts';
const HOST_SECRETS_SECTION = 'hostSecrets';

/**
 * Independent SSH-host backup. It carries `hosts.json` plus the matching SSH
 * host credentials, keeping host configuration fully separate from the general
 * application-settings backup.
 */
export class HostBackupService {
  constructor(
    private readonly hostsPath: string,
    private readonly secretStore: SecretStore,
    private readonly appVersion: string,
  ) {}

  async exportToFile(path: string): Promise<BackupExportResult> {
    const hosts = readJson(this.hostsPath);
    const hostSecrets = await this.readHostSecrets();
    const manifest: BackupManifest = {
      formatVersion: BACKUP_FORMAT_VERSION,
      appVersion: this.appVersion,
      exportedAt: new Date().toISOString(),
      sections: {
        ...(hosts === undefined ? {} : { [HOSTS_SECTION]: { schemaVersion: 1, data: hosts } }),
        [HOST_SECRETS_SECTION]: {
          schemaVersion: 1,
          data: Object.fromEntries(
            hostSecrets.map((entry) => [entry.reference, entry.secret]),
          ),
        },
      },
    };
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, serialized, 'utf8');
    return {
      path,
      exportedAt: manifest.exportedAt,
      sections: Object.keys(manifest.sections),
      bytes: Buffer.byteLength(serialized, 'utf8'),
    };
  }

  async importFromFile(path: string): Promise<BackupImportResult> {
    const raw = readFileSync(path, 'utf8');
    const manifest = parseManifest(JSON.parse(raw) as unknown);
    const sectionsImported: string[] = [];
    const sectionsSkipped: BackupImportResult['sectionsSkipped'] = [];

    const hostsEnvelope = manifest.sections[HOSTS_SECTION];
    if (hostsEnvelope !== undefined) {
      if (hostsEnvelope.schemaVersion !== 1) {
        sectionsSkipped.push({
          section: HOSTS_SECTION,
          reason: `schemaVersion ${hostsEnvelope.schemaVersion} 不受支持`,
        });
      } else {
        writeJson(this.hostsPath, hostsEnvelope.data);
        sectionsImported.push(HOSTS_SECTION);
      }
    }

    const secretsEnvelope = manifest.sections[HOST_SECRETS_SECTION];
    if (secretsEnvelope !== undefined) {
      if (secretsEnvelope.schemaVersion !== 1) {
        sectionsSkipped.push({
          section: HOST_SECRETS_SECTION,
          reason: `schemaVersion ${secretsEnvelope.schemaVersion} 不受支持`,
        });
      } else {
        await this.replaceHostSecrets(secretsEnvelope.data);
        sectionsImported.push(HOST_SECRETS_SECTION);
      }
    }

    return {
      sectionsImported,
      sectionsSkipped,
      needsRestart: sectionsImported.length > 0,
    };
  }

  private async readHostSecrets(): Promise<SecretEntry[]> {
    const entries = await this.secretStore.entries?.() ?? [];
    return entries.filter((entry) => entry.reference.startsWith(HOST_SECRET_PREFIX));
  }

  private async replaceHostSecrets(data: unknown): Promise<void> {
    const incoming = data as Record<string, unknown> | undefined;
    const map = new Map<string, string>();
    if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
      for (const [reference, secret] of Object.entries(incoming)) {
        if (
          typeof secret === 'string'
          && secret
          && reference.startsWith(HOST_SECRET_PREFIX)
        ) map.set(reference, secret);
      }
    }
    const existing = await this.secretStore.entries?.() ?? [];
    for (const entry of existing) {
      if (
        entry.reference.startsWith(HOST_SECRET_PREFIX)
        && !map.has(entry.reference)
      ) await this.secretStore.remove(entry.reference);
    }
    for (const [reference, secret] of map) {
      await this.secretStore.set(reference, secret);
    }
  }
}

function parseManifest(manifest: unknown): BackupManifest {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('备份文件格式无效。');
  }
  const candidate = manifest as Partial<BackupManifest>;
  if (candidate.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error(`不支持的备份格式版本：${String(candidate.formatVersion)}`);
  }
  if (!candidate.sections || typeof candidate.sections !== 'object') {
    throw new Error('备份文件缺少 sections。');
  }
  return candidate as BackupManifest;
}

function readJson(path: string): unknown | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return JSON.parse(raw) as unknown;
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}
