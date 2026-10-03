/**
 * Flamingo Panel - create / serialize / parse.
 *
 * Mirrors the engine's board.ts: pretty-printed JSON with stable key order so
 * panel files diff cleanly, and a parser that validates shape and fills in
 * settings added after a file was written.
 */

import type { Panel, PanelInstance, PanelLink, PanelSettings, PanelSource, Rotation } from './types.js';

export const PANEL_EXTENSION = '.plamingo';

/**
 * Settings a new panel starts with. The numbers mirror
 * `config/panel-limits.json` (`defaults`), which records where each one comes
 * from; `settingsFromLimits` builds settings from a loaded config instead.
 */
export const DEFAULT_SETTINGS: PanelSettings = {
  separation: 'mouse-bite',
  rails: { top: 5, bottom: 5, left: 0, right: 0 },
  spacing: 2,
  tabs: { width: 5, pitch: 50, maxLength: 8, holeDiameter: 0.6, holePitch: 1, holeOverlap: 1 / 3 },
  fiducials: { enabled: true, copperDiameter: 1, maskDiameter: 2, edgeDistance: 3.85, cornerOffset: 10 },
  toolingHoles: { enabled: true, diameter: 2, cornerOffset: 5 },
  copperLayers: 'auto',
};

export function newPanel(name: string, settings: PanelSettings = DEFAULT_SETTINGS): Panel {
  return {
    formatVersion: 1,
    kind: 'flamingo-panel',
    name,
    sources: [],
    instances: [],
    settings: structuredClone(settings),
  };
}

export function serializePanel(p: Panel): string {
  return JSON.stringify(p, null, 2);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

const ROTATIONS: readonly number[] = [0, 90, 180, 270];

/** Overlay `patch` on `base`, one level deep into nested settings groups. */
export function mergeSettings(base: PanelSettings, patch: unknown): PanelSettings {
  const out = structuredClone(base) as unknown as Record<string, unknown>;
  if (!isObject(patch)) return out as unknown as PanelSettings;
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in out)) continue; // unknown keys are dropped, not carried along
    const cur = out[k];
    if (isObject(cur) && isObject(v)) {
      const group = { ...cur };
      for (const [gk, gv] of Object.entries(v)) if (gk in group) group[gk] = gv;
      out[k] = group;
    } else if (!isObject(cur) && v !== undefined) {
      out[k] = v;
    }
  }
  return out as unknown as PanelSettings;
}

/**
 * Parse and validate a panel file. Throws with a message naming the first
 * problem found. Settings missing from the file take their defaults, so panels
 * written before a setting existed still load.
 */
export function parsePanel(json: string): Panel {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isObject(parsed)) throw new Error('Panel must be a JSON object');
  if (parsed.kind !== 'flamingo-panel') {
    throw new Error('Not a panel file: missing "kind": "flamingo-panel"');
  }
  if (parsed.formatVersion !== 1) {
    throw new Error(`Unsupported formatVersion: ${String(parsed.formatVersion)}. Expected 1.`);
  }
  if (typeof parsed.name !== 'string') throw new Error('Missing required field: name');
  if (!Array.isArray(parsed.sources)) throw new Error('Field "sources" must be an array');
  if (!Array.isArray(parsed.instances)) throw new Error('Field "instances" must be an array');

  const sources: PanelSource[] = parsed.sources.map((raw, i) => {
    if (!isObject(raw)) throw new Error(`sources[${i}] must be an object`);
    const { key, path, hash, name, needed, niceToHave } = raw;
    if (typeof key !== 'string' || key === '') throw new Error(`sources[${i}].key must be a non-empty string`);
    if (typeof path !== 'string' || path === '') throw new Error(`sources[${i}].path must be a non-empty string`);
    if (typeof hash !== 'string') throw new Error(`sources[${i}].hash must be a string`);
    if (!isCount(needed)) throw new Error(`sources[${i}].needed must be a non-negative integer`);
    return {
      key,
      path,
      hash,
      name: typeof name === 'string' ? name : key,
      needed,
      niceToHave: isCount(niceToHave) ? niceToHave : 0,
    };
  });
  const keys = new Set<string>();
  for (const s of sources) {
    if (keys.has(s.key)) throw new Error(`Duplicate source key "${s.key}"`);
    keys.add(s.key);
  }

  const instances: PanelInstance[] = parsed.instances.map((raw, i) => {
    if (!isObject(raw)) throw new Error(`instances[${i}] must be an object`);
    const { id, source, at, rotation, pinned, populate } = raw;
    if (typeof id !== 'string' || id === '') throw new Error(`instances[${i}].id must be a non-empty string`);
    if (typeof source !== 'string' || !keys.has(source)) {
      throw new Error(`instances[${i}] ("${id}") refers to unknown source "${String(source)}"`);
    }
    if (!isObject(at) || typeof at.x !== 'number' || typeof at.y !== 'number') {
      throw new Error(`instances[${i}] ("${id}").at must be {x, y}`);
    }
    if (typeof rotation !== 'number' || !ROTATIONS.includes(rotation)) {
      throw new Error(`instances[${i}] ("${id}").rotation must be 0, 90, 180 or 270`);
    }
    return {
      id,
      source,
      at: { x: at.x, y: at.y },
      rotation: rotation as Rotation,
      pinned: pinned === true,
      populate: populate !== false,
    };
  });
  const ids = new Set<string>();
  for (const inst of instances) {
    if (ids.has(inst.id)) throw new Error(`Duplicate instance id "${inst.id}"`);
    ids.add(inst.id);
  }

  const links = parsed.links === undefined ? undefined : parseLinks(parsed.links, keys);

  return {
    formatVersion: 1,
    kind: 'flamingo-panel',
    name: parsed.name,
    sources,
    instances,
    settings: mergeSettings(DEFAULT_SETTINGS, parsed.settings),
    ...(links ? { links } : {}),
  };
}

const ENDPOINT_RE = /^([^:\s]+):([^:\s]+)$/;

/** `<source key>:<refdes>` -> its parts, or null when malformed. */
export function parseEndpoint(ep: string): { key: string; refdes: string } | null {
  const m = ENDPOINT_RE.exec(ep);
  return m ? { key: m[1]!, refdes: m[2]! } : null;
}

function isStringMap(v: unknown): v is Record<string, string> {
  return isObject(v) && Object.values(v).every((x) => typeof x === 'string');
}

/**
 * Validate a link's shape and that its endpoints name sources on the panel.
 * Returns an error message, or null when the link is well formed. Whether the
 * refdes exist on those boards is the interconnect check's business: the
 * panel never reads board content.
 */
export function validateLink(link: Omit<PanelLink, 'id'>, keys: ReadonlySet<string>): string | null {
  const eps = [link.from, ...(Array.isArray(link.to) ? link.to : [])];
  if (typeof link.from !== 'string') return 'from must be "<source key>:<refdes>"';
  if (!Array.isArray(link.to) || link.to.length === 0) return 'to must list at least one "<source key>:<refdes>"';
  for (const ep of eps) {
    const parsed = typeof ep === 'string' ? parseEndpoint(ep) : null;
    if (!parsed) return `endpoint "${String(ep)}" must be "<source key>:<refdes>"`;
    if (!keys.has(parsed.key)) return `endpoint "${ep}" refers to unknown source "${parsed.key}"`;
  }
  if (new Set(eps).size !== eps.length) return 'a link cannot join a header to itself';
  if (link.map !== 'straight' && !isStringMap(link.map)) return 'map must be "straight" or an object of pad -> pad';
  if (link.aliases !== undefined && !isStringMap(link.aliases)) return 'aliases must be an object of net name -> name';
  if (link.note !== undefined && typeof link.note !== 'string') return 'note must be a string';
  return null;
}

function parseLinks(raw: unknown, keys: ReadonlySet<string>): PanelLink[] {
  if (!Array.isArray(raw)) throw new Error('Field "links" must be an array');
  const ids = new Set<string>();
  return raw.map((l, i) => {
    if (!isObject(l)) throw new Error(`links[${i}] must be an object`);
    if (typeof l.id !== 'string' || l.id === '') throw new Error(`links[${i}].id must be a non-empty string`);
    if (ids.has(l.id)) throw new Error(`Duplicate link id "${l.id}"`);
    ids.add(l.id);
    const link = l as unknown as PanelLink;
    const problem = validateLink(link, keys);
    if (problem) throw new Error(`links[${i}] ("${l.id}"): ${problem}`);
    return {
      id: link.id,
      from: link.from,
      to: [...link.to],
      map: link.map === 'straight' ? 'straight' : { ...link.map },
      ...(link.aliases ? { aliases: { ...link.aliases } } : {}),
      ...(link.note !== undefined ? { note: link.note } : {}),
    };
  });
}
