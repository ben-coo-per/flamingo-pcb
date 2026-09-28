/**
 * Panel view - canvas drawing.
 *
 * `drawPlate` is a pure function of the state: panel view in, pixels out.
 * Colour says which design a board is, and nothing else: every instance is
 * filled with a tint of its board's colour and outlined in it. What state a
 * thing is in is said with line weight, dashes, hatching and labels, so the
 * plate reads the same without colour:
 *
 *   panel outline      heavy solid line
 *   rails              diagonal hatch
 *   size limits        long-dash rectangles, labelled
 *   populated board    solid outline
 *   bare board         dashed outline, sparse hatch, label BARE
 *   selected           heavy outline, square handles at the corners
 *   pinned             filled square in the top-left corner, label PINNED
 *   stale source       dotted outline, label STALE
 *   blocked edge       heavy line with a comb of ticks pointing outward
 *   overhanging part   thin dashed polygon
 *   board-edge keepout cross hatch
 *   tab                filled bar; mouse-bite holes as open circles
 *   error / warning    second outline outside the board (solid / dashed), label ERROR / WARNING
 */

import type { Point } from '@flamingo/engine';
import type { Box, PanelGeometry, PlacedInstance, Side } from '@flamingo/panel';
import { BOARD_TINT, boardColor, tint } from '@flamingo/panel';
import type { ViewTransform } from '../state.js';
import { worldToScreen } from '../view.js';
import { mm, worstByInstance } from './format.js';
import { dragOffset } from './hit.js';
import type { PanelState } from './store.js';

const INK = '#000';
const PAPER = '#fff';
// ctx.font cannot resolve CSS custom properties: spell the stack out.
const FONT = `'Space Mono', 'Menlo', monospace`;
const SIDES: readonly Side[] = ['N', 'E', 'S', 'W'];

type Ctx = CanvasRenderingContext2D;

function corners(b: Box): Point[] {
  return [
    { x: b.minX, y: b.minY },
    { x: b.maxX, y: b.minY },
    { x: b.maxX, y: b.maxY },
    { x: b.minX, y: b.maxY },
  ];
}

function trace(ctx: Ctx, t: ViewTransform, pts: Point[], close = true): void {
  ctx.beginPath();
  pts.forEach((p, i) => {
    const s = worldToScreen(t, p);
    if (i === 0) ctx.moveTo(s.x, s.y);
    else ctx.lineTo(s.x, s.y);
  });
  if (close) ctx.closePath();
}

function stroke(ctx: Ctx, width: number, dash: number[] = [], colour: string = INK): void {
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.strokeStyle = colour;
  ctx.stroke();
  ctx.setLineDash([]);
}

/** Diagonal hatch inside the current path, at a fixed pitch in screen pixels. */
function hatch(
  ctx: Ctx,
  t: ViewTransform,
  pts: Point[],
  pitch: number,
  width: number,
  cross = false,
  colour: string = INK,
): void {
  const screen = pts.map((p) => worldToScreen(t, p));
  const xs = screen.map((p) => p.x);
  const ys = screen.map((p) => p.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const h = y1 - y0;
  ctx.save();
  trace(ctx, t, pts);
  ctx.clip();
  ctx.beginPath();
  // Anchored to the plate, not to the shape, so hatches line up across shapes.
  const first = Math.floor((x0 - h) / pitch) * pitch;
  for (let x = first; x <= x1 + pitch; x += pitch) {
    ctx.moveTo(x, y1);
    ctx.lineTo(x + h, y0);
    if (cross) {
      ctx.moveTo(x + h, y1);
      ctx.lineTo(x, y0);
    }
  }
  ctx.lineWidth = width;
  ctx.strokeStyle = colour;
  ctx.stroke();
  ctx.restore();
}

function label(
  ctx: Ctx,
  text: string,
  x: number,
  y: number,
  px: number,
  bold = false,
  align: CanvasTextAlign = 'center',
  ground: string = PAPER,
): void {
  ctx.font = `${bold ? '700 ' : ''}${px}px ${FONT}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  // A patch of the ground behind the text keeps it legible over hatching.
  const w = ctx.measureText(text).width;
  const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  ctx.fillStyle = ground;
  ctx.fillRect(left - 3, y - px * 0.62, w + 6, px * 1.24);
  ctx.fillStyle = INK;
  ctx.fillText(text, x, y);
}

function edgeEnds(b: Box, side: Side): [Point, Point] {
  switch (side) {
    case 'N':
      return [{ x: b.minX, y: b.maxY }, { x: b.maxX, y: b.maxY }];
    case 'S':
      return [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }];
    case 'E':
      return [{ x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }];
    case 'W':
      return [{ x: b.minX, y: b.minY }, { x: b.minX, y: b.maxY }];
  }
}

const NORMAL: Record<Side, Point> = {
  N: { x: 0, y: 1 },
  S: { x: 0, y: -1 },
  E: { x: 1, y: 0 },
  W: { x: -1, y: 0 },
};

function shift(pts: Point[], by: Point): Point[] {
  return by.x === 0 && by.y === 0 ? pts : pts.map((p) => ({ x: p.x + by.x, y: p.y + by.y }));
}

function shiftBox(b: Box, by: Point): Box {
  return { minX: b.minX + by.x, minY: b.minY + by.y, maxX: b.maxX + by.x, maxY: b.maxY + by.y };
}

function drawLimits(ctx: Ctx, state: PanelState, geometry: PanelGeometry, width: number, height: number): void {
  const view = state.view!;
  const t = state.transform;
  const origin = geometry.frame ? { x: geometry.frame.outer.minX, y: geometry.frame.outer.minY } : { x: 0, y: 0 };
  view.limits.forEach((l, i) => {
    const box: Box = { minX: origin.x, minY: origin.y, maxX: origin.x + l.width, maxY: origin.y + l.height };
    trace(ctx, t, corners(box));
    stroke(ctx, l.binding ? 1.5 : 1, [14, 6]);
    // The label sits inside the limit's top-left corner, or, when that corner
    // is out of view, as near to it as the plate allows. Limits are stacked so
    // that two labels pushed to the same edge do not cover each other.
    const corner = worldToScreen(t, { x: box.minX, y: box.maxY });
    const text = `${l.label}: ${l.width} × ${l.height} mm${l.verified ? '' : ' (est.)'}${l.binding ? ' — arrange packs within this' : ''}`;
    ctx.font = `${l.binding ? '700 ' : ''}11px ${FONT}`;
    const w = ctx.measureText(text).width;
    const x = Math.max(8, Math.min(corner.x + 8, width - w - 8));
    const y = Math.max(12 + i * 18, Math.min(corner.y + 12 + i * 18, height - 12));
    label(ctx, text, x, y, 11, l.binding, 'left');
  });
}

function drawFrame(ctx: Ctx, state: PanelState, geometry: PanelGeometry): void {
  const t = state.transform;
  const frame = geometry.frame;
  if (!frame) return;

  for (const r of geometry.rails) {
    hatch(ctx, t, corners(r.box), 9, 0.6);
    trace(ctx, t, corners(r.box));
    stroke(ctx, 1);
  }

  for (const tab of geometry.tabs) {
    trace(ctx, t, tab.polygon);
    ctx.fillStyle = INK;
    ctx.fill();
  }
  const holeR = (state.view!.panel.settings.tabs.holeDiameter / 2) * t.scale;
  if (holeR >= 1.2) {
    for (const tab of geometry.tabs) {
      for (const h of tab.holes) {
        const s = worldToScreen(t, h);
        ctx.beginPath();
        ctx.arc(s.x, s.y, holeR, 0, Math.PI * 2);
        ctx.fillStyle = PAPER;
        ctx.fill();
        stroke(ctx, 0.75);
      }
    }
  }

  for (const d of geometry.dividers) {
    trace(ctx, t, d, false);
    stroke(ctx, 1, [3, 3]);
  }

  trace(ctx, t, corners(frame.outer));
  stroke(ctx, 3);

  for (const h of geometry.toolingHoles) {
    const s = worldToScreen(t, h.at);
    ctx.beginPath();
    ctx.arc(s.x, s.y, Math.max(2, (h.diameter / 2) * t.scale), 0, Math.PI * 2);
    ctx.fillStyle = PAPER;
    ctx.fill();
    stroke(ctx, 1.5);
  }
  const seen = new Set<string>();
  for (const f of geometry.fiducials) {
    const key = `${f.at.x},${f.at.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const s = worldToScreen(t, f.at);
    ctx.beginPath();
    ctx.arc(s.x, s.y, Math.max(3, (f.maskDiameter / 2) * t.scale), 0, Math.PI * 2);
    ctx.fillStyle = PAPER;
    ctx.fill();
    stroke(ctx, 1);
    ctx.beginPath();
    ctx.arc(s.x, s.y, Math.max(1.5, (f.copperDiameter / 2) * t.scale), 0, Math.PI * 2);
    ctx.fillStyle = INK;
    ctx.fill();
  }

  const at = worldToScreen(t, { x: frame.outer.minX, y: frame.outer.minY });
  label(ctx, `${mm(frame.width)} × ${mm(frame.height)} mm`, at.x, at.y + 14, 12, true, 'left');
}

function drawInstance(
  ctx: Ctx,
  state: PanelState,
  inst: PlacedInstance,
  level: 'error' | 'warning' | undefined,
  stale: boolean,
  colour: string,
): void {
  const t = state.transform;
  const off = dragOffset(inst.id, state.drag);
  const moving = off.x !== 0 || off.y !== 0;
  const selected = state.selection === inst.id;
  const outline = shift(inst.outline, off);
  const box = shiftBox(inst.bbox, off);

  // Opaque, so an instance being dragged hides what is under it.
  trace(ctx, t, outline);
  ctx.fillStyle = tint(colour, BOARD_TINT);
  ctx.fill();

  for (const k of inst.keepouts) {
    const poly = shift(k, off);
    hatch(ctx, t, poly, 7, 0.5, true);
    trace(ctx, t, poly);
    stroke(ctx, 0.75, [2, 3]);
  }
  if (!inst.populate) hatch(ctx, t, outline, 16, 1, false, colour);

  trace(ctx, t, outline);
  if (selected) stroke(ctx, 4.5, inst.populate ? [] : [10, 5], colour);
  else if (!inst.populate) stroke(ctx, 2, [10, 5], colour);
  else if (stale) stroke(ctx, 2, [2, 4], colour);
  else stroke(ctx, 2, [], colour);

  for (const o of inst.overhangs) {
    trace(ctx, t, shift(o.polygon, off));
    stroke(ctx, 1, [4, 3]);
  }

  for (const side of SIDES) {
    if (!inst.edges[side].blocked) continue;
    const [a, b] = edgeEnds(box, side);
    const sa = worldToScreen(t, a);
    const sb = worldToScreen(t, b);
    ctx.beginPath();
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
    stroke(ctx, 5);
    // The comb points away from the board. Screen y runs down, world y up.
    const n = { x: NORMAL[side].x, y: -NORMAL[side].y };
    const len = Math.hypot(sb.x - sa.x, sb.y - sa.y);
    const count = Math.max(2, Math.round(len / 12));
    ctx.beginPath();
    for (let i = 0; i <= count; i++) {
      const x = sa.x + ((sb.x - sa.x) * i) / count;
      const y = sa.y + ((sb.y - sa.y) * i) / count;
      ctx.moveTo(x, y);
      ctx.lineTo(x + n.x * 8, y + n.y * 8);
    }
    stroke(ctx, 1);
  }

  if (level) {
    const grow = 5 / t.scale;
    trace(ctx, t, corners({ minX: box.minX - grow, minY: box.minY - grow, maxX: box.maxX + grow, maxY: box.maxY + grow }));
    stroke(ctx, level === 'error' ? 2.5 : 1.25, level === 'error' ? [] : [6, 4]);
  }

  const tl = worldToScreen(t, { x: box.minX, y: box.maxY });
  if (inst.pinned) {
    ctx.fillStyle = INK;
    ctx.fillRect(tl.x + 5, tl.y + 5, 9, 9);
  }

  if (selected) {
    ctx.fillStyle = INK;
    for (const c of corners(box)) {
      const s = worldToScreen(t, c);
      ctx.fillRect(s.x - 4, s.y - 4, 8, 8);
    }
  }

  const c = worldToScreen(t, { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 });
  const wPx = (box.maxX - box.minX) * t.scale;
  const hPx = (box.maxY - box.minY) * t.scale;
  const tags: string[] = [];
  if (!inst.populate) tags.push('BARE');
  if (inst.pinned) tags.push('PINNED');
  if (stale) tags.push('STALE');
  if (level) tags.push(level === 'error' ? 'ERROR' : 'WARNING');
  const big = Math.max(11, Math.min(30, hPx / 3.2, wPx / 3));
  const small = Math.max(9, Math.min(12, big * 0.5));
  const showTags = tags.length > 0 && hPx > big + small + 10;
  const ground = tint(colour, BOARD_TINT);
  label(ctx, inst.id, c.x, showTags ? c.y - small * 0.7 : c.y, big, true, 'center', ground);
  if (showTags) {
    // Tags that do not fit the board are dropped from the right.
    ctx.font = `${small}px ${FONT}`;
    let text = tags.join(' · ');
    while (tags.length > 1 && ctx.measureText(text).width > wPx - 8) {
      tags.pop();
      text = tags.join(' · ');
    }
    label(ctx, text, c.x, c.y + big * 0.62, small, false, 'center', ground);
  }

  if (moving) {
    const at = worldToScreen(t, { x: box.minX, y: box.minY });
    label(ctx, `${mm(box.minX)}, ${mm(box.minY)}`, at.x, at.y + 12, 11, false, 'left');
  }
}

/** Draw the plate. `width` and `height` are the canvas size in CSS pixels. */
export function drawPlate(ctx: Ctx, state: PanelState, width: number, height: number): void {
  ctx.setLineDash([]);
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, width, height);
  const view = state.view;
  if (!view) return;

  const { geometry } = view;
  drawLimits(ctx, state, geometry, width, height);
  drawFrame(ctx, state, geometry);

  const worst = worstByInstance(view.issues);
  const stale = new Set(view.sources.filter((s) => s.stale).map((s) => s.key));
  const keys = view.panel.sources.map((s) => s.key);
  // The dragged instance is drawn last, on top of the rest.
  const dragged = state.drag?.id;
  for (const inst of geometry.instances) {
    if (inst.id === dragged) continue;
    drawInstance(ctx, state, inst, worst.get(inst.id), stale.has(inst.source), boardColor(keys, inst.source));
  }
  const top = geometry.instances.find((i) => i.id === dragged);
  if (top) drawInstance(ctx, state, top, worst.get(top.id), stale.has(top.source), boardColor(keys, top.source));
}
