// Shared contracts for the Tier-0 static audit (P1). Local to src/audit/ —
// deliberately not folded into src/types.ts, which another agent owns.

import type { SystemConfig, SystemId } from '../types.ts';

export type Severity = 'info' | 'warn' | 'fail';

export interface AuditFinding {
  severity: Severity;
  message: string;
  fix?: string;
}

export interface AuditCheckResult {
  id: string;
  title: string;
  /** 0-100, or null when the check could not run at all (e.g. no catalog available) — never a crash. */
  score: number | null;
  findings: AuditFinding[];
}

/** catalogsDir/tokensDir resolved once per invocation (config-parameterized, per resolveDataDirs) and threaded to every check. */
export interface AuditDirs {
  catalogsDir: string;
  tokensDir: string;
}

/** Uniform signature every Tier-0 check implements — see src/audit/run.ts for the orchestrator that calls all seven. */
export type AuditCheckFn = (system: SystemId, cfg: SystemConfig, dirs: AuditDirs) => Promise<AuditCheckResult>;
