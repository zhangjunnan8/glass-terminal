export const BACKUP_FORMAT_VERSION = 1 as const;

/** Provider API keys and SSH host credentials share the same SecretStore. */
export const PROVIDER_SECRET_PREFIX = 'AI Terminal/provider/';
export const HOST_SECRET_PREFIX = 'AI Terminal/ssh/';

export interface BackupSectionEnvelope {
  schemaVersion: number;
  data: unknown;
}

export interface BackupManifest {
  formatVersion: typeof BACKUP_FORMAT_VERSION;
  appVersion: string;
  exportedAt: string;
  sections: Record<string, BackupSectionEnvelope>;
}

export interface BackupExportRequest {
  /** Reserved for the optional session-log inclusion phase. */
  includeLogs?: boolean;
}

export interface BackupExportResult {
  path: string;
  exportedAt: string;
  sections: string[];
  bytes: number;
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

export const BACKUP_CHANNELS = {
  export: 'backup:export',
  import: 'backup:import',
} as const;
