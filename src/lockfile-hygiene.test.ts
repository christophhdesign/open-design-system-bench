// Guard against a private-registry lockfile leaking into the committed tree.
// npm honors `resolved` URLs from package-lock.json regardless of the
// installer's configured registry, so a mirror hostname in the lockfile
// makes `npm install` fail for anyone who cannot reach that host.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_REGISTRY_HOST = 'registry.npmjs.org';

test('package-lock.json resolved URLs use the public npm registry', () => {
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as {
    packages?: Record<string, { resolved?: string }>;
  };
  const hosts = new Set<string>();
  for (const pkg of Object.values(lock.packages ?? {})) {
    if (!pkg.resolved) continue;
    hosts.add(new URL(pkg.resolved).host);
  }
  assert.ok(hosts.size > 0, 'lockfile should contain resolved tarball URLs');
  assert.deepEqual([...hosts].sort(), [PUBLIC_REGISTRY_HOST]);
});
