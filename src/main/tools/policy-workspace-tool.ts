import { posix, win32 } from 'node:path';
import type {
  WorkspaceBinding,
  WorkspaceTool,
  WorkspaceToolPermissions,
} from '../../shared/tools';
import type { WorkspaceOperation } from '../sessions/workspace-operation-journal';

type WorkspaceCapability = 'read' | 'write' | 'create' | 'delete';
type WorkspaceScope = 'readable' | 'writable';
type PathFlavor = 'posix' | 'windows';

export const POLICY_WORKSPACE_AUDITOR = Symbol('policy-workspace-auditor');

export interface PolicyWorkspaceAuditRequest {
  operation: WorkspaceOperation;
  target: { path: string } | { source: string; destination: string };
  options?: { recursive?: boolean };
}

export interface PolicyWorkspaceAuditDelegate {
  [POLICY_WORKSPACE_AUDITOR](request: PolicyWorkspaceAuditRequest): void;
}

const MAX_POLICY_PATH_CHARS = 4_096;
const WINDOWS_RESERVED_FILE_STEM = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/iu;
const WINDOWS_DEVICE_NAMESPACE = /^(?:[\\/]{2}[?.][\\/]|[\\/]\?\?[\\/])/u;
const WINDOWS_DRIVE_RELATIVE = /^[A-Za-z]:(?![\\/])/u;
const WINDOWS_ROOT_RELATIVE = /^[\\/](?![\\/])/u;
const UNSAFE_PATH_CHARACTERS = /[\u0000-\u001f\u007f]/u;

function assertBoundedPath(path: string): void {
  if (!path || path.length > MAX_POLICY_PATH_CHARS || UNSAFE_PATH_CHARACTERS.test(path)) {
    throw new Error('Workspace path is empty, too long, or contains control characters.');
  }
}

function windowsSegments(path: string): string[] {
  const withoutDrive = path.replace(/^[A-Za-z]:[\\/]?/u, '');
  const withoutUncPrefix = withoutDrive.replace(/^[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]?/u, '');
  return withoutUncPrefix.split(/[\\/]/u).filter(Boolean);
}

function assertSafeWindowsPath(path: string): void {
  if (WINDOWS_DEVICE_NAMESPACE.test(path)) {
    throw new Error('Workspace paths cannot use a Windows device namespace.');
  }
  if (WINDOWS_DRIVE_RELATIVE.test(path)) {
    throw new Error('Workspace paths cannot use a Windows drive-relative spelling.');
  }
  if (WINDOWS_ROOT_RELATIVE.test(path)) {
    throw new Error('Workspace paths cannot use a Windows root-relative spelling.');
  }
  for (const segment of windowsSegments(path)) {
    if (segment === '.' || segment === '..') continue;
    const withoutTrailingDotsOrSpaces = segment.replace(/[. ]+$/u, '');
    const stem = withoutTrailingDotsOrSpaces.split('.', 1)[0] ?? '';
    if (
      segment.includes(':')
      || segment !== withoutTrailingDotsOrSpaces
      || WINDOWS_RESERVED_FILE_STEM.test(stem)
    ) {
      throw new Error(
        'Workspace path contains a Windows reserved name, trailing dot/space, or alternate data stream.',
      );
    }
  }
}

function localPathFlavor(root: string): PathFlavor {
  return /^[A-Za-z]:[\\/]/u.test(root) || /^[\\/]{2}/u.test(root)
    ? 'windows'
    : 'posix';
}

function canonicalAbsolutePath(path: string, flavor: PathFlavor): string {
  assertBoundedPath(path);
  if (flavor === 'windows') {
    assertSafeWindowsPath(path);
    if (!win32.isAbsolute(path)) {
      throw new Error('Workspace policy paths must be absolute.');
    }
    return win32.resolve(path);
  }
  if (!posix.isAbsolute(path)) {
    throw new Error('Workspace policy paths must be absolute.');
  }
  return posix.resolve(path);
}

function resolveRequestedPath(root: string, requestedPath: string, flavor: PathFlavor): string {
  assertBoundedPath(requestedPath);
  if (flavor === 'windows') {
    assertSafeWindowsPath(requestedPath);
    return win32.resolve(root, requestedPath);
  }
  return posix.resolve(root, requestedPath);
}

function pathIsWithin(scope: string, target: string, flavor: PathFlavor): boolean {
  const relative = flavor === 'windows'
    ? win32.relative(scope, target)
    : posix.relative(scope, target);
  if (!relative) return true;
  const normalized = flavor === 'windows' ? relative.toLocaleLowerCase('en-US') : relative;
  const parentPrefix = flavor === 'windows' ? `..${win32.sep}` : `..${posix.sep}`;
  return normalized !== '..'
    && !normalized.startsWith(parentPrefix)
    && !(flavor === 'windows' ? win32.isAbsolute(relative) : posix.isAbsolute(relative));
}

function clonePermissions(permissions: WorkspaceToolPermissions): WorkspaceToolPermissions {
  return {
    ...permissions,
    // A forged granular snapshot must not turn a narrower mode into path-unbounded access.
    fullAccess: permissions.mode === 'full-access' && permissions.fullAccess,
    readablePaths: [...permissions.readablePaths],
    writablePaths: [...permissions.writablePaths],
  };
}

/**
 * A fail-closed, per-call permission membrane around a workspace backend.
 *
 * The backend remains responsible for canonical/realpath and symlink checks.
 * This layer performs the independent lexical policy check before any delegate
 * method is reached, including calls not advertised to a model by the harness.
 */
export class PolicyWorkspaceTool implements WorkspaceTool {
  private readonly permissions: WorkspaceToolPermissions;
  private readonly flavor: PathFlavor;
  private readonly root: string;
  private readonly readablePaths: string[];
  private readonly writablePaths: string[];

  constructor(
    private readonly delegate: WorkspaceTool,
    binding: WorkspaceBinding,
    permissions: WorkspaceToolPermissions,
  ) {
    this.permissions = clonePermissions(permissions);
    this.flavor = binding.backend === 'sftp' ? 'posix' : localPathFlavor(binding.root);
    this.root = canonicalAbsolutePath(binding.root, this.flavor);
    this.readablePaths = this.permissions.fullAccess
      ? []
      : this.permissions.readablePaths.map((path) => canonicalAbsolutePath(path, this.flavor));
    this.writablePaths = this.permissions.fullAccess
      ? []
      : this.permissions.writablePaths.map((path) => canonicalAbsolutePath(path, this.flavor));
  }

  async listDirectory(path = '.') {
    this.authorizeOperation('list', { path }, () => {
      this.authorizePath(path, ['read'], ['readable'], 'workspace_list');
    });
    return this.delegate.listDirectory(path);
  }

  async readFile(path: string) {
    this.authorizeOperation('read', { path }, () => {
      this.authorizePath(path, ['read'], ['readable'], 'workspace_read_file');
    });
    return this.delegate.readFile(path);
  }

  async writeFile(path: string, content: string, expectedSha256: string | null) {
    this.authorizeOperation('write', { path }, () => {
      if (expectedSha256 === null) {
        this.authorizePath(path, ['create'], ['writable'], 'workspace_write_file');
      } else {
        this.authorizePath(
          path,
          ['read', 'write'],
          ['readable', 'writable'],
          'workspace_write_file',
        );
      }
    });
    return this.delegate.writeFile(path, content, expectedSha256);
  }

  async applyPatch(
    path: string,
    expectedSha256: string,
    patches: Parameters<WorkspaceTool['applyPatch']>[2],
  ) {
    this.authorizeOperation('patch', { path }, () => {
      this.authorizePath(
        path,
        ['read', 'write'],
        ['readable', 'writable'],
        'workspace_apply_patch',
      );
    });
    return this.delegate.applyPatch(path, expectedSha256, patches);
  }

  async search(query: string, options?: { path?: string; maxResults?: number }) {
    const path = options?.path ?? '.';
    this.authorizeOperation('search', { path }, () => {
      this.authorizePath(path, ['read'], ['readable'], 'workspace_search');
    });
    return this.delegate.search(query, options);
  }

  async glob(pattern: string, options?: { path?: string; maxResults?: number }) {
    const path = options?.path ?? '.';
    this.authorizeOperation('glob', { path }, () => {
      this.authorizePath(path, ['read'], ['readable'], 'workspace_glob');
    });
    return this.delegate.glob(pattern, options);
  }

  async stat(path: string) {
    this.authorizeOperation('stat', { path }, () => {
      this.authorizePath(path, ['read'], ['readable'], 'workspace_stat');
    });
    return this.delegate.stat(path);
  }

  async mkdir(path: string) {
    this.authorizeOperation('mkdir', { path }, () => {
      this.authorizePath(path, ['create'], ['writable'], 'workspace_mkdir');
    });
    return this.delegate.mkdir(path);
  }

  async rename(source: string, destination: string) {
    const capabilities: WorkspaceCapability[] = ['write', 'create', 'delete'];
    this.authorizeOperation('rename', { source, destination }, () => {
      this.authorizePath(source, capabilities, ['writable'], 'workspace_rename');
      this.authorizePath(destination, capabilities, ['writable'], 'workspace_rename');
    });
    return this.delegate.rename(source, destination);
  }

  async delete(path: string, options?: { recursive?: boolean }) {
    this.authorizeOperation('delete', { path }, () => {
      this.authorizePath(path, ['delete'], ['writable'], 'workspace_delete');
    }, options);
    return this.delegate.delete(path, options);
  }

  private authorizeOperation(
    operation: WorkspaceOperation,
    target: PolicyWorkspaceAuditRequest['target'],
    authorize: () => void,
    options?: PolicyWorkspaceAuditRequest['options'],
  ): void {
    try {
      authorize();
    } catch (error) {
      const auditor = (this.delegate as Partial<PolicyWorkspaceAuditDelegate>)[
        POLICY_WORKSPACE_AUDITOR
      ];
      if (typeof auditor === 'function') {
        auditor.call(this.delegate, {
          operation,
          target,
          ...(options === undefined ? {} : { options }),
        });
      }
      throw error;
    }
  }

  private authorizePath(
    requestedPath: string,
    capabilities: WorkspaceCapability[],
    scopes: WorkspaceScope[],
    operation: string,
  ): void {
    if (!this.permissions.enabled || this.permissions.mode === 'off') {
      throw new Error(`${operation} is disabled.`);
    }
    const modeCanWrite = this.permissions.mode === 'read-write'
      || this.permissions.mode === 'full-access';
    if (capabilities.some((capability) => (
      !this.permissions[capability]
      || (capability !== 'read' && !modeCanWrite)
    ))) {
      throw new Error(`${operation} is not allowed by the workspace capability policy.`);
    }

    const target = resolveRequestedPath(this.root, requestedPath, this.flavor);
    if (this.permissions.fullAccess) return;
    for (const scope of scopes) {
      const allowedPaths = scope === 'readable' ? this.readablePaths : this.writablePaths;
      if (!allowedPaths.some((allowedPath) => pathIsWithin(allowedPath, target, this.flavor))) {
        throw new Error(`${operation} path is outside the allowed ${scope} paths.`);
      }
    }
  }
}
