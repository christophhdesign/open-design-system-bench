// Expand test files in process, then hand Node an explicit list.
// Node 20's test runner has no glob support, and `src/**/*.test.ts` in an npm
// script is not portable: some shells expand it one directory deep, others
// pass the pattern through literally, and either way src/*.test.ts is missed.

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const files = readdirSync(src, { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => join(src, f))
  .sort();

if (files.length === 0) {
  console.error('No test files found under src/');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], {
  stdio: 'inherit',
  cwd: root,
});
process.exit(result.status === null ? 1 : result.status);
