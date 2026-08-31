import type { AgentChatItem } from '../../shared/agent';

const MAX_PREVIEW_MESSAGES = 200;
const MAX_PREVIEW_CHARACTERS = 200_000;

function safeChatItem(value: unknown): AgentChatItem | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Partial<AgentChatItem>;
  const role = item.role;
  if (
    typeof item.id !== 'string'
    || (role !== 'user' && role !== 'assistant' && role !== 'system')
    || typeof item.content !== 'string'
    || typeof item.createdAt !== 'string'
  ) return undefined;
  return {
    id: item.id,
    role,
    content: item.content,
    createdAt: item.createdAt,
    ...(typeof item.turnId === 'string' ? { turnId: item.turnId } : {}),
    ...(item.presentation === 'intermediate' || item.presentation === 'summary'
      ? { presentation: item.presentation }
      : {}),
  };
}

export function conversationPreview(
  events: Array<Record<string, unknown>>,
  sourceTruncated: boolean,
): { messages: AgentChatItem[]; truncated: boolean } {
  let messages: AgentChatItem[] = [];

  for (const event of events) {
    if (event.type === 'chat') {
      const item = safeChatItem(event.item);
      if (item) messages.push(item);
      continue;
    }
    if (
      event.type === 'chat_presentation'
      && typeof event.targetMessageId === 'string'
      && (event.presentation === 'intermediate' || event.presentation === 'summary')
    ) {
      const target = messages.find((message) => message.id === event.targetMessageId);
      if (target) target.presentation = event.presentation;
      continue;
    }
    if (
      event.type !== 'chat_action'
      || (event.action !== 'retract' && event.action !== 'replace')
      || typeof event.targetMessageId !== 'string'
    ) continue;

    const targetIndex = messages.findIndex((message) => (
      message.id === event.targetMessageId && message.role === 'user'
    ));
    if (targetIndex >= 0) {
      messages = messages.slice(0, targetIndex);
    } else if (sourceTruncated) {
      // The target may precede the bounded tail. Clearing the tail avoids
      // presenting responses that the append-only action invalidated.
      messages = [];
    }
    if (event.action === 'replace') {
      const replacement = safeChatItem(event.replacementItem);
      if (replacement?.role === 'user') messages.push(replacement);
    }
  }

  let characterCount = 0;
  let startIndex = messages.length;
  while (startIndex > 0 && messages.length - startIndex < MAX_PREVIEW_MESSAGES) {
    const next = messages[startIndex - 1]!;
    if (characterCount + next.content.length > MAX_PREVIEW_CHARACTERS) break;
    characterCount += next.content.length;
    startIndex -= 1;
  }
  return {
    messages: messages.slice(startIndex),
    truncated: sourceTruncated || startIndex > 0,
  };
}

export function plainTerminalPreview(content: string): string {
  return content
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B[@-_]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g, '');
}
