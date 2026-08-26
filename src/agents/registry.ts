import type { AgentAdapter } from '../types.ts';
import { claudeCodeAdapter } from './claude-code.ts';
import { codexAdapter } from './codex.ts';
import { apiOneshotAdapter } from './api-oneshot.ts';

const adapters: Record<string, AgentAdapter> = {
  [claudeCodeAdapter.id]: claudeCodeAdapter,
  [codexAdapter.id]: codexAdapter,
  [apiOneshotAdapter.id]: apiOneshotAdapter,
};

export function getAdapter(id: string): AgentAdapter {
  const adapter = adapters[id];
  if (!adapter) {
    throw new Error(`unknown agent adapter "${id}" (known: ${Object.keys(adapters).join(', ')})`);
  }
  return adapter;
}
