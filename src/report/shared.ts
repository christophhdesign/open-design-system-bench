// Shared rendering helpers for the self-contained HTML reports (html.ts, compare.ts).
// Every report is one inline-everything file — no external fonts/scripts/styles,
// no fetch(), no <link>, nothing that touches the network — so it stays safe to
// email or archive next to a ticket. Mirrors the house style set by
// motion-perf-gate/src/report-html.mjs (same idea: pull shared bits into one
// module and inline the whole thing at generation time).

import type { CellRecord, CellStatus, Gate } from '../types.ts';

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

/** Shared design tokens + base layout. Dark theme fixed, matching motion-perf-gate's default. */
export const BASE_CSS = `
*{box-sizing:border-box}
:root{
  --bg:#0A0D16; --surface:#10151F; --surface-2:#161D2C; --border:#232B3F;
  --ink:#E8ECF7; --muted:#8B95B3; --accent:#6C8CFF; --accent-ink:#9FB0FF;
  --green:#3DD68C; --yellow:#F5C542; --red:#F0576B;
  --font-display:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;
  --font-body:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;
  --font-mono:'SF Mono',Menlo,Consolas,'Liberation Mono',monospace;
  --r-sm:6px; --r-md:10px; --r-lg:16px; --r-full:9999px;
}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--font-body);font-size:14.5px;line-height:1.55;-webkit-font-smoothing:antialiased}
h1,h2,h3,h4{font-family:var(--font-display);margin:0;letter-spacing:-.01em}
code,.mono{font-family:var(--font-mono)}
a{color:var(--accent-ink)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}
.wrap{max-width:1320px;margin:0 auto;padding:28px 28px 80px}

header.top{padding:6px 0 22px;border-bottom:1px solid var(--border);margin-bottom:26px}
header.top h1{font-size:24px;font-weight:700}
.meta-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-top:16px}
.meta-item{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-md);padding:10px 13px}
.meta-item .label{color:var(--muted);font-family:var(--font-mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.06em}
.meta-item .value{margin-top:4px;font-size:14.5px;font-weight:600}
.meta-item .sub{margin-top:2px;color:var(--muted);font-size:12px;font-family:var(--font-mono)}

section{margin-top:34px}
section>h2{font-size:18px;font-weight:650;margin-bottom:4px}
section>p.lede{color:var(--muted);max-width:74ch;margin:0 0 14px;font-size:13.5px}

.chip{display:inline-block;font-family:var(--font-mono);font-size:11px;font-weight:600;letter-spacing:.03em;text-transform:uppercase;padding:2px 8px;border-radius:var(--r-full);border:1px solid;white-space:nowrap}
.chip-pass{color:var(--green);border-color:color-mix(in srgb,var(--green) 45%,transparent);background:color-mix(in srgb,var(--green) 12%,transparent)}
.chip-review{color:var(--yellow);border-color:color-mix(in srgb,var(--yellow) 45%,transparent);background:color-mix(in srgb,var(--yellow) 12%,transparent)}
.chip-fail{color:var(--red);border-color:color-mix(in srgb,var(--red) 45%,transparent);background:color-mix(in srgb,var(--red) 12%,transparent)}
.chip-skip{color:var(--muted);border-color:var(--border);background:var(--surface-2)}

.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden;margin-bottom:14px}
.card>h3{padding:12px 16px;border-bottom:1px solid var(--border);font-size:14.5px;display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.card .body{padding:14px 16px}

.scroll-x{overflow-x:auto;max-width:100%}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 11px;border-bottom:1px solid var(--border);white-space:nowrap}
th{color:var(--muted);font-weight:500;font-family:var(--font-mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.05em}
td.num{font-family:var(--font-mono);text-align:right}
tr:last-child td{border-bottom:0}

.matrix th, .matrix td{text-align:center}
.matrix td.task-name, .matrix th.task-name{text-align:left;white-space:normal;min-width:170px;position:sticky;left:0;background:var(--surface);z-index:1}
.matrix thead th{background:var(--surface)}
.matrix tbody tr:hover td{background:color-mix(in srgb,var(--surface-2) 60%,transparent)}
.matrix tfoot td{font-weight:600;background:var(--surface-2)}
.matrix-system{margin-bottom:8px}
.matrix-system>h3{font-family:var(--font-mono);font-size:12px;font-weight:650;text-transform:uppercase;letter-spacing:.07em;color:var(--accent-ink)}
.matrix-system + .drilldowns{margin-top:10px;margin-bottom:18px}

.mx-cell{cursor:pointer;border:0;background:transparent;padding:8px 11px;width:100%;font:inherit;color:inherit;display:flex;flex-direction:column;align-items:center;gap:3px}
.mx-cell:hover{background:color-mix(in srgb,var(--accent) 10%,transparent)}
/* Hover/selection is a state change, so it gets a short transition rather than
   snapping. Kept under 200ms: the reader is scanning a matrix, not watching it. */
@media (prefers-reduced-motion: no-preference){
  .mx-cell{transition:background 140ms cubic-bezier(0.16,1,0.3,1)}
  .matrix tbody tr td{transition:background 140ms cubic-bezier(0.16,1,0.3,1)}
  a{transition:color 140ms cubic-bezier(0.16,1,0.3,1)}
}
.mx-score{font-family:var(--font-mono);font-weight:700;font-size:14px}
.mx-cell.tone-green .mx-score{color:var(--green)}
.mx-cell.tone-yellow .mx-score{color:var(--yellow)}
.mx-cell.tone-red .mx-score{color:var(--red)}
.mx-cell.tone-gray .mx-score{color:var(--muted)}
.mx-n{font-family:var(--font-mono);font-size:10px;color:var(--muted)}

.drilldowns{margin-top:18px}
.drill{border:1px solid var(--border);border-radius:var(--r-md);background:var(--surface);margin-bottom:12px;padding:14px 16px}
.drill[hidden]{display:none}
.drill h4{font-size:14px;margin-bottom:6px}
.drill .agg-line{color:var(--muted);font-family:var(--font-mono);font-size:12px;margin-bottom:10px}
.rep-card{border-top:1px dashed var(--border);padding-top:10px;margin-top:10px}
.rep-card:first-of-type{border-top:0;margin-top:0;padding-top:0}
.rep-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-weight:600;font-size:13px}
.diff-row .msg{white-space:normal;max-width:46ch}
.diff-row .fix{white-space:normal;max-width:40ch;color:var(--muted)}
.judge-note{background:var(--surface-2);border-radius:var(--r-sm);padding:9px 11px;margin-top:8px;font-size:13px;white-space:normal}
.links{margin-top:8px;display:flex;gap:12px;flex-wrap:wrap;font-family:var(--font-mono);font-size:12px}
.na{color:var(--muted);font-family:var(--font-mono);font-size:12px}

.delta-up{color:var(--green);font-family:var(--font-mono)}
.delta-down{color:var(--red);font-family:var(--font-mono)}
.delta-flat{color:var(--muted);font-family:var(--font-mono)}

footer.foot{margin-top:44px;padding-top:18px;border-top:1px solid var(--border);color:var(--muted);font-size:12px}
@media print{.mx-cell{cursor:default}}
`;

/** Embeds arbitrary JSON as an inline <script type="application/json"> blob — no fetch, ever. */
export function jsonScript(id: string, data: unknown): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<script type="application/json" id="${esc(id)}">${json}</script>`;
}

export function page(title: string, body: string, script: string): string {
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
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
