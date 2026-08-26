// Dimension weights + gate policy for per-task score composition.
// overall = Σ(weight_d × score_d); gate = worst-case across dimensions.

export const rubric = {
  weights: {
    imports: 0.1,
    apiFidelity: 0.25,
    tokenDiscipline: 0.15,
    a11yStatic: 0.1,
    compile: 0.1,
    judgment: 0.3,
  },
  // Which findings force which gates (documented here, enforced in graders):
  // - hallucinated component        → fail   (headline metric)
  // - compile error                 → fail
  // - ≥2 foreign UI-lib imports     → fail, 1 → review
  // - invented prop                 → review (docgen gaps get human triage)
  // - spread props (unverifiable)   → cap at review
  // - >3 token violations           → review
  // - any static a11y error         → review
  // - failed critical judge rubric  → review (judge alone never fails a run)
  gates: {
    hallucinatedComponent: 'fail',
    compileError: 'fail',
    inventedProp: 'review',
    criticalRubricFail: 'review',
  },
} as const;

export type DimensionId = keyof typeof rubric.weights;
