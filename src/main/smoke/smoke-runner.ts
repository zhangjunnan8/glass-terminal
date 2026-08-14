import { app } from 'electron';
import type { BrowserWindow } from 'electron';

export type SmokeMode = 'local' | 'ssh' | null;

export function smokeModeFromEnvironment(): SmokeMode {
  if (process.env.AI_TERMINAL_SSH_SMOKE_TEST === '1') return 'ssh';
  if (process.env.AI_TERMINAL_SMOKE_TEST === '1') return 'local';
  return null;
}

export function registerSmokeRunner(window: BrowserWindow, mode: Exclude<SmokeMode, null>) {
  window.webContents.once('did-finish-load', async () => {
    try {
      const ready = mode === 'ssh'
        ? await runSshSmoke(window)
        : await runLocalSmoke(window);
      console.log(`SMOKE_${mode.toUpperCase()}_TERMINAL_READY=${String(ready)}`);
      app.exit(ready ? 0 : 1);
    } catch (error) {
      console.error(`SMOKE_${mode.toUpperCase()}_FAILED=${(error as Error).message}`);
      app.exit(1);
    }
  });
  window.webContents.once('did-fail-load', (_event, code, description) => {
    console.error(`SMOKE_RENDERER_FAILED=${code}:${description}`);
    app.exit(1);
  });
}

async function runLocalSmoke(window: BrowserWindow): Promise<boolean> {
  const smokeCommand = process.platform === 'win32'
    ? "Write-Output '__AI_TERMINAL_PTY_SMOKE__'\r"
    : "printf '__AI_TERMINAL_PTY_SMOKE__\\n'\n";
  return window.webContents.executeJavaScript(
    `(async () => {
      const waitFor = (predicate, timeout = 10000) => new Promise((resolve) => {
        const deadline = Date.now() + timeout;
        const check = () => {
          if (predicate()) resolve(true);
          else if (Date.now() >= deadline) resolve(false);
          else setTimeout(check, 100);
        };
        check();
      });
      const started = await waitFor(
        () => document.querySelector('[data-terminal-output="true"]'),
      );
      if (!started) return false;
      const pane = document.querySelector('[data-terminal-output="true"]');
      const terminalId = pane?.getAttribute('data-terminal-id');
      if (!terminalId) return false;
      await window.aiTerminal.terminal.write(terminalId, ${JSON.stringify(smokeCommand)});
      const commandSeen = await waitFor(
        () => pane.textContent?.includes('__AI_TERMINAL_PTY_SMOKE__'),
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      const session = await window.aiTerminal.sessions.upgrade({ terminalId });
      const persistedHistory = await window.aiTerminal.sessions.readTerminalHistory(session.id);
      const sessionListed = (await window.aiTerminal.sessions.list()).some(
        (item) => item.id === session.id,
      );
      await window.aiTerminal.terminal.close(terminalId);
      await new Promise((resolve) => setTimeout(resolve, 250));
      return commandSeen
        && sessionListed
        && persistedHistory.includes('__AI_TERMINAL_PTY_SMOKE__');
    })()`,
  );
}

async function runSshSmoke(window: BrowserWindow): Promise<boolean> {
  const hostname = process.env.AI_TERMINAL_SSH_TEST_HOST;
  const username = process.env.AI_TERMINAL_SSH_TEST_USER;
  const password = process.env.AI_TERMINAL_SSH_TEST_PASSWORD;
  const port = Number(process.env.AI_TERMINAL_SSH_TEST_PORT ?? 22);
  if (!hostname || !username || !password) {
    throw new Error('SSH smoke requires host, user, and password environment variables.');
  }
  const config = { hostname, username, password, port };
  const markerCommand = "printf '__AI_TERMINAL_SSH_SMOKE__\\n'\r";
  const exitCommand = 'exit\r';
  const result = await window.webContents.executeJavaScript(
    `(async () => { try {
      const config = ${JSON.stringify(config)};
      const waitFor = (predicate, timeout = 12000) => new Promise((resolve) => {
        const deadline = Date.now() + timeout;
        const check = () => {
          if (predicate()) resolve(true);
          else if (Date.now() >= deadline) resolve(false);
          else setTimeout(check, 100);
        };
        check();
      });
      let host = (await window.aiTerminal.hosts.list()).find(
        (item) => item.name === 'SSH Smoke Target' && item.hostname === config.hostname,
      );
      if (!host) {
        host = await window.aiTerminal.hosts.save({
          name: 'SSH Smoke Target',
          hostname: config.hostname,
          port: config.port,
          username: config.username,
          authMethod: 'password',
        });
      }
      let connection = await window.aiTerminal.terminal.connectSsh({
        hostId: host.id,
        password: config.password,
      });
      if (connection.status === 'host-key-required') {
        connection = await window.aiTerminal.terminal.connectSsh({
          hostId: host.id,
          password: config.password,
          trustHostKey: connection.fingerprint,
        });
      }
      if (connection.status !== 'connected') throw new Error('SSH trust handshake did not complete.');
      const descriptor = connection.terminal;
      window.dispatchEvent(new CustomEvent('ai-terminal:terminal-opened', {
        detail: descriptor,
      }));
      const paneReady = await waitFor(
        () => document.querySelector('[data-terminal-id="' + descriptor.id + '"][data-terminal-output="true"]'),
      );
      if (!paneReady) throw new Error('SSH terminal pane did not attach.');
      const pane = document.querySelector('[data-terminal-id="' + descriptor.id + '"]');
      document.querySelector('[title="SFTP files and transfers"]')?.click();
      const sftpReady = await waitFor(
        () => document.querySelector('[data-sftp-ready="true"]'),
      );
      await window.aiTerminal.terminal.write(
        descriptor.id,
        ${JSON.stringify(markerCommand)},
      );
      const commandSeen = await waitFor(
        () => pane?.textContent?.includes('__AI_TERMINAL_SSH_SMOKE__'),
      );
      await window.aiTerminal.terminal.write(descriptor.id, ${JSON.stringify(exitCommand)});
      await waitFor(() => document.querySelector('.tab-state.exited'), 8000);
      await window.aiTerminal.hosts.remove(host.id);
      return { ok: commandSeen && sftpReady };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      };
    }
    })()`,
  );
  if (!result?.ok && result?.error) throw new Error(result.error);
  return Boolean(result?.ok);
}
