/**
 * Flamingo Panel - cost against quantity.
 *
 * How the cheapest way to order changes with the number of boards: the
 * total and the cost per board at each of a set of quantities, each priced
 * by `quoteOrder` with every design's needed quantity set to that number.
 * Fees step (a panel holds so many boards, assembly setup is paid once), so
 * the curve shows where another few boards come almost free and where they
 * tip into another panel.
 */

import type { Objective, QuoteRequest, ScenarioKind } from './scenarios.js';
import { quoteOrder } from './scenarios.js';

/** Quantities the curve is priced at: dense where small orders change fastest. */
export const CURVE_QUANTITIES: readonly number[] = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 75, 100];

export interface CostPoint {
  /** Boards of each design. */
  quantity: number;
  total: number;
  perBoard: number;
  /** The cheapest way at this quantity. */
  way: { id: string; kind: ScenarioKind; title: string };
  /** Rests on at least one unverified number. */
  estimate: boolean;
}

export interface CostCurve {
  objective: Objective;
  designs: string[];
  points: CostPoint[];
  /** Quantities nothing could be ordered at, and why. */
  impossible: Array<{ quantity: number; reason: string }>;
  elapsedMs: number;
}

/**
 * Price every quantity in `quantities` (default `CURVE_QUANTITIES`). The
 * request's own quantities are ignored: each point sets every design's
 * `needed` to the point's quantity, so the curve is per design.
 */
export function costCurve(req: QuoteRequest, quantities: readonly number[] = CURVE_QUANTITIES): CostCurve {
  const t0 = performance.now();
  const designs = req.sources.filter((s) => req.resolved.some((r) => r.key === s.key && r.geometry));
  const points: CostPoint[] = [];
  const impossible: CostCurve['impossible'] = [];
  for (const quantity of quantities) {
    if (!Number.isInteger(quantity) || quantity < 1) continue;
    const q = quoteOrder({
      ...req,
      sources: designs.map((s) => ({ ...s, needed: quantity })),
    });
    const best = q.scenarios[0];
    if (!best) {
      impossible.push({ quantity, reason: q.rejected[0]?.reason ?? 'no way to order' });
      continue;
    }
    points.push({
      quantity,
      total: best.total,
      perBoard: best.costPerNeededBoard,
      way: { id: best.id, kind: best.kind, title: best.title },
      estimate: best.estimate,
    });
  }
  return {
    objective: req.objective ?? 'total',
    designs: designs.map((s) => s.key),
    points,
    impossible,
    elapsedMs: Math.round(performance.now() - t0),
  };
}
