/**
 * Shared fixtures for the panel tests: small synthetic boards built in code,
 * so no test depends on the network or on files outside the repo.
 */

import type { Board, ComponentInst, Footprint, PathSeg } from '@flamingo/engine';
import { newBoard } from '@flamingo/engine';
import type { PanelLimits } from '../src/config.js';
import { loadPanelLimits } from '../src/node/config.js';

export const LIMITS: PanelLimits = loadPanelLimits();

export function rectOutline(w: number, h: number, x0 = 0, y0 = 0): PathSeg[] {
  const p = [
    { x: x0, y: y0 },
    { x: x0 + w, y: y0 },
    { x: x0 + w, y: y0 + h },
    { x: x0, y: y0 + h },
  ];
  return p.map((start, i) => ({ type: 'line' as const, start, end: p[(i + 1) % 4]! }));
}

export const R0603: Footprint = {
  name: 'R0603',
  lcsc: 'C25804',
  pads: [
    { number: '1', shape: 'rect', at: { x: -0.75, y: 0 }, rotation: 0, size: { w: 0.8, h: 0.9 }, layer: 'top' },
    { number: '2', shape: 'rect', at: { x: 0.75, y: 0 }, rotation: 0, size: { w: 0.8, h: 0.9 }, layer: 'top' },
  ],
  silk: [],
  courtyard: [
    [
      { x: -1.5, y: -0.8 },
      { x: 1.5, y: -0.8 },
      { x: 1.5, y: 0.8 },
      { x: -1.5, y: 0.8 },
    ],
  ],
};

/** A connector whose courtyard reaches 2 mm below its origin: place it near an edge to overhang. */
export const EDGE_CONN: Footprint = {
  name: 'USB-C-EDGE',
  lcsc: 'C165948',
  pads: [
    { number: '1', shape: 'rect', at: { x: -1, y: 1 }, rotation: 0, size: { w: 0.6, h: 1.2 }, layer: 'top' },
    { number: '2', shape: 'rect', at: { x: 1, y: 1 }, rotation: 0, size: { w: 0.6, h: 1.2 }, layer: 'top' },
    {
      number: 'SH',
      shape: 'oval',
      at: { x: 0, y: 0 },
      rotation: 0,
      size: { w: 1.2, h: 1.8 },
      drill: { diameter: 0.7, plated: true },
      layer: 'through',
    },
  ],
  silk: [],
  courtyard: [
    [
      { x: -4, y: -2 },
      { x: 4, y: -2 },
      { x: 4, y: 3 },
      { x: -4, y: 3 },
    ],
  ],
};

export function comp(
  refdes: string,
  footprint: Footprint,
  x: number,
  y: number,
  extra: Partial<ComponentInst> = {},
): ComponentInst {
  return {
    refdes,
    lcsc: footprint.lcsc,
    footprint,
    at: { x, y },
    rotation: 0,
    side: 'top',
    fields: { value: footprint.name, package: footprint.name, basic: footprint.lcsc === 'C25804' },
    ...extra,
  };
}

/** A plain w x h board with one resistor in the middle. */
export function plainBoard(name: string, w: number, h: number, layers: 2 | 4 | 6 = 2): Board {
  const b = newBoard(name, layers);
  b.outline = rectOutline(w, h);
  b.components.push(comp('R1', R0603, w / 2, h / 2));
  return b;
}

/** A board with a connector overhanging its bottom (S) edge and a keepout on its top (N) edge. */
export function awkwardBoard(name = 'awkward', w = 30, h = 20): Board {
  const b = newBoard(name, 2);
  b.outline = rectOutline(w, h);
  b.components.push(comp('J1', EDGE_CONN, w / 2, 0.5)); // courtyard bottom at y = -1.5
  b.components.push(comp('R1', R0603, w / 2, h / 2));
  b.keepouts.push({
    id: 'ant',
    layers: 'all',
    polygon: [
      { x: 5, y: h - 6 },
      { x: w - 5, y: h - 6 },
      { x: w - 5, y: h },
      { x: 5, y: h },
    ],
    keepout: { copper: true, via: true, pour: true },
  });
  return b;
}

// ---------------------------------------------------------------------------
// Panels and resolved sources without touching the disk
// ---------------------------------------------------------------------------

import { resolveSourceGeometry } from '../src/source.js';
import type { ResolvedSource } from '../src/resolved.js';
import { newPanel } from '../src/panel.js';
import { applyPanelOp } from '../src/ops.js';
import type { PanelOp } from '../src/ops.js';
import type { Panel, PanelInstance } from '../src/types.js';

export function resolved(key: string, board: Board, extra: Partial<ResolvedSource> = {}): ResolvedSource {
  return {
    key,
    path: `${board.name}.flamingo`,
    name: board.name,
    recordedHash: 'h',
    hash: 'h',
    stale: false,
    board,
    geometry: resolveSourceGeometry(board, LIMITS),
    ...extra,
  };
}

export function applyAll(panel: Panel, ...ops: PanelOp[]): Panel {
  for (const op of ops) {
    const r = applyPanelOp(panel, op);
    if (!r.ok) throw new Error(`${op.op}: ${r.error}`);
    panel = r.panel;
  }
  return panel;
}

export type InstanceSpec = [source: string, x: number, y: number, extra?: Partial<PanelInstance>];

/** A panel over `sources` with instances at the given corners. */
export function panelOf(sources: ResolvedSource[], instances: InstanceSpec[], settings: PanelOp[] = []): Panel {
  let p = newPanel('test');
  for (const s of sources) {
    p = applyAll(p, { op: 'addSource', source: { key: s.key, path: s.path, hash: 'h', name: s.name } });
  }
  for (const [source, x, y, extra] of instances) {
    p = applyAll(p, { op: 'addInstance', source, at: { x, y }, ...extra });
  }
  return applyAll(p, ...settings);
}
