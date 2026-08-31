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
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      const sendPrompt = (prompt) => {
        const textarea = document.querySelector('textarea[data-testid="agent-composer"]');
        if (!(textarea instanceof HTMLTextAreaElement) || textarea.disabled) {
          throw new Error('Agent composer is not ready.');
        }
        setter?.call(textarea, prompt);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.closest('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      };
      sendPrompt('Run the harmless shared-terminal marker test.');
      const approvalReady = await waitFor(() => document.querySelector('.approval-card'));
      if (!approvalReady) throw new Error('Command approval did not appear.');
      if (pane?.textContent?.includes('__AI_AGENT_APPROVED__')) {
        throw new Error('Command executed before approval.');
      }
      const execute = document.querySelector('[data-action="execute-command"]');
      if (!(execute instanceof HTMLButtonElement)) throw new Error('Execute button is missing.');
      execute.click();
      const markerVisible = await waitFor(
        () => pane?.textContent?.includes('__AI_AGENT_APPROVED__'),
      );
      const partialVisible = await waitFor(() => {
        const streaming = document.querySelector('.agent-markdown[data-streaming="true"]');
        return streaming?.textContent?.includes('Agent smoke complete');
      });
      const completed = await waitFor(
        () => document.querySelector('.terminal-stage')?.getAttribute('data-agent-state') === 'COMPLETED'
          && document.querySelector('.agent-body')?.textContent?.includes('Agent smoke complete'),
      );
      if (!markerVisible || !partialVisible || !completed) {
        const agentState = document.querySelector('.terminal-stage')?.getAttribute('data-agent-state');
        const streamingText = document.querySelector('.agent-markdown[data-streaming="true"]')?.textContent;
        throw new Error(
          'Approved Agent command did not stream and complete: marker=' + markerVisible
          + ', partial=' + partialVisible + ', completed=' + completed
          + ', state=' + agentState + ', streaming=' + JSON.stringify(streamingText),
        );
      }
      const markdownStrong = document.querySelector('.agent-message.assistant .agent-markdown strong');
      if (markdownStrong?.textContent !== 'approved command ran in the shared terminal') {
        throw new Error('Agent Markdown was not rendered as semantic markup.');
      }
      const agentScroll = document.querySelector('[data-testid="agent-scroll-container"]');
      if (!(agentScroll instanceof HTMLElement)
        || agentScroll.scrollHeight - agentScroll.clientHeight - agentScroll.scrollTop > 33) {
        throw new Error('Agent output did not automatically follow the latest message.');
      }

      const switchToFull = document.querySelector('.agent-review-modes .complete-access');
      if (!(switchToFull instanceof HTMLButtonElement)) {
        throw new Error('Complete Access mode button is missing.');
      }
      switchToFull.click();
      const riskVisible = await waitFor(() => document.querySelector('.complete-access-modal'));
      if (!riskVisible) throw new Error('Complete Access risk confirmation did not appear.');
      const riskModal = document.querySelector('.complete-access-modal');
      if (riskModal?.getAttribute('data-terminal-id') !== terminalId) {
        throw new Error('Complete Access confirmation is not bound to the active terminal.');
      }
      if (pane?.textContent?.includes('__AI_FULL_TAKEOVER_ONE__')) {
        throw new Error('Complete Access command ran before risk confirmation.');
      }
      const enableFull = document.querySelector('.complete-access-modal [data-action="confirm-complete-access"]');
      if (!(enableFull instanceof HTMLButtonElement)) throw new Error('Complete Access confirmation is missing.');
      enableFull.click();
      const fullEnabled = await waitFor(
        () => document.querySelector('.terminal-stage')?.getAttribute('data-review-mode') === 'complete',
      );
      if (!fullEnabled) throw new Error('Complete Access did not become active.');

      sendPrompt('Run two Complete Access marker commands.');
      const fullOne = await waitFor(() => pane?.textContent?.includes('__AI_FULL_TAKEOVER_ONE__'));
      const fullTwo = await waitFor(() => pane?.textContent?.includes('__AI_FULL_TAKEOVER_TWO__'));
      const fullComplete = await waitFor(
        () => document.querySelector('.agent-body')?.textContent?.includes('Complete Access smoke complete'),
      );
      if (!fullOne || !fullTwo || !fullComplete || document.querySelector('.approval-card')) {
        throw new Error('Consecutive Complete Access execution failed.');
      }

      sendPrompt('Run the secure authentication smoke.');
      const authReady = await waitFor(
        () => document.querySelector('.terminal-stage')?.getAttribute('data-input-mode') === 'secure-human',
      );
      if (!authReady) throw new Error('Secure authentication handoff did not open.');
      const authState = await window.aiTerminal.agent.getState(terminalId);
      if (!authState?.authRequest) throw new Error('Authentication request metadata is missing.');
      const terminalTextarea = document.querySelector(
        '.terminal-pane[data-terminal-id="' + terminalId + '"] .xterm-helper-textarea',
      );
      if (!(terminalTextarea instanceof HTMLTextAreaElement)) {
        throw new Error('xterm secure input surface is missing.');
      }
      terminalTextarea.focus();
      terminalTextarea.dispatchEvent(new InputEvent('input', {
        data: '__AI_AUTH_SECRET_CANARY__\\rprintf __AI_PASTE_TAIL_EXECUTED__\\r',
        inputType: 'insertText',
        bubbles: true,
      }));
      const authMarker = await waitFor(() => pane?.textContent?.includes('__AI_AUTH_OK__'));
      const authComplete = await waitFor(
        () => document.querySelector('.agent-body')?.textContent?.includes('Authentication smoke complete'),
      );
      if (!authMarker || !authComplete) throw new Error('Authentication smoke did not resume the Agent.');
      if (pane?.textContent?.includes('__AI_PASTE_TAIL_EXECUTED__')) {
        throw new Error('Secure multiline paste tail reached the shell.');
      }

      sendPrompt('Run the stop-button smoke.');
      const running = await waitFor(
        () => document.querySelector('.terminal-stage')?.getAttribute('data-agent-state') === 'RUNNING',
      );
      if (!running) throw new Error('Stop-button command did not start.');
      const stopButton = document.querySelector('.composer .agent-stop-submit');
      if (!(stopButton instanceof HTMLButtonElement)) throw new Error('Composer stop button is missing.');
      stopButton.click();
      const paused = await waitFor(
        () => document.querySelector('.terminal-stage')?.getAttribute('data-agent-state') === 'PAUSED',
      );
      const shellReadyVisible = await waitFor(
        () => Boolean(document.querySelector('.execution-card [data-action="confirm-shell-ready"]')),
        1500,
      );
      if (shellReadyVisible) {
        const shellReady = document.querySelector('.execution-card [data-action="confirm-shell-ready"]');
        if (shellReady instanceof HTMLButtonElement) shellReady.click();
      }
      const trackingSettled = await waitFor(
        () => !document.querySelector('.execution-card.running'),
      );
      const state = await window.aiTerminal.agent.getState(terminalId);
      if (host) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        await window.aiTerminal.terminal.write(terminalId, 'exit\\r');
        await waitFor(() => document.querySelector('.tab-state.exited'), 8000);
        await window.aiTerminal.hosts.remove(host.id);
      }
      return {
        ok: Boolean(
          paused
          && trackingSettled
          && state?.state === 'PAUSED'
          && state.activeExecution?.status !== 'running'
          && state.reviewMode === 'all'
        ),
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
      const sectionLabel = document.querySelector('.section-label');
      const searchInput = document.querySelector('.search-box input');
      const uiLocalized = document.querySelector('.app-shell')?.getAttribute('data-locale') === 'zh-CN'
        && document.body.textContent?.includes('本地 SHELL');
      const uiReadable = sectionLabel && searchInput
        && Number.parseFloat(getComputedStyle(sectionLabel).fontSize) >= 12
        && Number.parseFloat(getComputedStyle(searchInput).fontSize) >= 14;
      const providerSettingsButton = document.querySelector('[data-action="open-provider-settings"]');
      const settingsWindowBridgeReady = providerSettingsButton instanceof HTMLButtonElement
        && typeof window.aiTerminal.settingsWindow.open === 'function';
      const agentBackendSelect = document.querySelector('[data-testid="agent-backend-select"]');
      const genericBackendSelected = agentBackendSelect instanceof HTMLSelectElement
        && agentBackendSelect.value === 'generic-provider'
        && agentBackendSelect.getAttribute('data-backend-kind') === 'generic-provider';
      await window.aiTerminal.terminal.close(terminalId);
      await new Promise((resolve) => setTimeout(resolve, 250));
      return commandSeen
        && sessionListed
        && uiLocalized
        && uiReadable
        && settingsWindowBridgeReady
        && genericBackendSelected
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
      document.querySelector('[data-action="toggle-sftp"]')?.click();
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
