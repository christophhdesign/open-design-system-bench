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
//
// Field-test fix (P2 2.1b): MCP and registry hints used to look only at the
// components package's own package.json plus a root fallback. Real systems
// often ship the MCP server (or a registry) as its own sibling workspace
// package instead (Chakra's apps/mcp, Mantine's
// packages/@mantine/mcp-server) — invisible to the old check. Both hints now
// also scan every workspace package via listWorkspacePackages, and when the
// hit comes from there the finding names the package: evidence beats a bare
// boolean. The weights are unchanged; a workspace hit just earns the same
// points a root-level hit always did.
//
// Field-test fix (OSS field test, Aug 2026, Primer + Ant Design): the local
// MCP check was both too loose and too eager to stop looking. Too loose: an
// unanchored /mcp/i over dependency keys tripped on
// "@storybook/addon-mcp" (Storybook tooling, not an MCP server) — see the
// exclusion comment on localMcpEvidence. Too eager: that false-positive
// silently awarded +10 with NO finding text (the only score in this
// function with none) and then short-circuited the workspace scan, so
// Primer's real first-party packages/mcp (@primer/mcp) was never evaluated
// or named. And Ant Design's real MCP surface — public/.well-known/mcp
// plus docs/react/mcp.en-US.md — was entirely undetected, since the check
// never looked for a .well-known/mcp hint at all.
//
// Fixed by (a) collecting local AND workspace evidence unconditionally
// (never short-circuiting), (b) awarding once, naming the workspace hit
// when both exist (it's the shippable artifact), and (c) tightening what
// counts as local evidence: mcp.json variants, .well-known/mcp, a word-ish
// "mcp" script/bin/dependency match (MCP_TOKEN_RE, shared with the
// workspace scan so the two can't quietly diverge), or an
// @modelcontextprotocol/* SDK dependency in either dependencies or
// devDependencies. A bare devDependency substring match no longer counts.
//
// Field-test addition (P2 2.2): builder-side agent tooling (.claude/agents,
// .claude/commands, .claude/hooks, settings.json hooks) is reported as an
// info finding when present, but deliberately left unscored until the
// Phase-4 weight re-slice — it's evidence of *how* the system was built,
// not evidence available to an agent consuming it, so folding it into this
// score right now would conflate two different things the survey measures.

import { existsSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { SystemConfig, SystemId } from '../../types.ts';
import type { AuditCheckResult, AuditDirs, AuditFinding } from '../types.ts';
import { walkFiles } from '../fs-walk.ts';
import { readJsonSafe, clamp, round1, findPackageDir } from '../util.ts';
import { loadCatalogForAudit } from '../catalog-loader.ts';
import { listWorkspacePackages, type WorkspacePackage } from '../workspace.ts';

interface PkgJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  bin?: unknown;
  publishConfig?: { registry?: string };
  exports?: Record<string, unknown>;
}

/**
 * Shared "looks like MCP" token matcher: word-ish "mcp" boundaries, so it
 * catches "mcp", "mcp-server", "@chakra-ui/react-mcp", "packages/mcp", but
 * not "mcpartland" or another accidental substring. Used for package names,
 * script keys/values, and bin keys in BOTH the local-package check and the
 * workspace scan, so the two never quietly diverge on what counts.
 */
const MCP_TOKEN_RE = /(^|[-_/@])mcp([-_/]|$)/i;

function looksLikeMcpToken(value: unknown): boolean {
  return typeof value === 'string' && MCP_TOKEN_RE.test(value);
}

/**
 * `.well-known/mcp` file-or-directory candidates: the system root, and the
 * two conventional static-asset roots a web app serves well-known files
 * from (field-tested on Ant Design: public/.well-known/mcp).
 */
const WELL_KNOWN_MCP_CANDIDATES = [
  join('.well-known', 'mcp'),
  join('public', '.well-known', 'mcp'),
  join('static', '.well-known', 'mcp'),
];

/**
 * Local-package MCP evidence: mcp.json/.mcp.json (plus editor-specific
 * variants), a .well-known/mcp hint, or an "mcp"-mentioning
 * script/bin/dependency in the package.json resolved for the components
 * package (falling back to the root package.json). Returns a short,
 * human-readable description of the FIRST evidence found — for naming in
 * the finding — or undefined when there's none.
 *
 * Field-tested false positive (Primer, OSS field test): a devDependency
 * like "@storybook/addon-mcp" merely CONTAINS "mcp" as part of Storybook
 * tooling, not evidence the system itself ships an MCP server. A bare
 * (non-"@modelcontextprotocol/*") devDependency match is deliberately
 * excluded here — only a *runtime* dependency, or an actual
 * @modelcontextprotocol/* SDK dependency (in either dependencies or
 * devDependencies, since SDK usage is strong evidence regardless of which
 * field declares it), counts.
 */
function localMcpEvidence(root: string, pkg: PkgJson | undefined): string | undefined {
  const mcpJsonCandidates = ['mcp.json', '.mcp.json', join('.cursor', 'mcp.json'), join('.vscode', 'mcp.json')];
  const mcpJsonHit = mcpJsonCandidates.find((c) => existsSync(join(root, c)));
  if (mcpJsonHit) return `${mcpJsonHit.split(sep).join('/')} present`;

  const wellKnownHit = WELL_KNOWN_MCP_CANDIDATES.find((c) => existsSync(join(root, c)));
  if (wellKnownHit) return `${wellKnownHit.split(sep).join('/')} present`;

  if (!pkg) return undefined;

  const scriptHit = Object.entries(pkg.scripts ?? {}).find(([k, v]) => looksLikeMcpToken(k) || looksLikeMcpToken(v));
  if (scriptHit) return `scripts.${scriptHit[0]} mentions mcp`;

  const bin = pkg.bin;
  if (bin && typeof bin === 'object') {
    const binHit = Object.keys(bin as Record<string, unknown>).find((k) => looksLikeMcpToken(k));
    if (binHit) return `bin.${binHit} mentions mcp`;
  }

  const depHit = Object.keys(pkg.dependencies ?? {}).find((k) => looksLikeMcpToken(k));
  if (depHit) return `dependencies.${depHit} mentions mcp`;

  const sdkHit = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})].find((k) =>
    k.startsWith('@modelcontextprotocol/'),
  );
  if (sdkHit) return `${sdkHit} (MCP SDK) dependency`;

  return undefined;
}

/**
 * MCP hint scoped to a single workspace package: name match, an
 * @modelcontextprotocol/* dependency, an "mcp"-mentioning script (key or
 * value), an "mcp"-mentioning bin entry key, or an mcp.json in its dir.
 * Uses the same word-ish MCP_TOKEN_RE as the local check so a workspace
 * package's plain deps can't trip on a substring the local check wouldn't.
 */
function workspacePackageHasMcpHint(wp: WorkspacePackage): boolean {
  const pkg = wp.pkg as PkgJson | undefined;
  if (looksLikeMcpToken(pkg?.name)) return true;
  const depKeys = [...Object.keys(pkg?.dependencies ?? {}), ...Object.keys(pkg?.devDependencies ?? {})];
  if (depKeys.some((k) => k.startsWith('@modelcontextprotocol/'))) return true;
  const scripts = pkg?.scripts ?? {};
  if (Object.entries(scripts).some(([k, v]) => looksLikeMcpToken(k) || looksLikeMcpToken(v))) return true;
  const bin = pkg?.bin;
  if (bin && typeof bin === 'object') {
    if (Object.keys(bin as Record<string, unknown>).some((k) => looksLikeMcpToken(k))) return true;
  }
  if (existsSync(join(wp.dir, 'mcp.json'))) return true;
  return false;
}

/** First workspace package (if any) that trips workspacePackageHasMcpHint, for naming in the finding. */
function findWorkspaceMcpHint(workspacePkgs: WorkspacePackage[]): WorkspacePackage | undefined {
  return workspacePkgs.find(workspacePackageHasMcpHint);
}

/** First workspace package (if any) that ships its own registry.json. */
function findWorkspaceRegistryHint(workspacePkgs: WorkspacePackage[]): WorkspacePackage | undefined {
  return workspacePkgs.find((wp) => existsSync(join(wp.dir, 'registry.json')));
}

/**
 * Builder-side agent tooling at the system root: .claude/agents,
 * .claude/commands, .claude/hooks (each counted by file), and a
 * .claude/settings.json whose JSON has a "hooks" key. Returns undefined
 * (no finding at all) when none are present.
 */
function builderToolingFinding(root: string): AuditFinding | undefined {
  const parts: string[] = [];
  const agentsDir = join(root, '.claude', 'agents');
  const commandsDir = join(root, '.claude', 'commands');
  const hooksDir = join(root, '.claude', 'hooks');
  if (existsSync(agentsDir)) parts.push(`.claude/agents (${walkFiles(agentsDir).length})`);
  if (existsSync(commandsDir)) parts.push(`.claude/commands (${walkFiles(commandsDir).length})`);
  if (existsSync(hooksDir)) parts.push(`.claude/hooks (${walkFiles(hooksDir).length})`);
  const settings = readJsonSafe<Record<string, unknown>>(join(root, '.claude', 'settings.json'));
  if (settings && Object.prototype.hasOwnProperty.call(settings, 'hooks')) parts.push('settings hooks');
  if (parts.length === 0) return undefined;
  return { severity: 'info', message: `Builder-side agent tooling found: ${parts.join(', ')}.` };
}

const EDITOR_RULE_CANDIDATES = ['.cursorrules', join('.cursor', 'rules'), join('.github', 'copilot-instructions.md')];

/** Which editor-rules file exists (for naming in the finding), or undefined if none do. */
function editorRulesEvidence(root: string): string | undefined {
  const hit = EDITOR_RULE_CANDIDATES.find((c) => existsSync(join(root, c)));
  return hit ? hit.split(sep).join('/') : undefined;
}

/** Which registry hint exists at the local (root or components-package) scope (for naming in the finding), or undefined if none do. */
function registryEvidence(root: string, componentsPkgDir: string, pkg: PkgJson | undefined): string | undefined {
  if (existsSync(join(root, 'registry.json'))) return 'registry.json at system root';
  if (componentsPkgDir !== root && existsSync(join(componentsPkgDir, 'registry.json'))) {
    return `registry.json in ${relative(root, componentsPkgDir).split(sep).join('/')}`;
  }
  if (pkg?.publishConfig?.registry) return `package.json publishConfig.registry ("${pkg.publishConfig.registry}")`;
  const exportsRegistryKey = pkg?.exports ? Object.keys(pkg.exports).find((k) => k.includes('registry')) : undefined;
  if (exportsRegistryKey) return `package.json exports["${exportsRegistryKey}"]`;
  return undefined;
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

/** Number of skill bundles inside a skill dir — each skill is conventionally its own subdirectory (e.g. .claude/skills/<name>/SKILL.md). */
function countSkillEntries(absDir: string): number {
  try {
    return readdirSync(absDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

/** Every skill dir (configured or generic) that actually exists on disk, for naming in the finding — plus configured entries that don't. */
function skillDirsEvidence(root: string, cfg: SystemConfig): { matched: string[]; configuredMissing: string[] } {
  const configured = cfg.agentContext.skillDirs ?? [];
  const configuredMissing = configured.filter((d) => !existsSync(join(root, d)));
  const configuredMatched = configured.filter((d) => existsSync(join(root, d)));
  const genericDirs = ['.agents/skills', '.claude/skills', 'skills'];
  const genericMatched = genericDirs.filter((d) => existsSync(join(root, d)));
  const matched = [...new Set([...configuredMatched, ...genericMatched])];
  return { matched, configuredMissing };
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
    findings.push({ severity: 'info', message: 'llms.txt present at system root.' });
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
    const catalogEvidence =
      catalogLoad.source === 'catalog-json-live'
        ? `catalog-json file (${cfg.catalogFile ?? 'configured catalogFile'})`
        : 'pre-extracted catalog snapshot';
    findings.push({ severity: 'info', message: `Machine-readable catalog found: ${catalogEvidence}.` });
  } else if (catalogLoad.source === 'empty-extract') {
    // Distinct from plain absence: a snapshot exists but was extracted with
    // zero exports, almost always an unsupported repo layout defeating the
    // extractor (field test: Radix's package-specifier re-exports), NOT
    // evidence the system itself lacks a catalog. Award nothing, but don't
    // pile on with the generic "no catalog found" fail either.
    findings.push({
      severity: 'warn',
      message: 'Extraction produced an empty catalog (0 exports) — machine catalog treated as unmeasured; likely an unsupported repo layout, not a missing catalog.',
    });
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
  const workspacePkgs = listWorkspacePackages(root);
  // Evidence is collected from BOTH scopes unconditionally — the workspace
  // scan must never be short-circuited by a local hit (that's exactly the
  // bug that hid Primer's real packages/mcp behind a Storybook
  // devDependency false positive). When both exist, the workspace hit is
  // named: it's the shippable MCP artifact, where the local hint is often
  // just a script or an SDK dependency.
  const localMcpEvidenceHit = localMcpEvidence(root, pkg);
  const workspaceMcpHit = findWorkspaceMcpHint(workspacePkgs);
  if (workspaceMcpHit) {
    score += 10;
    const name = typeof (workspaceMcpHit.pkg as PkgJson | undefined)?.name === 'string' ? ` (${(workspaceMcpHit.pkg as PkgJson).name})` : '';
    findings.push({ severity: 'info', message: `MCP server found in workspace package ${workspaceMcpHit.relDir}${name}.` });
  } else if (localMcpEvidenceHit) {
    score += 10;
    findings.push({ severity: 'info', message: `MCP hint: ${localMcpEvidenceHit}.` });
  } else {
    findings.push({
      severity: 'warn',
      message: 'No MCP server hint found (no mcp.json, no .well-known/mcp, no "mcp" script/bin/dependency, and no workspace package name/deps/scripts/bin suggesting one).',
      fix: 'MCP adoption is 95% among AI-native systems in the survey: the highest-adoption asset of the whole checklist.',
    });
  }

  // --- skills dirs (10) ---
  const skills = skillDirsEvidence(root, cfg);
  if (skills.matched.length > 0) {
    score += 10;
    const parts = skills.matched.map((d) => `${d} (${countSkillEntries(join(root, d))} skills)`);
    findings.push({ severity: 'info', message: `Skill bundles found: ${parts.join(', ')}.` });
  } else {
    findings.push({ severity: 'warn', message: 'No agent skill bundles found (.agents/skills, .claude/skills, or configured skillDirs).' });
  }
  for (const missing of skills.configuredMissing) {
    findings.push({ severity: 'warn', message: `Configured skillDirs entry "${missing}" does not exist on disk.` });
  }

  // --- editor rules (10) ---
  const editorRulesHit = editorRulesEvidence(root);
  if (editorRulesHit) {
    score += 10;
    findings.push({ severity: 'info', message: `Editor rules found: ${editorRulesHit}.` });
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
  const localRegistryEvidence = registryEvidence(root, componentsPkgDir, pkg);
  const workspaceRegistryHit = localRegistryEvidence ? undefined : findWorkspaceRegistryHint(workspacePkgs);
  if (localRegistryEvidence) {
    score += 5;
    findings.push({ severity: 'info', message: `Registry hint found: ${localRegistryEvidence}.` });
  } else if (workspaceRegistryHit) {
    score += 5;
    findings.push({ severity: 'info', message: `Registry hint found: registry.json in workspace package ${workspaceRegistryHit.relDir}.` });
  } else {
    findings.push({ severity: 'info', message: 'No registry hint found (registry.json, publishConfig.registry).' });
  }

  // --- builder-side agent tooling (info only, unscored — see file header) (P2 2.2) ---
  const builderFinding = builderToolingFinding(root);
  if (builderFinding) findings.push(builderFinding);

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
