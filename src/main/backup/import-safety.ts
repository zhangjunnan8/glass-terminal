import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import AdmZip from 'adm-zip';
import {
  BACKUP_FORMAT_VERSION,
  type BackupManifest,
  type BackupSectionEnvelope,
} from '../../shared/backup';
import { isAllowedCredentialReference, type SecretStore } from '../providers/secret-store';

export const BACKUP_IMPORT_LIMITS = {
  maxEntries: 20_000,
  maxDirectoryDepth: 16,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxManifestBytes: 1024 * 1024,
  maxJsonBytes: 16 * 1024 * 1024,
  maxPortableJsonBytes: 32 * 1024 * 1024,
  maxArchiveBytes: 512 * 1024 * 1024,
} as const;

interface NormalizedArchivePath {
  path: string;
  directory: boolean;
}

interface StagedReplacement {
  target: string;
  staged: string;
  backup: string;
  kind: 'file' | 'directory';
  originalMoved: boolean;
  installed: boolean;
}

export interface ImportTransactionHooks {
  /** Test-only fault injection at an exact reversible commit boundary. */
  beforeInstall?: (target: string, index: number) => void;
}

function importError(message: string): Error {
  return new Error(`备份导入安全校验失败：${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeArchivePath(raw: string): NormalizedArchivePath {
  if (!raw || raw.includes('\0')) throw importError('ZIP entry 路径为空或包含 NUL。');
  if (raw.includes('\\')) throw importError(`ZIP entry 使用了非标准路径分隔符：${raw}`);
  if (isAbsolute(raw) || raw.startsWith('/') || raw.startsWith('//') || /^[a-z]:/i.test(raw)) {
    throw importError(`ZIP entry 不能使用绝对路径、盘符或 UNC：${raw}`);
  }
  const directory = raw.endsWith('/');
  const withoutTrailingSlash = directory ? raw.slice(0, -1) : raw;
  const segments = withoutTrailingSlash.split('/');
  if (
    !withoutTrailingSlash
    || segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) throw importError(`ZIP entry 路径未规范化或试图逃逸根目录：${raw}`);
  if (segments.length > BACKUP_IMPORT_LIMITS.maxDirectoryDepth) {
    throw importError(`ZIP entry 目录深度超过 ${BACKUP_IMPORT_LIMITS.maxDirectoryDepth}：${raw}`);
  }
  if (segments.some((segment) => segment.length > 255)) {
    throw importError(`ZIP entry 路径片段过长：${raw}`);
  }
  if (segments.some((segment) => (
    /[<>:"|?*\u0000-\u001f]/.test(segment)
    || /[. ]$/.test(segment)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
  ))) throw importError(`ZIP entry 包含不可安全落盘的路径片段：${raw}`);
  return { path: segments.join('/'), directory };
}

function archiveEntrySize(entry: AdmZip.IZipEntry): number {
  const size = Number(entry.header.size);
  const compressedSize = Number(entry.header.compressedSize);
  if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(compressedSize) || compressedSize < 0) {
    throw importError(`ZIP entry 大小元数据无效：${entry.entryName}`);
  }
  if (size > BACKUP_IMPORT_LIMITS.maxEntryBytes) {
    throw importError(`ZIP entry 解压大小超过 ${BACKUP_IMPORT_LIMITS.maxEntryBytes} 字节：${entry.entryName}`);
  }
  if (size > 0 && compressedSize === 0) {
    throw importError(`ZIP entry 压缩大小异常：${entry.entryName}`);
  }
  if (size > 1024 && size / Math.max(1, compressedSize) > BACKUP_IMPORT_LIMITS.maxCompressionRatio) {
    throw importError(`ZIP entry 压缩率超过 ${BACKUP_IMPORT_LIMITS.maxCompressionRatio}:1：${entry.entryName}`);
  }
  return size;
}

function validateArchiveEntries(entries: AdmZip.IZipEntry[]): Map<string, AdmZip.IZipEntry> {
  if (entries.length > BACKUP_IMPORT_LIMITS.maxEntries) {
    throw importError(`ZIP entry 数量超过 ${BACKUP_IMPORT_LIMITS.maxEntries}。`);
  }
  const result = new Map<string, AdmZip.IZipEntry>();
  const entryKinds = new Map<string, 'file' | 'directory'>();
  let declaredBytes = 0;
  for (const entry of entries) {
    const normalized = normalizeArchivePath(entry.entryName);
    const key = normalized.path.toLocaleLowerCase('en-US');
    if (result.has(key)) throw importError(`ZIP 包含重复 entry：${normalized.path}`);
    const declaredDirectory = normalized.directory || entry.isDirectory;
    if (declaredDirectory !== entry.isDirectory) {
      throw importError(`ZIP entry 的目录标记不一致：${entry.entryName}`);
    }
    const size = archiveEntrySize(entry);
    if (entry.isDirectory && size !== 0) {
      throw importError(`ZIP 目录 entry 不能包含数据：${entry.entryName}`);
    }
    declaredBytes += size;
    if (declaredBytes > BACKUP_IMPORT_LIMITS.maxTotalBytes) {
      throw importError(`ZIP 总解压大小超过 ${BACKUP_IMPORT_LIMITS.maxTotalBytes} 字节。`);
    }
    result.set(key, entry);
    entryKinds.set(key, entry.isDirectory ? 'directory' : 'file');
  }

  for (const [key] of result) {
    const segments = key.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join('/');
      if (entryKinds.get(ancestor) === 'file') {
        throw importError(`ZIP entry 位于文件路径之下：${key}`);
      }
    }
  }
  return result;
}

export class SafeZipArchive {
  private readonly entries: Map<string, AdmZip.IZipEntry>;
  private actualBytes = 0;

  constructor(path: string) {
    let archiveBytes: number;
    try {
      archiveBytes = statSync(path).size;
    } catch {
      throw importError('ZIP 文件不存在或无法读取。');
    }
    if (archiveBytes > BACKUP_IMPORT_LIMITS.maxArchiveBytes) {
      throw importError(`ZIP 文件超过 ${BACKUP_IMPORT_LIMITS.maxArchiveBytes} 字节。`);
    }
    let zip: AdmZip;
    try {
      zip = new AdmZip(path);
    } catch {
      throw importError('ZIP 文件损坏或无法读取。');
    }
    this.entries = validateArchiveEntries(zip.getEntries());
  }

  has(path: string): boolean {
    const normalized = normalizeArchivePath(path);
    return this.entries.has(normalized.path.toLocaleLowerCase('en-US'));
  }

  read(path: string, maxBytes = BACKUP_IMPORT_LIMITS.maxEntryBytes): Buffer {
    const normalized = normalizeArchivePath(path);
    const entry = this.entries.get(normalized.path.toLocaleLowerCase('en-US'));
    if (!entry || entry.isDirectory) throw importError(`ZIP 缺少文件：${normalized.path}`);
    let data: Buffer;
    try {
      data = entry.getData();
    } catch {
      throw importError(`ZIP entry 解压或 CRC 校验失败：${normalized.path}`);
    }
    if (data.byteLength !== Number(entry.header.size)) {
      throw importError(`ZIP entry 实际解压大小与元数据不一致：${normalized.path}`);
    }
    if (data.byteLength > maxBytes) {
      throw importError(`ZIP entry 实际解压大小超过 ${maxBytes} 字节：${normalized.path}`);
    }
    this.actualBytes += data.byteLength;
    if (this.actualBytes > BACKUP_IMPORT_LIMITS.maxTotalBytes) {
      throw importError(`ZIP 实际解压总量超过 ${BACKUP_IMPORT_LIMITS.maxTotalBytes} 字节。`);
    }
    return data;
  }

  filesUnder(prefix: string): Array<{ path: string; relative: string }> {
    const normalizedPrefix = normalizeArchivePath(prefix.endsWith('/') ? prefix : `${prefix}/`).path;
    const prefixWithSlash = `${normalizedPrefix}/`;
    return [...this.entries.values()].flatMap((entry) => {
      if (entry.isDirectory) return [];
      const normalized = normalizeArchivePath(entry.entryName).path;
      if (!normalized.toLocaleLowerCase('en-US').startsWith(prefixWithSlash.toLocaleLowerCase('en-US'))) {
        return [];
      }
      return [{ path: normalized, relative: normalized.slice(prefixWithSlash.length) }];
    });
  }
}

export function parseBackupManifest(value: unknown): BackupManifest {
  if (!isRecord(value)) throw importError('manifest.json 必须是对象。');
  if (value.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error(`不支持的备份格式版本：${String(value.formatVersion)}`);
  }
  if (typeof value.appVersion !== 'string' || value.appVersion.length > 200) {
    throw importError('manifest appVersion 无效。');
  }
  if (
    typeof value.exportedAt !== 'string'
    || value.exportedAt.length > 100
    || Number.isNaN(Date.parse(value.exportedAt))
  ) throw importError('manifest exportedAt 无效。');
  if (!isRecord(value.sections)) throw importError('manifest 缺少 sections 对象。');
  const sectionEntries = Object.entries(value.sections);
  if (sectionEntries.length > 64) throw importError('manifest sections 数量过多。');
  const sections: Record<string, BackupSectionEnvelope> = {};
  for (const [name, envelopeValue] of sectionEntries) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) || !isRecord(envelopeValue)) {
      throw importError(`manifest section 无效：${name}`);
    }
    const schemaVersion = envelopeValue.schemaVersion;
    if (!Number.isSafeInteger(schemaVersion) || Number(schemaVersion) < 1) {
      throw importError(`manifest section schemaVersion 无效：${name}`);
    }
    const file = envelopeValue.file;
    if (file !== undefined && typeof file !== 'string') {
      throw importError(`manifest section file 无效：${name}`);
    }
    if (file !== undefined) normalizeArchivePath(file);
    if (file !== undefined && Object.prototype.hasOwnProperty.call(envelopeValue, 'data')) {
      throw importError(`manifest section 不能同时包含 data 和 file：${name}`);
    }
    sections[name] = {
      schemaVersion: Number(schemaVersion),
      ...(file === undefined ? {} : { file }),
      ...(Object.prototype.hasOwnProperty.call(envelopeValue, 'data')
        ? { data: envelopeValue.data }
        : {}),
    };
  }
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: value.appVersion,
    exportedAt: value.exportedAt,
    sections,
  };
}

export function parseJsonBuffer(buffer: Buffer, label: string): unknown {
  if (buffer.byteLength > BACKUP_IMPORT_LIMITS.maxJsonBytes) {
    throw importError(`${label} 超过 JSON 大小限制。`);
  }
  try {
    return JSON.parse(buffer.toString('utf8')) as unknown;
  } catch {
    throw importError(`${label} 不是有效 JSON。`);
  }
}

export function validateSessionData(relativePath: string, data: Buffer): void {
  const lower = relativePath.toLocaleLowerCase('en-US');
  if (lower.endsWith('.json')) {
    parseJsonBuffer(data, `Session 文件 ${relativePath}`);
    return;
  }
  if (!lower.endsWith('.jsonl')) return;
  const lines = data.toString('utf8').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    try {
      JSON.parse(lines[index]);
    } catch {
      throw importError(`Session JSONL 无效：${relativePath}:${index + 1}`);
    }
  }
}

function uniqueSibling(target: string, role: 'stage' | 'rollback'): string {
  return join(
    dirname(target),
    `.${basename(target)}.backup-import-${role}-${process.pid}-${randomUUID()}`,
  );
}

function syncFile(path: string): void {
  const descriptor = openSync(path, fsConstants.O_RDWR);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export class ImportFilesystemTransaction {
  private readonly replacements: StagedReplacement[] = [];
  private committed = false;

  constructor(private readonly hooks: ImportTransactionHooks = {}) {}

  stageFile(target: string, data: Buffer | string): string {
    mkdirSync(dirname(target), { recursive: true });
    const staged = uniqueSibling(target, 'stage');
    writeFileSync(staged, data, { flag: 'wx', mode: 0o600 });
    syncFile(staged);
    this.replacements.push({
      target,
      staged,
      backup: uniqueSibling(target, 'rollback'),
      kind: 'file',
      originalMoved: false,
      installed: false,
    });
    return staged;
  }

  stageDirectory(target: string): string {
    mkdirSync(dirname(target), { recursive: true });
    const staged = uniqueSibling(target, 'stage');
    mkdirSync(staged, { recursive: false, mode: 0o700 });
    this.replacements.push({
      target,
      staged,
      backup: uniqueSibling(target, 'rollback'),
      kind: 'directory',
      originalMoved: false,
      installed: false,
    });
    return staged;
  }

  writeDirectoryFile(root: string, relativePath: string, data: Buffer): string {
    const normalized = normalizeArchivePath(relativePath);
    if (normalized.directory) throw importError(`不能把目录写成文件：${relativePath}`);
    const target = resolve(root, ...normalized.path.split('/'));
    const rootPath = resolve(root);
    if (target === rootPath || !target.startsWith(`${rootPath}${process.platform === 'win32' ? '\\' : '/'}`)) {
      throw importError(`staging 路径逃逸：${relativePath}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data, { flag: 'wx', mode: 0o600 });
    return target;
  }

  commit(): void {
    if (this.committed) throw new Error('Backup import transaction has already committed.');
    try {
      for (let index = 0; index < this.replacements.length; index += 1) {
        const replacement = this.replacements[index];
        this.hooks.beforeInstall?.(replacement.target, index);
        if (existsSync(replacement.target)) {
          renameSync(replacement.target, replacement.backup);
          replacement.originalMoved = true;
        }
        renameSync(replacement.staged, replacement.target);
        replacement.installed = true;
      }
      this.committed = true;
    } catch (error) {
      try {
        this.rollback();
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], '备份提交失败且回滚未能完整完成。');
      }
      throw error;
    }
  }

  rollback(): void {
    for (const replacement of [...this.replacements].reverse()) {
      if (replacement.installed && existsSync(replacement.target)) {
        rmSync(replacement.target, {
          recursive: replacement.kind === 'directory',
          force: true,
        });
        replacement.installed = false;
      }
      if (replacement.originalMoved && existsSync(replacement.backup)) {
        renameSync(replacement.backup, replacement.target);
        replacement.originalMoved = false;
      }
      if (existsSync(replacement.staged)) {
        rmSync(replacement.staged, {
          recursive: replacement.kind === 'directory',
          force: true,
        });
      }
    }
    this.committed = false;
  }

  finalize(): void {
    for (const replacement of this.replacements) {
      for (const leftover of [replacement.backup, replacement.staged]) {
        if (!existsSync(leftover)) continue;
        try {
          rmSync(leftover, {
            recursive: replacement.kind === 'directory',
            force: true,
          });
        } catch (error) {
          // The live replacement is already verified. A cleanup failure must
          // never delete that replacement after an earlier rollback copy was
          // successfully removed; leave the uniquely named orphan for later.
          console.error('Unable to clean a completed backup-import artifact:', error);
        }
      }
    }
  }
}

export function portableJsonBytes(path: string): Buffer {
  const size = statSync(path).size;
  if (size > BACKUP_IMPORT_LIMITS.maxPortableJsonBytes) {
    throw importError(`备份文件超过 ${BACKUP_IMPORT_LIMITS.maxPortableJsonBytes} 字节。`);
  }
  const data = readFileSync(path);
  if (data.byteLength > BACKUP_IMPORT_LIMITS.maxPortableJsonBytes) {
    throw importError(`备份文件超过 ${BACKUP_IMPORT_LIMITS.maxPortableJsonBytes} 字节。`);
  }
  return data;
}

export function parseSecretMap(data: unknown, prefix: string, label: string): Map<string, string> {
  if (!isRecord(data)) throw importError(`${label} 必须是对象。`);
  const result = new Map<string, string>();
  for (const [reference, secret] of Object.entries(data)) {
    if (
      !reference.startsWith(prefix)
      || !isAllowedCredentialReference(reference)
      || typeof secret !== 'string'
      || !secret
      || Buffer.byteLength(secret, 'utf8') > 64 * 1024
    ) throw importError(`${label} 包含无效的凭据引用或值。`);
    result.set(reference, secret);
  }
  return result;
}

export async function readSecretNamespace(
  store: SecretStore,
  prefix: string,
): Promise<Map<string, string>> {
  if (!store.entries) throw importError('当前 SecretStore 不支持安全的凭据事务。');
  const entries = await store.entries();
  return new Map(entries
    .filter((entry) => entry.reference.startsWith(prefix))
    .map((entry) => [entry.reference, entry.secret]));
}

async function restoreSecretNamespace(
  store: SecretStore,
  prefix: string,
  snapshot: Map<string, string>,
): Promise<void> {
  if (store.replaceNamespace) {
    await store.replaceNamespace(prefix, [...snapshot].map(([reference, secret]) => ({
      reference,
      secret,
    })));
    return;
  }
  const current = await readSecretNamespace(store, prefix);
  for (const reference of current.keys()) await store.remove(reference);
  for (const [reference, secret] of snapshot) await store.set(reference, secret);
}

export async function replaceSecretNamespace(
  store: SecretStore,
  prefix: string,
  incoming: Map<string, string>,
): Promise<void> {
  const snapshot = await readSecretNamespace(store, prefix);
  try {
    if (store.replaceNamespace) {
      await store.replaceNamespace(prefix, [...incoming].map(([reference, secret]) => ({
        reference,
        secret,
      })));
    } else {
      for (const reference of snapshot.keys()) {
        if (!incoming.has(reference)) await store.remove(reference);
      }
      for (const [reference, secret] of incoming) await store.set(reference, secret);
    }
    const verified = await readSecretNamespace(store, prefix);
    if (
      verified.size !== incoming.size
      || [...incoming].some(([reference, secret]) => verified.get(reference) !== secret)
    ) throw importError('SecretStore 提交后验证失败。');
  } catch (error) {
    try {
      await restoreSecretNamespace(store, prefix, snapshot);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], '凭据导入失败且回滚未能完整完成。');
    }
    throw error;
  }
}

export function validateCredentialBindings(
  bindings: ReadonlyMap<string, boolean>,
  secrets: ReadonlyMap<string, string>,
  label: string,
): void {
  for (const reference of secrets.keys()) {
    if (!bindings.has(reference)) throw importError(`${label} 包含没有元数据引用的凭据。`);
  }
  for (const [reference, configured] of bindings) {
    if (configured && !secrets.has(reference)) {
      throw importError(`${label} 缺少元数据声明为已配置的凭据。`);
    }
  }
}

export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function verifyFileBytes(path: string, expected: Buffer): void {
  const actual = readFileSync(path);
  if (actual.byteLength !== expected.byteLength || sha256(actual) !== sha256(expected)) {
    throw importError(`提交后文件验证失败：${basename(path)}`);
  }
}
