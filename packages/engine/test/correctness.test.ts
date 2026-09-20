// Regression tests for DRC false negatives and connectivity errors found in
// the 2026-09 correctness review: each case is a board that used to pass DRC
// (or misreport connectivity) while the fabricated board would be wrong.
import { describe, it, expect } from 'vitest';
import { applyOp, newBoard, runDRC, fillAllZones, connectedGroups, expandTrack, pointInPolygon } from '../src/index.js';
import type { Board, ComponentInst, Pad, PathSeg, Point, Track, Zone } from '../src/index.js';

const W = 20;
const H = 20;
const outline: PathSeg[] = [
  { type: 'line', start: { x: 0, y: 0 }, end: { x: W, y: 0 } },
  { type: 'line', start: { x: W, y: 0 }, end: { x: W, y: H } },
  { type: 'line', start: { x: W, y: H }, end: { x: 0, y: H } },
  { type: 'line', start: { x: 0, y: H }, end: { x: 0, y: 0 } },
];
const rect = (x0: number, y0: number, x1: number, y1: number): Point[] => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];

function pad(number: string, at: Point, over: Partial<Pad> = {}): Pad {
  return { number, shape: 'rect', at, rotation: 0, size: { w: 1, h: 1 }, layer: 'top', ...over };
}
function comp(refdes: string, at: Point, pads: Pad[]): ComponentInst {
  return {
    refdes, lcsc: 'C1', at, rotation: 0, side: 'top', fields: {},
    footprint: { name: 'fp', lcsc: 'C1', pads, silk: [], courtyard: [] },
  };
}
function track(id: string, net: string, start: Point, end: Point, width = 0.25, layer: Track['layer'] = 'F.Cu'): Track {
  return { id, net, layer, width, seg: { type: 'line', start, end } };
}
function zone(id: string, net: string, layer: Zone['layer'], polygon = rect(0, 0, W, H)): Zone {
  return { id, net, layer, polygon, clearance: 0.3, minWidth: 0.2, thermal: { gap: 0.3, spokeWidth: 0.3 } };
}
function board(over: Partial<Board>): Board {
  return { ...newBoard('t', 2), outline, ...over };
}
const rules = (b: Board) => new Set(runDRC(fillAllZones(b)).map((v) => v.rule));

describe('DRC false negatives', () => {
  it('plated hole under a VCC pour (F) and GND pour (B) is not bonded to either', () => {
    const b = board({
      nets: [{ name: 'VCC', class: 'default', pins: [] }, { name: 'GND', class: 'default', pins: [] }],
      holes: [{ id: 'h1', at: { x: 10, y: 10 }, drill: 3.2, padDiameter: 6, plated: true }],
      zones: [zone('zf', 'VCC', 'F.Cu'), zone('zb', 'GND', 'B.Cu')],
    });
    // The pours now carve the annulus, so the filled board is clean...
    expect(rules(b).has('clearance')).toBe(false);
    // ...and a track across it is flagged instead of silently shorting.
    const t = { ...b, tracks: [track('t1', 'VCC', { x: 5, y: 10 }, { x: 15, y: 10 })], zones: [] };
    expect(rules(t).has('clearance')).toBe(true);
  });

  it('track through an NPTH is flagged (the drill severs it)', () => {
    const b = board({
      nets: [{ name: 'A', class: 'default', pins: [] }],
      holes: [{ id: 'h1', at: { x: 10, y: 10 }, drill: 3, padDiameter: 3, plated: false }],
      tracks: [track('t1', 'A', { x: 2, y: 10 }, { x: 18, y: 10 })],
    });
    expect(rules(b).has('clearance')).toBe(true);
  });

  it('copper wholly outside the outline is flagged', () => {
    const b = board({
      nets: [{ name: 'A', class: 'default', pins: [] }],
      tracks: [track('t1', 'A', { x: 30, y: 5 }, { x: 35, y: 5 })],
    });
    expect(rules(b).has('copper-to-edge')).toBe(true);
  });

  it('two net-less pads overlapping is a clearance violation', () => {
    const b = board({
      components: [comp('R1', { x: 5, y: 5 }, [pad('1', { x: 0, y: 0 })]), comp('R2', { x: 5.5, y: 5 }, [pad('1', { x: 0, y: 0 })])],
    });
    expect(rules(b).has('clearance')).toBe(true);
  });

  it('big round pad vs via: 0.15mm true gap under a 0.2mm class clearance is flagged', () => {
    // r=2.5 pad at x=8; via r=0.3 centred 2.5+0.15+0.3 away. A 50µm chord
    // error read this as >= 0.19 and passed it.
    const b = board({
      nets: [{ name: 'A', class: 'default', pins: ['U1.1'] }, { name: 'B', class: 'default', pins: [] }],
      netClasses: [{ name: 'default', trackWidth: 0.25, clearance: 0.2, viaDrill: 0.3, viaDiameter: 0.6 }],
      components: [comp('U1', { x: 8, y: 10 }, [pad('1', { x: 0, y: 0 }, { shape: 'circle', size: { w: 5, h: 5 } })])],
      vias: [{ id: 'v1', net: 'B', at: { x: 8 + 2.95 * Math.cos(0.2), y: 10 + 2.95 * Math.sin(0.2) }, drill: 0.3, diameter: 0.6 }],
    });
    expect(rules(b).has('clearance')).toBe(true);
  });

  it('zero-length track outlines a full round dot (no notch)', () => {
    const poly = expandTrack(track('dot', 'A', { x: 10, y: 10 }, { x: 10, y: 10 }, 1));
    let area = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      area += p.x * q.y - q.x * p.y;
    }
    expect(Math.abs(area) / 2).toBeGreaterThan(0.95 * Math.PI * 0.25) // notched outline was ~0.79;
  });

  it('slotted through pad counts its slot length in hole-to-hole', () => {
    const slotPad = pad('1', { x: 0, y: 0 }, {
      shape: 'oval', size: { w: 3, h: 1.2 }, layer: 'through', drill: { diameter: 0.6, slotLength: 2.4, plated: true },
    });
    const b = board({
      components: [comp('J1', { x: 10, y: 10 }, [slotPad])],
      // Slot ends at x=11.2; via drill edge 0.25 beyond it (0.5 required).
      vias: [{ id: 'v1', net: '', at: { x: 11.2 + 0.25 + 0.15, y: 10 }, drill: 0.3, diameter: 0.6 }],
    });
    expect(rules(b).has('hole-to-hole')).toBe(true);
  });

  it('plated through pad with no annular ring is flagged', () => {
    const b = board({
      components: [comp('J1', { x: 10, y: 10 }, [pad('1', { x: 0, y: 0 }, {
        shape: 'circle', size: { w: 1, h: 1 }, layer: 'through', drill: { diameter: 1, plated: true },
      })])],
    });
    expect(rules(b).has('pad-annular')).toBe(true);
  });
});

describe('connectivity matches the copper', () => {
  it('a pour split in two does not connect its halves', () => {
    const b = fillAllZones(board({
      nets: [
        { name: 'GND', class: 'default', pins: ['U1.1', 'U2.1'] },
        { name: 'SIG', class: 'default', pins: [] },
      ],
      components: [comp('U1', { x: 4, y: 10 }, [pad('1', { x: 0, y: 0 })]), comp('U2', { x: 16, y: 10 }, [pad('1', { x: 0, y: 0 })])],
      tracks: [track('cut', 'SIG', { x: 10, y: -1 }, { x: 10, y: 21 }, 1)],
      zones: [zone('z', 'GND', 'F.Cu')],
    }));
    expect(connectedGroups(b, b.nets[0])).toHaveLength(2);
  });

  it('track ending off-centre on a pad, and a T-junction, both connect', () => {
    const b = board({
      nets: [{ name: 'A', class: 'default', pins: ['R1.1', 'R2.1'] }],
      components: [comp('R1', { x: 4, y: 10 }, [pad('1', { x: 0, y: 0 })]), comp('R2', { x: 10, y: 4 }, [pad('1', { x: 0, y: 0 })])],
      tracks: [
        track('main', 'A', { x: 4.3, y: 10.2 }, { x: 16, y: 10 }), // ends 0.36mm off R1's centre, on its copper
        track('tee', 'A', { x: 10, y: 4 }, { x: 10, y: 10.05 }), // lands mid-track
      ],
    });
    expect(connectedGroups(b, b.nets[0])).toHaveLength(1);
  });

  it('a track to the second copy of a duplicated pad number connects', () => {
    const b = board({
      nets: [{ name: 'S', class: 'default', pins: ['J1.S', 'R1.1'] }],
      components: [
        comp('J1', { x: 5, y: 10 }, [pad('S', { x: -3, y: 0 }), pad('S', { x: 3, y: 0 })]),
        comp('R1', { x: 14, y: 10 }, [pad('1', { x: 0, y: 0 })]),
      ],
      tracks: [track('t', 'S', { x: 8, y: 10 }, { x: 14, y: 10 })],
    });
    expect(connectedGroups(b, b.nets[0])).toHaveLength(1);
  });
});

describe('ops reject copper that would never reach fab', () => {
  it('addZone refuses an unknown net or a non-copper / absent layer', () => {
    const b = board({ nets: [{ name: 'GND', class: 'default', pins: [] }] });
    const z = { net: 'GND', layer: 'F.Cu' as const, polygon: rect(0, 0, 5, 5), clearance: 0.3, minWidth: 0.2, thermal: { gap: 0.3, spokeWidth: 0.3 } };
    expect(applyOp(b, { op: 'addZone', zone: z }).ok).toBe(true);
    expect(applyOp(b, { op: 'addZone', zone: { ...z, net: 'GDN' } }).ok).toBe(false);
    expect(applyOp(b, { op: 'addZone', zone: { ...z, layer: 'In1.Cu' } }).ok).toBe(false);
    expect(applyOp(b, { op: 'addZone', zone: { ...z, layer: 'F.Silk' as never } }).ok).toBe(false);
  });
});

describe('zone fill honours minWidth', () => {
  it('drops a sliver narrower than minWidth but keeps wide copper', () => {
    // Two 0.25mm SIG tracks 0.94mm apart (centres): their knockouts
    // (0.3 clearance + 0.01 snap margin) leave a ~0.07mm GND strip.
    const b = fillAllZones(board({
      nets: [{ name: 'GND', class: 'default', pins: [] }, { name: 'SIG', class: 'default', pins: [] }],
      tracks: [track('a', 'SIG', { x: -1, y: 9.53 }, { x: 21, y: 9.53 }), track('b', 'SIG', { x: -1, y: 10.47 }, { x: 21, y: 10.47 })],
      zones: [zone('z', 'GND', 'F.Cu')],
    }));
    const fill = b.zones[0].fill!;
    const inFill = (p: Point) => fill.filter((r) => pointInPolygon(p, r)).length % 2 === 1;
    expect(inFill({ x: 10, y: 10 })).toBe(false); // sliver gone
    expect(inFill({ x: 10, y: 5 })).toBe(true); // bulk pour intact
  });
});

describe('indexed clearance (spatial grid) keeps exact semantics', () => {
  it('flags a pour island lying wholly inside another net\'s pad (no edge crossing)', () => {
    // Stale fill: a 1mm GND island inside a 4mm SIG pad. No boundaries cross,
    // so only the island-inside-item test catches the overlap.
    const island = rect(9.5, 9.5, 10.5, 10.5);
    const b = board({
      nets: [{ name: 'GND', class: 'default', pins: [] }, { name: 'SIG', class: 'default', pins: ['U1.1'] }],
      components: [comp('U1', { x: 10, y: 10 }, [pad('1', { x: 0, y: 0 }, { size: { w: 4, h: 4 } })])],
      zones: [{ ...zone('z', 'GND', 'F.Cu', island), fill: [island] }],
    });
    expect(runDRC(b).some((v) => v.rule === 'clearance' && v.items.includes('z'))).toBe(true);
  });
});
