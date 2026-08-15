import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { WebContents } from 'electron';
import type { SFTPWrapper } from 'ssh2';
import { describe, expect, it } from 'vitest';
import type { HostProfile } from '../../shared/host';
import { SSH_ERROR_CODES } from '../../shared/host';
import type { TransferJobSnapshot } from '../../shared/sftp';
import { TerminalService } from '../terminal/terminal-service';
import { SftpService } from './sftp-service';
import { TransferQueue } from './transfer-queue';

const enabled = Boolean(
  process.env.AI_TERMINAL_SSH_TEST_HOST
  && process.env.AI_TERMINAL_SSH_TEST_USER
  && process.env.AI_TERMINAL_SSH_TEST_PASSWORD,
);

function sftpCommand(
  sftp: SFTPWrapper,
  command: 'mkdir' | 'unlink' | 'rmdir',
  path: string,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    sftp[command](path, (error) => {
      if (error) reject(error);
      else resolvePromise();
    });
  });
}

async function waitForTransfer(
  queue: TransferQueue,
  owner: WebContents,
  jobId: string,
): Promise<TransferJobSnapshot> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const job = queue.list(owner).find((candidate) => candidate.id === jobId);
    if (job && ['completed', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error('Timed out waiting for SFTP transfer.');
}

describe.runIf(enabled)('real SFTP over the visible SSH connection', () => {
  it('browses, uploads, and downloads without a second SSH login', async () => {
    const service = new TerminalService();
    const sftpService = new SftpService(service);
    const queue = new TransferQueue(service);
    const owner = {
      id: 7_002,
      isDestroyed: () => false,
      send: () => undefined,
    } as unknown as WebContents;
    const host: HostProfile = {
      id: 'sftp-integration-host',
      protocol: 'ssh',
      name: 'Ubuntu SFTP integration target',
      hostname: process.env.AI_TERMINAL_SSH_TEST_HOST!,
      port: Number(process.env.AI_TERMINAL_SSH_TEST_PORT ?? 22),
      username: process.env.AI_TERMINAL_SSH_TEST_USER!,
      authMethod: 'password',
      sortOrder: 0,
      favorite: false,
      credentialConfigured: false,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const password = process.env.AI_TERMINAL_SSH_TEST_PASSWORD;
    const unique = randomUUID();
    const remoteDirectory = `/home/${host.username}/.ai-terminal-sftp-smoke-${unique}`;
    const localRoot = resolve(process.cwd(), '.smoke-data', 'sftp-integration', unique);
    const uploadPath = join(localRoot, 'roundtrip.txt');
    const downloadPath = join(localRoot, 'downloaded.txt');
    mkdirSync(localRoot, { recursive: true });
    writeFileSync(uploadPath, `AI Terminal SFTP roundtrip ${unique}\n`, 'utf8');

    let terminalId: string | undefined;
    let remoteCreated = false;
    try {
      let challenge = '';
      try {
        await service.createSsh(owner, host, { hostId: host.id, password });
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain(SSH_ERROR_CODES.hostKeyRequired);
        challenge = message.slice(message.indexOf('SHA256:')).trim();
      }
      const { descriptor } = await service.createSsh(owner, host, {
        hostId: host.id,
        password,
        trustHostKey: challenge,
      });
      terminalId = descriptor.id;
      service.attach(owner, terminalId);

      const home = await sftpService.listDirectory(owner, terminalId);
      expect(home.path).toBe(`/home/${host.username}`);

      const setup = await service.openSftp(owner, terminalId);
      try {
        await sftpCommand(setup, 'mkdir', remoteDirectory);
        remoteCreated = true;
      } finally {
        setup.end();
      }

      const upload = queue.enqueueUpload(owner, terminalId, uploadPath, remoteDirectory);
      expect((await waitForTransfer(queue, owner, upload.id)).status).toBe('completed');
      const remoteListing = await sftpService.listDirectory(owner, terminalId, remoteDirectory);
      expect(remoteListing.entries.map((entry) => entry.name)).toContain('roundtrip.txt');

      const download = queue.enqueueDownload(
        owner,
        terminalId,
        `${remoteDirectory}/roundtrip.txt`,
        downloadPath,
      );
      expect((await waitForTransfer(queue, owner, download.id)).status).toBe('completed');
      expect(readFileSync(downloadPath, 'utf8')).toBe(readFileSync(uploadPath, 'utf8'));

      const cleanup = await service.openSftp(owner, terminalId);
      try {
        await sftpCommand(cleanup, 'unlink', `${remoteDirectory}/roundtrip.txt`);
        await sftpCommand(cleanup, 'rmdir', remoteDirectory);
        remoteCreated = false;
      } finally {
        cleanup.end();
      }
      const homeAfterCleanup = await sftpService.listDirectory(owner, terminalId);
      expect(homeAfterCleanup.entries.map((entry) => entry.path)).not.toContain(remoteDirectory);
    } finally {
      if (terminalId && remoteCreated) {
        try {
          const cleanup = await service.openSftp(owner, terminalId);
          try {
            await sftpCommand(cleanup, 'unlink', `${remoteDirectory}/roundtrip.txt`)
              .catch(() => undefined);
            await sftpCommand(cleanup, 'rmdir', remoteDirectory).catch(() => undefined);
          } finally {
            cleanup.end();
          }
        } catch {
          // The generated smoke path is reported if connection loss prevents cleanup.
        }
      }
      queue.close();
      if (terminalId) service.close(owner, terminalId);
      if (localRoot.startsWith(resolve(process.cwd(), '.smoke-data', 'sftp-integration'))) {
        rmSync(localRoot, { recursive: true, force: true });
      }
    }
  }, 45_000);
});
