/**
 * Values a SPICE template needs, read from a board. Every value carries the
 * refdes it came from, so a summary can say where a number came from and a
 * change on the board shows up in the next run.
 */

import type { Board, ComponentInst } from '../types.js';
import { kindFromRefdes, parseValue } from '../values.js';
import { formatSi } from '../values.js';

export class SpiceExtractError extends Error {}

export interface Sourced {
  value: number;
  source: string;
}

function padNets(b: Board, c: ComponentInst): (string | undefined)[] {
  const m = new Map<string, string>();
  for (const n of b.nets) for (const pin of n.pins) m.set(pin, n.name);
  return c.footprint.pads.map((p) => m.get(`${c.refdes}.${p.number}`));
}

/** Refdes of two-pad parts starting with `prefix` that join netA to netB. */
export function between(b: Board, prefix: string, netA: string, netB: string): string[] {
  const out: string[] = [];
  for (const c of b.components) {
    if (!c.refdes.startsWith(prefix) || !/^\d/.test(c.refdes.slice(prefix.length))) continue;
    if (c.footprint.pads.length !== 2) continue;
    const [a, bb] = padNets(b, c);
    if ((a === netA && bb === netB) || (a === netB && bb === netA)) out.push(c.refdes);
  }
  return out.sort();
}

export function valueOf(b: Board, ref: string): number {
  const c = b.components.find((x) => x.refdes === ref);
  if (!c) throw new SpiceExtractError(`${b.name}: no ${ref}`);
  const v = parseValue(c.fields.value, kindFromRefdes(ref));
  if (!v) throw new SpiceExtractError(`${b.name}: ${ref} value "${c.fields.value ?? ''}" cannot be read as a number`);
  return v.value;
}

function describe(b: Board, refs: string[], joiner: string): string {
  return `${refs.map((r) => `${r} ${b.components.find((c) => c.refdes === r)?.fields.value ?? ''}`).join(joiner)} (${b.name})`;
}

/** Exactly one part between two nets. */
export function one(b: Board, prefix: string, netA: string, netB: string, what: string): Sourced {
  const refs = between(b, prefix, netA, netB);
  if (refs.length !== 1) {
    throw new SpiceExtractError(
      `${b.name}: expected one ${what} (${prefix} between ${netA} and ${netB}), found ${refs.length ? refs.join(', ') : 'none'}`,
    );
  }
  return { value: valueOf(b, refs[0]!), source: describe(b, refs, '') };
}

/** Every resistor between two nets, in parallel; undefined when there are none. */
export function parallelR(b: Board, netA: string, netB: string): Sourced | undefined {
  const refs = between(b, 'R', netA, netB);
  if (refs.length === 0) return undefined;
  const g = refs.reduce((s, r) => s + 1 / valueOf(b, r), 0);
  return { value: 1 / g, source: describe(b, refs, ' || ') };
}

export interface CapOnNet {
  ref: string;
  farads: number;
}

export function capsOn(b: Board, net: string, gnd = 'GND'): CapOnNet[] {
  return between(b, 'C', net, gnd).map((ref) => ({ ref, farads: valueOf(b, ref) }));
}

export function totalC(b: Board, net: string, gnd = 'GND'): Sourced {
  const refs = between(b, 'C', net, gnd);
  if (refs.length === 0) throw new SpiceExtractError(`${b.name}: no capacitors from ${net} to ${gnd}`);
  const total = refs.reduce((s, r) => s + valueOf(b, r), 0);
  return { value: total, source: `${formatSi(total, 'F')}: ${describe(b, refs, ' + ')}` };
}

export function requireNet(b: Board, net: string): void {
  if (!b.nets.some((n) => n.name === net)) throw new SpiceExtractError(`${b.name}: no net ${net}`);
}
