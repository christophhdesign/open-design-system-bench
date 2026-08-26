// Token extraction: a deliberately dumb line-oriented scan of a system's
// Tailwind v4 foundations CSS. We don't need a real CSS parser here — the
// two shapes we care about (`--custom-property:` declarations and
// `@utility name` blocks) are both single-line, column-0-ish constructs in
// these files, and a line scan is far more robust to Tailwind v4's nested
// `@theme`/`@layer`/`@custom-variant` blocks than trying to balance braces.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SystemConfig, SystemId, SystemTokens } from '../types.ts';

const CSS_VAR_DECL_RE = /^\s*(--[\w-]+)\s*:/;
const UTILITY_RE = /^\s*@utility\s+([\w-]+)/;
const TYPOGRAPHY_RE = /^(body|heading|display|label)/i;

/** cssHash used when a system has no foundationsCss configured — never matches a real content hash. */
export const NO_FOUNDATIONS_CSS_HASH = 'no-foundations-css';

export async function extractSystemTokens(system: SystemId, cfg: SystemConfig): Promise<SystemTokens> {
  if (!cfg.foundationsCss) {
    // foundationsCss is optional: a system with no CSS-custom-property token
    // file just gets an empty token set. Downstream graders degrade
    // gracefully — tokenDiscipline doesn't consult tokens at all, and
    // apiFidelity's contamination-casing check already no-ops when there are
    // no typography utilities to derive prefixes from.
    return {
      system,
      generatedAt: new Date().toISOString(),
      cssVars: [],
      utilities: [],
      typographyUtilities: [],
      cssHash: NO_FOUNDATIONS_CSS_HASH,
    };
  }

  const cssPath = join(cfg.root, cfg.foundationsCss);
  const content = readFileSync(cssPath, 'utf8');
  const lines = content.split(/\r?\n/);

  const cssVarSet = new Set<string>();
  const utilitySet = new Set<string>();

  for (const line of lines) {
    const varMatch = CSS_VAR_DECL_RE.exec(line);
    if (varMatch) cssVarSet.add(varMatch[1]);

    const utilMatch = UTILITY_RE.exec(line);
    if (utilMatch) utilitySet.add(utilMatch[1]);
  }

  const cssVars = [...cssVarSet].sort();
  const utilities = [...utilitySet].sort();
  const typographyUtilities = utilities.filter((u) => TYPOGRAPHY_RE.test(u));

  const cssHash = createHash('sha256').update(content).digest('hex');

  return {
    system,
    generatedAt: new Date().toISOString(),
    cssVars,
    utilities,
    typographyUtilities,
    cssHash,
  };
}
