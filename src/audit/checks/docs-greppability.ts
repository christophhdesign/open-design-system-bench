// Tier-0 check 7: Docs greppability. "Docs reachable as text/markdown, not
// only a JS-rendered site" — with a catalog available, scores what fraction
// of components get at least one .md mention anywhere in the repo (a
// zeroheight/Storybook-only docs site an agent's context window never sees
// doesn't count; a co-located README or docs/*.md does). Without a catalog,
// degrades to a coarser "how much markdown documentation exists at all"
// signal, per the spec's documented fallback.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SystemConfig, SystemId } from '../../types.ts';
import type { AuditCheckResult, AuditDirs, AuditFinding } from '../types.ts';
import { loadCatalogForAudit } from '../catalog-loader.ts';
import { walkFiles } from '../fs-walk.ts';
import { round1, clamp } from '../util.ts';

export async function checkDocsGreppability(system: SystemId, cfg: SystemConfig, dirs: AuditDirs): Promise<AuditCheckResult> {
  const findings: AuditFinding[] = [];
  const root = cfg.root;

  const mdFiles = walkFiles(root, { extensions: ['.md', '.mdx'] });
  const mdContents = mdFiles.map((f) => {
    try {
      return readFileSync(f.absPath, 'utf8');
    } catch {
      return '';
    }
  });
  const allMd = mdContents.join('\n---\n');

  findings.push({ severity: 'info', message: `${mdFiles.length} markdown file(s) found in the repo.` });

  const llmsTxtPath = join(root, 'llms.txt');
  const hasLlmsTxt = existsSync(llmsTxtPath);
  let llmsTxtContent = '';
  if (hasLlmsTxt) {
    try {
      llmsTxtContent = readFileSync(llmsTxtPath, 'utf8');
    } catch {
      // ignore
    }
  }

  const load = await loadCatalogForAudit(system, cfg, dirs.catalogsDir);

  if (!load.catalog) {
    if (mdFiles.length === 0) {
      findings.push({ severity: 'fail', message: 'No catalog and no markdown files found. Docs are not greppable at all.' });
      return { id: 'docs-greppability', title: 'Docs greppability', score: 0, findings };
    }
    // Fallback per spec: no catalog to check per-component coverage against,
    // so score off markdown volume alone. 20 for "some docs exist", scaling
    // to full credit at 20 files — an arbitrary but documented cap past
    // which more .md files stop being informative about greppability.
    const score = clamp(20 + Math.min(mdFiles.length, 20) / 20 * 80, 0, 100);
    findings.push({ severity: 'info', message: 'No catalog available: scoring markdown volume only, not per-component coverage.' });
    if (!hasLlmsTxt) findings.push({ severity: 'warn', message: 'No llms.txt found.' });
    return { id: 'docs-greppability', title: 'Docs greppability', score: round1(score), findings };
  }

  const displayNames = load.catalog.components.flatMap((c) => c.exports.map((e) => e.displayName));
  const uniqueNames = [...new Set(displayNames)];
  const covered = uniqueNames.filter((name) => allMd.includes(name));
  const uncovered = uniqueNames.filter((name) => !covered.includes(name));
  const pctCovered = uniqueNames.length > 0 ? (covered.length / uniqueNames.length) * 100 : 0;

  findings.push({
    severity: pctCovered < 50 ? 'warn' : 'info',
    message: `${covered.length}/${uniqueNames.length} components (${round1(pctCovered)}%) are mentioned in at least one markdown file.`,
  });
  if (uncovered.length > 0) {
    findings.push({
      severity: 'warn',
      message: `${uncovered.length} component(s) have no markdown mention: ${uncovered.slice(0, 10).join(', ')}${uncovered.length > 10 ? ', …' : ''}.`,
      fix: 'A component with zero markdown reach is invisible to any docs-grepping or retrieval-based agent workflow.',
    });
  }

  let llmsCoveredPct = 0;
  if (hasLlmsTxt) {
    const llmsCovered = uniqueNames.filter((name) => llmsTxtContent.includes(name));
    llmsCoveredPct = uniqueNames.length > 0 ? (llmsCovered.length / uniqueNames.length) * 100 : 0;
    findings.push({ severity: llmsCoveredPct < 50 ? 'warn' : 'info', message: `llms.txt lists ${llmsCovered.length}/${uniqueNames.length} components (${round1(llmsCoveredPct)}%).` });
  } else {
    findings.push({ severity: 'warn', message: 'No llms.txt found. Component list is not machine-listable in the ecosystem-standard location.' });
  }

  // Weights: per-component md coverage is the headline signal (60); llms.txt
  // coverage is a stronger, more agent-specific signal so it's weighted
  // higher per point (30) than its lower ceiling suggests; "docs exist at
  // all" gets a flat 10 so a system with partial coverage never scores
  // identically to one with none.
  const score = (mdFiles.length > 0 ? 10 : 0) + pctCovered * 0.6 + (hasLlmsTxt ? llmsCoveredPct * 0.3 : 0);

  return { id: 'docs-greppability', title: 'Docs greppability', score: round1(clamp(score, 0, 100)), findings };
}
