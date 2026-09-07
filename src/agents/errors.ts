// Usage-limit detection shared by the generating adapter (claude-code.ts) and
// the judge (grade/judge.ts). Centralized here so both sides agree on what
// counts as "the claude CLI is out of usage" vs. an ordinary failure, and so
// the runner can pause a benchmark run instead of burning the rest of the
// matrix as errored cells.

/**
 * Case-insensitive signals seen in claude CLI stdout/stderr when the
 * account/session has hit a usage or rate limit. Kept as an array (rather than
 * one combined RegExp) so new phrasings can be appended without touching the
 * matching logic.
 */
export const USAGE_LIMIT_PATTERNS: RegExp[] = [
  /usage limit/i,
  /rate limit/i,
  /limit reached/i,
  /out of credits?/i,
  /quota/i,
  /resets at/i,
  /too many requests/i,
  /overloaded/i,
  // Claude Code seat/spend caps ("You've hit your individual spend limit ·
  // run /usage-credits to ask your admin for a higher limit") — seen live 2026-08-25.
  /spend limit/i,
  /usage-credits/i,
  /insufficient credits/i,
  // Subscription session/weekly caps ("You've hit your session limit · resets
  // 2am (Europe/Berlin)") — seen live 2026-09-03; note "resets 2am" has no "at",
  // so /resets at/ above did not match and 25 cells burned as agent-error.
  /session limit/i,
  /hit your (?:\w+ )*limit/i,
  /resets (?:at )?\d/i,
];

export function looksLikeUsageLimit(text: string | undefined | null): boolean {
  if (!text) return false;
  return USAGE_LIMIT_PATTERNS.some((re) => re.test(text));
}

/** Thrown (instead of a generic Error) when a claude CLI failure is classified as a usage limit. */
export class UsageLimitError extends Error {
  constructor(detail: string) {
    super(`usage limit hit: ${detail}`);
    this.name = 'UsageLimitError';
  }
}
