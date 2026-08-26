// Shared input contract for mechanical + judgment graders.

import type { SystemCatalog, SystemConfig, SystemId, SystemTokens, Task } from '../types.ts';
import type { FileAnalysis } from './ast.ts';

export interface AnalyzedFile {
  path: string;
  source: string;
  analysis: FileAnalysis;
}

export interface GradeContext {
  system: SystemId;
  systemCfg: SystemConfig;
  catalog: SystemCatalog;
  tokens: SystemTokens;
  task: Task;
  files: AnalyzedFile[];
  workspaceDir: string;
}
