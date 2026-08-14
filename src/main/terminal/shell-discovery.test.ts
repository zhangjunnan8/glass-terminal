import { describe, expect, it } from 'vitest';
import { discoverShells } from './shell-discovery';

describe('discoverShells', () => {
  it('returns only executable profiles with stable ids', () => {
    const profiles = discoverShells();
    expect(profiles.length).toBeGreaterThan(0);
    expect(new Set(profiles.map((profile) => profile.id)).size).toBe(profiles.length);
    for (const profile of profiles) {
      expect(profile.command.length).toBeGreaterThan(0);
      expect(profile.label.length).toBeGreaterThan(0);
    }
  });

  it.runIf(process.platform === 'win32')('detects standard Windows shells', () => {
    const ids = discoverShells().map((profile) => profile.id);
    expect(ids).toContain('windows-powershell');
    expect(ids).toContain('command-prompt');
  });
});
