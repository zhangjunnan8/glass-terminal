import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Dirent } from 'node:fs';
import AdmZip from 'adm-zip';
import {
  BACKUP_FORMAT_VERSION,
  PROVIDER_SECRET_PREFIX,
} from '../../shared/backup';
import type {
  BackupExportResult,
  BackupImportResult,
  BackupManifest,
  BackupSectionEnvelope,
} from '../../shared/backup';
import type { SecretEntry, SecretStore } from '../providers/secret-store';

interface BackupPaths {
  settings: string;
  providers: string;
  codexAppServer: string;
  /** Root of per-session data and logs; bundled only when requested. */
  sessions: string;
}

const CONFIG_SECTIONS = [
  ['settings', 'settings.json'],
  ['providers', 'providers.json'],
  ['codexAppServer', 'codex-app-server.json'],
] as const;
const PROVIDER_SECRETS_SECTION = 'providerSecrets';
const SESSIONS_SECTION = 'sessions';

/**
 * Serializes the app's non-host configuration into a single versioned ZIP
 * bundle. Small sections live as JSON files referenced from `manifest.json`;
 * session logs live under a `sessions/` directory only when requested. Every
 * section carries its own `schemaVersion`, and unknown sections are skipped on
 * import, so future settings remain forward-compatible.
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

  async exportToFile(path: string, includeLogs = false): Promise<BackupExportResult> {
    const zip = new AdmZip();
    const sections: Record<string, BackupSectionEnvelope> = {};

    for (const [name, fileName] of CONFIG_SECTIONS) {
      const data = readJson(this.paths[name]);
      if (data === undefined) continue;
      const entry = `sections/${fileName}`;
      zip.addFile(entry, Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8'));
      sections[name] = { schemaVersion: 1, file: entry };
    }

    const providerSecrets = await this.readProviderSecrets();
    zip.addFile(
      `sections/provider-secrets.json`,
      Buffer.from(`${JSON.stringify(
        Object.fromEntries(providerSecrets.map((entry) => [entry.reference, entry.secret])),
        null,
        2,
      )}\n`, 'utf8'),
    );
    sections[PROVIDER_SECRETS_SECTION] = { schemaVersion: 1, file: 'sections/provider-secrets.json' };

    if (includeLogs) {
      this.addSessionsToZip(zip, this.paths.sessions);
      sections[SESSIONS_SECTION] = { schemaVersion: 1, file: `${SESSIONS_SECTION}/` };
    }

    const manifest: BackupManifest = {
      formatVersion: BACKUP_FORMAT_VERSION,
      appVersion: this.appVersion,
      exportedAt: new Date().toISOString(),
      sections,
    };
    zip.addFile('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));

    mkdirSync(dirname(path), { recursive: true });
    zip.writeZip(path);
    return {
      path,
      exportedAt: manifest.exportedAt,
      sections: Object.keys(manifest.sections),
      bytes: readFileSync(path).byteLength,
    };
  }

  async importFromFile(path: string): Promise<BackupImportResult> {
    const zip = new AdmZip(path);
    const manifestEntry = zip.getEntry('manifest.json');
    if (!manifestEntry) throw new Error('备份文件缺少 manifest.json。');
    const manifest = parseManifest(JSON.parse(manifestEntry.getData().toString('utf8')) as unknown);
    const sectionsImported: string[] = [];
    const sectionsSkipped: BackupImportResult['sectionsSkipped'] = [];

    for (const [name, fileName] of CONFIG_SECTIONS) {
      const envelope = manifest.sections[name];
      if (envelope === undefined) continue;
      if (envelope.schemaVersion !== 1) {
        sectionsSkipped.push({ section: name, reason: `schemaVersion ${envelope.schemaVersion} 不受支持` });
        continue;
      }
      const entryPath = envelope.file ?? `sections/${fileName}`;
      const entry = zip.getEntry(entryPath);
      if (!entry) {
        sectionsSkipped.push({ section: name, reason: '缺少对应文件' });
        continue;
      }
      const data = JSON.parse(entry.getData().toString('utf8')) as unknown;
      writeJson(this.paths[name], data);
      sectionsImported.push(name);
    }

    const secretEnvelope = manifest.sections[PROVIDER_SECRETS_SECTION];
    if (secretEnvelope !== undefined) {
      if (secretEnvelope.schemaVersion !== 1) {
        sectionsSkipped.push({
          section: PROVIDER_SECRETS_SECTION,
          reason: `schemaVersion ${secretEnvelope.schemaVersion} 不受支持`,
        });
      } else {
        const entryPath = secretEnvelope.file ?? 'sections/provider-secrets.json';
        const entry = zip.getEntry(entryPath);
        if (!entry) {
          sectionsSkipped.push({ section: PROVIDER_SECRETS_SECTION, reason: '缺少对应文件' });
        } else {
          await this.replaceProviderSecrets(JSON.parse(entry.getData().toString('utf8')) as unknown);
          sectionsImported.push(PROVIDER_SECRETS_SECTION);
        }
      }
    }

    const sessionsEnvelope = manifest.sections[SESSIONS_SECTION];
    if (sessionsEnvelope !== undefined) {
      if (sessionsEnvelope.schemaVersion !== 1) {
        sectionsSkipped.push({
          section: SESSIONS_SECTION,
          reason: `schemaVersion ${sessionsEnvelope.schemaVersion} 不受支持`,
        });
      } else {
        this.extractSessions(zip, this.paths.sessions);
        sectionsImported.push(SESSIONS_SECTION);
      }
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

  private addSessionsToZip(zip: AdmZip, sessionsDir: string): void {
    const walk = (dir: string, zipPrefix: string): void => {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      const normalizedPrefix = zipPrefix.replace(/\/$/, '');
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, `${normalizedPrefix}/${entry.name}/`);
        } else if (entry.isFile()) {
          zip.addLocalFile(full, normalizedPrefix);
        }
      }
    };
    walk(sessionsDir, `${SESSIONS_SECTION}/`);
  }

  private extractSessions(zip: AdmZip, sessionsDir: string): void {
    for (const entry of zip.getEntries()) {
      const name = entry.entryName;
      if (!name.startsWith(`${SESSIONS_SECTION}/`) || entry.isDirectory) continue;
      const relative = name.slice(`${SESSIONS_SECTION}/`.length);
      const target = join(sessionsDir, relative);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, entry.getData());
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
