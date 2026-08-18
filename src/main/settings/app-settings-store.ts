import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AppSettings, AppSettingsPatch } from '../../shared/settings';

const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: 1,
  theme: 'dark',
  language: 'zh-CN',
  logRetentionDays: 90,
  defaultMaxRounds: 40,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

/**
 * Persists non-secret application preferences to a versioned JSON file.
 * Unknown fields are dropped on load and missing fields fall back to defaults,
 * so a file written by a newer version still imports cleanly.
 */
export class AppSettingsStore {
  private current: AppSettings;

  constructor(private readonly path: string) {
    this.current = loadSettings(path);
  }

  get(): AppSettings {
    return cloneSettings(this.current);
  }

  update(patch: AppSettingsPatch): AppSettings {
    const next = normalizeSettings({
      ...this.current,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    this.current = next;
    persist(this.path, next);
    return cloneSettings(next);
  }
}

function loadSettings(path: string): AppSettings {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_SETTINGS };
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('App settings file is malformed.');
  }
  return normalizeSettings(parsed as Partial<AppSettings>);
}

function normalizeSettings(candidate: Partial<AppSettings>): AppSettings {
  const now = new Date().toISOString();
  const createdAt = typeof candidate.createdAt === 'string'
    ? candidate.createdAt
    : DEFAULT_SETTINGS.createdAt;
  return {
    schemaVersion: 1,
    theme: candidate.theme === 'light' || candidate.theme === 'system'
      ? candidate.theme
      : 'dark',
    language: candidate.language === 'en' ? 'en' : 'zh-CN',
    logRetentionDays: isNonNegativeInteger(candidate.logRetentionDays)
      ? candidate.logRetentionDays
      : DEFAULT_SETTINGS.logRetentionDays,
    defaultMaxRounds: isPositiveInteger(candidate.defaultMaxRounds)
      && candidate.defaultMaxRounds <= 64
      ? candidate.defaultMaxRounds
      : DEFAULT_SETTINGS.defaultMaxRounds,
    createdAt: createdAt || now,
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : now,
  };
}

function cloneSettings(settings: AppSettings): AppSettings {
  return { ...settings };
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function persist(path: string, settings: AppSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}
