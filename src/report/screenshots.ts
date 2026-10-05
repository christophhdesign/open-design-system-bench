// Screenshots of what each cell rendered, for the gallery. For every ok record
// whose workspace/ still exists: restore the node_modules symlink, `vite build`
// into a temp dir, serve it on a loopback port and let headless Chrome write
// <cellDir>/screenshot.png. A failure lands in <cellDir>/screenshot-error.txt
// (first line is the label, e.g. "Build failed in 546ms") so the gallery can
// say why. Both files are cached: a cell is built at most once.
//
// Chrome is the only requirement beyond the fixture's own vite: no Playwright,
// no Puppeteer. CHROME_PATH overrides the lookup.

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ensureWorkspaceNodeModules } from '../run/fixture.ts';
import type { CellRecord, SystemsConfig } from '../types.ts';

const execFileAsync = promisify(execFile);

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

export function findChrome(): string | undefined {
  return CHROME_CANDIDATES.find((p): p is string => !!p && existsSync(p));
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** Serves a built dist dir on a loopback port (ES modules do not load over file://). */
function serveDir(dir: string): Promise<{ url: string; stop: () => void }> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const file = join(dir, path === '/' ? 'index.html' : path);
    if (!file.startsWith(dir) || !existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}/`, stop: () => server.close() });
    }),
  );
}

export type ScreenshotOutcome = 'done' | 'cached' | 'failed' | 'no-workspace';

export async function screenshotCell(opts: {
  runDir: string;
  rec: CellRecord;
  systemsConfig: SystemsConfig;
  chrome: string;
}): Promise<ScreenshotOutcome> {
  const { runDir, rec, chrome } = opts;
  if (!rec.artifacts) return 'no-workspace';
  // Absolute: vite is spawned with cwd=workspace, so a relative runDir would
  // resolve the binary against the workspace and ENOENT.
  const cellDir = resolve(runDir, rec.artifacts.dir);
  const png = join(cellDir, 'screenshot.png');
  const errFile = join(cellDir, 'screenshot-error.txt');
  if (existsSync(png) || existsSync(errFile)) return 'cached';
  const workspace = join(cellDir, 'workspace');
  if (!existsSync(join(workspace, 'package.json'))) return 'no-workspace';

  const dist = mkdtempSync(join(tmpdir(), 'odsys-shot-'));
  const profile = mkdtempSync(join(tmpdir(), 'odsys-chrome-'));
  let unlink = () => {};
  let phase = 'Setup failed';
  const startedAt = Date.now();
  try {
    unlink = ensureWorkspaceNodeModules(workspace, rec.cell.system, opts.systemsConfig[rec.cell.system]);
    phase = 'Build failed';
    await execFileAsync(
      join(workspace, 'node_modules', '.bin', 'vite'),
      ['build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'],
      { cwd: workspace, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
    );
    phase = 'Screenshot failed';
    const { url, stop } = await serveDir(dist);
    let chromeStderr = '';
    try {
      ({ stderr: chromeStderr } = await execFileAsync(
        chrome,
        [
          '--headless=new',
          '--disable-gpu',
          '--no-first-run',
          '--no-default-browser-check',
          '--hide-scrollbars',
          `--user-data-dir=${profile}`,
          '--window-size=1280,900',
          '--virtual-time-budget=3000',
          // Console errors reach stderr as "ERROR:CONSOLE(line)] "message"":
          // a blank screenshot of a page that threw should say so.
          '--enable-logging=stderr',
          '--v=0',
          `--screenshot=${png}`,
          url,
        ],
        { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
      ));
    } finally {
      stop();
    }
    if (!existsSync(png)) throw new Error('Chrome exited without writing a screenshot');
    const consoleErrors = [...chromeStderr.matchAll(/ERROR:CONSOLE\([^)]*\)\] "([^"]*)"/g)].map((m) => m[1]);
    if (consoleErrors.length > 0) writeFileSync(join(cellDir, 'screenshot-console.txt'), consoleErrors.slice(0, 5).join('\n') + '\n');
    return 'done';
  } catch (err) {
    const detail = err instanceof Error ? (err as { stderr?: string }).stderr?.trim() || err.message : String(err);
    writeFileSync(errFile, `${phase} in ${Date.now() - startedAt}ms\n${detail}\n`);
    return 'failed';
  } finally {
    unlink();
    rmSync(dist, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
  }
}
