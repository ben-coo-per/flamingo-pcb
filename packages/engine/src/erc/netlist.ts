/**
 * Flamingo Engine - ERC netlist view.
 *
 * The questions several ERC rules ask of a board's nets: what else is on a
 * net, which resistors pull it where, which capacitors decouple it, what
 * role a pin plays. Built once per ERC run.
 */

import type { Board, ComponentInst, Point, SymbolPin } from '../types.js';
import { padWorld } from '../geometry.js';
import { componentPins, pinNetMap, type PinLookup } from '../checks/types.js';
import { kindFromRefdes, parseValue } from '../values.js';
import { GROUND_NET, pinRole, type PinRole } from './part-facts.js';

/** A resistor this small is a series link, not a pull. */
export const SERIES_MAX_OHMS = 100;

export interface Pull {
  ref: string;
  ohms: number;
  /** The net at the resistor's far end. */
  to: string;
  direction: 'up' | 'down' | 'other';
}

export class Netlist {
  readonly board: Board;
  private readonly netByPin: Map<string, string>;
  private readonly comps: Map<string, ComponentInst>;
  private readonly pinsByRef = new Map<string, Record<string, SymbolPin>>();
  private readonly classOf: Map<string, string>;

  constructor(board: Board, lookup?: PinLookup) {
    this.board = board;
    this.netByPin = pinNetMap(board);
    this.comps = new Map(board.components.map((c) => [c.refdes, c]));
    this.classOf = new Map(board.nets.map((n) => [n.name, n.class]));
    for (const c of board.components) this.pinsByRef.set(c.refdes, componentPins(c, lookup));
  }

  component(ref: string): ComponentInst | undefined {
    return this.comps.get(ref);
  }

  get components(): ComponentInst[] {
    return this.board.components;
  }

  /** Symbol pins of a component (empty when its symbol is unknown). */
  pins(ref: string): Record<string, SymbolPin> {
    return this.pinsByRef.get(ref) ?? {};
  }

  pinName(ref: string, pad: string): string {
    return this.pins(ref)[pad]?.name ?? '';
  }

  /** Pad numbers of `ref` whose symbol pin name is `name`. */
  padsNamed(ref: string, name: string): string[] {
    return Object.entries(this.pins(ref))
      .filter(([, p]) => p.name.toUpperCase() === name.toUpperCase())
      .map(([pad]) => pad);
  }

  role(ref: string, pad: string): PinRole | undefined {
    const c = this.comps.get(ref);
    const name = this.pinName(ref, pad);
    if (!c || !name) return undefined;
    return pinRole(c.lcsc, name);
  }

  net(ref: string, pad: string): string | undefined {
    return this.netByPin.get(`${ref}.${pad}`);
  }

  netOfName(ref: string, name: string): string | undefined {
    for (const pad of this.padsNamed(ref, name)) {
      const n = this.net(ref, pad);
      if (n) return n;
    }
    return undefined;
  }

  /** [ref, pad] of every pin on a net. */
  members(net: string): [string, string][] {
    const n = this.board.nets.find((x) => x.name === net);
    if (!n) return [];
    return n.pins.map((p) => {
      const i = p.indexOf('.');
      return [p.slice(0, i), p.slice(i + 1)] as [string, string];
    });
  }

  /** Distinct pad numbers of a component, in a stable order. */
  padNumbers(ref: string): string[] {
    const c = this.comps.get(ref);
    if (!c) return [];
    const seen = [...new Set(c.footprint.pads.map((p) => p.number))];
    return seen.sort((a, b) => a.length - b.length || a.localeCompare(b, undefined, { numeric: true }));
  }

  /** "U2 VDD (9)", or "U2.9" when the pin has no name of its own. */
  label(ref: string, pad: string): string {
    const name = this.pinName(ref, pad);
    return name && name !== pad ? `${ref} ${name} (${pad})` : `${ref}.${pad}`;
  }

  /** Board position of a pad (its first copy, for multi-pad pins). */
  padAt(ref: string, pad: string): Point | undefined {
    const c = this.comps.get(ref);
    const p = c?.footprint.pads.find((x) => x.number === pad);
    return c && p ? padWorld(c, p).at : undefined;
  }

  isGroundNet(net: string | undefined): boolean {
    return !!net && GROUND_NET.test(net);
  }

  /** A non-ground power rail, judged by net class or name. */
  isSupplyNet(net: string | undefined): boolean {
    if (!net || this.isGroundNet(net)) return false;
    const cls = this.classOf.get(net);
    if (cls === 'power' || cls === 'supply') return true;
    return /^(\+?\d+V\d*|V\d+V\d*|VCC|VDD|VBUS|VM|AVDD|DVDD|VIN)(_.*)?$/i.test(net);
  }

  /** Rail voltage parsed from a net name: 3V3 -> 3.3, 5V -> 5, +12V -> 12, VBUS -> 5, GND -> 0. */
  netVolts(net: string | undefined): number | undefined {
    if (!net) return undefined;
    if (this.isGroundNet(net)) return 0;
    if (/^VBUS(_.*)?$/i.test(net)) return 5;
    const m = /^\+?V?(\d+)V(\d*)(_.*)?$/i.exec(net);
    if (m) return Number(`${m[1]}.${m[2] || '0'}`);
    return undefined;
  }

  /** Net on the other pad of a two-terminal part. */
  otherSide(ref: string, pad: string): string | undefined {
    const pads = this.padNumbers(ref);
    if (pads.length !== 2 || !pads.includes(pad)) return undefined;
    return this.net(ref, pads[0] === pad ? pads[1]! : pads[0]!);
  }

  /** Resistance of a resistor, from its value field. */
  ohms(ref: string): number | undefined {
    const c = this.comps.get(ref);
    if (!c || kindFromRefdes(ref) !== 'resistor') return undefined;
    return parseValue(c.fields.value, 'resistor')?.value;
  }

  /** Capacitance of a capacitor, from its value field. */
  farads(ref: string): number | undefined {
    const c = this.comps.get(ref);
    if (!c || kindFromRefdes(ref) !== 'capacitor') return undefined;
    return parseValue(c.fields.value, 'capacitor')?.value;
  }

  /** Resistors from `net` to a supply (up), ground (down), or another net. */
  pulls(net: string | undefined): Pull[] {
    if (!net) return [];
    const out: Pull[] = [];
    for (const [ref, pad] of this.members(net)) {
      if (kindFromRefdes(ref) !== 'resistor') continue;
      const ohms = this.ohms(ref);
      const to = this.otherSide(ref, pad);
      if (ohms === undefined || to === undefined || ohms <= SERIES_MAX_OHMS) continue;
      const direction = this.isGroundNet(to) ? 'down' : this.isSupplyNet(to) ? 'up' : 'other';
      out.push({ ref, ohms, to, direction });
    }
    return out;
  }

  /** Capacitors with one pad on `net` and the other on ground: [ref, farads?]. */
  capsToGround(net: string | undefined): [string, number | undefined][] {
    if (!net) return [];
    const out: [string, number | undefined][] = [];
    for (const [ref, pad] of this.members(net)) {
      if (kindFromRefdes(ref) !== 'capacitor') continue;
      if (this.isGroundNet(this.otherSide(ref, pad))) out.push([ref, this.farads(ref)]);
    }
    return out;
  }

  /** Integrated circuits: refdes U*. */
  ics(): ComponentInst[] {
    return this.board.components
      .filter((c) => /^U\d/.test(c.refdes))
      .sort((a, b) => a.refdes.localeCompare(b.refdes, undefined, { numeric: true }));
  }
}

export function isConnector(ref: string): boolean {
  return /^(J|X[A-Z]*|P|CN)\d/i.test(ref);
}
