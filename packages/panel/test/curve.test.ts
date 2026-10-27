import { describe, expect, it } from 'vitest';
import { costCurve } from '../src/curve.js';
import { FEES, LIMITS, plainBoard, resolved } from './helpers.js';
import { DEFAULT_SETTINGS } from '../src/panel.js';

describe('costCurve', () => {
  const r = resolved('M', plainBoard('mini', 30, 20));
  const req = {
    name: 'p',
    sources: [{ key: 'M', path: 'mini.flamingo', hash: 'h', name: 'mini', needed: 1 }],
    resolved: [r],
    settings: DEFAULT_SETTINGS,
    limits: LIMITS,
    fees: FEES,
  };

  it('prices the cheapest way at each quantity, per board falling as the order grows', () => {
    const c = costCurve(req, [1, 5, 20, 100]);
    expect(c.points.map((p) => p.quantity)).toEqual([1, 5, 20, 100]);
    expect(c.impossible).toEqual([]);
    for (const p of c.points) {
      expect(p.total).toBeGreaterThan(0);
      expect(p.perBoard).toBeCloseTo(p.total / p.quantity, 1);
      expect(p.way.title.length).toBeGreaterThan(0);
    }
    expect(c.points[3]!.perBoard).toBeLessThan(c.points[0]!.perBoard);
    expect(c.points[3]!.total).toBeGreaterThan(c.points[0]!.total);
  });

  it('ignores the request quantities and skips bad ones', () => {
    const c = costCurve({ ...req, sources: [{ ...req.sources[0]!, needed: 7 }] }, [2, 0, 2.5, 3]);
    expect(c.points.map((p) => p.quantity)).toEqual([2, 3]);
  });

  it('is fast the second time: packings are kept', () => {
    costCurve(req);
    const t0 = performance.now();
    const c = costCurve(req);
    expect(c.points.length).toBeGreaterThan(10);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});
