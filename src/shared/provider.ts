export type ProviderKind = 'generic-openai-compatible';
export type ProviderStatus = 'not-tested' | 'ready' | 'error';

export interface ProviderProfile {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  modelId: string;
  /**
   * Provider/model input context window. Existing profiles default to 64K.
   * Automatic compression triggers before this hard ceiling.
   */
  contextWindowTokens?: number;
  /**
   * Opaque, non-secret identity revision for endpoint/model/credential changes.
   * Routine status tests, display-name edits, and default selection preserve it.
   */
  recipientRevision: string;
  apiKeyConfigured: boolean;
  isDefault: boolean;
  status: ProviderStatus;
  lastTestedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderInput {
  id?: string;
  name: string;
  kind?: ProviderKind;
  baseUrl: string;
  modelId: string;
  contextWindowTokens?: number;
  apiKey?: string;
  makeDefault?: boolean;
}

export interface ProviderConnectionResult {
  ok: boolean;
  status: ProviderStatus;
  message: string;
  testedAt: string;
}

export interface ProviderModelDiscoveryInput {
  baseUrl: string;
  apiKey?: string;
  providerId?: string;
}

export interface ProviderModelDiscoveryResult {
  models: string[];
  message: string;
}

export const PROVIDER_CHANNELS = {
  list: 'provider:list',
  save: 'provider:save',
  remove: 'provider:remove',
  setDefault: 'provider:set-default',
  testConnection: 'provider:test-connection',
  discoverModels: 'provider:discover-models',
} as const;
