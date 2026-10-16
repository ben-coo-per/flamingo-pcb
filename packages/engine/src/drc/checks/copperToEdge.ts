/**
 * DRC check: copper-to-edge clearance — minimum distance from any copper
 * item's boundary to the board outline's boundary. Skipped entirely when
 * there's no outline (or it doesn't close) — that's the 'missing-outline'
 * check's job (see outline.ts).
 */
import type { Board, PathSeg, Point } from '../../types.js';
import { outlineToPolygon, pointInPolygon, segSegDistance } from '../../geometry.js';
import { DRC_EPSILON } from '../rules.js';
import type { RuleSet } from '../rules.js';
import type { CopperItem, DrcViolation } from '../types.js';

/** Minimum distance between two closed polygon *boundaries* (ignores containment/overlap, unlike polyPolyDistance). */
function boundaryDistance(a: Point[], b: Point[]): { d: number; at: Point } {
  let best = Infinity;
  let at = a[0];
  const na = a.length;
  const nb = b.length;
  for (let i = 0; i < na; i++) {
    const segA: PathSeg = { type: 'line', start: a[i], end: a[(i + 1) % na] };
    for (let j = 0; j < nb; j++) {
      const segB: PathSeg = { type: 'line', start: b[j], end: b[(j + 1) % nb] };
      const d = segSegDistance(segA, segB);
      if (d < best) {
        best = d;
        at = { x: (segA.start.x + segB.start.x) / 2, y: (segA.start.y + segB.start.y) / 2 };
      }
    }
  }
  return { d: best, at };
}

export function check(b: Board, rules: RuleSet, items: CopperItem[]): DrcViolation[] {
  if (b.outline.length === 0) return [];
  let outlinePoly: Point[];
  try {
    outlinePoly = outlineToPolygon(b.outline);
  } catch {
    return []; // reported by the 'missing-outline' check instead
  }

  const violations: DrcViolation[] = [];
  for (const item of items) {
    if (item.kind === 'hole' && !item.plated) continue; // bare drill, no copper
    // Copper lying (partly) off the board is trimmed away at fab: distance 0,
    // not its boundary gap (a track 5mm outside would otherwise pass). An
    // unfilled zone's raw outline is exempt -- the fill clips it to the board;
    // pads are reported by 'outside-outline' already.
    const off = item.kind !== 'pad' && (item.kind !== 'zone' || item.group) && item.polygon.some((p) => !pointInPolygon(p, outlinePoly));
    // For a decoded zone (outer+holes), every ring is a real copper boundary;
    // measure the nearest of them to the edge. A hole boundary is copper too
    // (copper wraps the knockout), so including holes can only surface a real
    // near-edge copper location, never a false one.
    const rings = item.group ? [item.group.outer, ...item.group.holes] : [item.polygon];
    let d = Infinity;
    let at: Point = rings[0][0];
    for (const ring of rings) {
      const r = boundaryDistance(ring, outlinePoly);
      if (r.d < d) {
        d = r.d;
        at = r.at;
      }
    }
    if (off) {
      d = 0;
      at = item.polygon.find((p) => !pointInPolygon(p, outlinePoly))!;
    }
    if (d < rules.copperToEdge - DRC_EPSILON) {
      violations.push({
        rule: 'copper-to-edge',
        message: `${item.kind} ${item.ref} (net "${item.net}") on ${item.layer} is ${off ? 'outside the board outline' : `${d.toFixed(2)}mm from the board edge`}, minimum is ${rules.copperToEdge.toFixed(2)}mm`,
        at,
        items: [item.ref],
      });
    }
  }
  return violations;
}
