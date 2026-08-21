import { useCallback, useEffect, useState } from 'react';
import type { AppSettings } from '../shared/settings';
import type { BackupImportChallenge, BackupImportResponse } from '../shared/backup';
import { AiServiceSettings } from './AiServiceSettings';
import { useSystemTheme } from './theme';

type SettingsSection = 'general' | 'ai' | 'data';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isImportChallenge(
  response: BackupImportResponse,
): response is BackupImportChallenge {
  return 'challenge' in response;
}

export function SettingsWindow() {
  const [section, setSection] = useState<SettingsSection>('general');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const [backupPending, setBackupPending] = useState(false);
  const [includeLogs, setIncludeLogs] = useState(false);
  const [includeCredentials, setIncludeCredentials] = useState(false);
  const [exportPassphrase, setExportPassphrase] = useState('');
  const [exportPassphraseConfirmation, setExportPassphraseConfirmation] = useState('');
  const [importChallenge, setImportChallenge] = useState<BackupImportChallenge | null>(null);
  const [importPassphrase, setImportPassphrase] = useState('');
  const [version, setVersion] = useState('');
  const systemTheme = useSystemTheme();

  useEffect(() => {
    void window.aiTerminal.settings.get().then((next) => {
      setSettings(next);
      setDraft(next);
    }).catch((error) => setSettingsMessage(errorMessage(error)));
    void window.aiTerminal.runtime.getInfo().then((info) => setVersion(info.version));
    const removeSettingsListener = window.aiTerminal.settings.onChanged((next) => {
      setSettings(next);
      setDraft(next);
    });
    return removeSettingsListener;
  }, []);

  const patchDraft = useCallback((patch: Partial<AppSettings>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }, []);

  const saveSettings = useCallback(async () => {
    if (!draft) return;
    setSettingsMessage(null);
    const retentionWillDeleteSooner = Boolean(
      settings
      && draft.logRetentionDays !== settings.logRetentionDays
      && (
        settings.logRetentionDays === 0
        || (
          draft.logRetentionDays > 0
          && draft.logRetentionDays < settings.logRetentionDays
        )
      ),
    );
    if (
      retentionWillDeleteSooner
      && !window.confirm(
        `将终端日志保留期从 ${settings!.logRetentionDays === 0 ? '永久' : `${settings!.logRetentionDays} 天`}缩短为 ${draft.logRetentionDays} 天。超过新期限的终端日志会在保存后异步永久删除，且无法恢复。是否继续？`,
      )
    ) return;
    try {
      const saved = await window.aiTerminal.settings.update({
        theme: draft.theme,
        logRetentionDays: draft.logRetentionDays,
        defaultMaxRounds: draft.defaultMaxRounds,
      });
      setSettings(saved);
      setDraft(saved);
      setSettingsMessage('已保存。');
    } catch (error) {
      setSettingsMessage(errorMessage(error));
    }
  }, [draft, settings]);

  const exportBackup = useCallback(async () => {
    if (includeCredentials && exportPassphrase.trim().length < 12) {
      setBackupMessage('包含凭据时，备份口令至少需要 12 个字符。');
      return;
    }
    if (includeCredentials && exportPassphrase !== exportPassphraseConfirmation) {
      setBackupMessage('两次输入的备份口令不一致。');
      return;
    }
    setBackupPending(true);
    setBackupMessage(null);
    try {
      const result = await window.aiTerminal.backup.export({
        includeLogs,
        includeCredentials,
        ...(includeCredentials ? {
          passphrase: exportPassphrase,
          passphraseConfirmation: exportPassphraseConfirmation,
        } : {}),
      });
      if (result) {
        setBackupMessage(
          `已导出 ${result.sections.length} 个分区（${result.bytes} 字节）${result.encrypted ? '，整包已加密' : '，未包含凭据'}。`,
        );
        setExportPassphrase('');
        setExportPassphraseConfirmation('');
      }
    } catch (error) {
      setBackupMessage(errorMessage(error));
    } finally {
      setBackupPending(false);
    }
  }, [exportPassphrase, exportPassphraseConfirmation, includeCredentials, includeLogs]);

  const applyImportResponse = useCallback((response: BackupImportResponse) => {
    if (isImportChallenge(response)) {
      setImportChallenge(response);
      setImportPassphrase('');
      setBackupMessage(response.message);
      return;
    }
    setImportChallenge(null);
    setImportPassphrase('');
    const skipped = response.sectionsSkipped.length
      ? `，跳过 ${response.sectionsSkipped.length} 个分区`
      : '';
    setBackupMessage(
      response.needsRestart
        ? `已导入 ${response.sectionsImported.length} 个分区${skipped}。重启后生效。`
        : `已导入 ${response.sectionsImported.length} 个分区${skipped}。`,
    );
  }, []);

  const importBackup = useCallback(async () => {
    setBackupPending(true);
    setBackupMessage(null);
    try {
      const result = await window.aiTerminal.backup.import();
      if (result) applyImportResponse(result);
    } catch (error) {
      setBackupMessage(errorMessage(error));
    } finally {
      setBackupPending(false);
    }
  }, [applyImportResponse]);

  const continueBackupImport = useCallback(async () => {
    if (!importChallenge) return;
    setBackupPending(true);
    setBackupMessage(null);
    try {
      const result = await window.aiTerminal.backup.import({
        token: importChallenge.token,
        ...(importChallenge.challenge === 'passphrase-required'
          ? { passphrase: importPassphrase }
          : { confirmLegacyPlaintext: true }),
      });
      if (result) applyImportResponse(result);
    } catch (error) {
      setBackupMessage(errorMessage(error));
    } finally {
      setBackupPending(false);
    }
  }, [applyImportResponse, importChallenge, importPassphrase]);

  const dirty = Boolean(
    draft && settings && JSON.stringify(draft) !== JSON.stringify(settings),
  );
  const resolvedTheme = draft?.theme === 'system' ? systemTheme : (draft?.theme ?? 'dark');

  return (
    <div
      className="settings-shell app-shell"
      data-theme={resolvedTheme}
    >
      <header className="settings-header">
        <h1>设置</h1>
        <span className="settings-version">Glass Terminal{version ? ` · v${version}` : ''}</span>
      </header>

      <nav className="settings-nav">
        <button
          type="button"
          className={section === 'general' ? 'settings-nav-active' : ''}
          onClick={() => setSection('general')}
        >
          通用
        </button>
        <button
          type="button"
          className={section === 'ai' ? 'settings-nav-active' : ''}
          onClick={() => setSection('ai')}
        >
          AI 服务
        </button>
        <button
          type="button"
          className={section === 'data' ? 'settings-nav-active' : ''}
          onClick={() => setSection('data')}
        >
          数据
        </button>
      </nav>

      <main className="settings-body">
        {section === 'ai' && (
          <section className="settings-card settings-card-wide">
            <h2>AI 服务</h2>
            <AiServiceSettings />
          </section>
        )}

        {section === 'general' && draft && (
          <section className="settings-card">
            <h2>通用偏好</h2>

            <label className="settings-field">
              <span>主题</span>
              <select
                value={draft.theme}
                onChange={(event) => patchDraft({
                  theme: event.target.value as AppSettings['theme'],
                })}
              >
                <option value="dark">深色</option>
                <option value="light">亮色</option>
                <option value="system">跟随系统</option>
              </select>
            </label>

            <label className="settings-field">
              <span>终端日志保留（天，0 表示不限时间）</span>
              <input
                type="number"
                min={0}
                value={draft.logRetentionDays}
                onChange={(event) => patchDraft({
                  logRetentionDays: Math.max(0, Number(event.target.value) || 0),
                })}
              />
              <small>无论天数设置如何，每个会话仍保留 200 MiB 安全容量上限。</small>
            </label>

            <label className="settings-field">
              <span>Agent 自动检查点间隔（1-64 轮）</span>
              <input
                type="number"
                min={1}
                max={64}
                value={draft.defaultMaxRounds}
                onChange={(event) => patchDraft({
                  defaultMaxRounds: Math.min(64, Math.max(1, Number(event.target.value) || 1)),
                })}
              />
              <small>达到间隔后保存完整上下文并自动继续，不是任务总轮数上限。</small>
            </label>

            <div className="settings-actions">
              <button
                type="button"
                className="settings-primary"
                disabled={!dirty}
                onClick={() => void saveSettings()}
              >
                保存
              </button>
              {settingsMessage && <span className="settings-hint">{settingsMessage}</span>}
            </div>
          </section>
        )}

        {section === 'data' && (
          <section className="settings-card">
            <h2>数据导出与导入</h2>
            <p className="settings-description">
              导出默认只包含通用偏好与 Provider 配置，不包含 API Key。SSH 主机配置独立管理。
              如显式包含凭据，整个备份（包括内部文件名）都会使用口令加密。导入后需要重启应用生效。
            </p>

            <div className="settings-actions">
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={includeLogs}
                  onChange={(event) => setIncludeLogs(event.target.checked)}
                />
                <span>包含会话日志</span>
              </label>
              <label className="settings-check">
                <input
                  type="checkbox"
                  data-testid="backup-include-credentials"
                  checked={includeCredentials}
                  onChange={(event) => {
                    setIncludeCredentials(event.target.checked);
                    if (!event.target.checked) {
                      setExportPassphrase('');
                      setExportPassphraseConfirmation('');
                    }
                  }}
                />
                <span>包含 Provider API Key（必须整包加密）</span>
              </label>
            </div>

            {includeCredentials && (
              <div className="settings-backup-passphrases" data-testid="backup-passphrase-fields">
                <label className="settings-field">
                  <span>备份口令</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={exportPassphrase}
                    onChange={(event) => setExportPassphrase(event.target.value)}
                  />
                </label>
                <label className="settings-field">
                  <span>再次输入口令</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={exportPassphraseConfirmation}
                    onChange={(event) => setExportPassphraseConfirmation(event.target.value)}
                  />
                </label>
                <p className="settings-hint">口令不会保存；遗失后无法恢复加密备份。</p>
              </div>
            )}

            <div className="settings-actions">
              <button
                type="button"
                className="settings-primary"
                disabled={backupPending}
                onClick={() => void exportBackup()}
              >
                导出配置…
              </button>
              <button
                type="button"
                disabled={backupPending}
                onClick={() => void importBackup()}
              >
                导入配置…
              </button>
            </div>
            {backupMessage && <p className="settings-hint">{backupMessage}</p>}
          </section>
        )}
      </main>
      {importChallenge && (
        <div className="modal-backdrop" data-testid="backup-import-challenge">
          <section className="modal backup-import-modal" role="dialog" aria-modal="true">
            <h2>{importChallenge.challenge === 'passphrase-required'
              ? '解密备份'
              : '旧版明文备份风险确认'}</h2>
            <p>{importChallenge.message}</p>
            {importChallenge.challenge === 'passphrase-required' && (
              <label>
                <span>备份口令</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  autoFocus
                  value={importPassphrase}
                  onChange={(event) => setImportPassphrase(event.target.value)}
                />
              </label>
            )}
            <div className="modal-actions">
              <button
                type="button"
                disabled={backupPending}
                onClick={() => {
                  setImportChallenge(null);
                  setImportPassphrase('');
                }}
              >取消</button>
              <button
                type="button"
                className="danger-action"
                disabled={
                  backupPending
                  || (
                    importChallenge.challenge === 'passphrase-required'
                    && !importPassphrase
                  )
                }
                onClick={() => void continueBackupImport()}
              >{importChallenge.challenge === 'passphrase-required' ? '解密并导入' : '确认风险并导入'}</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
