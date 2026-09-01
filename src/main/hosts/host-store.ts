import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  CreateHostFolderRequest,
  HostFolder,
  HostInput,
  HostProfile,
  MoveHostFolderRequest,
  MoveHostRequest,
  RenameHostFolderRequest,
  SshAuthMethod,
  SshShellKind,
} from '../../shared/host';
import type { AgentReviewMode } from '../../shared/agent';

const HOST_STORE_VERSION = 4;
const MAX_HOST_NAME_LENGTH = 160;
const MAX_FOLDER_NAME_LENGTH = 120;
const MAX_PERSISTED_FOLDER_NAME_LENGTH = 2_048;
const MAX_FOLDER_COUNT = 1_000;
const AUTH_METHODS = new Set<SshAuthMethod>([
  'password',
  'private-key',
  'agent',
  'keyboard-interactive',
]);
const SHELL_KINDS = new Set<SshShellKind>(['posix', 'powershell', 'cmd']);
const REVIEW_MODES = new Set<AgentReviewMode>(['all', 'risky', 'complete']);

interface NormalizedHostInput {
  protocol: 'ssh';
  name: string;
  hostname: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  privateKeyPath?: string;
  favorite: boolean;
  shellKind: SshShellKind;
}

interface StoredHostProfile extends Omit<HostProfile, 'group'> {
  credentialReference?: string;
  revision: number;
}

interface HostStoreDocument {
  version: number;
  folders: HostFolder[];
  hosts: StoredHostProfile[];
}

interface HostStoreState {
  folders: HostFolder[];
  hosts: StoredHostProfile[];
  needsMigration?: boolean;
}

export interface HostSaveResult {
  host: HostProfile;
  retiredCredentialReference?: string;
}

function requiredText(
  value: unknown,
  field: string,
  maximumLength = 512,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required.`);
  }
  const normalized = value.trim();
  if (normalized.length > maximumLength) {
    throw new Error(`${field} is too long.`);
  }
  return normalized;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function safeOrder(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function reviewModePreference(
  value: unknown,
  legacyFullTakeover = false,
): AgentReviewMode {
  if (value === undefined) return legacyFullTakeover ? 'complete' : 'all';
  if (typeof value === 'string' && REVIEW_MODES.has(value as AgentReviewMode)) {
    return value as AgentReviewMode;
  }
  throw new Error('Invalid Host AI review mode preference.');
}

function normalizeInput(input: HostInput): NormalizedHostInput {
  const protocol = (input as { protocol?: unknown }).protocol ?? 'ssh';
  if (protocol !== 'ssh') {
    throw new Error(`Host protocol ${String(protocol)} is not implemented.`);
  }
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Port must be an integer from 1 to 65535.');
  }
  if (!AUTH_METHODS.has(input.authMethod)) {
    throw new Error('Unsupported SSH authentication method.');
  }
  const privateKeyPath = optionalText(input.privateKeyPath);
  if (input.authMethod === 'private-key' && !privateKeyPath) {
    throw new Error('A private key path is required.');
  }
  const shellKind: SshShellKind = input.shellKind && SHELL_KINDS.has(input.shellKind)
    ? input.shellKind
    : 'posix';
  return {
    protocol: 'ssh',
    name: requiredText(input.name, 'Host name', MAX_HOST_NAME_LENGTH),
    hostname: requiredText(input.hostname, 'Hostname'),
    port,
    username: requiredText(input.username, 'Username'),
    authMethod: input.authMethod,
    privateKeyPath,
    favorite: Boolean(input.favorite),
    shellKind,
  };
}

function parseFolder(value: unknown, fallbackOrder: number): HostFolder {
  if (!value || typeof value !== 'object') throw new Error('Invalid Host folder.');
  const candidate = value as Partial<HostFolder>;
  return {
    id: requiredText(candidate.id, 'Host folder id'),
    name: requiredText(
      candidate.name,
      'Host folder name',
      MAX_PERSISTED_FOLDER_NAME_LENGTH,
    ),
    sortOrder: safeOrder(candidate.sortOrder, fallbackOrder),
    createdAt: requiredText(candidate.createdAt, 'Host folder createdAt'),
    updatedAt: requiredText(candidate.updatedAt, 'Host folder updatedAt'),
  };
}

function parseHost(
  value: unknown,
  fallbackOrder: number,
  folderId?: string,
): StoredHostProfile {
  if (!value || typeof value !== 'object') throw new Error('Invalid Host profile.');
  const candidate = value as Partial<StoredHostProfile> & {
    group?: unknown;
    fullTakeover?: unknown;
  };
  const id = requiredText(candidate.id, 'Host id');
  const normalized = normalizeInput({
    name: candidate.name ?? '',
    protocol: candidate.protocol,
    hostname: candidate.hostname ?? '',
    port: candidate.port ?? 0,
    username: candidate.username ?? '',
    authMethod: candidate.authMethod as SshAuthMethod,
    privateKeyPath: candidate.privateKeyPath,
    favorite: candidate.favorite,
    shellKind: candidate.shellKind,
  });
  const expectedReference = `AI Terminal/ssh/${id}`;
  const credentialReference = candidate.credentialReference === expectedReference
    ? expectedReference
    : undefined;
  const preferredReviewMode = reviewModePreference(
    candidate.reviewModePreference,
    candidate.fullTakeoverPreference === true || candidate.fullTakeover === true,
  );
  return {
    id,
    ...normalized,
    hostKeyFingerprint: optionalText(candidate.hostKeyFingerprint),
    ...(folderId ? { folderId } : {}),
    sortOrder: safeOrder(candidate.sortOrder, fallbackOrder),
    credentialConfigured: candidate.credentialConfigured === true && Boolean(credentialReference),
    credentialReference,
    reviewModePreference: preferredReviewMode,
    fullTakeoverPreference: preferredReviewMode === 'complete',
    revision: Number.isSafeInteger(candidate.revision) && Number(candidate.revision) > 0
      ? Number(candidate.revision)
      : 1,
    createdAt: requiredText(candidate.createdAt, 'Host createdAt'),
    updatedAt: requiredText(candidate.updatedAt, 'Host updatedAt'),
  };
}

function publicHost(host: StoredHostProfile, folders: HostFolder[]): HostProfile {
  const {
    credentialReference: _credentialReference,
    revision: _revision,
    ...profile
  } = host;
  const group = host.folderId
    ? folders.find((folder) => folder.id === host.folderId)?.name
    : undefined;
  return { ...profile, ...(group ? { group } : {}) };
}

function identityChanged(
  existing: StoredHostProfile,
  normalized: NormalizedHostInput,
): boolean {
  return existing.protocol !== normalized.protocol
    || existing.hostname !== normalized.hostname
    || existing.port !== normalized.port
    || existing.username !== normalized.username
    || existing.authMethod !== normalized.authMethod
    || (
      (existing.authMethod === 'private-key' || normalized.authMethod === 'private-key')
      && existing.privateKeyPath !== normalized.privateKeyPath
    );
}

function sameFolder(left: string | undefined, right: string | undefined): boolean {
  return left === right;
}

function folderNameKey(name: string): string {
  return name.normalize('NFKC').toLowerCase();
}

function stableLegacyFolderId(name: string): string {
  const digest = createHash('sha256').update(folderNameKey(name)).digest('hex').slice(0, 24);
  return `legacy-${digest}`;
}

function assertUnique<T>(items: T[], value: (item: T) => string, label: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    const key = value(item);
    if (seen.has(key)) throw new Error(`Duplicate ${label}: ${key}`);
    seen.add(key);
  }
}

function comparePosition<T extends { sortOrder: number; name?: string; id: string }>(
  left: T,
  right: T,
): number {
  return left.sortOrder - right.sortOrder
    || (left.name ?? '').localeCompare(right.name ?? '')
    || left.id.localeCompare(right.id);
}

export class HostStore {
  private hosts: StoredHostProfile[];
  private folders: HostFolder[];

  constructor(private readonly filePath: string) {
    const state = this.read();
    this.hosts = state.hosts;
    this.folders = state.folders;
    if (state.needsMigration) this.write(this.hosts, this.folders);
  }

  list(): HostProfile[] {
    const folderOrder = new Map(
      this.listFolders().map((folder, index) => [folder.id, index]),
    );
    return [...this.hosts].sort((left, right) => {
      const leftFolder = left.folderId ? (folderOrder.get(left.folderId) ?? Number.MAX_SAFE_INTEGER) : -1;
      const rightFolder = right.folderId ? (folderOrder.get(right.folderId) ?? Number.MAX_SAFE_INTEGER) : -1;
      return leftFolder - rightFolder || comparePosition(left, right);
    }).map((host) => publicHost(host, this.folders));
  }

  listFolders(): HostFolder[] {
    return [...this.folders].sort(comparePosition).map((folder) => ({ ...folder }));
  }

  get(hostId: string): HostProfile {
    return publicHost(this.getStored(hostId), this.folders);
  }

  credentialReference(hostId: string): string | undefined {
    const host = this.getStored(hostId);
    return host.credentialConfigured ? host.credentialReference : undefined;
  }

  revision(hostId: string): number {
    return this.getStored(hostId).revision;
  }

  setFullTakeoverPreference(hostId: string, enabled: boolean): HostProfile {
    return this.setReviewModePreference(hostId, enabled ? 'complete' : 'all');
  }

  setReviewModePreference(hostId: string, mode: AgentReviewMode): HostProfile {
    const existing = this.getStored(hostId);
    const normalizedMode = reviewModePreference(mode);
    const updated: StoredHostProfile = {
      ...existing,
      reviewModePreference: normalizedMode,
      fullTakeoverPreference: normalizedMode === 'complete',
      revision: existing.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    this.replace(updated);
    return publicHost(updated, this.folders);
  }

  connectionIdentityChanged(input: HostInput): boolean {
    const normalized = normalizeInput(input);
    const existing = input.id
      ? this.hosts.find((host) => host.id === input.id)
      : undefined;
    return existing ? identityChanged(existing, normalized) : false;
  }

  save(input: HostInput): HostProfile {
    return this.saveWithCredentialRetirement(input).host;
  }

  saveWithCredentialRetirement(input: HostInput): HostSaveResult {
    const now = new Date().toISOString();
    const existing = input.id
      ? this.hosts.find((host) => host.id === input.id)
      : undefined;
    if (input.id && !existing) throw new Error(`Host not found: ${input.id}`);
    const normalized = normalizeInput(input);
    const folderSelection = this.resolveFolderSelection(input, existing, now);
    const connectionChanged = existing ? identityChanged(existing, normalized) : false;
    const targetChanged = existing
      ? existing.hostname !== normalized.hostname || existing.port !== normalized.port
      : false;
    const movingFolder = existing
      ? !sameFolder(existing.folderId, folderSelection.folderId)
      : false;
    const preferredReviewMode = existing?.reviewModePreference
      ?? reviewModePreference(
        input.reviewModePreference,
        input.fullTakeoverPreference === true || input.fullTakeover === true,
      );
    const host: StoredHostProfile = {
      id: existing?.id ?? randomUUID(),
      ...normalized,
      hostKeyFingerprint: targetChanged ? undefined : existing?.hostKeyFingerprint,
      ...(folderSelection.folderId ? { folderId: folderSelection.folderId } : {}),
      sortOrder: existing && !movingFolder
        ? existing.sortOrder
        : this.nextHostOrder(folderSelection.folderId),
      credentialConfigured: connectionChanged ? false : existing?.credentialConfigured ?? false,
      credentialReference: connectionChanged ? undefined : existing?.credentialReference,
      reviewModePreference: preferredReviewMode,
      fullTakeoverPreference: preferredReviewMode === 'complete',
      revision: (existing?.revision ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const next = existing
      ? this.hosts.map((item) => item.id === host.id ? host : item)
      : [...this.hosts, host];
    this.commit(next, folderSelection.folders);
    return {
      host: publicHost(host, folderSelection.folders),
      ...(connectionChanged && existing?.credentialReference
        ? { retiredCredentialReference: existing.credentialReference }
        : {}),
    };
  }

  createFolder(request: CreateHostFolderRequest): HostFolder {
    if (this.folders.length >= MAX_FOLDER_COUNT) {
      throw new Error(`Host folder limit (${MAX_FOLDER_COUNT}) reached.`);
    }
    const name = this.availableFolderName(request?.name);
    const now = new Date().toISOString();
    const folder: HostFolder = {
      id: randomUUID(),
      name,
      sortOrder: this.nextFolderOrder(),
      createdAt: now,
      updatedAt: now,
    };
    this.commit(this.hosts, [...this.folders, folder]);
    return { ...folder };
  }

  renameFolder(request: RenameHostFolderRequest): HostFolder {
    const folderId = requiredText(request?.folderId, 'Host folder id');
    const existing = this.getFolder(folderId);
    const name = this.availableFolderName(request?.name, folderId);
    if (name === existing.name) return { ...existing };
    const updated: HostFolder = {
      ...existing,
      name,
      updatedAt: new Date().toISOString(),
    };
    this.commit(
      this.hosts,
      this.folders.map((folder) => folder.id === folderId ? updated : folder),
    );
    return { ...updated };
  }

  removeFolder(folderIdValue: string): void {
    const folderId = requiredText(folderIdValue, 'Host folder id');
    this.getFolder(folderId);
    if (this.hosts.some((host) => host.folderId === folderId)) {
      throw new Error('只能删除空的主机文件夹。');
    }
    this.commit(this.hosts, this.folders.filter((folder) => folder.id !== folderId));
  }

  moveFolder(request: MoveHostFolderRequest): HostFolder[] {
    const folderId = requiredText(request?.folderId, 'Host folder id');
    const moving = this.getFolder(folderId);
    if (request.beforeFolderId === folderId) return this.listFolders();
    const ordered = this.listFolders().filter((folder) => folder.id !== folderId);
    let insertionIndex = ordered.length;
    if (request.beforeFolderId !== null) {
      const beforeId = requiredText(request.beforeFolderId, 'Before Host folder id');
      insertionIndex = ordered.findIndex((folder) => folder.id === beforeId);
      if (insertionIndex < 0) throw new Error(`Host folder not found: ${beforeId}`);
    }
    ordered.splice(insertionIndex, 0, moving);
    const positions = new Map(ordered.map((folder, index) => [folder.id, index]));
    const next = this.folders.map((folder) => ({
      ...folder,
      sortOrder: positions.get(folder.id)!,
    }));
    this.commit(this.hosts, next);
    return this.listFolders();
  }

  moveHost(request: MoveHostRequest): HostProfile {
    const hostId = requiredText(request?.hostId, 'Host id');
    const moving = this.getStored(hostId);
    const destinationFolderId = this.requestedFolderId(request.folderId);
    if (request.beforeHostId === hostId && sameFolder(moving.folderId, destinationFolderId)) {
      return publicHost(moving, this.folders);
    }
    const remaining = this.hosts.filter((host) => host.id !== hostId);
    const destination = remaining
      .filter((host) => sameFolder(host.folderId, destinationFolderId))
      .sort(comparePosition);
    let insertionIndex = destination.length;
    if (request.beforeHostId !== null) {
      const beforeId = requiredText(request.beforeHostId, 'Before Host id');
      insertionIndex = destination.findIndex((host) => host.id === beforeId);
      if (insertionIndex < 0) {
        const target = remaining.find((host) => host.id === beforeId);
        if (target) throw new Error('The target Host is not in the destination folder.');
        throw new Error(`Host not found: ${beforeId}`);
      }
    }
    const moved: StoredHostProfile = {
      ...moving,
      ...(destinationFolderId ? { folderId: destinationFolderId } : { folderId: undefined }),
    };
    destination.splice(insertionIndex, 0, moved);
    const destinationPositions = new Map(
      destination.map((host, index) => [host.id, index]),
    );
    const source = sameFolder(moving.folderId, destinationFolderId)
      ? []
      : remaining.filter((host) => sameFolder(host.folderId, moving.folderId)).sort(comparePosition);
    const sourcePositions = new Map(source.map((host, index) => [host.id, index]));
    const next = [...remaining, moved].map((host) => {
      const destinationPosition = destinationPositions.get(host.id);
      if (destinationPosition !== undefined) return { ...host, sortOrder: destinationPosition };
      const sourcePosition = sourcePositions.get(host.id);
      return sourcePosition === undefined ? host : { ...host, sortOrder: sourcePosition };
    });
    this.commit(next, this.folders);
    return this.get(hostId);
  }

  configureCredential(
    hostId: string,
    reference: string,
    expectedRevision?: number,
  ): HostProfile {
    const host = this.getStored(hostId);
    this.assertRevision(host, expectedRevision);
    if (reference !== `AI Terminal/ssh/${host.id}`) {
      throw new Error('Invalid Host credential reference.');
    }
    const updated: StoredHostProfile = {
      ...host,
      credentialConfigured: true,
      credentialReference: reference,
      revision: host.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    this.replace(updated);
    return publicHost(updated, this.folders);
  }

  retireCredential(hostId: string, expectedRevision?: number): string | undefined {
    const host = this.getStored(hostId);
    this.assertRevision(host, expectedRevision);
    const reference = host.credentialReference;
    if (!reference && !host.credentialConfigured) return undefined;
    const updated: StoredHostProfile = {
      ...host,
      credentialConfigured: false,
      credentialReference: undefined,
      revision: host.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    this.replace(updated);
    return reference;
  }

  remove(hostId: string): void {
    const next = this.hosts.filter((host) => host.id !== hostId);
    if (next.length === this.hosts.length) throw new Error(`Host not found: ${hostId}`);
    this.commit(next, this.folders);
  }

  trustFingerprint(
    hostId: string,
    fingerprint: string,
    expectedRevision?: number,
  ): HostProfile {
    const host = this.getStored(hostId);
    this.assertRevision(host, expectedRevision);
    const updated: StoredHostProfile = {
      ...host,
      hostKeyFingerprint: requiredText(fingerprint, 'Host key fingerprint'),
      revision: host.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    this.replace(updated);
    return publicHost(updated, this.folders);
  }

  private getStored(hostId: string): StoredHostProfile {
    const host = this.hosts.find((item) => item.id === hostId);
    if (!host) throw new Error(`Host not found: ${hostId}`);
    return host;
  }

  private getFolder(folderId: string): HostFolder {
    const folder = this.folders.find((item) => item.id === folderId);
    if (!folder) throw new Error(`Host folder not found: ${folderId}`);
    return folder;
  }

  private requestedFolderId(folderId: string | null): string | undefined {
    if (folderId === null) return undefined;
    const normalized = requiredText(folderId, 'Host folder id');
    this.getFolder(normalized);
    return normalized;
  }

  private resolveFolderSelection(
    input: HostInput,
    existing: StoredHostProfile | undefined,
    now: string,
  ): { folderId?: string; folders: HostFolder[] } {
    if (Object.prototype.hasOwnProperty.call(input, 'folderId')) {
      if (input.folderId === null || input.folderId === undefined) {
        return { folders: this.folders };
      }
      const folderId = requiredText(input.folderId, 'Host folder id');
      this.getFolder(folderId);
      return { folderId, folders: this.folders };
    }
    if (Object.prototype.hasOwnProperty.call(input, 'group')) {
      const groupName = optionalText(input.group);
      if (!groupName) return { folders: this.folders };
      if (groupName.length > MAX_FOLDER_NAME_LENGTH) {
        throw new Error('Host folder name is too long.');
      }
      const existingFolder = this.folders.find(
        (folder) => folderNameKey(folder.name) === folderNameKey(groupName),
      );
      if (existingFolder) return { folderId: existingFolder.id, folders: this.folders };
      if (this.folders.length >= MAX_FOLDER_COUNT) {
        throw new Error(`Host folder limit (${MAX_FOLDER_COUNT}) reached.`);
      }
      const folder: HostFolder = {
        id: randomUUID(),
        name: groupName,
        sortOrder: this.nextFolderOrder(),
        createdAt: now,
        updatedAt: now,
      };
      return { folderId: folder.id, folders: [...this.folders, folder] };
    }
    return {
      ...(existing?.folderId ? { folderId: existing.folderId } : {}),
      folders: this.folders,
    };
  }

  private availableFolderName(value: unknown, excludingId?: string): string {
    const name = requiredText(value, 'Host folder name', MAX_FOLDER_NAME_LENGTH);
    const duplicate = this.folders.some((folder) => (
      folder.id !== excludingId
      && folderNameKey(folder.name) === folderNameKey(name)
    ));
    if (duplicate) throw new Error('已存在同名的主机文件夹。');
    return name;
  }

  private nextFolderOrder(): number {
    return this.folders.reduce((maximum, folder) => Math.max(maximum, folder.sortOrder), -1) + 1;
  }

  private nextHostOrder(folderId: string | undefined): number {
    return this.hosts.reduce((maximum, host) => (
      sameFolder(host.folderId, folderId) ? Math.max(maximum, host.sortOrder) : maximum
    ), -1) + 1;
  }

  private assertRevision(host: StoredHostProfile, expectedRevision: number | undefined): void {
    if (expectedRevision !== undefined && host.revision !== expectedRevision) {
      throw new Error('Host profile changed during the SSH operation.');
    }
  }

  private replace(host: StoredHostProfile): void {
    this.commit(this.hosts.map((item) => item.id === host.id ? host : item), this.folders);
  }

  private read(): HostStoreState {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (Array.isArray(parsed)) return this.readLegacy(parsed);
      if (!parsed || typeof parsed !== 'object') return { folders: [], hosts: [] };
      const document = parsed as Partial<HostStoreDocument>;
      if (![2, 3, HOST_STORE_VERSION].includes(document.version ?? -1)) {
        throw new Error(`Unsupported Host store version: ${String(document.version)}`);
      }
      if (!Array.isArray(document.folders) || !Array.isArray(document.hosts)) {
        throw new Error('Invalid Host store document.');
      }
      const folders = document.folders.map(parseFolder);
      assertUnique(folders, (folder) => folder.id, 'Host folder id');
      assertUnique(
        folders,
        (folder) => folderNameKey(folder.name),
        'Host folder name',
      );
      const folderIds = new Set(folders.map((folder) => folder.id));
      const hosts = document.hosts.map((value, index) => {
        const candidate = value as Partial<StoredHostProfile>;
        const folderId = optionalText(candidate?.folderId);
        if (folderId && !folderIds.has(folderId)) {
          throw new Error(`Host folder not found: ${folderId}`);
        }
        return parseHost(value, index, folderId);
      });
      assertUnique(hosts, (host) => host.id, 'Host id');
      return {
        folders,
        hosts,
        ...(document.version !== HOST_STORE_VERSION ? { needsMigration: true } : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { folders: [], hosts: [] };
      }
      throw new Error(`Unable to read Host store: ${(error as Error).message}`);
    }
  }

  private readLegacy(values: unknown[]): HostStoreState {
    const folders: HostFolder[] = [];
    const folderByName = new Map<string, HostFolder>();
    const groupPositions = new Map<string, number>();
    const rootPosition = { value: 0 };
    const hosts = values.map((value) => {
      const candidate = value as Partial<StoredHostProfile> & { group?: unknown };
      const rawGroupName = optionalText(candidate?.group);
      const groupName = rawGroupName
        ? requiredText(rawGroupName, 'Host folder name', MAX_PERSISTED_FOLDER_NAME_LENGTH)
        : undefined;
      let folder: HostFolder | undefined;
      if (groupName) {
        const key = folderNameKey(groupName);
        folder = folderByName.get(key);
        if (!folder) {
          const timestamp = typeof candidate.createdAt === 'string'
            ? candidate.createdAt
            : new Date(0).toISOString();
          folder = {
            id: stableLegacyFolderId(groupName),
            name: groupName,
            sortOrder: folders.length,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          folders.push(folder);
          folderByName.set(key, folder);
          groupPositions.set(folder.id, 0);
        }
      }
      const sortOrder = folder
        ? (groupPositions.get(folder.id) ?? 0)
        : rootPosition.value;
      if (folder) groupPositions.set(folder.id, sortOrder + 1);
      else rootPosition.value += 1;
      return parseHost(value, sortOrder, folder?.id);
    });
    assertUnique(hosts, (host) => host.id, 'Host id');
    return { folders, hosts, needsMigration: true };
  }

  private commit(hosts: StoredHostProfile[], folders: HostFolder[]): void {
    this.write(hosts, folders);
    this.hosts = hosts;
    this.folders = folders;
  }

  private write(hosts: StoredHostProfile[], folders: HostFolder[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp-${process.pid}`;
    const document: HostStoreDocument = {
      version: HOST_STORE_VERSION,
      folders,
      hosts,
    };
    writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporaryPath, this.filePath);
  }
}
