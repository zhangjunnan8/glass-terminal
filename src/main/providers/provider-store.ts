import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type {
  ProviderConnectionResult,
  ProviderInput,
  ProviderModelDiscoveryInput,
  ProviderModelDiscoveryResult,
  ProviderProfile,
} from '../../shared/provider';
import {
  MAX_CONTEXT_ESTIMATE_SAFETY_FACTOR,
  MAX_CONTEXT_WINDOW_TOKENS,
  MIN_CONTEXT_ESTIMATE_SAFETY_FACTOR,
  MIN_CONTEXT_WINDOW_TOKENS,
  normalizedContextEstimateSafetyFactor,
  normalizedContextWindowTokens,
} from '../../shared/context-window';
import { PROVIDER_SECRET_PREFIX } from '../../shared/backup';
import { isAllowedCredentialReference, type SecretStore } from './secret-store';

type FetchImplementation = typeof fetch;
const MAX_MODELS_RESPONSE_BYTES = 1024 * 1024;
const MAX_DISCOVERED_MODELS = 500;
interface StoredProviderProfile extends ProviderProfile {
  apiKeyReference: string;
  /** Durable private fence while the Credential Manager value is transitioning. */
  recipientTransitionPending: boolean;
}

export interface ProviderRuntimeSnapshot {
  profile: ProviderProfile;
  apiKey: string;
}

function legacyRecipientRevision(
  profile: Pick<StoredProviderProfile, 'id' | 'apiKeyReference' | 'createdAt'>,
): string {
  return createHash('sha256')
    .update(`legacy\0${profile.id}\0${profile.apiKeyReference}\0${profile.createdAt}`)
    .digest('hex');
}

function publicProfile(profile: StoredProviderProfile): ProviderProfile {
  const {
    apiKeyReference: _reference,
    recipientTransitionPending: _transitionPending,
    ...publicFields
  } = profile;
  return publicFields;
}

function providerTransitionError(): Error {
  return new Error('Provider recipient identity or credential is transitioning; retry after saving and testing it.');
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
    const recipientTransitionPending = profile.recipientTransitionPending === true;
    const status = !recipientTransitionPending
      && (profile.status === 'ready' || profile.status === 'error')
      ? profile.status
      : 'not-tested';
    const createdAt = typeof profile.createdAt === 'string'
      ? profile.createdAt
      : new Date(0).toISOString();
    return {
      id: profile.id,
      name: profile.name,
      kind: 'generic-openai-compatible',
      baseUrl: profile.baseUrl,
      modelId: profile.modelId,
      contextWindowTokens: normalizedContextWindowTokens(profile.contextWindowTokens),
      contextEstimateSafetyFactor: normalizedContextEstimateSafetyFactor(
        profile.contextEstimateSafetyFactor,
      ),
      apiKeyReference: profile.apiKeyReference,
      recipientTransitionPending,
      recipientRevision: typeof profile.recipientRevision === 'string'
        && profile.recipientRevision.length > 0
        && profile.recipientRevision.length <= 128
        ? profile.recipientRevision
        : legacyRecipientRevision({
          id: profile.id,
          apiKeyReference: profile.apiKeyReference,
          createdAt,
        }),
      apiKeyConfigured: profile.apiKeyConfigured === true,
      isDefault: profile.isDefault === true,
      status,
      lastTestedAt: typeof profile.lastTestedAt === 'string' ? profile.lastTestedAt : undefined,
      lastError: typeof profile.lastError === 'string' ? profile.lastError : undefined,
      createdAt,
      updatedAt: typeof profile.updatedAt === 'string' ? profile.updatedAt : new Date(0).toISOString(),
    };
  });
}

/** Strict validation used before a portable backup may replace live metadata. */
export function validateProviderBackupMetadata(value: unknown): ReadonlyMap<string, boolean> {
  const profiles = parseProfiles(value);
  const ids = new Set<string>();
  const references = new Map<string, boolean>();
  let defaults = 0;
  for (const profile of profiles) {
    requiredText(profile.id, 'Provider ID');
    requiredText(profile.name, 'Provider 名称');
    requiredText(profile.modelId, '模型 ID');
    normalizedBaseUrl(profile.baseUrl);
    if (ids.has(profile.id)) throw new Error(`Provider 元数据包含重复 id：${profile.id}`);
    ids.add(profile.id);
    if (
      profile.apiKeyReference !== `${PROVIDER_SECRET_PREFIX}${profile.id}`
      || !isAllowedCredentialReference(profile.apiKeyReference)
    ) throw new Error(`Provider ${profile.id} 的凭据引用无效。`);
    if (references.has(profile.apiKeyReference)) {
      throw new Error(`Provider 元数据重复使用凭据引用：${profile.apiKeyReference}`);
    }
    if (profile.recipientTransitionPending) {
      throw new Error(`Provider ${profile.id} 的凭据仍处于未完成的迁移状态。`);
    }
    references.set(profile.apiKeyReference, profile.apiKeyConfigured);
    if (profile.isDefault) defaults += 1;
  }
  if (defaults > 1) throw new Error('Provider 元数据包含多个默认 Provider。');
  return references;
}

export class ProviderStore {
  private profiles: StoredProviderProfile[];
  private mutationActive = false;
  private readonly queuedMutations: Array<() => void> = [];

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
    if (provider.recipientTransitionPending) throw providerTransitionError();
    const expectedRevision = provider.recipientRevision;
    const expectedReference = provider.apiKeyReference;
    const secret = await this.secrets.get(provider.apiKeyReference);
    const current = this.assertCredentialRecipient(
      providerId,
      expectedRevision,
      expectedReference,
    );
    if (!secret) throw new Error(`${current.name} 尚未配置 API Key。`);
    return secret;
  }

  assertRuntimeRecipient(
    providerId: string,
    expectedRecipientRevision?: string,
  ): ProviderProfile {
    const provider = this.getStored(providerId);
    if (
      provider.recipientTransitionPending
      || (
        expectedRecipientRevision !== undefined
        && provider.recipientRevision !== expectedRecipientRevision
      )
    ) throw providerTransitionError();
    if (provider.status !== 'ready') {
      throw new Error(`Provider ${provider.name} is not Ready.`);
    }
    return publicProfile(provider);
  }

  async runtimeSnapshot(
    providerId: string,
    expectedRecipientRevision: string,
  ): Promise<ProviderRuntimeSnapshot> {
    this.assertRuntimeRecipient(providerId, expectedRecipientRevision);
    const apiKey = await this.apiKey(providerId);
    const profile = this.assertRuntimeRecipient(providerId, expectedRecipientRevision);
    return { profile, apiKey };
  }

  async save(input: ProviderInput): Promise<ProviderProfile> {
    return this.serializeMutation(() => this.saveExclusive(input));
  }

  private async saveExclusive(input: ProviderInput): Promise<ProviderProfile> {
    const now = new Date().toISOString();
    const existing = input.id
      ? this.profiles.find((profile) => profile.id === input.id)
      : undefined;
    if (input.id && !existing) throw new Error(`找不到 Provider：${input.id}`);
    const id = existing?.id ?? randomUUID();
    const baseUrl = normalizedBaseUrl(input.baseUrl);
    const modelId = requiredText(input.modelId, '模型 ID');
    if (
      input.contextWindowTokens !== undefined
      && normalizedContextWindowTokens(input.contextWindowTokens) !== input.contextWindowTokens
    ) {
      throw new Error(
        `上下文窗口必须是 ${MIN_CONTEXT_WINDOW_TOKENS}-${MAX_CONTEXT_WINDOW_TOKENS} 之间的整数。`,
      );
    }
    const contextWindowTokens = normalizedContextWindowTokens(
      input.contextWindowTokens ?? existing?.contextWindowTokens,
    );
    if (
      input.contextEstimateSafetyFactor !== undefined
      && normalizedContextEstimateSafetyFactor(input.contextEstimateSafetyFactor)
        !== input.contextEstimateSafetyFactor
    ) {
      throw new Error(
        `估算安全系数必须是 ${MIN_CONTEXT_ESTIMATE_SAFETY_FACTOR}-${MAX_CONTEXT_ESTIMATE_SAFETY_FACTOR} 之间的数值。`,
      );
    }
    const contextEstimateSafetyFactor = normalizedContextEstimateSafetyFactor(
      input.contextEstimateSafetyFactor ?? existing?.contextEstimateSafetyFactor,
    );
    const apiKeyReference = existing?.apiKeyReference ?? `AI Terminal/provider/${id}`;
    const suppliedKey = input.apiKey && input.apiKey.trim() ? input.apiKey : undefined;
    const keyReplaced = Boolean(suppliedKey);
    const endpointChanged = existing
      && (existing.baseUrl !== baseUrl || existing.modelId !== modelId);
    const recipientChanged = Boolean(endpointChanged || keyReplaced);
    const makeDefault = Boolean(input.makeDefault)
      || this.profiles.length === 0
      || existing?.isDefault === true;
    const profile: StoredProviderProfile = {
      id,
      name: requiredText(input.name, 'Provider 名称'),
      kind: 'generic-openai-compatible',
      baseUrl,
      modelId,
      contextWindowTokens,
      contextEstimateSafetyFactor,
      apiKeyReference,
      recipientTransitionPending: suppliedKey
        ? true
        : existing?.recipientTransitionPending ?? false,
      recipientRevision: existing && !recipientChanged
        ? existing.recipientRevision
        : randomUUID(),
      apiKeyConfigured: existing?.apiKeyConfigured ?? false,
      isDefault: makeDefault,
      status: endpointChanged || keyReplaced ? 'not-tested' : existing?.status ?? 'not-tested',
      lastTestedAt: endpointChanged || keyReplaced ? undefined : existing?.lastTestedAt,
      lastError: endpointChanged || keyReplaced ? undefined : existing?.lastError,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const candidateProfiles = this.profiles
      .filter((candidate) => candidate.id !== profile.id)
      .map((candidate) => makeDefault ? { ...candidate, isDefault: false } : candidate);
    candidateProfiles.push(profile);
    // A credential replacement is a durable two-phase transition. Persisting
    // the new recipient revision and private fence first guarantees that a
    // metadata failure cannot silently replace the key under an old identity.
    this.persistProfiles(candidateProfiles);
    if (!suppliedKey) return publicProfile(profile);

    // Any rejection here may be ambiguous (the platform store might have
    // committed before reporting failure), so deliberately retain the new
    // revision and pending fence. A later explicit save can complete recovery.
    await this.secrets.set(apiKeyReference, suppliedKey);
    const committed: StoredProviderProfile = {
      ...profile,
      apiKeyConfigured: true,
      recipientTransitionPending: false,
    };
    this.persistProfiles(this.profiles.map((candidate) => (
      candidate.id === committed.id ? committed : candidate
    )));
    return publicProfile(committed);
  }

  async remove(providerId: string): Promise<void> {
    return this.serializeMutation(() => this.removeExclusive(providerId));
  }

  private async removeExclusive(providerId: string): Promise<void> {
    const provider = this.getStored(providerId);
    await this.secrets.remove(provider.apiKeyReference);
    const wasDefault = provider.isDefault;
    this.profiles = this.profiles.filter((candidate) => candidate.id !== providerId);
    if (wasDefault && this.profiles.length) this.profiles[0] = { ...this.profiles[0], isDefault: true };
    this.write();
  }

  async setDefault(providerId: string): Promise<ProviderProfile> {
    return this.serializeMutation(() => this.setDefaultExclusive(providerId));
  }

  private setDefaultExclusive(providerId: string): ProviderProfile {
    const selected = this.getStored(providerId);
    this.persistProfiles(this.profiles.map((profile) => ({
      ...profile,
      isDefault: profile.id === providerId,
      updatedAt: profile.id === providerId ? new Date().toISOString() : profile.updatedAt,
    })));
    return this.get(selected.id);
  }

  async testConnection(providerId: string): Promise<ProviderConnectionResult> {
    return this.serializeMutation(() => this.testConnectionExclusive(providerId));
  }

  private async testConnectionExclusive(providerId: string): Promise<ProviderConnectionResult> {
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
    if (
      current.recipientTransitionPending
      || current.recipientRevision !== provider.recipientRevision
    ) throw providerTransitionError();
    const updated: StoredProviderProfile = {
      ...current,
      status: result.status,
      lastTestedAt: testedAt,
      lastError: result.ok ? undefined : result.message,
      updatedAt: testedAt,
    };
    this.persistProfiles(this.profiles.map((candidate) => (
      candidate.id === providerId ? updated : candidate
    )));
    return result;
  }

  async discoverModels(
    input: ProviderModelDiscoveryInput,
  ): Promise<ProviderModelDiscoveryResult> {
    const baseUrl = normalizedBaseUrl(input.baseUrl);
    const suppliedKey = typeof input.apiKey === 'string' && input.apiKey.trim()
      ? input.apiKey
      : undefined;
    let apiKey = suppliedKey;
    let requestBaseUrl = baseUrl;
    let savedRecipient: {
      providerId: string;
      recipientRevision: string;
      apiKeyReference: string;
    } | undefined;
    if (!apiKey && input.providerId) {
      const provider = this.getStored(input.providerId);
      if (provider.recipientTransitionPending) throw providerTransitionError();
      // A saved credential is scoped to its saved recipient. Never treat
      // providerId as a bearer-token lookup for a caller-controlled endpoint.
      if (baseUrl !== provider.baseUrl) {
        throw new Error('使用已保存的 API Key 时，Base URL 必须与当前 Provider 一致；其他地址请显式输入 API Key。');
      }
      savedRecipient = {
        providerId: provider.id,
        recipientRevision: provider.recipientRevision,
        apiKeyReference: provider.apiKeyReference,
      };
      requestBaseUrl = provider.baseUrl;
      apiKey = await this.secrets.get(savedRecipient.apiKeyReference);
      const current = this.assertCredentialRecipient(
        savedRecipient.providerId,
        savedRecipient.recipientRevision,
        savedRecipient.apiKeyReference,
      );
      if (current.baseUrl !== requestBaseUrl) throw providerTransitionError();
    }
    if (!apiKey) throw new Error('请先输入 API Key，再自动检索模型。');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const requestOptions: RequestInit = {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: controller.signal,
        redirect: 'error',
      };
      // Recheck synchronously at the final dispatch boundary. No await or
      // caller-controlled callback may separate this fence from fetch.
      if (savedRecipient) {
        const current = this.assertCredentialRecipient(
          savedRecipient.providerId,
          savedRecipient.recipientRevision,
          savedRecipient.apiKeyReference,
        );
        if (current.baseUrl !== requestBaseUrl) throw providerTransitionError();
      }
      const response = await this.fetchImplementation(`${requestBaseUrl}/models`, requestOptions);
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

  private assertCredentialRecipient(
    providerId: string,
    expectedRecipientRevision: string,
    expectedApiKeyReference: string,
  ): StoredProviderProfile {
    const provider = this.getStored(providerId);
    if (
      provider.recipientTransitionPending
      || provider.recipientRevision !== expectedRecipientRevision
      || provider.apiKeyReference !== expectedApiKeyReference
    ) throw providerTransitionError();
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

  private persistProfiles(profiles: StoredProviderProfile[]): void {
    this.write(profiles);
    this.profiles = profiles;
  }

  /**
   * Provider metadata and credential-store mutations form one ordered log.
   * In particular, credential writes must never overlap: a late completion
   * from an older save could otherwise revive its recipient revision while
   * leaving the key written by a newer save (or vice versa).
   */
  private serializeMutation<T>(operation: () => Promise<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const execute = () => {
        let result: Promise<T> | T;
        try {
          result = operation();
        } catch (error) {
          this.finishMutation();
          reject(error);
          return;
        }
        Promise.resolve(result).then(
          (value) => {
            resolve(value);
            this.finishMutation();
          },
          (error) => {
            reject(error);
            this.finishMutation();
          },
        );
      };
      if (this.mutationActive) {
        this.queuedMutations.push(execute);
      } else {
        this.mutationActive = true;
        execute();
      }
    });
  }

  private finishMutation(): void {
    const next = this.queuedMutations.shift();
    if (next) next();
    else this.mutationActive = false;
  }

  private write(profiles: readonly StoredProviderProfile[] = this.profiles): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(profiles, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      // Windows rejects FlushFileBuffers on a read-only handle; O_RDWR gives
      // fsyncSync a flush-capable handle without changing file contents.
      const descriptor = openSync(temporaryPath, fsConstants.O_RDWR);
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporaryPath, this.filePath);
      if (process.platform !== 'win32') {
        const directory = openSync(dirname(this.filePath), fsConstants.O_RDONLY);
        try {
          fsyncSync(directory);
        } finally {
          closeSync(directory);
        }
      }
    } catch (error) {
      try { unlinkSync(temporaryPath); } catch { /* best-effort failed-write cleanup */ }
      throw error;
    }
  }
}
