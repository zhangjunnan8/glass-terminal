import { useEffect, useMemo, useState } from 'react';
import type {
  SftpDirectoryListing,
  SftpEntry,
  TransferJobSnapshot,
} from '../../shared/sftp';

interface SftpTerminal {
  id: string;
  title: string;
  transport: 'local' | 'ssh';
  status: 'connected' | 'exited';
}

interface SftpDrawerProps {
  terminal: SftpTerminal | null;
  onClose(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parentPath(path: string): string {
  if (path === '/') return '/';
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return `/${parts.join('/')}` || '/';
}

function humanBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

function mergeJobs(current: TransferJobSnapshot[], updates: TransferJobSnapshot[]) {
  const merged = new Map(current.map((job) => [job.id, job]));
  for (const job of updates) merged.set(job.id, job);
  return [...merged.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function SftpDrawer({ terminal, onClose }: SftpDrawerProps) {
  const [listing, setListing] = useState<SftpDirectoryListing | null>(null);
  const [transfers, setTransfers] = useState<TransferJobSnapshot[]>([]);
  const [pathInput, setPathInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = terminal?.transport === 'ssh' && terminal.status === 'connected';

  const visibleTransfers = useMemo(
    () => transfers.filter((job) => job.terminalId === terminal?.id),
    [terminal?.id, transfers],
  );

  async function loadDirectory(path?: string) {
    if (!terminal || !available) return;
    setLoading(true);
    setError(null);
    try {
      const next = await window.aiTerminal.sftp.listDirectory(terminal.id, path);
      setListing(next);
      setPathInput(next.path);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const removeListener = window.aiTerminal.sftp.onTransferUpdated((job) => {
      setTransfers((current) => mergeJobs(current, [job]));
    });
    return removeListener;
  }, []);

  useEffect(() => {
    setListing(null);
    setPathInput('');
    setError(null);
    if (!terminal || !available) return;
    void Promise.all([
      loadDirectory(),
      window.aiTerminal.sftp.listTransfers(terminal.id).then((jobs) => {
        setTransfers((current) => mergeJobs(current, jobs));
      }),
    ]).catch((caught) => setError(errorMessage(caught)));
  }, [terminal?.id, available]);

  async function upload() {
    if (!terminal || !listing) return;
    try {
      const jobs = await window.aiTerminal.sftp.chooseUpload({
        terminalId: terminal.id,
        remoteDirectory: listing.path,
      });
      setTransfers((current) => mergeJobs(current, jobs));
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function download(entry: SftpEntry) {
    if (!terminal) return;
    try {
      const job = await window.aiTerminal.sftp.chooseDownload({
        terminalId: terminal.id,
        remotePath: entry.path,
        suggestedName: entry.name,
      });
      if (job) setTransfers((current) => mergeJobs(current, [job]));
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <aside className="sftp-drawer" aria-label="SFTP files and transfers">
      <header>
        <span>
          <strong>SFTP</strong>
          <small>{terminal?.title ?? 'No terminal'}</small>
        </span>
        <button onClick={onClose} aria-label="Close SFTP panel">×</button>
      </header>

      {!available && (
        <div className="sftp-unavailable">Select a connected SSH terminal to browse files.</div>
      )}

      {available && (
        <>
          <form className="sftp-pathbar" onSubmit={(event) => {
            event.preventDefault();
            void loadDirectory(pathInput);
          }}>
            <button type="button" title="Parent directory" onClick={() => {
              if (listing) void loadDirectory(parentPath(listing.path));
            }}>↑</button>
            <input
              aria-label="Remote directory"
              value={pathInput}
              onChange={(event) => setPathInput(event.target.value)}
            />
            <button type="submit" title="Go">Go</button>
            <button type="button" title="Refresh" onClick={() => void loadDirectory(listing?.path)}>↻</button>
            <button type="button" className="sftp-upload" onClick={() => void upload()}>Upload</button>
          </form>
          {error && <div className="sftp-error">{error}</div>}
          <div className="sftp-file-list" data-sftp-ready={listing ? 'true' : 'false'}>
            {loading && <div className="sftp-loading">Loading…</div>}
            {!loading && listing?.entries.map((entry) => (
              <div className="sftp-entry" key={entry.path}>
                <button
                  className="sftp-entry-main"
                  onDoubleClick={() => {
                    if (entry.type === 'directory') void loadDirectory(entry.path);
                  }}
                  onClick={() => {
                    if (entry.type === 'directory') void loadDirectory(entry.path);
                  }}
                >
                  <span className="sftp-entry-icon">{entry.type === 'directory' ? '▣' : '▤'}</span>
                  <span>
                    <strong>{entry.name}</strong>
                    <small>{entry.type === 'directory' ? 'Directory' : humanBytes(entry.size)}</small>
                  </span>
                </button>
                {entry.type === 'file' && (
                  <button className="sftp-download" onClick={() => void download(entry)}>Download</button>
                )}
              </div>
            ))}
            {!loading && listing?.entries.length === 0 && (
              <div className="sftp-loading">This directory is empty.</div>
            )}
          </div>

          <section className="transfer-queue">
            <div className="transfer-heading">TRANSFERS <span>{visibleTransfers.length}</span></div>
            {visibleTransfers.map((job) => {
              const percentage = job.totalBytes > 0
                ? Math.min(100, (job.bytesTransferred / job.totalBytes) * 100)
                : 0;
              return (
                <div className="transfer-job" key={job.id}>
                  <div>
                    <strong>{job.direction === 'upload' ? '↑' : '↓'} {job.displayName}</strong>
                    <span className={`transfer-status ${job.status}`}>{job.status}</span>
                  </div>
                  <div className="transfer-track"><span style={{ width: `${percentage}%` }} /></div>
                  <small>
                    {humanBytes(job.bytesTransferred)} / {humanBytes(job.totalBytes)}
                    {job.error ? ` · ${job.error}` : ''}
                  </small>
                  {(job.status === 'queued' || job.status === 'running') && (
                    <button onClick={() => void window.aiTerminal.sftp.cancelTransfer(job.id)}>Cancel</button>
                  )}
                  {(job.status === 'failed' || job.status === 'cancelled') && (
                    <button onClick={() => void window.aiTerminal.sftp.retryTransfer(job.id)}>Retry</button>
                  )}
                </div>
              );
            })}
            {visibleTransfers.length === 0 && <div className="transfer-empty">No transfers yet.</div>}
          </section>
        </>
      )}
    </aside>
  );
}
