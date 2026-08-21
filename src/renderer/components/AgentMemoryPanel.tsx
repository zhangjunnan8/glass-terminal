import { useEffect, useState } from 'react';
import type { AgentChatItem } from '../../shared/agent';
import {
  AGENT_MEMORY_CATEGORIES,
  MAX_AGENT_MEMORY_CONTENT_CHARS,
  containsObviousAgentSecret,
  type AgentMemoryCard,
  type AgentMemoryCategory,
} from '../../shared/agent-memory';

export interface AgentMemoryDraftSource {
  id: string;
  content: string;
}

interface AgentMemoryPanelProps {
  memories: readonly AgentMemoryCard[];
  messages: readonly AgentChatItem[];
  disabled?: boolean;
  draftSource?: AgentMemoryDraftSource | null;
  onDraftConsumed?(): void;
  onSave(input: {
    memoryId?: string;
    category: AgentMemoryCategory;
    content: string;
    sourceMessageIds: string[];
    mergeMemoryIds: string[];
  }): Promise<void>;
  onRemove(memoryId: string): Promise<void>;
  onLocate(sourceMessageId: string): void;
}

interface EditorState {
  memoryId?: string;
  category: AgentMemoryCategory;
  content: string;
  sourceMessageIds: string[];
  mergeMemoryIds: string[];
  sourceWasTrimmed?: boolean;
}

const CATEGORY_LABELS: Record<AgentMemoryCategory, string> = {
  constraint: '约束',
  decision: '决策',
  artifact: '产物',
  failure: '失败路线',
  pending: '待办',
};

function editorForCard(card: AgentMemoryCard): EditorState {
  return {
    memoryId: card.id,
    category: card.category,
    content: card.content,
    sourceMessageIds: [...card.sourceMessageIds],
    mergeMemoryIds: [],
  };
}

export function AgentMemoryPanel({
  memories,
  messages,
  disabled = false,
  draftSource,
  onDraftConsumed,
  onSave,
  onRemove,
  onLocate,
}: AgentMemoryPanelProps) {
  const [open, setOpen] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!draftSource) return;
    setOpen(true);
    if (containsObviousAgentSecret(draftSource.content)) {
      setEditor(null);
      setError('检测到明显凭据；这条消息不能提炼为持久上下文记忆。');
    } else {
      setEditor({
        category: 'constraint',
        content: draftSource.content.slice(0, MAX_AGENT_MEMORY_CONTENT_CHARS),
        sourceMessageIds: [draftSource.id],
        mergeMemoryIds: [],
        sourceWasTrimmed: draftSource.content.length > MAX_AGENT_MEMORY_CONTENT_CHARS,
      });
      setError(null);
    }
    onDraftConsumed?.();
  }, [draftSource, onDraftConsumed]);

  const submit = async () => {
    if (!editor || pending) return;
    const content = editor.content.trim();
    if (!content || content.length > MAX_AGENT_MEMORY_CONTENT_CHARS) {
      setError(`记忆内容必须为 1-${MAX_AGENT_MEMORY_CONTENT_CHARS} 个字符。`);
      return;
    }
    if (editor.sourceWasTrimmed) {
      setError('原消息超过单卡片上限；请先编辑并提炼预填内容，再保存。');
      return;
    }
    if (containsObviousAgentSecret(content)) {
      setError('检测到密码、API Key、令牌、passphrase、OTP 或私钥，不能保存。');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onSave({
        ...(editor.memoryId ? { memoryId: editor.memoryId } : {}),
        category: editor.category,
        content,
        sourceMessageIds: [...editor.sourceMessageIds],
        mergeMemoryIds: [...editor.mergeMemoryIds],
      });
      setEditor(null);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setPending(false);
    }
  };

  const remove = async (memoryId: string) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await onRemove(memoryId);
      if (editor?.memoryId === memoryId) setEditor(null);
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : String(removeError));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="agent-memory-control">
      <button
        type="button"
        className="agent-memory-trigger"
        data-testid="agent-memory-trigger"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >记忆 {memories.length}</button>
      {open && (
        <section className="agent-memory-panel" data-testid="agent-memory-panel">
          <header>
            <div>
              <strong>上下文记忆</strong>
              <small>当前 AI 对话专属 · 每轮注入 · 不受自动摘要清理</small>
            </div>
            <button type="button" aria-label="关闭上下文记忆" onClick={() => setOpen(false)}>×</button>
          </header>
          <div className="agent-memory-list">
            {memories.length === 0 && <p>暂无记忆。可从消息中“存为记忆”，或新建短卡片。</p>}
            {memories.map((memory) => (
              <article key={memory.id} data-memory-id={memory.id}>
                <span>{CATEGORY_LABELS[memory.category]}</span>
                <p>{memory.content}</p>
                <small>{memory.pinSource === 'user-message' ? '来自消息' : '用户创建'}</small>
                <div>
                  {memory.sourceMessageIds.map((sourceId) => {
                    const sourceExists = messages.some((message) => message.id === sourceId);
                    return (
                      <button
                        type="button"
                        key={sourceId}
                        disabled={!sourceExists}
                        title={sourceExists ? '定位来源消息' : '来源消息已不在当前可见对话中'}
                        onClick={() => onLocate(sourceId)}
                      >来源</button>
                    );
                  })}
                  <button type="button" disabled={pending} onClick={() => setEditor(editorForCard(memory))}>编辑/合并</button>
                  <button type="button" disabled={pending} onClick={() => void remove(memory.id)}>取消 Pin</button>
                </div>
              </article>
            ))}
          </div>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setEditor({
                category: 'pending',
                content: '',
                sourceMessageIds: [],
                mergeMemoryIds: [],
              });
              setError(null);
            }}
          >新建记忆</button>
          {editor && (
            <div className="agent-memory-editor">
              <label>分类
                <select
                  value={editor.category}
                  onChange={(event) => setEditor({
                    ...editor,
                    category: event.target.value as AgentMemoryCategory,
                  })}
                >
                  {AGENT_MEMORY_CATEGORIES.map((category) => (
                    <option value={category} key={category}>{CATEGORY_LABELS[category]}</option>
                  ))}
                </select>
              </label>
              <label>短记忆
                <textarea
                  aria-label="上下文记忆内容"
                  maxLength={MAX_AGENT_MEMORY_CONTENT_CHARS}
                  value={editor.content}
                  onChange={(event) => setEditor({
                    ...editor,
                    content: event.target.value,
                    sourceWasTrimmed: false,
                  })}
                />
              </label>
              <small>{editor.content.length} / {MAX_AGENT_MEMORY_CONTENT_CHARS}</small>
              {editor.sourceWasTrimmed && (
                <small>原消息过长，已仅预填前 {MAX_AGENT_MEMORY_CONTENT_CHARS} 字；请提炼后保存。</small>
              )}
              {memories.some((memory) => memory.id !== editor.memoryId) && (
                <fieldset>
                  <legend>保存时合并并移除其他卡片</legend>
                  {memories.filter((memory) => memory.id !== editor.memoryId).map((memory) => (
                    <label key={memory.id}>
                      <input
                        type="checkbox"
                        checked={editor.mergeMemoryIds.includes(memory.id)}
                        onChange={(event) => setEditor({
                          ...editor,
                          mergeMemoryIds: event.target.checked
                            ? [...editor.mergeMemoryIds, memory.id]
                            : editor.mergeMemoryIds.filter((id) => id !== memory.id),
                        })}
                      />
                      {CATEGORY_LABELS[memory.category]}：{memory.content.slice(0, 80)}
                    </label>
                  ))}
                </fieldset>
              )}
              <div>
                <button type="button" disabled={pending} onClick={() => setEditor(null)}>取消</button>
                <button type="button" disabled={pending} onClick={() => void submit()}>
                  {pending ? '保存中…' : '保存记忆'}
                </button>
              </div>
            </div>
          )}
          {error && <div className="agent-memory-error" role="alert">{error}</div>}
        </section>
      )}
    </div>
  );
}
