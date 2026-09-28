/**
 * Flamingo Panel - panel geometry.
 *
 * `computeGeometry` turns a panel plus its resolved sources into everything
 * that has a shape: each instance in panel space, the frame and rails around
 * them, the tabs and mouse-bite holes between them, fiducials, tooling holes,
 * and the profile that gets routed. The canvas, the checks, the SVG render and
 * the fab merge all read this one structure.
 *
 * The frame is derived, never stored: it wraps the instances wherever they
 * are, leaving each side's required clearance plus the rail. Moving a board
 * outward grows the panel.
 */

import polygonClipping from 'polygon-clipping';
import type { Point } from '@flamingo/engine';
import type { ResolvedSources } from './resolved.js';
import type { EdgeInfo } from './source.js';
import {
  applyTransformAll,
  boxCorners,
  boxOf,
  instanceTransform,
  rotateSide,
  type Transform,
} from './transform.js';
import type { Box, Panel, PanelSettings, Side } from './types.js';
import { SIDES } from './types.js';

const EPS = 0.01;
/** Tabs keep this far from the end of the straight stretch they sit on. */
const TAB_CORNER_MARGIN = 1;
/** Tabs and rails overlap what they join by this much so the union is one piece. */
const WELD = 0.01;

export interface PlacedOverhang {
  refdes: string;
  side: Side;
  depth: number;
  polygon: Point[];
}

export interface PlacedInstance {
  id: string;
  source: string;
  populate: boolean;
  pinned: boolean;
  transform: Transform;
  /** Bounding box of the outline, panel mm. */
  bbox: Box;
  /** Outline polygon, panel mm. */
  outline: Point[];
  /** Edge state keyed by the panel side each edge now faces. */
  edges: Record<Side, EdgeInfo>;
  /** Clearance each side needs from whatever faces it: the spacing, or more on a blocked edge. */
  margins: Record<Side, number>;
  overhangs: PlacedOverhang[];
  /** Board-edge keepouts, panel mm. */
  keepouts: Point[][];
}

export interface UnplacedInstance {
  id: string;
  source: string;
  reason: string;
}

export type RailSide = 'top' | 'bottom' | 'left' | 'right';

export interface Rail {
  side: RailSide;
  box: Box;
}

export interface Frame {
  /** Inner edge of the rails (or the content itself on a side without a rail). */
  inner: Box;
  /** The panel outline. */
  outer: Box;
  width: number;
  height: number;
}

export interface Tab {
  /** Instance id, or `rail:<side>`, at each end. `a` is always an instance. */
  a: string;
  b: string;
  /** Panel side of instance `a` the tab leaves from. */
  side: Side;
  /** Tab centre along the edge, and the gap it bridges. */
  center: Point;
  length: number;
  polygon: Point[];
  /** Mouse-bite hole centres (empty for solid tabs). */
  holes: Point[];
}

export interface Fiducial {
  at: Point;
  side: 'top' | 'bottom';
  copperDiameter: number;
  maskDiameter: number;
}

export interface ToolingHole {
  at: Point;
  diameter: number;
}

export interface PanelGeometry {
  instances: PlacedInstance[];
  unplaced: UnplacedInstance[];
  /** null when nothing could be placed. */
  frame: Frame | null;
  rails: Rail[];
  tabs: Tab[];
  fiducials: Fiducial[];
  toolingHoles: ToolingHole[];
  /** Why fiducials or tooling holes that were asked for could not be placed. */
  featureNotes: string[];
  /**
   * Closed contours of the panel's material: what the router cuts along. One
   * outer ring per solid piece, plus a ring for every routed opening.
   */
  profile: Point[][];
  /** Silkscreen divider lines (silk-divider panels only), as polylines. */
  dividers: Point[][];
}

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

/** Spacing that applies between boards: none at all on a silk-divider panel. */
export function effectiveSpacing(settings: PanelSettings): number {
  return settings.separation === 'silk-divider' ? 0 : settings.spacing;
}

export function placeInstances(
  panel: Panel,
  sources: ResolvedSources,
): { instances: PlacedInstance[]; unplaced: UnplacedInstance[] } {
  const spacing = effectiveSpacing(panel.settings);
  const instances: PlacedInstance[] = [];
  const unplaced: UnplacedInstance[] = [];

  for (const inst of panel.instances) {
    const src = sources.find((s) => s.key === inst.source);
    if (!src || !src.geometry) {
      unplaced.push({
        id: inst.id,
        source: inst.source,
        reason: src?.error ?? `source "${inst.source}" is not resolved`,
      });
      continue;
    }
    const g = src.geometry;
    const transform = instanceTransform(g.bbox, inst.at, inst.rotation);
    const outline = applyTransformAll(transform, g.outline);

    const edges = {} as Record<Side, EdgeInfo>;
    const margins = {} as Record<Side, number>;
    for (const boardSide of SIDES) {
      const panelSide = rotateSide(boardSide, inst.rotation);
      const e = g.edges[boardSide];
      edges[panelSide] = e;
      margins[panelSide] = Math.max(spacing, e.clearance);
    }

    instances.push({
      id: inst.id,
      source: inst.source,
      populate: inst.populate,
      pinned: inst.pinned,
      transform,
      bbox: boxOf(outline),
      outline,
      edges,
      margins,
      overhangs: g.overhangs.map((o) => ({
        refdes: o.refdes,
        side: rotateSide(o.side, inst.rotation),
        depth: o.depth,
        polygon: applyTransformAll(transform, o.polygon),
      })),
      keepouts: g.edgeKeepouts.map((k) => applyTransformAll(transform, k.polygon)),
    });
  }
  return { instances, unplaced };
}

// ---------------------------------------------------------------------------
// Frame and rails
// ---------------------------------------------------------------------------

/**
 * The frame that wraps `instances`. A side with a rail stands off from the
 * boards by each board's margin on that side; a side without one runs along
 * the outermost board edge.
 */
export function computeFrame(settings: PanelSettings, instances: PlacedInstance[]): Frame | null {
  if (instances.length === 0) return null;
  const { rails } = settings;
  const ext = (side: Side, hasRail: boolean): number => {
    let v = side === 'N' || side === 'E' ? -Infinity : Infinity;
    for (const i of instances) {
      const m = hasRail ? i.margins[side] : 0;
      if (side === 'N') v = Math.max(v, i.bbox.maxY + m);
      else if (side === 'E') v = Math.max(v, i.bbox.maxX + m);
      else if (side === 'S') v = Math.min(v, i.bbox.minY - m);
      else v = Math.min(v, i.bbox.minX - m);
    }
    return v;
  };
  const inner: Box = {
    minX: ext('W', rails.left > 0),
    maxX: ext('E', rails.right > 0),
    minY: ext('S', rails.bottom > 0),
    maxY: ext('N', rails.top > 0),
  };
  const outer: Box = {
    minX: inner.minX - rails.left,
    maxX: inner.maxX + rails.right,
    minY: inner.minY - rails.bottom,
    maxY: inner.maxY + rails.top,
  };
  return { inner, outer, width: outer.maxX - outer.minX, height: outer.maxY - outer.minY };
}

function computeRails(settings: PanelSettings, frame: Frame): Rail[] {
  const { rails } = settings;
  const { inner, outer } = frame;
  const out: Rail[] = [];
  // Top and bottom rails run the full width; side rails fit between them.
  if (rails.bottom > 0) out.push({ side: 'bottom', box: { minX: outer.minX, maxX: outer.maxX, minY: outer.minY, maxY: inner.minY } });
  if (rails.top > 0) out.push({ side: 'top', box: { minX: outer.minX, maxX: outer.maxX, minY: inner.maxY, maxY: outer.maxY } });
  if (rails.left > 0) out.push({ side: 'left', box: { minX: outer.minX, maxX: inner.minX, minY: inner.minY, maxY: inner.maxY } });
  if (rails.right > 0) out.push({ side: 'right', box: { minX: inner.maxX, maxX: outer.maxX, minY: inner.minY, maxY: inner.maxY } });
  return out;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

type Interval = [number, number];

/** Stretches of `outline` that run along `side` of its bounding box, as intervals on the other axis. */
export function edgeSpans(outline: Point[], bbox: Box, side: Side): Interval[] {
  const horizontal = side === 'N' || side === 'S';
  const level = side === 'N' ? bbox.maxY : side === 'S' ? bbox.minY : side === 'E' ? bbox.maxX : bbox.minX;
  const spans: Interval[] = [];
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!;
    const b = outline[(i + 1) % outline.length]!;
    const [a0, b0] = horizontal ? [a.y, b.y] : [a.x, b.x];
    if (Math.abs(a0 - level) > EPS || Math.abs(b0 - level) > EPS) continue;
    const [a1, b1] = horizontal ? [a.x, b.x] : [a.y, b.y];
    if (Math.abs(a1 - b1) < EPS) continue;
    spans.push([Math.min(a1, b1), Math.max(a1, b1)]);
  }
  return mergeIntervals(spans);
}

function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = [...list].sort((p, q) => p[0] - q[0]);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1] + EPS) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

function intersectIntervals(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const p of a) {
    for (const q of b) {
      const lo = Math.max(p[0], q[0]);
      const hi = Math.min(p[1], q[1]);
      if (hi - lo > EPS) out.push([lo, hi]);
    }
  }
  return out;
}

function subtractIntervals(a: Interval[], b: Interval[]): Interval[] {
  let cur = a;
  for (const q of b) {
    const next: Interval[] = [];
    for (const p of cur) {
      if (q[1] <= p[0] + EPS || q[0] >= p[1] - EPS) {
        next.push(p);
        continue;
      }
      if (q[0] - p[0] > EPS) next.push([p[0], q[0]]);
      if (p[1] - q[1] > EPS) next.push([q[1], p[1]]);
    }
    cur = next;
  }
  return cur;
}

/** Where tabs go along a free stretch of length `hi - lo`. */
export function tabCentres(lo: number, hi: number, width: number, pitch: number): number[] {
  const len = hi - lo;
  if (len < width - EPS) return [];
  const usable = len - 2 * TAB_CORNER_MARGIN;
  if (usable < width) return [(lo + hi) / 2];
  let n = Math.max(1, Math.ceil(len / pitch));
  // One tab in the middle of an edge lets the board rock: give it two as soon
  // as two fit with room between them.
  if (n === 1 && len >= 3 * width) n = 2;
  while (n > 1 && usable / n < width) n--;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(lo + (len * (i + 0.5)) / n);
  return out;
}

interface Facing {
  /** Instance id or `rail:<side>`. */
  id: string;
  gap: number;
  spans: Interval[];
  /** The facing solid is a board, so its end of the tab gets holes too. */
  board: boolean;
}

const RAIL_FOR: Record<Side, RailSide> = { N: 'top', S: 'bottom', E: 'right', W: 'left' };
const OPPOSITE: Record<Side, Side> = { N: 'S', S: 'N', E: 'W', W: 'E' };

function sideLevel(bbox: Box, side: Side): number {
  return side === 'N' ? bbox.maxY : side === 'S' ? bbox.minY : side === 'E' ? bbox.maxX : bbox.minX;
}

function computeTabs(settings: PanelSettings, instances: PlacedInstance[], rails: Rail[]): Tab[] {
  if (settings.separation === 'silk-divider') return [];
  const { tabs: ts } = settings;
  const withHoles = settings.separation === 'mouse-bite';
  const out: Tab[] = [];

  for (const a of instances) {
    for (const side of SIDES) {
      if (a.edges[side].blocked) continue;
      const horizontal = side === 'N' || side === 'S';
      const outward = side === 'N' || side === 'E' ? 1 : -1;
      const level = sideLevel(a.bbox, side);
      const spans = edgeSpans(a.outline, a.bbox, side);
      if (spans.length === 0) continue;

      const facing: Facing[] = [];
      for (const b of instances) {
        if (b === a) continue;
        const gap = (sideLevel(b.bbox, OPPOSITE[side]) - level) * outward;
        if (gap < -EPS || gap > ts.maxLength + EPS) continue;
        if (b.edges[OPPOSITE[side]].blocked) {
          // Still an obstacle: nothing farther away may be tabbed through it.
          facing.push({ id: b.id, gap, spans: [horizontal ? [b.bbox.minX, b.bbox.maxX] : [b.bbox.minY, b.bbox.maxY]], board: false });
          continue;
        }
        facing.push({ id: b.id, gap, spans: edgeSpans(b.outline, b.bbox, OPPOSITE[side]), board: true });
      }
      const rail = rails.find((r) => r.side === RAIL_FOR[side]);
      if (rail) {
        const railLevel = sideLevel(rail.box, OPPOSITE[side]);
        const gap = (railLevel - level) * outward;
        if (gap >= -EPS && gap <= ts.maxLength + EPS) {
          facing.push({
            id: `rail:${rail.side}`,
            gap,
            spans: [horizontal ? [rail.box.minX, rail.box.maxX] : [rail.box.minY, rail.box.maxY]],
            board: false,
          });
        }
      }
      facing.sort((p, q) => p.gap - q.gap);

      // Nearest first; what a nearer solid covers is hidden from farther ones.
      let free = spans;
      for (const f of facing) {
        const shared = intersectIntervals(free, f.spans);
        free = subtractIntervals(free, f.spans);
        const other = instances.find((i) => i.id === f.id);
        if (other && other.edges[OPPOSITE[side]].blocked) continue;
        // Each pair of boards is tabbed once, from the side that faces N or E.
        if (f.board && (side === 'S' || side === 'W')) continue;
        if (f.gap < EPS) continue; // touching: nothing to bridge
        for (const [lo, hi] of shared) {
          for (const c of tabCentres(lo, hi, ts.width, ts.pitch)) {
            const near = level - outward * WELD;
            const far = level + outward * (f.gap + WELD);
            const box: Box = horizontal
              ? { minX: c - ts.width / 2, maxX: c + ts.width / 2, minY: Math.min(near, far), maxY: Math.max(near, far) }
              : { minY: c - ts.width / 2, maxY: c + ts.width / 2, minX: Math.min(near, far), maxX: Math.max(near, far) };
            const holes: Point[] = [];
            if (withHoles) {
              const d = ts.holeDiameter;
              const n = Math.max(1, Math.floor((ts.width - d) / ts.holePitch + 1e-9) + 1);
              const off = d * (0.5 - ts.holeOverlap);
              const rows = [level + outward * off];
              if (f.board) rows.push(level + outward * (f.gap - off));
              for (const row of rows) {
                for (let j = 0; j < n; j++) {
                  const along = c + (j - (n - 1) / 2) * ts.holePitch;
                  holes.push(horizontal ? { x: along, y: row } : { x: row, y: along });
                }
              }
            }
            out.push({
              a: a.id,
              b: f.id,
              side,
              center: horizontal ? { x: c, y: level + (outward * f.gap) / 2 } : { x: level + (outward * f.gap) / 2, y: c },
              length: f.gap,
              polygon: boxCorners(box),
              holes,
            });
          }
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fiducials and tooling holes
// ---------------------------------------------------------------------------

function computeRailFeatures(
  settings: PanelSettings,
  frame: Frame,
  rails: Rail[],
  needBottomFiducials: boolean,
): { fiducials: Fiducial[]; toolingHoles: ToolingHole[]; notes: string[] } {
  const fiducials: Fiducial[] = [];
  const toolingHoles: ToolingHole[] = [];
  const notes: string[] = [];
  const { fiducials: fs, toolingHoles: th } = settings;
  if (!fs.enabled && !th.enabled) return { fiducials, toolingHoles, notes };

  const bottom = rails.find((r) => r.side === 'bottom');
  const top = rails.find((r) => r.side === 'top');
  const left = rails.find((r) => r.side === 'left');
  const right = rails.find((r) => r.side === 'right');
  const { outer } = frame;

  // A pair of opposite rails carries the features; horizontal rails win.
  type Slot = { rail: Rail; width: number; place: (along: number, fromEdge: number) => Point; length: number };
  const slots: Slot[] = [];
  const horiz = (rail: Rail, isTop: boolean): Slot => ({
    rail,
    width: rail.box.maxY - rail.box.minY,
    length: outer.maxX - outer.minX,
    place: (along, fromEdge) => ({
      x: outer.minX + along,
      y: isTop ? outer.maxY - fromEdge : outer.minY + fromEdge,
    }),
  });
  const vert = (rail: Rail, isRight: boolean): Slot => ({
    rail,
    width: rail.box.maxX - rail.box.minX,
    length: outer.maxY - outer.minY,
    place: (along, fromEdge) => ({
      x: isRight ? outer.maxX - fromEdge : outer.minX + fromEdge,
      y: outer.minY + along,
    }),
  });
  if (bottom || top) {
    if (bottom) slots.push(horiz(bottom, false));
    if (top) slots.push(horiz(top, true));
  } else {
    if (left) slots.push(vert(left, false));
    if (right) slots.push(vert(right, true));
  }

  if (slots.length === 0) {
    if (fs.enabled) notes.push('no rails: fiducials were not placed');
    if (th.enabled) notes.push('no rails: tooling holes were not placed');
    return { fiducials, toolingHoles, notes };
  }

  if (th.enabled) {
    for (const s of slots) {
      if (s.width < th.diameter + 1) {
        notes.push(`${s.rail.side} rail (${s.width} mm) is too narrow for ${th.diameter} mm tooling holes`);
        continue;
      }
      const ends = s.length >= 2 * th.cornerOffset + 2 * th.diameter ? [th.cornerOffset, s.length - th.cornerOffset] : [s.length / 2];
      for (const along of ends) toolingHoles.push({ at: s.place(along, s.width / 2), diameter: th.diameter });
    }
  }

  if (fs.enabled) {
    const sides: Array<'top' | 'bottom'> = needBottomFiducials ? ['top', 'bottom'] : ['top'];
    // Three marks, not four: the missing corner makes the pattern unambiguous.
    const spots: Array<{ slot: Slot; along: number }> = [];
    slots.forEach((s, i) => {
      if (s.width < fs.edgeDistance + fs.maskDiameter / 2) {
        notes.push(
          `${s.rail.side} rail (${s.width} mm) is too narrow for fiducials ${fs.edgeDistance} mm from the edge`,
        );
        return;
      }
      const room = s.length >= 2 * fs.cornerOffset + 2 * fs.maskDiameter;
      if (!room) {
        spots.push({ slot: s, along: s.length / 2 });
        return;
      }
      spots.push({ slot: s, along: fs.cornerOffset });
      if (i === 0) spots.push({ slot: s, along: s.length - fs.cornerOffset });
    });
    for (const { slot, along } of spots) {
      const at = slot.place(along, fs.edgeDistance);
      // Never on top of a tooling hole.
      const clash = toolingHoles.some((h) => Math.hypot(h.at.x - at.x, h.at.y - at.y) < h.diameter / 2 + fs.maskDiameter / 2 + 0.5);
      if (clash) {
        notes.push(`fiducial at (${at.x.toFixed(2)}, ${at.y.toFixed(2)}) would collide with a tooling hole and was left out`);
        continue;
      }
      for (const side of sides) {
        fiducials.push({ at, side, copperDiameter: fs.copperDiameter, maskDiameter: fs.maskDiameter });
      }
    }
    const marks = new Set(fiducials.map((f) => `${f.at.x},${f.at.y}`)).size;
    if (marks > 0 && marks < 3) notes.push(`only ${marks} fiducial position(s) fit; assembly wants 3`);
  }

  return { fiducials, toolingHoles, notes };
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

type Ring = [number, number][];

function toRing(pts: Point[]): Ring {
  return pts.map((p): [number, number] => [p.x, p.y]);
}

function fromRing(ring: Ring): Point[] {
  const pts = ring.map(([x, y]): Point => ({ x, y }));
  const n = pts.length;
  if (n > 1 && pts[0]!.x === pts[n - 1]!.x && pts[0]!.y === pts[n - 1]!.y) pts.pop();
  return pts;
}

function expandBox(b: Box, by: number): Box {
  return { minX: b.minX - by, minY: b.minY - by, maxX: b.maxX + by, maxY: b.maxY + by };
}

function computeProfile(
  settings: PanelSettings,
  frame: Frame,
  instances: PlacedInstance[],
  rails: Rail[],
  tabs: Tab[],
): Point[][] {
  if (settings.separation === 'silk-divider') return [boxCorners(frame.outer)];
  const polys: Ring[][] = [];
  for (const i of instances) polys.push([toRing(i.outline)]);
  for (const t of tabs) polys.push([toRing(t.polygon)]);
  // Rails overlap each other at the corners by WELD so the frame is one ring.
  for (const r of rails) {
    const grown = expandBox(r.box, WELD);
    const clipped: Box = {
      minX: Math.max(grown.minX, frame.outer.minX),
      minY: Math.max(grown.minY, frame.outer.minY),
      maxX: Math.min(grown.maxX, frame.outer.maxX),
      maxY: Math.min(grown.maxY, frame.outer.maxY),
    };
    polys.push([toRing(boxCorners(clipped))]);
  }
  if (polys.length === 0) return [];
  const [first, ...rest] = polys;
  const merged = polygonClipping.union(first!, ...rest);
  const rings: Point[][] = [];
  for (const poly of merged) for (const ring of poly) rings.push(fromRing(ring));
  return rings;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function computeGeometry(panel: Panel, sources: ResolvedSources): PanelGeometry {
  const { instances, unplaced } = placeInstances(panel, sources);
  const frame = computeFrame(panel.settings, instances);
  if (!frame) {
    return {
      instances,
      unplaced,
      frame: null,
      rails: [],
      tabs: [],
      fiducials: [],
      toolingHoles: [],
      featureNotes: [],
      profile: [],
      dividers: [],
    };
  }
  const rails = computeRails(panel.settings, frame);
  const tabs = computeTabs(panel.settings, instances, rails);
  const needBottom = instances.some((i) => {
    if (!i.populate) return false;
    return sources.find((s) => s.key === i.source)?.geometry?.hasBottomParts === true;
  });
  const features = computeRailFeatures(panel.settings, frame, rails, needBottom);
  const dividers: Point[][] = [];
  if (panel.settings.separation === 'silk-divider') {
    for (const i of instances) dividers.push([...i.outline, i.outline[0]!]);
    for (const r of rails) {
      const c = boxCorners(r.box);
      dividers.push([...c, c[0]!]);
    }
  }
  return {
    instances,
    unplaced,
    frame,
    rails,
    tabs,
    fiducials: features.fiducials,
    toolingHoles: features.toolingHoles,
    featureNotes: features.notes,
    profile: computeProfile(panel.settings, frame, instances, rails, tabs),
    dividers,
  };
}

/** Number of tabs attached to each instance. */
export function tabCounts(geometry: PanelGeometry): Map<string, number> {
  const counts = new Map<string, number>();
  for (const i of geometry.instances) counts.set(i.id, 0);
  for (const t of geometry.tabs) {
    counts.set(t.a, (counts.get(t.a) ?? 0) + 1);
    if (counts.has(t.b)) counts.set(t.b, (counts.get(t.b) ?? 0) + 1);
  }
  return counts;
}
