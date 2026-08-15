import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { launchCodexAppServer } from './app-server-client';
import { bundledCodexCandidates } from './app-server-service';

const enabled = process.env.CODEX_APP_SERVER_REAL_SMOKE === 'true';
const smokeRoot = join(process.cwd(), '.smoke-data', `codex-app-server-${process.pid}`);

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

describe.skipIf(!enabled)('real bundled Codex App Server', () => {
  it('completes initialize and reads the isolated account state', async () => {
    const executable = bundledCodexCandidates(
      process.cwd(),
      process.cwd(),
      process.platform,
      process.arch,
    ).find(existsSync);
    expect(executable, 'bundled Codex CLI is missing').toBeTruthy();
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
