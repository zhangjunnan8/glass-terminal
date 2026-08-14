import type { WebContents } from 'electron';
import { afterEach, describe, expect, it } from 'vitest';
import type { TerminalService } from '../terminal/terminal-service';
import type { TransferExecutor } from './transfer-queue';
import { TransferQueue } from './transfer-queue';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for transfer state.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class FakeTerminalService {
  private exitListener?: (terminalId: string, ownerId: number) => void;

  onExit(listener: (terminalId: string, ownerId: number) => void) {
    this.exitListener = listener;
    return () => { this.exitListener = undefined; };
  }

  exit(terminalId: string, ownerId: number) {
    this.exitListener?.(terminalId, ownerId);
  }
}

function owner(id: number): WebContents {
  return {
    id,
    isDestroyed: () => false,
    send: () => undefined,
  } as unknown as WebContents;
}

const queues: TransferQueue[] = [];

afterEach(() => {
  for (const queue of queues.splice(0)) queue.close();
});

describe('TransferQueue', () => {
  it('runs transfers sequentially for one SSH terminal and reports progress', async () => {
    const terminal = new FakeTerminalService();
    const gates = [deferred(), deferred()];
    const started: string[] = [];
    const executor: TransferExecutor = async (job, _owner, _signal, progress) => {
      const index = started.length;
      started.push(job.id);
      progress(5, 10);
      await gates[index].promise;
      progress(10, 10);
    };
    const queue = new TransferQueue(terminal as unknown as TerminalService, executor);
    queues.push(queue);
    const browser = owner(1);
    const first = queue.enqueueDownload(browser, 'terminal-1', '/remote/a', 'C:\\tmp\\a');
    const second = queue.enqueueDownload(browser, 'terminal-1', '/remote/b', 'C:\\tmp\\b');

    await waitFor(() => queue.list(browser)[0]?.status === 'running');
    expect(started).toEqual([first.id]);
    expect(queue.list(browser)[1].status).toBe('queued');
    gates[0].resolve();
    await waitFor(() => queue.list(browser)[1]?.status === 'running');
    expect(started).toEqual([first.id, second.id]);
    gates[1].resolve();
    await waitFor(() => queue.list(browser).every((job) => job.status === 'completed'));
    expect(queue.list(browser).map((job) => job.bytesTransferred)).toEqual([10, 10]);
  });

  it('cancels running work when its visible SSH terminal exits', async () => {
    const terminal = new FakeTerminalService();
    const executor: TransferExecutor = (_job, _owner, signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    const queue = new TransferQueue(terminal as unknown as TerminalService, executor);
    queues.push(queue);
    const browser = owner(2);
    queue.enqueueDownload(browser, 'terminal-2', '/remote/file', 'C:\\tmp\\file');

    await waitFor(() => queue.list(browser)[0]?.status === 'running');
    terminal.exit('terminal-2', browser.id);
    await waitFor(() => queue.list(browser)[0]?.status === 'cancelled');
    expect(queue.list(browser)[0].error).toBeUndefined();
  });

  it('retries a failed job as a new attempt without exposing another owner', async () => {
    const terminal = new FakeTerminalService();
    let attempt = 0;
    const executor: TransferExecutor = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('simulated disconnect');
    };
    const queue = new TransferQueue(terminal as unknown as TerminalService, executor);
    queues.push(queue);
    const firstOwner = owner(3);
    const otherOwner = owner(4);
    const job = queue.enqueueDownload(firstOwner, 'terminal-3', '/remote/file', 'C:\\tmp\\file');

    await waitFor(() => queue.list(firstOwner)[0]?.status === 'failed');
    expect(() => queue.cancel(otherOwner, job.id)).toThrow('Transfer not found');
    queue.retry(firstOwner, job.id);
    await waitFor(() => queue.list(firstOwner)[0]?.status === 'completed');
    expect(queue.list(firstOwner)[0].attempt).toBe(2);
  });
});
