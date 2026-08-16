import { useEffect, useState } from 'react';
import type { SessionHistoryDetail, SessionRecord } from '../../shared/session';

interface SessionHistoryDialogProps {
  session: SessionRecord;
  onClose(): void;
  onDeleted(sessionId: string): void;
  onError(message: string): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dateTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN');
}

function roleLabel(role: 'user' | 'assistant' | 'system'): string {
  if (role === 'user') return '用户';
  if (role === 'assistant') return 'AI 助手';
  return '系统';
}

export function SessionHistoryDialog({
  session,
  onClose,
  onDeleted,
  onError,
}: SessionHistoryDialogProps) {
  const [detail, setDetail] = useState<SessionHistoryDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setLoadError(null);
    void window.aiTerminal.sessions.readHistoryDetail({ sessionId: session.id })
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(errorMessage(error));
      });
    return () => { cancelled = true; };
  }, [session.id]);

  const current = detail?.session ?? session;
  const active = current.connectionState === 'connected' || current.status === 'active';

  async function removeSession() {
    if (deleting || active) return;
    const confirmed = window.confirm(
      `确定永久删除会话“${current.name}”吗？\n\n`
      + '该会话的终端日志、AI 对话、审计记录和元数据都会被删除，此操作无法撤销。',
    );
    if (!confirmed) return;
    setDeleting(true);
    setLoadError(null);
    try {
      await window.aiTerminal.sessions.remove({
        sessionId: current.id,
        expectedUpdatedAt: current.updatedAt,
        expectedRuntimeTerminalId: current.runtimeTerminalId,
      });
      onDeleted(current.id);
    } catch (error) {
      const message = errorMessage(error);
      setLoadError(message);
      onError(message);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="modal-backdrop" data-testid="session-history-backdrop">
      <section
        className="modal session-history-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-history-title"
        aria-busy={!detail && !loadError}
        data-testid="session-history-dialog"
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || deleting) return;
          event.preventDefault();
          onClose();
        }}
      >
        <div className="modal-header">
          <span>
            <strong id="session-history-title">{current.name}</strong>
            <small>会话历史内容</small>
          </span>
          <button type="button" aria-label="关闭会话历史" disabled={deleting} onClick={onClose}>×</button>
        </div>

        <dl className="session-history-metadata">
          <div><dt>目标</dt><dd>{current.targetSnapshot.label}</dd></div>
          <div><dt>类型</dt><dd>{current.transport === 'ssh' ? 'SSH' : '本地 Shell'}</dd></div>
          <div><dt>状态</dt><dd>{active ? '活动中' : current.status === 'interrupted' ? '已中断' : '已断开'}</dd></div>
          <div><dt>用户</dt><dd>{current.effectiveUser ?? current.targetSnapshot.username ?? '未记录'}</dd></div>
          <div><dt>目录</dt><dd title={current.cwd}>{current.cwd ?? '未记录'}</dd></div>
          <div><dt>最后更新</dt><dd>{dateTime(current.updatedAt)}</dd></div>
        </dl>

        {loadError && <div className="form-error" role="alert">{loadError}</div>}
        {!detail && !loadError && <div className="session-history-loading" role="status">正在读取会话内容…</div>}

        {detail && (
          <div className="session-history-content">
            <section>
              <div className="session-history-section-heading">
                <strong>AI 对话</strong>
                <small>{detail.conversation.messages.length} 条近期消息</small>
              </div>
              {detail.conversation.truncated && (
                <div className="history-truncation-note">对话较长，这里只显示最近的有界预览。</div>
              )}
              <div className="session-conversation-preview" data-testid="session-conversation-preview">
                {detail.conversation.messages.map((message) => (
                  <article className={`session-history-message ${message.role}`} key={message.id}>
                    <header>
                      <strong>{roleLabel(message.role)}</strong>
                      <time dateTime={message.createdAt}>{dateTime(message.createdAt)}</time>
                    </header>
                    <pre>{message.content}</pre>
                  </article>
                ))}
                {detail.conversation.messages.length === 0 && (
                  <div className="session-history-empty">该会话没有已保存的 AI 对话。</div>
                )}
              </div>
            </section>

            <section>
              <div className="session-history-section-heading">
                <strong>终端输出</strong>
                <small>近期内容预览</small>
              </div>
              {detail.terminal.truncated && (
                <div className="history-truncation-note">终端日志较长，这里仅显示最近的 120,000 个字符；删除时仍会删除完整日志。</div>
              )}
              <pre className="session-terminal-preview" data-testid="session-terminal-preview">
                {detail.terminal.content || '该会话没有已保存的终端输出。'}
              </pre>
            </section>
          </div>
        )}

        <div className="modal-actions session-history-footer">
          <small>{active ? '活动会话需先关闭终端，才能删除。' : '删除会同时清除完整终端、AI 和审计记录。'}</small>
          <button type="button" disabled={deleting} onClick={onClose}>关闭</button>
          <button
            type="button"
            className="danger-action"
            data-action="delete-session"
            disabled={active || deleting || !detail}
            title={active ? '活动会话不能删除' : '永久删除会话内容'}
            onClick={() => void removeSession()}
          >{deleting ? '正在删除…' : '删除会话'}</button>
        </div>
      </section>
    </div>
  );
}
