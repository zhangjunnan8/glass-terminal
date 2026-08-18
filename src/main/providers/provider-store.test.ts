import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
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

  it('changes recipient revision only for endpoint, model, or credential identity', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ data: [{ id: 'model-1' }, { id: 'model-2' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const { store } = fixture(fetchMock);
    const original = await store.save({
      name: 'Recipient',
      baseUrl: 'https://provider.example/v1',
      modelId: 'model-1',
      apiKey: 'fake-1',
    });

    await store.testConnection(original.id);
    expect(store.get(original.id).recipientRevision).toBe(original.recipientRevision);
    await store.setDefault(original.id);
    expect(store.get(original.id).recipientRevision).toBe(original.recipientRevision);
    const renamed = await store.save({
      id: original.id,
      name: 'Display name only',
      baseUrl: original.baseUrl,
      modelId: original.modelId,
    });
    expect(renamed.recipientRevision).toBe(original.recipientRevision);

    const moved = await store.save({
      id: original.id,
      name: renamed.name,
      baseUrl: 'https://replacement.example/v1',
      modelId: renamed.modelId,
    });
    expect(moved.recipientRevision).not.toBe(original.recipientRevision);
    const rekeyed = await store.save({
      id: original.id,
      name: moved.name,
      baseUrl: moved.baseUrl,
      modelId: moved.modelId,
      apiKey: 'fake-2',
    });
    expect(rekeyed.recipientRevision).not.toBe(moved.recipientRevision);
  });

  it('persists the transition fence before touching a replacement secret', async () => {
    const { path, secrets, store } = fixture();
    const original = await store.save({
      name: 'Atomic recipient',
      baseUrl: 'https://provider.example/v1',
      modelId: 'model-1',
      apiKey: 'original-secret',
    });
    const reference = JSON.parse(readFileSync(path, 'utf8'))[0].apiKeyReference as string;
    const setSecret = vi.spyOn(secrets, 'set');
    unlinkSync(path);
    mkdirSync(path);

    await expect(store.save({
      id: original.id,
      name: original.name,
      baseUrl: original.baseUrl,
      modelId: original.modelId,
      apiKey: 'must-not-be-written',
    })).rejects.toThrow();

    expect(setSecret).not.toHaveBeenCalled();
    expect(await secrets.get(reference)).toBe('original-secret');
    expect(store.get(original.id).recipientRevision).toBe(original.recipientRevision);
  });

  it('keeps an ambiguous secret failure durably pending and blocks snapshots and dispatch', async () => {
    const { path, secrets, store } = fixture();
    const original = await store.save({
      name: 'Pending recipient',
      baseUrl: 'https://provider.example/v1',
      modelId: 'model-1',
      apiKey: 'original-secret',
    });
    vi.spyOn(secrets, 'set').mockRejectedValueOnce(new Error('ambiguous credential failure'));

    await expect(store.save({
      id: original.id,
      name: original.name,
      baseUrl: original.baseUrl,
      modelId: original.modelId,
      apiKey: 'possibly-committed-secret',
    })).rejects.toThrow('ambiguous credential failure');

    const pending = store.get(original.id);
    expect(pending.recipientRevision).not.toBe(original.recipientRevision);
    expect(pending.status).toBe('not-tested');
    expect(JSON.parse(readFileSync(path, 'utf8'))[0]).toMatchObject({
      recipientRevision: pending.recipientRevision,
      recipientTransitionPending: true,
    });
    await expect(store.apiKey(original.id)).rejects.toThrow('transitioning');
    await expect(store.runtimeSnapshot(
      original.id,
      pending.recipientRevision,
    )).rejects.toThrow('transitioning');
    const restarted = new ProviderStore(path, secrets);
    await expect(restarted.runtimeSnapshot(
      original.id,
      pending.recipientRevision,
    )).rejects.toThrow('transitioning');
  });

  it('rejects a runtime snapshot when recipient config changes during secret retrieval', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ data: [{ id: 'model-1' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const { secrets, store } = fixture(fetchMock);
    const profile = await store.save({
      name: 'Deferred recipient',
      baseUrl: 'https://provider.example/v1',
      modelId: 'model-1',
      apiKey: 'original-secret',
    });
    await store.testConnection(profile.id);
    let releaseSecret!: (secret: string) => void;
    const secretRead = vi.spyOn(secrets, 'get').mockImplementationOnce(() => (
      new Promise<string>((resolve) => { releaseSecret = resolve; })
    ));

    const snapshot = store.runtimeSnapshot(profile.id, profile.recipientRevision);
    expect(secretRead).toHaveBeenCalledOnce();
    await store.save({
      id: profile.id,
      name: profile.name,
      baseUrl: 'https://replacement.example/v1',
      modelId: profile.modelId,
    });
    releaseSecret('original-secret');

    await expect(snapshot).rejects.toThrow('transitioning');
  });

  it('serializes concurrent rekeys even when the newer credential write is ready first', async () => {
    const { path, secrets, store } = fixture();
    const original = await store.save({
      name: 'Serialized recipient',
      baseUrl: 'https://provider.example/v1',
      modelId: 'model-1',
      apiKey: 'original-secret',
    });
    const reference = JSON.parse(readFileSync(path, 'utf8'))[0].apiKeyReference as string;
    const writeSecret = secrets.set.bind(secrets);
    let releaseOlder!: () => void;
    const olderGate = new Promise<void>((resolve) => { releaseOlder = resolve; });
    let releaseNewer!: () => void;
    const newerGate = new Promise<void>((resolve) => { releaseNewer = resolve; });
    // Model the newer platform write being immediately ready while the older
    // write is still blocked. Serialization must keep it from starting early.
    releaseNewer();
    const setSecret = vi.spyOn(secrets, 'set').mockImplementation(async (key, secret) => {
      await (secret === 'older-secret' ? olderGate : newerGate);
      await writeSecret(key, secret);
    });

    const olderSave = store.save({
      id: original.id,
      name: original.name,
      baseUrl: 'https://older.example/v1',
      modelId: 'older-model',
      apiKey: 'older-secret',
    });
    const olderRevision = store.get(original.id).recipientRevision;
    const newerSave = store.save({
      id: original.id,
      name: original.name,
      baseUrl: 'https://newer.example/v1',
      modelId: 'newer-model',
      apiKey: 'newer-secret',
    });

    expect(setSecret).toHaveBeenCalledTimes(1);
    expect(setSecret).toHaveBeenLastCalledWith(reference, 'older-secret');
    expect(store.get(original.id).recipientRevision).toBe(olderRevision);

    releaseOlder();
    const older = await olderSave;
    expect(older.recipientRevision).toBe(olderRevision);
    expect(setSecret).toHaveBeenCalledTimes(2);
    expect(setSecret).toHaveBeenLastCalledWith(reference, 'newer-secret');
    const newer = await newerSave;

    const finalProfile = store.get(original.id);
    expect(finalProfile).toMatchObject({
      baseUrl: 'https://newer.example/v1',
      modelId: 'newer-model',
      recipientRevision: newer.recipientRevision,
    });
    expect(finalProfile.recipientRevision).not.toBe(older.recipientRevision);
    expect(await secrets.get(reference)).toBe('newer-secret');
    expect(JSON.parse(readFileSync(path, 'utf8'))[0]).toMatchObject({
      baseUrl: finalProfile.baseUrl,
      modelId: finalProfile.modelId,
      recipientRevision: finalProfile.recipientRevision,
      recipientTransitionPending: false,
    });
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

    await store.setDefault(first.id);
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

  it('never sends a saved provider key to a different discovery Base URL', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const { store } = fixture(fetchMock);
    const profile = await store.save({
      name: 'Bound discovery recipient',
      baseUrl: 'https://saved.example/v1',
      modelId: 'saved-model',
      apiKey: 'saved-secret',
    });

    await expect(store.discoverModels({
      baseUrl: 'https://untrusted.example/v1',
      providerId: profile.id,
    })).rejects.toThrow('显式输入 API Key');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts saved-key discovery if recipient config changes during secret retrieval', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const { secrets, store } = fixture(fetchMock);
    const profile = await store.save({
      name: 'Deferred discovery recipient',
      baseUrl: 'https://saved.example/v1',
      modelId: 'saved-model',
      apiKey: 'saved-secret',
    });
    let releaseSecret!: (secret: string) => void;
    const secretRead = vi.spyOn(secrets, 'get').mockImplementationOnce(() => (
      new Promise<string>((resolve) => { releaseSecret = resolve; })
    ));

    const discovery = store.discoverModels({
      baseUrl: profile.baseUrl,
      providerId: profile.id,
    });
    expect(secretRead).toHaveBeenCalledOnce();
    await store.save({
      id: profile.id,
      name: profile.name,
      baseUrl: 'https://replacement.example/v1',
      modelId: profile.modelId,
    });
    releaseSecret('saved-secret');

    await expect(discovery).rejects.toThrow('transitioning');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('discovers only from the exact saved URL when reusing its bound key', async () => {
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

  it('reports the exact number of normalized model options returned to the UI', async () => {
    const data = Array.from({ length: 520 }, (_, index) => ({
      id: `model-${String(index).padStart(3, '0')}`,
    }));
    data.push({ id: ' model-001 ' }, { id: '' });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const { store } = fixture(fetchMock);

    const result = await store.discoverModels({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'discovery-secret',
    });

    expect(result.models).toHaveLength(500);
    expect(new Set(result.models).size).toBe(500);
    expect(result.models[0]).toBe('model-000');
    expect(result.models.at(-1)).toBe('model-499');
    expect(result.message).toBe(`已检索到 ${result.models.length} 个可用模型。`);
  });
});
