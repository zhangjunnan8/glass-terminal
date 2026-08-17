import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    main: 'src/main/index.ts',
    preload: 'src/preload/index.ts',
  },
  outDir: 'dist-electron',
  format: ['cjs'],
  outExtension: () => ({ js: '.cjs' }),
  platform: 'node',
  target: 'node22',
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ['electron', 'node-pty', 'ssh2'],
  // LangChain is ESM-only; bundling converts it to CJS so the Electron main
  // process can load it without ERR_REQUIRE_ESM. zod is bundled alongside so
  // its `zod/v3` subpath (used internally by @langchain/core) resolves too.
  noExternal: ['@langchain/core', '@langchain/openai', 'zod'],
});
