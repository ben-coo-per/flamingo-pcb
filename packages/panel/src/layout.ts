/**
 * Flamingo Panel - auto-layout ("arrange").
 *
 * Packs the unpinned instances into the smallest panel that respects the
 * spacing, the blocked-edge clearances and the size limit; pinned instances
 * stay where they are and the rest is packed around them.
 *
 * The method is deliberately plain. Every instance is a rectangle grown by
 * the clearance each of its sides needs, so that grown rectangles may touch.
 * They are placed largest first at the lowest, then leftmost, free corner of
 * a strip ("bottom-left"), trying the instance as it is and turned by 90
 * degrees. That is repeated for a range of strip widths and the smallest
 * panel that fits the limit wins.
 */

import type { PanelLimits } from './config.js';
import {
  computeFrame,
  computeGeometry,
  effectiveSpacing,
  placeInstances,
  tabCounts,
  type PlacedInstance,
} from './geometry.js';
import type { InstancePlacement } from './ops.js';
import type { ResolvedSources } from './resolved.js';
import type { EdgeInfo } from './source.js';
import { checkPanel, targetLayers, usedLayerCounts } from './check.js';
import { rotateSide, rotatedSize } from './transform.js';
import type { Panel, PanelInstance, Rotation, Side } from './types.js';
import { SIDES } from './types.js';

const EPS = 1e-6;
/** How many strip widths are tried at most. */
const MAX_WIDTHS = 32;

export interface SizeLimit {
  width: number;
  height: number;
  /** What imposes the limit, for messages. */
  label: string;
}

export interface ArrangeOptions {
  /** Try each instance turned by 90 degrees as well (default true). */
  rotate?: boolean;
  /** Override the size limit (default: `sizeLimit(panel, sources, limits)`). */
  limit?: SizeLimit;
}

export interface ArrangeOk {
  ok: true;
  /** New position (and rotation) of every unpinned instance. */
  placements: InstancePlacement[];
  width: number;
  height: number;
  limit: SizeLimit;
  /** Instances left alone because their source could not be resolved. */
  skipped: string[];
}

export interface ArrangeFail {
  ok: false;
  reason: string;
  /** The smallest panel the packer found that holds everything, ignoring the limit. */
  smallestFit?: { width: number; height: number };
  limit: SizeLimit;
  skipped: string[];
}

export type ArrangeResult = ArrangeOk | ArrangeFail;

function fmt(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/**
 * The size limit that binds this panel: the fab's maximum for its layer count,
 * tightened to what assembly accepts when any instance is to be populated.
 * A panel may go to either assembly service, so the roomier one counts.
 */
export function sizeLimit(panel: Panel, sources: ResolvedSources, limits: PanelLimits): SizeLimit {
  const layers = targetLayers(panel, sources) ?? Math.max(2, ...usedLayerCounts(panel, sources));
  const fab = limits.fab.maxSize[String(layers) as '2' | '4' | '6'].value;
  const long = (a: { width: number; height: number }): { width: number; height: number } => ({
    width: Math.max(a.width, a.height),
    height: Math.min(a.width, a.height),
  });
  let best = { ...long(fab), label: `JLCPCB's largest ${layers}-layer board` };
  if (panel.instances.some((i) => i.populate)) {
    const panelized = panel.settings.separation !== 'silk-divider' && panel.instances.length > 1;
    const pick = (type: 'economic' | 'standard'): { width: number; height: number } => {
      const r = (panelized ? limits.assembly[type].panelSize : limits.assembly[type].singleSize).value;
      return long({ width: r.maxWidth, height: r.maxHeight });
    };
    const e = pick('economic');
    const s = pick('standard');
    const roomier = e.width * e.height >= s.width * s.height ? e : s;
    const asm = {
      width: Math.min(roomier.width, best.width),
      height: Math.min(roomier.height, best.height),
    };
    best = { ...asm, label: panelized ? 'the assembly panel limit' : 'the assembly board limit' };
  }
  return best;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Option {
  rotation: Rotation;
  /** Grown size. */
  w: number;
  h: number;
  /** Offset from the grown rectangle's corner to the instance's `at`. */
  dx: number;
  dy: number;
}

interface Item {
  id: string;
  options: Option[];
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;
}

/**
 * How far each side of an instance grows. Grown rectangles may touch, so two
 * growths add up to the gap between two boards:
 *  - a plain edge grows by half the spacing, giving the spacing between two;
 *  - a blocked edge grows by its clearance less the half spacing a plain
 *    neighbour brings, giving exactly its clearance;
 *  - an edge with an overhanging part grows by at least the overhang plus half
 *    the margin, so that two such edges facing each other keep the margin
 *    between the parts, not merely between a part and a board.
 */
function growth(
  edges: Record<Side, EdgeInfo>,
  spacing: number,
  overhangMargin: number,
): Record<Side, number> {
  const g = {} as Record<Side, number>;
  for (const s of SIDES) {
    const e = edges[s];
    const margin = Math.max(spacing, e.clearance);
    g[s] = Math.max(0, margin - spacing / 2, e.overhang > 0 ? e.overhang + overhangMargin / 2 : 0);
  }
  return g;
}

/** A board's edges keyed by the panel side each faces once turned by `rotation`. */
function turnedEdges(edges: Record<Side, EdgeInfo>, rotation: Rotation): Record<Side, EdgeInfo> {
  const out = {} as Record<Side, EdgeInfo>;
  for (const boardSide of SIDES) out[rotateSide(boardSide, rotation)] = edges[boardSide];
  return out;
}

function optionsFor(
  inst: PanelInstance,
  sources: ResolvedSources,
  spacing: number,
  overhangMargin: number,
  rotate: boolean,
): Option[] {
  const g = sources.find((s) => s.key === inst.source)!.geometry!;
  const rotations: Rotation[] = rotate ? [inst.rotation, ((inst.rotation + 90) % 360) as Rotation] : [inst.rotation];
  const out: Option[] = [];
  for (const rotation of rotations) {
    const size = rotatedSize(g.bbox, rotation);
    const grow = growth(turnedEdges(g.edges, rotation), spacing, overhangMargin);
    const o: Option = {
      rotation,
      w: size.width + grow.W + grow.E,
      h: size.height + grow.S + grow.N,
      dx: grow.W,
      dy: grow.S,
    };
    // A square board with even margins packs the same either way round.
    if (!out.some((p) => Math.abs(p.w - o.w) < EPS && Math.abs(p.h - o.h) < EPS && Math.abs(p.dx - o.dx) < EPS && Math.abs(p.dy - o.dy) < EPS)) {
      out.push(o);
    }
  }
  return out;
}

function grownRect(p: PlacedInstance, spacing: number, overhangMargin: number): Rect {
  const g = growth(p.edges, spacing, overhangMargin);
  return {
    x: p.bbox.minX - g.W,
    y: p.bbox.minY - g.S,
    w: p.bbox.maxX - p.bbox.minX + g.W + g.E,
    h: p.bbox.maxY - p.bbox.minY + g.S + g.N,
  };
}

interface Packed {
  id: string;
  rect: Rect;
  option: Option;
}

/** Bottom-left packing of `items` into a strip `width` wide starting at (x0, y0). */
function packStrip(items: Item[], obstacles: Rect[], x0: number, y0: number, width: number): Packed[] | null {
  const placed: Rect[] = [...obstacles];
  const out: Packed[] = [];
  for (const item of items) {
    let best: { rect: Rect; option: Option } | null = null;
    const corners: Array<[number, number]> = [[x0, y0]];
    for (const r of placed) {
      corners.push([r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, y0], [x0, r.y + r.h]);
    }
    for (const option of item.options) {
      for (const [cx, cy] of corners) {
        if (cx < x0 - EPS || cy < y0 - EPS) continue;
        if (cx + option.w > x0 + width + EPS) continue;
        const rect: Rect = { x: cx, y: cy, w: option.w, h: option.h };
        if (placed.some((p) => overlaps(rect, p))) continue;
        if (
          best === null ||
          rect.y < best.rect.y - EPS ||
          (Math.abs(rect.y - best.rect.y) <= EPS && rect.x < best.rect.x - EPS) ||
          (Math.abs(rect.y - best.rect.y) <= EPS && Math.abs(rect.x - best.rect.x) <= EPS && rect.h < best.rect.h - EPS)
        ) {
          best = { rect, option };
        }
      }
    }
    if (best === null) return null;
    placed.push(best.rect);
    out.push({ id: item.id, rect: best.rect, option: best.option });
  }
  return out;
}

function fits(w: number, h: number, limit: SizeLimit): boolean {
  return (w <= limit.width + 1e-3 && h <= limit.height + 1e-3) || (w <= limit.height + 1e-3 && h <= limit.width + 1e-3);
}

interface Candidate {
  placements: InstancePlacement[];
  width: number;
  height: number;
  /** Large enough for an assembly line to take (always true for a bare panel). */
  assemblable: boolean;
  /** The rails run along the long sides, as a conveyor wants them. */
  railsAlongLongSides: boolean;
}

/** Long thin strips are fragile: beyond this aspect ratio area counts for more. */
const MAX_EASY_ASPECT = 3;

function cost(c: Candidate): number {
  const aspect = Math.max(c.width, c.height) / Math.max(1e-6, Math.min(c.width, c.height));
  return c.width * c.height * Math.max(1, aspect / MAX_EASY_ASPECT);
}

/**
 * Order of preference: a panel an assembly line accepts, then rails on the
 * long sides, then the smaller (and less strip-like) panel.
 */
function better(a: Candidate, b: Candidate | null): boolean {
  if (b === null) return true;
  if (a.assemblable !== b.assemblable) return a.assemblable;
  if (a.railsAlongLongSides !== b.railsAlongLongSides) return a.railsAlongLongSides;
  const ca = cost(a);
  const cb = cost(b);
  if (Math.abs(ca - cb) > 1e-3) return ca < cb;
  return Math.max(a.width, a.height) < Math.max(b.width, b.height) - 1e-3;
}

/**
 * Work out where the unpinned instances of `panel` should go. Does not change
 * the panel: apply `placements` with a `placeInstances` op.
 */
export function arrange(
  panel: Panel,
  sources: ResolvedSources,
  limits: PanelLimits,
  opts: ArrangeOptions = {},
): ArrangeResult {
  const limit = opts.limit ?? sizeLimit(panel, sources, limits);
  const spacing = effectiveSpacing(panel.settings);
  const rotate = opts.rotate !== false;
  const { rails } = panel.settings;

  const usable = panel.instances.filter((i) => sources.find((s) => s.key === i.source)?.geometry);
  const skipped = panel.instances.filter((i) => !usable.includes(i)).map((i) => i.id);
  const pinned = usable.filter((i) => i.pinned);
  const free = usable.filter((i) => !i.pinned);

  if (free.length === 0) {
    const placed = placeInstances({ ...panel, instances: usable }, sources).instances;
    const frame = computeFrame(panel.settings, placed);
    return { ok: true, placements: [], width: frame?.width ?? 0, height: frame?.height ?? 0, limit, skipped };
  }

  const pinnedPlaced = placeInstances({ ...panel, instances: pinned }, sources).instances;
  const overhangMargin = limits.blockedEdges.overhangMargin.value;
  const obstacles = pinnedPlaced.map((p) => grownRect(p, spacing, overhangMargin));

  const items: Item[] = free
    .map((inst) => ({ id: inst.id, options: optionsFor(inst, sources, spacing, overhangMargin, rotate) }))
    .sort((a, b) => {
      const size = (it: Item): [number, number] => [
        Math.max(...it.options.map((o) => Math.max(o.w, o.h))),
        Math.max(...it.options.map((o) => o.w * o.h)),
      ];
      const [la, aa] = size(a);
      const [lb, ab] = size(b);
      return lb - la || ab - aa || a.id.localeCompare(b.id, undefined, { numeric: true });
    });

  // The strip starts where a panel anchored at the origin puts its first
  // board, or further out when a pinned board sits beyond that.
  const halfGap = spacing / 2;
  let x0 = rails.left > 0 ? rails.left + halfGap : 0;
  let y0 = rails.bottom > 0 ? rails.bottom + halfGap : 0;
  for (const o of obstacles) {
    x0 = Math.min(x0, o.x);
    y0 = Math.min(y0, o.y);
  }
  const obstacleRight = Math.max(x0, ...obstacles.map((o) => o.x + o.w));

  const narrowest = Math.max(
    obstacleRight - x0,
    ...items.map((it) => Math.min(...it.options.map((o) => o.w))),
  );
  const widest = obstacleRight - x0 + items.reduce((sum, it) => sum + Math.max(...it.options.map((o) => o.w)), 0);

  // Candidate strip widths: every run of 1..n boards of each size, which are
  // the widths at which a row gains a board.
  const widths = new Set<number>([narrowest, widest]);
  for (const it of items) {
    for (const o of it.options) {
      for (let k = 1; k <= items.length; k++) {
        const w = obstacleRight - x0 + k * o.w;
        if (w >= narrowest - EPS && w <= widest + EPS) widths.add(Math.round(w * 1000) / 1000);
        if (k * o.w >= widest) break;
      }
    }
  }
  let sorted = [...widths].sort((a, b) => a - b);
  if (sorted.length > MAX_WIDTHS) {
    const step = (sorted.length - 1) / (MAX_WIDTHS - 1);
    sorted = Array.from({ length: MAX_WIDTHS }, (_, i) => sorted[Math.round(i * step)]!);
  }

  // The smallest panel either assembly service takes.
  const populated = usable.some((i) => i.populate);
  const panelized = panel.settings.separation !== 'silk-divider' && usable.length > 1;
  const minSide = (['economic', 'standard'] as const)
    .map((type) => (panelized ? limits.assembly[type].panelSize : limits.assembly[type].singleSize).value)
    .map((r) => ({ long: Math.max(r.minWidth, r.minHeight), short: Math.min(r.minWidth, r.minHeight) }))
    .reduce((a, b) => (a.long * a.short <= b.long * b.short ? a : b));

  const byId = new Map(panel.instances.map((i) => [i.id, i]));
  let bestFit: Candidate | null = null;
  let bestAny: Candidate | null = null;

  for (const width of sorted) {
    const packed = packStrip(items, obstacles, x0, y0, width);
    if (!packed) continue;
    const placements: InstancePlacement[] = packed.map((p) => ({
      id: p.id,
      at: { x: p.rect.x + p.option.dx, y: p.rect.y + p.option.dy },
      rotation: p.option.rotation,
    }));
    const moved: PanelInstance[] = usable.map((inst) => {
      const pl = placements.find((q) => q.id === inst.id);
      return pl ? { ...inst, at: pl.at, rotation: pl.rotation ?? inst.rotation } : inst;
    });
    const frame = computeFrame(panel.settings, placeInstances({ ...panel, instances: moved }, sources).instances);
    if (!frame) continue;

    // Nothing pinned: slide the whole layout so the panel's corner is the origin.
    if (pinned.length === 0) {
      for (const pl of placements) {
        pl.at = { x: round(pl.at.x - frame.outer.minX), y: round(pl.at.y - frame.outer.minY) };
      }
    } else {
      for (const pl of placements) pl.at = { x: round(pl.at.x), y: round(pl.at.y) };
    }
    const horizontalRails = rails.top > 0 || rails.bottom > 0;
    const verticalRails = rails.left > 0 || rails.right > 0;
    const cand: Candidate = {
      placements,
      width: frame.width,
      height: frame.height,
      assemblable:
        !populated ||
        (Math.max(frame.width, frame.height) >= minSide.long - 1e-3 &&
          Math.min(frame.width, frame.height) >= minSide.short - 1e-3),
      railsAlongLongSides:
        horizontalRails === verticalRails ||
        (horizontalRails ? frame.width >= frame.height - 1e-3 : frame.height >= frame.width - 1e-3),
    };
    if (better(cand, bestAny)) bestAny = cand;
    if (fits(frame.width, frame.height, limit) && better(cand, bestFit)) bestFit = cand;
  }

  if (bestFit) {
    const supported =
      rotate && panel.settings.separation !== 'silk-divider'
        ? improveSupport(panel, usable, sources, limits, bestFit, limit, pinned.length === 0)
        : bestFit;
    // Keep the panel's order of instances in the result.
    const placements = [...supported.placements].sort(
      (a, b) => panel.instances.indexOf(byId.get(a.id)!) - panel.instances.indexOf(byId.get(b.id)!),
    );
    return { ok: true, placements, width: supported.width, height: supported.height, limit, skipped };
  }

  const limitText = `${fmt(limit.width)} x ${fmt(limit.height)} mm (${limit.label})`;
  if (!bestAny) {
    return { ok: false, reason: `Could not place the instances at all within ${limitText}.`, limit, skipped };
  }

  // Name the culprit when one board alone is too big.
  for (const it of items) {
    const inst = byId.get(it.id)!;
    const g = sources.find((s) => s.key === inst.source)!.geometry!;
    const single = computeFrame(
      panel.settings,
      placeInstances({ ...panel, instances: [{ ...inst, at: { x: 0, y: 0 } }] }, sources).instances,
    )!;
    const turned = computeFrame(
      panel.settings,
      placeInstances(
        { ...panel, instances: [{ ...inst, at: { x: 0, y: 0 }, rotation: ((inst.rotation + 90) % 360) as Rotation }] },
        sources,
      ).instances,
    )!;
    if (!fits(single.width, single.height, limit) && !fits(turned.width, turned.height, limit)) {
      return {
        ok: false,
        reason:
          `Board ${inst.source} (${fmt(g.width)} x ${fmt(g.height)} mm) does not fit on its own: with rails and clearance it needs ` +
          `${fmt(single.width)} x ${fmt(single.height)} mm, and the limit is ${limitText}.`,
        smallestFit: { width: round(bestAny.width), height: round(bestAny.height) },
        limit,
        skipped,
      };
    }
  }

  const n = usable.length;
  return {
    ok: false,
    reason:
      `${n} instance${n === 1 ? '' : 's'} do not fit within ${limitText}. ` +
      `The smallest panel that holds them is ${fmt(bestAny.width)} x ${fmt(bestAny.height)} mm` +
      (pinned.length > 0 ? ` with ${pinned.length} pinned instance${pinned.length === 1 ? '' : 's'} left in place.` : '.'),
    smallestFit: { width: round(bestAny.width), height: round(bestAny.height) },
    limit,
    skipped,
  };
}

/**
 * A board whose blocked edge ended up facing a rail or a neighbour may be left
 * hanging by a single tab. Turning it by 180 degrees inside the space it
 * already occupies moves the blocked edge to the other side at no cost in
 * area, so that is tried for every board held by too few tabs, and kept when
 * the board ends up better held and nothing else gets worse.
 */
function improveSupport(
  panel: Panel,
  usable: PanelInstance[],
  sources: ResolvedSources,
  limits: PanelLimits,
  start: Candidate,
  limit: SizeLimit,
  anchorAtOrigin: boolean,
): Candidate {
  const spacing = effectiveSpacing(panel.settings);
  const min = limits.tabs.minPerInstance.value;
  const apply = (placements: InstancePlacement[]): Panel => ({
    ...panel,
    instances: usable.map((inst) => {
      const pl = placements.find((q) => q.id === inst.id);
      return pl ? { ...inst, at: pl.at, rotation: pl.rotation ?? inst.rotation } : inst;
    }),
  });
  const score = (p: Panel): { weak: number; tabs: Map<string, number>; errors: number } => {
    const g = computeGeometry(p, sources);
    const tabs = tabCounts(g);
    return {
      weak: [...tabs.values()].filter((n) => n < min).length,
      tabs,
      errors: checkPanel(p, sources, limits, g).filter((i) => i.severity === 'error').length,
    };
  };

  let placements = start.placements.map((p) => ({ ...p, at: { ...p.at } }));
  let current = score(apply(placements));
  if (current.weak === 0) return start;

  for (const pl of placements) {
    if ((current.tabs.get(pl.id) ?? 0) >= min) continue;
    const inst = usable.find((i) => i.id === pl.id)!;
    const g = sources.find((s) => s.key === inst.source)!.geometry!;
    const rotation = pl.rotation ?? inst.rotation;
    const flipped = ((rotation + 180) % 360) as Rotation;
    const growAt = (r: Rotation): Record<Side, number> =>
      growth(turnedEdges(g.edges, r), spacing, limits.blockedEdges.overhangMargin.value);
    const before = growAt(rotation);
    const after = growAt(flipped);
    const trial = placements.map((q) =>
      q.id === pl.id
        ? { id: q.id, rotation: flipped, at: { x: q.at.x - before.W + after.W, y: q.at.y - before.S + after.S } }
        : q,
    );
    const next = score(apply(trial));
    const held = next.tabs.get(pl.id) ?? 0;
    if (held > (current.tabs.get(pl.id) ?? 0) && next.weak < current.weak && next.errors <= current.errors) {
      placements = trial;
      current = next;
    }
  }
  if (placements.every((p, i) => p.rotation === start.placements[i]!.rotation)) return start;

  const frame = computeFrame(panel.settings, placeInstances(apply(placements), sources).instances);
  if (!frame || !fits(frame.width, frame.height, limit)) return start;
  if (anchorAtOrigin) {
    for (const pl of placements) {
      pl.at = { x: round(pl.at.x - frame.outer.minX), y: round(pl.at.y - frame.outer.minY) };
    }
  } else {
    for (const pl of placements) pl.at = { x: round(pl.at.x), y: round(pl.at.y) };
  }
  return { ...start, placements, width: frame.width, height: frame.height };
}

function round(n: number): number {
  const r = Math.round(n * 1000) / 1000;
  return r === 0 ? 0 : r; // no negative zero in saved files
}
