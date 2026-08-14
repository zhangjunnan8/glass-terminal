import { randomUUID } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join, posix } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { WebContents } from 'electron';
import type { SFTPWrapper, Stats } from 'ssh2';
import { SFTP_CHANNELS } from '../../shared/sftp';
import type { TransferJobSnapshot } from '../../shared/sftp';
import type { TerminalService } from '../terminal/terminal-service';
import { remotePath } from './sftp-service';

interface TransferJob extends TransferJobSnapshot {
  owner: WebContents;
  ownerId: number;
  controller?: AbortController;
}

type ProgressCallback = (transferred: number, total?: number) => void;
export type TransferExecutor = (
  job: TransferJobSnapshot,
  owner: WebContents,
  signal: AbortSignal,
  progress: ProgressCallback,
) => Promise<void>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sftpStat(sftp: SFTPWrapper, path: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (error, attributes) => {
      if (error) reject(error);
      else resolve(attributes);
    });
  });
}

async function sftpPathExists(sftp: SFTPWrapper, path: string): Promise<boolean> {
  try {
    await sftpStat(sftp, path);
    return true;
  } catch (error) {
    if ((error as { code?: number }).code === 2) return false;
    throw error;
  }
}

function sftpRename(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function sftpUnlink(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(path, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function publicSnapshot(job: TransferJob): TransferJobSnapshot {
  const { owner: _owner, ownerId: _ownerId, controller: _controller, ...snapshot } = job;
  return snapshot;
}

export class TransferQueue {
  private readonly jobs = new Map<string, TransferJob>();
  private readonly runningTerminals = new Set<string>();
  private readonly removeExitListener: () => void;
  private readonly executeTransfer: TransferExecutor;

  constructor(
    private readonly terminals: TerminalService,
    executor?: TransferExecutor,
  ) {
    this.executeTransfer = executor ?? ((job, owner, signal, progress) => (
      this.execute(job, owner, signal, progress)
    ));
    this.removeExitListener = terminals.onExit((terminalId, ownerId) => {
      this.cancelByTerminal(terminalId, ownerId);
    });
  }

  enqueueUpload(
    owner: WebContents,
    terminalId: string,
    localPath: string,
    remoteDirectory: string,
  ): TransferJobSnapshot {
    const stats = statSync(localPath);
    if (!stats.isFile()) throw new Error('Only file uploads are supported in this milestone.');
    const destination = posix.join(remotePath(remoteDirectory), basename(localPath));
    return this.enqueue(owner, {
      terminalId,
      direction: 'upload',
      source: localPath,
      destination,
      displayName: basename(localPath),
      totalBytes: stats.size,
    });
  }

  enqueueDownload(
    owner: WebContents,
    terminalId: string,
    remoteSource: string,
    localDestination: string,
  ): TransferJobSnapshot {
    const source = remotePath(remoteSource);
    return this.enqueue(owner, {
      terminalId,
      direction: 'download',
      source,
      destination: localDestination,
      displayName: posix.basename(source),
      totalBytes: 0,
    });
  }

  list(owner: WebContents, terminalId?: string): TransferJobSnapshot[] {
    return [...this.jobs.values()]
      .filter((job) => job.ownerId === owner.id)
      .filter((job) => terminalId === undefined || job.terminalId === terminalId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(publicSnapshot);
  }

  cancel(owner: WebContents, jobId: string): TransferJobSnapshot {
    const job = this.requireOwned(owner, jobId);
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      return publicSnapshot(job);
    }
    job.revision += 1;
    job.status = 'cancelled';
    job.updatedAt = new Date().toISOString();
    job.error = undefined;
    job.controller?.abort();
    this.emit(job);
    queueMicrotask(() => this.pump(job.terminalId));
    return publicSnapshot(job);
  }

  retry(owner: WebContents, jobId: string): TransferJobSnapshot {
    const job = this.requireOwned(owner, jobId);
    if (job.status !== 'failed' && job.status !== 'cancelled') {
      throw new Error('Only failed or cancelled transfers can be retried.');
    }
    job.revision += 1;
    job.attempt += 1;
    job.status = 'queued';
    job.bytesTransferred = 0;
    job.error = undefined;
    job.updatedAt = new Date().toISOString();
    this.emit(job);
    queueMicrotask(() => this.pump(job.terminalId));
    return publicSnapshot(job);
  }

  cancelByTerminal(terminalId: string, ownerId?: number): void {
    for (const job of this.jobs.values()) {
      if (job.terminalId !== terminalId) continue;
      if (ownerId !== undefined && job.ownerId !== ownerId) continue;
      if (job.status !== 'queued' && job.status !== 'running') continue;
      job.revision += 1;
      job.status = 'cancelled';
      job.updatedAt = new Date().toISOString();
      job.controller?.abort();
      this.emit(job);
    }
  }

  close(): void {
    this.removeExitListener();
    for (const job of this.jobs.values()) {
      if (job.status === 'queued' || job.status === 'running') {
        job.status = 'cancelled';
        job.controller?.abort();
      }
    }
  }

  private enqueue(
    owner: WebContents,
    input: Pick<
      TransferJobSnapshot,
      'terminalId' | 'direction' | 'source' | 'destination' | 'displayName' | 'totalBytes'
    >,
  ): TransferJobSnapshot {
    const now = new Date().toISOString();
    const job: TransferJob = {
      ...input,
      id: randomUUID(),
      owner,
      ownerId: owner.id,
      status: 'queued',
      bytesTransferred: 0,
      attempt: 1,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    this.emit(job);
    queueMicrotask(() => this.pump(job.terminalId));
    return publicSnapshot(job);
  }

  private async pump(terminalId: string): Promise<void> {
    if (this.runningTerminals.has(terminalId)) return;
    const job = [...this.jobs.values()].find((candidate) => (
      candidate.terminalId === terminalId && candidate.status === 'queued'
    ));
    if (!job) return;

    this.runningTerminals.add(terminalId);
    const revision = job.revision;
    job.status = 'running';
    job.updatedAt = new Date().toISOString();
    job.controller = new AbortController();
    this.emit(job);
    let lastProgressEmission = 0;

    try {
      await this.executeTransfer(
        publicSnapshot(job),
        job.owner,
        job.controller.signal,
        (transferred, total) => {
          if (job.revision !== revision || job.status !== 'running') return;
          job.bytesTransferred = transferred;
          if (total !== undefined) job.totalBytes = total;
          job.updatedAt = new Date().toISOString();
          const now = Date.now();
          if (now - lastProgressEmission >= 100 || transferred === job.totalBytes) {
            lastProgressEmission = now;
            this.emit(job);
          }
        },
      );
      if (job.revision === revision && job.status === 'running') {
        job.status = 'completed';
        job.bytesTransferred = job.totalBytes;
        job.updatedAt = new Date().toISOString();
        this.emit(job);
      }
    } catch (error) {
      if (job.revision === revision && job.status === 'running') {
        job.status = job.controller.signal.aborted ? 'cancelled' : 'failed';
        job.error = job.status === 'failed' ? errorMessage(error) : undefined;
        job.updatedAt = new Date().toISOString();
        this.emit(job);
      }
    } finally {
      job.controller = undefined;
      this.runningTerminals.delete(terminalId);
      queueMicrotask(() => this.pump(terminalId));
    }
  }

  private async execute(
    job: TransferJobSnapshot,
    owner: WebContents,
    signal: AbortSignal,
    progress: ProgressCallback,
  ): Promise<void> {
    const sftp = await this.terminals.openSftp(owner, job.terminalId);
    try {
      if (job.direction === 'upload') {
        await this.upload(sftp, job, signal, progress);
      } else {
        await this.download(sftp, job, signal, progress);
      }
    } finally {
      sftp.end();
    }
  }

  private async upload(
    sftp: SFTPWrapper,
    job: TransferJobSnapshot,
    signal: AbortSignal,
    progress: ProgressCallback,
  ): Promise<void> {
    if (await sftpPathExists(sftp, job.destination)) {
      throw new Error('Remote destination already exists. Rename it or choose another directory.');
    }
    const partial = posix.join(
      posix.dirname(job.destination),
      `.ai-terminal-${job.id}-${job.attempt}.part`,
    );
    let transferred = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        transferred += chunk.length;
        progress(transferred, job.totalBytes);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        createReadStream(job.source),
        meter,
        sftp.createWriteStream(partial, { flags: 'w', mode: 0o600 }),
        { signal },
      );
      await sftpRename(sftp, partial, job.destination);
    } catch (error) {
      await sftpUnlink(sftp, partial).catch(() => undefined);
      throw error;
    }
  }

  private async download(
    sftp: SFTPWrapper,
    job: TransferJobSnapshot,
    signal: AbortSignal,
    progress: ProgressCallback,
  ): Promise<void> {
    const attributes = await sftpStat(sftp, job.source);
    if (!attributes.isFile()) throw new Error('Only file downloads are supported.');
    const partial = join(
      dirname(job.destination),
      `.${basename(job.destination)}.ai-terminal-${job.id}-${job.attempt}.part`,
    );
    let transferred = 0;
    progress(0, attributes.size);
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        transferred += chunk.length;
        progress(transferred, attributes.size);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        sftp.createReadStream(job.source),
        meter,
        createWriteStream(partial, { flags: 'wx', mode: 0o600 }),
        { signal },
      );
      if (existsSync(job.destination)) unlinkSync(job.destination);
      renameSync(partial, job.destination);
    } catch (error) {
      if (existsSync(partial)) unlinkSync(partial);
      throw error;
    }
  }

  private requireOwned(owner: WebContents, jobId: string): TransferJob {
    const job = this.jobs.get(jobId);
    if (!job || job.ownerId !== owner.id) throw new Error(`Transfer not found: ${jobId}`);
    return job;
  }

  private emit(job: TransferJob): void {
    if (!job.owner.isDestroyed()) {
      job.owner.send(SFTP_CHANNELS.transferUpdated, publicSnapshot(job));
    }
  }
}
