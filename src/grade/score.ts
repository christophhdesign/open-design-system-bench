// Composes individual DimensionResults (mechanical + judgment) into the
// final per-cell EvalResult, and orchestrates the five mechanical graders.

import { rubric } from '../../rubric.config.ts';
import type { DimensionResult, Diff, EvalResult, Gate } from '../types.ts';
import type { GradeContext } from './context.ts';
import { gradeImports } from './mechanical/imports.ts';
import { gradeApiFidelity } from './mechanical/api-fidelity.ts';
import { gradeTokenDiscipline } from './mechanical/token-discipline.ts';
import { gradeA11yStatic } from './mechanical/a11y-static.ts';
import { gradeCompile } from './mechanical/compile.ts';

const GATE_RANK: Record<Gate, number> = { pass: 0, review: 1, fail: 2 };

/**
 * Weighted mean of dimension scores using rubric.config.ts weights,
 * renormalized over whatever dimensions are actually present — so grading a
 * run without the judge dimension (e.g. mechanical-only) still lands 0–100
 * instead of being capped at (1 - judgment.weight) * 100.
 */
export function composeResult(dimensions: DimensionResult[]): EvalResult {
  const weights: Record<string, number> = rubric.weights;

  const byDimension: Record<string, DimensionResult> = {};
  const diffs: Diff[] = [];
  let weightSum = 0;
  let weightedScore = 0;
  let worstGate: Gate = 'pass';

  for (const d of dimensions) {
    byDimension[d.dimension] = d;
    diffs.push(...d.diffs);

    if (GATE_RANK[d.gate] > GATE_RANK[worstGate]) worstGate = d.gate;

    const w = weights[d.dimension];
    if (typeof w === 'number') {
      weightSum += w;
      weightedScore += w * d.score;
    }
  }

  const overall = weightSum > 0 ? weightedScore / weightSum : 0;

  return {
    overall,
    gate: worstGate,
    dimensions: byDimension,
    diffs,
  };
}

/** Runs all five mechanical graders (awaiting the async ones) for a cell. */
export async function runMechanical(ctx: GradeContext): Promise<DimensionResult[]> {
  const [a11yStatic, compile] = await Promise.all([gradeA11yStatic(ctx), gradeCompile(ctx)]);

  return [gradeImports(ctx), gradeApiFidelity(ctx), gradeTokenDiscipline(ctx), a11yStatic, compile];
}
