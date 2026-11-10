// Bundles the extension host, the dev harness and every webview entry point.
import * as esbuild from 'esbuild';
import { readdirSync, existsSync } from 'fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const views = readdirSync('webview')
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
  .map((f) => f.replace(/\.ts$/, ''));

const common = { bundle: true, sourcemap: !production, minify: production, logLevel: 'info' };

const configs = [
  {
    ...common,
    entryPoints: ['src/vscode/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: Object.fromEntries(views.map((v) => [v, `webview/${v}.ts`])),
    outdir: 'dist/webview',
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    loader: { '.css': 'css' },
  },
];
if (!production && existsSync('src/harness/server.ts')) {
  configs.push({
    ...common,
    entryPoints: ['src/harness/server.ts'],
    outfile: 'dist/harness.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['ws', 'playwright-core'],
  });
}

if (watch) {
  for (const c of configs) (await esbuild.context(c)).watch();
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
