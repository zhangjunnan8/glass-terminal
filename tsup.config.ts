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
  external: ['electron', 'node-pty', 'ssh2', '@langchain/core', '@langchain/openai', 'zod'],
});
