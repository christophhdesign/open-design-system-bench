// UI gallery: screenshots of what each agent cell rendered, one task at a time.
// A separate step writes screenshot.png (or screenshot-error.txt) next to each
// cell's artifacts; this module only reads what is on disk and lays it out as
// a self-contained page. The page references the png files by relative path
// (the one intended exception to the inline-everything house style), so it
// must be written to `outDir` for those links to resolve.

import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { recordCostUsd } from '../providers/pricing.ts';
import type { CellRecord, Gate, RunResults } from '../types.ts';
import { contextRank, esc, fmtDate, fmtUsd, page, statusChip } from './shared.ts';

export interface GalleryRun {
  runDir: string;
  results: RunResults;
  /** taskId -> task text, when the tasks dir could be loaded; optional. */
  tasks?: Map<string, { title: string; prompt: string }>;
}

export function loadGalleryRun(runDir: string): GalleryRun {
  return { runDir, results: JSON.parse(readFileSync(join(runDir, 'results.json'), 'utf8')) as RunResults };
}

const GATES: Gate[] = ['pass', 'review', 'fail'];
const f2 = (n: number): string => n.toFixed(2);

/** relative(outDir, file) as a URL path: each segment percent-encoded (cell dirs hold ':', spaces, parentheses). */
function relUrl(outDir: string, file: string): string {
  return relative(outDir, file).split(sep).map(encodeURIComponent).join('/');
}

function gateChips(counts: Record<Gate, number>): string {
  return GATES.filter((g) => counts[g] > 0)
    .map((g) => `<span class="chip chip-${g}">${counts[g]} ${g}</span>`)
    .join(' ');
}

function dimensionsDetails(rec: CellRecord): string {
  const res = rec.result;
  if (!res) return '';
  const dims = Object.values(res.dimensions);
  const notes = res.diffs.filter((d) => d.dimension === 'judgment');
  if (dims.length === 0 && notes.length === 0) return '';
  const label = notes.length > 0 ? `Dimensions · ${notes.length} note${notes.length === 1 ? '' : 's'}` : 'Dimensions';
  const rows = dims
    .map((d) => `<tr><td>${esc(d.dimension)}</td><td class="num">${f2(d.score)}</td><td><span class="chip chip-${d.gate}">${esc(d.gate)}</span></td></tr>`)
    .join('');
  const table = dims.length > 0 ? `<table><thead><tr><th>dimension</th><th>score</th><th>gate</th></tr></thead><tbody>${rows}</tbody></table>` : '';
  const list = notes.length > 0 ? `<ul class="notes">${notes.map((n) => `<li>${esc(n.message)}</li>`).join('')}</ul>` : '';
  return `<details><summary>${label}</summary>${table}${list}</details>`;
}

function renderCard(run: GalleryRun, rec: CellRecord, outDir: string): string {
  const res = rec.result;
  const dir = rec.status === 'ok' && rec.artifacts ? join(run.runDir, rec.artifacts.dir) : undefined;
  const png = dir ? join(dir, 'screenshot.png') : undefined;
  const errFile = dir ? join(dir, 'screenshot-error.txt') : undefined;
  const hasPng = png != null && existsSync(png);

  let shot: string;
  if (hasPng) {
    const alt = `rep ${rec.rep} screenshot of ${rec.taskId} under ${rec.cell.context}`;
    shot = `<div class="shot"><img src="${esc(relUrl(outDir, png))}" alt="${esc(alt)}" loading="lazy"></div>`;
    // Console errors Chrome saw while rendering: a blank screenshot of a page
    // that threw at runtime should not pass as "rendered nothing".
    const consoleFile = join(dir!, 'screenshot-console.txt');
    if (existsSync(consoleFile)) {
      const first = readFileSync(consoleFile, 'utf8').trim().split(/\r?\n/)[0] ?? '';
      shot += `<div class="err rt">Runtime error: ${esc(first.slice(0, 160))}</div>`;
    }
  } else if (errFile != null && existsSync(errFile)) {
    // First line is the label ("Build failed in 546ms"), the next three are the detail.
    const [first, ...rest] = readFileSync(errFile, 'utf8').trim().split(/\r?\n/);
    const label = first?.trim() || 'Screenshot failed';
    shot = `<div class="shot empty"><div class="err">${esc(label)}</div><pre>${esc(rest.slice(0, 3).join('\n'))}</pre></div>`;
  } else if (rec.status === 'ok') {
    shot = '<div class="shot empty"><div class="na">no screenshot</div><div class="hint">run <code>gallery</code> on a machine with Chrome and the run\'s workspaces</div></div>';
  } else {
    shot = `<div class="shot empty"><div class="na">${rec.skipReason ? esc(rec.skipReason) : 'no result'}</div></div>`;
  }

  const links: string[] = [];
  if (hasPng) links.push(`<a href="${esc(relUrl(outDir, png))}" target="_blank" rel="noopener">Open full size</a>`);
  if (rec.agentMeta?.numTurns != null) links.push(`${esc(rec.agentMeta.numTurns)} turns`);
  const cost = recordCostUsd(rec);
  if (typeof cost === 'number' && Number.isFinite(cost)) links.push(esc(fmtUsd(cost)));

  const head = res
    ? `<span class="score">${f2(res.overall)}</span> <span class="chip chip-${res.gate}">${esc(res.gate)}</span>`
    : statusChip(rec.status);
  const data = res ? ` data-overall="${res.overall}" data-gate="${res.gate}"` : ' data-gate="none"';
  return `<article class="gcard${res && res.gate !== 'pass' ? ` gate-${res.gate}` : ''}"${data} data-rep="${rec.rep}">
  <div class="ghead"><span class="rep">rep${rec.rep}</span><span>${head}</span></div>
  ${shot}
  ${links.length > 0 ? `<div class="gfoot">${links.join(' · ')}</div>` : ''}
  ${dimensionsDetails(rec)}
</article>`;
}

interface RowKey {
  system: string;
  context: string;
  model: string;
}

function renderRow(run: GalleryRun, taskId: string, key: RowKey, recs: CellRecord[], labels: { model: boolean; system: boolean }, outDir: string): string {
  const scored = recs.filter((r) => r.result);
  const mean = scored.length > 0 ? f2(scored.reduce((s, r) => s + r.result!.overall, 0) / scored.length) : 'n/a';
  const counts: Record<Gate, number> = { pass: 0, review: 0, fail: 0 };
  for (const r of scored) counts[r.result!.gate]++;
  const sub = [labels.model ? key.model : '', labels.system ? key.system : ''].filter(Boolean);
  return `<div class="grow" data-run="${esc(run.results.runId)}" data-task="${esc(taskId)}" data-context="${esc(key.context)}">
  <div class="glabel">
    <div class="ctx">${esc(key.context)}</div>
    ${sub.map((s) => `<div class="sub">${esc(s)}</div>`).join('')}
    <div class="mean"><span class="mean-val">${mean}</span><span class="mean-cap">mean of ${scored.length} shown</span></div>
    <div class="gates">${gateChips(counts)}</div>
  </div>
  <div class="gcards">${recs.map((r) => renderCard(run, r, outDir)).join('\n')}</div>
</div>`;
}

function renderSection(run: GalleryRun, taskId: string, outDir: string): string {
  const recs = run.results.records.filter((r) => r.taskId === taskId);
  const text = run.tasks?.get(taskId);
  const title = text?.title && text.title !== taskId ? `${esc(text.title)} <span class="tid">${esc(taskId)}</span>` : esc(taskId);
  const labels = {
    model: new Set(run.results.records.map((r) => r.cell.model)).size > 1,
    system: new Set(run.results.records.map((r) => r.cell.system)).size > 1,
  };
  const groups = new Map<string, { key: RowKey; recs: CellRecord[] }>();
  for (const r of recs) {
    const key = { system: r.cell.system, context: r.cell.context, model: r.cell.model };
    const id = JSON.stringify(key);
    if (!groups.has(id)) groups.set(id, { key, recs: [] });
    groups.get(id)!.recs.push(r);
  }
  const rows = [...groups.values()]
    .sort((a, b) => a.key.system.localeCompare(b.key.system) || contextRank(a.key.context) - contextRank(b.key.context) || a.key.model.localeCompare(b.key.model))
    .map((g) => renderRow(run, taskId, g.key, g.recs.sort((a, b) => a.rep - b.rep), labels, outDir));
  return `<section class="gtask" data-run="${esc(run.results.runId)}" data-task="${esc(taskId)}">
<h2>${title}</h2>
${text?.prompt ? `<p class="prompt">${esc(text.prompt)}</p>` : ''}
${rows.length > 0 ? rows.join('\n') : '<p class="na">no cells for this task in this run</p>'}
</section>`;
}

const GALLERY_CSS = `
[hidden]{display:none!important}
.wrap.gallery{max-width:none;padding-top:8px}
.gbar{position:sticky;top:0;z-index:10;background:var(--bg);border-bottom:1px solid var(--border);padding:10px 28px;display:flex;flex-wrap:wrap;align-items:center;gap:8px 18px}
.gbar h1{font-size:18px;font-weight:700}
.gbar .gmeta{color:var(--muted);font-family:var(--font-mono);font-size:12px}
.gbar .gctl{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;font-size:13px}
.gbar label{display:inline-flex;align-items:center;gap:6px;color:var(--muted)}
.gbar select,.gbar input{color-scheme:dark;font:inherit;color:var(--ink)}
.gbar select{background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r-sm);padding:3px 6px}
.gtask>h2{font-size:20px}
.gtask .tid{font-family:var(--font-mono);font-size:12px;font-weight:400;color:var(--muted);margin-left:6px}
.gtask .prompt{color:var(--muted);max-width:100ch;white-space:pre-wrap;margin:6px 0 16px;font-size:13.5px}
.grow{display:flex;flex-wrap:wrap;gap:12px 18px;padding:16px 0;border-top:1px solid var(--border)}
.glabel{flex:0 0 150px;display:flex;flex-direction:column;gap:4px;align-items:flex-start}
.glabel .ctx{font-weight:650;font-size:15px}
.glabel .sub{color:var(--muted);font-family:var(--font-mono);font-size:11px;overflow-wrap:anywhere}
.glabel .mean-val{font-family:var(--font-mono);font-size:20px;font-weight:700;display:block}
.glabel .mean-cap{color:var(--muted);font-size:11px}
.glabel .gates{display:flex;flex-wrap:wrap;gap:4px}
.gcards{flex:1 1 0;min-width:0;display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start}
.gcard{width:min(var(--card-w,320px),100%);background:var(--surface);border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden}
.gcard.gate-fail{border-color:var(--red)}
.gcard.gate-review{border-color:var(--yellow)}
.gcard .ghead{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:7px 10px;font-size:13px}
.gcard .rep{font-family:var(--font-mono);font-weight:600}
.gcard .score{font-family:var(--font-mono);font-weight:700;margin-right:4px}
.shot{aspect-ratio:1280/900;background:#fff;overflow:hidden}
.shot img{display:block;width:100%;height:100%;object-fit:contain}
.shot.empty{background:var(--surface-2);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:12px;text-align:center;overflow:auto}
.shot .err{color:var(--red);font-family:var(--font-mono);font-size:13px;font-weight:600}
.shot pre{margin:0;max-width:100%;white-space:pre-wrap;overflow-wrap:anywhere;text-align:left;color:var(--muted);font-family:var(--font-mono);font-size:11px}
.shot .hint{color:var(--muted);font-size:11px}
.gfoot{padding:6px 10px;color:var(--muted);font-family:var(--font-mono);font-size:11.5px}
.gcard details{border-top:1px solid var(--border);padding:6px 10px;font-size:12px}
.gcard summary{cursor:pointer;color:var(--muted)}
.gcard table{margin-top:6px;font-size:12px}
.gcard th,.gcard td{padding:3px 6px}
.gcard ul.notes{margin:8px 0 2px;padding-left:18px;color:var(--ink)}
.gcard ul.notes li{margin-bottom:4px}
@media (max-width:640px){.gbar{padding:10px 16px}.wrap.gallery{padding:8px 16px 60px}.glabel{flex:1 0 100%}}
`;

// Plain string (no template placeholders, no backticks): the page has no other script.
const GALLERY_SCRIPT = `
(function () {
  var KEY = 'odsb-gallery';
  var $ = function (id) { return document.getElementById(id); };
  var gate = $('g-gate'), run = $('g-run'), task = $('g-task'), size = $('g-size');
  var all = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };
  var boxes = all('input[data-ctx]'), sections = all('section[data-task]'), rows = all('.grow');
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) {}
  function restore(el, v) {
    if (v != null && Array.prototype.some.call(el.options, function (o) { return o.value === v; })) el.value = v;
  }
  restore(task, saved.task);
  restore(gate, saved.gate);
  if (saved.size >= 240 && saved.size <= 720) size.value = saved.size;
  function apply() {
    document.documentElement.style.setProperty('--card-w', size.value + 'px');
    var off = {};
    boxes.forEach(function (b) { if (!b.checked) off[b.value] = true; });
    sections.forEach(function (s) {
      s.hidden = s.getAttribute('data-task') !== task.value || (run != null && s.getAttribute('data-run') !== run.value);
    });
    rows.forEach(function (row) {
      row.hidden = !!off[row.getAttribute('data-context')];
      var sum = 0, n = 0, counts = { pass: 0, review: 0, fail: 0 };
      Array.prototype.forEach.call(row.querySelectorAll('.gcard'), function (c) {
        var g = c.getAttribute('data-gate');
        var show = gate.value === 'all' || g === gate.value;
        c.hidden = !show;
        if (show && c.hasAttribute('data-overall')) { sum += parseFloat(c.getAttribute('data-overall')); n++; counts[g]++; }
      });
      row.querySelector('.mean-val').textContent = n > 0 ? (sum / n).toFixed(2) : 'n/a';
      row.querySelector('.mean-cap').textContent = 'mean of ' + n + ' shown';
      row.querySelector('.gates').innerHTML = ['pass', 'review', 'fail'].filter(function (g) { return counts[g] > 0; })
        .map(function (g) { return '<span class="chip chip-' + g + '">' + counts[g] + ' ' + g + '</span>'; }).join(' ');
    });
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({ task: task.value, gate: gate.value, size: +size.value })); } catch (e) {}
  }
  [gate, task, size].forEach(function (el) { el.addEventListener(el === size ? 'input' : 'change', function () { apply(); save(); }); });
  if (run) run.addEventListener('change', apply);
  boxes.forEach(function (b) { b.addEventListener('change', apply); });
  apply();
})();
`;

const option = (value: string, label = value, selected = false): string =>
  `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;

export function renderGalleryHtml(runs: GalleryRun[], opts: { outDir: string; generatedAt?: string }): string {
  const records = runs.flatMap((r) => r.results.records);
  const taskIds = [...new Set(records.map((r) => r.taskId))].sort();
  const contexts = [...new Set(records.map((r) => r.cell.context as string))].sort((a, b) => contextRank(a) - contextRank(b) || a.localeCompare(b));
  const multiRun = runs.length > 1;

  const meta = multiRun ? `${runs.length} runs · ${records.length} cells` : `${runs[0]?.results.runId ?? 'no run'} · ${records.length} cells`;
  const controls = [
    ...contexts.map((c) => `<label><input type="checkbox" data-ctx value="${esc(c)}" checked> ${esc(c)}</label>`),
    `<label>Gate <select id="g-gate">${['all', ...GATES].map((g) => option(g)).join('')}</select></label>`,
    multiRun ? `<label>Run <select id="g-run">${runs.map((r, i) => option(r.results.runId, r.results.runId, i === 0)).join('')}</select></label>` : '',
    `<label>Task <select id="g-task">${taskIds.map((t, i) => option(t, t, i === 0)).join('')}</select></label>`,
    '<label>Size <input type="range" id="g-size" min="240" max="720" step="10" value="320"></label>',
  ].join('\n    ');

  const sections = runs.flatMap((run) => taskIds.map((t) => renderSection(run, t, opts.outDir)));
  const body = `<style>${GALLERY_CSS}</style>
<header class="gbar">
  <h1>UI gallery</h1>
  <span class="gmeta">${esc(meta)}</span>
  <div class="gctl">
    ${controls}
  </div>
</header>
<main class="wrap gallery">
${sections.length > 0 ? sections.join('\n') : '<p class="na">no cell records in this run</p>'}
<footer class="foot">generated ${esc(fmtDate(opts.generatedAt ?? new Date().toISOString()))}</footer>
</main>`;
  return page(`UI gallery · ${runs.map((r) => r.results.runId).join(', ')}`, body, GALLERY_SCRIPT);
}
