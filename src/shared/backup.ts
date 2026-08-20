export const BACKUP_FORMAT_VERSION = 1 as const;

/** Provider API keys and SSH host credentials share the same SecretStore. */
export const PROVIDER_SECRET_PREFIX = 'AI Terminal/provider/';
export const HOST_SECRET_PREFIX = 'AI Terminal/ssh/';

export interface BackupSectionEnvelope {
  schemaVersion: number;
  /** Inline data for small sections (JSON backups). */
  data?: unknown;
  /** Entry path inside a ZIP archive for large sections (session logs). */
  file?: string;
}

export interface BackupManifest {
  formatVersion: typeof BACKUP_FORMAT_VERSION;
  appVersion: string;
  exportedAt: string;
  sections: Record<string, BackupSectionEnvelope>;
}

export interface BackupExportRequest {
  includeLogs?: boolean;
  /** Defaults to false. Credential-bearing exports are always whole-file encrypted. */
  includeCredentials?: boolean;
  passphrase?: string;
  passphraseConfirmation?: string;
}

export interface HostBackupExportRequest {
  /** Defaults to false. Credential-bearing exports are always whole-file encrypted. */
  includeCredentials?: boolean;
  passphrase?: string;
  passphraseConfirmation?: string;
}

export interface BackupExportResult {
  path: string;
  exportedAt: string;
  sections: string[];
  bytes: number;
  encrypted: boolean;
  credentialsIncluded: boolean;
}

export interface BackupSkippedSection {
  section: string;
  reason: string;
}

export interface BackupImportResult {
  sectionsImported: string[];
  sectionsSkipped: BackupSkippedSection[];
  needsRestart: boolean;
}

export interface BackupImportRequest {
  /** Omitted on the initial file-selection request. */
  token?: string;
  passphrase?: string;
  confirmLegacyPlaintext?: boolean;
}

export interface BackupImportChallenge {
  challenge: 'passphrase-required' | 'legacy-plaintext-confirmation';
  token: string;
  message: string;
}

export type BackupImportResponse = BackupImportResult | BackupImportChallenge;

export const BACKUP_CHANNELS = {
  export: 'backup:export',
  import: 'backup:import',
} as const;

export const HOST_BACKUP_CHANNELS = {
  export: 'host-backup:export',
  import: 'host-backup:import',
} as const;
