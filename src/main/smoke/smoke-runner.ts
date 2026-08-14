import { app } from 'electron';
import type { BrowserWindow } from 'electron';

export type SmokeMode = 'local' | 'ssh' | 'agent' | 'agent-ssh' | null;

export function smokeModeFromEnvironment(): SmokeMode {
  if (process.env.AI_TERMINAL_AGENT_SSH_SMOKE_TEST === '1') return 'agent-ssh';
  if (process.env.AI_TERMINAL_AGENT_SMOKE_TEST === '1') return 'agent';
  if (process.env.AI_TERMINAL_SSH_SMOKE_TEST === '1') return 'ssh';
  if (process.env.AI_TERMINAL_SMOKE_TEST === '1') return 'local';
  return null;
}

export function registerSmokeRunner(window: BrowserWindow, mode: Exclude<SmokeMode, null>) {
  window.webContents.once('did-finish-load', async () => {
    try {
      const ready = mode === 'ssh'
        ? await runSshSmoke(window)
        : mode === 'agent' || mode === 'agent-ssh'
          ? await runAgentSmoke(window, mode === 'agent-ssh')
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

async function runAgentSmoke(window: BrowserWindow, useSsh: boolean): Promise<boolean> {
  const sshConfig = useSsh ? {
    hostname: process.env.AI_TERMINAL_SSH_TEST_HOST,
    username: process.env.AI_TERMINAL_SSH_TEST_USER,
    password: process.env.AI_TERMINAL_SSH_TEST_PASSWORD,
    port: Number(process.env.AI_TERMINAL_SSH_TEST_PORT ?? 22),
  } : null;
  if (useSsh && (!sshConfig?.hostname || !sshConfig.username || !sshConfig.password)) {
    throw new Error('Agent SSH smoke requires host, user, and password variables.');
  }
  return window.webContents.executeJavaScript(
    `(async () => { try {
      const sshConfig = ${JSON.stringify(sshConfig)};
      const waitFor = (predicate, timeout = 15000) => new Promise((resolve) => {
        const deadline = Date.now() + timeout;
        const check = () => {
          if (predicate()) resolve(true);
          else if (Date.now() >= deadline) resolve(false);
          else setTimeout(check, 100);
        };
        check();
      });
      let host = null;
      let terminalId = null;
      let pane = null;
      if (sshConfig) {
        host = await window.aiTerminal.hosts.save({
          name: 'Agent SSH Smoke Target',
          hostname: sshConfig.hostname,
          port: sshConfig.port,
          username: sshConfig.username,
          authMethod: 'password',
        });
        let connection = await window.aiTerminal.terminal.connectSsh({
          hostId: host.id,
          password: sshConfig.password,
        });
        if (connection.status === 'host-key-required') {
          connection = await window.aiTerminal.terminal.connectSsh({
            hostId: host.id,
            password: sshConfig.password,
            trustHostKey: connection.fingerprint,
          });
        }
        if (connection.status !== 'connected') throw new Error('Agent SSH connection failed.');
        terminalId = connection.terminal.id;
        window.dispatchEvent(new CustomEvent('ai-terminal:terminal-opened', {
          detail: connection.terminal,
        }));
        const ready = await waitFor(() => document.querySelector(
          '[data-terminal-id="' + terminalId + '"][data-terminal-output="true"]',
        ));
        if (!ready) throw new Error('Agent SSH terminal did not attach.');
        pane = document.querySelector('[data-terminal-id="' + terminalId + '"]');
      } else {
        const started = await waitFor(() => document.querySelector('[data-terminal-output="true"]'));
        if (!started) throw new Error('Local terminal did not start.');
        pane = document.querySelector('[data-terminal-output="true"]');
        terminalId = pane?.getAttribute('data-terminal-id');
        if (!terminalId) throw new Error('Local terminal id is missing.');
      }
      const textarea = document.querySelector('textarea[aria-label="Message AI"]');
      if (!(textarea instanceof HTMLTextAreaElement) || textarea.disabled) {
        throw new Error('Agent composer is not ready.');
      }
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setter?.call(textarea, 'Run the harmless shared-terminal marker test.');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.closest('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      const approvalReady = await waitFor(() => document.querySelector('.approval-card'));
      if (!approvalReady) throw new Error('Command approval did not appear.');
      if (pane?.textContent?.includes('__AI_AGENT_APPROVED__')) {
        throw new Error('Command executed before approval.');
      }
      const execute = [...document.querySelectorAll('.approval-actions button')]
        .find((button) => button.textContent === 'Execute');
      if (!(execute instanceof HTMLButtonElement)) throw new Error('Execute button is missing.');
      execute.click();
      const markerVisible = await waitFor(
        () => pane?.textContent?.includes('__AI_AGENT_APPROVED__'),
      );
      const completed = await waitFor(
        () => document.querySelector('.agent-body')?.textContent?.includes('Agent smoke complete'),
      );
      const state = await window.aiTerminal.agent.getState(terminalId);
      if (host) {
        await window.aiTerminal.terminal.write(terminalId, 'exit\\r');
        await waitFor(() => document.querySelector('.tab-state.exited'), 8000);
        await window.aiTerminal.hosts.remove(host.id);
      }
      return {
        ok: Boolean(markerVisible && completed && state?.state === 'COMPLETED'),
        sessionId: state?.sessionId,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) };
    } })()`,
  ).then((result) => {
    if (!result?.ok && result?.error) throw new Error(result.error);
    return Boolean(result?.ok && result?.sessionId);
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
