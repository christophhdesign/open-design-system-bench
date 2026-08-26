// Qualified model strings: "provider:model" routes generation/judging through
// a configured API provider instead of the claude CLI. The split is
// deliberately conservative — a prefix only counts as a provider if it's
// actually a key in bench.config.json "providers" — so plain model names
// that happen to contain no colon ("sonnet", "claude-sonnet-5") are
// unaffected, and an unrecognized "foo:bar" is treated as a literal model
// name rather than silently failing to resolve a provider.

import type { BenchConfig } from '../types.ts';

export interface ParsedModelSpec {
  /** Provider id (key into bench.providers), present only when the prefix matched a configured provider. */
  provider?: string;
  /** The model name to send to the provider/CLI — the qualifier prefix (if any) is stripped. */
  model: string;
}

export function parseModelSpec(spec: string, bench: BenchConfig): ParsedModelSpec {
  const idx = spec.indexOf(':');
  if (idx === -1) return { model: spec };

  const prefix = spec.slice(0, idx);
  const rest = spec.slice(idx + 1);
  if (bench.providers && Object.prototype.hasOwnProperty.call(bench.providers, prefix)) {
    return { provider: prefix, model: rest };
  }
  return { model: spec };
}
