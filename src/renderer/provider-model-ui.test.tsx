import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '../shared/ipc';
import { AiServiceSettings } from './AiServiceSettings';

vi.mock('./components/TerminalPane', () => ({
  TerminalPane: () => <div data-testid="terminal-pane" />,
}));

vi.mock('./components/SftpDrawer', () => ({
  SftpDrawer: () => null,
}));

function providerBridge(discoverModels: DesktopBridge['providers']['discoverModels']): DesktopBridge {
  return {
    runtime: {
      getInfo: vi.fn().mockResolvedValue({ platform: 'win32', arch: 'x64', version: 'test' }),
    },
    terminal: {
      listShells: vi.fn().mockResolvedValue([{
        id: 'shell-1',
        label: 'PowerShell',
        command: 'pwsh',
        args: [],
        kind: 'powershell',
        detail: 'Test shell',
      }]),
      create: vi.fn().mockResolvedValue({
        id: 'terminal-1',
        title: 'PowerShell',
        profileId: 'shell-1',
        shellKind: 'powershell',
        transport: 'local',
      }),
      close: vi.fn().mockResolvedValue(undefined),
      onExit: vi.fn(() => () => undefined),
    },
    hosts: {
      list: vi.fn().mockResolvedValue([]),
      listFolders: vi.fn().mockResolvedValue([]),
    },
    sessions: {
      list: vi.fn().mockResolvedValue([]),
      onRenamed: vi.fn(() => () => undefined),
    },
    providers: {
      list: vi.fn().mockResolvedValue([]),
      discoverModels,
    },
    codexAppServer: {
      getState: vi.fn(() => new Promise(() => undefined)),
      onStateChanged: vi.fn(() => () => undefined),
    },
    agent: {
      getState: vi.fn().mockResolvedValue(undefined),
      onStateChanged: vi.fn(() => () => undefined),
    },
    sftp: {},
  } as unknown as DesktopBridge;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('compatible API model picker', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    window.localStorage.clear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('shows exactly the discovered models and copies a choice into the editable model ID', async () => {
    let receivedRequest: unknown;
    const discoverModels = vi.fn().mockImplementation(async (request) => {
      receivedRequest = { ...request };
      return {
        models: ['model-alpha', 'model-beta', 'model-gamma'],
        message: '已检索到 3 个可用模型。',
      };
    });
    Object.defineProperty(window, 'aiTerminal', {
      configurable: true,
      value: providerBridge(discoverModels),
    });

    await act(async () => root.render(<AiServiceSettings />));
    await settle();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="provider-kind-generic"]')!.click();
    });

    let picker = container.querySelector<HTMLSelectElement>('[data-testid="provider-model-select"]')!;
    expect(picker.options[0]?.textContent).toBe('模板建议（1 个）');
    expect(picker.querySelectorAll('[data-provider-model]')).toHaveLength(1);

    const apiKey = container.querySelector<HTMLInputElement>('input[name="apiKey"]')!;
    await act(async () => setInputValue(apiKey, 'test-key'));
    const discoverButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '检索模型')!;
    await act(async () => discoverButton.click());
    await settle();

    expect(receivedRequest).toEqual({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
    });
    picker = container.querySelector<HTMLSelectElement>('[data-testid="provider-model-select"]')!;
    expect(picker.options[0]?.textContent).toBe('已检索到 3 个可用模型');
    expect([...picker.querySelectorAll<HTMLOptionElement>('[data-provider-model]')]
      .map((option) => option.value))
      .toEqual(['model-alpha', 'model-beta', 'model-gamma']);

    const modelInput = container.querySelector<HTMLInputElement>('input[name="modelId"]')!;
    await act(async () => setSelectValue(picker, 'model-beta'));
    expect(modelInput.value).toBe('model-beta');

    await act(async () => setInputValue(modelInput, 'manually-entered-model'));
    expect(modelInput.value).toBe('manually-entered-model');
  });
});
