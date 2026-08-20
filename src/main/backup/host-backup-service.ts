import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { HostStore } from '../hosts/host-store';
import { isAllowedCredentialReference, type SecretEntry, type SecretStore } from '../providers/secret-store';
import {
  ImportFilesystemTransaction,
  type ImportTransactionHooks,
  parseBackupManifest,
  parseSecretMap,
  portableJsonBytes,
  readSecretNamespace,
  replaceSecretNamespace,
  validateCredentialBindings,
  verifyFileBytes,
} from './import-safety';

const HOSTS_SECTION = 'hosts';
const HOST_SECRETS_SECTION = 'hostSecrets';

/**
 * Independent SSH-host backup. Import validates Host schema and credential
 * bindings against staged data before replacing either live metadata or the
 * SecretStore namespace.
 */
export class HostBackupService {
  constructor(
    private readonly hostsPath: string,
    private readonly secretStore: SecretStore,
    private readonly appVersion: string,
    private readonly importHooks: ImportTransactionHooks = {},
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
    const manifest = parseBackupManifest(parsePortableManifest(path));
    const sectionsImported: string[] = [];
    const sectionsSkipped: BackupImportResult['sectionsSkipped'] = [];
    const transaction = new ImportFilesystemTransaction(this.importHooks);
    let expectedHosts: Buffer | undefined;
    let incomingBindings: ReadonlyMap<string, boolean> | undefined;
    let incomingSecrets: Map<string, string> | undefined;

    try {
      const hostsEnvelope = manifest.sections[HOSTS_SECTION];
      if (hostsEnvelope !== undefined) {
        if (hostsEnvelope.schemaVersion !== 1) {
          sectionsSkipped.push({
            section: HOSTS_SECTION,
            reason: `schemaVersion ${hostsEnvelope.schemaVersion} 不受支持`,
          });
        } else {
          if (hostsEnvelope.file !== undefined || hostsEnvelope.data === undefined) {
            throw new Error('Host section 必须包含内联 data。');
          }
          const staged = transaction.stageFile(
            this.hostsPath,
            `${JSON.stringify(hostsEnvelope.data, null, 2)}\n`,
          );
          incomingBindings = validateStagedHosts(staged);
          expectedHosts = readFileSync(staged);
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
          if (secretsEnvelope.file !== undefined || secretsEnvelope.data === undefined) {
            throw new Error('Host 凭据 section 必须包含内联 data。');
          }
          incomingSecrets = parseSecretMap(
            secretsEnvelope.data,
            HOST_SECRET_PREFIX,
            'Host 凭据 section',
          );
          sectionsImported.push(HOST_SECRETS_SECTION);
        }
      }

      if (incomingSecrets) {
        const bindings = incomingBindings ?? validateStagedHosts(this.hostsPath);
        validateCredentialBindings(bindings, incomingSecrets, 'Host 凭据 section');
      } else if (incomingBindings) {
        const existingSecrets = await readSecretNamespace(this.secretStore, HOST_SECRET_PREFIX);
        const referencedExisting = new Map([...existingSecrets].filter(([reference]) => (
          incomingBindings!.has(reference)
        )));
        validateCredentialBindings(incomingBindings, referencedExisting, 'Host 元数据');
      }

      transaction.commit();
      if (expectedHosts) {
        verifyFileBytes(this.hostsPath, expectedHosts);
        validateStagedHosts(this.hostsPath);
      }
      if (incomingSecrets) {
        await replaceSecretNamespace(this.secretStore, HOST_SECRET_PREFIX, incomingSecrets);
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
        throw new AggregateError([error, rollbackError], 'Host 备份导入失败且文件回滚未能完整完成。');
      }
      throw error;
    }
  }

  private async readHostSecrets(): Promise<SecretEntry[]> {
    const entries = await this.secretStore.entries?.() ?? [];
    return entries.filter((entry) => entry.reference.startsWith(HOST_SECRET_PREFIX));
  }
}

function parsePortableManifest(path: string): unknown {
  const raw = portableJsonBytes(path);
  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    throw new Error('Host 备份文件不是有效 JSON。');
  }
}

function validateStagedHosts(path: string): ReadonlyMap<string, boolean> {
  const store = new HostStore(path);
  const profiles = store.list();
  const bindings = new Map<string, boolean>();
  for (const profile of profiles) {
    const reference = store.credentialReference(profile.id);
    if (!reference) {
      if (profile.credentialConfigured) {
        throw new Error(`Host ${profile.id} 声明已配置凭据但缺少引用。`);
      }
      continue;
    }
    if (
      !reference.startsWith(HOST_SECRET_PREFIX)
      || !isAllowedCredentialReference(reference)
    ) throw new Error(`Host ${profile.id} 的凭据引用无效。`);
    if (bindings.has(reference)) throw new Error(`Host 元数据重复使用凭据引用：${reference}`);
    bindings.set(reference, profile.credentialConfigured);
  }
  return bindings;
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
