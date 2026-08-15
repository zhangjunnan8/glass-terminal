import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderStore } from './provider-store';
import { MemorySecretStore } from './secret-store';
import { PROVIDER_TEMPLATES, providerTemplateForBaseUrl } from '../../shared/provider-templates';

const roots: string[] = [];

function fixture(fetchImplementation: typeof fetch = fetch) {
  const root = mkdtempSync(join(tmpdir(), 'ai-terminal-provider-test-'));
  roots.push(root);
  const path = join(root, 'providers.json');
  const secrets = new MemorySecretStore();
  return { path, secrets, store: new ProviderStore(path, secrets, fetchImplementation) };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (root.startsWith(tmpdir())) rmSync(root, { recursive: true, force: true });
  }
});

describe('ProviderStore', () => {
  it('ships stable presets while preserving a custom endpoint option', () => {
    expect(PROVIDER_TEMPLATES.map((template) => template.id)).toEqual([
      'openai',
      'deepseek',
      'zhipu',
      'minimax-cn',
      'minimax-global',
      'custom',
    ]);
    expect(providerTemplateForBaseUrl('https://api.deepseek.com/').id).toBe('deepseek');
    expect(providerTemplateForBaseUrl('https://private.example/v1').id).toBe('custom');
  });

  it('persists only a Credential Manager reference, never the API key', async () => {
    const { path, secrets, store } = fixture();
    const profile = await store.save({
      name: 'Test Provider',
      baseUrl: 'https://provider.example/v1/',
      modelId: 'model-1',
      apiKey: 'super-secret-provider-key',
    });

    const persisted = readFileSync(path, 'utf8');
    const reference = JSON.parse(persisted)[0].apiKeyReference as string;
    expect(persisted).not.toContain('super-secret-provider-key');
    expect(profile).not.toHaveProperty('apiKeyReference');
    expect(reference).toMatch(/^AI Terminal\/provider\//);
    expect(await secrets.get(reference)).toBe('super-secret-provider-key');
    expect(profile.baseUrl).toBe('https://provider.example/v1');
  });

  it('becomes Ready only after a successful authenticated connection test', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ data: [{ id: 'model-1' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const { store } = fixture(fetchMock);
    const profile = await store.save({
      name: 'Ready Provider',
      baseUrl: 'https://provider.example/v1',
      modelId: 'model-1',
      apiKey: 'key-for-request-only',
    });

    expect(profile.status).toBe('not-tested');
    const result = await store.testConnection(profile.id);

    expect(result.ok).toBe(true);
    expect(store.get(profile.id).status).toBe('ready');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://provider.example/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer key-for-request-only' }),
      }),
    );
  });

  it('records a safe error and supports default selection and removal', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 401 }));
    const { path, secrets, store } = fixture(fetchMock);
    const first = await store.save({
      name: 'First',
      baseUrl: 'https://one.example/v1',
      modelId: 'one',
      apiKey: 'first-secret',
    });
    const second = await store.save({
      name: 'Second',
      baseUrl: 'https://two.example/v1',
      modelId: 'two',
      apiKey: 'second-secret',
      makeDefault: true,
    });
    const secondReference = (JSON.parse(readFileSync(path, 'utf8')) as Array<{
      id: string;
      apiKeyReference: string;
    }>).find((profile) => profile.id === second.id)!.apiKeyReference;

    expect(store.list()[0].id).toBe(second.id);
    const result = await store.testConnection(second.id);
    expect(result).toMatchObject({ ok: false, status: 'error' });
    expect(result.message).toBe('Provider 返回 HTTP 401。');
    expect(readFileSync(path, 'utf8')).not.toContain('second-secret');

    store.setDefault(first.id);
    expect(store.list()[0].id).toBe(first.id);
    await store.remove(second.id);
    expect(store.list().map((profile) => profile.id)).toEqual([first.id]);
    expect(await secrets.get(secondReference)).toBeUndefined();
  });

  it('drops unknown imported fields instead of reflecting possible secret material', () => {
    const { path, secrets } = fixture();
    writeFileSync(path, JSON.stringify([{
      id: 'provider-id',
      name: 'Imported',
      kind: 'generic-openai-compatible',
      baseUrl: 'https://provider.example/v1',
      modelId: 'model',
      apiKeyReference: 'AI Terminal/provider/provider-id',
      apiKeyConfigured: true,
      isDefault: true,
      status: 'not-tested',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      apiKey: 'must-not-cross-the-store-boundary',
    }]));

    const store = new ProviderStore(path, secrets);
    expect(store.list()[0]).not.toHaveProperty('apiKey');
    expect(JSON.stringify(store.list())).not.toContain('must-not-cross-the-store-boundary');
  });

  it('discovers, deduplicates, and sorts models without persisting a supplied key', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'model-z' }, { id: 'model-a' }, { id: 'model-z' }, { ignored: true }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const { path, store } = fixture(fetchMock);

    await expect(store.discoverModels({
      baseUrl: 'https://provider.example/v1/',
      apiKey: 'discovery-secret',
    })).resolves.toEqual({
      models: ['model-a', 'model-z'],
      message: '已检索到 2 个可用模型。',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://provider.example/v1/models',
      expect.objectContaining({
        redirect: 'error',
        headers: expect.objectContaining({ Authorization: 'Bearer discovery-secret' }),
      }),
    );
    expect(() => readFileSync(path, 'utf8')).toThrow();
  });

  it('can discover with an existing saved key and keeps manual entry as the safe fallback', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'saved-model' }] }), { status: 200 }));
    const { store } = fixture(fetchMock);
    const profile = await store.save({
      name: 'Existing',
      baseUrl: 'https://provider.example/v1',
      modelId: 'manual-model',
      apiKey: 'saved-secret',
    });

    await expect(store.discoverModels({
      baseUrl: profile.baseUrl,
      providerId: profile.id,
    })).rejects.toThrow('仍可手动输入模型 ID');
    await expect(store.discoverModels({
      baseUrl: profile.baseUrl,
      providerId: profile.id,
    })).resolves.toMatchObject({ models: ['saved-model'] });
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://provider.example/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer saved-secret' }),
      }),
    );
  });
});
