import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { launchCodexAppServer } from './app-server-client';
import {
  bundledCodexCandidates,
  CodexAppServerService,
  installedCodexCandidates,
  probeCodexExecutable,
} from './app-server-service';

const enabled = process.env.CODEX_APP_SERVER_REAL_SMOKE === 'true';
const smokeRoot = join(tmpdir(), `glass-terminal-codex-app-server-${process.pid}`);

afterAll(async () => {
  for (let attempt = 0; attempt < 20 && existsSync(smokeRoot); attempt += 1) {
    try {
      rmSync(smokeRoot, { recursive: true, force: true });
    } catch (error) {
      if (attempt === 19) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
  }
});

describe.skipIf(!enabled)('real Codex App Server', () => {
  it('auto-detects a launchable installation and reaches ready state', async () => {
    const service = new CodexAppServerService(
      join(smokeRoot, 'service-config.json'),
      process.cwd(),
      process.cwd(),
      'integration-test',
      async () => undefined,
    );
    try {
      const state = await service.start();
      expect(state).toMatchObject({
        phase: 'ready',
        executable: {
          source: expect.stringMatching(/^(bundled|path)$/),
          version: expect.stringMatching(/^codex-cli\s+/i),
        },
        requiresOpenaiAuth: expect.any(Boolean),
      });
    } finally {
      service.close();
    }
  }, 45_000);

  it('completes initialize and reads the isolated account state', async () => {
    const configured = process.env.CODEX_APP_SERVER_EXECUTABLE;
    const candidates = [
      ...(configured && isAbsolute(configured) ? [configured] : []),
      ...bundledCodexCandidates(
        process.cwd(),
        process.cwd(),
        process.platform,
        process.arch,
      ),
      ...installedCodexCandidates(process.env, process.platform, process.arch),
    ];
    let executable: string | undefined;
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      try {
        await probeCodexExecutable(candidate);
        executable = candidate;
        break;
      } catch {
        // Continue past inaccessible Windows app aliases and stale installations.
      }
    }
    expect(executable, 'no launchable Codex CLI was discovered').toBeTruthy();
    const codexHome = join(smokeRoot, 'codex-home');
    const workingDirectory = join(smokeRoot, 'server-cwd');
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(workingDirectory, { recursive: true });

    const connection = await launchCodexAppServer(executable!, 'integration-test', {
      codexHome,
      workingDirectory,
    });
    try {
      const account = await connection.request<Record<string, unknown>>(
        'account/read',
        { refreshToken: false },
        30_000,
      );
      expect(account).toEqual(expect.objectContaining({
        requiresOpenaiAuth: expect.any(Boolean),
      }));
    } finally {
      connection.close();
    }
  }, 45_000);
});
