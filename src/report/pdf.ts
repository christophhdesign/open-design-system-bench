// Renders a PdfReportModel to a print HTML document and prints it with the
// headless Chrome the gallery already locates. No new dependency: Chrome is
// an optional external binary here exactly as it is for screenshots, and
// the degradation contract is the same - no Chrome means the print HTML is
// written out and the caller says so, never a silent failure.
//
// Pagination honesty: Chrome's --print-to-pdf cannot do CSS margin boxes,
// so this document has no footer with page numbers and its contents lists
// sections without page numbers. That is a deliberate v1 trade (zero new
// tooling); a CDP Page.printToPDF path is the named follow-up if exact
// pagination ever becomes a requirement.

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { RunResults } from '../types.ts';
import type { PdfReportModel, PdfScreenshot, PdfSection, PdfTable } from './pdf-model.ts';
import { findChrome } from './screenshots.ts';
import { esc } from './shared.ts';

const execFileAsync = promisify(execFile);

/**
 * Print twin of the screen tokens in shared.ts: same ink, accent, panel and
 * semantic hues, at print sizes and with backgrounds forced on (Chrome drops
 * them by default). No external fonts, for the same archive-offline reason
 * as the screen reports: Fira and IBM Plex are named for machines that have
 * them installed and fall back to the system stack everywhere else.
 */
const PRINT_CSS = `
@page { size: A4; margin: 18mm 16mm 20mm 16mm; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
:root {
  --ink: #16233d; --secondary: #4b5c74; --accent: #1e40af; --accent-strong: #17337e; --accent-soft: #e1eaff;
  --warm: #9a5b00; --warm-bg: #fff1c9;
  --hairline: #d3dce9; --hairline-strong: #a9bcd4; --panel: #ebf0f7; --panel-soft: #f8fafc;
  --font-body: "Fira Sans", "IBM Plex Sans", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  --font-mono: "Fira Code", "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
body { margin: 0; background: #fff; color: var(--ink); font-family: var(--font-body); font-size: 9.5pt; line-height: 1.5; }
code, .mono { font-family: var(--font-mono); }
a { color: var(--accent); text-decoration: none; }
.kicker { display: inline-block; font-family: var(--font-mono); font-size: 8pt; letter-spacing: .14em; text-transform: uppercase; color: var(--accent); background: var(--accent-soft); border-radius: 999px; padding: 3px 10px; font-weight: 700; }
.cover { padding-top: 20mm; }
.cover h1 { font-size: 28pt; line-height: 1.12; margin: 12px 0 6px; font-weight: 700; letter-spacing: -0.015em; color: var(--ink); }
.cover .subtitle { font-size: 12.5pt; line-height: 1.4; color: var(--secondary); margin: 0 0 8mm; max-width: 52ch; }
.flavor-note { display: inline-block; font-family: var(--font-mono); font-size: 7.5pt; text-transform: uppercase; letter-spacing: .08em; color: var(--accent-strong); background: var(--accent-soft); border: 1px solid var(--hairline-strong); border-radius: 999px; padding: 3px 9px; margin-bottom: 10mm; }
.cover table.meta { border-top: 2.5px solid var(--accent); }
.cover table.meta tr:nth-child(even) td { background: var(--panel-soft); }
.page-break { break-before: page; }
h1.sec { font-size: 15.5pt; font-weight: 700; margin: 0 0 10px; padding-bottom: 6px; border-bottom: 2px solid var(--accent); letter-spacing: -0.01em; break-after: avoid; }
h1.sec .no, h2.sec .no { color: var(--accent); font-weight: 600; margin-right: 8px; }
h2.sec { font-size: 11.5pt; font-weight: 700; margin: 18px 0 6px; padding-bottom: 3px; border-bottom: 0.75px solid var(--hairline); break-after: avoid; }
p { margin: 0 0 7px; max-width: 68ch; }
ul { margin: 4px 0 10px; padding-left: 16px; }
li { margin-bottom: 4px; }
table { width: 100%; border-collapse: collapse; font-size: 7.9pt; margin: 8px 0 14px; }
th { font-family: var(--font-mono); font-size: 6.7pt; text-transform: uppercase; letter-spacing: .06em; color: var(--secondary); background: var(--panel); font-weight: 700; text-align: left; padding: 5px 6px; border-bottom: 1.5px solid var(--hairline-strong); }
td { padding: 4.5px 6px; border-bottom: 0.5px solid var(--hairline); vertical-align: top; word-break: break-word; }
tbody tr:nth-child(even) td { background: var(--panel-soft); }
td.num, th.num { text-align: right; font-family: var(--font-mono); white-space: nowrap; }
thead { display: table-header-group; }
tr { break-inside: avoid; }
table.meta td:first-child { font-family: var(--font-mono); font-size: 7pt; text-transform: uppercase; letter-spacing: .07em; color: var(--secondary); width: 34mm; }
pre { font-family: var(--font-mono); font-size: 7.4pt; line-height: 1.45; background: var(--panel); border: 0.5px solid var(--hairline); padding: 10px 12px; white-space: pre-wrap; word-break: break-word; border-radius: 4px; break-inside: auto; }
.contents { list-style: none; padding: 0; margin: 10px 0; }
.contents li { font-size: 10pt; margin: 0; padding: 5px 2px; border-bottom: 0.5px solid var(--hairline); }
.contents .no { color: var(--accent); font-family: var(--font-mono); font-weight: 700; font-size: 8.5pt; margin-right: 8px; }
.contents .lvl2 { padding-left: 18px; font-size: 9pt; }
.shots { break-before: page; }
.shot { break-inside: avoid; margin-bottom: 14px; }
.shot img { max-width: 100%; border: 1px solid var(--hairline-strong); border-radius: 4px; }
.shot .cap { font-family: var(--font-mono); font-size: 7.5pt; color: var(--secondary); margin-top: 4px; }
.md h3 { font-size: 10.5pt; margin: 14px 0 5px; break-after: avoid; }
.md h4 { font-size: 9.5pt; margin: 12px 0 4px; break-after: avoid; }
.md strong { color: var(--ink); }
`;

function renderTable(table: PdfTable, cls = ''): string {
  const numeric = new Set(table.numericCols ?? []);
  const head = table.headers
    .map((h, i) => `<th${numeric.has(i) ? ' class="num"' : ''}>${esc(h)}</th>`)
    .join('');
  const body = table.rows
    .map(
      (row) =>
        `<tr>${row.map((cell, i) => `<td${numeric.has(i) ? ' class="num"' : ''}>${esc(cell)}</td>`).join('')}</tr>`,
    )
    .join('');
  return `<table${cls ? ` class="${esc(cls)}"` : ''}><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderSection(section: PdfSection): string {
  const parts: string[] = [];
  const heading =
    section.level === 1
      ? `<h1 class="sec"><span class="no">${esc(section.number)}.</span>${esc(section.title)}</h1>`
      : `<h2 class="sec"><span class="no">${esc(section.number)}</span>${esc(section.title)}</h2>`;
  // Every top-level section starts a page, as in the reference reports:
  // the contents page never shares its page with section 1.
  parts.push(`<section${section.level === 1 ? ' class="page-break"' : ''}>${heading}`);
  for (const p of section.intro ?? []) parts.push(`<p>${esc(p)}</p>`);
  if (section.authoredMarkdown) parts.push(`<div class="md">${renderMarkdown(section.authoredMarkdown)}</div>`);
  for (const table of section.tables ?? []) parts.push(renderTable(table));
  if (section.bullets?.length) {
    parts.push(`<ul>${section.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`);
  }
  if (section.code) parts.push(`<pre>${esc(section.code)}</pre>`);
  parts.push('</section>');
  return parts.join('\n');
}

/** The full print document: cover, contents (no page numbers), sections, screenshots. */
export function renderPdfHtml(model: PdfReportModel): string {
  const metaRows = model.coverRows
    .map(([label, value]) => `<tr><td>${esc(label)}</td><td>${esc(value)}</td></tr>`)
    .join('');
  const contents = model.sections
    .map(
      (s) =>
        `<li${s.level === 2 ? ' class="lvl2"' : ''}><span class="no">${esc(/^[A-Z]$/.test(s.number) ? `Appendix ${s.number}` : s.number)}</span>${esc(s.title)}</li>`,
    )
    .join('');

  const shots = model.screenshots.length
    ? `<section class="shots"><h1 class="sec"><span class="no">S.</span>Screenshots</h1>` +
      model.screenshots
        .map(
          (s) =>
            `<figure class="shot"><img src="${esc(pathToFileURL(s.path).href)}" alt="${esc(s.caption)}"><figcaption class="cap">${esc(s.caption)}</figcaption></figure>`,
        )
        .join('') +
      '</section>'
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${esc(model.title)} - AI-readiness benchmark report</title>
<style>${PRINT_CSS}</style>
</head>
<body>
<div class="cover">
  <div class="kicker">AI-readiness benchmark report</div>
  <h1>${esc(model.title)}</h1>
  <p class="subtitle">${esc(model.subtitle)}</p>
  <div><span class="flavor-note">${esc(model.flavorNote)}</span></div>
  <table class="meta"><tbody>${metaRows}</tbody></table>
</div>
<section class="page-break">
  <h1 class="sec">Contents</h1>
  <ul class="contents">${contents}${model.screenshots.length ? '<li><span class="no">S</span>Screenshots</li>' : ''}</ul>
</section>
${model.sections.map((s) => renderSection(s)).join('\n')}
${shots}
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// A small markdown subset for authored sections (Phase 2): headings,
// paragraphs, tables, lists, fenced code, bold/code/links. It renders the
// interpretation layer only; generated sections never pass through here.
// ---------------------------------------------------------------------------

function renderInline(text: string): string {
  let out = esc(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '<em>$1</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return out;
}

export function renderMarkdown(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let i = 0;
  const isTableLine = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  const cellsOf = (l: string) =>
    l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i += 1;
      out.push(`<pre>${esc(buf.join('\n'))}</pre>`);
      continue;
    }
    if (isTableLine(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const headers = cellsOf(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableLine(lines[i])) rows.push(cellsOf(lines[i++]));
      out.push(
        `<table><thead><tr>${headers.map((h) => `<th>${renderInline(h)}</th>`).join('')}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`).join('') +
          '</tbody></table>',
      );
      continue;
    }
    const heading = /^(#{2,5})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length, 4);
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ''));
      out.push(`<ul>${items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ul>`);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''));
      out.push(`<ol>${items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ol>`);
      continue;
    }
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    // Paragraph: gather until a blank line or a block starter.
    const buf = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^\s*```/.test(lines[i]) &&
      !/^(#{2,5})\s+/.test(lines[i]) &&
      !isTableLine(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i])
    ) {
      buf.push(lines[i++]);
    }
    out.push(`<p>${renderInline(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

export type PrintOutcome =
  | { ok: true; pdfPath: string }
  | { ok: false; reason: 'no-chrome' | 'chrome-failed'; htmlPath: string; message: string };

/**
 * Writes the print HTML next to the target PDF (as <name>-print.html when
 * Chrome is missing, so the operator can print it by hand) and, when Chrome
 * exists, prints it. `chromePath: null` forces the no-Chrome path (tests);
 * undefined auto-detects.
 */
export async function printPdfHtml(
  html: string,
  pdfPath: string,
  opts?: { chromePath?: string | null },
): Promise<PrintOutcome> {
  const chrome = opts?.chromePath === undefined ? findChrome() : (opts.chromePath ?? undefined);
  const htmlPath = pdfPath.replace(/\.pdf$/i, '') + '-print.html';
  if (!chrome) {
    writeFileSync(htmlPath, html);
    return {
      ok: false,
      reason: 'no-chrome',
      htmlPath,
      message: 'no Chrome, Chromium or Edge found (set CHROME_PATH); print HTML written instead',
    };
  }

  const dir = mkdtempSync(join(tmpdir(), 'odsb-pdf-'));
  const profile = mkdtempSync(join(tmpdir(), 'odsb-pdf-chrome-'));
  const tempHtml = join(dir, 'report.html');
  // Chrome resolves a relative --print-to-pdf against its own working
  // directory, which is not guaranteed to be the caller's: absolutize it.
  const absPdfPath = resolve(pdfPath);
  try {
    writeFileSync(tempHtml, html);
    await execFileAsync(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-scrollbars',
        `--user-data-dir=${profile}`,
        '--no-pdf-header-footer',
        `--print-to-pdf=${absPdfPath}`,
        pathToFileURL(tempHtml).href,
      ],
      { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
    );
    if (!existsSync(absPdfPath)) throw new Error('Chrome exited without writing a PDF');
    return { ok: true, pdfPath };
  } catch (err) {
    writeFileSync(htmlPath, html);
    const stderr = (err as { stderr?: string }).stderr?.trim().split('\n').slice(0, 2).join(' ');
    return {
      ok: false,
      reason: 'chrome-failed',
      htmlPath,
      message: `${err instanceof Error ? err.message : String(err)}${stderr ? ` - ${stderr.slice(0, 300)}` : ''}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
  }
}

/**
 * Screenshots that already exist next to a system's cells (written by the
 * gallery). The PDF embeds what is on disk and never triggers a build or a
 * screenshot of its own: generation stays a pure rendering step.
 */
export function collectExistingScreenshots(run: RunResults, runDir: string, systemId: string): PdfScreenshot[] {
  const out: PdfScreenshot[] = [];
  const records = run.records
    .filter((r) => r.cell.system === systemId && r.status === 'ok' && r.artifacts)
    .sort((a, b) => a.taskId.localeCompare(b.taskId) || a.cell.context.localeCompare(b.cell.context) || a.rep - b.rep);
  for (const rec of records) {
    const path = join(resolve(runDir), rec.artifacts!.dir, 'screenshot.png');
    if (!existsSync(path)) continue;
    const score = rec.result ? `${rec.result.overall.toFixed(2)} ${rec.result.gate}` : 'no score';
    out.push({ path, caption: `${rec.taskId} - ${rec.cell.context} - rep ${rec.rep} - ${score}` });
  }
  return out;
}

/** Convenience: model to PDF in one call. */
export async function writePdf(model: PdfReportModel, pdfPath: string, opts?: { chromePath?: string | null }): Promise<PrintOutcome> {
  return printPdfHtml(renderPdfHtml(model), pdfPath, opts);
}

export function pdfFileName(model: PdfReportModel): string {
  return `report-${basename(model.reportId)}.pdf`;
}
