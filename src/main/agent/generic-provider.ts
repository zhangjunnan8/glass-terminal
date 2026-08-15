import type { ProviderStore } from '../providers/provider-store';
import type {
  AgentCompletion,
  AgentCompletionRequest,
  AgentMessage,
  AgentProviderRuntime,
} from './agent-loop';

const MAX_PROVIDER_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ASSISTANT_TEXT_CHARS = 100_000;
const SAFE_STREAM_FINISH_REASONS = new Set(['stop', 'tool_calls']);

interface OpenAiToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiAssistantMessage {
  role?: string;
  content?: string | null;
  tool_calls?: OpenAiToolCall[];
}

interface OpenAiResponse {
  choices?: Array<{
    message?: OpenAiAssistantMessage;
    finish_reason?: string | null;
  }>;
}

interface OpenAiStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<OpenAiToolCall & { index?: number }>;
    };
    finish_reason?: string | null;
  }>;
  error?: unknown;
}

interface StreamedToolCall {
  id?: string;
  type?: string;
  name: string;
  arguments: string;
}

function openAiMessage(message: AgentMessage): Record<string, unknown> {
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: message.toolCalls?.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  if (message.role === 'tool') {
    return { role: 'tool', content: message.content, tool_call_id: message.toolCallId };
  }
  return message;
}

function parseCompletion(text: string): AgentCompletion {
  let parsed: OpenAiResponse;
  try {
    parsed = JSON.parse(text) as OpenAiResponse;
  } catch {
    throw new Error('Provider returned invalid JSON.');
  }
  const choice = parsed.choices?.[0];
  const expectedFinishReason = choice?.message?.tool_calls?.length ? 'tool_calls' : 'stop';
  if (choice?.finish_reason !== expectedFinishReason) {
    throw new Error(`Provider JSON completion ended unsafely (${choice?.finish_reason ?? 'missing'}).`);
  }
  return completionFromMessage(choice.message);
}

function completionFromMessage(
  message: OpenAiAssistantMessage | undefined,
): AgentCompletion {
  if (!message || (message.content == null && !message.tool_calls?.length)) {
    throw new Error('Provider returned no assistant message.');
  }
  if (
    typeof message.content === 'string'
    && message.content.length > MAX_ASSISTANT_TEXT_CHARS
  ) throw new Error('Provider assistant message is too large.');
  return {
    message: {
      role: 'assistant',
      content: typeof message.content === 'string' ? message.content : null,
      toolCalls: message.tool_calls?.map((call, index) => {
        if (call.type !== 'function' || !call.function?.name) {
          throw new Error('Provider returned an invalid tool call.');
        }
        return {
          id: call.id ?? `tool-${index}`,
          name: call.function.name,
          arguments: call.function.arguments ?? '{}',
        };
      }),
    },
  };
}

async function readEventStream(
  response: Response,
  onTextDelta: ((delta: string) => void) | undefined,
): Promise<AgentCompletion> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Provider returned an empty stream.');
  const decoder = new TextDecoder();
  const toolCalls = new Map<number, StreamedToolCall>();
  const dataLines: string[] = [];
  let buffered = '';
  let content = '';
  let receivedBytes = 0;
  let done = false;
  let finishReason: 'stop' | 'tool_calls' | undefined;

  const dispatch = () => {
    if (dataLines.length === 0 || done) {
      dataLines.length = 0;
      return;
    }
    const payload = dataLines.splice(0).join('\n').trim();
    if (!payload) return;
    if (payload === '[DONE]') {
      done = true;
      return;
    }
    if (finishReason) {
      throw new Error('Provider streamed data after its completion reason.');
    }
    let parsed: OpenAiStreamChunk;
    try {
      parsed = JSON.parse(payload) as OpenAiStreamChunk;
    } catch {
      throw new Error('Provider returned an invalid event stream.');
    }
    if (parsed.error) throw new Error('Provider stream returned an error.');
    const choice = parsed.choices?.[0];
    const reportedFinishReason = choice?.finish_reason;
    if (
      typeof reportedFinishReason === 'string'
      && reportedFinishReason
      && !SAFE_STREAM_FINISH_REASONS.has(reportedFinishReason)
    ) throw new Error(`Provider stream ended unsafely (${reportedFinishReason}).`);
    if (reportedFinishReason === 'stop' || reportedFinishReason === 'tool_calls') {
      finishReason = reportedFinishReason;
    }
    const delta = choice?.delta;
    if (!delta) return;
    if (typeof delta.content === 'string' && delta.content) {
      if (content.length + delta.content.length > MAX_ASSISTANT_TEXT_CHARS) {
        throw new Error('Provider assistant message is too large.');
      }
      content += delta.content;
      onTextDelta?.(delta.content);
    }
    for (const streamed of delta.tool_calls ?? []) {
      if (!Number.isInteger(streamed.index) || (streamed.index ?? -1) < 0) {
        throw new Error('Provider streamed an invalid tool-call index.');
      }
      const index = streamed.index!;
      const current = toolCalls.get(index) ?? { name: '', arguments: '' };
      if (streamed.id) current.id = streamed.id;
      if (streamed.type) current.type = streamed.type;
      if (typeof streamed.function?.name === 'string') current.name += streamed.function.name;
      if (typeof streamed.function?.arguments === 'string') {
        current.arguments += streamed.function.arguments;
      }
      toolCalls.set(index, current);
    }
  };

  const acceptLine = (rawLine: string) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line) {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    if (line === 'data') dataLines.push('');
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  };

  try {
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > MAX_PROVIDER_RESPONSE_BYTES) {
        throw new Error('Provider response is too large.');
      }
      buffered += decoder.decode(chunk.value, { stream: true });
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        acceptLine(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
      }
    }
    buffered += decoder.decode();
    if (buffered) acceptLine(buffered);
    dispatch();
    if (!done && !finishReason) {
      throw new Error('Provider event stream ended before a completion marker.');
    }

    const assembledTools = [...toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, call]): OpenAiToolCall => ({
        id: call.id ?? `tool-${index}`,
        type: call.type ?? 'function',
        function: { name: call.name, arguments: call.arguments || '{}' },
      }));
    if (finishReason) {
      const expectedFinishReason = assembledTools.length ? 'tool_calls' : 'stop';
      if (finishReason !== expectedFinishReason) {
        throw new Error(
          `Provider stream finish reason ${finishReason} does not match ${expectedFinishReason}.`,
        );
      }
    }
    return completionFromMessage({
      content: content || null,
      tool_calls: assembledTools.length ? assembledTools : undefined,
    });
  } finally {
    await reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* best-effort stream cleanup */ }
  }
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > MAX_PROVIDER_RESPONSE_BYTES) {
        throw new Error('Provider response is too large.');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    await reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* best-effort stream cleanup */ }
  }
}

export class GenericOpenAiProvider implements AgentProviderRuntime {
  constructor(
    private readonly providerId: string,
    private readonly providers: ProviderStore,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async complete(request: AgentCompletionRequest): Promise<AgentCompletion> {
    const profile = this.providers.get(this.providerId);
    if (profile.status !== 'ready') throw new Error(`Provider ${profile.name} is not Ready.`);
    const apiKey = await this.providers.apiKey(profile.id);
    const response = await this.fetchImplementation(`${profile.baseUrl}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      signal: request.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: profile.modelId,
        messages: request.messages.map(openAiMessage),
        tools: request.tools.map((tool) => ({
          type: 'function',
          function: tool,
        })),
        tool_choice: 'auto',
        stream: true,
      }),
    });
    if (!response.ok) throw new Error(`Provider completion failed with HTTP ${response.status}.`);
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > MAX_PROVIDER_RESPONSE_BYTES) throw new Error('Provider response is too large.');
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (contentType.includes('text/event-stream')) {
      return readEventStream(response, request.onTextDelta);
    }
    const text = await readBoundedResponseText(response);
    const completion = parseCompletion(text);
    if (completion.message.content) request.onTextDelta?.(completion.message.content);
    return completion;
  }
}
