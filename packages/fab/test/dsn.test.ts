import { describe, it, expect } from 'vitest';
import { applyOp, newBoard } from '@flamingo/engine';
import type { Board, Footprint, Op, PathSeg } from '@flamingo/engine';
import { exportDSN } from '../src/dsn.js';

const R0603: Footprint = {
  name: 'R0603',
  lcsc: 'C25804',
  pads: [
    { number: '1', shape: 'rect', at: { x: -0.75, y: 0 }, rotation: 0, size: { w: 0.8, h: 0.9 }, layer: 'top' },
    { number: '2', shape: 'rect', at: { x: 0.75, y: 0 }, rotation: 0, size: { w: 0.8, h: 0.9 }, layer: 'top' },
  ],
  silk: [],
  courtyard: [],
};

const RECT_OUTLINE: PathSeg[] = [
  { type: 'line', start: { x: 0, y: 0 }, end: { x: 20, y: 0 } },
  { type: 'line', start: { x: 20, y: 0 }, end: { x: 20, y: 15 } },
  { type: 'line', start: { x: 20, y: 15 }, end: { x: 0, y: 15 } },
  { type: 'line', start: { x: 0, y: 15 }, end: { x: 0, y: 0 } },
];

function apply(b: Board, op: Op): Board {
  const r = applyOp(b, op);
  if (!r.ok) throw new Error(`op ${op.op} failed: ${r.error}`);
  return r.board;
}

/** A tiny 2-resistor board: R1, R2 (shared R0603 footprint), one net N1. */
function tinyBoard(): Board {
  let b = newBoard('t', 2);
  b = apply(b, { op: 'setOutline', outline: RECT_OUTLINE });
  b = apply(b, {
    op: 'placeComponent',
    refdes: 'R1',
    lcsc: 'C25804',
    footprint: R0603,
    at: { x: 5, y: 5 },
    rotation: 0,
    side: 'top',
    fields: {},
  });
  b = apply(b, {
    op: 'placeComponent',
    refdes: 'R2',
    lcsc: 'C25804',
    footprint: R0603,
    at: { x: 10, y: 5 },
    rotation: 0,
    side: 'top',
    fields: {},
  });
  b = apply(b, { op: 'connectPins', net: 'N1', pins: ['R1.2', 'R2.1'] });
  return b;
}

const GOLDEN = `(pcb t
  (parser
    (string_quote ")
    (space_in_quoted_tokens on)
    (host_cad flamingo)
    (host_version 0.1.0)
  )
  (resolution um 1)
  (unit um)
  (structure
    (layer F.Cu (type signal))
    (layer B.Cu (type signal))
    (boundary (path pcb 0 0 0 20000 0 20000 15000 0 15000 0 0))
    (via V_300_600)
    (rule (width 250) (clearance 200) (clearance 200 (type via_via)))
  )
  (placement
    (component R0603
      (place R1 5000 5000 front 0)
      (place R2 10000 5000 front 0)
    )
  )
  (library
    (image R0603
      (pin rect_800x900_F 1 -750 0)
      (pin rect_800x900_F 2 750 0)
    )
    (padstack rect_800x900_F (shape (rect F.Cu -400 -450 400 450)) (attach off))
    (padstack V_300_600 (shape (circle F.Cu 600)) (shape (circle B.Cu 600)) (attach off))
  )
  (network
    (net N1 (pins R1-2 R2-1))
    (class default N1 (circuit (use_via V_300_600)) (rule (width 250) (clearance 200)))
  )
)
`;

describe('exportDSN', () => {
  it('produces the exact golden DSN for a tiny 2-part board', () => {
    expect(exportDSN(tinyBoard())).toBe(GOLDEN);
  });

  it('dedupes identical pad geometry into a single padstack', () => {
    const dsn = exportDSN(tinyBoard());
    const matches = dsn.match(/\(padstack rect_800x900_F /g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('emits (side back) as `back` for bottom-side components', () => {
    let b = tinyBoard();
    b = apply(b, { op: 'moveComponent', refdes: 'R2', side: 'bottom' });
    const dsn = exportDSN(b);
    expect(dsn).toContain('(place R2 10000 5000 back 0)');
    expect(dsn).toContain('(place R1 5000 5000 front 0)');
  });

  it('subsetting: routed net + untouched nets all declared in (network); untouched become protect wiring', () => {
    let b = tinyBoard();
    b = apply(b, { op: 'connectPins', net: 'N2', pins: ['R1.1', 'R2.2'] });
    // Give N2 an existing track so it must be emitted as a protect obstacle.
    b = apply(b, {
      op: 'addTrack',
      track: {
        layer: 'F.Cu',
        width: 0.25,
        net: 'N2',
        seg: { type: 'line', start: { x: 4.25, y: 5 }, end: { x: 10.75, y: 5 } },
      },
    });

    const dsn = exportDSN(b, { nets: ['N1'] });
    expect(dsn).toContain('(net N1 (pins R1-2 R2-1))');
    // N2 is still declared (with its class) even though it isn't being
    // routed -- otherwise its protect wiring below would reference an
    // undeclared net and fall back to the board's default clearance.
    expect(dsn).toContain('(net N2 (pins R1-1 R2-2))');
    expect(dsn).toContain('(class default N1 N2 ');
    expect(dsn).toContain('(wiring');
    expect(dsn).toContain(
      '(wire (path F.Cu 250 4250 5000 10750 5000) (net N2) (type protect))',
    );
  });

  it('bottom-side place line keeps the component origin (Specctra mirrors around it, not it)', () => {
    // Specctra mirrors a back-side image around the component origin; the
    // origin coordinate itself is NOT mirrored. So the (place ...) x/y must
    // equal the component's placement coordinates verbatim, with `back` and
    // the placement rotation preserved.
    let b = tinyBoard();
    b = apply(b, { op: 'moveComponent', refdes: 'R2', side: 'bottom', rotation: 90 });
    const dsn = exportDSN(b);
    // R2 was placed at (10,5) => 10000 5000 um; rotation 90; side back.
    expect(dsn).toContain('(place R2 10000 5000 back 90)');
    // Top-side sibling untouched.
    expect(dsn).toContain('(place R1 5000 5000 front 0)');
  });

  it('emits copper keepouts per-layer as (keepout ...) polygons', () => {
    let b = tinyBoard();
    b = apply(b, {
      op: 'addKeepout',
      keepout: {
        layers: ['F.Cu'],
        polygon: [
          { x: 2, y: 2 },
          { x: 4, y: 2 },
          { x: 4, y: 4 },
          { x: 2, y: 4 },
        ],
        keepout: { copper: true, via: false },
      },
    });
    const dsn = exportDSN(b);
    expect(dsn).toContain('(keepout "" (polygon F.Cu 0 2000 2000 4000 2000 4000 4000 2000 4000))');
    // copper:true, via:false => no via_keepout for this shape.
    expect(dsn).not.toContain('(via_keepout "" (polygon signal 0 2000 2000');
  });

  it('emits an all-layer via keepout as a single (via_keepout ...) on signal', () => {
    let b = tinyBoard();
    b = apply(b, {
      op: 'addKeepout',
      keepout: {
        layers: 'all',
        polygon: [
          { x: 6, y: 6 },
          { x: 8, y: 6 },
          { x: 8, y: 8 },
          { x: 6, y: 8 },
        ],
        keepout: { copper: false, via: true },
      },
    });
    const dsn = exportDSN(b);
    expect(dsn).toContain('(via_keepout "" (polygon signal 0 6000 6000 8000 6000 8000 8000 6000 8000))');
    // copper:false => no copper keepout lines for this shape.
    expect(dsn).not.toContain('(keepout "" (polygon F.Cu 0 6000 6000');
    expect(dsn).not.toContain('(keepout "" (polygon B.Cu 0 6000 6000');
  });

  it('does not emit any keepout line for a pour-only keepout', () => {
    let b = tinyBoard();
    b = apply(b, {
      op: 'addKeepout',
      keepout: {
        layers: ['F.Cu'],
        polygon: [
          { x: 2, y: 2 },
          { x: 4, y: 2 },
          { x: 4, y: 4 },
          { x: 2, y: 4 },
        ],
        keepout: { copper: false, via: false, pour: true },
      },
    });
    const dsn = exportDSN(b);
    // pour-only => no router keepout and no via_keepout.
    expect(dsn).not.toContain('(keepout "" (polygon F.Cu 0 2000 2000');
    expect(dsn).not.toContain('(via_keepout "" (polygon signal 0 2000 2000');
  });

  it('bakes pad rotation (mod 180 != 0) into a polygon padstack', () => {
    const fp: Footprint = {
      name: 'ROT',
      lcsc: 'X',
      pads: [
        { number: '1', shape: 'rect', at: { x: 0, y: 0 }, rotation: 90, size: { w: 1.0, h: 0.5 }, layer: 'top' },
      ],
      silk: [],
      courtyard: [],
    };
    let b = newBoard('r', 2);
    b = apply(b, {
      op: 'placeComponent',
      refdes: 'U1',
      lcsc: 'X',
      footprint: fp,
      at: { x: 5, y: 5 },
      rotation: 0,
      side: 'top',
      fields: {},
    });
    const dsn = exportDSN(b);
    expect(dsn).toMatch(/\(padstack poly_[0-9a-f]{8}_F \(shape \(polygon F\.Cu 0 /);
  });

  it('fences a plated mounting hole with a keepout on every copper layer plus a via_keepout', () => {
    let b = tinyBoard();
    b = apply(b, {
      op: 'addHole',
      hole: { at: { x: 5, y: 10 }, drill: 1.0, padDiameter: 1.6, plated: true },
    });
    const dsn = exportDSN(b);
    expect(dsn.match(/\(keepout "" \(polygon F\.Cu 0 /g) ?? []).toHaveLength(1);
    expect(dsn.match(/\(keepout "" \(polygon B\.Cu 0 /g) ?? []).toHaveLength(1);
    expect(dsn.match(/\(via_keepout "" \(polygon signal 0 /g) ?? []).toHaveLength(1);
  });

  it('sizes a non-plated hole keepout by drill (not annulus), grown by the default clearance', () => {
    let b = tinyBoard();
    b = apply(b, {
      op: 'addHole',
      hole: { at: { x: 0, y: 0 }, drill: 1.0, padDiameter: 3.0, plated: false },
    });
    const dsn = exportDSN(b);
    // radius = drill/2 (0.5mm) + default clearance (0.2mm) = 0.7mm = 700um,
    // so the circle's rightmost tessellated point sits at x=700 (y=0 center).
    expect(dsn).toContain('(keepout "" (polygon F.Cu 0 700 0');
  });

  it('gives distinct-geometry parts sharing a footprint name their own image/padstacks', () => {
    const wideFp: Footprint = {
      name: '0603',
      lcsc: 'A',
      pads: [
        { number: '1', shape: 'rect', at: { x: -0.75, y: 0 }, rotation: 0, size: { w: 0.8, h: 0.9 }, layer: 'top' },
        { number: '2', shape: 'rect', at: { x: 0.75, y: 0 }, rotation: 0, size: { w: 0.8, h: 0.9 }, layer: 'top' },
      ],
      silk: [],
      courtyard: [],
    };
    const narrowFp: Footprint = {
      name: '0603', // same name, different real pads
      lcsc: 'B',
      pads: [
        { number: '1', shape: 'rect', at: { x: -0.5, y: 0 }, rotation: 0, size: { w: 0.4, h: 0.5 }, layer: 'top' },
        { number: '2', shape: 'rect', at: { x: 0.5, y: 0 }, rotation: 0, size: { w: 0.4, h: 0.5 }, layer: 'top' },
      ],
      silk: [],
      courtyard: [],
    };
    let b = newBoard('t2', 2);
    b = apply(b, { op: 'placeComponent', refdes: 'U1', lcsc: 'A', footprint: wideFp, at: { x: 0, y: 0 }, rotation: 0, side: 'top', fields: {} });
    b = apply(b, { op: 'placeComponent', refdes: 'U2', lcsc: 'B', footprint: narrowFp, at: { x: 5, y: 0 }, rotation: 0, side: 'top', fields: {} });
    const dsn = exportDSN(b);
    // two distinct (image ...) blocks: the first-seen geometry keeps the bare
    // name, the second gets a disambiguating suffix.
    expect(dsn.match(/\(image /g) ?? []).toHaveLength(2);
    expect(dsn).toContain('(image 0603\n');
    expect(dsn).toMatch(/\(image 0603_[0-9a-f]{8}\n/);
    // each component's placement points at its own image, and each image's
    // pin list reflects its own pad geometry (not the other one's).
    expect(dsn).toMatch(/\(pin rect_800x900_F 1 -750 0\)/);
    expect(dsn).toMatch(/\(pin rect_400x500_F 1 -500 0\)/);
  });

  it('quotes odd pad numbers/refdes in the (pins ...) list', () => {
    const fp: Footprint = {
      name: 'ODD',
      lcsc: 'X',
      pads: [
        { number: 'A 6', shape: 'rect', at: { x: -0.75, y: 0 }, rotation: 0, size: { w: 0.8, h: 0.9 }, layer: 'top' },
        { number: '2', shape: 'rect', at: { x: 0.75, y: 0 }, rotation: 0, size: { w: 0.8, h: 0.9 }, layer: 'top' },
      ],
      silk: [],
      courtyard: [],
    };
    let b = newBoard('o', 2);
    b = apply(b, { op: 'placeComponent', refdes: 'U-1', lcsc: 'X', footprint: fp, at: { x: 0, y: 0 }, rotation: 0, side: 'top', fields: {} });
    b = apply(b, { op: 'placeComponent', refdes: 'U2', lcsc: 'X', footprint: fp, at: { x: 5, y: 0 }, rotation: 0, side: 'top', fields: {} });
    b = apply(b, { op: 'connectPins', net: 'N1', pins: ['U-1.A 6', 'U2.2'] });
    const dsn = exportDSN(b);
    expect(dsn).toContain('(net N1 (pins "U-1"-"A 6" U2-2))');
  });
});
