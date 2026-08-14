import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface AgentSmokeProvider {
  baseUrl: string;
  close(): Promise<void>;
}

export async function startAgentSmokeProvider(remotePosix = false): Promise<AgentSmokeProvider> {
  let completionCount = 0;
  const command = !remotePosix && process.platform === 'win32'
    ? "Write-Output '__AI_AGENT_APPROVED__'"
    : "printf '__AI_AGENT_APPROVED__\\n'";
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
        const parsed = JSON.parse(body) as { messages?: Array<{ role?: string }> };
        completionCount += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        if (completionCount === 1) {
          response.end(JSON.stringify({
            choices: [{
              message: {
                role: 'assistant',
                content: 'I need to run one harmless marker command.',
                tool_calls: [{
                  id: 'agent-smoke-call',
                  type: 'function',
                  function: {
                    name: 'terminal_execute',
                    arguments: JSON.stringify({ command, reason: 'verify shared visible terminal' }),
                  },
                }],
              },
            }],
          }));
          return;
        }
        const hasToolResult = parsed.messages?.some((message) => message.role === 'tool');
        response.end(JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              content: hasToolResult
                ? 'Agent smoke complete: the approved command ran in the shared terminal.'
                : 'Agent smoke failed to receive a tool result.',
            },
          }],
        }));
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
