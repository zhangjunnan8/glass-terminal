import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostInput } from '../../shared/host';
import { HostStore } from './host-store';

const temporaryDirectories: string[] = [];

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), 'ai-terminal-hosts-'));
  temporaryDirectories.push(directory);
  const filePath = join(directory, 'hosts.json');
  return { store: new HostStore(filePath), filePath };
}

function storedDocument(filePath: string) {
  return JSON.parse(readFileSync(filePath, 'utf8')) as {
    version: number;
    folders: Array<Record<string, unknown>>;
    hosts: Array<Record<string, unknown>>;
  };
}

function sshHost(name: string, suffix = name): HostInput {
  return {
    name,
    hostname: `192.0.2.${suffix.length}`,
    port: 22,
    username: 'tester',
    authMethod: 'password',
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('HostStore', () => {
  it('persists only allowlisted, non-secret Host fields in a versioned document', () => {
    const { store, filePath } = createStore();
    const host = store.save({
      name: 'Ubuntu Lab',
      hostname: '192.0.2.10',
      port: 22,
      username: 'tester',
      authMethod: 'password',
    });
    expect(store.get(host.id)).toMatchObject({
      protocol: 'ssh',
      hostname: '192.0.2.10',
      sortOrder: 0,
      credentialConfigured: false,
    });
    const persisted = readFileSync(filePath, 'utf8');
    expect(storedDocument(filePath).version).toBe(4);
    expect(persisted).not.toContain('password": "');
    expect(persisted).not.toContain('passphrase');
  });

  it('keeps a trusted fingerprint across profile edits', () => {
    const { store } = createStore();
    const host = store.save(sshHost('Ubuntu Lab'));
    store.trustFingerprint(host.id, 'SHA256:example');
    const updated = store.save({ ...host, name: 'Ubuntu Debug' });
    expect(updated.hostKeyFingerprint).toBe('SHA256:example');
  });

  it('keeps credential references internal and retires them before identity changes', () => {
    const { store, filePath } = createStore();
    const host = store.save(sshHost('Ubuntu Lab'));
    const reference = `AI Terminal/ssh/${host.id}`;
    const configured = store.configureCredential(host.id, reference);
    expect(configured.credentialConfigured).toBe(true);
    expect(configured).not.toHaveProperty('credentialReference');
    expect(configured).not.toHaveProperty('revision');
    expect(store.list()[0]).not.toHaveProperty('credentialReference');
    expect(readFileSync(filePath, 'utf8')).toContain(reference);

    const renamed = store.saveWithCredentialRetirement({ ...host, name: 'Renamed' });
    expect(renamed.retiredCredentialReference).toBeUndefined();
    expect(renamed.host.credentialConfigured).toBe(true);

    const changed = store.saveWithCredentialRetirement({
      ...renamed.host,
      username: 'another-user',
    });
    expect(changed.retiredCredentialReference).toBe(reference);
    expect(changed.host.credentialConfigured).toBe(false);
    expect(store.credentialReference(host.id)).toBeUndefined();
    expect(readFileSync(filePath, 'utf8')).not.toContain(reference);
  });

  it('migrates legacy group strings to stable folders without exposing injected fields', () => {
    const { filePath } = createStore();
    const timestamp = '2026-01-02T03:04:05.000Z';
    const legacy = [{
      id: 'legacy-host',
      name: 'Ubuntu Lab',
      hostname: '192.0.2.10',
      port: 22,
      username: 'tester',
      authMethod: 'password',
      group: 'Production',
      favorite: false,
      credentialConfigured: true,
      credentialReference: 'AI Terminal/ssh/not-the-host-id',
      password: 'must-not-cross-ipc',
      revision: 7,
      createdAt: timestamp,
      updatedAt: timestamp,
    }];
    writeFileSync(filePath, JSON.stringify(legacy), 'utf8');

    const firstLoad = new HostStore(filePath);
    const firstFolder = firstLoad.listFolders()[0];
    const migrated = firstLoad.get('legacy-host');
    expect(firstFolder).toMatchObject({ name: 'Production', sortOrder: 0 });
    expect(migrated).toMatchObject({
      protocol: 'ssh',
      folderId: firstFolder.id,
      group: 'Production',
      credentialConfigured: false,
    });
    expect(migrated).not.toHaveProperty('password');
    expect(migrated).not.toHaveProperty('credentialReference');

    const secondLoad = new HostStore(filePath);
    expect(secondLoad.listFolders()[0].id).toBe(firstFolder.id);

    firstLoad.moveHost({
      hostId: migrated.id,
      folderId: null,
      beforeHostId: null,
    });
    const persisted = storedDocument(filePath);
    expect(persisted.version).toBe(4);
    expect(persisted.hosts[0].revision).toBe(7);
  });

  it('migrates a version-two Full Takeover flag into the Complete Access Host default', () => {
    const { filePath } = createStore();
    const timestamp = '2026-01-02T03:04:05.000Z';
    writeFileSync(filePath, JSON.stringify({
      version: 2,
      folders: [],
      hosts: [{
        id: 'legacy-takeover-host',
        protocol: 'ssh',
        name: 'Legacy takeover',
        hostname: '192.0.2.30',
        port: 22,
        username: 'tester',
        authMethod: 'password',
        favorite: false,
        credentialConfigured: false,
        fullTakeover: true,
        sortOrder: 0,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      }],
    }), 'utf8');

    const store = new HostStore(filePath);

    expect(store.get('legacy-takeover-host').fullTakeoverPreference).toBe(true);
    expect(store.get('legacy-takeover-host').reviewModePreference).toBe('complete');
    const persisted = storedDocument(filePath);
    expect(persisted.version).toBe(4);
    expect(persisted.hosts[0]).toMatchObject({
      fullTakeoverPreference: true,
      reviewModePreference: 'complete',
    });
    expect(persisted.hosts[0]).not.toHaveProperty('fullTakeover');
  });

  it('persists the last selected three-state AI review mode per Host', () => {
    const { store, filePath } = createStore();
    const host = store.save(sshHost('Review default'));

    expect(host.reviewModePreference).toBe('all');
    expect(store.setReviewModePreference(host.id, 'risky')).toMatchObject({
      reviewModePreference: 'risky',
      fullTakeoverPreference: false,
    });
    expect(new HostStore(filePath).get(host.id).reviewModePreference).toBe('risky');
    expect(store.setReviewModePreference(host.id, 'complete')).toMatchObject({
      reviewModePreference: 'complete',
      fullTakeoverPreference: true,
    });
  });

  it('creates, renames, orders, and only removes empty Host folders', () => {
    const { store } = createStore();
    const production = store.createFolder({ name: 'Production' });
    const staging = store.createFolder({ name: 'Staging' });
    expect(() => store.createFolder({ name: 'production' })).toThrow(/same|exist|\u5b58在/i);

    const renamed = store.renameFolder({ folderId: staging.id, name: 'Testing' });
    expect(renamed.name).toBe('Testing');
    const ordered = store.moveFolder({
      folderId: renamed.id,
      beforeFolderId: production.id,
    });
    expect(ordered.map((folder) => folder.id)).toEqual([renamed.id, production.id]);

    const host = store.save({ ...sshHost('Grouped'), folderId: production.id });
    expect(() => store.removeFolder(production.id)).toThrow(/empty|\u7a7a/);
    store.moveHost({ hostId: host.id, folderId: null, beforeHostId: null });
    store.removeFolder(production.id);
    expect(store.listFolders().map((folder) => folder.id)).toEqual([renamed.id]);
  });

  it('moves and reorders Hosts without changing identity, credentials, or revision', () => {
    const { store, filePath } = createStore();
    const source = store.createFolder({ name: 'Source' });
    const target = store.createFolder({ name: 'Target' });
    const first = store.save({ ...sshHost('First'), folderId: source.id });
    const second = store.save({ ...sshHost('Second'), folderId: source.id });
    const targetHost = store.save({ ...sshHost('Target host'), folderId: target.id });
    store.trustFingerprint(first.id, 'SHA256:move-safe');
    store.configureCredential(first.id, `AI Terminal/ssh/${first.id}`);
    const before = storedDocument(filePath).hosts.find((host) => host.id === first.id)!;

    const moved = store.moveHost({
      hostId: first.id,
      folderId: target.id,
      beforeHostId: targetHost.id,
    });
    expect(moved.folderId).toBe(target.id);
    expect(store.list().filter((host) => host.folderId === target.id).map((host) => host.id))
      .toEqual([first.id, targetHost.id]);
    expect(store.list().filter((host) => host.folderId === source.id).map((host) => host.id))
      .toEqual([second.id]);
    store.moveFolder({ folderId: target.id, beforeFolderId: source.id });

    const after = storedDocument(filePath).hosts.find((host) => host.id === first.id)!;
    for (const field of [
      'protocol',
      'hostname',
      'port',
      'username',
      'authMethod',
      'hostKeyFingerprint',
      'credentialConfigured',
      'credentialReference',
      'revision',
      'createdAt',
      'updatedAt',
    ]) {
      expect(after[field], field).toEqual(before[field]);
    }
    expect(store.credentialReference(first.id)).toBe(`AI Terminal/ssh/${first.id}`);
  });

  it('rejects cross-folder reorder targets and unimplemented protocol persistence', () => {
    const { store } = createStore();
    const left = store.createFolder({ name: 'Left' });
    const right = store.createFolder({ name: 'Right' });
    const leftHost = store.save({ ...sshHost('Left host'), folderId: left.id });
    const rightHost = store.save({ ...sshHost('Right host'), folderId: right.id });

    expect(() => store.moveHost({
      hostId: leftHost.id,
      folderId: left.id,
      beforeHostId: rightHost.id,
    })).toThrow(/destination folder/);
    expect(() => store.save({
      ...sshHost('Future VNC'),
      protocol: 'vnc',
    } as unknown as HostInput)).toThrow(/not implemented/);
  });
});
