import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '../shared/ipc';
import type { ProviderProfile } from '../shared/provider';
import { AiServiceSettings } from './AiServiceSettings';

vi.mock('./components/TerminalPane', () => ({
  TerminalPane: () => <div data-testid="terminal-pane" />,
}));

vi.mock('./components/SftpDrawer', () => ({
  SftpDrawer: () => null,
}));

function providerBridge(
  discoverModels: DesktopBridge['providers']['discoverModels'],
  providers: ProviderProfile[] = [],
): DesktopBridge {
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
      list: vi.fn().mockResolvedValue(providers),
      discoverModels,
      save: vi.fn().mockImplementation(async (input) => ({
        ...input,
        id: 'saved-provider',
        kind: 'generic-openai-compatible',
        recipientRevision: 'recipient-1',
        apiKeyConfigured: true,
        isDefault: true,
        status: 'not-tested',
        createdAt: '2026-08-20T00:00:00.000Z',
        updatedAt: '2026-08-20T00:00:00.000Z',
      })),
      testConnection: vi.fn().mockResolvedValue({ ok: true, message: '连接成功' }),
      remove: vi.fn().mockResolvedValue(undefined),
      setDefault: vi.fn(),
      onChanged: vi.fn(() => () => undefined),
    },
    agent: {
      getState: vi.fn().mockResolvedValue(undefined),
      setFullTakeoverPreference: vi.fn(),
      onStateChanged: vi.fn(() => () => undefined),
      onAssistantDelta: vi.fn(() => () => undefined),
    },
    sftp: {},
  } as unknown as DesktopBridge;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
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
    expect(container.querySelector('.provider-form')).toBeNull();
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('添加 Provider'))!.click());

    let options = container.querySelector<HTMLDataListElement>('[data-testid="provider-model-options"]')!;
    expect(options.querySelectorAll('[data-provider-model]')).toHaveLength(1);

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
    options = container.querySelector<HTMLDataListElement>('[data-testid="provider-model-options"]')!;
    expect(container.querySelector('[data-testid="provider-model-prompt"]')?.textContent)
      .toContain('已检索到 3 个可用模型');
    expect([...options.querySelectorAll<HTMLOptionElement>('[data-provider-model]')]
      .map((option) => option.value))
      .toEqual(['model-alpha', 'model-beta', 'model-gamma']);

    const modelInput = container.querySelector<HTMLInputElement>('input[name="modelId"]')!;
    await act(async () => setInputValue(modelInput, 'model-beta'));
    expect(modelInput.value).toBe('model-beta');

    await act(async () => setInputValue(modelInput, 'manually-entered-model'));
    expect(modelInput.value).toBe('manually-entered-model');
  });

  it('keeps the editor hidden until an existing provider is selected', async () => {
    const provider: ProviderProfile = {
      id: 'existing-provider',
      name: 'Existing API',
      kind: 'generic-openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      modelId: 'existing-model',
      contextWindowTokens: 500_736,
      contextEstimateSafetyFactor: 1.15,
      recipientRevision: 'recipient-1',
      apiKeyConfigured: true,
      isDefault: true,
      status: 'ready',
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-20T00:00:00.000Z',
    };
    Object.defineProperty(window, 'aiTerminal', {
      configurable: true,
      value: providerBridge(vi.fn(), [provider]),
    });

    await act(async () => root.render(<AiServiceSettings />));
    await settle();

    expect(container.querySelector('.provider-form')).toBeNull();
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('.provider-list button')]
      .find((button) => button.textContent?.includes(provider.name))!.click());

    expect(container.querySelector('.provider-form')).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[name="name"]')?.value)
      .toBe(provider.name);
  });

  it('shows and saves the configurable context estimation safety factor', async () => {
    const bridge = providerBridge(vi.fn().mockResolvedValue({
      models: ['gpt-5'],
      message: '已检索到 1 个可用模型。',
    }));
    Object.defineProperty(window, 'aiTerminal', { configurable: true, value: bridge });
    await act(async () => root.render(<AiServiceSettings />));
    await settle();
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('添加 Provider'))!.click());
    const factor = container.querySelector<HTMLInputElement>(
      'input[name="contextEstimateSafetyFactor"]',
    )!;
    expect(factor.value).toBe('1.15');
    expect(factor.min).toBe('1');
    expect(factor.max).toBe('2');
    await act(async () => setInputValue(factor, '1.4'));
    await act(async () => setInputValue(
      container.querySelector<HTMLInputElement>('input[name="apiKey"]')!,
      'test-key',
    ));
    await act(async () => container.querySelector<HTMLFormElement>('.provider-form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await settle();

    expect(bridge.providers.save).toHaveBeenCalledWith(expect.objectContaining({
      contextWindowTokens: 500_736,
      contextEstimateSafetyFactor: 1.4,
    }));
    expect(bridge.providers.testConnection).toHaveBeenCalledWith('saved-provider');
  });
});
