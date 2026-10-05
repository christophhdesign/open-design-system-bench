// Shared input contract for mechanical + judgment graders.

import type { SystemCatalog, SystemConfig, SystemId, SystemTokens, Task } from '../types.ts';
import type { FileAnalysis } from './ast.ts';

export interface AnalyzedFile {
  path: string;
  source: string;
  analysis: FileAnalysis;
}

/** A collected .css/.scss file. No AST: only tokenDiscipline reads these. */
export interface StyleFile {
  path: string;
  source: string;
}

export interface GradeContext {
  system: SystemId;
  systemCfg: SystemConfig;
  catalog: SystemCatalog;
  tokens: SystemTokens;
  task: Task;
  files: AnalyzedFile[];
  styles: StyleFile[];
  workspaceDir: string;
}
