/**
 * Flamingo Fab - export_print: the board as 1:1 printable sheets, for
 * test-fitting real parts on paper before ordering.
 *
 * Clone parts (StepSticks, breakout boards, connector clones) do not always
 * match the footprint they copy. Printing the board at 1:1, gluing it to card
 * and pushing the real parts through catches that for the price of a sheet of
 * paper. Pages:
 *
 *   1. Top side, seen from above: outline, copper pads, drills with
 *      crosshairs to pierce, vias, holes, the top legend exactly as the fab
 *      prints it (legend.ts), dashed courtyards, red rings on pin 1.
 *   2. Bottom side, seen from below (the board turned over about its vertical
 *      axis): the side through-hole parts are soldered from.
 *   3+ Every distinct footprint, unrotated, with pad numbers, pad 1 in red,
 *      its LCSC number and the refdes that use it.
 *
 * Every page carries a 100 mm and a 4 inch scale bar. Print at 100 %.
 * Geometry goes through the engine's own transforms (padOutline, padWorld,
 * componentTransformPoints, allHoles), the same ones the Gerbers use.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Board, ComponentInst, Footprint, Point } from '@flamingo/engine';
import {
  allHoles,
  boardBBox,
  capsulePolygon,
  componentTransformPoints,
  copperLayersOf,
  holeSlotCenterline,
  isSlot,
  outlineToPolygon,
  padCopperLayers,
  padOutline,
  padWorld,
  rotate,
  tessellateCircle,
  tessellateSeg,
} from '@flamingo/engine';
import { legendStrokes } from '../legend.js';
import { PAPER, type Paper, PrintPage, type Rgb, fitText, pageSvg, writePdf } from './pdf.js';

const BLACK: Rgb = [0, 0, 0];
const GREY: Rgb = [0.55, 0.55, 0.55];
const FAINT: Rgb = [0.88, 0.88, 0.88];
const BOARD_FILL: Rgb = [0.96, 0.98, 0.94];
const COPPER_TOP: Rgb = [0.85, 0.55, 0.25];
const COPPER_BOTTOM: Rgb = [0.35, 0.55, 0.85];
const COPPER_THROUGH: Rgb = [0.7, 0.45, 0.2];
const RED: Rgb = [0.85, 0.1, 0.1];
const WHITE: Rgb = [1, 1, 1];
const SUBTLE: Rgb = [0.25, 0.25, 0.25];

const MARGIN = 12;
const HEADER = 28; // mm kept clear at the top for the title block
const FOOTER = 22; // mm kept clear at the bottom for the scale bars

export interface PrintOptions {
  paper?: Paper;
  /** Shown in the title block, e.g. the board file name and its hash. */
  source?: string;
  /** Date shown in the title block (default today, ISO). */
  date?: string;
}

// ---------------------------------------------------------------------------
// Page furniture
// ---------------------------------------------------------------------------

function titleBlock(pg: PrintPage, title: string, lines: string[]): void {
  const y = pg.h - MARGIN - 5;
  pg.text({ x: MARGIN, y }, title, 5, { bold: true });
  lines.forEach((s, i) => pg.text({ x: MARGIN, y: y - 7 - 4.2 * i }, s, 2.6, { color: SUBTLE }));
  pg.text(
    { x: MARGIN, y: y - 7 - 4.2 * lines.length },
    'Print at 100 % (Actual size), not Fit to page. Measure the scale bars at the bottom before trusting a fit.',
    2.6,
    { color: RED, bold: true },
  );
}

/** A 100 mm bar and a 4 inch bar, with ticks. */
function scaleBars(pg: PrintPage): void {
  const x0 = MARGIN;
  const yMm = MARGIN + 13;
  const yIn = MARGIN + 3;
  pg.line({ x: x0, y: yMm }, { x: x0 + 100, y: yMm }, { width: 0.3 });
  for (let i = 0; i <= 10; i++) {
    const t = i % 5 === 0 ? 2.5 : 1.5;
    pg.line({ x: x0 + 10 * i, y: yMm }, { x: x0 + 10 * i, y: yMm + t }, { width: 0.2 });
  }
  pg.text({ x: x0 + 102, y: yMm - 0.8 }, '100 mm', 2.4);
  pg.line({ x: x0, y: yIn }, { x: x0 + 101.6, y: yIn }, { width: 0.3 });
  for (let i = 0; i <= 16; i++) {
    const t = i % 4 === 0 ? 2.5 : 1.2;
    pg.line({ x: x0 + 6.35 * i, y: yIn }, { x: x0 + 6.35 * i, y: yIn + t }, { width: 0.2 });
  }
  pg.text({ x: x0 + 104, y: yIn - 0.8 }, '4 in', 2.4);
}

function legendKey(pg: PrintPage, bottom: boolean): void {
  const x = pg.w - MARGIN - 62;
  const y = MARGIN + FOOTER - 3;
  const items: [Rgb, string][] = [
    [bottom ? COPPER_BOTTOM : COPPER_TOP, 'SMD copper, this side'],
    [COPPER_THROUGH, 'through-hole copper'],
    [RED, 'red: pin 1 and refdes (not printed by the fab)'],
  ];
  items.forEach(([col, label], i) => {
    const yy = y - 4 * i;
    pg.poly(
      [
        { x, y: yy },
        { x: x + 3, y: yy },
        { x: x + 3, y: yy + 2 },
        { x, y: yy + 2 },
      ],
      { stroke: null, fill: col, closed: true },
    );
    pg.text({ x: x + 4.5, y: yy + 0.3 }, label, 1.9);
  });
}

// ---------------------------------------------------------------------------
// Board sides
// ---------------------------------------------------------------------------

/** Board mm -> page mm. `bottom` mirrors x so the page shows the underside seen from below. */
export interface View {
  (p: Point): Point;
  ox: number;
  oy: number;
}

export function boardView(b: Board, pg: PrintPage, bottom: boolean): View {
  const bb = boardBBox(b);
  const bw = bb.maxX - bb.minX;
  const bh = bb.maxY - bb.minY;
  const availW = pg.w - 2 * MARGIN;
  const availH = pg.h - 2 * MARGIN - HEADER - FOOTER;
  if (bw > availW || bh > availH) {
    throw new Error(
      `export_print: ${b.name} (${bw.toFixed(1)} x ${bh.toFixed(1)} mm) does not fit on this paper at 1:1`,
    );
  }
  const ox = MARGIN + (availW - bw) / 2;
  const oy = MARGIN + FOOTER + (availH - bh) / 2;
  const v = ((p: Point): Point => ({
    x: ox + (bottom ? bb.maxX - p.x : p.x - bb.minX),
    y: oy + (p.y - bb.minY),
  })) as View;
  v.ox = ox;
  v.oy = oy;
  return v;
}

/** Centre-line of a slotted pad drill in world space (as excellon.ts drills it). */
function padSlot(c: ComponentInst, pad: Footprint['pads'][number]): Point[] {
  const world = padWorld(c, pad);
  const d = pad.drill!.diameter;
  const half = Math.max(0, (pad.drill!.slotLength! - d) / 2);
  const dir = rotate(pad.size.w >= pad.size.h ? { x: 1, y: 0 } : { x: 0, y: 1 }, world.rotation);
  return capsulePolygon(
    { x: world.at.x - dir.x * half, y: world.at.y - dir.y * half },
    { x: world.at.x + dir.x * half, y: world.at.y + dir.y * half },
    d / 2,
  );
}

function drawDrill(pg: PrintPage, v: (p: Point) => Point, c: ComponentInst, pad: Footprint['pads'][number]): void {
  if (!pad.drill) return;
  if (pad.drill.slotLength !== undefined && pad.drill.slotLength > pad.drill.diameter) {
    pg.poly(padSlot(c, pad).map(v), { stroke: BLACK, fill: WHITE, width: 0.08, closed: true });
    return;
  }
  const ctr = v(padWorld(c, pad).at);
  const r = pad.drill.diameter / 2;
  pg.circle(ctr, r, { stroke: BLACK, fill: WHITE, width: 0.08 });
  const k = Math.min(r * 0.7, 0.35);
  pg.line({ x: ctr.x - k, y: ctr.y }, { x: ctr.x + k, y: ctr.y }, { width: 0.05 });
  pg.line({ x: ctr.x, y: ctr.y - k }, { x: ctr.x, y: ctr.y + k }, { width: 0.05 });
}

function drawLegend(pg: PrintPage, b: Board, side: 'F' | 'B', v: (p: Point) => Point): void {
  for (const s of legendStrokes(b, side)) {
    if (s.kind === 'seg') pg.poly(tessellateSeg(s.seg).map(v), { width: s.width });
    else if (s.kind === 'circle') pg.poly(tessellateCircle(s.center, s.r).map(v), { width: s.width, closed: true });
    else pg.poly(s.pts.map(v), { width: s.width });
  }
}

function pinOne(c: ComponentInst): Footprint['pads'][number] | undefined {
  if (c.footprint.pads.length <= 2) return undefined;
  return c.footprint.pads.find((p) => p.number === '1' || p.number === 'A1');
}

function hasThroughPads(c: ComponentInst): boolean {
  return c.footprint.pads.some((p) => p.layer === 'through');
}

/** Draw one side of `b` onto `pg`. Returns the view used, for tests. */
export function drawBoardSide(b: Board, pg: PrintPage, side: 'top' | 'bottom'): View {
  const bottom = side === 'bottom';
  const v = boardView(b, pg, bottom);
  const cu = copperLayersOf(b);
  const myCu = bottom ? 'B.Cu' : 'F.Cu';

  // Board body.
  if (b.outline.length > 0) {
    pg.poly(outlineToPolygon(b.outline).map(v), { stroke: BLACK, fill: BOARD_FILL, width: 0.3, closed: true });
  }

  // Courtyards: this side's parts in grey, the other side's faint.
  for (const c of b.components) {
    for (const ring of c.footprint.courtyard) {
      pg.poly(componentTransformPoints(c, ring).map(v), {
        stroke: c.side === side ? GREY : FAINT,
        width: 0.1,
        closed: true,
        dash: [0.8, 0.6],
      });
    }
  }

  // Copper pads on this side (through-hole pads are on both).
  for (const c of b.components) {
    for (const pad of c.footprint.pads) {
      if (!padCopperLayers(pad, c.side, cu).includes(myCu)) continue;
      const fill = pad.layer === 'through' ? COPPER_THROUGH : bottom ? COPPER_BOTTOM : COPPER_TOP;
      pg.poly(padOutline(c, pad).map(v), { stroke: null, fill, closed: true });
    }
  }

  // Pad drills, with a crosshair to aim a pin through the paper.
  for (const c of b.components) for (const pad of c.footprint.pads) drawDrill(pg, v, c, pad);

  // Mounting holes and footprint locating holes.
  for (const h of allHoles(b)) {
    if (isSlot(h)) {
      const { start, end } = holeSlotCenterline(h);
      if (h.plated && h.padDiameter > h.drill) {
        pg.poly(capsulePolygon(start, end, h.padDiameter / 2).map(v), { stroke: null, fill: COPPER_THROUGH, closed: true });
      }
      pg.poly(capsulePolygon(start, end, h.drill / 2).map(v), { stroke: BLACK, fill: WHITE, width: 0.12, closed: true });
      continue;
    }
    const ctr = v(h.at);
    if (h.plated && h.padDiameter > h.drill) pg.circle(ctr, h.padDiameter / 2, { stroke: null, fill: COPPER_THROUGH });
    pg.circle(ctr, h.drill / 2, { stroke: BLACK, fill: WHITE, width: 0.12 });
    if (!h.plated) pg.circle(ctr, h.drill / 2 + 0.3, { stroke: GREY, width: 0.08 });
  }

  // Vias, so the paper shows everywhere the board is drilled.
  for (const via of b.vias) pg.circle(v(via.at), via.drill / 2, { stroke: null, fill: GREY });

  // The legend, exactly as the fab prints it.
  drawLegend(pg, b, bottom ? 'B' : 'F', v);

  // Annotations: a ring on pin 1 of every multi-pin part visible from this
  // side, and the refdes of through-hole parts mounted on the other side
  // (their fab label is on the other legend).
  for (const c of b.components) {
    const visible = c.side === side || hasThroughPads(c);
    if (!visible) continue;
    const p1 = pinOne(c);
    if (p1) {
      const r = Math.max(p1.size.w, p1.size.h) / 2 + 0.35;
      pg.circle(v(padWorld(c, p1).at), r, { stroke: RED, width: 0.12 });
    }
    if (c.side !== side) {
      const pts = c.footprint.courtyard.flat();
      const world = pts.length > 0 ? componentTransformPoints(c, pts) : [c.at];
      const xs = world.map((p) => p.x);
      const ys = world.map((p) => p.y);
      const ctr = v({ x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 });
      pg.text({ x: ctr.x, y: ctr.y - 0.8 }, c.refdes, 1.6, { color: RED, anchor: 'middle' });
    }
  }
  return v;
}

// ---------------------------------------------------------------------------
// Footprint catalogue
// ---------------------------------------------------------------------------

/** The component as if placed unrotated, top side, at the origin. */
function atOrigin(c: ComponentInst): ComponentInst {
  return { ...c, at: { x: 0, y: 0 }, rotation: 0, side: 'top' };
}

function footprintBBox(c: ComponentInst): { minX: number; minY: number; maxX: number; maxY: number } {
  const pts: Point[] = [];
  for (const pad of c.footprint.pads) pts.push(...padOutline(c, pad));
  for (const ring of c.footprint.courtyard) pts.push(...componentTransformPoints(c, ring));
  for (const s of c.footprint.silk) {
    if (s.kind === 'line' || s.kind === 'arc') pts.push(...componentTransformPoints(c, [s.start, s.end]));
    if (s.kind === 'circle') {
      const [ctr] = componentTransformPoints(c, [s.center]);
      pts.push({ x: ctr!.x - s.radius, y: ctr!.y - s.radius }, { x: ctr!.x + s.radius, y: ctr!.y + s.radius });
    }
  }
  if (pts.length === 0) pts.push({ x: 0, y: 0 });
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/** "XP2, XP0, XP1, R5" -> "R5, XP0-XP2". */
export function compressRefs(refs: string[]): string {
  const parsed = refs
    .map((r) => {
      const m = /^([A-Za-z_]+)(\d+)$/.exec(r);
      return m ? { p: m[1]!, n: Number(m[2]) } : { p: r, n: -1 };
    })
    .sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : a.n - b.n));
  const out: string[] = [];
  for (let i = 0; i < parsed.length; ) {
    const { p, n } = parsed[i]!;
    let j = i;
    while (n >= 0 && j + 1 < parsed.length && parsed[j + 1]!.p === p && parsed[j + 1]!.n === parsed[j]!.n + 1) j++;
    if (n < 0) out.push(p);
    else if (j - i >= 2) out.push(`${p}${n}-${p}${parsed[j]!.n}`);
    else for (let k = i; k <= j; k++) out.push(`${p}${parsed[k]!.n}`);
    i = j + 1;
  }
  return out.join(', ');
}

/** Components grouped by (LCSC, footprint name), widest footprint first. */
export function footprintGroups(b: Board): ComponentInst[][] {
  const groups = new Map<string, ComponentInst[]>();
  for (const c of b.components) {
    const key = `${c.lcsc}|${c.footprint.name}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const width = (c: ComponentInst): number => {
    const bb = footprintBBox(atOrigin(c));
    return bb.maxX - bb.minX;
  };
  return [...groups.values()].sort((a, b) => width(b[0]!) - width(a[0]!));
}

function drawFootprint(pg: PrintPage, c0: ComponentInst, origin: Point): void {
  const c = atOrigin(c0);
  const v = (p: Point): Point => ({ x: origin.x + p.x, y: origin.y + p.y });
  for (const ring of c.footprint.courtyard) {
    pg.poly(componentTransformPoints(c, ring).map(v), { stroke: GREY, width: 0.1, closed: true, dash: [0.8, 0.6] });
  }
  for (const pad of c.footprint.pads) {
    const fill = pad.layer === 'through' ? COPPER_THROUGH : COPPER_TOP;
    pg.poly(padOutline(c, pad).map(v), { stroke: null, fill, closed: true });
    drawDrill(pg, v, c, pad);
  }
  for (const s of c.footprint.silk) {
    if (s.kind === 'line') pg.poly(componentTransformPoints(c, [s.start, s.end]).map(v), { width: Math.max(0.15, s.width) });
    else if (s.kind === 'arc') {
      const [start, end, center] = componentTransformPoints(c, [s.start, s.end, s.center]);
      pg.poly(tessellateSeg({ type: 'arc', start: start!, end: end!, center: center!, cw: s.cw }).map(v), {
        width: Math.max(0.15, s.width),
      });
    } else if (s.kind === 'circle') {
      pg.poly(tessellateCircle(s.center, s.radius).map(v), { width: Math.max(0.15, s.width), closed: true });
    }
  }
  const one = pinOne(c);
  for (const pad of c.footprint.pads) {
    const label = pad.number;
    const size = Math.max(
      0.5,
      Math.min(1.4, 0.45 * Math.min(pad.size.w, pad.size.h) + 0.2, (1.6 * Math.max(pad.size.w, pad.size.h)) / Math.max(1, label.length)),
    );
    const at = v(padWorld(c, pad).at);
    const isOne = pad === one;
    pg.text({ x: at.x, y: at.y - size / 2 }, label, size, { color: isOne ? RED : BLACK, anchor: 'middle', bold: isOne });
  }
}

function cataloguePages(b: Board, paper: Paper, source: string): PrintPage[] {
  const { w: pw, h: ph } = PAPER[paper];
  const labelH = 9;
  const gap = 6;
  const xMin = MARGIN;
  const xMax = pw - MARGIN;
  const yTop = ph - MARGIN - HEADER;
  const yBot = MARGIN + FOOTER;
  const pages: PrintPage[] = [];
  const newPage = (): PrintPage => {
    const pg = new PrintPage(pw, ph);
    titleBlock(pg, `${b.name} - every footprint at 1:1`, [
      source,
      'Unrotated, seen from above. Pad 1 in red. Set each real part on its footprint to check pitch, row spacing and pin 1.',
    ]);
    scaleBars(pg);
    pages.push(pg);
    return pg;
  };
  let pg = newPage();
  let cx = xMin;
  let cy = yTop;
  let rowH = 0;
  for (const comps of footprintGroups(b)) {
    const c0 = comps[0]!;
    const bb = footprintBBox(atOrigin(c0));
    const fw = bb.maxX - bb.minX;
    const fh = bb.maxY - bb.minY;
    const cellW = Math.max(fw, 38);
    const cellH = fh + labelH;
    if (cx + cellW > xMax) {
      cx = xMin;
      cy -= rowH + gap;
      rowH = 0;
    }
    if (cy - cellH < yBot) {
      pg = newPage();
      cx = xMin;
      cy = yTop;
      rowH = 0;
    }
    pg.text({ x: cx, y: cy - 2.4 }, fitText(c0.fields.value || c0.footprint.name, cellW, 2.2), 2.2, { bold: true });
    pg.text({ x: cx, y: cy - 5 }, fitText(`${c0.lcsc}  ${c0.footprint.name}`, cellW, 1.6), 1.6, { color: SUBTLE });
    pg.text({ x: cx, y: cy - 7.3 }, fitText(compressRefs(comps.map((c) => c.refdes)), cellW, 1.6), 1.6, { color: RED });
    drawFootprint(pg, c0, { x: cx + (cellW - fw) / 2 - bb.minX, y: cy - labelH - bb.maxY });
    cx += cellW + gap;
    rowH = Math.max(rowH, cellH);
  }
  return pages;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Every page of the printout for `b`: top, bottom, then the footprint catalogue. */
export function printPages(b: Board, opts: PrintOptions = {}): PrintPage[] {
  const paper = opts.paper ?? 'a4';
  const { w, h } = PAPER[paper];
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const source = [opts.source, `generated ${date}`].filter(Boolean).join('  ');
  const bb = boardBBox(b);
  const size = `Outline ${+(bb.maxX - bb.minX).toFixed(2)} x ${+(bb.maxY - bb.minY).toFixed(2)} mm.`;
  const pages: PrintPage[] = [];
  for (const side of ['top', 'bottom'] as const) {
    const pg = new PrintPage(w, h);
    const note =
      side === 'top'
        ? 'Lay parts on the pads; pierce the crosshairs to push through-hole pins through.'
        : 'The soldering side for through-hole parts. Left and right are swapped against page 1.';
    titleBlock(pg, `${b.name} - ${side === 'top' ? 'TOP, seen from above' : 'BOTTOM, seen from below'}`, [
      source,
      `${size} ${note}`,
    ]);
    drawBoardSide(b, pg, side);
    scaleBars(pg);
    legendKey(pg, side === 'bottom');
    pages.push(pg);
  }
  return [...pages, ...cataloguePages(b, paper, source)];
}

export interface ExportPrintResult {
  pdf: string;
  svgs: string[];
  pages: number;
}

/**
 * Write `<name>.print.pdf` (and, with `svg`, one `<name>.print-pN.svg` per
 * page) into `outDir`. Returns absolute paths.
 */
export async function exportPrint(
  b: Board,
  outDir: string,
  opts: PrintOptions & { svg?: boolean; name?: string } = {},
): Promise<ExportPrintResult> {
  const abs = resolve(outDir);
  await mkdir(abs, { recursive: true });
  const pages = printPages(b, opts);
  const name = (opts.name ?? b.name ?? 'board').replace(/[^\w.-]+/g, '_');
  const pdf = resolve(abs, `${name}.print.pdf`);
  await writeFile(pdf, writePdf(pages, `${b.name} 1:1 print`));
  const svgs: string[] = [];
  if (opts.svg) {
    for (const [i, pg] of pages.entries()) {
      const p = resolve(abs, `${name}.print-p${i + 1}.svg`);
      await writeFile(p, pageSvg(pg), 'utf8');
      svgs.push(p);
    }
  }
  return { pdf, svgs, pages: pages.length };
}
