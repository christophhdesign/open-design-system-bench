// Loads and interprets convention-lexicon.json — the empirically mined list
// of component/prop names four models reached for across 898 graded
// benchmark generations when a name didn't exist in either production
// design system. Consumed by the `vocabulary` Tier-0 check (static,
// catalog-vs-lexicon diff) and by score.ts's Vocabulary-behavioral sub-score
// (RunResults-vs-lexicon diff).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LEXICON_PATH = join(dirname(fileURLToPath(import.meta.url)), 'convention-lexicon.json');

export interface LexiconEntry {
  expected: string;
  occurrences: number;
  concept: string;
  note?: string;
}

export interface ConventionLexicon {
  $comment?: string;
  version: number;
  minedAt: string;
  sampleCells: number;
  components: LexiconEntry[];
  props: LexiconEntry[];
}

let cached: ConventionLexicon | undefined;

/** Reads + parses src/audit/convention-lexicon.json once per process. */
export function loadLexicon(): ConventionLexicon {
  if (!cached) {
    cached = JSON.parse(readFileSync(LEXICON_PATH, 'utf8')) as ConventionLexicon;
  }
  return cached;
}

/**
 * Extracts alias name(s) mentioned in a lexicon entry's `note`, e.g.
 * "often Toggle elsewhere" -> ["Toggle"], "cx/clsx/twMerge elsewhere" ->
 * ["cx", "clsx", "twMerge"], "Stack or View elsewhere" -> ["Stack", "View"].
 * Notes that don't name a concrete alternative (e.g. "MUI vocabulary") yield
 * no aliases — there's nothing concrete to check the catalog for. This is a
 * text heuristic over free-form notes, not a structured field, so it only
 * catches the "X/Y elsewhere" / "often X (or Y) elsewhere" phrasing the
 * lexicon's own notes consistently use.
 */
export function extractAliases(note: string | undefined): string[] {
  if (!note) return [];
  const m = /(?:often |; )?([\w/]+(?:\s+or\s+[\w/]+)*)\s+elsewhere/i.exec(note);
  if (!m) return [];
  return m[1]
    .split(/\s*(?:\/|\s+or\s+)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Marks entries whose note explicitly says the concept is intentionally
 * absent in a well-designed system (e.g. Chakra-style margin-shorthand
 * props). Those must never be scored as a naming gap — the model inventing
 * `mb` is the anti-pattern, not the system's lack of an `mb` prop — so
 * vocabulary scoring treats them as always n/a regardless of presence.
 */
export function isIntentionallyAbsent(entry: LexiconEntry): boolean {
  return /by design/i.test(entry.note ?? '');
}
