import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { ProviderInput, ProviderProfile } from '../shared/provider';
import {
  DEFAULT_CONTEXT_ESTIMATE_SAFETY_FACTOR,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  MAX_CONTEXT_ESTIMATE_SAFETY_FACTOR,
  MAX_CONTEXT_WINDOW_TOKENS,
  MIN_CONTEXT_ESTIMATE_SAFETY_FACTOR,
  MIN_CONTEXT_WINDOW_TOKENS,
} from '../shared/context-window';
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
import { providerStatusLabel } from './ui-text';

interface ProviderDiscoveryMessage {
  tone: 'loading' | 'success' | 'error';
  text: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AiServiceSettings() {
  const [providers, setProviders] = useState<ProviderProfile[]>([]);
  const [editingProvider, setEditingProvider] = useState<ProviderProfile | null>(null);
  const [providerEditorOpen, setProviderEditorOpen] = useState(false);
  const [providerMessage, setProviderMessage] = useState<string | null>(null);
  const [providerDraftRevision, setProviderDraftRevision] = useState(0);
  const [providerTemplateId, setProviderTemplateId] = useState<ProviderTemplate['id']>('openai');
  const [providerModelOptions, setProviderModelOptions] = useState<string[]>(
    [...PROVIDER_TEMPLATES[0]!.suggestedModels],
  );
  const [providerModelOptionSource, setProviderModelOptionSource] =
    useState<ProviderModelOptionSource>('suggested');
  const [providerDiscoveryMessage, setProviderDiscoveryMessage] =
    useState<ProviderDiscoveryMessage | null>(null);
  const [providerSavePending, setProviderSavePending] = useState(false);

  const providerNameInputRef = useRef<HTMLInputElement>(null);
  const providerBaseUrlInputRef = useRef<HTMLInputElement>(null);
  const providerModelInputRef = useRef<HTMLInputElement>(null);
  const providerApiKeyInputRef = useRef<HTMLInputElement>(null);
  const providerDiscoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const providerDiscoveryGenerationRef = useRef(0);

  useEffect(() => {
    let alive = true;
    void window.aiTerminal.providers.list().then((next) => {
      if (!alive) return;
      setProviders(next);
    }).catch(() => undefined);
    const removeListener = window.aiTerminal.providers.onChanged((next) => {
      if (!alive) return;
      setProviders(next);
      setEditingProvider((current) => (
        current ? next.find((provider) => provider.id === current.id) ?? null : current
      ));
    });
    return () => {
      alive = false;
      removeListener();
    };
  }, []);

  useEffect(() => {
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
  }, [editingProvider?.id, editingProvider?.updatedAt]);

  useEffect(() => cancelPendingProviderDiscovery, []);

  const selectedProviderTemplate = PROVIDER_TEMPLATES.find((template) => (
    template.id === providerTemplateId
  )) ?? PROVIDER_TEMPLATES[PROVIDER_TEMPLATES.length - 1]!;

  async function refreshProviders(preferredProviderId?: string) {
    const next = await window.aiTerminal.providers.list();
    setProviders(next);
    if (preferredProviderId) {
      setEditingProvider(next.find((provider) => provider.id === preferredProviderId) ?? null);
    }
    return next;
  }

  async function saveProvider(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (providerSavePending) return;
    cancelPendingProviderDiscovery();
    const form = event.currentTarget;
    const apiKeyInput = form.elements.namedItem('apiKey') as HTMLInputElement;
    const input: ProviderInput = {
      id: editingProvider?.id,
      name: (form.elements.namedItem('name') as HTMLInputElement).value,
      baseUrl: (form.elements.namedItem('baseUrl') as HTMLInputElement).value,
      modelId: (form.elements.namedItem('modelId') as HTMLInputElement).value,
      contextWindowTokens: Number(
        (form.elements.namedItem('contextWindowTokens') as HTMLInputElement).value,
      ),
      contextEstimateSafetyFactor: Number(
        (form.elements.namedItem('contextEstimateSafetyFactor') as HTMLInputElement).value,
      ),
      makeDefault: (form.elements.namedItem('makeDefault') as HTMLInputElement).checked,
    };
    if (apiKeyInput.value.trim()) input.apiKey = apiKeyInput.value.trim();
    setProviderSavePending(true);
    setProviderMessage('正在保存并测试连接…');
    try {
      const saved = await window.aiTerminal.providers.save(input);
      apiKeyInput.value = '';
      const result = await window.aiTerminal.providers.testConnection(saved.id);
      await refreshProviders(saved.id);
      setProviderMessage(result.ok
        ? '已保存并通过连接测试，右侧 AI 智能体现在可以使用。'
        : `已保存，但连接测试失败：${result.message}`);
    } catch (error) {
      setProviderMessage(errorMessage(error));
    } finally {
      delete input.apiKey;
      setProviderSavePending(false);
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
    const request: { baseUrl: string; apiKey?: string; providerId?: string } = {
      baseUrl: providerBaseUrlInputRef.current?.value.trim() ?? '',
    };
    if (providerApiKeyInputRef.current?.value.trim()) {
      request.apiKey = providerApiKeyInputRef.current.value.trim();
    } else if (editingProvider?.apiKeyConfigured) {
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
    setEditingProvider(provider);
    setProviderEditorOpen(true);
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
    setProviderEditorOpen(true);
    setProviderDraftRevision((current) => current + 1);
    setProviderMessage(null);
  }

  async function removeProvider(provider: ProviderProfile) {
    if (!window.confirm(`确定删除 Provider“${provider.name}”及其已保存的凭据吗？`)) return;
    await window.aiTerminal.providers.remove(provider.id);
    await refreshProviders();
    setEditingProvider(null);
    setProviderEditorOpen(false);
  }

  return (
    <div className="ai-service-settings">
      <section className="provider-service-note generic-provider-note">
        <strong>OpenAI 兼容 API</strong>
        <p>保存时会自动检测 Base URL、API Key 和模型；检测成功后，右侧 AI 智能体立即可用。</p>
      </section>
      <div className={`provider-layout ${providerEditorOpen ? '' : 'editor-closed'}`}>
        <div className="provider-list">
          {providers.map((provider) => (
            <button
              type="button"
              className={editingProvider?.id === provider.id ? 'active' : ''}
              key={provider.id}
              onClick={() => editProvider(provider)}
            >
              <strong>{provider.name}</strong>
              <small>{provider.modelId}</small>
              <span className={`provider-status ${provider.status}`}>
                {providerStatusLabel(provider.status)}
              </span>
            </button>
          ))}
          <button type="button" className="add-provider" onClick={addProvider}>
            ＋ 添加 Provider
          </button>
        </div>
        {providerEditorOpen && <form
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
            模型
            <div className="provider-model-field">
              <input
                ref={providerModelInputRef}
                name="modelId"
                list="provider-model-options"
                required
                placeholder="选择可用模型或手动输入模型 ID"
                defaultValue={editingProvider?.modelId
                  ?? selectedProviderTemplate.suggestedModels[0]
                  ?? ''}
              />
              <datalist id="provider-model-options" data-testid="provider-model-options">
                {providerModelOptions.map((model) => (
                  <option data-provider-model value={model} key={model} />
                ))}
              </datalist>
              <button
                type="button"
                onClick={() => scheduleProviderModelDiscovery(0)}
              >检索模型</button>
            </div>
          </label>
          <small className="provider-field-note" data-testid="provider-model-prompt">
            {providerModelOptionPrompt(providerModelOptionSource, providerModelOptions.length)}；也可直接输入模型 ID。
          </small>
          <label>
            上下文窗口（tokens）
            <input
              name="contextWindowTokens"
              type="number"
              min={MIN_CONTEXT_WINDOW_TOKENS}
              max={MAX_CONTEXT_WINDOW_TOKENS}
              step={1_024}
              required
              defaultValue={editingProvider?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS}
              aria-describedby="provider-context-window-note"
            />
          </label>
          <small id="provider-context-window-note" className="provider-field-note">
            默认 500,736；数值按 1,024 tokens 对齐，到达 85% 安全阈值时自动压缩旧上下文。
          </small>
          <label>
            估算安全系数
            <input
              name="contextEstimateSafetyFactor"
              type="number"
              min={MIN_CONTEXT_ESTIMATE_SAFETY_FACTOR}
              max={MAX_CONTEXT_ESTIMATE_SAFETY_FACTOR}
              step={0.05}
              required
              defaultValue={editingProvider?.contextEstimateSafetyFactor
                ?? DEFAULT_CONTEXT_ESTIMATE_SAFETY_FACTOR}
              aria-describedby="provider-context-safety-note"
            />
          </label>
          <small id="provider-context-safety-note" className="provider-field-note">
            默认 1.15，为消息、工具 Schema 和请求包装统一预留估算余量。
          </small>
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
            <input
              name="makeDefault"
              type="checkbox"
              defaultChecked={editingProvider?.isDefault ?? providers.length === 0}
            />
            设为默认 Provider
          </label>
          <p className="secure-note">API Key 保存到本机密钥库；Provider JSON 只保存凭据引用。</p>
          {providerDiscoveryMessage && (
            <div
              className={`provider-discovery-message ${providerDiscoveryMessage.tone}`}
              role="status"
            >{providerDiscoveryMessage.text}</div>
          )}
          {providerMessage && <div className="provider-message" role="status">{providerMessage}</div>}
          <div className="provider-actions">
            {editingProvider && (
              <>
                {!editingProvider.isDefault && (
                  <button type="button" onClick={async () => {
                    await window.aiTerminal.providers.setDefault(editingProvider.id);
                    await refreshProviders(editingProvider.id);
                  }}>设为默认</button>
                )}
                <button
                  className="danger-text"
                  type="button"
                  onClick={() => void removeProvider(editingProvider)}
                >删除</button>
              </>
            )}
            <button className="primary" type="submit" disabled={providerSavePending}>
              {providerSavePending ? '保存并检测中…' : '保存 Provider'}
            </button>
          </div>
        </form>}
      </div>
    </div>
  );
}
