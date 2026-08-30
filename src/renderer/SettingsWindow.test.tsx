import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '../shared/ipc';
import type { AppSettings } from '../shared/settings';
import { SettingsWindow } from './SettingsWindow';

const initialSettings: AppSettings = {
  schemaVersion: 1,
  theme: 'dark',
  language: 'zh-CN',
  logRetentionDays: 90,
  defaultMaxRounds: 40,
  createdAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
};

function settingsBridge() {
  return {
    runtime: {
      getInfo: vi.fn().mockResolvedValue({ platform: 'win32', arch: 'x64', version: 'test' }),
    },
    settings: {
      get: vi.fn().mockResolvedValue(initialSettings),
      update: vi.fn().mockImplementation(async (patch) => ({
        ...initialSettings,
        ...patch,
        updatedAt: '2026-08-20T00:01:00.000Z',
      })),
      onChanged: vi.fn(() => () => undefined),
    },
    backup: {
      export: vi.fn().mockResolvedValue(null),
      import: vi.fn().mockResolvedValue(null),
    },
    hostBackup: {
      export: vi.fn().mockResolvedValue(null),
      import: vi.fn().mockResolvedValue(null),
    },
    settingsWindow: {
      open: vi.fn().mockResolvedValue(undefined),
      onNavigate: vi.fn(() => () => undefined),
    },
  } as unknown as DesktopBridge;
}

function setNumberInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function setTextInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function settle(): Promise<void> {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

describe('SettingsWindow runtime settings', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await act(async () => root.unmount());
    container.remove();
  });

  it('requires irreversible-deletion confirmation before lowering terminal retention', async () => {
    const bridge = settingsBridge();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    Object.defineProperty(window, 'aiTerminal', { configurable: true, value: bridge });
    await act(async () => root.render(<SettingsWindow />));
    await settle();

    expect(container.textContent).toContain('终端日志保留');
    expect(container.textContent).toContain('200 MiB');
    expect(container.textContent).toContain('Agent 自动检查点间隔（1-64 轮）');
    expect(container.textContent).toContain('不是任务总轮数上限');
    const retention = container.querySelectorAll<HTMLInputElement>('input[type="number"]')[0]!;
    await act(async () => setNumberInput(retention, '30'));
    const save = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === '保存')!;
    await act(async () => save.click());

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('永久删除'));
    expect(bridge.settings.update).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await act(async () => save.click());
    await settle();
    expect(bridge.settings.update).toHaveBeenCalledWith(expect.objectContaining({
      logRetentionDays: 30,
      defaultMaxRounds: 40,
    }));
  });

  it('does not warn when changing from a finite retention to unlimited time', async () => {
    const bridge = settingsBridge();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    Object.defineProperty(window, 'aiTerminal', { configurable: true, value: bridge });
    await act(async () => root.render(<SettingsWindow />));
    await settle();

    const retention = container.querySelectorAll<HTMLInputElement>('input[type="number"]')[0]!;
    await act(async () => setNumberInput(retention, '0'));
    const save = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === '保存')!;
    await act(async () => save.click());
    await settle();

    expect(confirm).not.toHaveBeenCalled();
    expect(bridge.settings.update).toHaveBeenCalledWith(expect.objectContaining({
      logRetentionDays: 0,
    }));
  });

  it('defaults to a credential-free export and requires matching passphrases when enabled', async () => {
    const bridge = settingsBridge();
    Object.defineProperty(window, 'aiTerminal', { configurable: true, value: bridge });
    await act(async () => root.render(<SettingsWindow />));
    await settle();
    await act(async () => [...container.querySelectorAll('button')]
      .find((button) => button.textContent === '数据')!.click());

    const includeCredentials = container.querySelector<HTMLInputElement>(
      '[data-testid="backup-include-credentials"]',
    )!;
    expect(includeCredentials.checked).toBe(false);
    expect(container.querySelector('[data-testid="backup-passphrase-fields"]')).toBeNull();

    const exportButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === '导出配置…')!;
    await act(async () => exportButton.click());
    await settle();
    expect(bridge.backup.export).toHaveBeenCalledWith({
      includeLogs: false,
      includeCredentials: false,
    });

    vi.mocked(bridge.backup.export).mockClear();
    await act(async () => includeCredentials.click());
    const passwordInputs = container.querySelectorAll<HTMLInputElement>(
      '[data-testid="backup-passphrase-fields"] input[type="password"]',
    );
    await act(async () => {
      setTextInput(passwordInputs[0]!, 'long enough password');
      setTextInput(passwordInputs[1]!, 'does not match password');
      exportButton.click();
    });
    expect(bridge.backup.export).not.toHaveBeenCalled();
    expect(container.textContent).toContain('不一致');

    await act(async () => {
      setTextInput(passwordInputs[1]!, 'long enough password');
      exportButton.click();
    });
    await settle();
    expect(bridge.backup.export).toHaveBeenCalledWith({
      includeLogs: false,
      includeCredentials: true,
      passphrase: 'long enough password',
      passphraseConfirmation: 'long enough password',
    });
  });

  it('requests an encrypted import passphrase after file detection and reuses the bound token', async () => {
    const bridge = settingsBridge();
    vi.mocked(bridge.backup.import)
      .mockResolvedValueOnce({
        challenge: 'passphrase-required',
        token: 'bound-import-token',
        message: '检测到整包加密备份。',
      })
      .mockResolvedValueOnce({
        sectionsImported: ['settings'],
        sectionsSkipped: [],
        needsRestart: true,
      });
    Object.defineProperty(window, 'aiTerminal', { configurable: true, value: bridge });
    await act(async () => root.render(<SettingsWindow />));
    await settle();
    await act(async () => [...container.querySelectorAll('button')]
      .find((button) => button.textContent === '数据')!.click());
    await act(async () => [...container.querySelectorAll('button')]
      .find((button) => button.textContent === '导入配置…')!.click());
    await settle();

    const modal = container.querySelector<HTMLElement>('[data-testid="backup-import-challenge"]')!;
    expect(modal.textContent).toContain('解密备份');
    await act(async () => setTextInput(
      modal.querySelector<HTMLInputElement>('input[type="password"]')!,
      'import password',
    ));
    await act(async () => [...modal.querySelectorAll('button')]
      .find((button) => button.textContent === '解密并导入')!.click());
    await settle();

    expect(bridge.backup.import).toHaveBeenNthCalledWith(1);
    expect(bridge.backup.import).toHaveBeenNthCalledWith(2, {
      token: 'bound-import-token',
      passphrase: 'import password',
    });
    expect(container.textContent).toContain('重启后生效');
  });
});
