/**
 * Flamingo Engine - built-in footprints: parts that have no LCSC number
 * because they are only copper (solder jumpers, test-point pads).
 *
 * Units mm, y-up, footprint origin at the centre. None of these get solder
 * paste, so an open jumper cannot bridge in reflow and a test point stays
 * flat bare copper for a probe. A part without an LCSC number is never
 * assembled: it stays out of the BOM, the CPL and the stock check.
 *
 * Solder jumper geometry follows KiCad's SolderJumper-*_P1.3mm_*_RectPad1.0x1.5mm:
 * 1.0 x 1.5mm pads on a 1.3mm pitch, so a 0.3mm gap that a soldering iron
 * bridges with one blob. A bridged jumper adds a 0.4mm-wide copper link
 * across one gap, split between the two pads it joins (each pad's polygon
 * carries half). The two pads stay separate nets; `netTie` tells DRC that
 * they touch on purpose. Cut the link with a knife to open the jumper.
 */

import type { ComponentInst, Footprint, Pad, Point, SilkItem } from './types.js';

export type BuiltinFootprintSpec =
  | { kind: 'solder-jumper-2'; bridged?: boolean }
  | { kind: 'solder-jumper-3'; bridged?: 'none' | '1-2' | '2-3' }
  | { kind: 'test-point'; diameter?: number };

const PAD_W = 1.0;
const PAD_H = 1.5;
const PITCH = 1.3;
const LINK_W = 0.4;
/** Silk sits this far outside the pads, clear of the 0.05mm mask opening. */
const SILK_GAP = 0.25;
const SILK_W = 0.15;
const COURTYARD_GAP = 0.25;
export const TEST_POINT_DEFAULT_DIAMETER = 1.0;

function rectPad(number: string, x: number): Pad {
  return { number, shape: 'rect', at: { x, y: 0 }, rotation: 0, size: { w: PAD_W, h: PAD_H }, layer: 'top' };
}

/**
 * Give a rect pad a half-link stub toward its neighbour: `dir` +1 grows it to
 * the right, -1 to the left. The pad keeps its `size` (the DSN uses that) and
 * becomes a polygon with the stub, relative to the pad's centre.
 */
function withStub(pad: Pad, dir: 1 | -1): Pad {
  const hw = PAD_W / 2;
  const hh = PAD_H / 2;
  const hl = LINK_W / 2;
  const tip = PITCH / 2;
  // CCW; the left-pointing stub is this rotated half a turn, still CCW.
  const right: Point[] = [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: -hl },
    { x: tip, y: -hl },
    { x: tip, y: hl },
    { x: hw, y: hl },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ];
  const polygon = dir === 1 ? right : right.map((p) => ({ x: -p.x, y: -p.y }));
  return { ...pad, shape: 'polygon', polygon };
}

function box(hx: number, hy: number): Point[] {
  return [
    { x: -hx, y: -hy },
    { x: hx, y: -hy },
    { x: hx, y: hy },
    { x: -hx, y: hy },
  ];
}

function silkBox(hx: number, hy: number): SilkItem[] {
  const c = box(hx, hy);
  return c.map((start, i) => ({ kind: 'line', start, end: c[(i + 1) % c.length], width: SILK_W }));
}

function jumperFootprint(name: string, pads: Pad[], netTie: string[] | undefined): Footprint {
  const hx = Math.max(...pads.map((p) => Math.abs(p.at.x))) + PAD_W / 2;
  const hy = PAD_H / 2;
  return {
    name,
    lcsc: '',
    pads,
    silk: silkBox(hx + SILK_GAP, hy + SILK_GAP),
    courtyard: [box(hx + SILK_GAP + SILK_W / 2 + COURTYARD_GAP, hy + SILK_GAP + SILK_W / 2 + COURTYARD_GAP)],
    ...(netTie ? { netTie } : {}),
    noPaste: true,
  };
}

export interface BuiltinPart {
  footprint: Footprint;
  /** BOM-style value, also shown in the UI. */
  value: string;
  package: string;
  description: string;
}

/** Build a built-in footprint. Throws on an out-of-range spec (a caller error). */
export function builtinFootprint(spec: BuiltinFootprintSpec): BuiltinPart {
  switch (spec.kind) {
    case 'solder-jumper-2': {
      const bridged = spec.bridged === true;
      let p1 = rectPad('1', -PITCH / 2);
      let p2 = rectPad('2', PITCH / 2);
      if (bridged) {
        p1 = withStub(p1, 1);
        p2 = withStub(p2, -1);
      }
      const name = bridged ? 'SolderJumper-2_Bridged' : 'SolderJumper-2_Open';
      return {
        footprint: jumperFootprint(name, [p1, p2], bridged ? ['1', '2'] : undefined),
        value: bridged ? 'SJ closed' : 'SJ open',
        package: name,
        description: bridged
          ? '2-pad solder jumper, closed by a copper link: cut the link to open it'
          : '2-pad solder jumper, open: bridge the pads with solder to close it',
      };
    }
    case 'solder-jumper-3': {
      const bridged = spec.bridged ?? 'none';
      let p1 = rectPad('1', -PITCH);
      let p2 = rectPad('2', 0);
      let p3 = rectPad('3', PITCH);
      let tie: string[] | undefined;
      if (bridged === '1-2') {
        p1 = withStub(p1, 1);
        p2 = withStub(p2, -1);
        tie = ['1', '2'];
      } else if (bridged === '2-3') {
        p2 = withStub(p2, 1);
        p3 = withStub(p3, -1);
        tie = ['2', '3'];
      }
      const name = bridged === 'none' ? 'SolderJumper-3_Open' : `SolderJumper-3_Bridged${bridged.replace('-', '')}`;
      return {
        footprint: jumperFootprint(name, [p1, p2, p3], tie),
        value: bridged === 'none' ? 'SJ3 open' : `SJ3 ${bridged}`,
        package: name,
        description:
          bridged === 'none'
            ? '3-pad solder jumper, open: bridge pad 2 to pad 1 or pad 3 with solder'
            : `3-pad solder jumper, pad ${bridged.replace('-', ' joined to pad ')} by a copper link: cut it to change over`,
      };
    }
    case 'test-point': {
      const d = spec.diameter ?? TEST_POINT_DEFAULT_DIAMETER;
      if (!(d >= 0.5 && d <= 3)) throw new Error(`test point diameter ${d}mm is outside 0.5 to 3mm`);
      const name = `TestPoint_Pad_D${parseFloat(d.toFixed(2))}mm`;
      const r = d / 2;
      return {
        footprint: {
          name,
          lcsc: '',
          pads: [{ number: '1', shape: 'circle', at: { x: 0, y: 0 }, rotation: 0, size: { w: d, h: d }, layer: 'top' }],
          // No silk: a ring around the pad would sit on the mask opening.
          silk: [],
          courtyard: [box(r + COURTYARD_GAP, r + COURTYARD_GAP)],
          noPaste: true,
        },
        value: 'TP',
        package: name,
        description: `Test point: a bare ${parseFloat(d.toFixed(2))}mm copper pad for a probe`,
      };
    }
  }
}

const LCSC_ID = /^C\d+$/i;

/**
 * Whether JLCPCB assembles this part: it has an LCSC number and is not
 * marked do-not-place. Everything else stays out of the BOM, CPL and stock check.
 */
export function isAssembled(c: ComponentInst): boolean {
  return LCSC_ID.test(c.lcsc) && c.fields.dnp !== true;
}
