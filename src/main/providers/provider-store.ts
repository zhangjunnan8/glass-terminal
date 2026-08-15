import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  ProviderConnectionResult,
  ProviderInput,
  ProviderModelDiscoveryInput,
  ProviderModelDiscoveryResult,
  ProviderProfile,
} from '../../shared/provider';
import type { SecretStore } from './secret-store';

type FetchImplementation = typeof fetch;
const MAX_MODELS_RESPONSE_BYTES = 1024 * 1024;
const MAX_DISCOVERED_MODELS = 500;
interface StoredProviderProfile extends ProviderProfile {
  apiKeyReference: string;
}

function publicProfile(profile: StoredProviderProfile): ProviderProfile {
  const { apiKeyReference: _reference, ...publicFields } = profile;
  return publicFields;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`请填写${field}。`);
  return value.trim();
}

function normalizedBaseUrl(value: unknown): string {
  const text = requiredText(value, 'Base URL').replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error('Base URL 必须是有效的绝对 URL。');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Base URL 必须使用 HTTP 或 HTTPS。');
  }
  const localHttp = url.hostname === 'localhost'
    || url.hostname === '127.0.0.1'
    || url.hostname === '[::1]';
  if (url.protocol === 'http:' && !localHttp) {
    throw new Error('远程 Provider URL 必须使用 HTTPS。');
  }
  if (url.username || url.password) throw new Error('Base URL 不得包含登录凭据。');
  if (url.search || url.hash) throw new Error('Base URL 不得包含查询参数或片段。');
  return url.toString().replace(/\/+$/, '');
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_MODELS_RESPONSE_BYTES) {
    throw new Error('Provider 返回的模型列表过大。');
  }
  const reader = response.body?.getReader();
  if (!reader) return JSON.parse(await response.text());
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > MAX_MODELS_RESPONSE_BYTES) {
        throw new Error('Provider 返回的模型列表过大。');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed; cancellation is best-effort cleanup.
    }
    reader.releaseLock();
  }
}

function modelIdsFromPayload(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Provider 返回了无效的模型列表。');
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new Error('Provider 返回了无效的模型列表。');
  const models = [...new Set(data.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const id = (item as { id?: unknown }).id;
    const normalizedId = typeof id === 'string' ? id.trim() : '';
    return normalizedId && normalizedId.length <= 256 ? [normalizedId] : [];
  }))]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, MAX_DISCOVERED_MODELS);
  if (models.length === 0) throw new Error('Provider 没有返回可用模型；你仍可手动输入模型 ID。');
  return models;
}

function parseProfiles(value: unknown): StoredProviderProfile[] {
  if (!Array.isArray(value)) throw new Error('Provider 元数据必须是数组。');
  return value.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('Provider 元数据无效。');
    const profile = item as Partial<StoredProviderProfile>;
    if (
      typeof profile.id !== 'string'
      || typeof profile.name !== 'string'
      || profile.kind !== 'generic-openai-compatible'
      || typeof profile.baseUrl !== 'string'
      || typeof profile.modelId !== 'string'
      || typeof profile.apiKeyReference !== 'string'
    ) {
      throw new Error('Provider 元数据格式不受支持。');
    }
    const status = profile.status === 'ready' || profile.status === 'error'
      ? profile.status
      : 'not-tested';
    return {
      id: profile.id,
      name: profile.name,
      kind: 'generic-openai-compatible',
      baseUrl: profile.baseUrl,
      modelId: profile.modelId,
      apiKeyReference: profile.apiKeyReference,
      apiKeyConfigured: profile.apiKeyConfigured === true,
      isDefault: profile.isDefault === true,
      status,
      lastTestedAt: typeof profile.lastTestedAt === 'string' ? profile.lastTestedAt : undefined,
      lastError: typeof profile.lastError === 'string' ? profile.lastError : undefined,
      createdAt: typeof profile.createdAt === 'string' ? profile.createdAt : new Date(0).toISOString(),
      updatedAt: typeof profile.updatedAt === 'string' ? profile.updatedAt : new Date(0).toISOString(),
    };
  });
}

export class ProviderStore {
  private profiles: StoredProviderProfile[];

  constructor(
    private readonly filePath: string,
    private readonly secrets: SecretStore,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {
    this.profiles = this.read();
  }

  list(): ProviderProfile[] {
    return [...this.profiles].sort((left, right) => {
      if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
      return left.name.localeCompare(right.name);
    }).map(publicProfile);
  }

  get(providerId: string): ProviderProfile {
    return publicProfile(this.getStored(providerId));
  }

  async apiKey(providerId: string): Promise<string> {
    const provider = this.getStored(providerId);
    const secret = await this.secrets.get(provider.apiKeyReference);
    if (!secret) throw new Error(`${provider.name} 尚未配置 API Key。`);
    return secret;
  }

  async save(input: ProviderInput): Promise<ProviderProfile> {
    const now = new Date().toISOString();
    const existing = input.id
      ? this.profiles.find((profile) => profile.id === input.id)
      : undefined;
    if (input.id && !existing) throw new Error(`找不到 Provider：${input.id}`);
    const id = existing?.id ?? randomUUID();
    const baseUrl = normalizedBaseUrl(input.baseUrl);
    const modelId = requiredText(input.modelId, '模型 ID');
    const apiKeyReference = existing?.apiKeyReference ?? `AI Terminal/provider/${id}`;
    let apiKeyConfigured = existing?.apiKeyConfigured ?? false;
    const suppliedKey = input.apiKey && input.apiKey.trim() ? input.apiKey : undefined;
    const keyReplaced = Boolean(suppliedKey);
    if (suppliedKey) {
      await this.secrets.set(apiKeyReference, suppliedKey);
      apiKeyConfigured = true;
    }
    const endpointChanged = existing
      && (existing.baseUrl !== baseUrl || existing.modelId !== modelId);
    const makeDefault = Boolean(input.makeDefault)
      || this.profiles.length === 0
      || existing?.isDefault === true;
    const profile: StoredProviderProfile = {
      id,
      name: requiredText(input.name, 'Provider 名称'),
      kind: 'generic-openai-compatible',
      baseUrl,
      modelId,
      apiKeyReference,
      apiKeyConfigured,
      isDefault: makeDefault,
      status: endpointChanged || keyReplaced ? 'not-tested' : existing?.status ?? 'not-tested',
      lastTestedAt: endpointChanged || keyReplaced ? undefined : existing?.lastTestedAt,
      lastError: endpointChanged || keyReplaced ? undefined : existing?.lastError,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.profiles = this.profiles
      .filter((candidate) => candidate.id !== profile.id)
      .map((candidate) => makeDefault ? { ...candidate, isDefault: false } : candidate);
    this.profiles.push(profile);
    this.write();
    return publicProfile(profile);
  }

  async remove(providerId: string): Promise<void> {
    const provider = this.getStored(providerId);
    await this.secrets.remove(provider.apiKeyReference);
    const wasDefault = provider.isDefault;
    this.profiles = this.profiles.filter((candidate) => candidate.id !== providerId);
    if (wasDefault && this.profiles.length) this.profiles[0] = { ...this.profiles[0], isDefault: true };
    this.write();
  }

  setDefault(providerId: string): ProviderProfile {
    const selected = this.getStored(providerId);
    this.profiles = this.profiles.map((profile) => ({
      ...profile,
      isDefault: profile.id === providerId,
      updatedAt: profile.id === providerId ? new Date().toISOString() : profile.updatedAt,
    }));
    this.write();
    return this.get(selected.id);
  }

  async testConnection(providerId: string): Promise<ProviderConnectionResult> {
    const provider = this.get(providerId);
    const testedAt = new Date().toISOString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let result: ProviderConnectionResult;
    try {
      const apiKey = await this.apiKey(providerId);
      const response = await this.fetchImplementation(`${provider.baseUrl}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`Provider 返回 HTTP ${response.status}。`);
      const models = modelIdsFromPayload(await readBoundedJson(response));
      if (!models.includes(provider.modelId)) {
        throw new Error(`Provider 返回的模型列表中没有“${provider.modelId}”。`);
      }
      result = {
        ok: true,
        status: 'ready',
        message: '连接成功。',
        testedAt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = {
        ok: false,
        status: 'error',
        message: message.slice(0, 500),
        testedAt,
      };
    } finally {
      clearTimeout(timeout);
    }
    const current = this.getStored(providerId);
    const updated: StoredProviderProfile = {
      ...current,
      status: result.status,
      lastTestedAt: testedAt,
      lastError: result.ok ? undefined : result.message,
      updatedAt: testedAt,
    };
    this.profiles = this.profiles.map((candidate) => (
      candidate.id === providerId ? updated : candidate
    ));
    this.write();
    return result;
  }

  async discoverModels(
    input: ProviderModelDiscoveryInput,
  ): Promise<ProviderModelDiscoveryResult> {
    const baseUrl = normalizedBaseUrl(input.baseUrl);
    const suppliedKey = typeof input.apiKey === 'string' && input.apiKey.trim()
      ? input.apiKey
      : undefined;
    const apiKey = suppliedKey ?? (input.providerId ? await this.apiKey(input.providerId) : undefined);
    if (!apiKey) throw new Error('请先输入 API Key，再自动检索模型。');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.fetchImplementation(`${baseUrl}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`Provider 返回 HTTP ${response.status}。`);
      const models = modelIdsFromPayload(await readBoundedJson(response));
      return {
        models,
        // Keep the user-facing count derived from the exact bounded array sent
        // to the renderer; it must never describe hidden or discarded entries.
        message: `已检索到 ${models.length} 个可用模型。`,
      };
    } catch (error) {
      if (controller.signal.aborted) throw new Error('检索模型超时，请检查网络与 API 地址。');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private getStored(providerId: string): StoredProviderProfile {
    const provider = this.profiles.find((profile) => profile.id === providerId);
    if (!provider) throw new Error(`找不到 Provider：${providerId}`);
    return provider;
  }

  private read(): StoredProviderProfile[] {
    try {
      return parseProfiles(JSON.parse(readFileSync(this.filePath, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(`无法读取 Provider 存储：${(error as Error).message}`);
    }
  }

  private write(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    writeFileSync(temporaryPath, `${JSON.stringify(this.profiles, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporaryPath, this.filePath);
  }
}
