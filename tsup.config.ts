import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', 'main-notice-bridge': 'src/main-notice-bridge.ts' },
  format: ['cjs'],
  target: 'es2020',
  dts: true,
  sourcemap: false,
  clean: true,
  splitting: false,
  minify: false,
  outDir: 'dist',
  external: ['openclaw', /^openclaw\//],
});
