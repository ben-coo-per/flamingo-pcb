/**
 * Flamingo Engine - Connectivity + Ratsnest
 * Units: mm
 *
 * Per-net connectivity model: nodes are the net's pins (pad world anchors)
 * plus the net's tracks and vias, which act as glue but are never returned
 * as group members. Two nodes are unioned when their copper touches on a
 * shared layer: anchors within EPSILON_MM, a track end or via anywhere on a
 * pad's outline, a track end inside a via's disk, or a track end / via on
 * another track's body (T-junction). `connectedGroups` collapses this to
 * groups of pin refs only.
 *
 * Zones: a same-net zone WITH a computed fill acts as glue — every node whose
 * anchor point lies inside the same fill island (outer minus its holes) on the
 * zone's layer is unioned through it, matching the physical copper.
 * Unfilled zones contribute nothing, so consumers of the live (never-filled)
 * board — ratsnest, autoroute — are unaffected; only filled-board consumers
 * (the DRC unconnected-net check inside export/api-drc, screenshots) get the
 * pour credit.
 */

import type { Board, Net, Point, Track, LayerId } from './types.js';
import { padWorld, padOutline, dist, bboxOf, groupFillRings, pointInGroup, pointInPolygon, pointSegDistance, polyGroupOverlapArea } from './geometry.js';
import { copperLayersOf, padCopperLayers } from './layers.js';
import { RULESETS } from './drc/rules.js';

const EPSILON_MM = 0.01;

export interface RatLine {
  net: string;
  from: Point;
  to: Point;
}

/** World-space center of a pad, given a "REFDES.PADNUMBER" pin ref. */
export function padAnchor(b: Board, pinRef: string): Point {
  const dot = pinRef.indexOf('.');
  if (dot === -1) {
    throw new Error(`padAnchor: invalid pin ref "${pinRef}" (expected REFDES.PADNUMBER)`);
  }
  const refdes = pinRef.slice(0, dot);
  const padNumber = pinRef.slice(dot + 1);
  const comp = b.components.find((c) => c.refdes === refdes);
  if (!comp) throw new Error(`padAnchor: unknown refdes "${refdes}" (in pin "${pinRef}")`);
  const pad = comp.footprint.pads.find((p) => p.number === padNumber);
  if (!pad) {
    throw new Error(`padAnchor: pad "${padNumber}" not found on "${refdes}" (in pin "${pinRef}")`);
  }
  return padWorld(comp, pad).at;
}

/**
 * Line-track endpoints coincident with `p` on `layer`, within EPSILON_MM.
 * Arc segments are excluded (Phase 1 rubber-band reshapes lines only).
 * Optionally filtered to one net.
 */
export function tracksAtPoint(
  b: Board,
  p: Point,
  layer: LayerId,
  net?: string,
): { trackId: string; end: 'start' | 'end' }[] {
  const out: { trackId: string; end: 'start' | 'end' }[] = [];
  for (const t of b.tracks) {
    if (t.layer !== layer) continue;
    if (net !== undefined && t.net !== net) continue;
    if (t.seg.type !== 'line') continue;
    if (dist(t.seg.start, p) <= EPSILON_MM) out.push({ trackId: t.id, end: 'start' });
    else if (dist(t.seg.end, p) <= EPSILON_MM) out.push({ trackId: t.id, end: 'end' });
  }
  return out;
}

/**
 * Line-track endpoints touching a component's pad — its world anchor, on each
 * copper layer the pad occupies. Built on padWorld + padCopperLayers +
 * tracksAtPoint. Filtered to the pad's net when the pad belongs to one.
 */
export function tracksAtPad(
  b: Board,
  refdes: string,
  padNumber: string,
): { trackId: string; end: 'start' | 'end'; layer: LayerId }[] {
  const comp = b.components.find((c) => c.refdes === refdes);
  if (!comp) return [];
  const pad = comp.footprint.pads.find((p) => p.number === padNumber);
  if (!pad) return [];
  const at = padWorld(comp, pad).at;
  const net = b.nets.find((n) => n.pins.includes(`${refdes}.${padNumber}`))?.name;
  const layers = padCopperLayers(pad, comp.side, copperLayersOf(b));
  const out: { trackId: string; end: 'start' | 'end'; layer: LayerId }[] = [];
  for (const layer of layers) {
    for (const hit of tracksAtPoint(b, at, layer, net)) {
      out.push({ ...hit, layer });
    }
  }
  return out;
}


interface PinNode {
  kind: 'pin';
  ref: string;
  at: Point;
  layers: LayerId[];
  /** World pad outline: a track end or via landing anywhere on it connects. */
  outline: Point[];
}

interface TrackEndNode {
  kind: 'trackEnd';
  trackIdx: number;
  which: 'start' | 'end';
  at: Point;
  layer: LayerId;
}

interface ViaNode {
  kind: 'via';
  viaIdx: number;
  at: Point;
}

type Node = PinNode | TrackEndNode | ViaNode;

function segEndpoints(t: Track): { start: Point; end: Point } {
  return { start: t.seg.start, end: t.seg.end };
}

function sharesLayer(a: LayerId[], b: LayerId[]): boolean {
  return a.some((l) => b.includes(l));
}

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

/**
 * One connected island of a net: the pin refs it contains plus the track/via
 * ids acting as its copper. Islands with an empty `pins` list are orphan
 * copper (tracks/vias touching nothing) — `connectedGroups` drops them, but
 * the UI shows them so stray copper is visible.
 */
export interface NetIsland {
  pins: string[];
  trackIds: string[];
  viaIds: string[];
}

/**
 * Union-find over a net's pins (world pad anchors), tracks, and vias.
 * Returns groups of pin refs only (tracks/vias are glue, not group members).
 * A net with 0 or 1 pins is a single group (or empty), never unrouted.
 */
export function connectedGroups(b: Board, net: Net): string[][] {
  if (net.pins.length <= 1) {
    return net.pins.length === 1 ? [[...net.pins]] : [];
  }
  return netIslands(b, net)
    .filter((g) => g.pins.length > 0)
    .map((g) => g.pins);
}

/**
 * Full island decomposition of a net: same union rules as `connectedGroups`,
 * but every island also lists its member track/via ids, and orphan islands
 * (copper with no pins) are included. Sorted largest-first by pin count.
 */
export function netIslands(b: Board, net: Net): NetIsland[] {
  const nodes: Node[] = [];
  const cu = copperLayersOf(b);

  for (const ref of net.pins) {
    const dot = ref.indexOf('.');
    const refdes = ref.slice(0, dot);
    const padNumber = ref.slice(dot + 1);
    const comp = b.components.find((c) => c.refdes === refdes);
    if (!comp) throw new Error(`netIslands: unknown refdes "${refdes}" (in pin "${ref}")`);
    // A pad number can repeat (USB-C shell tabs, split exposed pads): every
    // copy is the same pin, so each gets a node and they're unioned below.
    const pads = comp.footprint.pads.filter((p) => p.number === padNumber);
    if (pads.length === 0) {
      throw new Error(`netIslands: pad "${padNumber}" not found on "${refdes}" (pin "${ref}")`);
    }
    for (const pad of pads) {
      const at = padWorld(comp, pad).at;
      const layers = padCopperLayers(pad, comp.side, cu);
      nodes.push({ kind: 'pin', ref, at, layers, outline: padOutline(comp, pad) });
    }
  }

  const netTracks = b.tracks.filter((t) => t.net === net.name);
  const trackNodeIdx: { startIdx: number; endIdx: number }[] = [];
  for (let i = 0; i < netTracks.length; i++) {
    const t = netTracks[i];
    const { start, end } = segEndpoints(t);
    const startIdx = nodes.length;
    nodes.push({ kind: 'trackEnd', trackIdx: i, which: 'start', at: start, layer: t.layer });
    const endIdx = nodes.length;
    nodes.push({ kind: 'trackEnd', trackIdx: i, which: 'end', at: end, layer: t.layer });
    trackNodeIdx.push({ startIdx, endIdx });
  }

  const netVias = b.vias.filter((v) => v.net === net.name);
  for (let i = 0; i < netVias.length; i++) {
    nodes.push({ kind: 'via', viaIdx: i, at: netVias[i].at });
  }

  const uf = new UnionFind(nodes.length);

  // A track's own two endpoints are always connected (it's one continuous
  // piece of copper), regardless of the endpoint-to-endpoint distance.
  for (const { startIdx, endIdx } of trackNodeIdx) {
    uf.union(startIdx, endIdx);
  }

  function layersOf(n: Node): LayerId[] {
    if (n.kind === 'pin') return n.layers;
    if (n.kind === 'trackEnd') return [n.layer];
    return cu; // via joins any copper layer
  }

  // Copper that physically touches is connected: coincident anchors, a track
  // end or via anywhere on a pad, a track end inside a via's disk. Pins only
  // join other copies of themselves (same ref), never another pin directly.
  const onPad = (pin: PinNode, p: Point): boolean =>
    dist(pin.at, p) <= EPSILON_MM || pointInPolygon(p, pin.outline);
  const touches = (a: Node, c: Node): boolean => {
    if (a.kind === 'pin' && c.kind === 'pin') return a.ref === c.ref;
    if (a.kind === 'pin') return onPad(a, c.at);
    if (c.kind === 'pin') return onPad(c, a.at);
    const d = dist(a.at, c.at);
    if (a.kind === 'via' && c.kind === 'trackEnd') return d <= Math.max(EPSILON_MM, netVias[a.viaIdx].diameter / 2);
    if (c.kind === 'via' && a.kind === 'trackEnd') return d <= Math.max(EPSILON_MM, netVias[c.viaIdx].diameter / 2);
    return d <= EPSILON_MM;
  };
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const bNode = nodes[j];
      if (!sharesLayer(layersOf(a), layersOf(bNode))) continue;
      if (touches(a, bNode)) uf.union(i, j);
    }
  }

  // T-junctions: a track end or via landing on another track's body (not
  // its endpoint) is connected to that track.
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.kind === 'pin') continue;
    for (let k = 0; k < netTracks.length; k++) {
      const t = netTracks[k];
      if (n.kind === 'trackEnd' && (n.trackIdx === k || n.layer !== t.layer)) continue;
      if (pointSegDistance(n.at, t.seg) <= t.width / 2) uf.union(i, trackNodeIdx[k].startIdx);
    }
  }

  // Filled same-net pours are copper too: union the nodes whose anchor sits
  // inside the same fill island on the zone's layer (see the header). Each
  // island is its own conductor -- a pour split in two by a track or keepout
  // does NOT join its halves -- and a node inside a knockout joins nothing.
  for (const z of b.zones) {
    if (z.net !== net.name || !z.fill || z.fill.length === 0) continue;
    // A pad joins when pour copper overlaps it by a real area -- at least a
    // minimum-track-width square, i.e. no worse than a minimum track -- not
    // only when the pour covers its centre: fine-pitch pads are fed from
    // their tip, between neighbours' knockouts.
    const minOverlap = RULESETS[b.rules].minTrackWidth ** 2;
    for (const group of groupFillRings(z.fill)) {
      const gb = bboxOf(group.outer);
      let first = -1;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (!layersOf(n).includes(z.layer)) continue;
        let joined = pointInGroup(n.at, group);
        if (!joined && n.kind === 'pin') {
          const pb = bboxOf(n.outline);
          joined =
            pb.minX <= gb.maxX && pb.maxX >= gb.minX && pb.minY <= gb.maxY && pb.maxY >= gb.minY &&
            polyGroupOverlapArea(n.outline, group) >= minOverlap;
        }
        if (!joined) continue;
        if (first === -1) first = i;
        else uf.union(first, i);
      }
    }
  }

  const islandsByRoot = new Map<number, NetIsland>();
  function islandFor(root: number): NetIsland {
    let island = islandsByRoot.get(root);
    if (!island) {
      island = { pins: [], trackIds: [], viaIds: [] };
      islandsByRoot.set(root, island);
    }
    return island;
  }
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const island = islandFor(uf.find(i));
    if (node.kind === 'pin') {
      if (!island.pins.includes(node.ref)) island.pins.push(node.ref);
    } else if (node.kind === 'trackEnd') {
      const id = netTracks[node.trackIdx].id;
      // Each track contributes two nodes; only record it once (on 'start').
      if (node.which === 'start') island.trackIds.push(id);
    } else {
      island.viaIds.push(netVias[node.viaIdx].id);
    }
  }

  return Array.from(islandsByRoot.values()).sort((a, b2) => b2.pins.length - a.pins.length);
}

/** Minimum distance between any pin anchor in group a vs group b, plus the closest pair. */
function closestPair(
  b: Board,
  groupA: string[],
  groupB: string[],
): { d: number; from: Point; to: Point } {
  let best = { d: Infinity, from: { x: 0, y: 0 }, to: { x: 0, y: 0 } };
  for (const refA of groupA) {
    const pa = padAnchor(b, refA);
    for (const refB of groupB) {
      const pb = padAnchor(b, refB);
      const d = dist(pa, pb);
      if (d < best.d) best = { d, from: pa, to: pb };
    }
  }
  return best;
}

/**
 * For each net with >1 connected group, compute a minimum spanning tree over
 * the groups (complete graph, edge weight = min pairwise distance between
 * any two pins' anchors across the two groups). RatLine endpoints are the
 * actual closest pin anchors of that edge (Prim's algorithm).
 */
export function ratsnest(b: Board): RatLine[] {
  const lines: RatLine[] = [];

  for (const net of b.nets) {
    const groups = connectedGroups(b, net);
    if (groups.length <= 1) continue;

    const n = groups.length;
    const inTree = new Array(n).fill(false);
    inTree[0] = true;
    let remaining = n - 1;

    // best[j] = best known connection from tree to group j (or undefined)
    const best: ({ d: number; from: Point; to: Point } | undefined)[] = new Array(n).fill(
      undefined,
    );

    function updateBestFrom(i: number): void {
      for (let j = 0; j < n; j++) {
        if (inTree[j]) continue;
        const pair = closestPair(b, groups[i], groups[j]);
        if (!best[j] || pair.d < best[j]!.d) {
          best[j] = { d: pair.d, from: pair.from, to: pair.to };
        }
      }
    }

    updateBestFrom(0);

    while (remaining > 0) {
      let bestJ = -1;
      for (let j = 0; j < n; j++) {
        if (inTree[j]) continue;
        if (bestJ === -1 || best[j]!.d < best[bestJ]!.d) bestJ = j;
      }
      const edge = best[bestJ]!;
      lines.push({ net: net.name, from: edge.from, to: edge.to });
      inTree[bestJ] = true;
      remaining--;
      updateBestFrom(bestJ);
    }
  }

  return lines;
}

/** Nets with >1 connected group, reporting groups.length - 1 as `unconnected`. */
export function isFullyRouted(b: Board): { net: string; unconnected: number }[] {
  const result: { net: string; unconnected: number }[] = [];
  for (const net of b.nets) {
    const groups = connectedGroups(b, net);
    if (groups.length > 1) {
      result.push({ net: net.name, unconnected: groups.length - 1 });
    }
  }
  return result;
}
