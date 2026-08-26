import type { AgentAdapter } from '../types.ts';

// Interface-proving stub: a second agent CLI slot for future benchmarks
// (e.g. codex). Not wired to a real binary yet.
export const codexAdapter: AgentAdapter = {
  id: 'codex',
  async detect() {
    return { ok: false, error: 'codex adapter is a stub — not implemented yet' };
  },
  async generate() {
    throw new Error('codex adapter is a stub — not implemented yet');
  },
};
