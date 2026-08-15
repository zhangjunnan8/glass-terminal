import { describe, expect, it } from 'vitest';
import { isAllowedCredentialReference } from './secret-store';

describe('Windows Credential Manager reference validation', () => {
  it('allows only Provider and SSH UUID targets', () => {
    expect(isAllowedCredentialReference(
      'AI Terminal/provider/00000000-0000-4000-8000-000000000001',
    )).toBe(true);
    expect(isAllowedCredentialReference(
      'AI Terminal/ssh/00000000-0000-4000-8000-000000000001',
    )).toBe(true);
    expect(isAllowedCredentialReference('AI Terminal/ssh/not-a-uuid')).toBe(false);
    expect(isAllowedCredentialReference(
      'AI Terminal/ssh/00000000-0000-4000-8000-000000000001/extra',
    )).toBe(false);
    expect(isAllowedCredentialReference(
      'Other App/ssh/00000000-0000-4000-8000-000000000001',
    )).toBe(false);
  });
});
