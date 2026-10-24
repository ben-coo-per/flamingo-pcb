import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { allHoles } from '@flamingo/engine';
import { importEpro } from '../src/import/epro.js';

/**
 * A minimal EasyEDA Pro project exercising the primitives the importer used to
 * drop silently (found by diffing a Flamingo export against the JLC fab set of
 * the same board, 2026-10-09): footprint-level holes and outline notches,
 * free silk text, fiducial pads, and via-on-pad-corner connectivity.
 */
const lines = (recs: unknown[][]): string => recs.map((r) => JSON.stringify(r)).join('\n') + '\n';

const PROJECT = {
  pcbs: { pcb1: 'Board' },
  footprints: { fp1: { title: 'JACK' } },
  devices: { dev1: { title: 'Jack', attributes: { 'Supplier Part': 'C1', Value: 'JACK' } } },
};

// Units: mil. Footprint: one 40x40 pad at origin, a 0.7 mm hole 100 mil right
// of it (multi-layer FILL circle), and an open U-shaped notch on layer 11
// whose mouth stops 4 mil short of x = -100 (EasyEDA unions shapes, so real
// footprints do this).
const FOOTPRINT: unknown[][] = [
  ['PAD', 'e1', 0, '', 1, '1', 0, 0, 0, null, ['RECT', 40, 40, 0], [], 0, 0, null, 1, 0, null, null, null, null, 0, null, null, null, null, []],
  ['FILL', 'e2', 0, '', 12, 0.2, 0, ['CIRCLE', 100, 0, 13.78], 0],
  ['POLY', 'e3', 0, '', 11, 10, [-96, -50, 'L', -60, -50, -60, 50, -96, 50], 0],
];

// PCB: 1000 mil square outline, the part at x = -400 so the notch mouth lands on
// the left edge (x = -500), two free texts, a fiducial, a GND stitch pad and a
// VCC via overlapping the corner of pad J1.1.
const PCB: unknown[][] = [
  ['LAYER_PHYS', 1], ['LAYER_PHYS', 2],
  ['NET', 'VCC'], ['NET', 'GND'],
  ['POLY', 'e100', 0, '', 11, 3.937, [-500, -500, 'L', 500, -500, 500, 500, -500, 500, -500, -500], 0],
  ['COMPONENT', 'c1', 0, 1, -400, 0, 0],
  ['ATTR', 'a1', 0, 'c1', 0, 0, 0, 'Designator', 'J1'],
  ['ATTR', 'a2', 0, 'c1', 0, 0, 0, 'Footprint', 'fp1'],
  ['ATTR', 'a3', 0, 'c1', 0, 0, 0, 'Device', 'dev1'],
  ['PAD_NET', 'c1', '1', 'VCC'],
  ['STRING', 's1', 0, 3, 0, 0, 'AB', 'default', 100, 8, 0, 0, 3, 0, 0, 0, 0, 0],
  ['STRING', 's2', 0, 4, 100, 100, 'AB', 'default', 100, 8, 0, 0, 3, -270, 0, 0, 0, 0],
  ['STRING', 's3', 0, 13, 0, 0, 'doc note', 'default', 100, 8, 0, 0, 3, 0, 0, 0, 0, 0],
  ['PAD', 'e200', 0, 'GND', 2, 'FID1', 300, 300, 0, null, ['ELLIPSE', 39.37, 39.37], [], 0, 0, null, 1, 0, null, null, null, null, 0, null, null, null, null, []],
  ['PAD', 'e201', 0, 'GND', 12, '1', 200, 200, 0, ['ROUND', 36, 36], ['ELLIPSE', 60, 60], [], 0, 0, 0, 1, 0, null, null, null, null, 0, null, null, null, null, []],
  ['VIA', 'v1', 0, 'VCC', '', -372.44, 19.685, 12, 24, 0, null, null, 0, []],
];

describe('importEpro', () => {
  let dir: string;
  let result: ReturnType<typeof importEpro>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'epro-'));
    const zip = new AdmZip();
    zip.addFile('project.json', Buffer.from(JSON.stringify(PROJECT)));
    zip.addFile('FOOTPRINT/fp1.efoo', Buffer.from(lines(FOOTPRINT)));
    zip.addFile('PCB/pcb1.epcb', Buffer.from(lines(PCB)));
    const path = join(dir, 'mini.epro');
    zip.writeZip(path);
    result = importEpro(path);
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('imports multi-layer FILL circles as footprint NPTH holes that reach allHoles()', () => {
    const j1 = result.board.components.find((c) => c.refdes === 'J1')!;
    expect(j1.footprint.holes).toEqual([{ at: { x: 2.54, y: 0 }, drill: 0.7 }]);
    expect((j1.footprint as Record<string, unknown>).cutouts).toBeUndefined();
    const holes = allHoles(result.board);
    expect(holes).toHaveLength(1);
    expect(holes[0]!.plated).toBe(false);
    expect(holes[0]!.at.x).toBeCloseTo(-7.62, 4);
    expect(holes[0]!.at.y).toBeCloseTo(0, 4);
  });

  it('splices a footprint outline notch into the board outline', () => {
    const o = result.board.outline;
    // 4 edges, the left one replaced by edge-half + 3 notch segments + edge-half
    expect(o).toHaveLength(8);
    for (let i = 0; i < o.length; i++) {
      const next = o[(i + 1) % o.length]!;
      expect(o[i]!.end.x).toBeCloseTo(next.start.x, 6);
      expect(o[i]!.end.y).toBeCloseTo(next.start.y, 6);
    }
    const inner = o.filter((s) => Math.abs(s.start.x + 11.684) < 1e-6 && Math.abs(s.end.x + 11.684) < 1e-6);
    expect(inner).toHaveLength(1); // the notch floor at x = -500 + 40 mil
    // mouth snapped onto the edge: no vertex left at the drawn x = -496 mil
    expect(o.some((s) => Math.abs(s.start.x + 12.5984) < 1e-6 || Math.abs(s.end.x + 12.5984) < 1e-6)).toBe(false);
    expect(o.filter((s) => Math.abs(s.start.x + 12.7) < 1e-6 && Math.abs(s.end.x + 12.7) < 1e-6)).toHaveLength(2);
    expect(result.warnings.some((w) => w.includes('cutout'))).toBe(false);
  });

  it('imports silk STRING text centred on EasyEDA baseline-anchor metrics', () => {
    const [top, bottom] = result.board.silk;
    expect(result.board.silk).toHaveLength(2);
    // size 100 mil = 2.54 mm, stroke 8 mil; run 0.633*2.54*2 = 3.2156, rise (2.032+0.2032)/2
    expect(top!.layer).toBe('F.Silk');
    expect(top!.at.x).toBeCloseTo(1.6078, 3);
    expect(top!.at.y).toBeCloseTo(1.1176, 3);
    expect(top!.height).toBeCloseTo(2.032, 4);
    expect(top!.rotation).toBe(0);
    // bottom view, rotated 90: runs +y, glyphs rise +x (as the JLC gerber showed)
    expect(bottom!.layer).toBe('B.Silk');
    expect(bottom!.at.x).toBeCloseTo(2.54 + 1.1176, 3);
    expect(bottom!.at.y).toBeCloseTo(2.54 + 1.6078, 3);
    expect(bottom!.rotation).toBe(90);
    expect(result.warnings.some((w) => w.includes('1 STRING record(s) on non-silk'))).toBe(true);
  });

  it('warns specifically about fiducial pads and tented stitch pads', () => {
    expect(result.warnings.some((w) => w.includes('FID1') && w.includes('free-pad'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('1 plated free pad(s)') && w.includes('tented'))).toBe(true);
    expect(result.board.vias.some((v) => v.net === 'GND' && v.drill === 0.9144)).toBe(true);
  });

  it('stubs a via whose annulus overlaps a pad corner (not just its nominal centre)', () => {
    const stub = result.board.tracks.find(
      (t) => t.net === 'VCC' && t.seg.type === 'line' && Math.abs(t.seg.end.x + 10.16) < 1e-6 && Math.abs(t.seg.end.y) < 1e-6,
    );
    expect(stub).toBeDefined();
    expect(stub!.seg.start.x).toBeCloseTo(-9.46, 3);
    expect(stub!.seg.start.y).toBeCloseTo(0.5, 3);
  });
});
