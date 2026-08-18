import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  BACKUP_FORMAT_VERSION,
  PROVIDER_SECRET_PREFIX,
} from '../../shared/backup';
import type {
  BackupExportResult,
  BackupImportResult,
  BackupManifest,
} from '../../shared/backup';
import type { SecretEntry, SecretStore } from '../providers/secret-store';

interface BackupPaths {
  settings: string;
  providers: string;
  codexAppServer: string;
}

const CONFIG_SECTIONS = ['settings', 'providers', 'codexAppServer'] as const;
const PROVIDER_SECRETS_SECTION = 'providerSecrets';

/**
 * Serializes the app's non-host configuration into a single versioned JSON
 * bundle. Each section carries its own `schemaVersion`, so new settings can be
 * added (or existing ones migrated) without breaking older bundles, and unknown
 * sections are preserved/skipped on import rather than rejected.
 *
 * SSH host configuration is intentionally excluded: it lives in its own
 * independent export/import path (see the host backup service).
 */
export class BackupService {
  constructor(
    private readonly paths: BackupPaths,
    private readonly secretStore: SecretStore,
    private readonly appVersion: string,
  ) {}

  async buildManifest(): Promise<BackupManifest> {
    const sections: BackupManifest['sections'] = {};
    for (const name of CONFIG_SECTIONS) {
      const data = readJson(this.paths[name]);
      if (data === undefined) continue;
      sections[name] = { schemaVersion: 1, data };
    }

    const providerSecrets = await this.readProviderSecrets();
    sections[PROVIDER_SECRETS_SECTION] = {
      schemaVersion: 1,
      data: Object.fromEntries(
        providerSecrets.map((entry) => [entry.reference, entry.secret]),
      ),
    };

    return {
      formatVersion: BACKUP_FORMAT_VERSION,
      appVersion: this.appVersion,
      exportedAt: new Date().toISOString(),
      sections,
    };
  }

  async exportToFile(path: string): Promise<BackupExportResult> {
    const manifest = await this.buildManifest();
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
    return this.importManifest(JSON.parse(raw) as unknown);
  }

  async importManifest(manifest: unknown): Promise<BackupImportResult> {
    const parsed = parseManifest(manifest);
    const sections = parsed.sections ?? {};
    const sectionsImported: string[] = [];
    const sectionsSkipped: BackupImportResult['sectionsSkipped'] = [];

    for (const name of CONFIG_SECTIONS) {
      const envelope = sections[name];
      if (envelope === undefined) continue;
      if (envelope.schemaVersion !== 1) {
        sectionsSkipped.push({
          section: name,
          reason: `schemaVersion ${envelope.schemaVersion} 不受支持`,
        });
        continue;
      }
      writeJson(this.paths[name], envelope.data);
      sectionsImported.push(name);
    }

    const secretEnvelope = sections[PROVIDER_SECRETS_SECTION];
    if (secretEnvelope !== undefined && secretEnvelope.schemaVersion === 1) {
      await this.replaceProviderSecrets(secretEnvelope.data);
      sectionsImported.push(PROVIDER_SECRETS_SECTION);
    } else if (secretEnvelope !== undefined) {
      sectionsSkipped.push({
        section: PROVIDER_SECRETS_SECTION,
        reason: `schemaVersion ${secretEnvelope.schemaVersion} 不受支持`,
      });
    }

    return {
      sectionsImported,
      sectionsSkipped,
      needsRestart: sectionsImported.length > 0,
    };
  }

  private async readProviderSecrets(): Promise<SecretEntry[]> {
    const entries = await this.secretStore.entries?.() ?? [];
    return entries.filter((entry) => entry.reference.startsWith(PROVIDER_SECRET_PREFIX));
  }

  private async replaceProviderSecrets(data: unknown): Promise<void> {
    const incoming = data as Record<string, unknown> | undefined;
    const map = new Map<string, string>();
    if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
      for (const [reference, secret] of Object.entries(incoming)) {
        if (
          typeof secret === 'string'
          && secret
          && reference.startsWith(PROVIDER_SECRET_PREFIX)
        ) map.set(reference, secret);
      }
    }
    const existing = await this.secretStore.entries?.() ?? [];
    for (const entry of existing) {
      if (
        entry.reference.startsWith(PROVIDER_SECRET_PREFIX)
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
