import type { SecretStore } from '../providers/secret-store';

const HOST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function hostCredentialReference(hostId: string): string {
  if (!HOST_ID_PATTERN.test(hostId)) throw new Error('Invalid Host credential identifier.');
  return `AI Terminal/ssh/${hostId}`;
}

export class HostCredentialStore {
  constructor(private readonly secrets: SecretStore) {}

  async get(hostId: string, reference: string | undefined): Promise<string | undefined> {
    if (!reference) return undefined;
    this.assertReference(hostId, reference);
    return this.secrets.get(reference);
  }

  async set(hostId: string, credential: string): Promise<string> {
    const reference = hostCredentialReference(hostId);
    await this.secrets.set(reference, credential);
    return reference;
  }

  async remove(hostId: string, reference = hostCredentialReference(hostId)): Promise<void> {
    this.assertReference(hostId, reference);
    await this.secrets.remove(reference);
  }

  private assertReference(hostId: string, reference: string): void {
    if (reference !== hostCredentialReference(hostId)) {
      throw new Error('Invalid Host credential reference.');
    }
  }
}
