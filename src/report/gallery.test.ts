// Gallery verification: synthetic run dirs on disk (results.json + cells/.../screenshot.png),
// rendered through renderGalleryHtml. No live agent, provider or browser is ever touched.

import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import type { CellRecord, CellStatus, ContextLevel, Gate, RunManifest, RunResults } from '../types.ts';
import { cellKey } from '../types.ts';
import { buildRunResults } from './aggregate.ts';
import { loadGalleryRun, renderGalleryHtml } from './gallery.ts';

const tmp = mkdtempSync(join(tmpdir(), 'odsys-gallery-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const GENERATED_AT = '2026-10-05T00:00:00Z';
// A relative <img src> / <a href> to the png files is intended; anything that reaches the network is not.
const FORBIDDEN_PATTERNS = ['<script src=', '<link ', 'fetch(', 'url(http'];
// A real 1x1 png, so the demo page shows an image rather than a broken-image icon.
const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

interface Spec {
  context: ContextLevel;
  taskId: string;
  model?: string;
  system?: string;
  rep?: number;
  status?: CellStatus;
  skipReason?: string;
  overall?: number;
  gate?: Gate;
  /** Write screenshot.png into the cell dir. */
  png?: boolean;
  /** Write screenshot-error.txt with this text into the cell dir. */
  error?: string;
  numTurns?: number;
  costUsd?: number;
  /** Judge notes, as diffs with dimension 'judgment'. */
  notes?: string[];
}

function writeRun(runId: string, specs: Spec[]): { dir: string; results: RunResults } {
  const dir = join(tmp, runId);
  mkdirSync(dir, { recursive: true });

  const records: CellRecord[] = specs.map((s) => {
    const status = s.status ?? 'ok';
    const cell = { system: s.system ?? 'sysA', context: s.context, model: s.model ?? 'sonnet', agent: 'claude-code' };
    const rec: CellRecord = { cell, taskId: s.taskId, rep: s.rep ?? 1, status };
    if (s.skipReason) rec.skipReason = s.skipReason;
    if (s.numTurns != null || s.costUsd != null) rec.agentMeta = { durationMs: 1000, numTurns: s.numTurns, costUsd: s.costUsd };
    if (status !== 'ok') return rec;

    const artifactDir = `cells/${cellKey(cell)}/${s.taskId}/rep${rec.rep}`;
    rec.artifacts = { dir: artifactDir };
    const overall = s.overall ?? 80;
    const gate = s.gate ?? 'pass';
    rec.result = {
      overall,
      gate,
      dimensions: { imports: { dimension: 'imports', score: overall, gate, diffs: [] } },
      diffs: (s.notes ?? []).map((message) => ({ dimension: 'judgment', message })),
    };
    mkdirSync(join(dir, artifactDir), { recursive: true });
    if (s.png) writeFileSync(join(dir, artifactDir, 'screenshot.png'), PNG_BYTES);
    if (s.error != null) writeFileSync(join(dir, artifactDir, 'screenshot-error.txt'), s.error);
    return rec;
  });

  const manifest: RunManifest = {
    runId,
    profile: 'smoke',
    startedAt: '2026-10-05T09:00:00.000Z',
    nodeVersion: process.version,
    adapters: { 'claude-code': { version: '1.2.3' } },
    systems: {},
    cells: records.map((r) => ({
      spec: { system: r.cell.system, context: r.cell.context, model: r.cell.model, agent: r.cell.agent, taskId: r.taskId, rep: r.rep },
      status: r.status,
    })),
  };
  const results = buildRunResults(manifest, records);
  writeFileSync(join(dir, 'results.json'), JSON.stringify(results, null, 2));
  return { dir, results };
}

function render(dirs: string[], outDir = tmp, tasks?: Map<string, { title: string; prompt: string }>): string {
  const runs = dirs.map(loadGalleryRun);
  if (tasks) runs[0]!.tasks = tasks;
  return renderGalleryHtml(runs, { outDir, generatedAt: GENERATED_AT });
}

const cards = (html: string): string[] => html.match(/<article [\s\S]*?<\/article>/g) ?? [];
const rows = (html: string): string[] => html.match(/<div class="grow"[\s\S]*?<\/article>\s*<\/div>\s*<\/div>/g) ?? [];

test('a cell with screenshot.png renders an <img> with the encoded relative path and an "Open full size" link', () => {
  const model = 'nexos:DeepSeek V4 Flash (Trusted)';
  const { dir } = writeRun('run-img', [{ context: 'bare', taskId: 'task-a', system: 'appkit', model, png: true, numTurns: 7, costUsd: 0.1234 }]);
  const outDir = join(tmp, 'out', 'gallery');
  const html = render([dir], outDir);

  const expected = `../../run-img/cells/appkit_bare_nexos%3ADeepSeek%20V4%20Flash%20(Trusted)/task-a/rep1/screenshot.png`;
  const [card] = cards(html);
  assert.ok(card, 'one card');
  assert.ok(card.includes(`<img src="${expected}"`), `img src should be ${expected}`);
  assert.match(card, /alt="rep 1 screenshot of task-a under bare" loading="lazy"/);
  assert.ok(card.includes(`<a href="${expected}" target="_blank" rel="noopener">Open full size</a>`));
  assert.match(card, /7 turns/);
  assert.match(card, /\$0\.12/);
});

test('screenshot-error.txt: first line is the red label, the next lines are the escaped detail', () => {
  const { dir } = writeRun('run-err', [
    { context: 'bare', taskId: 'task-a', error: 'Build failed in 546ms\nerror TS2322: <Button> is not assignable & so on\nline 3\nline 4\nline 5\n' },
    { context: 'skill', taskId: 'task-a', error: '' },
  ]);
  const [bare, skill] = cards(render([dir]));
  assert.ok(bare!.includes('<div class="err">Build failed in 546ms</div>'));
  assert.ok(bare!.includes('error TS2322: &lt;Button&gt; is not assignable &amp; so on\nline 3\nline 4'));
  assert.ok(!bare!.includes('line 5'), 'only three detail lines');
  assert.ok(!bare!.includes('<img') && !bare!.includes('Open full size'));
  assert.ok(skill!.includes('<div class="err">Screenshot failed</div>'), 'empty file falls back to a generic label');
});

test('no screenshot at all says so; a non-ok record shows its status chip and no <img>', () => {
  const { dir } = writeRun('run-none', [
    { context: 'bare', taskId: 'task-a', rep: 1 },
    { context: 'bare', taskId: 'task-a', rep: 2, status: 'agent-error', skipReason: 'usage <limit>' },
  ]);
  const [ok, bad] = cards(render([dir]));
  assert.match(ok!, /no screenshot/);
  assert.match(ok!, /<code>gallery<\/code>/);
  assert.ok(!ok!.includes('<img'));

  assert.match(bad!, /<span class="chip chip-skip">agent error<\/span>/);
  assert.ok(bad!.includes('usage &lt;limit&gt;'));
  assert.ok(!bad!.includes('<img') && !bad!.includes('Open full size') && !bad!.includes('no screenshot'));
  assert.match(bad!, /data-gate="none"/);
  assert.ok(!bad!.includes('data-overall'));
});

test('rows follow contextRank, cards carry data-overall/data-gate, row label shows the two-decimal mean', () => {
  const { dir } = writeRun('run-rows', [
    { context: 'skill', taskId: 'task-a', overall: 90 },
    { context: 'bare', taskId: 'task-a', rep: 2, overall: 50.5, gate: 'fail' },
    { context: 'bare', taskId: 'task-a', rep: 1, overall: 71, gate: 'review', notes: ['Looks <cramped>'] },
    { context: 'agents-md', taskId: 'task-a', overall: 60 },
    { context: 'bare', taskId: 'task-a', rep: 3, overall: 80 },
  ]);
  const html = render([dir]);
  const rs = rows(html);
  assert.deepEqual(rs.map((r) => r.match(/data-context="([^"]*)"/)![1]), ['bare', 'agents-md', 'skill']);

  const bare = rs[0]!;
  assert.match(bare, /<span class="mean-val">67\.17<\/span><span class="mean-cap">mean of 3 shown<\/span>/);
  assert.match(bare, /<span class="chip chip-pass">1 pass<\/span> <span class="chip chip-review">1 review<\/span> <span class="chip chip-fail">1 fail<\/span>/);
  assert.deepEqual([...bare.matchAll(/data-rep="(\d)"/g)].map((m) => m[1]), ['1', '2', '3'], 'reps in order');
  const [rep1, rep2] = cards(bare);
  assert.match(rep1!, /data-overall="71" data-gate="review"/);
  assert.match(rep1!, /gcard gate-review/);
  assert.match(rep2!, /data-overall="50.5" data-gate="fail"/);
  assert.match(rep2!, /gcard gate-fail/);
  assert.match(rep1!, /<summary>Dimensions · 1 note<\/summary>/);
  assert.ok(rep1!.includes('<li>Looks &lt;cramped&gt;</li>'));
  assert.match(rep1!, /<td>imports<\/td><td class="num">71\.00<\/td>/);
  assert.match(rep2!, /<summary>Dimensions<\/summary>/);
  assert.match(html, /<span class="gmeta">run-rows · 5 cells<\/span>/);
  assert.deepEqual([...html.matchAll(/<input type="checkbox" data-ctx value="([^"]*)" checked>/g)].map((m) => m[1]), ['bare', 'agents-md', 'skill']);
});

test('Run select only for several runs (one section per run); task text and model labels come through', () => {
  const one = writeRun('run-one', [
    { context: 'bare', taskId: 'task-b' },
    { context: 'bare', taskId: 'task-a', model: 'sonnet' },
    { context: 'bare', taskId: 'task-a', model: 'opus' },
  ]);
  const two = writeRun('run-two', [{ context: 'bare', taskId: 'task-a' }]);

  const single = render([one.dir], tmp, new Map([['task-a', { title: 'Add <Bulk> actions', prompt: 'Build "it" & ship' }]]));
  assert.ok(!single.includes('id="g-run"'), 'no Run select for one run');
  assert.deepEqual([...single.matchAll(/<option value="([^"]*)"( selected)?>/g)].filter((m) => m[1]!.startsWith('task-')).map((m) => m[1]), ['task-a', 'task-b']);
  assert.match(single, /<option value="task-a" selected>/);
  assert.ok(single.includes('<h2>Add &lt;Bulk&gt; actions <span class="tid">task-a</span></h2>'));
  assert.ok(single.includes('<p class="prompt">Build &quot;it&quot; &amp; ship</p>'));
  assert.match(single, /<h2>task-b<\/h2>/, 'no task text: bare id');
  const taskA = single.match(/<section class="gtask" data-run="run-one" data-task="task-a">[\s\S]*?<\/section>/)![0];
  assert.ok(taskA.includes('<div class="sub">opus</div>') && taskA.includes('<div class="sub">sonnet</div>'), 'two models: model under the context');
  assert.equal((taskA.match(/class="grow"/g) ?? []).length, 2);

  const multi = render([one.dir, two.dir]);
  assert.match(multi, /<select id="g-run">/);
  assert.match(multi, /<span class="gmeta">2 runs · 4 cells<\/span>/);
  assert.equal((multi.match(/<section class="gtask" data-run="run-one"/g) ?? []).length, 2);
  assert.equal((multi.match(/<section class="gtask" data-run="run-two"/g) ?? []).length, 2);
  assert.match(multi, /<section class="gtask" data-run="run-two" data-task="task-b">\s*<h2>task-b<\/h2>\s*<p class="na">no cells/);
});

test('page is self-contained, loadGalleryRun round-trips results.json, demo page is written', () => {
  const { dir, results } = writeRun('run-self', [
    { context: 'bare', taskId: 'task-a', png: true, overall: 88.4 },
    { context: 'bare', taskId: 'task-a', rep: 2, error: 'Build failed in 546ms\nboom', overall: 40, gate: 'fail' },
    { context: 'skill', taskId: 'task-a', status: 'timeout' },
  ]);
  assert.deepEqual(loadGalleryRun(dir), { runDir: dir, results });

  const outDir = mkdtempSync(join(tmpdir(), 'odsys-gallery-demo-'));
  const html = render([dir], outDir);
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.match(html, /<title>UI gallery · run-self<\/title>/);
  for (const pattern of FORBIDDEN_PATTERNS) {
    assert.ok(!html.includes(pattern), `gallery html should not contain ${JSON.stringify(pattern)}`);
  }
  assert.equal((html.match(/<script/g) ?? []).length, 1, 'one inline script');
  assert.match(html, /setProperty\('--card-w'/);
  assert.match(html, /localStorage/);

  // Demo for a human: the page sits next to a copy of the run so the png links resolve.
  const demo = join(outDir, 'gallery.html');
  cpSync(dir, join(outDir, 'run-self'), { recursive: true });
  writeFileSync(demo, render([join(outDir, 'run-self')], outDir));
  console.log(`demo gallery: ${demo}`);
});
