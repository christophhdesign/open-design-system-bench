// Aggregation: turns raw per-rep CellRecord[] into the per-(cellKey × taskId)
// summary rows that the report/CI surfaces consume. Pure and side-effect free —
// callers own reading the manifest/records off disk.

import type { CellRecord, Gate, RunManifest, RunResults } from '../types.ts';
import { cellKey } from '../types.ts';

/** pass < review < fail. Exported so ci.ts can compare gates without duplicating the order. */
export const GATE_RANK: Record<Gate, number> = { pass: 0, review: 1, fail: 2 };

export function worstGate(gates: Gate[]): Gate {
  let worst: Gate = 'pass';
  for (const g of gates) {
    if (GATE_RANK[g] > GATE_RANK[worst]) worst = g;
  }
  return worst;
}

function populationStd(values: number[], mean: number): number {
  if (values.length === 0) return 0;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

interface Group {
  cellKey: string;
  system: RunResults['aggregates'][number]['system'];
  context: RunResults['aggregates'][number]['context'];
  model: string;
  taskId: string;
  okRecords: CellRecord[];
}

/**
 * Aggregates ok-status records into RunResults['aggregates'].
 *
 * Cells with zero ok records (fully skipped or fully errored) intentionally
 * produce NO aggregate entry — they remain visible only through `records` and
 * `manifest.cells`, so consumers must not assume every planned cell has a
 * corresponding aggregate.
 */
export function buildRunResults(manifest: RunManifest, records: CellRecord[]): RunResults {
  const groups = new Map<string, Group>();

  for (const rec of records) {
    const ck = cellKey(rec.cell);
    const groupKey = `${ck}::${rec.taskId}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        cellKey: ck,
        system: rec.cell.system,
        context: rec.cell.context,
        model: rec.cell.model,
        taskId: rec.taskId,
        okRecords: [],
      };
      groups.set(groupKey, group);
    }
    if (rec.status === 'ok' && rec.result) {
      group.okRecords.push(rec);
    }
  }

  const aggregates: RunResults['aggregates'] = [];

  for (const group of groups.values()) {
    const { okRecords } = group;
    if (okRecords.length === 0) continue; // no ok reps → no aggregate, per contract

    const overalls = okRecords.map((r) => r.result!.overall);
    const n = overalls.length;
    const meanOverall = overalls.reduce((a, b) => a + b, 0) / n;
    const stdOverall = populationStd(overalls, meanOverall);
    const gate = worstGate(okRecords.map((r) => r.result!.gate));

    const dimensionSums = new Map<string, { sum: number; count: number }>();
    for (const rec of okRecords) {
      for (const [dimId, dimResult] of Object.entries(rec.result!.dimensions)) {
        const entry = dimensionSums.get(dimId) ?? { sum: 0, count: 0 };
        entry.sum += dimResult.score;
        entry.count += 1;
        dimensionSums.set(dimId, entry);
      }
    }
    const meanDimensions: Record<string, number> = {};
    for (const [dimId, { sum, count }] of dimensionSums) {
      meanDimensions[dimId] = sum / count;
    }

    aggregates.push({
      cellKey: group.cellKey,
      system: group.system,
      context: group.context,
      model: group.model,
      taskId: group.taskId,
      n,
      meanOverall,
      stdOverall,
      worstGate: gate,
      meanDimensions,
    });
  }

  return {
    runId: manifest.runId,
    manifest,
    records,
    aggregates,
  };
}
