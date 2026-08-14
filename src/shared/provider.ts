export type ProviderKind = 'generic-openai-compatible';
export type ProviderStatus = 'not-tested' | 'ready' | 'error';

export interface ProviderProfile {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  modelId: string;
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
  apiKey?: string;
  makeDefault?: boolean;
}

export interface ProviderConnectionResult {
  ok: boolean;
  status: ProviderStatus;
  message: string;
  testedAt: string;
}

export const PROVIDER_CHANNELS = {
  list: 'provider:list',
  save: 'provider:save',
  remove: 'provider:remove',
  setDefault: 'provider:set-default',
  testConnection: 'provider:test-connection',
} as const;
