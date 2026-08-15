import { describe, expect, it } from 'vitest';
import { MemorySecretStore } from '../providers/secret-store';
import { HostCredentialStore, hostCredentialReference } from './host-credential-store';

const HOST_ID = '00000000-0000-4000-8000-000000000001';

describe('HostCredentialStore', () => {
  it('uses only the stable SSH namespace and keeps the secret in its adapter', async () => {
    const secrets = new MemorySecretStore();
    const store = new HostCredentialStore(secrets);
    const reference = await store.set(HOST_ID, 'ssh-secret');

    expect(reference).toBe(`AI Terminal/ssh/${HOST_ID}`);
    expect(await store.get(HOST_ID, reference)).toBe('ssh-secret');
    await store.remove(HOST_ID, reference);
    expect(await store.get(HOST_ID, reference)).toBeUndefined();
  });

  it('rejects invalid Host ids and mismatched references', async () => {
    const store = new HostCredentialStore(new MemorySecretStore());
    expect(() => hostCredentialReference('not-a-uuid')).toThrow(/invalid/i);
    await expect(store.get(
      HOST_ID,
      'AI Terminal/ssh/00000000-0000-4000-8000-000000000002',
    )).rejects.toThrow(/invalid/i);
  });
});
