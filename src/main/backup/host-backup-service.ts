import { readFileSync } from 'node:fs';
import {
  BACKUP_FORMAT_VERSION,
  HOST_SECRET_PREFIX,
} from '../../shared/backup';
import type {
  BackupExportResult,
  HostBackupExportRequest,
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
  readSecretNamespace,
  replaceSecretNamespace,
  validateCredentialBindings,
  verifyFileBytes,
} from './import-safety';
import {
  type BackupImportFileOptions,
  backupPayloadFingerprint,
  encryptBackupPayload,
  isEncryptedBackupPayload,
  loadBackupPayload,
  readBackupFile,
  validateBackupPassphrase,
  writeBackupFileAtomic,
} from './backup-crypto';

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

  async exportToFile(
    path: string,
    request: HostBackupExportRequest = {},
  ): Promise<BackupExportResult> {
    const includeCredentials = request.includeCredentials === true;
    const passphrase = includeCredentials
      ? validateBackupPassphrase(request.passphrase, request.passphraseConfirmation)
      : undefined;
    const hosts = readJson(this.hostsPath);
    const hostSecrets = includeCredentials ? await this.readHostSecrets() : [];
    const manifest: BackupManifest = {
      formatVersion: BACKUP_FORMAT_VERSION,
      appVersion: this.appVersion,
      exportedAt: new Date().toISOString(),
      sections: {
        ...(hosts === undefined ? {} : { [HOSTS_SECTION]: { schemaVersion: 1, data: hosts } }),
        ...(includeCredentials ? {
          [HOST_SECRETS_SECTION]: {
            schemaVersion: 1,
            data: Object.fromEntries(
              hostSecrets.map((entry) => [entry.reference, entry.secret]),
            ),
          },
        } : {}),
      },
    };
    const plaintext = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    let output: Buffer<ArrayBufferLike> = plaintext;
    try {
      if (includeCredentials) output = await encryptBackupPayload(plaintext, passphrase!);
      writeBackupFileAtomic(path, output);
    } finally {
      if (includeCredentials) plaintext.fill(0);
    }
    return {
      path,
      exportedAt: manifest.exportedAt,
      sections: Object.keys(manifest.sections),
      bytes: output.byteLength,
      encrypted: includeCredentials,
      credentialsIncluded: includeCredentials,
    };
  }

  inspectImportFile(path: string): {
    encrypted: boolean;
    legacyPlaintextCredentials: boolean;
    fingerprint: string;
  } {
    const source = readBackupFile(path);
    const fingerprint = backupPayloadFingerprint(source);
    if (isEncryptedBackupPayload(source)) {
      source.fill(0);
      return { encrypted: true, legacyPlaintextCredentials: false, fingerprint };
    }
    try {
      const manifest = parseBackupManifest(parsePortableManifest(source));
      return {
        encrypted: false,
        legacyPlaintextCredentials: manifest.sections[HOST_SECRETS_SECTION] !== undefined,
        fingerprint,
      };
    } finally {
      source.fill(0);
    }
  }

  async importFromFile(
    path: string,
    options: BackupImportFileOptions = {},
  ): Promise<BackupImportResult> {
    const loaded = await loadBackupPayload(path, options.passphrase);
    if (options.expectedFingerprint && loaded.fingerprint !== options.expectedFingerprint) {
      loaded.payload.fill(0);
      throw new Error('备份文件在确认期间发生变化，请重新选择。');
    }
    try {
      return await this.importManifest(
        parseBackupManifest(parsePortableManifest(loaded.payload)),
        loaded.encrypted || options.allowLegacyPlaintextCredentials === true,
      );
    } finally {
      loaded.payload.fill(0);
    }
  }

  private async importManifest(
    manifest: BackupManifest,
    credentialsMayBeImported: boolean,
  ): Promise<BackupImportResult> {
    if (
      manifest.sections[HOST_SECRETS_SECTION] !== undefined
      && !credentialsMayBeImported
    ) {
      throw new Error('旧版明文主机备份可能包含 SSH 密码或私钥口令，必须显式确认风险后才能导入。');
    }
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

function parsePortableManifest(raw: Buffer): unknown {
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
