import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppSettingsStore } from './app-settings-store';

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ai-terminal-settings-'));
  roots.push(root);
  return join(root, 'config', 'app-settings.json');
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('AppSettingsStore', () => {
  it('returns defaults when no file exists', () => {
    const store = new AppSettingsStore(fixture());
    expect(store.get()).toMatchObject({
      schemaVersion: 1,
      theme: 'dark',
      language: 'zh-CN',
      logRetentionDays: 90,
      defaultMaxRounds: 40,
    });
  });

  it('persists updates and reloads them from a fresh instance', () => {
    const path = fixture();
    const store = new AppSettingsStore(path);
    store.update({ theme: 'light', language: 'en', defaultMaxRounds: 20 });

    const reloaded = new AppSettingsStore(path);
    expect(reloaded.get()).toMatchObject({
      theme: 'light',
      language: 'en',
      defaultMaxRounds: 20,
      logRetentionDays: 90,
    });
  });

  it.each([1, 5, 40, 64])('accepts the supported %i-round checkpoint interval', (rounds) => {
    const store = new AppSettingsStore(fixture());
    expect(store.update({ defaultMaxRounds: rounds }).defaultMaxRounds).toBe(rounds);
  });

  it('drops unknown fields and falls back on invalid values', () => {
    const path = fixture();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      theme: 'neon',
      language: 'fr',
      logRetentionDays: -3,
      defaultMaxRounds: 999,
      futureField: 'must be ignored',
    }), 'utf8');

    const store = new AppSettingsStore(path);
    expect(store.get()).toMatchObject({
      schemaVersion: 1,
      theme: 'dark',
      language: 'zh-CN',
      logRetentionDays: 90,
      defaultMaxRounds: 40,
    });
    expect(store.get()).not.toHaveProperty('futureField');
  });
});
