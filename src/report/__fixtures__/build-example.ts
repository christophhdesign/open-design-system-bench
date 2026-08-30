// Regenerates docs/report-example.md from the committed fixture run, so the
// example's generated sections are byte-exact by construction.
//
// Run from the repo root when document.test.ts reports a G3 mismatch on the
// example, which means a generated block's rendering changed:
//
//   npx tsx src/report/__fixtures__/build-example.ts
//
// The prose below is the example's interpretation layer. Edit it here, not in
// docs/report-example.md, or the next regeneration will overwrite it.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dump } from 'js-yaml';
import { buildRunResults } from '../aggregate.ts';
import { computeAuditScore } from '../../audit/score.ts';
import { buildGeneratedFrontMatter, buildReportStats, renderStatsBlocks, REPORT_OUTLINE, headingFor } from '../stats.ts';

const fx = JSON.parse(readFileSync(join(process.cwd(), 'src/report/__fixtures__/example-run.json'), 'utf8'));
const run = buildRunResults(fx.manifest, fx.records);
const score = computeAuditScore(fx.checks, run, 'my-system');
const stats = buildReportStats(run, 'my-system', fx.config, fx.checks, score, fx.extraction);
const blocks = renderStatsBlocks(stats);
const generated = buildGeneratedFrontMatter(stats, run) as Record<string, Record<string, unknown>>;

const frontMatter = {
  schemaVersion: 1,
  reportId: 'my-system-2026-01-01-medium',
  generatedAt: '2026-01-01',
  title: 'My system - AI-readiness benchmark report',
  author: { kind: 'agent', model: 'claude-opus-5', tool: 'claude-code' },
  subject: {
    systemId: 'my-system',
    displayName: 'My system',
    commit: 'abc1234',
    packages: [
      { name: '@example/components', version: '2.4.0', role: 'components' },
      { name: '@example/tokens', version: '1.1.0', role: 'foundations' },
    ],
  },
  harness: { version: '0.1.0', repo: 'https://github.com/open-design-system-bench' },
  provenance: generated.provenance,
  methodology: {
    ...generated.methodology,
    judge: { model: 'haiku', samples: 1 },
    fixtureTemplate: 'fixtures/my-app',
    deviations: [
      {
        change: 'Tailwind removed from the fixture template.',
        rationale: 'Consumers of this system do not use Tailwind. Leaving it in would offer the agent a styling escape hatch that does not exist in production, which distorts tokenDiscipline.',
      },
    ],
  },
  results: generated.results,
  audit: generated.audit,
  citedFigures: [
    {
      id: 'token-source-references',
      value: 118,
      source: 'packages/tokens/src/semantic-colors.json',
      method: 'count of values referencing another token by name in the token source, before the build step flattens them',
    },
  ],
  findings: [
    {
      id: 'no-agents-md',
      title: 'No AGENTS.md at the system root',
      severity: 'gap',
      status: 'confirmed',
      owner: 'system',
      section: '5.1',
      evidence: [{ kind: 'auditCheck', checkId: 'surface' }],
      recommendationIds: ['add-agents-md'],
    },
    {
      id: 'flat-token-output',
      title: 'Token references are flattened at build time',
      severity: 'gap',
      status: 'confirmed',
      owner: 'system',
      section: '5.2',
      evidence: [
        { kind: 'auditCheck', checkId: 'tokens' },
        { kind: 'figure', figureId: 'token-source-references' },
      ],
      recommendationIds: ['emit-token-references'],
    },
    {
      id: 'input-not-textfield',
      title: 'Input diverges from the TextField convention',
      severity: 'divergence',
      status: 'confirmed',
      owner: 'system',
      section: '5.3',
      evidence: [{ kind: 'auditCheck', checkId: 'vocabulary' }],
    },
    {
      id: 'skill-bypasses-pagination',
      title: 'The skill steered the agent away from the shipped Pagination',
      severity: 'defect',
      status: 'confirmed',
      owner: 'system',
      section: '5.4',
      evidence: [
        {
          kind: 'cell',
          runId: '20260101-000000-example',
          cellKey: 'my-system_skill_sonnet',
          taskId: 'data-table-pagination',
          rep: 1,
          dimension: 'apiFidelity',
        },
      ],
      recommendationIds: ['name-pagination-in-skill'],
    },
    {
      id: 'destructive-action-hierarchy',
      title: 'Destructive actions carry the same emphasis as safe ones',
      severity: 'defect',
      status: 'open',
      owner: 'system',
      section: '5.5',
      evidence: [
        {
          kind: 'cell',
          runId: '20260101-000000-example',
          cellKey: 'my-system_agents-md_sonnet',
          taskId: 'destructive-confirmation',
          rep: 1,
          dimension: 'judgment',
        },
      ],
      recommendationIds: ['encode-action-hierarchy'],
    },
  ],
  recommendations: [
    { id: 'add-agents-md', title: 'Add an AGENTS.md at the system root', effort: 'low', breaking: false, findingIds: ['no-agents-md'] },
    { id: 'emit-token-references', title: 'Enable outputReferences in the token build', effort: 'low', breaking: false, findingIds: ['flat-token-output'] },
    { id: 'name-pagination-in-skill', title: 'Name Pagination explicitly in the skill bundle', effort: 'low', breaking: false, findingIds: ['skill-bypasses-pagination'] },
    { id: 'encode-action-hierarchy', title: 'Encode destructive-action hierarchy as a composition rule', effort: 'medium', breaking: false, findingIds: ['destructive-action-hierarchy'] },
  ],
  validityLimits: [
    { id: 'single-rep', text: 'Every cell is a single sample. Nothing here distinguishes a systematic effect from model variance. Three repetitions are the minimum for that.' },
    { id: 'no-bare-context', text: 'The run has no bare context, so Lift is unmeasurable and the composite falls back to partial-behavioral. It should not be compared against a composite computed on a different basis.' },
    { id: 'authors-rubrics', text: 'The judgment rubrics ship with the benchmark and encode its author\'s view of good design, not this system\'s. Rewriting them would turn this axis into a conformance test.' },
  ],
};

const prose: Record<string, string> = {
  '2': [
    'The benchmark was pointed at this system as it stands. No files were added to the system',
    'repository to improve its score, and the repository was read from only.',
  ].join('\n'),

  '2.4': [
    'The stock fixture template was modified in one respect:',
    '',
    '| Change | Rationale |',
    '|---|---|',
    '| Tailwind removed | Consumers of this system do not use Tailwind. Retaining it would offer the agent a styling escape hatch that does not exist in production, distorting `tokenDiscipline`. |',
    '',
    'Comparability caveat: this deviation means scores are not strictly comparable against other',
    'systems benchmarked on the unmodified template. The `comparabilityKey` in the front matter',
    'records it.',
  ].join('\n'),

  '4': 'Per-cell scores and the context comparison follow. Every figure below is generated.',

  '5': [
    'Five findings. Each cites evidence that resolves against the run or the static audit.',
    '',
    '### 5.1 No AGENTS.md at the system root',
    '',
    'The enablement surface check scored 35.0, the lowest of the seven static checks, and reports',
    'no `AGENTS.md` or `CLAUDE.md` at the system root.',
    '',
    'This matters more than its weight suggests. Every guided context level begins by copying the',
    'files named in `agentContext.agentsMd`, so the absence of a purpose-written one means the',
    'benchmark measures whatever general-purpose README happens to be there instead. It is the',
    'single highest-leverage missing asset.',
    '',
    '### 5.2 Token references are flattened at build time',
    '',
    'Token machine-readability scored 40.0, reporting that no shipped custom property references',
    'another. The measurement is accurate for the shipped artefact, but the inference that this is',
    'a flat token list is wrong: the token source does carry a semantic layer, with 118 references',
    'that the build step resolves rather than emitting as `var()` chains.',
    '',
    'The semantic layer exists in source and is destroyed in output, so anything consuming the',
    'shipped CSS, agents included, sees only flat literals. This is an output-format change, not a',
    'token redesign.',
    '',
    '### 5.3 Input diverges from the TextField convention',
    '',
    'The vocabulary check reports that models invented the name `TextField` 21 times across its',
    'mined sample, where this system ships `Input`.',
    '',
    'This is a divergence, not a defect. Every design system chooses names, and the number only',
    'quantifies how often a model will guess wrong before reading the source. It is worth knowing',
    'when writing the `AGENTS.md` that 5.1 calls for: naming the alias explicitly costs one line.',
    '',
    '### 5.4 The skill steered the agent away from the shipped Pagination',
    '',
    'The `data-table-pagination` task under the `skill` context scored 0.0 on `apiFidelity` with',
    'the grader reporting no design-system components used, and gated `fail`. The agent wrote its',
    'own pagination component rather than importing the one the system ships.',
    '',
    'The generated code compiles and is accessible. It scored 100.0 on token discipline, faithfully',
    'using the system\'s custom properties while reimplementing a component the library already has.',
    'That combination is the signature of this failure mode: the output looks correct in isolation',
    'and is wrong in the only way that matters.',
    '',
    'The same task under `agents-md` used the shipped components and scored 100.00. The guidance',
    'layer made the result worse, which is exactly the comparison the context levels exist to make.',
    '',
    '### 5.5 Destructive actions carry the same emphasis as safe ones',
    '',
    'The `destructive-confirmation` task under `agents-md` scored 100.0 on all five mechanical',
    'dimensions and 40.0 on judgment. The judge found all three actions rendered with identical',
    'emphasis, so the destructive option carried the same visual weight as the safe one.',
    '',
    'The code was clean, compiling, token-correct and accessible. It also presented "cancel your',
    'subscription" with the same prominence as "keep my plan". This is the failure class the',
    'mechanical dimensions are structurally incapable of catching, and it is why judgment carries',
    'the heaviest weight.',
  ].join('\n'),

  '6': [
    'The `destructive-confirmation` cell described in 5.5 is worth restating as a pattern rather',
    'than an incident: mechanically perfect, and wrong.',
    '',
    '| Dimension | Score |',
    '|---|---|',
    '| Five mechanical dimensions | 100.0 each |',
    '| `judgment` | 40.0 |',
    '| Overall | 82.00 |',
    '',
    'A reader scanning only the mechanical columns would record this cell as a success. The gate',
    'caught it because a critical rubric failed, which is the worst-case gate doing its job.',
  ].join('\n'),

  '7': [
    'None. The harness ran without error, and no cell was lost to a benchmark defect.',
    '',
    'This section exists because a benchmark that never reports its own failures is not reporting',
    'honestly. When a cell is lost to a harness bug rather than to the system under test, it belongs',
    'here, with `owner: harness` on the corresponding finding, so it is never read as a defect in',
    'the design system.',
  ].join('\n'),

  '8': [
    'What this report does not support:',
    '',
    '1. **Single repetition.** Every cell is one sample. Nothing here distinguishes a systematic',
    '   effect from model variance. Three repetitions are the minimum to attribute a context',
    '   difference to the context rather than to the roll.',
    '2. **No bare context.** Lift is unmeasurable without one, so the composite reports a',
    '   `partial-behavioral` basis. It must not be read against a composite computed on a',
    '   different basis.',
    '3. **The rubrics are the benchmark author\'s.** Judgment carries the heaviest weight and',
    '   measures generic UI judgment, not conformance to this system\'s own composition rules.',
    '4. **One model, one agent.** No claim is made about how other models behave.',
  ].join('\n'),

  '9': [
    '**Low cost, do now:**',
    '',
    '1. Add an `AGENTS.md` at the system root (5.1). Highest-leverage single asset; every guided',
    '   context begins there. Name the `Input` alias while writing it (5.3).',
    '2. Enable `outputReferences` in the token build (5.2). Recovers the semantic layer in the',
    '   shipped artefact.',
    '3. Name `Pagination` explicitly in the skill bundle (5.4).',
    '',
    '**Needs a decision:**',
    '',
    '4. Encode destructive-action hierarchy as an explicit composition rule (5.5). This is a',
    '   question about what the system asserts, not a documentation fix.',
    '',
    '**Further measurement:**',
    '',
    '5. Run a profile that includes a `bare` context and three repetitions, for a defensible',
    '   composite and a real Lift figure.',
  ].join('\n'),
};

const lines: string[] = ['---', dump(frontMatter, { lineWidth: 100, noRefs: true }).trimEnd(), '---', ''];
lines.push(`# ${frontMatter.title}`, '');

for (const section of REPORT_OUTLINE) {
  lines.push(headingFor(section), '');
  const body = section.source === 'generated' ? blocks[section.number] : prose[section.number];
  if (body === undefined) throw new Error(`no content for section ${section.number}`);
  lines.push(body, '');
}

const out = join(process.cwd(), 'docs', 'report-example.md');
writeFileSync(out, `${lines.join('\n').replace(/\n+$/, '')}\n`);
console.log('wrote', out);
