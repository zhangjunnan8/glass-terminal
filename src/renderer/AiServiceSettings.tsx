import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { CodexAppServerSnapshot, CodexModelInfo } from '../shared/codex-app-server';
import type { ProviderInput, ProviderProfile } from '../shared/provider';
import {
  PROVIDER_TEMPLATES,
  providerTemplateForBaseUrl,
} from '../shared/provider-templates';
import type { ProviderTemplate } from '../shared/provider-templates';
import {
  mergeProviderModelOptions,
  providerModelOptionPrompt,
  type ProviderModelOptionSource,
} from './provider-ui';
import {
  codexAppServerOperationLabel,
  codexAppServerPhaseLabel,
  codexPlanTypeLabel,
  codexReasoningEffortLabel,
  providerStatusLabel,
} from './ui-text';

type AiServiceSection = 'codex' | 'generic';

interface AiServiceMessage {
  tone: 'success' | 'error';
  text: string;
}

interface ProviderDiscoveryMessage {
  tone: 'loading' | 'success' | 'error';
  text: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mergeCodexAppServerState(
  current: CodexAppServerSnapshot | null,
  incoming: CodexAppServerSnapshot,
): CodexAppServerSnapshot {
  return current && current.revision >= incoming.revision ? current : incoming;
}

function preferredCodexReasoningEffort(
  model: CodexModelInfo,
  preferred?: string,
): string {
  const efforts = model.supportedReasoningEfforts;
  if (efforts.length === 0) return '';
  if (preferred && efforts.some((effort) => effort.reasoningEffort === preferred)) {
    return preferred;
  }
  if (
    model.defaultReasoningEffort
    && efforts.some((effort) => effort.reasoningEffort === model.defaultReasoningEffort)
  ) return model.defaultReasoningEffort;
  return efforts[0]?.reasoningEffort ?? '';
}

/**
 * Self-contained Provider + Codex App Server settings surface. It owns its own
 * state so it can run both inside the dedicated settings window and, during the
 * migration, inside the main window's legacy modal.
 */
export function AiServiceSettings() {
  const [section, setSection] = useState<AiServiceSection>('codex');
  const [providers, setProviders] = useState<ProviderProfile[]>([]);
  const [codexAppServer, setCodexAppServer] = useState<CodexAppServerSnapshot | null>(null);
  const [editingProvider, setEditingProvider] = useState<ProviderProfile | null>(null);
  const [providerMessage, setProviderMessage] = useState<string | null>(null);
  const [providerDraftRevision, setProviderDraftRevision] = useState(0);
  const [providerTemplateId, setProviderTemplateId] = useState<ProviderTemplate['id']>('openai');
  const [providerModelOptions, setProviderModelOptions] = useState<string[]>(
    [...PROVIDER_TEMPLATES[0]!.suggestedModels],
  );
  const [providerModelOptionSource, setProviderModelOptionSource] = useState<ProviderModelOptionSource>('suggested');
  const [providerDiscoveryMessage, setProviderDiscoveryMessage] = useState<ProviderDiscoveryMessage | null>(null);
  const [codexMessage, setCodexMessage] = useState<AiServiceMessage | null>(null);
  const [codexActionPending, setCodexActionPending] = useState(false);
  const [codexModelId, setCodexModelId] = useState('');
  const [codexReasoningEffort, setCodexReasoningEffort] = useState('');

  const codexActionLock = useRef(false);
  const providerNameInputRef = useRef<HTMLInputElement>(null);
  const providerBaseUrlInputRef = useRef<HTMLInputElement>(null);
  const providerModelInputRef = useRef<HTMLInputElement>(null);
  const providerApiKeyInputRef = useRef<HTMLInputElement>(null);
  const providerDiscoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const providerDiscoveryGenerationRef = useRef(0);

  useEffect(() => {
    void window.aiTerminal.providers.list().then(setProviders).catch(() => undefined);
    void window.aiTerminal.codexAppServer.getState().then((state) => {
      setCodexAppServer((current) => mergeCodexAppServerState(current, state));
    }).catch(() => undefined);
    const removeListener = window.aiTerminal.codexAppServer.onStateChanged((state) => {
      setCodexAppServer((current) => mergeCodexAppServerState(current, state));
    });
    return removeListener;
  }, []);

  useEffect(() => {
    if (!codexAppServer) return;
    const { models, selection } = codexAppServer;
    if (models.length === 0) {
      setCodexModelId('');
      setCodexReasoningEffort('');
      return;
    }
    const currentModel = models.find((model) => model.id === codexModelId);
    const selectedModel = models.find((model) => model.id === selection?.modelId);
    const nextModel = currentModel
      ?? selectedModel
      ?? models.find((model) => model.isDefault)
      ?? models[0];
    const preferredEffort = currentModel
      ? codexReasoningEffort
      : nextModel.id === selection?.modelId
        ? selection.reasoningEffort
        : undefined;
    const nextEffort = preferredCodexReasoningEffort(nextModel, preferredEffort);
    if (nextModel.id !== codexModelId) setCodexModelId(nextModel.id);
    if (nextEffort !== codexReasoningEffort) setCodexReasoningEffort(nextEffort);
  }, [codexAppServer?.revision]);

  useEffect(() => {
    if (section !== 'generic') {
      cancelPendingProviderDiscovery();
      return undefined;
    }
    const template = editingProvider
      ? providerTemplateForBaseUrl(editingProvider.baseUrl)
      : PROVIDER_TEMPLATES[0]!;
    setProviderTemplateId(template.id);
    setProviderModelOptions(mergeProviderModelOptions(
      template.suggestedModels,
      editingProvider ? [editingProvider.modelId] : undefined,
    ));
    setProviderModelOptionSource('suggested');
    setProviderDiscoveryMessage(null);
    if (editingProvider?.apiKeyConfigured) scheduleProviderModelDiscovery(250);
    return cancelPendingProviderDiscovery;
  }, [section, editingProvider?.id, editingProvider?.updatedAt]);

  useEffect(() => cancelPendingProviderDiscovery, []);

  const selectedProviderTemplate = PROVIDER_TEMPLATES.find((template) => (
    template.id === providerTemplateId
  )) ?? PROVIDER_TEMPLATES[PROVIDER_TEMPLATES.length - 1]!;
  const selectedCodexModel = codexAppServer?.models.find((model) => (
    model.id === codexModelId
  ));
  const codexBusy = codexActionPending
    || Boolean(codexAppServer && codexAppServer.operation !== 'idle');
  const savedCodexEffort = selectedCodexModel?.supportedReasoningEfforts.length
    ? codexAppServer?.selection?.reasoningEffort ?? ''
    : '';
  const draftCodexEffort = selectedCodexModel?.supportedReasoningEfforts.length
    ? codexReasoningEffort
    : '';
  const codexDraftMatchesSaved = Boolean(
    selectedCodexModel
    && codexAppServer?.selection?.modelId === codexModelId
    && savedCodexEffort === draftCodexEffort,
  );
  const codexSelectionSaved = Boolean(codexAppServer?.bound && codexDraftMatchesSaved);
  const codexSelectionDirty = Boolean(selectedCodexModel && !codexSelectionSaved);
  const codexOperationText = codexAppServer && codexAppServer.operation !== 'idle'
    ? codexAppServerOperationLabel(codexAppServer.operation)
    : codexActionPending
      ? '正在处理界面操作'
      : null;
  const codexTerminalContextAccess = codexAppServer?.terminalContextAccess;

  function applyCodexState(state: CodexAppServerSnapshot) {
    setCodexAppServer((current) => mergeCodexAppServerState(current, state));
  }

  async function runCodexAction(
    action: () => Promise<CodexAppServerSnapshot>,
    successMessage?: string,
  ) {
    if (codexActionLock.current) return;
    codexActionLock.current = true;
    setCodexActionPending(true);
    setCodexMessage(null);
    try {
      const state = await action();
      applyCodexState(state);
      if (state.error) {
        setCodexMessage({ tone: 'error', text: state.error });
      } else if (successMessage) {
        setCodexMessage({ tone: 'success', text: successMessage });
      }
    } catch (error) {
      setCodexMessage({ tone: 'error', text: errorMessage(error) });
    } finally {
      codexActionLock.current = false;
      setCodexActionPending(false);
    }
  }

  function selectCodexModel(modelId: string) {
    setCodexModelId(modelId);
    const model = codexAppServer?.models.find((candidate) => candidate.id === modelId);
    setCodexReasoningEffort(model ? preferredCodexReasoningEffort(model) : '');
  }

  async function saveCodexSelection() {
    if (!selectedCodexModel || !codexSelectionDirty) return;
    await runCodexAction(
      () => window.aiTerminal.codexAppServer.saveSelection({
        modelId: codexModelId,
        reasoningEffort: selectedCodexModel.supportedReasoningEfforts.length
          ? codexReasoningEffort || undefined
          : undefined,
      }),
      'App Server 首选模型已保存。',
    );
  }

  async function setCodexTerminalContextAccess(enabled: boolean) {
    await runCodexAction(
      () => window.aiTerminal.codexAppServer.setTerminalContextAccess({ enabled }),
      enabled
        ? '已允许 Codex 只读刷新当前终端状态并读取近期内容。'
        : '已关闭终端状态刷新与内容读取；每轮仍会提供非敏感的终端身份。',
    );
  }

  async function refreshProviders() {
    setProviders(await window.aiTerminal.providers.list());
  }

  async function saveProvider(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    cancelPendingProviderDiscovery();
    const form = event.currentTarget;
    const nameInput = form.elements.namedItem('name') as HTMLInputElement;
    const baseUrlInput = form.elements.namedItem('baseUrl') as HTMLInputElement;
    const modelInput = form.elements.namedItem('modelId') as HTMLInputElement;
    const apiKeyInput = form.elements.namedItem('apiKey') as HTMLInputElement;
    const makeDefaultInput = form.elements.namedItem('makeDefault') as HTMLInputElement;
    const input: ProviderInput = {
      id: editingProvider?.id,
      name: nameInput.value,
      baseUrl: baseUrlInput.value,
      modelId: modelInput.value,
      makeDefault: makeDefaultInput.checked,
    };
    if (apiKeyInput.value) input.apiKey = apiKeyInput.value;
    apiKeyInput.value = '';
    try {
      const saved = await window.aiTerminal.providers.save(input);
      await refreshProviders();
      setEditingProvider(saved);
      setProviderMessage('已保存。请先测试连接，再使用此 Provider。');
    } catch (error) {
      setProviderMessage(errorMessage(error));
    } finally {
      delete input.apiKey;
    }
  }

  function cancelPendingProviderDiscovery() {
    providerDiscoveryGenerationRef.current += 1;
    if (providerDiscoveryTimerRef.current) {
      clearTimeout(providerDiscoveryTimerRef.current);
      providerDiscoveryTimerRef.current = null;
    }
  }

  function scheduleProviderModelDiscovery(delay = 650) {
    if (providerDiscoveryTimerRef.current) clearTimeout(providerDiscoveryTimerRef.current);
    const generation = ++providerDiscoveryGenerationRef.current;
    const hasTypedKey = Boolean(providerApiKeyInputRef.current?.value.trim());
    const canUseSavedKey = Boolean(editingProvider?.apiKeyConfigured);
    if (!hasTypedKey && !canUseSavedKey) {
      providerDiscoveryTimerRef.current = null;
      setProviderDiscoveryMessage(delay === 0
        ? { tone: 'error', text: '请先输入 API Key。' }
        : null);
      return;
    }
    setProviderDiscoveryMessage({
      tone: 'loading',
      text: delay > 0 ? '等待输入完成后自动检索模型…' : '正在检索可用模型…',
    });
    providerDiscoveryTimerRef.current = setTimeout(() => {
      providerDiscoveryTimerRef.current = null;
      void discoverProviderModels(generation);
    }, delay);
  }

  async function discoverProviderModels(generation = ++providerDiscoveryGenerationRef.current) {
    const baseUrl = providerBaseUrlInputRef.current?.value.trim() ?? '';
    const canUseSavedKey = Boolean(editingProvider?.apiKeyConfigured);
    const request: {
      baseUrl: string;
      apiKey?: string;
      providerId?: string;
    } = { baseUrl };
    if (providerApiKeyInputRef.current?.value.trim()) {
      request.apiKey = providerApiKeyInputRef.current.value.trim();
    } else if (canUseSavedKey && editingProvider) {
      request.providerId = editingProvider.id;
    }
    if (!request.apiKey && !request.providerId) {
      setProviderDiscoveryMessage({ tone: 'error', text: '请先输入 API Key。' });
      return;
    }
    setProviderDiscoveryMessage({ tone: 'loading', text: '正在检索可用模型…' });
    try {
      const result = await window.aiTerminal.providers.discoverModels(request);
      if (providerDiscoveryGenerationRef.current !== generation) return;
      const models = mergeProviderModelOptions(result.models);
      setProviderModelOptions(models);
      setProviderModelOptionSource('discovered');
      if (providerModelInputRef.current && !providerModelInputRef.current.value.trim()) {
        providerModelInputRef.current.value = models[0] ?? '';
      }
      setProviderDiscoveryMessage({ tone: 'success', text: result.message });
    } catch (error) {
      if (providerDiscoveryGenerationRef.current !== generation) return;
      setProviderDiscoveryMessage({
        tone: 'error',
        text: `${errorMessage(error)} 你仍可手动输入模型 ID。`,
      });
    } finally {
      delete request.apiKey;
    }
  }

  function selectProviderTemplate(templateId: ProviderTemplate['id']) {
    cancelPendingProviderDiscovery();
    const template = PROVIDER_TEMPLATES.find((candidate) => candidate.id === templateId)
      ?? PROVIDER_TEMPLATES[PROVIDER_TEMPLATES.length - 1]!;
    setProviderTemplateId(template.id);
    setProviderDiscoveryMessage(null);
    setProviderModelOptions([...template.suggestedModels]);
    setProviderModelOptionSource('suggested');
    if (providerNameInputRef.current) providerNameInputRef.current.value = template.name;
    if (providerBaseUrlInputRef.current) providerBaseUrlInputRef.current.value = template.baseUrl;
    if (providerModelInputRef.current) {
      providerModelInputRef.current.value = template.suggestedModels[0] ?? '';
    }
    scheduleProviderModelDiscovery(250);
  }

  function editProvider(provider: ProviderProfile) {
    cancelPendingProviderDiscovery();
    const template = providerTemplateForBaseUrl(provider.baseUrl);
    setProviderTemplateId(template.id);
    setProviderModelOptions(mergeProviderModelOptions(
      template.suggestedModels,
      [provider.modelId],
    ));
    setProviderModelOptionSource('suggested');
    setProviderDiscoveryMessage(null);
    setEditingProvider(provider);
    setProviderDraftRevision((current) => current + 1);
    setProviderMessage(null);
  }

  function addProvider() {
    cancelPendingProviderDiscovery();
    const template = PROVIDER_TEMPLATES[0]!;
    setProviderTemplateId(template.id);
    setProviderModelOptions([...template.suggestedModels]);
    setProviderModelOptionSource('suggested');
    setProviderDiscoveryMessage(null);
    setEditingProvider(null);
    setProviderDraftRevision((current) => current + 1);
    setProviderMessage(null);
  }

  async function testProvider(providerId: string) {
    setProviderMessage('正在测试连接…');
    try {
      const result = await window.aiTerminal.providers.testConnection(providerId);
      await refreshProviders();
      setProviderMessage(result.message);
    } catch (error) {
      setProviderMessage(errorMessage(error));
    }
  }

  async function removeProvider(provider: ProviderProfile) {
    if (!window.confirm(`确定删除 Provider“${provider.name}”及其已保存的凭据吗？`)) return;
    await window.aiTerminal.providers.remove(provider.id);
    setEditingProvider(null);
    await refreshProviders();
  }

  return (
    <div className="ai-service-settings">
      <div className="provider-kind-tabs" role="tablist" aria-label="AI 服务类型">
        <button
          id="provider-kind-codex"
          type="button"
          className={section === 'codex' ? 'active' : ''}
          data-testid="provider-kind-codex"
          onClick={() => {
            setSection('codex');
            setCodexMessage(null);
          }}
          role="tab"
          aria-selected={section === 'codex'}
          aria-controls="provider-panel-codex"
        >Codex App Server</button>
        <button
          id="provider-kind-generic"
          type="button"
          className={section === 'generic' ? 'active' : ''}
          data-testid="provider-kind-generic"
          onClick={() => {
            setSection('generic');
            setCodexMessage(null);
          }}
          role="tab"
          aria-selected={section === 'generic'}
          aria-controls="provider-panel-generic"
        >OpenAI 兼容 API</button>
      </div>

      {section === 'codex' && codexMessage && (
        <div
          className={`provider-message codex-ui-message ${codexMessage.tone}`}
          role={codexMessage.tone === 'error' ? 'alert' : 'status'}
          aria-live={codexMessage.tone === 'error' ? 'assertive' : 'polite'}
        >{codexMessage.text}</div>
      )}

      {section === 'codex' && (
        <div
          id="provider-panel-codex"
          className="codex-app-server-panel"
          data-testid="codex-app-server-panel"
          role="tabpanel"
          aria-labelledby="provider-kind-codex"
          aria-busy={codexBusy}
        >
          <section className="codex-setup-section">
            <div className="codex-section-heading">
              <span>1</span>
              <div><strong>App Server 服务</strong><small>由主进程启动官方 codex app-server，不解析命令行界面。</small></div>
            </div>
            <div
              className="codex-status-row"
              data-testid="codex-service-status"
              role="status"
              aria-live="polite"
            >
              <div>
                <span
                  className={`codex-state-dot ${codexAppServer?.phase ?? 'stopped'}`}
                  aria-hidden="true"
                />
                <span className="codex-status-copy">
                  <strong>{codexAppServer
                    ? codexAppServerPhaseLabel(codexAppServer.phase)
                    : '正在读取状态'}</strong>
                  {codexOperationText && <small>{codexOperationText}…</small>}
                </span>
              </div>
              {codexAppServer?.executable && (
                <small className="codex-status-version">{codexAppServer.executable.version}</small>
              )}
            </div>
            {codexAppServer?.executable && (
              <code className="codex-executable-path" title={codexAppServer.executable.path}>
                {codexAppServer.executable.path}
              </code>
            )}
            <div className="codex-actions">
              {codexAppServer?.phase !== 'ready' ? (
                <button
                  className="primary"
                  data-action="codex-start"
                  disabled={codexBusy}
                  onClick={() => void runCodexAction(
                    () => window.aiTerminal.codexAppServer.start(),
                  )}
                >自动检测并启动</button>
              ) : (
                <>
                  <button
                    data-action="codex-refresh"
                    disabled={codexBusy}
                    onClick={() => void runCodexAction(
                      () => window.aiTerminal.codexAppServer.refresh(),
                      '账号与模型状态已刷新。',
                    )}
                  >刷新状态</button>
                  <button
                    data-action="codex-restart"
                    disabled={codexBusy}
                    onClick={() => void runCodexAction(
                      () => window.aiTerminal.codexAppServer.restart(),
                    )}
                  >重启服务</button>
                </>
              )}
              <button
                data-action="codex-choose-executable"
                disabled={codexBusy}
                onClick={() => void runCodexAction(
                  () => window.aiTerminal.codexAppServer.chooseExecutable(),
                )}
              >选择 codex 可执行文件…</button>
            </div>
            {codexAppServer?.error && (
              <div className="codex-error" data-testid="codex-error" role="alert">
                {codexAppServer.error}
              </div>
            )}
          </section>

          <section className="codex-setup-section">
            <div className="codex-section-heading">
              <span>2</span>
              <div><strong>ChatGPT 账号</strong><small>登录和 token 刷新由 App Server 管理；AI Terminal 不读取或保存 token。</small></div>
            </div>
            {codexAppServer?.phase !== 'ready' && (
              <p className="codex-empty-state">启动服务后即可在这里完成登录。</p>
            )}
            {codexAppServer?.phase === 'ready' && codexAppServer.pendingLogin && (
              <div
                className="codex-login-pending"
                data-testid="codex-login-pending"
                role="status"
                aria-live="polite"
              >
                <strong>{codexAppServer.pendingLogin.type === 'browser'
                  ? '等待浏览器完成 ChatGPT 登录'
                  : '使用设备码完成登录'}</strong>
                {codexAppServer.pendingLogin.type === 'device-code' && (
                  <div className="codex-device-code" data-testid="codex-device-code">
                    {codexAppServer.pendingLogin.userCode}
                  </div>
                )}
                <p>完成授权后，本页会自动刷新账号和模型，无需粘贴任何凭据。</p>
                <div className="codex-actions">
                  <button
                    className="primary"
                    data-action="codex-open-auth"
                    disabled={codexBusy}
                    onClick={() => void runCodexAction(
                      () => window.aiTerminal.codexAppServer.reopenLogin(),
                    )}
                  >{codexAppServer.pendingLogin.type === 'browser'
                      ? '重新打开登录页'
                      : '打开验证页面'}</button>
                  <button
                    data-action="codex-cancel-login"
                    disabled={codexBusy}
                    onClick={() => void runCodexAction(
                      () => window.aiTerminal.codexAppServer.cancelLogin(),
                    )}
                  >取消登录</button>
                </div>
              </div>
            )}
            {codexAppServer?.phase === 'ready'
              && !codexAppServer.pendingLogin
              && codexAppServer.account && (
              <div className="codex-account-card" data-testid="codex-account-status">
                <div>
                  <strong>{codexAppServer.account.email ?? '已登录账号'}</strong>
                  <span>{codexAppServer.account.type === 'chatgpt' ? 'ChatGPT' : codexAppServer.account.type}
                    {codexAppServer.account.planType
                      ? ` · ${codexPlanTypeLabel(codexAppServer.account.planType)}`
                      : ''}</span>
                </div>
                <button
                  className="danger-text"
                  data-action="codex-logout"
                  disabled={codexBusy}
                  onClick={() => void runCodexAction(
                    () => window.aiTerminal.codexAppServer.logout(),
                    '已退出 App Server 账号。',
                  )}
                >退出登录</button>
              </div>
            )}
            {codexAppServer?.phase === 'ready'
              && !codexAppServer.pendingLogin
              && !codexAppServer.account
              && codexAppServer.requiresOpenaiAuth === true && (
              <div className="codex-login-options" data-testid="codex-account-status">
                <p>尚未登录。请选择一种完全由界面引导的方式：</p>
                <div className="codex-actions">
                  <button
                    className="primary"
                    data-action="codex-login-browser"
                    disabled={codexBusy}
                    onClick={() => void runCodexAction(
                      () => window.aiTerminal.codexAppServer.loginBrowser(),
                    )}
                  >使用 ChatGPT 登录</button>
                  <button
                    data-action="codex-login-device"
                    disabled={codexBusy}
                    onClick={() => void runCodexAction(
                      () => window.aiTerminal.codexAppServer.loginDeviceCode(),
                    )}
                  >使用设备码登录</button>
                </div>
              </div>
            )}
            {codexAppServer?.phase === 'ready'
              && !codexAppServer.account
              && codexAppServer.requiresOpenaiAuth === false && (
              <div className="codex-account-card" data-testid="codex-account-status">
                <div><strong>当前配置无需 OpenAI 登录</strong><span>App Server 报告可直接使用当前模型提供方。</span></div>
              </div>
            )}
            {codexAppServer?.phase === 'ready'
              && !codexAppServer.pendingLogin
              && !codexAppServer.account
              && codexAppServer.requiresOpenaiAuth === undefined && (
              <p className="codex-empty-state">
                账号状态尚未加载。请刷新状态；若持续失败，请重启服务。
              </p>
            )}
          </section>

          <section className="codex-setup-section">
            <div className="codex-section-heading">
              <span>3</span>
              <div>
                <strong>模型与首选项</strong>
                <small>模型来自当前 App Server；保存后可供原生 Codex 后端使用，并在下次启动时恢复。</small>
              </div>
            </div>
            {codexAppServer?.models.length ? (
              <div className="codex-model-grid">
                <label>模型
                  <select
                    data-testid="codex-model-select"
                    value={codexModelId}
                    onChange={(event) => selectCodexModel(event.target.value)}
                    disabled={codexBusy}
                  >
                    {codexAppServer.models.map((model) => (
                      <option key={model.id} value={model.id}>{model.displayName}</option>
                    ))}
                  </select>
                </label>
                <label>推理强度
                  <select
                    data-testid="codex-effort-select"
                    value={codexReasoningEffort}
                    onChange={(event) => setCodexReasoningEffort(event.target.value)}
                    disabled={codexBusy || !selectedCodexModel?.supportedReasoningEfforts.length}
                  >
                    {!selectedCodexModel?.supportedReasoningEfforts.length && (
                      <option value="">使用模型默认值</option>
                    )}
                    {selectedCodexModel?.supportedReasoningEfforts.map((effort) => (
                      <option key={effort.reasoningEffort} value={effort.reasoningEffort}>
                        {codexReasoningEffortLabel(effort.reasoningEffort)}
                        {effort.description ? ` · ${effort.description}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="primary codex-bind"
                  data-action="codex-bind"
                  disabled={codexBusy || !selectedCodexModel || !codexSelectionDirty}
                  onClick={() => void saveCodexSelection()}
                >保存 App Server 首选模型</button>
                {codexSelectionSaved && (
                  <span className="codex-bound-badge" role="status">当前选择已保存</span>
                )}
                {codexSelectionDirty && (
                  <span className="codex-dirty-badge" role="status">有未保存更改</span>
                )}
              </div>
            ) : (
              <p className="codex-empty-state">{codexAppServer?.phase !== 'ready'
                ? '服务就绪后将在这里显示可选模型。'
                : codexAppServer.requiresOpenaiAuth === true && !codexAppServer.account
                  ? '登录完成后将自动加载可选模型。'
                  : codexAppServer.requiresOpenaiAuth === undefined
                    ? '模型状态尚未加载。请刷新状态。'
                    : 'App Server 当前没有返回可选模型。请刷新状态或检查 Codex 配置。'}</p>
            )}
          </section>

          <section
            className={`codex-setup-section codex-terminal-context-card ${
              codexTerminalContextAccess?.enabled ? 'enabled' : 'disabled'
            }`}
            data-testid="codex-terminal-context-card"
            data-context-enabled={codexTerminalContextAccess?.enabled ? 'true' : 'false'}
          >
            <div className="codex-section-heading">
              <span>4</span>
              <div>
                <strong>允许 AI 读取当前终端内容</strong>
                <small>这是可选的只读上下文权限；它不决定 Codex 原生后端是否可用。</small>
              </div>
            </div>
            <div
              className="codex-agent-availability"
              data-testid="codex-terminal-context-status"
              data-context-state={!codexTerminalContextAccess?.available
                ? 'unavailable'
                : codexTerminalContextAccess.enabled ? 'enabled' : 'disabled'}
              role="status"
              aria-live="polite"
            >
              <span className="codex-agent-state-dot" aria-hidden="true" />
              <span>
                <strong>{!codexTerminalContextAccess
                  ? '正在读取状态'
                  : !codexTerminalContextAccess.available
                    ? '当前不可用'
                    : codexTerminalContextAccess.enabled
                      ? '已允许只读访问'
                      : '未允许读取'}</strong>
                <small>{codexTerminalContextAccess?.reason
                  ?? '正在读取终端上下文权限。'}</small>
              </span>
            </div>

            <div
              id="codex-terminal-context-description"
              className="codex-safety-boundary codex-agent-boundary codex-native-boundary"
              data-testid="codex-native-boundary"
            >
              <strong>Codex 原生模式与当前终端相互独立</strong>
              <p>
                Codex 的内建 <code>Shell</code>/<code>File</code> 工具在 AI Terminal
                为它分配的应用独立工作区内执行，不会进入当前 SSH 或本地 Shell。
              </p>
              <ul>
                <li>当前终端始终由你控制；Codex 原生模式不提供任何终端控制功能。</li>
                <li>AI Terminal 每轮都会提供当前终端的类型、目标、目录、有效用户和 Shell；不包含密码或凭据引用。</li>
                <li>开启这个开关会额外提供 <code>terminal_state</code> 和 <code>terminal_read</code>，用于只读刷新状态和读取近期文本；不能向终端写入或执行命令。</li>
                <li>关闭后，Codex 仍知道每轮开始时绑定的终端身份，并可在自己的独立工作区中工作。</li>
              </ul>
            </div>

            <label className="codex-context-toggle">
              <input
                type="checkbox"
                data-testid="codex-terminal-context-toggle"
                checked={codexTerminalContextAccess?.enabled === true}
                disabled={codexBusy || !codexTerminalContextAccess?.available}
                aria-describedby="codex-terminal-context-description"
                onChange={(event) => void setCodexTerminalContextAccess(event.target.checked)}
              />
              <span className="codex-context-toggle-track" aria-hidden="true">
                <span />
              </span>
              <span className="codex-context-toggle-copy">
                <strong>{codexTerminalContextAccess?.enabled ? '允许读取' : '不允许读取'}</strong>
                <small>只读权限，不包含终端输入或控制能力。</small>
              </span>
            </label>
          </section>
        </div>
      )}

      {section === 'generic' && (
        <div
          id="provider-panel-generic"
          className="generic-provider-panel"
          role="tabpanel"
          aria-labelledby="provider-kind-generic"
        >
          <section className="codex-app-server-note generic-provider-note">
            <strong>OpenAI 兼容 API</strong>
            <p>“可用”表示 Base URL、API Key 与模型列表测试通过。请勿在 API Key 输入框中粘贴 ChatGPT 登录凭据。</p>
          </section>
          <div className="provider-layout">
            <div className="provider-list">
              {providers.map((provider) => (
                <button
                  className={editingProvider?.id === provider.id ? 'active' : ''}
                  key={provider.id}
                  onClick={() => editProvider(provider)}
                >
                  <strong>{provider.name}</strong>
                  <small>{provider.modelId}</small>
                  <span className={`provider-status ${provider.status}`}>{providerStatusLabel(provider.status)}</span>
                </button>
              ))}
              <button className="add-provider" onClick={addProvider}>＋ 添加 Provider</button>
            </div>
            <form
              className="provider-form"
              key={`provider-${editingProvider?.id ?? 'new'}-${providerDraftRevision}`}
              onSubmit={(event) => void saveProvider(event)}
            >
              <label>
                API 模板
                <select
                  name="template"
                  value={providerTemplateId}
                  onChange={(event) => selectProviderTemplate(
                    event.currentTarget.value as ProviderTemplate['id'],
                  )}
                >
                  {PROVIDER_TEMPLATES.map((template) => (
                    <option value={template.id} key={template.id}>{template.name}</option>
                  ))}
                </select>
              </label>
              <label>
                名称
                <input
                  ref={providerNameInputRef}
                  name="name"
                  required
                  defaultValue={editingProvider?.name ?? selectedProviderTemplate.name}
                />
              </label>
              <label>
                基础 URL
                <input
                  ref={providerBaseUrlInputRef}
                  name="baseUrl"
                  type="url"
                  required
                  readOnly={!selectedProviderTemplate.custom}
                  aria-describedby="provider-base-url-note"
                  placeholder="https://api.example.com/v1"
                  defaultValue={editingProvider?.baseUrl ?? selectedProviderTemplate.baseUrl}
                  onInput={() => scheduleProviderModelDiscovery()}
                />
              </label>
              <small id="provider-base-url-note" className="provider-field-note">
                {selectedProviderTemplate.custom
                  ? '自定义模板可编辑 Base URL；不要在 URL 中放入 API Key。'
                  : '内置模板已锁定官方 Base URL，只需输入 API Key。'}
              </small>
              <label>
                可用模型
                <select
                  key={`models-${providerModelOptions.join('\u0000')}`}
                  data-testid="provider-model-select"
                  defaultValue=""
                  onChange={(event) => {
                    const modelId = event.currentTarget.value;
                    if (modelId && providerModelInputRef.current) {
                      providerModelInputRef.current.value = modelId;
                    }
                  }}
                >
                  <option value="">{providerModelOptionPrompt(
                    providerModelOptionSource,
                    providerModelOptions.length,
                  )}</option>
                  {providerModelOptions.map((model) => (
                    <option data-provider-model value={model} key={model}>{model}</option>
                  ))}
                </select>
              </label>
              <label>
                模型 ID（可手动输入）
                <div className="provider-model-field">
                  <input
                    ref={providerModelInputRef}
                    name="modelId"
                    required
                    placeholder="从检索结果选择或手动输入"
                    defaultValue={editingProvider?.modelId
                      ?? selectedProviderTemplate.suggestedModels[0]
                      ?? ''}
                  />
                  <button
                    type="button"
                    disabled={providerDiscoveryMessage?.text === '正在检索可用模型…'}
                    onClick={() => scheduleProviderModelDiscovery(0)}
                  >检索模型</button>
                </div>
              </label>
              <label>
                API Key
                <input
                  ref={providerApiKeyInputRef}
                  name="apiKey"
                  type="password"
                  required={!editingProvider?.apiKeyConfigured}
                  autoComplete="new-password"
                  placeholder={editingProvider?.apiKeyConfigured ? '已保存到本机密钥库' : '必填'}
                  onInput={() => scheduleProviderModelDiscovery()}
                />
              </label>
              <label className="check-label">
                <input name="makeDefault" type="checkbox" defaultChecked={editingProvider?.isDefault ?? providers.length === 0} />
                设为默认 Provider
              </label>
              <p className="secure-note">API Key 保存到本机密钥库；Provider JSON 只保存凭据引用。</p>
              {providerDiscoveryMessage && (
                <div
                  className={`provider-discovery-message ${providerDiscoveryMessage.tone}`}
                  role="status"
                >{providerDiscoveryMessage.text}</div>
              )}
              {providerMessage && <div className="provider-message">{providerMessage}</div>}
              <div className="provider-actions">
                {editingProvider && (
                  <>
                    <button type="button" onClick={() => void testProvider(editingProvider.id)}>测试连接</button>
                    {!editingProvider.isDefault && (
                      <button type="button" onClick={async () => {
                        await window.aiTerminal.providers.setDefault(editingProvider.id);
                        await refreshProviders();
                      }}>设为默认</button>
                    )}
                    <button className="danger-text" type="button" onClick={() => void removeProvider(editingProvider)}>删除</button>
                  </>
                )}
                <button className="primary" type="submit">保存 Provider</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
