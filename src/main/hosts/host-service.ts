import type { WebContents } from 'electron';
import {
  SSH_ERROR_CODES,
  type CreateHostFolderRequest,
  type HostFolder,
  type HostInput,
  type HostProfile,
  type MoveHostFolderRequest,
  type MoveHostRequest,
  type RenameHostFolderRequest,
  type SshConnectRequest,
  type SshConnectResult,
} from '../../shared/host';
import type { SessionManager } from '../sessions/session-manager';
import type { TerminalService } from '../terminal/terminal-service';
import { HostCredentialStore } from './host-credential-store';
import { HostStore } from './host-store';

type SshTerminalConnector = Pick<TerminalService, 'createSsh' | 'close'>;
type SessionConnector = Pick<SessionManager, 'reconnect'>;

interface ResolvedConnectionRequest {
  request: SshConnectRequest;
  suppliedCredential?: string;
  revision: number;
}

const CREDENTIAL_SAVE_WARNING = 'SSH 已连接，但无法将凭据保存到 Windows 凭据管理器。下次重连可能仍需输入。';

export class HostService {
  private readonly hostOperationTails = new Map<string, Promise<void>>();
  private credentialCleanupTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly hosts: HostStore,
    private readonly credentials: HostCredentialStore,
    private readonly terminals: SshTerminalConnector,
    private readonly sessions: SessionConnector,
  ) {}

  list(): HostProfile[] {
    return this.hosts.list();
  }

  listFolders(): HostFolder[] {
    return this.hosts.listFolders();
  }

  createFolder(request: CreateHostFolderRequest): HostFolder {
    return this.hosts.createFolder(request);
  }

  renameFolder(request: RenameHostFolderRequest): HostFolder {
    return this.hosts.renameFolder(request);
  }

  removeFolder(folderId: string): void {
    this.hosts.removeFolder(folderId);
  }

  moveFolder(request: MoveHostFolderRequest): HostFolder[] {
    return this.hosts.moveFolder(request);
  }

  moveHost(request: MoveHostRequest): HostProfile {
    return this.hosts.moveHost(request);
  }

  async save(input: HostInput): Promise<HostProfile> {
    if (input.id) return this.withHostLock(input.id, () => this.saveUnlocked(input));
    return this.saveUnlocked(input);
  }

  async remove(hostId: string): Promise<void> {
    await this.withHostLock(hostId, async () => {
      this.hosts.get(hostId);
      // The Host metadata is the authority that can activate a secret. Remove it
      // atomically first, then retire the stable UUID-scoped credential in the
      // background so a slow Credential Manager process cannot block the UI.
      this.hosts.remove(hostId);
      this.queueCredentialCleanup(hostId);
    });
  }

  /** Waits for already queued best-effort cleanup; intended for shutdown and tests. */
  async flushCredentialCleanup(): Promise<void> {
    await this.credentialCleanupTail;
  }

  async forgetCredential(hostId: string): Promise<void> {
    await this.withHostLock(hostId, async () => {
      this.hosts.get(hostId);
      await this.retireAndRemoveCredential(hostId);
    });
  }

  connect(owner: WebContents, request: SshConnectRequest): Promise<SshConnectResult> {
    return this.withHostLock(request.hostId, () => this.connectUnlocked(owner, request));
  }

  private async saveUnlocked(input: HostInput): Promise<HostProfile> {
    const identityChanged = this.hosts.connectionIdentityChanged(input);
    const result = this.hosts.saveWithCredentialRetirement(input);
    if (input.id && identityChanged) {
      try {
        await this.credentials.remove(input.id, result.retiredCredentialReference);
      } catch {
        // The persisted Host no longer references this credential, so cleanup can be retried safely.
      }
    }
    return result.host;
  }

  private async connectUnlocked(
    owner: WebContents,
    request: SshConnectRequest,
  ): Promise<SshConnectResult> {
    const host = this.hosts.get(request.hostId);
    let expectedRevision = this.hosts.revision(host.id);
    const resolved = await this.resolveConnectionRequest(host, request, expectedRevision);
    expectedRevision = resolved.revision;
    if (!this.hasRevision(host.id, expectedRevision)) {
      throw new Error('SSH 连接期间主机配置已更改，请重新连接。');
    }
    let result: Awaited<ReturnType<TerminalService['createSsh']>>;
    try {
      result = await this.terminals.createSsh(owner, host, resolved.request);
    } catch (error) {
      const message = (error as Error).message;
      const marker = `${SSH_ERROR_CODES.hostKeyRequired}:`;
      if (message.startsWith(marker)) {
        return {
          status: 'host-key-required',
          fingerprint: message.slice(marker.length),
        };
      }
      throw error;
    }

    let terminal = result.descriptor;
    try {
      if (this.hosts.revision(host.id) !== expectedRevision) {
        throw new Error('SSH 连接期间主机配置已更改，请重新连接。');
      }
      if (!host.hostKeyFingerprint) {
        this.hosts.trustFingerprint(host.id, result.fingerprint, expectedRevision);
        expectedRevision = this.hosts.revision(host.id);
      }
      if (request.sessionId) {
        const session = this.sessions.reconnect(owner, result.descriptor, request.sessionId);
        terminal = { ...result.descriptor, sessionId: session.id };
      }
    } catch (error) {
      this.closeCreatedTerminal(owner, result.descriptor.id);
      throw error;
    }

    let credentialWarning: string | undefined;
    if (request.saveCredential === true && resolved.suppliedCredential) {
      if (!await this.persistCredential(
        host.id,
        resolved.suppliedCredential,
        expectedRevision,
      )) {
        credentialWarning = CREDENTIAL_SAVE_WARNING;
      }
    }
    return {
      status: 'connected',
      terminal,
      ...(credentialWarning ? { credentialWarning } : {}),
    };
  }

  private async resolveConnectionRequest(
    host: HostProfile,
    request: SshConnectRequest,
    expectedRevision: number,
  ): Promise<ResolvedConnectionRequest> {
    const { saveCredential: _saveCredential, ...connectionRequest } = request;
    let credential: string | undefined;
    let suppliedCredential: string | undefined;
    let revision = expectedRevision;
    switch (host.authMethod) {
      case 'password':
      case 'keyboard-interactive':
        suppliedCredential = this.nonEmpty(request.password);
        if (suppliedCredential) {
          credential = suppliedCredential;
        } else {
          const stored = await this.storedCredential(host.id, revision);
          credential = stored.credential;
          revision = stored.revision;
        }
        if (!credential) {
          throw new Error('此主机没有可用的已保存密码，请输入密码。');
        }
        connectionRequest.password = credential;
        connectionRequest.passphrase = undefined;
        break;
      case 'private-key':
        suppliedCredential = this.nonEmpty(request.passphrase);
        if (suppliedCredential) {
          credential = suppliedCredential;
        } else {
          const stored = await this.storedCredential(host.id, revision);
          credential = stored.credential;
          revision = stored.revision;
        }
        connectionRequest.password = undefined;
        connectionRequest.passphrase = credential;
        break;
      case 'agent':
        connectionRequest.password = undefined;
        connectionRequest.passphrase = undefined;
        break;
    }
    return { request: connectionRequest, suppliedCredential, revision };
  }

  private nonEmpty(value: string | undefined): string | undefined {
    return value === undefined || value.length === 0 ? undefined : value;
  }

  private async storedCredential(
    hostId: string,
    expectedRevision: number,
  ): Promise<{ credential?: string; revision: number }> {
    const reference = this.hosts.credentialReference(hostId);
    const credential = await this.credentials.get(hostId, reference);
    if (!this.hasRevision(hostId, expectedRevision)) {
      throw new Error('SSH 连接期间主机配置已更改，请重新连接。');
    }
    if (reference && credential === undefined) {
      this.hosts.retireCredential(hostId, expectedRevision);
      return { revision: this.hosts.revision(hostId) };
    }
    return { credential, revision: expectedRevision };
  }

  private async persistCredential(
    hostId: string,
    credential: string,
    expectedRevision: number,
  ): Promise<boolean> {
    let alreadyConfigured: boolean;
    try {
      if (this.hosts.revision(hostId) !== expectedRevision) return false;
      alreadyConfigured = this.hosts.get(hostId).credentialConfigured;
    } catch {
      return false;
    }
    let reference: string;
    try {
      reference = await this.credentials.set(hostId, credential);
    } catch {
      if (alreadyConfigured && this.hasRevision(hostId, expectedRevision)) {
        try {
          this.hosts.retireCredential(hostId);
        } catch {
          // Secret cleanup below still prevents use when the metadata update cannot be saved.
        }
      }
      try {
        await this.credentials.remove(hostId);
      } catch {
        // A partially written OS credential remains inactive for a newly configured Host.
      }
      return false;
    }
    if (!this.hasRevision(hostId, expectedRevision)) {
      try {
        await this.credentials.remove(hostId, reference);
      } catch {
        // The stale Host metadata never activates this connection's credential.
      }
      return false;
    }
    if (alreadyConfigured) return true;
    try {
      this.hosts.configureCredential(hostId, reference, expectedRevision);
      return true;
    } catch {
      try {
        await this.credentials.remove(hostId, reference);
      } catch {
        // The reference remains inactive, so cleanup can be retried safely.
      }
      return false;
    }
  }

  private hasRevision(hostId: string, expectedRevision: number): boolean {
    try {
      return this.hosts.revision(hostId) === expectedRevision;
    } catch {
      return false;
    }
  }

  private closeCreatedTerminal(owner: WebContents, terminalId: string): void {
    try {
      this.terminals.close(owner, terminalId);
    } catch {
      // Preserve the post-connect persistence or Session error.
    }
  }

  private async retireAndRemoveCredential(hostId: string): Promise<void> {
    const activeReference = this.hosts.credentialReference(hostId);
    let retiredReference: string | undefined;
    try {
      retiredReference = this.hosts.retireCredential(hostId);
    } catch (error) {
      try {
        await this.credentials.remove(hostId, activeReference);
      } catch {
        // Preserve the metadata failure; neither partial failure is reported as success.
      }
      throw error;
    }
    await this.credentials.remove(hostId, retiredReference ?? activeReference);
  }

  private queueCredentialCleanup(hostId: string): void {
    this.credentialCleanupTail = this.credentialCleanupTail
      .then(() => this.credentials.remove(hostId))
      .catch(() => {
        // Host UUIDs are never reused and their metadata is already gone, so a
        // failed OS cleanup cannot reactivate or expose the orphaned credential.
      });
  }

  private async withHostLock<T>(hostId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.hostOperationTails.get(hostId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.hostOperationTails.set(hostId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.hostOperationTails.get(hostId) === tail) {
        this.hostOperationTails.delete(hostId);
      }
    }
  }
}
