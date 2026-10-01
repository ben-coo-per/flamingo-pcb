/**
 * Flamingo Panel - operations.
 *
 * Same contract as the engine's board ops: `applyPanelOp` is a pure reducer
 * over a discriminated union. It never mutates its input, returns a new panel
 * or `{ok:false,error}`, and never throws for a validation failure. One op is
 * one undo step; `transaction` groups several into one.
 */

import type { Point } from '@flamingo/engine';
import { mergeSettings, validateLink } from './panel.js';
import type { Panel, PanelInstance, PanelLink, PanelSettings, PanelSource, Rotation } from './types.js';

/** Recursive partial of the settings: patch one number without restating its group. */
export type SettingsPatch = {
  [K in keyof PanelSettings]?: PanelSettings[K] extends object ? Partial<PanelSettings[K]> : PanelSettings[K];
};

export interface InstancePlacement {
  id: string;
  at: Point;
  rotation?: Rotation;
}

export type PanelOp =
  | { op: 'setName'; name: string }
  | { op: 'addSource'; source: Omit<PanelSource, 'key' | 'needed' | 'niceToHave'> & { key?: string; needed?: number; niceToHave?: number } }
  | { op: 'removeSource'; key: string }
  | { op: 'refreshSource'; key: string; hash: string; name?: string }
  | { op: 'setQuantity'; key: string; needed?: number; niceToHave?: number }
  | { op: 'addInstance'; source: string; at?: Point; rotation?: Rotation; pinned?: boolean; populate?: boolean }
  | { op: 'removeInstance'; id: string }
  | { op: 'moveInstance'; id: string; at: Point; pin?: boolean }
  | { op: 'rotateInstance'; id: string; rotation?: Rotation; by?: number; center?: Point }
  | { op: 'setPopulate'; id: string; populate: boolean }
  | { op: 'setPinned'; id: string; pinned: boolean }
  /** Move (and optionally rotate) several instances at once: what arrange emits. */
  | { op: 'placeInstances'; placements: InstancePlacement[] }
  /** Replace every instance (and optionally the settings): what loading a scenario emits. */
  | { op: 'setLayout'; instances: PanelInstance[]; settings?: SettingsPatch }
  | { op: 'setSettings'; settings: SettingsPatch }
  /** Declare a cable between boards. The new link's id is in `created`. */
  | { op: 'addLink'; link: Omit<PanelLink, 'id'> & { id?: string } }
  | { op: 'removeLink'; id: string }
  | { op: 'transaction'; ops: PanelOp[] };

export interface PanelOpResult {
  ok: true;
  panel: Panel;
  /** Ids of instances (or keys of sources) this op created. */
  created: string[];
}

export interface PanelOpError {
  ok: false;
  error: string;
}

function ok(panel: Panel, created: string[]): PanelOpResult {
  return { ok: true, panel, created };
}

function err(error: string): PanelOpError {
  return { ok: false, error };
}

const ROTATIONS: readonly number[] = [0, 90, 180, 270];

function isRotation(r: unknown): r is Rotation {
  return typeof r === 'number' && ROTATIONS.includes(r);
}

function isFinitePoint(p: unknown): p is Point {
  return (
    typeof p === 'object' &&
    p !== null &&
    Number.isFinite((p as Point).x) &&
    Number.isFinite((p as Point).y)
  );
}

function isCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

/** Source keys are short uppercase labels; they become refdes prefixes, so keep them tame. */
const KEY_RE = /^[A-Z][A-Z0-9]{0,3}$/;

/**
 * Pick a free key for a new source: the first letter of its name if that is
 * free, else the first free letter of the alphabet, else a two-letter key.
 */
export function suggestSourceKey(panel: Panel, name: string): string {
  const taken = new Set(panel.sources.map((s) => s.key));
  const first = name.replace(/[^A-Za-z]/g, '').charAt(0).toUpperCase();
  if (first && !taken.has(first)) return first;
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const ch of letters) if (!taken.has(ch)) return ch;
  for (const a of letters) for (const b of letters) if (!taken.has(a + b)) return a + b;
  throw new Error('no free source key');
}

/** Next unused instance number for a source: one past the highest in use. */
export function nextInstanceId(panel: Panel, key: string): string {
  let max = 0;
  for (const inst of panel.instances) {
    if (inst.source !== key) continue;
    const n = Number(inst.id.slice(key.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${key}${max + 1}`;
}

function normRotation(deg: number): Rotation {
  const r = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  return r as Rotation;
}

function validateSettings(s: PanelSettings): string | null {
  const nonNeg = (v: number, name: string): string | null =>
    Number.isFinite(v) && v >= 0 ? null : `${name} must be a number >= 0`;
  const pos = (v: number, name: string): string | null =>
    Number.isFinite(v) && v > 0 ? null : `${name} must be a number > 0`;
  if (!['mouse-bite', 'solid-tab', 'silk-divider'].includes(s.separation)) {
    return 'separation must be "mouse-bite", "solid-tab" or "silk-divider"';
  }
  if (s.copperLayers !== 'auto' && ![2, 4, 6].includes(s.copperLayers)) {
    return 'copperLayers must be "auto", 2, 4 or 6';
  }
  if (typeof s.fiducials.enabled !== 'boolean') return 'fiducials.enabled must be a boolean';
  if (typeof s.toolingHoles.enabled !== 'boolean') return 'toolingHoles.enabled must be a boolean';
  if (!(s.tabs.holeOverlap >= 0 && s.tabs.holeOverlap <= 0.5)) return 'tabs.holeOverlap must be between 0 and 0.5';
  return (
    nonNeg(s.rails.top, 'rails.top') ??
    nonNeg(s.rails.bottom, 'rails.bottom') ??
    nonNeg(s.rails.left, 'rails.left') ??
    nonNeg(s.rails.right, 'rails.right') ??
    pos(s.spacing, 'spacing') ??
    pos(s.tabs.width, 'tabs.width') ??
    pos(s.tabs.pitch, 'tabs.pitch') ??
    pos(s.tabs.maxLength, 'tabs.maxLength') ??
    pos(s.tabs.holeDiameter, 'tabs.holeDiameter') ??
    pos(s.tabs.holePitch, 'tabs.holePitch') ??
    pos(s.fiducials.copperDiameter, 'fiducials.copperDiameter') ??
    pos(s.fiducials.maskDiameter, 'fiducials.maskDiameter') ??
    nonNeg(s.fiducials.edgeDistance, 'fiducials.edgeDistance') ??
    nonNeg(s.fiducials.cornerOffset, 'fiducials.cornerOffset') ??
    pos(s.toolingHoles.diameter, 'toolingHoles.diameter') ??
    nonNeg(s.toolingHoles.cornerOffset, 'toolingHoles.cornerOffset')
  );
}

function validateInstance(panel: Panel, inst: PanelInstance, seen: Set<string>): string | null {
  if (typeof inst.id !== 'string' || inst.id === '') return 'instance id must be a non-empty string';
  if (seen.has(inst.id)) return `Duplicate instance id "${inst.id}"`;
  if (!panel.sources.some((s) => s.key === inst.source)) return `Unknown source "${inst.source}" (instance "${inst.id}")`;
  if (!isFinitePoint(inst.at)) return `Instance "${inst.id}": at must be {x, y}`;
  if (!isRotation(inst.rotation)) return `Instance "${inst.id}": rotation must be 0, 90, 180 or 270`;
  return null;
}

/** Apply one op to a panel. Pure: returns a new panel, never mutates `p`. */
export function applyPanelOp(p: Panel, op: PanelOp): PanelOpResult | PanelOpError {
  const panel = structuredClone(p);
  op = structuredClone(op);
  const created: string[] = [];

  switch (op.op) {
    case 'setName': {
      if (typeof op.name !== 'string' || op.name.trim() === '') return err('name cannot be empty');
      panel.name = op.name;
      return ok(panel, created);
    }

    case 'addSource': {
      const src = op.source;
      if (typeof src.path !== 'string' || src.path === '') return err('source path cannot be empty');
      if (panel.sources.some((s) => s.path === src.path)) {
        return err(`Board "${src.path}" is already on the panel`);
      }
      const key = src.key ?? suggestSourceKey(panel, src.name);
      if (!KEY_RE.test(key)) {
        return err(`Invalid source key "${key}" (1-4 characters, uppercase letter first, then letters or digits)`);
      }
      if (panel.sources.some((s) => s.key === key)) return err(`Source key "${key}" is already in use`);
      const needed = src.needed ?? 1;
      const niceToHave = src.niceToHave ?? 0;
      if (!isCount(needed)) return err('needed must be a non-negative integer');
      if (!isCount(niceToHave)) return err('niceToHave must be a non-negative integer');
      panel.sources.push({ key, path: src.path, hash: src.hash, name: src.name, needed, niceToHave });
      created.push(key);
      return ok(panel, created);
    }

    case 'removeSource': {
      const idx = panel.sources.findIndex((s) => s.key === op.key);
      if (idx === -1) return err(`Unknown source "${op.key}"`);
      panel.sources.splice(idx, 1);
      panel.instances = panel.instances.filter((i) => i.source !== op.key);
      // A cable to a board that is gone describes nothing.
      if (panel.links) {
        const touches = (ep: string): boolean => ep.split(':')[0] === op.key;
        panel.links = panel.links.filter((l) => !touches(l.from) && !l.to.some(touches));
        if (panel.links.length === 0) delete panel.links;
      }
      return ok(panel, created);
    }

    case 'refreshSource': {
      const src = panel.sources.find((s) => s.key === op.key);
      if (!src) return err(`Unknown source "${op.key}"`);
      src.hash = op.hash;
      if (op.name !== undefined) src.name = op.name;
      return ok(panel, created);
    }

    case 'setQuantity': {
      const src = panel.sources.find((s) => s.key === op.key);
      if (!src) return err(`Unknown source "${op.key}"`);
      if (op.needed !== undefined) {
        if (!isCount(op.needed)) return err('needed must be a non-negative integer');
        src.needed = op.needed;
      }
      if (op.niceToHave !== undefined) {
        if (!isCount(op.niceToHave)) return err('niceToHave must be a non-negative integer');
        src.niceToHave = op.niceToHave;
      }
      return ok(panel, created);
    }

    case 'addInstance': {
      if (!panel.sources.some((s) => s.key === op.source)) return err(`Unknown source "${op.source}"`);
      if (op.at !== undefined && !isFinitePoint(op.at)) return err('at must be {x, y}');
      if (op.rotation !== undefined && !isRotation(op.rotation)) {
        return err('rotation must be 0, 90, 180 or 270');
      }
      const id = nextInstanceId(panel, op.source);
      panel.instances.push({
        id,
        source: op.source,
        at: op.at ?? { x: 0, y: 0 },
        rotation: op.rotation ?? 0,
        pinned: op.pinned ?? false,
        populate: op.populate ?? true,
      });
      created.push(id);
      return ok(panel, created);
    }

    case 'removeInstance': {
      const idx = panel.instances.findIndex((i) => i.id === op.id);
      if (idx === -1) return err(`Unknown instance "${op.id}"`);
      panel.instances.splice(idx, 1);
      return ok(panel, created);
    }

    case 'moveInstance': {
      const inst = panel.instances.find((i) => i.id === op.id);
      if (!inst) return err(`Unknown instance "${op.id}"`);
      if (!isFinitePoint(op.at)) return err('at must be {x, y}');
      inst.at = op.at;
      if (op.pin !== undefined) inst.pinned = op.pin;
      return ok(panel, created);
    }

    case 'rotateInstance': {
      const inst = panel.instances.find((i) => i.id === op.id);
      if (!inst) return err(`Unknown instance "${op.id}"`);
      if (op.rotation !== undefined) {
        if (!isRotation(op.rotation)) return err('rotation must be 0, 90, 180 or 270');
        inst.rotation = op.rotation;
      } else {
        const by = op.by ?? 90;
        if (!Number.isFinite(by) || Math.abs(by % 90) > 1e-9) return err('by must be a multiple of 90');
        inst.rotation = normRotation(inst.rotation + by);
      }
      // `at` is the bounding-box corner, so a caller that wants the instance
      // to turn about its centre passes the corner it works out to.
      if (op.center !== undefined) {
        if (!isFinitePoint(op.center)) return err('center must be {x, y}');
        inst.at = op.center;
      }
      return ok(panel, created);
    }

    case 'setPopulate': {
      const inst = panel.instances.find((i) => i.id === op.id);
      if (!inst) return err(`Unknown instance "${op.id}"`);
      inst.populate = op.populate === true;
      return ok(panel, created);
    }

    case 'setPinned': {
      const inst = panel.instances.find((i) => i.id === op.id);
      if (!inst) return err(`Unknown instance "${op.id}"`);
      inst.pinned = op.pinned === true;
      return ok(panel, created);
    }

    case 'placeInstances': {
      for (const pl of op.placements) {
        if (!panel.instances.some((i) => i.id === pl.id)) return err(`Unknown instance "${pl.id}"`);
        if (!isFinitePoint(pl.at)) return err(`Instance "${pl.id}": at must be {x, y}`);
        if (pl.rotation !== undefined && !isRotation(pl.rotation)) {
          return err(`Instance "${pl.id}": rotation must be 0, 90, 180 or 270`);
        }
      }
      for (const pl of op.placements) {
        const inst = panel.instances.find((i) => i.id === pl.id)!;
        inst.at = pl.at;
        if (pl.rotation !== undefined) inst.rotation = pl.rotation;
      }
      return ok(panel, created);
    }

    case 'setLayout': {
      const seen = new Set<string>();
      for (const inst of op.instances) {
        const problem = validateInstance(panel, inst, seen);
        if (problem) return err(problem);
        seen.add(inst.id);
      }
      if (op.settings !== undefined) {
        const next = mergeSettings(panel.settings, op.settings);
        const problem = validateSettings(next);
        if (problem) return err(problem);
        panel.settings = next;
      }
      panel.instances = op.instances.map((i) => ({
        id: i.id,
        source: i.source,
        at: { x: i.at.x, y: i.at.y },
        rotation: i.rotation,
        pinned: i.pinned === true,
        populate: i.populate !== false,
      }));
      return ok(panel, created);
    }

    case 'setSettings': {
      const next = mergeSettings(panel.settings, op.settings);
      const problem = validateSettings(next);
      if (problem) return err(problem);
      panel.settings = next;
      return ok(panel, created);
    }

    case 'addLink': {
      const keys = new Set(panel.sources.map((s) => s.key));
      const problem = validateLink(op.link, keys);
      if (problem) return err(problem);
      const links = panel.links ?? [];
      let id = op.link.id;
      if (id !== undefined && links.some((l) => l.id === id)) return err(`Link "${id}" already exists`);
      if (id === undefined) {
        const used = new Set(links.map((l) => l.id));
        let n = 1;
        while (used.has(`L${n}`)) n++;
        id = `L${n}`;
      }
      const { from, to, map, aliases, note } = op.link;
      links.push({ id, from, to: [...to], map, ...(aliases ? { aliases } : {}), ...(note !== undefined ? { note } : {}) });
      panel.links = links;
      created.push(id);
      return ok(panel, created);
    }

    case 'removeLink': {
      const idx = (panel.links ?? []).findIndex((l) => l.id === op.id);
      if (idx === -1) return err(`Unknown link "${op.id}"`);
      panel.links!.splice(idx, 1);
      if (panel.links!.length === 0) delete panel.links;
      return ok(panel, created);
    }

    case 'transaction': {
      let cur: Panel = panel;
      for (const sub of op.ops) {
        const r = applyPanelOp(cur, sub);
        if (!r.ok) return r;
        cur = r.panel;
        created.push(...r.created);
      }
      return ok(cur, created);
    }

    default: {
      const _exhaustive: never = op;
      return err(`Unknown op: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
