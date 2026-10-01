/**
 * Netlist-driven logic simulation: build a system from board instances and
 * evaluate one state of it.
 *
 * The model is deliberately small. It follows a digital control path through
 * the parts it knows (port expanders, decoders, analog muxes, single gates,
 * tri-state buffers), resistors as pulls, and jumpers. Everything else is
 * ignored, and listed as unmodelled so a reader knows what was left out.
 *
 * A net's level is resolved in this order:
 *   1. constants (ground nets, declared supplies);
 *   2. forced free signals (an MCU pin driven 0 or 1);
 *   3. outputs of modelled parts that drive it; 0 and 1 together is X (contention);
 *   4. resistors over SHORT_OHMS to a net resolved in 1-3 (weak pulls);
 *      a pull-up and a pull-down together is X;
 *   5. otherwise Z.
 * Parts read Z on an input as X: a floating CMOS input is undefined.
 * Resistors at or under SHORT_OHMS (series resistors) are wires.
 */

import type { Board, ComponentInst } from '../types.js';
import { componentPins, type PinLookup } from '../checks/types.js';
import { parseValue } from '../values.js';
import type { Level, LogicInstance, LogicLink } from './types.js';

export const SHORT_OHMS = 100;

/** Levels as small ints in the hot loop. */
export const L0 = 0;
export const L1 = 1;
export const LZ = 2;
export const LX = 3;
const CODE: Record<Level, number> = { '0': L0, '1': L1, Z: LZ, X: LX };
export const LEVEL: Level[] = ['0', '1', 'Z', 'X'];
export const toCode = (l: Level): number => CODE[l];

const GROUND = /^(A|D|P|S)?GND\d*$|^VSS$/i;

export type PartKind = 'mcp23017' | 'hc154' | 'hc4067' | 'buf125' | 'xor' | 'and' | 'or' | 'nand' | 'nor';

/** Which model a component gets, from its symbol pin names (and, for single gates, its part number). */
export function classifyPart(c: ComponentInst, pinNames: Set<string>): PartKind | null {
  const has = (...n: string[]) => n.every((x) => pinNames.has(x));
  if (has('GPA0', 'GPB0', 'RESET#')) return 'mcp23017';
  if (has('Y0#', 'Y15#', 'E1#', 'E2#', 'A3')) return 'hc154';
  if (has('I0', 'I15', 'S3', 'E#') && [...pinNames].some((n) => n.startsWith('COMMON'))) return 'hc4067';
  if (has('1OE', '1A', '1Y', '4OE')) return 'buf125';
  if (has('A', 'B', 'Y')) {
    const id = `${c.fields.value ?? ''} ${c.fields.description ?? ''}`;
    const m = /1G(86|08|32|00|02)\b/i.exec(id);
    if (m) return ({ '86': 'xor', '08': 'and', '32': 'or', '00': 'nand', '02': 'nor' } as const)[m[1] as '86'];
  }
  return null;
}

export interface CompiledPart {
  inst: string;
  ref: string;
  kind: PartKind;
  /** Upper-case symbol pin name -> canonical net id, or -1 when the pin is unconnected. */
  pin: Map<string, number>;
  /** MCP23017 only: GPIO pin names in register order (GPA0..GPB7), connected or not. */
  gpio: string[];
  /** Net ids in the kind's slot order (see SLOTS); -1 when unconnected. */
  slots: Int32Array;
  /** Net id of the supply pin (VCC/VDD), -1 if unconnected, -2 if the part has none. */
  supply: number;
}

const range = (prefix: string, n: number, suffix = ''): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}${suffix}`);

/** Pin order each model reads its nets in, so the hot loop indexes arrays instead of names. */
const SLOTS: Record<PartKind, string[]> = {
  mcp23017: ['RESET#', ...range('GPA', 8), ...range('GPB', 8)],
  hc154: ['E1#', 'E2#', 'A0', 'A1', 'A2', 'A3', ...range('Y', 16, '#')],
  hc4067: ['E#', 'S0', 'S1', 'S2', 'S3', ...range('I', 16)],
  buf125: ['1OE', '1A', '1Y', '2OE', '2A', '2Y', '3OE', '3A', '3Y', '4OE', '4A', '4Y'],
  xor: ['A', 'B', 'Y'],
  and: ['A', 'B', 'Y'],
  or: ['A', 'B', 'Y'],
  nand: ['A', 'B', 'Y'],
  nor: ['A', 'B', 'Y'],
};

class UnionFind {
  private parent: number[] = [];
  add(): number {
    this.parent.push(this.parent.length);
    return this.parent.length - 1;
  }
  find(a: number): number {
    const p = this.parent;
    while (p[a] !== a) {
      p[a] = p[p[a]!]!;
      a = p[a]!;
    }
    return a;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

export interface EvalInput {
  /** Per net id: forced level code, or -1. */
  forced: Int8Array;
  /** Per part index (MCP23017 only): level code per gpio index. */
  registers: Map<number, Int8Array>;
}

/** EvalResult.mux values besides a connected net id. */
export const MUX_OPEN = -1;
export const MUX_UNKNOWN = -2;

export interface EvalResult {
  level: Int8Array;
  /** Net ids driven 0 and 1 at once. */
  contention: number[];
  /**
   * Per part index, for analog muxes: the net id the common pin connects to,
   * MUX_OPEN when disabled or the channel is unconnected, MUX_UNKNOWN when
   * the enable or select is unknown (or the mux is unpowered).
   */
  mux: Int32Array;
}

/**
 * Board instances joined into one netlist. Net ids are dense after
 * union-find, so the evaluator works on typed arrays.
 */
export class LogicSystem {
  readonly instances = new Map<string, LogicInstance>();
  readonly parts: CompiledPart[] = [];
  readonly unmodelled: string[] = [];
  /** Canonical net id -> display name ("bank0:SEL_N", or several joined by "="). */
  names: string[] = [];
  netCount = 0;
  private constLevel!: Int8Array;
  private pulls!: Int32Array; // pairs (a, b)
  private relevant!: Int32Array; // net ids the evaluator resolves
  private raw = new Map<string, number>(); // "inst:NET" -> raw id
  private uf = new UnionFind();
  private rawConst = new Map<number, number>();
  private rawPulls: [number, number][] = [];
  private rawParts: { inst: string; ref: string; kind: PartKind; pin: Map<string, number>; gpio: string[] }[] = [];
  private canon: Int32Array = new Int32Array(0);
  private built = false;

  constructor(private readonly pins?: PinLookup) {}

  private rawNet(inst: string, net: string): number {
    const key = `${inst}:${net}`;
    let id = this.raw.get(key);
    if (id === undefined) {
      id = this.uf.add();
      this.raw.set(key, id);
    }
    return id;
  }

  componentPinNames(c: ComponentInst): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [pad, p] of Object.entries(componentPins(c, this.pins))) out[pad] = p.name.toUpperCase();
    return out;
  }

  addInstance(inst: LogicInstance): void {
    if (this.built) throw new Error('LogicSystem: add instances before compiling');
    if (this.instances.has(inst.name)) throw new Error(`duplicate instance name ${inst.name}`);
    if (inst.name.includes(':')) throw new Error(`instance name ${inst.name} must not contain ':'`);
    this.instances.set(inst.name, inst);
    const b = inst.board;
    const padNet = new Map<string, string>();
    for (const n of b.nets) {
      const id = this.rawNet(inst.name, n.name);
      if (GROUND.test(n.name)) this.rawConst.set(id, L0);
      for (const p of n.pins) padNet.set(p, n.name);
    }
    for (const [net, lvl] of Object.entries(inst.supplies ?? {})) {
      if (!b.nets.some((n) => n.name === net)) throw new Error(`${inst.name}: supply net ${net} is not on the board`);
      this.rawConst.set(this.rawNet(inst.name, net), CODE[lvl]);
    }
    const fitted = new Set(inst.fitted ?? []);
    for (const ref of fitted) {
      if (!b.components.some((c) => c.refdes === ref)) throw new Error(`${inst.name}: no jumper ${ref}`);
    }
    for (const c of [...b.components].sort((x, y) => x.refdes.localeCompare(y.refdes))) {
      const names = this.componentPinNames(c);
      const kind = classifyPart(c, new Set(Object.values(names)));
      if (kind) {
        const pin = new Map<string, number>();
        for (const [pad, name] of Object.entries(names)) {
          const net = padNet.get(`${c.refdes}.${pad}`);
          // Several pads may share a name (GND); keep the first connected one.
          if (pin.has(name) && pin.get(name)! >= 0) continue;
          pin.set(name, net ? this.rawNet(inst.name, net) : -1);
        }
        const gpio =
          kind === 'mcp23017'
            ? ['A', 'B'].flatMap((port) => Array.from({ length: 8 }, (_, i) => `GP${port}${i}`))
            : [];
        this.rawParts.push({ inst: inst.name, ref: c.refdes, kind, pin, gpio });
        continue;
      }
      const pads = c.footprint.pads.map((p) => p.number);
      const nets = pads.map((p) => padNet.get(`${c.refdes}.${p}`));
      if (/^R\d/.test(c.refdes) && pads.length === 2) {
        const v = parseValue(c.fields.value, 'resistor');
        if (!v) throw new Error(`${inst.name}:${c.refdes} has a resistor value that cannot be read: "${c.fields.value}"`);
        if (nets[0] && nets[1]) {
          const a = this.rawNet(inst.name, nets[0]);
          const bb = this.rawNet(inst.name, nets[1]);
          if (v.value <= SHORT_OHMS) this.uf.union(a, bb);
          else this.rawPulls.push([a, bb]);
        }
        continue;
      }
      if (fitted.has(c.refdes)) {
        if (pads.length !== 2 || !nets[0] || !nets[1]) {
          throw new Error(`${inst.name}:${c.refdes} is not a connected 2-pin jumper`);
        }
        this.uf.union(this.rawNet(inst.name, nets[0]), this.rawNet(inst.name, nets[1]));
        continue;
      }
      if (/^U\d/.test(c.refdes)) this.unmodelled.push(`${inst.name}:${c.refdes} ${c.fields.value ?? ''}`.trim());
    }
  }

  /** Join pin n of `from` to pin n of each `to` (or by an explicit pad map). Returns the pad pairs joined. */
  addLink(link: LogicLink): number {
    if (this.built) throw new Error('LogicSystem: add links before compiling');
    const [fi, fref] = splitHeader(link.from);
    const a = this.header(fi, fref);
    let joined = 0;
    for (const t of link.to) {
      const [ti, tref] = splitHeader(t);
      const b = this.header(ti, tref);
      const map: [string, string][] =
        link.map && link.map !== 'straight'
          ? Object.entries(link.map)
          : [...a.pads.keys()].map((p) => [p, p] as [string, string]);
      if (!link.map || link.map === 'straight') {
        const pa = [...a.pads.keys()].sort().join(',');
        const pb = [...b.pads.keys()].sort().join(',');
        if (pa !== pb) throw new Error(`${link.from} and ${t} have different pads; give the link an explicit map`);
      }
      for (const [pa, pb] of map) {
        if (!a.pads.has(pa)) throw new Error(`${link.from} has no pad ${pa}`);
        if (!b.pads.has(pb)) throw new Error(`${t} has no pad ${pb}`);
        const na = a.pads.get(pa);
        const nb = b.pads.get(pb);
        if (na && nb) {
          this.uf.union(this.rawNet(fi, na), this.rawNet(ti, nb));
          joined++;
        }
      }
    }
    return joined;
  }

  private header(inst: string, ref: string): { pads: Map<string, string | undefined> } {
    const i = this.instances.get(inst);
    if (!i) throw new Error(`no instance ${inst}`);
    const c = i.board.components.find((x) => x.refdes === ref);
    if (!c) throw new Error(`${inst} has no ${ref}`);
    const net = new Map<string, string>();
    for (const n of i.board.nets) for (const p of n.pins) net.set(p, n.name);
    return { pads: new Map(c.footprint.pads.map((p) => [p.number, net.get(`${ref}.${p.number}`)])) };
  }

  /** Freeze the netlist: canonical dense ids, constants, pulls, parts. */
  compile(): void {
    if (this.built) return;
    this.built = true;
    const rawCount = this.raw.size;
    const rootToId = new Map<number, number>();
    this.canon = new Int32Array(rawCount);
    const members: string[][] = [];
    const byRaw = [...this.raw.entries()].sort((x, y) => x[1] - y[1]);
    for (const [name, rid] of byRaw) {
      const root = this.uf.find(rid);
      let id = rootToId.get(root);
      if (id === undefined) {
        id = members.length;
        rootToId.set(root, id);
        members.push([]);
      }
      this.canon[rid] = id;
      members[id]!.push(name);
    }
    this.netCount = members.length;
    this.names = members.map((m) => m.join('='));
    this.constLevel = new Int8Array(this.netCount).fill(-1);
    for (const [rid, lvl] of this.rawConst) {
      const id = this.canon[rid]!;
      const prev = this.constLevel[id]!;
      if (prev >= 0 && prev !== lvl) throw new Error(`supplies disagree on ${this.names[id]}`);
      this.constLevel[id] = lvl;
    }
    const pulls: number[] = [];
    for (const [a, b] of this.rawPulls) {
      const ca = this.canon[a]!;
      const cb = this.canon[b]!;
      if (ca !== cb) pulls.push(ca, cb);
    }
    this.pulls = Int32Array.from(pulls);
    for (const p of this.rawParts) {
      const pin = new Map<string, number>();
      for (const [n, rid] of p.pin) pin.set(n, rid >= 0 ? this.canon[rid]! : -1);
      const slots = Int32Array.from(SLOTS[p.kind].map((n) => pin.get(n) ?? -1));
      const supplyName = ['VCC', 'VDD'].find((n) => pin.has(n));
      const supply = supplyName ? pin.get(supplyName)! : -2;
      this.parts.push({ inst: p.inst, ref: p.ref, kind: p.kind, pin, gpio: p.gpio, slots, supply });
    }
    const rel = new Set<number>();
    for (let i = 0; i < this.netCount; i++) if (this.constLevel[i]! >= 0) rel.add(i);
    for (const v of pulls) rel.add(v);
    for (const p of this.parts) for (const id of p.pin.values()) if (id >= 0) rel.add(id);
    this.relevant = Int32Array.from([...rel].sort((a, b) => a - b));
  }

  /** Canonical id of "inst:NET", or undefined. */
  netId(inst: string, net: string): number | undefined {
    const rid = this.raw.get(`${inst}:${net}`);
    return rid === undefined ? undefined : this.canon[rid];
  }

  /** Make sure a net is resolved by the evaluator even if no part touches it (a forced MCU pin). */
  markRelevant(id: number): void {
    if (this.relevant.includes(id)) return;
    this.relevant = Int32Array.from([...this.relevant, id].sort((a, b) => a - b));
  }

  emptyInput(): EvalInput {
    return { forced: new Int8Array(this.netCount).fill(-1), registers: new Map() };
  }

  /**
   * Resolve every net for one state. The arrays in the result are reused by
   * the next call: copy them to keep them.
   */
  evaluate(input: EvalInput): EvalResult {
    const n = this.netCount;
    let level = (this.bufA ??= new Int8Array(n)).fill(LZ);
    let next = (this.bufB ??= new Int8Array(n)).fill(LZ);
    const drive = this.scratchDrive ?? (this.scratchDrive = new Uint8Array(n));
    const strong = this.scratchStrong ?? (this.scratchStrong = new Uint8Array(n));
    const weak = this.scratchWeak ?? (this.scratchWeak = new Uint8Array(n));
    const mux = (this.bufMux ??= new Int32Array(this.parts.length)).fill(MUX_OPEN);
    const rel = this.relevant;
    const pulls = this.pulls;
    const consts = this.constLevel;
    const forced = input.forced;
    let contention: number[] = [];

    for (let pass = 0; pass < 64; pass++) {
      for (let k = 0; k < rel.length; k++) drive[rel[k]!] = 0;
      this.driveParts(level, input, drive, mux);
      contention = [];
      for (let k = 0; k < rel.length; k++) {
        const i = rel[k]!;
        const c = consts[i]!;
        const f = forced[i]!;
        weak[i] = 0;
        strong[i] = 1;
        if (c >= 0) next[i] = c;
        else if (f >= 0 && f !== LZ) next[i] = f;
        else if (drive[i]) {
          const d = drive[i]!;
          if ((d & 3) === 3) contention.push(i);
          next[i] = d === 1 ? L0 : d === 2 ? L1 : LX;
        } else strong[i] = 0;
      }
      // Weak pulls from resolved nets. Bits: 1 = toward 0, 2 = toward 1, 8 = toward X.
      for (let k = 0; k < pulls.length; k += 2) {
        const a = pulls[k]!;
        const b = pulls[k + 1]!;
        if (!strong[a] && strong[b]) weak[a]! |= 1 << next[b]!;
        if (!strong[b] && strong[a]) weak[b]! |= 1 << next[a]!;
      }
      let same = true;
      for (let k = 0; k < rel.length; k++) {
        const i = rel[k]!;
        if (!strong[i]) {
          const w = weak[i]!;
          next[i] = w === 0 ? LZ : w === 1 ? L0 : w === 2 ? L1 : LX;
        }
        if (next[i] !== level[i]) same = false;
      }
      if (same) return { level: next, contention, mux };
      const t = level;
      level = next;
      next = t;
    }
    throw new Error('logic did not settle in 64 passes: is there a combinational loop?');
  }

  private bufA?: Int8Array;
  private bufB?: Int8Array;
  private bufMux?: Int32Array;
  private scratchDrive?: Uint8Array;
  private scratchStrong?: Uint8Array;
  private scratchWeak?: Uint8Array;

  private driveParts(level: Int8Array, input: EvalInput, drive: Uint8Array, mux: Int32Array): void {
    // Input read: an unconnected or floating input is X.
    const rd = (id: number): number => {
      if (id < 0) return LX;
      const v = level[id]!;
      return v === LZ ? LX : v;
    };
    const wr = (id: number, v: number): void => {
      if (id >= 0 && v !== LZ) drive[id]! |= v === L0 ? 1 : v === L1 ? 2 : 4;
    };
    const parts = this.parts;
    for (let pi = 0; pi < parts.length; pi++) {
      const p = parts[pi]!;
      const s = p.slots;
      const on = p.supply === -2 || (p.supply >= 0 && level[p.supply] === L1);
      switch (p.kind) {
        case 'mcp23017': {
          // RESET# low (or no power): every GPIO is an input. Otherwise each pin
          // is what the register says: output 0/1, or input (Z).
          const rst = rd(s[0]!);
          const reg = input.registers.get(pi);
          for (let g = 0; g < 16; g++) {
            const want = reg ? reg[g]! : LZ;
            const v = !on || rst === L0 ? LZ : rst === LX ? (want === LZ ? LZ : LX) : want;
            wr(s[1 + g]!, v);
          }
          break;
        }
        case 'hc154': {
          const e1 = rd(s[0]!);
          const e2 = rd(s[1]!);
          let code = 0;
          let known = true;
          for (let i = 0; i < 4; i++) {
            const a = rd(s[2 + i]!);
            if (a === LX) known = false;
            else code |= a << i;
          }
          for (let k = 0; k < 16; k++) {
            const v = !on
              ? LX
              : e1 === L1 || e2 === L1
                ? L1
                : e1 === L0 && e2 === L0 && known
                  ? code === k
                    ? L0
                    : L1
                  : LX;
            wr(s[6 + k]!, v);
          }
          break;
        }
        case 'hc4067': {
          const e = rd(s[0]!);
          let code = 0;
          let known = true;
          for (let i = 0; i < 4; i++) {
            const x = rd(s[1 + i]!);
            if (x === LX) known = false;
            else code |= x << i;
          }
          if (!on) mux[pi] = MUX_UNKNOWN;
          else if (e === L1) mux[pi] = MUX_OPEN;
          else if (e === L0 && known) mux[pi] = s[5 + code]! >= 0 ? s[5 + code]! : MUX_OPEN;
          else mux[pi] = MUX_UNKNOWN;
          break;
        }
        case 'buf125': {
          for (let ch = 0; ch < 4; ch++) {
            const oe = rd(s[3 * ch]!);
            const a = rd(s[3 * ch + 1]!);
            wr(s[3 * ch + 2]!, !on ? LX : oe === L1 ? LZ : oe === L0 ? a : LX);
          }
          break;
        }
        default: {
          const a = rd(s[0]!);
          const b = rd(s[1]!);
          let v: number;
          if (!on) v = LX;
          else if (a === LX || b === LX) {
            // A controlling input decides even when the other is unknown.
            const ctl = p.kind === 'and' || p.kind === 'nand' ? L0 : p.kind === 'or' || p.kind === 'nor' ? L1 : -1;
            if (ctl >= 0 && (a === ctl || b === ctl)) {
              v = p.kind === 'and' ? L0 : p.kind === 'nand' ? L1 : p.kind === 'or' ? L1 : L0;
            } else v = LX;
          } else {
            v =
              p.kind === 'xor' ? a ^ b
              : p.kind === 'and' ? a & b
              : p.kind === 'or' ? a | b
              : p.kind === 'nand' ? 1 - (a & b)
              : 1 - (a | b);
          }
          wr(s[2]!, v);
        }
      }
    }
  }
}

function splitHeader(s: string): [string, string] {
  const i = s.indexOf(':');
  if (i <= 0) throw new Error(`expected "Instance:REF", got "${s}"`);
  return [s.slice(0, i), s.slice(i + 1)];
}

export function isGround(net: string): boolean {
  return GROUND.test(net);
}

/** The board's nets as a pad -> net map (helper for selectors). */
export function padNetMap(b: Board): Map<string, string> {
  const m = new Map<string, string>();
  for (const n of b.nets) for (const p of n.pins) m.set(p, n.name);
  return m;
}
