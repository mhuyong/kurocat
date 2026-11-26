// Bundles tests/*.test.ts with esbuild and runs them with Node's built-in test runner.
import { build } from 'esbuild';
import { readdirSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'node_modules', '.cache', 'frontend-tests');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const entries = readdirSync(join(root, 'tests'))
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => join(root, 'tests', f));

await build({
  entryPoints: entries,
  outdir: outDir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
  logLevel: 'warning',
});

const files = readdirSync(outDir)
  .filter((f) => f.endsWith('.test.mjs'))
  .map((f) => join(outDir, f));
const res = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(res.status ?? 1);
