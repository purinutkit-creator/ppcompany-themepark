import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', migrate: 'src/db/migrate.ts', seed: 'src/db/seed.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: ['@kiosk/shared'],
  // Bundled CJS deps (qrcode via shared) need require() in ESM output.
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  onSuccess: 'cp -r src/db/migrations dist/migrations',
});
