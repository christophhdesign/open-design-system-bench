// Shared rendering helpers for the self-contained HTML reports (html.ts, compare.ts).
// Every report is one inline-everything file — no external fonts/scripts/styles,
// no fetch(), no <link>, nothing that touches the network — so it stays safe to
// email or archive next to a ticket. Mirrors the house style set by
// motion-perf-gate/src/report-html.mjs (same idea: pull shared bits into one
// module and inline the whole thing at generation time).

import type { CellRecord, CellStatus, Gate } from '../types.ts';
import { BENCH_VERSION } from '../version.ts';

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]!);
}

export type ScoreTone = 'green' | 'yellow' | 'red';

/** green >=85 / yellow >=60 / red <60, per the report spec. */
export function scoreTone(score: number): ScoreTone {
  if (score >= 85) return 'green';
  if (score >= 60) return 'yellow';
  return 'red';
}

const GATE_CHIP_CLASS: Record<Gate, string> = {
  pass: 'chip-pass',
  review: 'chip-review',
  fail: 'chip-fail',
};

export function gateChip(gate: Gate): string {
  return `<span class="chip ${GATE_CHIP_CLASS[gate]}">${esc(gate)}</span>`;
}

const STATUS_LABEL: Record<CellStatus, string> = {
  ok: 'ok',
  'agent-error': 'agent error',
  timeout: 'timeout',
  skipped: 'skipped',
};

export function statusChip(status: CellStatus): string {
  const cls = status === 'ok' ? 'chip-pass' : 'chip-skip';
  return `<span class="chip ${cls}">${esc(STATUS_LABEL[status])}</span>`;
}

export function fmtScore(score: number | undefined | null): string {
  if (score == null || Number.isNaN(score)) return 'n/a';
  return score.toFixed(1);
}

export function fmtUsd(usd: number | undefined | null): string {
  if (usd == null || Number.isNaN(usd)) return 'n/a';
  const abs = Math.abs(usd);
  if (abs === 0) return '$0.00';
  if (abs >= 0.01) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4)}`;
}

export function fmtTokens(n: number | undefined | null): string {
  if (n == null || Number.isNaN(n)) return 'n/a';
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** `8.1k in · 1.2k out`, or null when neither count was recorded. */
export function fmtTokenPair(input?: number | null, output?: number | null): string | null {
  if (input == null && output == null) return null;
  return `${fmtTokens(input ?? 0)} in · ${fmtTokens(output ?? 0)} out`;
}

export function fmtMs(ms: number | undefined | null): string {
  if (ms == null || Number.isNaN(ms)) return 'n/a';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const totalMin = Math.floor(totalSec / 60);
  const remSec = Math.round(totalSec - totalMin * 60);
  if (totalMin < 60) return `${totalMin}m ${remSec}s`;
  const hrs = Math.floor(totalMin / 60);
  const remMin = totalMin - hrs * 60;
  return `${hrs}h ${remMin}m`;
}

export function fmtDate(iso: string | undefined): string {
  if (!iso) return 'n/a';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

/** Canonical column ordering so context levels always read bare → agents-md → skill → mcp. */
export const CONTEXT_ORDER = ['bare', 'agents-md', 'skill', 'mcp'] as const;

export function contextRank(context: string): number {
  const idx = (CONTEXT_ORDER as readonly string[]).indexOf(context);
  return idx === -1 ? CONTEXT_ORDER.length : idx;
}

/**
 * A thin score bar: the numeric score always stays visible next to it, so
 * the bar is a second signal, never the only one (ui-ux-pro-max heatmap
 * guidance: print values in cells, do not rely on colour alone). Width is
 * the score clamped to 0-100; colour follows the shared score tones.
 */
export function scoreBar(score: number | undefined | null): string {
  if (score == null || Number.isNaN(score)) return '';
  const pct = Math.max(0, Math.min(100, score));
  return `<span class="score-bar tone-${scoreTone(score)}" aria-hidden="true"><span class="score-bar-fill" style="width:${pct.toFixed(1)}%"></span></span>`;
}

/** Summarize the non-ok records for a (taskId, cellKey) pair for a gray cell's hover title. */
export function summarizeNonOk(records: CellRecord[]): string {
  const parts: string[] = [];
  for (const rec of records) {
    if (rec.status === 'ok') continue;
    const reason = rec.skipReason ? `: ${rec.skipReason}` : '';
    parts.push(`rep ${rec.rep} ${STATUS_LABEL[rec.status]}${reason}`);
  }
  return parts.join('; ');
}

/**
 * Shared design tokens + base layout. Light by default with a dark variant
 * that follows prefers-color-scheme, harmonized with the PDF print
 * stylesheet in pdf.ts so a screen report and its printed twin read
 * as one document. Direction from ui-ux-pro-max (data-dense dashboard:
 * blue data palette, amber highlight, KPI cards, dense tables), adapted to
 * this repo's hard constraints: no external fonts or assets, ever, so the
 * stacks name locally installed Fira faces first and fall back to system
 * fonts; text tones are darkened variants of the palette, picked for 4.5:1
 * contrast on white (the bright palette values are fills, not text).
 */
export const BASE_CSS = `
*{box-sizing:border-box}
:root{
  color-scheme:light dark;
  --bg:#F4F7FB; --surface:#FFFFFF; --surface-2:#EBF0F7; --surface-3:#F8FAFC;
  --border:#D3DCE9; --border-strong:#A9BCD4;
  --ink:#16233D; --muted:#4B5C74;
  --accent:#1E40AF; --accent-strong:#17337E; --accent-ink:#1E40AF; --accent-soft:#E1EAFF;
  --warm:#9A5B00; --warm-bg:#FFF1C9;
  --green:#0F7038; --green-bg:#DFF5E6;
  --yellow:#8A5A00; --yellow-bg:#FFF1C9;
  --red:#B42335; --red-bg:#FFE3E8;
  --bar-track:rgb(22 35 61/.13);
  --font-display:"Fira Sans",-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;
  --font-body:"Fira Sans",-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;
  --font-mono:"Fira Code",ui-monospace,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace;
  --r-sm:6px; --r-md:10px; --r-lg:16px; --r-full:9999px;
  --shadow:0 1px 2px rgb(22 35 61/.06),0 4px 14px rgb(22 35 61/.05);
}
/* Dark follows the operating system, with no toggle and no stored choice:
   the reader's preference is the preference. Pairs are chosen as sets
   (text tone on its own tinted background) for 4.5:1 contrast on the dark
   surfaces, mirroring the light pairs above rather than inverting them. */
@media (prefers-color-scheme: dark){
  :root{
    --bg:#0A0F1E; --surface:#111A2E; --surface-2:#1A2742; --surface-3:#0D1526;
    --border:#263650; --border-strong:#41577A;
    --ink:#E8EEF9; --muted:#A6B5CC;
    --accent:#8FAEFF; --accent-strong:#B9CBFF; --accent-ink:#9DB4FF; --accent-soft:#1D3465;
    --warm:#F2C14E; --warm-bg:#38300F;
    --green:#55D68E; --green-bg:#14301F;
    --yellow:#F2C14E; --yellow-bg:#38300F;
    --red:#FF8A99; --red-bg:#3D1620;
    --bar-track:rgb(232 238 249/.18);
    --shadow:0 1px 2px rgb(0 0 0/.45),0 4px 14px rgb(0 0 0/.35);
  }
}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--font-body);font-size:14.5px;line-height:1.55;-webkit-font-smoothing:antialiased}
h1,h2,h3,h4{font-family:var(--font-display);margin:0;letter-spacing:-.01em}
code,.mono{font-family:var(--font-mono)}
a{color:var(--accent-ink);text-underline-offset:2px}
a:hover{color:var(--accent-strong)}
:focus-visible{outline:2.5px solid var(--accent);outline-offset:2px;border-radius:3px}
.wrap{max-width:1320px;margin:0 auto;padding:28px 28px 80px}
.kicker{display:inline-block;font-family:var(--font-mono);font-size:10.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);background:var(--accent-soft);border-radius:var(--r-full);padding:3px 9px;margin-bottom:8px}

header.top{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);box-shadow:var(--shadow);padding:20px 22px 18px;margin-bottom:26px}
header.top h1{font-size:26px;font-weight:700;line-height:1.2}
.meta-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-top:16px}
.meta-item{background:var(--surface-3);border:1px solid var(--border);border-radius:var(--r-md);padding:11px 13px}
.meta-item .label{color:var(--accent);font-family:var(--font-mono);font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}
.meta-item .value{margin-top:4px;font-size:15px;font-weight:650}
.meta-item .sub{margin-top:2px;color:var(--muted);font-size:12px;font-family:var(--font-mono)}

section{margin-top:34px}
section>h2{font-size:19px;font-weight:650;margin-bottom:4px;padding-bottom:6px;border-bottom:2px solid var(--accent);display:inline-block}
section>p.lede{color:var(--muted);max-width:74ch;margin:8px 0 14px;font-size:13.5px}

.score-legend{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center;font-family:var(--font-mono);font-size:11px;color:var(--muted);margin:0 0 12px}
.score-legend .sw{display:inline-block;width:22px;height:12px;border-radius:3px;border:1px solid var(--border-strong);vertical-align:-2px;margin-right:5px}
.sw-green{background:var(--green-bg)} .sw-yellow{background:var(--yellow-bg)} .sw-red{background:var(--red-bg)} .sw-gray{background:var(--surface-2)}
.score-bar{display:block;width:100%;max-width:110px;height:4px;border-radius:var(--r-full);background:var(--bar-track);overflow:hidden;margin-top:5px}
.score-bar-fill{display:block;height:100%;border-radius:var(--r-full)}
.score-bar.tone-green .score-bar-fill{background:var(--green)}
.score-bar.tone-yellow .score-bar-fill{background:#D97706}
.score-bar.tone-red .score-bar-fill{background:var(--red)}

.chip{display:inline-block;font-family:var(--font-mono);font-size:11px;font-weight:600;letter-spacing:.03em;text-transform:uppercase;padding:2px 8px;border-radius:var(--r-full);border:1px solid;white-space:nowrap}
.chip-pass{color:var(--green);border-color:color-mix(in srgb,var(--green) 45%,transparent);background:var(--green-bg)}
.chip-review{color:var(--yellow);border-color:color-mix(in srgb,#D97706 55%,transparent);background:var(--yellow-bg)}
.chip-fail{color:var(--red);border-color:color-mix(in srgb,var(--red) 45%,transparent);background:var(--red-bg)}
.chip-skip{color:var(--muted);border-color:var(--border);background:var(--surface-2)}

.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-md);box-shadow:var(--shadow);overflow:hidden;margin-bottom:14px}
.card>h3{padding:12px 16px;border-bottom:1px solid var(--border);background:var(--surface-3);font-size:14.5px;display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.card .body{padding:14px 16px}

.scroll-x{overflow-x:auto;max-width:100%}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 11px;border-bottom:1px solid var(--border);white-space:nowrap}
th{color:var(--muted);font-weight:600;font-family:var(--font-mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.05em}
td.num{font-family:var(--font-mono);text-align:right}
tbody tr{transition:background 120ms ease}
tbody tr:hover td{background:color-mix(in srgb,var(--accent-soft) 45%,transparent)}
tr:last-child td{border-bottom:0}

.matrix th, .matrix td{text-align:center}
.matrix td.task-name, .matrix th.task-name{text-align:left;white-space:normal;min-width:170px;position:sticky;left:0;background:var(--surface);z-index:1;box-shadow:1px 0 0 var(--border)}
.matrix thead th{background:var(--surface-2);position:sticky;top:0;z-index:2;border-bottom:2px solid var(--border-strong)}
.matrix thead th.task-name{z-index:3;background:var(--surface-2)}
.matrix tfoot td{font-weight:600;background:var(--accent-soft);position:sticky;bottom:0;border-top:2px solid var(--border-strong)}
.matrix tfoot .score-bar{margin-left:auto;margin-right:auto}
.matrix-system{margin-bottom:8px}
.matrix-system>h3{font-family:var(--font-mono);font-size:12px;font-weight:650;text-transform:uppercase;letter-spacing:.07em;color:var(--accent-ink)}
.matrix-system + .drilldowns{margin-top:10px;margin-bottom:18px}

.mx-cell{cursor:pointer;border:1px solid var(--border);border-radius:8px;background:var(--surface-3);padding:7px 10px;width:100%;font:inherit;color:inherit;display:flex;flex-direction:column;align-items:center;gap:3px;min-height:52px;justify-content:center}
.mx-cell:hover{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}
.mx-cell.tone-green{background:var(--green-bg);border-color:color-mix(in srgb,var(--green) 38%,transparent)}
.mx-cell.tone-yellow{background:var(--yellow-bg);border-color:color-mix(in srgb,#D97706 42%,transparent)}
.mx-cell.tone-red{background:var(--red-bg);border-color:color-mix(in srgb,var(--red) 38%,transparent)}
.mx-cell.tone-gray{background:var(--surface-2)}
span.mx-cell{cursor:default}
/* Hover/selection is a state change, so it gets a short transition rather than
   snapping. Kept under 200ms: the reader is scanning a matrix, not watching it. */
@media (prefers-reduced-motion: no-preference){
  .mx-cell{transition:border-color 140ms cubic-bezier(0.16,1,0.3,1),box-shadow 140ms cubic-bezier(0.16,1,0.3,1)}
  a{transition:color 140ms cubic-bezier(0.16,1,0.3,1)}
}
.mx-score{font-family:var(--font-mono);font-weight:700;font-size:14.5px}
.mx-cell.tone-green .mx-score{color:var(--green)}
.mx-cell.tone-yellow .mx-score{color:var(--yellow)}
.mx-cell.tone-red .mx-score{color:var(--red)}
.mx-cell.tone-gray .mx-score{color:var(--muted)}
.mx-cell .score-bar{max-width:72px;margin-top:1px}
.mx-n{font-family:var(--font-mono);font-size:10px;color:var(--muted)}

.drilldowns{margin-top:18px}
.drill{border:1px solid var(--border-strong);border-radius:var(--r-md);background:var(--surface);box-shadow:var(--shadow);margin-bottom:12px;padding:14px 16px}
.drill[hidden]{display:none}
.drill h4{font-size:14px;margin-bottom:6px}
.drill .agg-line{color:var(--muted);font-family:var(--font-mono);font-size:12px;margin-bottom:10px}
.rep-card{border-top:1px dashed var(--border-strong);padding-top:10px;margin-top:10px}
.rep-card:first-of-type{border-top:0;margin-top:0;padding-top:0}
.rep-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-weight:600;font-size:13px}
.diff-row .msg{white-space:normal;max-width:46ch}
.diff-row .fix{white-space:normal;max-width:40ch;color:var(--muted)}
.judge-note{background:var(--warm-bg);border:1px solid color-mix(in srgb,#D97706 40%,transparent);border-radius:var(--r-sm);padding:9px 11px;margin-top:8px;font-size:13px;white-space:normal}
.links{margin-top:8px;display:flex;gap:12px;flex-wrap:wrap;font-family:var(--font-mono);font-size:12px}
.na{color:var(--muted);font-family:var(--font-mono);font-size:12px}

.delta-up{color:var(--green);font-family:var(--font-mono)}
.delta-down{color:var(--red);font-family:var(--font-mono)}
.delta-flat{color:var(--muted);font-family:var(--font-mono)}

footer.foot{margin-top:44px;padding-top:18px;border-top:1px solid var(--border);color:var(--muted);font-size:12px}
@media (max-width:720px){.wrap{padding:18px 16px 60px}header.top{padding:16px}header.top h1{font-size:22px}}
@media print{
  /* Print is always the light theme, whatever the system preference: the
     printed page is the PDF's twin, and dark surfaces waste ink. */
  :root{
    --bg:#F4F7FB; --surface:#FFFFFF; --surface-2:#EBF0F7; --surface-3:#F8FAFC;
    --border:#D3DCE9; --border-strong:#A9BCD4;
    --ink:#16233D; --muted:#4B5C74;
    --accent:#1E40AF; --accent-strong:#17337E; --accent-ink:#1E40AF; --accent-soft:#E1EAFF;
    --warm:#9A5B00; --warm-bg:#FFF1C9;
    --green:#0F7038; --green-bg:#DFF5E6;
    --yellow:#8A5A00; --yellow-bg:#FFF1C9;
    --red:#B42335; --red-bg:#FFE3E8;
    --bar-track:rgb(22 35 61/.13);
    --shadow:none;
  }
  *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  body{background:#fff}
  .wrap{max-width:none;padding:0}
  header.top,.card,.drill{box-shadow:none}
  .mx-cell{cursor:default}
  .card,.drill,.rep-card{break-inside:avoid}
}
`;

/** Embeds arbitrary JSON as an inline <script type="application/json"> blob — no fetch, ever. */
export function jsonScript(id: string, data: unknown): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<script type="application/json" id="${esc(id)}">${json}</script>`;
}

export function page(title: string, body: string, script: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<meta name="generator" content="open-design-system-bench ${BENCH_VERSION}">
<title>${esc(title)}</title>
<style>${BASE_CSS}</style>
</head>
<body>
${body}
<script>
${script}
</script>
</body>
</html>
`;
}
