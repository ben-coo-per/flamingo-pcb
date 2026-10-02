import { describe, it, expect } from 'vitest';
import { builtinFootprint, isAssembled, newBoard, padOutline, polyPolyDistance, runDRC } from '../src/index.js';
import type { Board, ComponentInst, Footprint } from '../src/index.js';

function place(refdes: string, footprint: Footprint, x = 10, lcsc = ''): ComponentInst {
  return { refdes, lcsc, footprint, at: { x, y: 10 }, rotation: 0, side: 'top', fields: {} };
}

function board(...components: ComponentInst[]): Board {
  const b = newBoard('jumpers', 2);
  b.components.push(...components);
  return b;
}

function gap(c: ComponentInst, a: string, b: string): number {
  const pa = c.footprint.pads.find((p) => p.number === a)!;
  const pb = c.footprint.pads.find((p) => p.number === b)!;
  return polyPolyDistance(padOutline(c, pa), padOutline(c, pb));
}

function clearanceOf(b: Board) {
  return runDRC(b).filter((v) => v.rule === 'clearance');
}

describe('builtinFootprint', () => {
  it('an open 2-pad jumper has a 0.3mm gap, no paste and no LCSC number', () => {
    const { footprint } = builtinFootprint({ kind: 'solder-jumper-2' });
    const c = place('JP1', footprint);
    expect(gap(c, '1', '2')).toBeCloseTo(0.3, 6);
    expect(footprint.lcsc).toBe('');
    expect(footprint.noPaste).toBe(true);
    expect(footprint.netTie).toBeUndefined();
  });

  it('a bridged 2-pad jumper joins its pads and ties them', () => {
    const { footprint } = builtinFootprint({ kind: 'solder-jumper-2', bridged: true });
    const c = place('JP1', footprint);
    expect(gap(c, '1', '2')).toBeCloseTo(0, 6);
    expect(footprint.netTie).toEqual(['1', '2']);
    // The router still sees the plain pad size.
    expect(footprint.pads[0]!.size).toEqual({ w: 1, h: 1.5 });
  });

  it('a 3-pad jumper bridges only the pads asked for', () => {
    const { footprint } = builtinFootprint({ kind: 'solder-jumper-3', bridged: '2-3' });
    const c = place('JP1', footprint);
    expect(gap(c, '1', '2')).toBeCloseTo(0.3, 6);
    expect(gap(c, '2', '3')).toBeCloseTo(0, 6);
    expect(footprint.netTie).toEqual(['2', '3']);
  });

  it('a test point is one round pad of the given diameter', () => {
    const { footprint } = builtinFootprint({ kind: 'test-point', diameter: 1.5 });
    expect(footprint.pads).toHaveLength(1);
    expect(footprint.pads[0]).toMatchObject({ number: '1', shape: 'circle', size: { w: 1.5, h: 1.5 } });
    expect(footprint.name).toBe('TestPoint_Pad_D1.5mm');
    expect(() => builtinFootprint({ kind: 'test-point', diameter: 4 })).toThrow();
  });

  it('a through-hole test point is a plated pad on every layer', () => {
    const { footprint } = builtinFootprint({ kind: 'test-point-th' });
    expect(footprint.pads).toEqual([
      expect.objectContaining({ layer: 'through', size: { w: 2, h: 2 }, drill: { diameter: 1, plated: true } }),
    ]);
    expect(footprint.name).toBe('TestPoint_THT_D2mm_Drill1mm');
    expect(footprint.lcsc).toBe('');
  });

  it('a through-hole test point needs a 0.15mm ring and a drillable hole', () => {
    expect(() => builtinFootprint({ kind: 'test-point-th', diameter: 1.3, drill: 1.0 })).not.toThrow();
    expect(() => builtinFootprint({ kind: 'test-point-th', diameter: 1.2, drill: 1.0 })).toThrow(/ring/);
    expect(() => builtinFootprint({ kind: 'test-point-th', drill: 0.2 })).toThrow(/drill/);
    expect(() => builtinFootprint({ kind: 'test-point-th', diameter: 6, drill: 3 })).toThrow(/5mm/);
  });
});

describe('DRC with solder jumpers', () => {
  it('a bridged jumper between two nets is not a clearance violation', () => {
    const c = place('JP1', builtinFootprint({ kind: 'solder-jumper-2', bridged: true }).footprint);
    const b = board(c);
    b.nets.push({ name: 'A', class: 'default', pins: ['JP1.1'] }, { name: 'B', class: 'default', pins: ['JP1.2'] });
    expect(clearanceOf(b)).toEqual([]);
  });

  it('the same touching pads without the tie are a violation', () => {
    const fp = builtinFootprint({ kind: 'solder-jumper-2', bridged: true }).footprint;
    const c = place('JP1', { ...fp, netTie: undefined });
    const b = board(c);
    b.nets.push({ name: 'A', class: 'default', pins: ['JP1.1'] }, { name: 'B', class: 'default', pins: ['JP1.2'] });
    expect(clearanceOf(b)).toHaveLength(1);
  });

  it('the tie covers only its own pads: the open pad of a 3-pad jumper still needs clearance', () => {
    const fp = builtinFootprint({ kind: 'solder-jumper-3', bridged: '1-2' }).footprint;
    const b = board(place('JP1', fp));
    b.nets.push(
      { name: 'A', class: 'default', pins: ['JP1.1'] },
      { name: 'B', class: 'default', pins: ['JP1.2'] },
      { name: 'C', class: 'default', pins: ['JP1.3'] },
    );
    b.netClasses.push({ name: 'wide', trackWidth: 0.25, clearance: 0.4, viaDrill: 0.3, viaDiameter: 0.6 });
    expect(clearanceOf(b)).toEqual([]);
    b.nets[2]!.class = 'wide'; // 0.3mm gap < 0.4mm
    expect(clearanceOf(b).map((v) => v.items)).toEqual([['JP1.2', 'JP1.3']]);
  });

  it('jumper silk and courtyard pass the silk and courtyard checks', () => {
    const b = board(
      place('JP1', builtinFootprint({ kind: 'solder-jumper-3' }).footprint, 10),
      place('TP1', builtinFootprint({ kind: 'test-point' }).footprint, 20),
      place('TP2', builtinFootprint({ kind: 'test-point-th' }).footprint, 30),
    );
    const rules = new Set(runDRC(b).map((v) => v.rule));
    expect(rules.has('silk-over-pad')).toBe(false);
    expect(rules.has('courtyard-overlap')).toBe(false);
    expect(rules.has('drill')).toBe(false);
  });
});

describe('isAssembled', () => {
  it('needs an LCSC number and no do-not-place mark', () => {
    const fp = builtinFootprint({ kind: 'test-point' }).footprint;
    expect(isAssembled(place('R1', fp, 0, 'C25804'))).toBe(true);
    expect(isAssembled(place('TP1', fp, 0, ''))).toBe(false);
    expect(isAssembled(place('TP2', fp, 0, 'TESTPOINT'))).toBe(false);
    const dnp = place('R2', fp, 0, 'C25804');
    dnp.fields.dnp = true;
    expect(isAssembled(dnp)).toBe(false);
  });
});
