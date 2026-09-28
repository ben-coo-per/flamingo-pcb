import { describe, it, expect } from 'vitest';
import { checkPanel } from '../src/check.js';
import { applyPanelOp } from '../src/ops.js';
import { DEFAULT_SETTINGS, newPanel } from '../src/panel.js';
import { quoteOrder } from '../src/scenarios.js';
import type { QuoteRequest, QuoteResult, Scenario } from '../src/scenarios.js';
import type { ResolvedSource } from '../src/resolved.js';
import type { Panel, PanelSource } from '../src/types.js';
import { EDGE_CONN, FEES, LIMITS, applyAll, comp, plainBoard, resolved } from './helpers.js';

function priced(src: ResolvedSource, price: number): ResolvedSource {
  return { ...src, geometry: { ...src.geometry!, parts: src.geometry!.parts.map((p) => ({ ...p, unitPrice: price })) } };
}

function source(r: ResolvedSource, needed: number, niceToHave = 0): PanelSource {
  return { key: r.key, path: r.path, hash: 'h', name: r.name, needed, niceToHave };
}

/** A sensor board with an expensive extended part, and a cheap mini board. */
function boards(): { s: ResolvedSource; m: ResolvedSource } {
  const sensor = plainBoard('sensor', 40, 30);
  sensor.components.push(comp('U1', { ...EDGE_CONN, lcsc: 'C2913204', name: 'MODULE' }, 20, 15));
  sensor.components[1]!.fields.basic = false;
  const s = resolved('S', sensor);
  s.geometry!.parts.find((p) => p.lcsc === 'C2913204')!.unitPrice = 3.2;
  s.geometry!.parts.find((p) => p.lcsc === 'C25804')!.unitPrice = 0.001;
  return { s, m: priced(resolved('M', plainBoard('mini', 18, 12)), 0.001) };
}

function request(sources: PanelSource[], resolvedSources: ResolvedSource[], extra: Partial<QuoteRequest> = {}): QuoteRequest {
  return { name: 'q', sources, resolved: resolvedSources, settings: DEFAULT_SETTINGS, limits: LIMITS, fees: FEES, ...extra };
}

function byId(result: QuoteResult, id: string): Scenario {
  const hit = result.scenarios.find((s) => s.id === id);
  if (!hit) throw new Error(`no scenario ${id} in [${result.scenarios.map((s) => s.id).join(', ')}]; rejected: ${JSON.stringify(result.rejected)}`);
  return hit;
}

describe('quoteOrder: 1 sensor + 5 minis', () => {
  const { s, m } = boards();
  const result = quoteOrder(request([source(s, 1), source(m, 5)], [s, m]));

  it('enumerates separate, own-panel, merged and silk-divider orders', () => {
    const kinds = new Set(result.scenarios.map((x) => x.kind));
    expect(kinds).toEqual(new Set(['separate', 'merged', 'silk-divider']));
    // The sensor is needed once: a panel of its own would hold one board.
    expect(result.rejected.find((r) => r.id === 'own-panels')?.reason).toContain('a panel would hold a single board');
    expect(result.scenarios.length).toBeGreaterThanOrEqual(5);
    expect(result.scenarios.length).toBeLessThan(20);
  });

  it('tries different panel counts', () => {
    const merged = result.scenarios.filter((x) => x.kind === 'merged').map((x) => x.id).sort();
    expect(merged).toEqual(['merged-needed-x2', 'merged-needed-x5']);
    expect(byId(result, 'merged-needed-x2').summary).toBe('1xS + 3xM per panel, 5 panels, 2 assembled');
    expect(byId(result, 'merged-needed-x5').summary).toBe('1xS + 1xM per panel, 5 panels, 5 assembled');
  });

  it('separate orders: one order per design, no different-designs fee', () => {
    const sep = byId(result, 'separate');
    expect(sep.orders).toHaveLength(2);
    expect(sep.orders.map((o) => o.panel)).toEqual([false, false]);
    expect(sep.lines.map((l) => l.code)).not.toContain('pcb-designs');
    expect(sep.lines.filter((l) => l.code === 'asm-setup')).toHaveLength(2);
    expect(sep.layout).toBeNull();
    expect(sep.received.map((r) => [r.key, r.needed, r.assembled])).toEqual([
      ['S', 1, 2],
      ['M', 5, 5],
    ]);
    expect(sep.total).toBeCloseTo(sep.orders.reduce((n, o) => n + o.priced.cost.total, 0), 2);
  });

  it('a merged panel pays the different-designs fee and the panel fee once', () => {
    const merged = byId(result, 'merged-needed-x2');
    expect(merged.orders).toHaveLength(1);
    expect(merged.lines.filter((l) => l.code === 'pcb-designs')).toHaveLength(1);
    expect(merged.lines.filter((l) => l.code === 'asm-panel')).toHaveLength(1);
    expect(merged.lines.filter((l) => l.code === 'asm-setup')).toHaveLength(1);
    expect(merged.received.map((r) => [r.key, r.assembled, r.bare, r.overage])).toEqual([
      ['S', 2, 3, 1],
      ['M', 6, 9, 1],
    ]);
    expect(merged.warnings).toContain('S: 1 more assembled than asked for');
  });

  it('a silk-divided board pays neither, and says you cut it yourself', () => {
    const silk = byId(result, 'silk-divider-needed-x2');
    expect(silk.lines.map((l) => l.code)).not.toContain('pcb-designs');
    expect(silk.lines.map((l) => l.code)).not.toContain('asm-panel');
    expect(silk.warnings).toContain('No routing between the boards: you cut them apart yourself along the silkscreen lines.');
    expect(silk.layout!.settings).toMatchObject({ separation: 'silk-divider', rails: { top: 0, bottom: 0 } });
    expect(silk.total).toBeLessThan(byId(result, 'merged-needed-x2').total);
  });

  it('every scenario delivers what is needed', () => {
    for (const sc of result.scenarios) {
      for (const r of sc.received) {
        expect(r.shortfall, `${sc.id} ${r.key}`).toBe(0);
        expect(r.assembled, `${sc.id} ${r.key}`).toBeGreaterThanOrEqual(r.needed);
      }
    }
  });

  it('every scenario is itemized, totalled and flagged', () => {
    for (const sc of result.scenarios) {
      expect(sc.total, sc.id).toBeCloseTo(sc.lines.reduce((n, l) => n + l.amount, 0), 2);
      expect(sc.estimate, sc.id).toBe(true);
      expect(sc.costPerNeededBoard, sc.id).toBeCloseTo(sc.total / 6, 2);
      for (const l of sc.lines) {
        expect(typeof l.estimate).toBe('boolean');
        expect(l.order).not.toBe('');
      }
      expect(sc.lines.some((l) => !l.estimate), sc.id).toBe(true);
    }
  });

  it('the layout a scenario implies is a valid panel', () => {
    for (const sc of result.scenarios.filter((x) => x.layout)) {
      let panel: Panel = newPanel('check');
      panel = applyAll(
        panel,
        { op: 'addSource', source: source(s, 1) },
        { op: 'addSource', source: source(m, 5) },
        { op: 'setLayout', instances: sc.layout!.instances, settings: sc.layout!.settings },
      );
      const errors = checkPanel(panel, [s, m], LIMITS).filter((i) => i.severity === 'error');
      expect(errors.map((e) => e.message), sc.id).toEqual([]);
      expect(panel.instances.filter((i) => i.source === 'M').length, sc.id).toBe(
        sc.orders[0]!.counts.find((c) => c.key === 'M')!.total,
      );
    }
  });

  it('ranks by total cost by default', () => {
    expect(result.objective).toBe('total');
    const totals = result.scenarios.map((x) => x.total);
    expect(totals).toEqual([...totals].sort((a, b) => a - b));
  });

  it('ranks by least overage when asked', () => {
    const r = quoteOrder(request([source(s, 1), source(m, 5)], [s, m], { objective: 'overage' }));
    const unwanted = r.scenarios.map((x) => x.received.reduce((n, y) => n + y.unwanted, 0));
    expect(unwanted).toEqual([...unwanted].sort((a, b) => a - b));
    expect(r.scenarios[0]!.id).not.toBe('merged-needed-x5'); // 4 sensors too many
    expect(new Set(r.scenarios.map((x) => x.id))).toEqual(new Set(result.scenarios.map((x) => x.id)));
  });

  it('ranks by cost per board when asked', () => {
    const r = quoteOrder(request([source(s, 1), source(m, 5)], [s, m], { objective: 'per-board' }));
    const per = r.scenarios.map((x) => x.costPerNeededBoard);
    expect(per).toEqual([...per].sort((a, b) => a - b));
  });

  it('reports how long it took, and it is quick', () => {
    expect(result.elapsedMs).toBeLessThan(2000);
  });
});

describe('quoteOrder: nice-to-have and partial population', () => {
  const { s, m } = boards();

  it('adds variants that reach the nice-to-have quantity populated or bare', () => {
    const r = quoteOrder(request([source(s, 2, 12), source(m, 5)], [s, m]));
    const ids = r.scenarios.map((x) => x.id);
    expect(ids.some((id) => id.startsWith('merged-wish-'))).toBe(true);
    expect(ids.some((id) => id.startsWith('merged-bare-'))).toBe(true);

    const bare = byId(r, 'merged-bare-x2');
    expect(bare.partial).toBe(true);
    // 2 sensors populated across 2 assembled panels, 12 wished for across 5 fabricated.
    expect(bare.orders[0]!.counts.find((c) => c.key === 'S')).toEqual({ key: 'S', total: 3, populated: 1 });
    expect(bare.received.find((x) => x.key === 'S')).toMatchObject({ assembled: 2, bare: 13, unwanted: 0 });
    expect(bare.layout!.instances.filter((i) => i.source === 'S').map((i) => i.populate)).toEqual([true, false, false]);

    const populated = byId(r, 'merged-wish-x2');
    expect(populated.partial).toBe(false);
    expect(populated.received.find((x) => x.key === 'S')).toMatchObject({ assembled: 12, unwanted: 0 });
    // Bare spares cost board area; populated ones cost parts as well.
    expect(bare.total).toBeLessThan(populated.total);
  });

  it('counts delivered nice-to-have boards in the cost per board', () => {
    const r = quoteOrder(request([source(s, 2, 12), source(m, 5)], [s, m]));
    const needed = byId(r, 'merged-needed-x2');
    const wish = byId(r, 'merged-wish-x2');
    // Needed only: 2 S assembled + 3 bare spares, 6 of 5 M -> 2 + 3 + 5 boards asked for.
    expect(needed.costPerNeededBoard).toBeCloseTo(needed.total / 10, 2);
    expect(wish.costPerNeededBoard).toBeCloseTo(wish.total / 17, 2);
  });

  it('a design wanted only as a nice-to-have ships bare', () => {
    const r = quoteOrder(request([source(s, 2), source(m, 0, 10)], [s, m]));
    const bare = r.scenarios.find((x) => x.id.startsWith('merged-bare-'))!;
    expect(bare.orders[0]!.counts.find((c) => c.key === 'M')).toMatchObject({ populated: 0 });
    expect(bare.received.find((x) => x.key === 'M')!.assembled).toBe(0);
    expect(bare.received.find((x) => x.key === 'M')!.bare).toBeGreaterThanOrEqual(10);
  });

  it('ignores designs nobody asked for', () => {
    const r = quoteOrder(request([source(s, 2), source(m, 0)], [s, m]));
    for (const sc of r.scenarios) expect(sc.received.map((x) => x.key)).toEqual(['S']);
  });

  it('has nothing to offer when nothing is needed', () => {
    const r = quoteOrder(request([source(s, 0), source(m, 0)], [s, m]));
    expect(r.scenarios).toEqual([]);
    expect(r.rejected[0]!.reason).toContain('No board has a needed');
  });
});

describe('quoteOrder: mismatched layer counts', () => {
  const two = priced(resolved('A', plainBoard('alpha', 40, 30, 2)), 0.01);
  const four = priced(resolved('B', plainBoard('beta', 30, 20, 4)), 0.01);
  const result = quoteOrder(request([source(two, 5), source(four, 5)], [two, four]));

  it('offers both splitting and promoting', () => {
    const split = byId(result, 'split');
    expect(split.orders).toHaveLength(2);
    expect(split.orders.map((o) => o.priced.order.piece.layers).sort()).toEqual([2, 4]);
    expect(split.promotedTo).toBeUndefined();

    const promoted = result.scenarios.filter((x) => x.kind === 'merged');
    expect(promoted.length).toBeGreaterThan(0);
    for (const p of promoted) {
      expect(p.promotedTo).toBe(4);
      expect(p.title).toContain('promoted to 4 layers');
      expect(p.orders[0]!.priced.order.piece.layers).toBe(4);
      expect(p.layout!.settings.copperLayers).toBe(4);
      expect(p.warnings).toContain('Boards with fewer layers are made as 4-layer boards.');
    }
  });

  it('a promoted layout passes the panel checks', () => {
    const p = result.scenarios.find((x) => x.kind === 'merged')!;
    const panel = applyAll(
      newPanel('check'),
      { op: 'addSource', source: source(two, 5) },
      { op: 'addSource', source: source(four, 5) },
      { op: 'setLayout', instances: p.layout!.instances, settings: p.layout!.settings },
    );
    expect(checkPanel(panel, [two, four], LIMITS).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('separate orders keep each board at its own layer count', () => {
    expect(byId(result, 'separate').orders.map((o) => o.priced.order.piece.layers)).toEqual([2, 4]);
  });
});

describe('quoteOrder: rejections', () => {
  it('says why a panel scenario was dropped', () => {
    const giant = priced(resolved('G', plainBoard('giant', 240, 200)), 0.01);
    const m = priced(resolved('M', plainBoard('mini', 18, 12)), 0.01);
    const r = quoteOrder(request([source(giant, 5), source(m, 5)], [giant, m]));
    const merged = r.rejected.filter((x) => x.id.startsWith('merged-'));
    expect(merged.length).toBeGreaterThan(0);
    expect(merged[0]!.reason).toMatch(/do not fit|does not fit/);
    // Ordering them separately still works.
    expect(byId(r, 'separate').orders).toHaveLength(2);
  });

  it('drops the silkscreen-divider approach for a board that is not a rectangle', () => {
    const ell = plainBoard('ell', 30, 20);
    const pts = [
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 20 },
      { x: 0, y: 20 },
    ];
    ell.outline = pts.map((start, i) => ({ type: 'line' as const, start, end: pts[(i + 1) % pts.length]! }));
    ell.components[0]!.at = { x: 5, y: 5 };
    const l = priced(resolved('L', ell), 0.01);
    const m = priced(resolved('M', plainBoard('mini', 18, 12)), 0.01);
    const r = quoteOrder(request([source(l, 5), source(m, 5)], [l, m]));
    expect(r.rejected.find((x) => x.id === 'silk-divider')!.reason).toContain('L is not a plain rectangle');
    expect(r.scenarios.some((x) => x.kind === 'silk-divider')).toBe(false);
  });

  it('reports a source that cannot be read', () => {
    const m = priced(resolved('M', plainBoard('mini', 18, 12)), 0.01);
    const gone: ResolvedSource = {
      ...m,
      key: 'X',
      path: 'x.flamingo',
      geometry: undefined,
      board: undefined,
      error: 'cannot read "x.flamingo"',
    };
    const r = quoteOrder(request([source(m, 5), source(gone, 5)], [m, gone]));
    expect(r.scenarios).toEqual([]);
    expect(r.rejected).toEqual([{ id: 'source-X', title: 'Board X', reason: 'cannot read "x.flamingo"' }]);
  });

  it('gives mouse-bite panels rails even when the panel settings have none', () => {
    const { s, m } = boards();
    const noRails = applyPanelOp(newPanel('x'), { op: 'setSettings', settings: { rails: { top: 0, bottom: 0 } } });
    if (!noRails.ok) throw new Error(noRails.error);
    const r = quoteOrder(request([source(s, 1), source(m, 5)], [s, m], { settings: noRails.panel.settings }));
    expect(byId(r, 'merged-needed-x2').layout!.settings.rails).toEqual({ top: 5, bottom: 5, left: 0, right: 0 });
  });
});

describe('quoteOrder: a single design', () => {
  const m = priced(resolved('M', plainBoard('mini', 18, 12)), 0.01);

  it('compares single boards with a panel of the design', () => {
    const r = quoteOrder(request([source(m, 20)], [m]));
    expect(r.scenarios.map((x) => x.id).sort()).toEqual(['own-panels', 'separate']);
    const panel = byId(r, 'own-panels');
    expect(panel.lines.map((l) => l.code)).not.toContain('pcb-designs');
    expect(panel.received[0]!.assembled).toBeGreaterThanOrEqual(20);
    expect(panel.layout!.instances.length).toBeGreaterThan(1);
  });
});
