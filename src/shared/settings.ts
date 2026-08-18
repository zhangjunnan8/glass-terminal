export type AppTheme = 'system' | 'dark' | 'light';
export type AppLanguage = 'zh-CN' | 'en';

export interface AppSettings {
  schemaVersion: 1;
  theme: AppTheme;
  language: AppLanguage;
  /** Days to retain per-session logs. `0` keeps logs indefinitely. */
  logRetentionDays: number;
  /** Upper bound for a Generic Provider harness turn; 1-64. */
  defaultMaxRounds: number;
  createdAt: string;
  updatedAt: string;
}

/** Fields the Settings window may mutate; the envelope is managed by the store. */
export type AppSettingsPatch = Partial<
  Omit<AppSettings, 'schemaVersion' | 'createdAt' | 'updatedAt'>
>;

export const SETTINGS_CHANNELS = {
  get: 'settings:get',
  update: 'settings:update',
} as const;
