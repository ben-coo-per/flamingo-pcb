/**
 * Flamingo Panel - SVG render (Node only: text is stroked with fab's vector
 * font, so the picture never depends on installed fonts).
 *
 * Monochrome on purpose, like the panel view in the browser: state is carried
 * by line weight, dashes, hatching and labels, never by colour.
 *
 *   panel outline      heavy solid line
 *   rails              light diagonal hatch
 *   size limits        long-dash rectangles, labelled
 *   populated board    solid outline, label `S1`
 *   bare board         dashed outline, sparse hatch, label `S1 BARE`
 *   pinned             label suffix `PIN`, filled square in the corner
 *   stale source       label suffix `STALE`
 *   blocked edge       heavy line with a comb of ticks pointing outward
 *   overhanging part   thin dashed polygon
 *   board-edge keepout cross hatch
 *   tab                filled bar; mouse-bite holes as small open circles
 *   error / warning    second outline just outside the board, label `ERR` / `WARN`
 */

import type { Point } from '@flamingo/engine';
import { strokeText } from '@flamingo/fab';
import type { PanelIssue } from '../check.js';
import type { PanelGeometry, PlacedInstance } from '../geometry.js';
import type { ResolvedSources } from '../resolved.js';
import { boxCorners } from '../transform.js';
import type { Box, Panel, Side } from '../types.js';
import { SIDES } from '../types.js';

export interface PanelRenderLimit {
  width: number;
  height: number;
  label: string;
}

export interface PanelRenderOpts {
  widthPx?: number;
  /** Size limits to draw, anchored at the panel's bottom-left corner. */
  limits?: PanelRenderLimit[];
  issues?: PanelIssue[];
  /** Draw instance labels (default true). */
  labels?: boolean;
}

const INK = '#000';
const PAPER = '#fff';
const MARGIN_MM = 6;
const DEFAULT_WIDTH_PX = 1200;

function f(n: number): string {
  const r = n.toFixed(3);
  return r === '-0.000' ? '0.000' : r;
}

export function renderPanelSVG(
  panel: Panel,
  sources: ResolvedSources,
  geometry: PanelGeometry,
  opts: PanelRenderOpts = {},
): string {
  const frame = geometry.frame;
  const content: Box = frame
    ? { ...frame.outer }
    : { minX: 0, minY: 0, maxX: 100, maxY: 60 };
  // Show the limits when they are near the panel; a 670 mm fab limit around a
  // 60 mm panel would shrink the panel to a dot, so far-away limits are
  // clipped by the view and named in the corner instead.
  const view: Box = { ...content };
  for (const i of geometry.instances) {
    for (const o of i.overhangs) {
      for (const p of o.polygon) {
        view.minX = Math.min(view.minX, p.x);
        view.minY = Math.min(view.minY, p.y);
        view.maxX = Math.max(view.maxX, p.x);
        view.maxY = Math.max(view.maxY, p.y);
      }
    }
  }
  const limits = opts.limits ?? [];
  const spanX = view.maxX - view.minX;
  const spanY = view.maxY - view.minY;
  for (const l of limits) {
    const lx = content.minX + l.width;
    const ly = content.minY + l.height;
    if (lx <= view.minX + spanX * 2.2) view.maxX = Math.max(view.maxX, lx);
    if (ly <= view.minY + spanY * 2.2) view.maxY = Math.max(view.maxY, ly);
  }

  const minX = view.minX - MARGIN_MM;
  const minY = view.minY - MARGIN_MM;
  const w = view.maxX - view.minX + 2 * MARGIN_MM;
  const h = view.maxY - view.minY + 2 * MARGIN_MM;
  const widthPx = opts.widthPx ?? DEFAULT_WIDTH_PX;
  const heightPx = Math.max(1, Math.round((widthPx * h) / w));

  // Board space is y-up, SVG is y-down: flip each point.
  const X = (x: number): string => f(x - minX);
  const Y = (y: number): string => f(minY + h - y);
  const pt = (p: Point): string => `${X(p.x)},${Y(p.y)}`;
  const path = (pts: Point[], close: boolean): string =>
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${pt(p)}`).join(' ') + (close ? ' Z' : '');

  const out: string[] = [];
  const line = (a: Point, b: Point, width: number, dash?: string): void => {
    out.push(
      `<line x1="${X(a.x)}" y1="${Y(a.y)}" x2="${X(b.x)}" y2="${Y(b.y)}" stroke="${INK}" stroke-width="${f(width)}"${dash ? ` stroke-dasharray="${dash}"` : ''} stroke-linecap="butt"/>`,
    );
  };
  const poly = (pts: Point[], width: number, o: { dash?: string; fill?: string; close?: boolean } = {}): void => {
    out.push(
      `<path d="${path(pts, o.close !== false)}" fill="${o.fill ?? 'none'}" stroke="${INK}" stroke-width="${f(width)}"${o.dash ? ` stroke-dasharray="${o.dash}"` : ''} stroke-linejoin="miter"/>`,
    );
  };
  const text = (s: string, at: Point, height: number, weight = 0.12): void => {
    for (const stroke of strokeText(s, at, height, 0, false)) {
      if (stroke.length < 2) continue;
      out.push(
        `<path d="${path(stroke, false)}" fill="none" stroke="${INK}" stroke-width="${f(height * weight)}" stroke-linecap="round" stroke-linejoin="round"/>`,
      );
    }
  };
  /** Parallel hatch lines across `box`, clipped to `clipId`. */
  const hatch = (box: Box, pitch: number, width: number, clipId: string, cross = false): void => {
    const span = box.maxX - box.minX + (box.maxY - box.minY);
    const lines: string[] = [];
    for (let d = -span; d <= span; d += pitch) {
      const a = { x: box.minX + d, y: box.minY };
      const b = { x: box.minX + d + (box.maxY - box.minY), y: box.maxY };
      lines.push(`<line x1="${X(a.x)}" y1="${Y(a.y)}" x2="${X(b.x)}" y2="${Y(b.y)}"/>`);
      if (cross) {
        const c = { x: box.maxX - d, y: box.minY };
        const e = { x: box.maxX - d - (box.maxY - box.minY), y: box.maxY };
        lines.push(`<line x1="${X(c.x)}" y1="${Y(c.y)}" x2="${X(e.x)}" y2="${Y(e.y)}"/>`);
      }
    }
    out.push(
      `<g clip-path="url(#${clipId})" stroke="${INK}" stroke-width="${f(width)}">${lines.join('')}</g>`,
    );
  };
  const defs: string[] = [];
  let clipN = 0;
  const clip = (pts: Point[]): string => {
    const id = `c${clipN++}`;
    defs.push(`<clipPath id="${id}"><path d="${path(pts, true)}"/></clipPath>`);
    return id;
  };

  // --- size limits ---------------------------------------------------------
  limits.forEach((l, i) => {
    const box: Box = {
      minX: content.minX,
      minY: content.minY,
      maxX: content.minX + l.width,
      maxY: content.minY + l.height,
    };
    poly(boxCorners(box), 0.2, { dash: '4 2' });
    const lx = Math.min(box.maxX, view.maxX);
    const ly = Math.min(box.maxY, view.maxY);
    const label = `${l.label} ${l.width} X ${l.height}`.toUpperCase();
    // Inside the top-right corner of the limit if that corner is in view,
    // else along the top of the view.
    text(label, { x: lx - label.length * 0.9 * 0.8 - 1, y: ly + 1.6 + i * 2.6 }, 1.6);
  });

  if (frame) {
    // --- rails -------------------------------------------------------------
    for (const r of geometry.rails) {
      hatch(r.box, 1.5, 0.08, clip(boxCorners(r.box)));
      poly(boxCorners(r.box), 0.12);
    }

    // --- tabs --------------------------------------------------------------
    for (const t of geometry.tabs) poly(t.polygon, 0.1, { fill: INK });
    for (const t of geometry.tabs) {
      for (const hole of t.holes) {
        out.push(
          `<circle cx="${X(hole.x)}" cy="${Y(hole.y)}" r="${f(panel.settings.tabs.holeDiameter / 2)}" fill="${PAPER}" stroke="${INK}" stroke-width="0.06"/>`,
        );
      }
    }

    // --- panel outline -----------------------------------------------------
    poly(boxCorners(frame.outer), 0.5);

    // --- rail features -----------------------------------------------------
    for (const hole of geometry.toolingHoles) {
      out.push(
        `<circle cx="${X(hole.at.x)}" cy="${Y(hole.at.y)}" r="${f(hole.diameter / 2)}" fill="${PAPER}" stroke="${INK}" stroke-width="0.2"/>`,
      );
    }
    const seen = new Set<string>();
    for (const fid of geometry.fiducials) {
      const key = `${fid.at.x},${fid.at.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(
        `<circle cx="${X(fid.at.x)}" cy="${Y(fid.at.y)}" r="${f(fid.maskDiameter / 2)}" fill="${PAPER}" stroke="${INK}" stroke-width="0.1"/>`,
        `<circle cx="${X(fid.at.x)}" cy="${Y(fid.at.y)}" r="${f(fid.copperDiameter / 2)}" fill="${INK}"/>`,
      );
    }
  }

  // --- silkscreen dividers -------------------------------------------------
  for (const d of geometry.dividers) poly(d, 0.15, { dash: '1 1', close: false });

  // --- instances -----------------------------------------------------------
  const issues = opts.issues ?? [];
  const worst = new Map<string, 'error' | 'warning'>();
  for (const issue of issues) {
    if (issue.severity === 'info') continue;
    for (const id of issue.instances) {
      if (worst.get(id) !== 'error') worst.set(id, issue.severity);
    }
  }

  for (const inst of geometry.instances) {
    drawInstance(inst);
  }

  function drawInstance(inst: PlacedInstance): void {
    const src = sources.find((s) => s.key === inst.source);
    const b = inst.bbox;

    for (const k of inst.keepouts) {
      hatch(bboxOf(k), 1.2, 0.06, clip(k), true);
      poly(k, 0.08, { dash: '0.6 0.6' });
    }
    if (!inst.populate) hatch(b, 3, 0.08, clip(inst.outline));
    poly(inst.outline, 0.3, inst.populate ? {} : { dash: '2 1' });

    for (const o of inst.overhangs) poly(o.polygon, 0.1, { dash: '0.8 0.5' });

    for (const side of SIDES) {
      if (!inst.edges[side].blocked) continue;
      const [a, c] = edgeEnds(b, side);
      line(a, c, 0.7);
      const n = normal(side);
      const len = Math.hypot(c.x - a.x, c.y - a.y);
      const count = Math.max(2, Math.floor(len / 2));
      for (let i = 0; i <= count; i++) {
        const p = { x: a.x + ((c.x - a.x) * i) / count, y: a.y + ((c.y - a.y) * i) / count };
        line(p, { x: p.x + n.x * 1.2, y: p.y + n.y * 1.2 }, 0.15);
      }
    }

    const level = worst.get(inst.id);
    if (level) {
      const g = level === 'error' ? 1.0 : 0.7;
      poly(
        boxCorners({ minX: b.minX - g, minY: b.minY - g, maxX: b.maxX + g, maxY: b.maxY + g }),
        level === 'error' ? 0.35 : 0.2,
        level === 'error' ? {} : { dash: '1.5 1' },
      );
    }

    if (inst.pinned) {
      poly(
        boxCorners({ minX: b.minX + 0.8, minY: b.maxY - 2.3, maxX: b.minX + 2.3, maxY: b.maxY - 0.8 }),
        0.1,
        { fill: INK },
      );
    }

    if (opts.labels !== false) {
      const tags = [inst.id];
      if (!inst.populate) tags.push('BARE');
      if (inst.pinned) tags.push('PIN');
      if (src?.stale) tags.push('STALE');
      if (level) tags.push(level === 'error' ? 'ERR' : 'WARN');
      const w0 = b.maxX - b.minX;
      const h0 = b.maxY - b.minY;
      const label = tags.join(' ');
      const height = Math.max(1.2, Math.min(4, h0 / 4, (w0 * 0.9) / (label.length * 0.9)));
      text(label, { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, height, 0.14);
    }
  }

  // --- caption -------------------------------------------------------------
  if (frame) {
    const caption = `${panel.name}  ${frame.width.toFixed(1)} X ${frame.height.toFixed(1)} MM  ${geometry.instances.length} BOARDS`;
    text(caption, { x: view.minX + (caption.length * 0.9 * 1.8) / 2, y: view.minY - 3.4 }, 1.8);
  } else {
    text('EMPTY PANEL', { x: (view.minX + view.maxX) / 2, y: (view.minY + view.maxY) / 2 }, 4);
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}" viewBox="0 0 ${f(w)} ${f(h)}">`,
    `<rect x="0" y="0" width="${f(w)}" height="${f(h)}" fill="${PAPER}"/>`,
    defs.length > 0 ? `<defs>${defs.join('')}</defs>` : '',
    ...out,
    '</svg>',
  ]
    .filter((s) => s !== '')
    .join('\n');
}

function bboxOf(pts: Point[]): Box {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
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

function normal(side: Side): Point {
  switch (side) {
    case 'N':
      return { x: 0, y: 1 };
    case 'S':
      return { x: 0, y: -1 };
    case 'E':
      return { x: 1, y: 0 };
    case 'W':
      return { x: -1, y: 0 };
  }
}
