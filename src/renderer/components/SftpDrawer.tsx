import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  SftpDirectoryListing,
  SftpEntry,
  TransferJobSnapshot,
} from '../../shared/sftp';
import { transferStatusLabel } from '../ui-text';

interface SftpTerminal {
  id: string;
  title: string;
  transport: 'local' | 'ssh';
  status: 'connected' | 'exited';
}

interface SftpDrawerProps {
  terminal: SftpTerminal | null;
  workspaceRoot?: string;
  onSetWorkspace?(terminalId: string, path: string): Promise<void> | void;
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

function sameRemotePath(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const normalized = (path: string) => path.replace(/\/+$/u, '') || '/';
  return normalized(left) === normalized(right);
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

export function SftpDrawer({
  terminal,
  workspaceRoot,
  onSetWorkspace,
  onClose,
}: SftpDrawerProps) {
  const [listing, setListing] = useState<SftpDirectoryListing | null>(null);
  const [transfers, setTransfers] = useState<TransferJobSnapshot[]>([]);
  const [pathInput, setPathInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workspacePending, setWorkspacePending] = useState(false);
  const [transfersCollapsed, setTransfersCollapsed] = useState(false);
  const available = terminal?.transport === 'ssh' && terminal.status === 'connected';
  const activeTerminalIdRef = useRef<string | null>(available ? terminal.id : null);
  const directoryRequestRef = useRef(0);
  const transferListRequestRef = useRef(0);
  const workspaceRequestRef = useRef(0);
  activeTerminalIdRef.current = available ? terminal.id : null;

  const visibleTransfers = useMemo(
    () => transfers.filter((job) => job.terminalId === terminal?.id),
    [terminal?.id, transfers],
  );

  async function loadDirectory(path?: string) {
    if (!terminal || !available) return;
    const terminalId = terminal.id;
    const requestId = ++directoryRequestRef.current;
    const isCurrentRequest = () => (
      activeTerminalIdRef.current === terminalId
      && directoryRequestRef.current === requestId
    );
    setLoading(true);
    setError(null);
    try {
      const next = await window.aiTerminal.sftp.listDirectory(terminalId, path);
      if (!isCurrentRequest()) return;
      if (next.terminalId !== terminalId) {
        throw new Error('远程目录响应与当前终端不匹配。');
      }
      setListing(next);
      setPathInput(next.path);
    } catch (caught) {
      if (isCurrentRequest()) setError(errorMessage(caught));
    } finally {
      if (isCurrentRequest()) setLoading(false);
    }
  }

  useEffect(() => {
    const removeListener = window.aiTerminal.sftp.onTransferUpdated((job) => {
      setTransfers((current) => mergeJobs(current, [job]));
    });
    return removeListener;
  }, []);

  useEffect(() => {
    directoryRequestRef.current += 1;
    transferListRequestRef.current += 1;
    workspaceRequestRef.current += 1;
    setListing(null);
    setPathInput('');
    setError(null);
    setLoading(false);
    setWorkspacePending(false);
    if (!terminal || !available) return;
    const terminalId = terminal.id;
    const transferRequestId = transferListRequestRef.current;
    void loadDirectory();
    void window.aiTerminal.sftp.listTransfers(terminalId).then((jobs) => {
      if (
        activeTerminalIdRef.current === terminalId
        && transferListRequestRef.current === transferRequestId
      ) {
        setTransfers((current) => mergeJobs(current, jobs));
      }
    }).catch((caught) => {
      if (
        activeTerminalIdRef.current === terminalId
        && transferListRequestRef.current === transferRequestId
      ) {
        setError(errorMessage(caught));
      }
    });
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

  async function setCurrentWorkspace() {
    if (
      !terminal
      || !listing
      || listing.terminalId !== terminal.id
      || !onSetWorkspace
      || sameRemotePath(listing.path, workspaceRoot)
    ) return;
    const terminalId = terminal.id;
    const path = listing.path;
    const requestId = ++workspaceRequestRef.current;
    const isCurrentRequest = () => (
      activeTerminalIdRef.current === terminalId
      && workspaceRequestRef.current === requestId
    );
    setWorkspacePending(true);
    setError(null);
    try {
      await onSetWorkspace(terminalId, path);
    } catch (caught) {
      if (isCurrentRequest()) setError(errorMessage(caught));
    } finally {
      if (isCurrentRequest()) setWorkspacePending(false);
    }
  }

  return (
    <aside className="sftp-drawer" aria-label="SFTP 文件与传输">
      <header>
        <span>
          <strong>SFTP</strong>
          <small>{terminal?.title ?? '未选择终端'}</small>
        </span>
        <button onClick={onClose} aria-label="关闭 SFTP 面板">×</button>
      </header>

      {!available && (
        <div className="sftp-unavailable">请选择一个已连接的 SSH 终端以浏览文件。</div>
      )}

      {available && (
        <>
          <form className="sftp-pathbar" onSubmit={(event) => {
            event.preventDefault();
            void loadDirectory(pathInput);
          }}>
            <button type="button" title="上级目录" onClick={() => {
              if (listing) void loadDirectory(parentPath(listing.path));
            }}>↑</button>
            <input
              aria-label="远程目录"
              value={pathInput}
              onChange={(event) => setPathInput(event.target.value)}
            />
            <button type="submit" title="前往">前往</button>
            <button type="button" title="刷新" onClick={() => void loadDirectory(listing?.path)}>↻</button>
            <button
              type="button"
              className={`sftp-workspace ${sameRemotePath(listing?.path, workspaceRoot) ? 'active' : ''}`}
              aria-label={sameRemotePath(listing?.path, workspaceRoot)
                ? `当前工作区 ${listing?.path ?? ''}`
                : `将当前目录 ${listing?.path ?? ''} 设为工作区`}
              disabled={
                !listing
                || !onSetWorkspace
                || workspacePending
                || sameRemotePath(listing.path, workspaceRoot)
              }
              title={sameRemotePath(listing?.path, workspaceRoot)
                ? '当前目录已是工作区'
                : onSetWorkspace ? '将当前目录设为工作区' : '当前不能修改工作区'}
              onClick={() => void setCurrentWorkspace()}
            >{sameRemotePath(listing?.path, workspaceRoot)
                ? '当前工作区'
                : workspacePending ? '设置中…' : '设为工作区'}</button>
            <button type="button" className="sftp-upload" onClick={() => void upload()}>上传</button>
          </form>
          {error && <div className="sftp-error">{error}</div>}
          <div className="sftp-file-list" data-sftp-ready={listing ? 'true' : 'false'}>
            {loading && <div className="sftp-loading">正在加载…</div>}
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
                    <small>{entry.type === 'directory' ? '目录' : humanBytes(entry.size)}</small>
                  </span>
                </button>
                {entry.type === 'file' && (
                  <button className="sftp-download" onClick={() => void download(entry)}>下载</button>
                )}
              </div>
            ))}
            {!loading && listing?.entries.length === 0 && (
              <div className="sftp-loading">此目录为空。</div>
            )}
          </div>

          <section
            className={`transfer-queue ${transfersCollapsed ? 'collapsed' : ''}`}
            data-collapsed={transfersCollapsed ? 'true' : 'false'}
          >
            <div className="transfer-heading">
              <span>传输任务 <b>{visibleTransfers.length}</b></span>
              <button
                type="button"
                data-action="toggle-transfer-queue"
                aria-expanded={!transfersCollapsed}
                onClick={() => setTransfersCollapsed((collapsed) => !collapsed)}
              >{transfersCollapsed ? '展开' : '收起'} <span aria-hidden="true">{transfersCollapsed ? '⌃' : '⌄'}</span></button>
            </div>
            {!transfersCollapsed && (
              <div className="transfer-jobs">
                {visibleTransfers.map((job) => {
                  const percentage = job.totalBytes > 0
                    ? Math.min(100, (job.bytesTransferred / job.totalBytes) * 100)
                    : 0;
                  return (
                    <div className="transfer-job" key={job.id}>
                      <div>
                        <strong>{job.direction === 'upload' ? '↑' : '↓'} {job.displayName}</strong>
                        <span className={`transfer-status ${job.status}`}>{transferStatusLabel(job.status)}</span>
                      </div>
                      <div className="transfer-track"><span style={{ width: `${percentage}%` }} /></div>
                      <small>
                        {humanBytes(job.bytesTransferred)} / {humanBytes(job.totalBytes)}
                        {job.error ? ` · ${job.error}` : ''}
                      </small>
                      {(job.status === 'queued' || job.status === 'running') && (
                        <button onClick={() => void window.aiTerminal.sftp.cancelTransfer(job.id)}>取消</button>
                      )}
                      {(job.status === 'failed' || job.status === 'cancelled') && (
                        <button onClick={() => void window.aiTerminal.sftp.retryTransfer(job.id)}>重试</button>
                      )}
                    </div>
                  );
                })}
                {visibleTransfers.length === 0 && <div className="transfer-empty">暂无传输任务。</div>}
              </div>
            )}
          </section>
        </>
      )}
    </aside>
  );
}
