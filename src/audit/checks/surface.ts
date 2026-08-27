// Tier-0 check 1: Enablement surface. The State of AI in Design Systems
// survey's own checklist (AGENTS.md/CLAUDE.md, llms.txt, machine catalog,
// MCP server, skills, editor rules, Code Connect, registry), scored for
// presence — plus a freshness signal the survey doesn't capture: are the
// docs actually kept up to date with the component source?
//
// Weights (documented here since they're a judgment call, not a spec):
//   AGENTS.md/CLAUDE.md   20   — the single highest-leverage asset; every
//                                 context level in this very benchmark is
//                                 built from it.
//   llms.txt              15   — cheap to ship, the survey's most-cited gap
//                                 signal (70% adoption in the mid-2026 snapshot).
//   machine catalog        20   — the hard prerequisite for every other Tier-0
//                                 check (catalog-quality, vocabulary,
//                                 docs-greppability all degrade without one).
//   MCP server hint         10
//   skills dirs             10
//   editor rules            10   — .cursorrules / .cursor/rules / copilot-instructions.md
//   Code Connect             10
//   registry hint             5
//   (sum = 100)
// Freshness is not folded into the weighted sum above (a missing doc already
// scores 0 on presence; there's nothing to further penalize). Instead it's a
// +5 bonus only (staleness earns a warn finding, never a score penalty),
// applied only when at least one of AGENTS.md/CLAUDE.md/llms.txt exists,
// comparing the newest of those docs' git commit times against the newest
// git commit time touching componentsSrc. This is git-commit-time based, not
// filesystem-mtime based: on a fresh clone every file's mtime is the
// checkout time, which makes an mtime comparison meaningless (it always
// looks "fresh" or "stale" based on write order during checkout, not actual
// history). When git is unavailable, the root isn't a git work tree, or any
// needed commit time can't be resolved, freshness is reported as unmeasured
// rather than guessed from mtime.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { SystemConfig, SystemId } from '../../types.ts';
import type { AuditCheckResult, AuditDirs, AuditFinding } from '../types.ts';
import { walkFiles } from '../fs-walk.ts';
import { readJsonSafe, clamp, round1, findPackageDir } from '../util.ts';
import { loadCatalogForAudit } from '../catalog-loader.ts';

interface PkgJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  bin?: unknown;
  publishConfig?: { registry?: string };
  exports?: Record<string, unknown>;
}

function hasMcpHint(root: string, pkg: PkgJson | undefined): boolean {
  const candidates = ['mcp.json', '.mcp.json', join('.cursor', 'mcp.json'), join('.vscode', 'mcp.json')];
  if (candidates.some((c) => existsSync(join(root, c)))) return true;
  if (!pkg) return false;
  const scriptValues = Object.values(pkg.scripts ?? {});
  if (scriptValues.some((v) => /\bmcp\b/i.test(v))) return true;
  const depKeys = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
  return depKeys.some((k) => /mcp/i.test(k));
}

function hasEditorRules(root: string): boolean {
  return (
    existsSync(join(root, '.cursorrules')) ||
    existsSync(join(root, '.cursor', 'rules')) ||
    existsSync(join(root, '.github', 'copilot-instructions.md'))
  );
}

function hasRegistryHint(root: string, componentsPkgDir: string, pkg: PkgJson | undefined): boolean {
  if (existsSync(join(root, 'registry.json'))) return true;
  if (existsSync(join(componentsPkgDir, 'registry.json'))) return true;
  if (pkg?.publishConfig?.registry) return true;
  if (pkg?.exports && Object.keys(pkg.exports).some((k) => k.includes('registry'))) return true;
  return false;
}

/**
 * Newest commit time (unix seconds, `git log`'s `%ct`) touching `relPath`
 * under `root`, or undefined if it can't be determined: git isn't
 * installed, `root` isn't a git work tree, the command otherwise fails, or
 * it succeeds but returns no history for that path (e.g. an untracked
 * file). A single `git log -1` per path is O(1) regardless of path type:
 * for a directory this is the newest commit touching anything under it, so
 * callers should pass a directory once rather than looping per file inside it.
 */
function getGitCommitTime(root: string, relPath: string): number | undefined {
  const result = spawnSync('git', ['-C', root, 'log', '-1', '--format=%ct', '--', relPath], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return undefined;
  const out = result.stdout.trim();
  if (!out) return undefined;
  const n = Number(out);
  return Number.isFinite(n) ? n : undefined;
}

function hasSkillDirs(root: string, cfg: SystemConfig): { present: boolean; configuredMissing: string[] } {
  const configured = cfg.agentContext.skillDirs ?? [];
  const configuredMissing = configured.filter((d) => !existsSync(join(root, d)));
  const genericDirs = ['.agents/skills', '.claude/skills', 'skills'];
  const anyGeneric = genericDirs.some((d) => existsSync(join(root, d)));
  const anyConfigured = configured.length > 0 && configuredMissing.length < configured.length;
  return { present: anyConfigured || anyGeneric, configuredMissing };
}

export async function checkSurface(system: SystemId, cfg: SystemConfig, dirs: AuditDirs): Promise<AuditCheckResult> {
  const findings: AuditFinding[] = [];
  const root = cfg.root;
  let score = 0;

  // --- AGENTS.md / CLAUDE.md (20) ---
  const agentsMdPath = join(root, 'AGENTS.md');
  const claudeMdPath = join(root, 'CLAUDE.md');
  const hasAgentsMd = existsSync(agentsMdPath);
  const hasClaudeMd = existsSync(claudeMdPath);
  if (hasAgentsMd || hasClaudeMd) {
    score += 20;
    findings.push({
      severity: 'info',
      message: `${[hasAgentsMd && 'AGENTS.md', hasClaudeMd && 'CLAUDE.md'].filter(Boolean).join(' + ')} present at system root.`,
    });
  } else {
    findings.push({
      severity: 'fail',
      message: 'No AGENTS.md or CLAUDE.md at the system root.',
      fix: 'Add an AGENTS.md. It is the single highest-leverage asset: every guided context level agents are graded under starts from it.',
    });
  }

  // --- llms.txt (15) ---
  const llmsTxtPath = join(root, 'llms.txt');
  const hasLlmsTxt = existsSync(llmsTxtPath);
  if (hasLlmsTxt) {
    score += 15;
  } else {
    findings.push({
      severity: 'warn',
      message: 'No llms.txt at the system root.',
      fix: 'Ship an llms.txt listing the component set: the most commonly cited gap in the mid-2026 AI-readiness survey.',
    });
  }

  // --- machine catalog (20) ---
  const catalogLoad = await loadCatalogForAudit(system, cfg, dirs.catalogsDir);
  if (catalogLoad.catalog) {
    score += 20;
  } else if (catalogLoad.source === 'none-docgen' && catalogLoad.docgenPreconditions) {
    const { tsconfigExists, tsxComponentCount } = catalogLoad.docgenPreconditions;
    if (tsconfigExists && tsxComponentCount > 0) {
      score += 12; // docgen-able but not yet extracted — partial credit
      findings.push({
        severity: 'warn',
        message: `No extracted catalog found, but the system is docgen-able (tsconfig.json present, ${tsxComponentCount} component .tsx files found).`,
        fix: 'Run "npm run extract" (or point --config at a snapshot dir) to produce a machine-readable catalog.',
      });
    } else {
      findings.push({
        severity: 'fail',
        message: 'No machine-readable catalog, and docgen preconditions are not met (missing tsconfig.json or no .tsx components found).',
      });
    }
  } else {
    findings.push({
      severity: 'fail',
      message: `No machine-readable catalog found for strategy "${cfg.catalogStrategy}"${cfg.catalogFile ? ` (expected ${cfg.catalogFile})` : ''}.`,
    });
  }

  // --- MCP server hint (10) ---
  const componentsPkgDir = findPackageDir(join(root, cfg.componentsSrc), root) ?? root;
  const pkg = readJsonSafe<PkgJson>(join(componentsPkgDir, 'package.json')) ?? readJsonSafe<PkgJson>(join(root, 'package.json'));
  if (hasMcpHint(root, pkg)) {
    score += 10;
  } else {
    findings.push({
      severity: 'warn',
      message: 'No MCP server hint found (no mcp.json, no "mcp" script, no MCP SDK dependency).',
      fix: 'MCP adoption is 95% among AI-native systems in the survey: the highest-adoption asset of the whole checklist.',
    });
  }

  // --- skills dirs (10) ---
  const skills = hasSkillDirs(root, cfg);
  if (skills.present) {
    score += 10;
  } else {
    findings.push({ severity: 'warn', message: 'No agent skill bundles found (.agents/skills, .claude/skills, or configured skillDirs).' });
  }
  for (const missing of skills.configuredMissing) {
    findings.push({ severity: 'warn', message: `Configured skillDirs entry "${missing}" does not exist on disk.` });
  }

  // --- editor rules (10) ---
  if (hasEditorRules(root)) {
    score += 10;
  } else {
    findings.push({ severity: 'info', message: 'No editor rules file (.cursorrules, .cursor/rules, .github/copilot-instructions.md).' });
  }

  // --- Code Connect (10) ---
  const figmaFiles = walkFiles(join(root, cfg.componentsSrc), { extensions: ['.figma.ts', '.figma.tsx'] });
  if (figmaFiles.length > 0) {
    score += 10;
    findings.push({ severity: 'info', message: `${figmaFiles.length} Code Connect file(s) (*.figma.ts[x]) found under ${cfg.componentsSrc}.` });
  } else {
    findings.push({
      severity: 'info',
      message: 'No Code Connect files (*.figma.ts[x]) found.',
      fix: 'Only 10% of systems in the survey have Code Connect mappings: lowest-adoption asset, but it unlocks the Tier-3 Figma-to-code eval.',
    });
  }

  // --- registry hint (5) ---
  if (hasRegistryHint(root, componentsPkgDir, pkg)) {
    score += 5;
  } else {
    findings.push({ severity: 'info', message: 'No registry hint found (registry.json, publishConfig.registry).' });
  }

  // --- freshness bonus (+5 only, git-commit-time based; only when a doc exists to compare) ---
  const docRelPaths = [hasAgentsMd && 'AGENTS.md', hasClaudeMd && 'CLAUDE.md', hasLlmsTxt && 'llms.txt'].filter(
    (v): v is string => typeof v === 'string',
  );
  if (docRelPaths.length > 0) {
    const docCommitTimes = docRelPaths.map((p) => getGitCommitTime(root, p));
    const sourceCommitTime = getGitCommitTime(root, cfg.componentsSrc);
    const measured = sourceCommitTime !== undefined && docCommitTimes.every((v): v is number => v !== undefined);
    if (!measured) {
      findings.push({ severity: 'info', message: 'Doc freshness unmeasured (not a git checkout).' });
    } else {
      const newestDoc = Math.max(...docCommitTimes);
      if (newestDoc >= sourceCommitTime) {
        score = clamp(score + 5, 0, 100);
        findings.push({ severity: 'info', message: 'Enablement docs are as new as or newer than the newest component source change (git history).' });
      } else {
        findings.push({
          severity: 'warn',
          message: 'Enablement docs (AGENTS.md/CLAUDE.md/llms.txt) predate the newest component source change (git history), so they may be stale.',
          fix: 'Re-check AGENTS.md/llms.txt after component API changes; agents will confidently cite the stale version.',
        });
      }
    }
  }

  return { id: 'surface', title: 'Enablement surface', score: round1(clamp(score, 0, 100)), findings };
}
