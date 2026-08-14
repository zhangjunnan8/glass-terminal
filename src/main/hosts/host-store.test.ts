import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HostStore } from './host-store';

const temporaryDirectories: string[] = [];

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), 'ai-terminal-hosts-'));
  temporaryDirectories.push(directory);
  const filePath = join(directory, 'hosts.json');
  return { store: new HostStore(filePath), filePath };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('HostStore', () => {
  it('persists only non-secret host fields', () => {
    const { store, filePath } = createStore();
    const host = store.save({
      name: 'Ubuntu Lab',
      hostname: '192.168.31.93',
      port: 22,
      username: 'zjn',
      authMethod: 'password',
    });
    expect(store.get(host.id).hostname).toBe('192.168.31.93');
    const persisted = readFileSync(filePath, 'utf8');
    expect(persisted).not.toContain('password": "');
    expect(persisted).not.toContain('passphrase');
  });

  it('keeps a trusted fingerprint across profile edits', () => {
    const { store } = createStore();
    const host = store.save({
      name: 'Ubuntu Lab',
      hostname: '192.168.31.93',
      port: 22,
      username: 'zjn',
      authMethod: 'password',
    });
    store.trustFingerprint(host.id, 'SHA256:example');
    const updated = store.save({ ...host, name: 'Ubuntu Debug' });
    expect(updated.hostKeyFingerprint).toBe('SHA256:example');
  });
});
