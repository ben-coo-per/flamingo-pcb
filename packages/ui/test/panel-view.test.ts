import { describe, it, expect } from 'vitest';
import type { CostLine, PanelGeometry, PanelIssue, PlacedInstance, Received } from '@flamingo/panel';
import {
  ISSUE_TITLE,
  loadsOntoPanel,
  previewLine,
  MAX_PIPS,
  composition,
  groupCost,
  groupIssues,
  pips,
  scenarioTags,
  escapeHtml,
  issueCounts,
  money,
  quoteKey,
  receivedLong,
  receivedShort,
  worstByInstance,
} from '../src/panel/format.js';
import { contentBox, dragOffset, dropPosition, hitInstance, platePlaces, platesBox, roundMm } from '../src/panel/hit.js';

function inst(id: string, x: number, y: number, w: number, h: number, extra: Partial<PlacedInstance> = {}): PlacedInstance {
  const free = { blocked: false, reasons: [], overhang: 0, clearance: 0 };
  return {
    id,
    source: id[0]!,
    populate: true,
    pinned: false,
    transform: { rotation: 0, offset: { x, y } },
    bbox: { minX: x, minY: y, maxX: x + w, maxY: y + h },
    outline: [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ],
    edges: { N: free, E: free, S: free, W: free },
    margins: { N: 2, E: 2, S: 2, W: 2 },
    overhangs: [],
    keepouts: [],
    ...extra,
  };
}

function geometry(instances: PlacedInstance[]): PanelGeometry {
  return {
    instances,
    unplaced: [],
    frame: { inner: { minX: 0, minY: 5, maxX: 60, maxY: 35 }, outer: { minX: 0, minY: 0, maxX: 60, maxY: 40 }, width: 60, height: 40 },
    rails: [],
    tabs: [],
    fiducials: [],
    toolingHoles: [],
    featureNotes: [],
    profile: [],
    dividers: [],
  };
}

describe('panel view: hit testing', () => {
  const g = geometry([inst('S1', 0, 7, 40, 30), inst('M1', 42, 7, 18, 12)]);

  it('finds the instance under the pointer', () => {
    expect(hitInstance(g, { x: 10, y: 20 })?.id).toBe('S1');
    expect(hitInstance(g, { x: 50, y: 10 })?.id).toBe('M1');
  });

  it('finds nothing on empty plate, in a gap, or on a rail', () => {
    expect(hitInstance(g, { x: 41, y: 10 })).toBeNull();
    expect(hitInstance(g, { x: 10, y: 2 })).toBeNull();
    expect(hitInstance(g, { x: 200, y: 200 })).toBeNull();
  });

  it('prefers the instance drawn last when two overlap', () => {
    const over = geometry([inst('S1', 0, 7, 40, 30), inst('M1', 30, 10, 18, 12)]);
    expect(hitInstance(over, { x: 35, y: 15 })?.id).toBe('M1');
  });

  it('respects the outline, not just the bounding box', () => {
    const ell = inst('L1', 0, 0, 30, 20, {
      outline: [
        { x: 0, y: 0 },
        { x: 30, y: 0 },
        { x: 30, y: 10 },
        { x: 10, y: 10 },
        { x: 10, y: 20 },
        { x: 0, y: 20 },
      ],
    });
    expect(hitInstance(geometry([ell]), { x: 20, y: 15 })).toBeNull();
    expect(hitInstance(geometry([ell]), { x: 5, y: 15 })?.id).toBe('L1');
  });

  it('follows an instance while it is dragged', () => {
    const drag = { id: 'M1', dx: 20, dy: 10 };
    expect(hitInstance(g, { x: 50, y: 10 }, drag)).toBeNull();
    expect(hitInstance(g, { x: 70, y: 20 }, drag)?.id).toBe('M1');
    expect(dragOffset('M1', drag)).toEqual({ x: 20, y: 10 });
    expect(dragOffset('S1', drag)).toEqual({ x: 0, y: 0 });
    expect(dragOffset('S1', null)).toEqual({ x: 0, y: 0 });
  });
});

describe('panel view: dropping', () => {
  it('rounds the drop position to a hundredth of a millimetre', () => {
    expect(dropPosition({ x: 42.194, y: 7 }, 3.33333, -1.00499)).toEqual({ x: 45.53, y: 6 });
    expect(roundMm(-0.001)).toBe(0);
    expect(Object.is(roundMm(-0.001), -0)).toBe(false);
  });
});

describe('panel view: what to fit', () => {
  it('fits the panel and anything hanging over its edge', () => {
    const over = inst('M1', 0, 7, 18, 12, {
      overhangs: [{ refdes: 'J1', side: 'W', depth: 1.2, polygon: [{ x: -1.2, y: 9 }, { x: 3, y: 9 }, { x: 3, y: 17 }, { x: -1.2, y: 17 }] }],
    });
    expect(contentBox(geometry([over]))).toEqual({ minX: -1.2, minY: 0, maxX: 60, maxY: 40 });
  });

  it('falls back to a default plate when the panel is empty', () => {
    expect(contentBox({ ...geometry([]), frame: null })).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 70 });
  });
});

describe('panel view: text', () => {
  const received: Received[] = [
    { key: 'S', name: 'sensor', needed: 1, niceToHave: 0, assembled: 2, bare: 3, overage: 1, unwanted: 1, shortfall: 0 },
    { key: 'M', name: 'mini', needed: 5, niceToHave: 8, assembled: 5, bare: 0, overage: 0, unwanted: 0, shortfall: 0 },
  ];

  it('formats money and escapes markup', () => {
    expect(money(48.5)).toBe('$48.50');
    expect(escapeHtml('<b a="1">&\'')).toBe('&lt;b a=&quot;1&quot;&gt;&amp;&#39;');
  });

  it('summarizes boards received against boards needed', () => {
    expect(receivedShort(received)).toBe('S 2/1  M 5/5');
    expect(receivedLong(received[0]!)).toBe('S  2 assembled + 3 bare  (need 1; 1 over)');
    expect(receivedLong(received[1]!)).toBe('M  5 assembled  (need 5, nice to have 8; exact)');
    expect(receivedLong({ ...received[1]!, assembled: 3, shortfall: 2 })).toContain('short by 2');
  });

  it('counts issues by severity and finds the worst per instance', () => {
    const issue = (severity: PanelIssue['severity'], instances: string[]): PanelIssue => ({
      code: 'overlap',
      severity,
      message: '',
      instances,
      sources: [],
    });
    const issues = [issue('warning', ['M1', 'M2']), issue('error', ['M1']), issue('info', ['M3']), issue('warning', ['M1'])];
    expect(issueCounts(issues)).toBe('1 error, 2 warnings, 1 note');
    expect(worstByInstance(issues)).toEqual(new Map([['M1', 'error'], ['M2', 'warning']]));
  });

  it('asks for new scenarios when quantities, boards or settings change, not when an instance moves', () => {
    const view = {
      panel: {
        sources: [{ key: 'S', hash: 'h1', needed: 1, niceToHave: 0 }],
        settings: { spacing: 2 },
        instances: [{ id: 'S1', at: { x: 0, y: 0 } }],
      },
      sources: [{ key: 'S', stale: false }],
    };
    const base = quoteKey(view);
    const moved = structuredClone(view);
    moved.panel.instances[0]!.at.x = 50;
    expect(quoteKey(moved)).toBe(base);
    const more = structuredClone(view);
    more.panel.sources[0]!.needed = 2;
    expect(quoteKey(more)).not.toBe(base);
    const wider = structuredClone(view);
    wider.panel.settings.spacing = 3;
    expect(quoteKey(wider)).not.toBe(base);
    const edited = structuredClone(view);
    edited.sources[0]!.stale = true;
    expect(quoteKey(edited)).not.toBe(base);
  });
});


describe('panel view: short forms', () => {
  const issue = (code: PanelIssue['code'], severity: PanelIssue['severity'], instances: string[], message: string): PanelIssue => ({
    code,
    severity,
    message,
    instances,
    sources: [],
  });

  it('folds findings of one kind into one row, worst first', () => {
    const groups = groupIssues([
      issue('blocked-edge', 'info', ['M1'], 'M1 edge W is blocked'),
      issue('blocked-edge', 'info', ['M2'], 'M2 edge S is blocked'),
      issue('size-assembly', 'warning', [], 'Standard PCBA cannot take this panel'),
      issue('overlap', 'error', ['S1', 'M1'], 'S1 and M1 overlap'),
      issue('blocked-edge', 'info', ['M1'], 'M1 edge N is blocked'),
    ]);
    expect(groups.map((g) => [g.severity, g.title, g.messages.length, g.instances])).toEqual([
      ['error', 'Overlap', 1, ['S1', 'M1']],
      ['warning', 'Assembly size limit', 1, []],
      ['info', 'Blocked edge', 3, ['M1', 'M2']],
    ]);
  });

  it('keeps one kind apart by severity', () => {
    const groups = groupIssues([
      issue('unsupported-instance', 'warning', ['M2'], 'held by 1 tab'),
      issue('unsupported-instance', 'error', ['M4'], 'has no tabs'),
    ]);
    expect(groups.map((g) => [g.severity, g.instances])).toEqual([
      ['error', ['M4']],
      ['warning', ['M2']],
    ]);
  });

  it('has a short title for every kind of finding', () => {
    for (const [code, title] of Object.entries(ISSUE_TITLE)) {
      expect(title.length, code).toBeGreaterThan(3);
      expect(title.split(' ').length, code).toBeLessThanOrEqual(5);
    }
  });

  it('folds fee lines into boards, assembly and parts', () => {
    const line = (code: CostLine['code'], amount: number, estimate: boolean): CostLine => ({
      code,
      label: code,
      amount,
      estimate,
      sources: [],
    });
    const groups = groupCost([
      line('pcb', 2, true),
      line('pcb-designs', 8, true),
      line('asm-setup', 8.18, false),
      line('asm-stencil', 1.53, false),
      line('part', 0.62, true),
      line('part', 1.34, true),
    ]);
    expect(groups.map((g) => [g.name, g.amount, g.estimate, g.lines.length])).toEqual([
      ['Boards', 10, true, 2],
      ['Assembly', 9.71, false, 2],
      ['Parts', 1.96, true, 2],
    ]);
    // A bare order has no assembly and no parts to show.
    expect(groupCost([line('pcb', 2, true)]).map((g) => g.name)).toEqual(['Boards']);
  });

  it('draws one mark per board received, up to a point', () => {
    expect(pips({ assembled: 6, needed: 5 })).toMatchObject({ met: 5, over: 1, short: 0, asText: false });
    expect(pips({ assembled: 2, needed: 5 })).toMatchObject({ met: 2, over: 0, short: 3, asText: false });
    expect(pips({ assembled: MAX_PIPS, needed: 1 })).toMatchObject({ asText: false });
    expect(pips({ assembled: 50, needed: 48 })).toMatchObject({ asText: true, label: '50/48' });
  });

  it('splits a design in a piece into populated and bare', () => {
    expect(composition({ key: 'M', total: 3, populated: 1 })).toEqual({ populated: 1, bare: 2 });
    expect(composition({ key: 'M', total: 3, populated: 3 })).toEqual({ populated: 3, bare: 0 });
  });

  it('tags what sets a scenario apart', () => {
    expect(scenarioTags({ id: 'merged-needed-x2' })).toEqual([]);
    expect(scenarioTags({ id: 'merged-wish-x2' })).toEqual(['extras populated']);
    expect(scenarioTags({ id: 'silk-divider-bare-x5', promotedTo: 4 })).toEqual(['extras bare', 'as 4-layer']);
  });
});

describe('panel view: a scenario on the plate', () => {
  const frame = (w: number, h: number, x = 0, y = 0) => ({
    frame: { inner: { minX: x, minY: y, maxX: x + w, maxY: y + h }, outer: { minX: x, minY: y, maxX: x + w, maxY: y + h }, width: w, height: h },
  });
  const order = (panel: boolean, layout: boolean) =>
    ({ panel, layout: layout ? { instances: [], settings: {}, width: 1, height: 1 } : null }) as never;

  it('puts the plates side by side, bottoms on one line', () => {
    const spots = platePlaces([frame(40, 30), frame(22, 16, 5, 7)], 18);
    expect(spots.map((s) => s.box)).toEqual([
      { minX: 0, minY: 0, maxX: 40, maxY: 30 },
      { minX: 58, minY: 0, maxX: 80, maxY: 16 },
    ]);
    // A plate whose own corner is elsewhere is moved to its place.
    expect(spots[1]!.offset).toEqual({ x: 53, y: -7 });
    const box = platesBox(spots);
    expect(box.minX).toBe(0);
    expect(box.maxX).toBeGreaterThanOrEqual(80);
    expect(box.minY).toBeLessThan(0); // captions
    expect(box.maxY).toBeGreaterThan(30); // quantity and banner
  });

  it('has a plate to show even for nothing', () => {
    expect(platesBox([])).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 70 });
  });

  it('loads a scenario only when it is one panel', () => {
    expect(loadsOntoPanel({ orders: [order(true, true)] })).toBe(true);
    expect(loadsOntoPanel({ orders: [order(false, false)] })).toBe(false);
    expect(loadsOntoPanel({ orders: [order(false, false), order(false, false)] })).toBe(false);
    expect(loadsOntoPanel({ orders: [order(true, true), order(true, true)] })).toBe(false);
  });

  it('says in one line what is on show', () => {
    expect(previewLine({ kind: 'separate', orders: [order(false, false), order(false, false)] }, 5)).toBe(
      'Scenario 5, Separate orders: 2 orders of single boards, no panel',
    );
    expect(previewLine({ kind: 'own-panels', orders: [order(true, true), order(true, true)] }, 2)).toBe(
      'Scenario 2, A panel per design: 2 panels, each its own order',
    );
    expect(previewLine({ kind: 'split', orders: [order(true, true), order(false, false)] }, 3)).toBe(
      'Scenario 3, Split by layers: 2 orders: 1 panel and 1 of single boards',
    );
  });
});
