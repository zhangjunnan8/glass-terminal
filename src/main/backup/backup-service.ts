import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
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
import { AppSettingsStore } from '../settings/app-settings-store';
import { validateProviderBackupMetadata } from '../providers/provider-store';
import { validateSessionBackupMetadata } from '../sessions/session-store';
import type { SecretEntry, SecretStore } from '../providers/secret-store';
import {
  BACKUP_IMPORT_LIMITS,
  ImportFilesystemTransaction,
  type ImportTransactionHooks,
  SafeZipArchive,
  parseBackupManifest,
  parseJsonBuffer,
  parseSecretMap,
  readSecretNamespace,
  replaceSecretNamespace,
  validateCredentialBindings,
  validateSessionData,
  verifyFileBytes,
} from './import-safety';

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
 * bundle. Import is deliberately two-phase: every selected section is staged
 * and validated before reversible filesystem replacement begins, and Provider
 * credentials are committed and verified last.
 */
export class BackupService {
  constructor(
    private readonly paths: BackupPaths,
    private readonly secretStore: SecretStore,
    private readonly appVersion: string,
    private readonly importHooks: ImportTransactionHooks = {},
  ) {}

  async exportToFile(path: string, includeLogs = false): Promise<BackupExportResult> {
    const zip = new AdmZip();
    const sections: Record<string, BackupSectionEnvelope> = {};

    for (const [name, fileName] of CONFIG_SECTIONS) {
      const data = readJson(this.paths[name]);
      if (data === undefined) continue;
      const entry = `sections/${fileName}`;
      zip.addFile(entry, jsonBytes(data));
      sections[name] = { schemaVersion: 1, file: entry };
    }

    const providerSecrets = await this.readProviderSecrets();
    zip.addFile(
      'sections/provider-secrets.json',
      jsonBytes(Object.fromEntries(
        providerSecrets.map((entry) => [entry.reference, entry.secret]),
      )),
    );
    sections[PROVIDER_SECRETS_SECTION] = {
      schemaVersion: 1,
      file: 'sections/provider-secrets.json',
    };

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
    zip.addFile('manifest.json', jsonBytes(manifest));

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
    const archive = new SafeZipArchive(path);
    const manifest = parseBackupManifest(parseJsonBuffer(
      archive.read('manifest.json', BACKUP_IMPORT_LIMITS.maxManifestBytes),
      'manifest.json',
    ));
    const transaction = new ImportFilesystemTransaction(this.importHooks);
    const sectionsImported: string[] = [];
    const sectionsSkipped: BackupImportResult['sectionsSkipped'] = [];
    const expectedFiles = new Map<string, Buffer>();
    const expectedSessionFiles = new Map<string, Buffer>();
    const claimedEntries = new Set<string>();
    let incomingProviderData: unknown;
    let incomingProviderBindings: ReadonlyMap<string, boolean> | undefined;
    let incomingSecrets: Map<string, string> | undefined;

    try {
      for (const [name, fileName] of CONFIG_SECTIONS) {
        const envelope = manifest.sections[name];
        if (envelope === undefined) continue;
        if (envelope.schemaVersion !== 1) {
          sectionsSkipped.push({
            section: name,
            reason: `schemaVersion ${envelope.schemaVersion} 不受支持`,
          });
          continue;
        }
        const entryPath = envelope.file ?? `sections/${fileName}`;
        if (!entryPath.toLocaleLowerCase('en-US').startsWith('sections/')) {
          throw new Error(`备份 section ${name} 必须位于 sections/ 根目录。`);
        }
        claimArchiveEntry(claimedEntries, entryPath);
        const data = parseJsonBuffer(archive.read(entryPath), entryPath);
        const serialized = jsonBytes(data);
        const staged = transaction.stageFile(this.paths[name], serialized);
        if (name === 'settings') {
          new AppSettingsStore(staged).get();
        } else if (name === 'providers') {
          incomingProviderData = data;
          incomingProviderBindings = validateProviderBackupMetadata(data);
        } else {
          validateObjectSection(data, 'Codex App Server 配置');
        }
        expectedFiles.set(this.paths[name], serialized);
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
          if (!entryPath.toLocaleLowerCase('en-US').startsWith('sections/')) {
            throw new Error('Provider 凭据 section 必须位于 sections/ 根目录。');
          }
          claimArchiveEntry(claimedEntries, entryPath);
          incomingSecrets = parseSecretMap(
            parseJsonBuffer(archive.read(entryPath), entryPath),
            PROVIDER_SECRET_PREFIX,
            'Provider 凭据 section',
          );
          sectionsImported.push(PROVIDER_SECRETS_SECTION);
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
          const prefix = sessionsEnvelope.file ?? `${SESSIONS_SECTION}/`;
          if (prefix.replace(/\/$/, '').toLocaleLowerCase('en-US') !== SESSIONS_SECTION) {
            throw new Error('Session section 必须位于 sessions/ 根目录。');
          }
          const stagedSessions = transaction.stageDirectory(this.paths.sessions);
          for (const entry of archive.filesUnder(prefix)) {
            const data = archive.read(entry.path);
            validateSessionData(entry.relative, data);
            if (entry.relative.toLocaleLowerCase('en-US').endsWith('/session.json')) {
              const record = validateSessionBackupMetadata(
                parseJsonBuffer(data, entry.relative),
                entry.relative,
              );
              if (record.id !== entry.relative.split('/')[0]) {
                throw new Error(`Session 目录与元数据 ID 不匹配：${entry.relative}`);
              }
            }
            transaction.writeDirectoryFile(stagedSessions, entry.relative, data);
            expectedSessionFiles.set(entry.relative, data);
          }
          sectionsImported.push(SESSIONS_SECTION);
        }
      }

      if (incomingSecrets) {
        const bindings = incomingProviderBindings
          ?? validateProviderBackupMetadata(readRequiredJson(
            this.paths.providers,
            '当前 Provider 元数据',
          ));
        validateCredentialBindings(bindings, incomingSecrets, 'Provider 凭据 section');
      } else if (incomingProviderData !== undefined && incomingProviderBindings) {
        const existingSecrets = await readSecretNamespace(this.secretStore, PROVIDER_SECRET_PREFIX);
        const referencedExisting = new Map([...existingSecrets].filter(([reference]) => (
          incomingProviderBindings!.has(reference)
        )));
        validateCredentialBindings(
          incomingProviderBindings,
          referencedExisting,
          'Provider 元数据',
        );
      }

      transaction.commit();
      this.verifyCommittedFiles(expectedFiles, expectedSessionFiles);
      if (incomingSecrets) {
        await replaceSecretNamespace(this.secretStore, PROVIDER_SECRET_PREFIX, incomingSecrets);
      }
      transaction.finalize();
      return {
        sectionsImported,
        sectionsSkipped,
        needsRestart: sectionsImported.length > 0,
      };
    } catch (error) {
      try {
        transaction.rollback();
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], '备份导入失败且文件回滚未能完整完成。');
      }
      throw error;
    }
  }

  private verifyCommittedFiles(
    expectedFiles: ReadonlyMap<string, Buffer>,
    expectedSessionFiles: ReadonlyMap<string, Buffer>,
  ): void {
    for (const [target, expected] of expectedFiles) {
      verifyFileBytes(target, expected);
      if (target === this.paths.settings) {
        new AppSettingsStore(target).get();
      } else if (target === this.paths.providers) {
        validateProviderBackupMetadata(JSON.parse(readFileSync(target, 'utf8')) as unknown);
      } else if (target === this.paths.codexAppServer) {
        validateObjectSection(
          JSON.parse(readFileSync(target, 'utf8')) as unknown,
          'Codex App Server 配置',
        );
      }
    }
    for (const [relativePath, expected] of expectedSessionFiles) {
      const target = join(this.paths.sessions, ...relativePath.split('/'));
      verifyFileBytes(target, expected);
      validateSessionData(relativePath, readFileSync(target));
    }
  }

  private async readProviderSecrets(): Promise<SecretEntry[]> {
    const entries = await this.secretStore.entries?.() ?? [];
    return entries.filter((entry) => entry.reference.startsWith(PROVIDER_SECRET_PREFIX));
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
}

function jsonBytes(data: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function validateObjectSection(value: unknown, label: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}格式无效。`);
  }
}

function readRequiredJson(path: string, label: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${label}不存在，无法验证凭据引用。`);
    }
    throw error;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label}不是有效 JSON。`);
  }
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

function claimArchiveEntry(claimed: Set<string>, path: string): void {
  const key = path.toLocaleLowerCase('en-US');
  if (claimed.has(key)) throw new Error(`多个备份 section 引用了同一 ZIP entry：${path}`);
  claimed.add(key);
}
