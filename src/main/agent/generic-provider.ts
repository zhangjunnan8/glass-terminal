import type { ProviderStore } from '../providers/provider-store';
import type {
  AgentCompletion,
  AgentCompletionRequest,
  AgentMessage,
  AgentProviderRuntime,
} from './agent-loop';

const MAX_PROVIDER_RESPONSE_BYTES = 4 * 1024 * 1024;

interface OpenAiResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
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
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: profile.modelId,
        messages: request.messages.map(openAiMessage),
        tools: request.tools.map((tool) => ({
          type: 'function',
          function: tool,
        })),
        tool_choice: 'auto',
        stream: false,
      }),
    });
    if (!response.ok) throw new Error(`Provider completion failed with HTTP ${response.status}.`);
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > MAX_PROVIDER_RESPONSE_BYTES) throw new Error('Provider response is too large.');
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_PROVIDER_RESPONSE_BYTES) {
      throw new Error('Provider response is too large.');
    }
    let parsed: OpenAiResponse;
    try {
      parsed = JSON.parse(text) as OpenAiResponse;
    } catch {
      throw new Error('Provider returned invalid JSON.');
    }
    const message = parsed.choices?.[0]?.message;
    if (!message || (message.content == null && !message.tool_calls?.length)) {
      throw new Error('Provider returned no assistant message.');
    }
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
}
