import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface AgentSmokeProvider {
  baseUrl: string;
  close(): Promise<void>;
}

interface SmokeMessage {
  role?: string;
  content?: string;
}

function toolResponse(id: string, command: string, reason: string): string {
  return JSON.stringify({
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id,
          type: 'function',
          function: {
            name: 'terminal_execute',
            arguments: JSON.stringify({ command, reason }),
          },
        }],
      },
    }],
  });
}

function textResponse(content: string): string {
  return JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] });
}

function sendTextResponse(response: ServerResponse, content: string, stream: boolean): void {
  if (!stream) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(textResponse(content));
    return;
  }
  const splitAt = Math.max(1, Math.floor(content.length / 2));
  const chunks = [content.slice(0, splitAt), content.slice(splitAt)];
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
  });
  response.write(`data: ${JSON.stringify({
    choices: [{ delta: { content: chunks[0] } }],
  })}\n\n`);
  setTimeout(() => {
    response.write(`data: ${JSON.stringify({
      choices: [{ delta: { content: chunks[1] } }],
    })}\n\n`);
    response.end('data: [DONE]\n\n');
  }, 800);
}

export async function startAgentSmokeProvider(remotePosix = false): Promise<AgentSmokeProvider> {
  const windowsShell = !remotePosix && process.platform === 'win32';
  const approvedCommand = windowsShell
    ? "Write-Output '__AI_AGENT_APPROVED__'"
    : "printf '__AI_AGENT_APPROVED__\\n'";
  const takeoverCommands = windowsShell
    ? [
      "Write-Output '__AI_FULL_TAKEOVER_ONE__'",
      "Write-Output '__AI_FULL_TAKEOVER_TWO__'",
    ]
    : [
      "printf '__AI_FULL_TAKEOVER_ONE__\\n'",
      "printf '__AI_FULL_TAKEOVER_TWO__\\n'",
    ];
  const authCommand = windowsShell
    ? "$null = Read-Host -AsSecureString -Prompt 'Password'; Write-Output '__AI_AUTH_OK__'"
    : "read -s -p 'Password: ' __ait_secret; printf '\\n__AI_AUTH_OK__\\n'";
  const longCommand = windowsShell
    ? "Start-Sleep -Seconds 20; Write-Output '__AI_SHOULD_NOT_COMPLETE__'"
    : "sleep 20; printf '__AI_SHOULD_NOT_COMPLETE__\\n'";

  const server = createServer((request, response) => {
    const authorized = request.headers.authorization === 'Bearer agent-smoke-secret';
    if (!authorized) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'agent-smoke-model' }] }));
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        const parsed = JSON.parse(body) as { messages?: SmokeMessage[]; stream?: boolean };
        const messages = parsed.messages ?? [];
        let lastUserIndex = messages.length - 1;
        while (lastUserIndex >= 0 && messages[lastUserIndex]?.role !== 'user') {
          lastUserIndex -= 1;
        }
        const lastUser = lastUserIndex >= 0 ? messages[lastUserIndex] : undefined;
        const prompt = lastUser?.content ?? '';
        const toolResultCount = messages
          .slice(lastUserIndex + 1)
          .filter((message) => message.role === 'tool').length;
        if (prompt.includes('Full Takeover marker')) {
          if (toolResultCount < 2) {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(toolResponse(
              `full-takeover-${toolResultCount + 1}`,
              takeoverCommands[toolResultCount],
              'verify consecutive Full Takeover commands',
            ));
          } else {
            sendTextResponse(response, 'Full Takeover smoke complete.', parsed.stream === true);
          }
          return;
        }
        if (prompt.includes('secure authentication smoke')) {
          if (toolResultCount === 0) {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(toolResponse(
              'auth-smoke-call', authCommand, 'verify secure input handoff',
            ));
          } else {
            sendTextResponse(response, 'Authentication smoke complete.', parsed.stream === true);
          }
          return;
        }
        if (prompt.includes('manual takeover smoke')) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(toolResponse(
            'manual-takeover-call',
            longCommand,
            'verify manual takeover and Ctrl+C',
          ));
          return;
        }
        if (toolResultCount === 0) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(toolResponse(
            'agent-smoke-call', approvedCommand, 'verify shared visible terminal',
          ));
        } else {
          sendTextResponse(
            response,
            'Agent smoke complete: **approved command ran in the shared terminal**.',
            parsed.stream === true,
          );
        }
      });
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
