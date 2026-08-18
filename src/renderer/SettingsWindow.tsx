import { useCallback, useEffect, useState } from 'react';
import type { AppSettings } from '../shared/settings';
import { AiServiceSettings } from './AiServiceSettings';

type SettingsSection = 'general' | 'ai' | 'data';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function SettingsWindow() {
  const [section, setSection] = useState<SettingsSection>('general');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const [backupPending, setBackupPending] = useState(false);
  const [includeLogs, setIncludeLogs] = useState(false);
  const [version, setVersion] = useState('');

  useEffect(() => {
    void window.aiTerminal.settings.get().then((next) => {
      setSettings(next);
      setDraft(next);
    }).catch((error) => setSettingsMessage(errorMessage(error)));
    void window.aiTerminal.runtime.getInfo().then((info) => setVersion(info.version));
  }, []);

  const patchDraft = useCallback((patch: Partial<AppSettings>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }, []);

  const saveSettings = useCallback(async () => {
    if (!draft) return;
    setSettingsMessage(null);
    try {
      const saved = await window.aiTerminal.settings.update({
        theme: draft.theme,
        language: draft.language,
        logRetentionDays: draft.logRetentionDays,
        defaultMaxRounds: draft.defaultMaxRounds,
      });
      setSettings(saved);
      setDraft(saved);
      setSettingsMessage('已保存。');
    } catch (error) {
      setSettingsMessage(errorMessage(error));
    }
  }, [draft]);

  const exportBackup = useCallback(async () => {
    setBackupPending(true);
    setBackupMessage(null);
    try {
      const result = await window.aiTerminal.backup.export({ includeLogs });
      if (result) {
        setBackupMessage(`已导出 ${result.sections.length} 个分区（${result.bytes} 字节）。`);
      }
    } catch (error) {
      setBackupMessage(errorMessage(error));
    } finally {
      setBackupPending(false);
    }
  }, [includeLogs]);

  const importBackup = useCallback(async () => {
    setBackupPending(true);
    setBackupMessage(null);
    try {
      const result = await window.aiTerminal.backup.import();
      if (result) {
        const skipped = result.sectionsSkipped.length
          ? `，跳过 ${result.sectionsSkipped.length} 个分区`
          : '';
        setBackupMessage(
          result.needsRestart
            ? `已导入 ${result.sectionsImported.length} 个分区${skipped}。重启后生效。`
            : `已导入 ${result.sectionsImported.length} 个分区${skipped}。`,
        );
      }
    } catch (error) {
      setBackupMessage(errorMessage(error));
    } finally {
      setBackupPending(false);
    }
  }, []);

  const dirty = Boolean(
    draft && settings && JSON.stringify(draft) !== JSON.stringify(settings),
  );

  return (
    <div className="settings-shell">
      <header className="settings-header">
        <h1>设置</h1>
        <span className="settings-version">AI Terminal{version ? ` · v${version}` : ''}</span>
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
                <option value="light">浅色</option>
                <option value="system">跟随系统</option>
              </select>
            </label>

            <label className="settings-field">
              <span>语言</span>
              <select
                value={draft.language}
                onChange={(event) => patchDraft({
                  language: event.target.value as AppSettings['language'],
                })}
              >
                <option value="zh-CN">简体中文</option>
                <option value="en">English</option>
              </select>
            </label>

            <label className="settings-field">
              <span>日志保留（天，0 表示永久）</span>
              <input
                type="number"
                min={0}
                value={draft.logRetentionDays}
                onChange={(event) => patchDraft({
                  logRetentionDays: Math.max(0, Number(event.target.value) || 0),
                })}
              />
            </label>

            <label className="settings-field">
              <span>Agent 单轮最大轮数（1-64）</span>
              <input
                type="number"
                min={1}
                max={64}
                value={draft.defaultMaxRounds}
                onChange={(event) => patchDraft({
                  defaultMaxRounds: Math.min(64, Math.max(1, Number(event.target.value) || 1)),
                })}
              />
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
              导出将生成一个可移植的备份文件，包含通用偏好、Provider 配置与 Provider
              API Key。SSH 主机配置独立管理，不包含在通用备份中。导入后需要重启应用生效。
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
            </div>

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
    </div>
  );
}
