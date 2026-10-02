/**
 * SPICE netlists from a board.
 *
 * `exportSpice` writes the passive parts (R, C, L, D, F) on a set of nets as
 * a netlist fragment: values come from the board, anything that cannot be
 * read becomes a named .param to fill in, and nothing is invented. Add
 * sources, models of the ICs and an analysis to simulate it, or use a
 * template (templates.ts), which does that for the circuits that recur.
 *
 * The helpers below (`wrapNetlist`, `ribbon`, `pwl`) are shared by the templates.
 */

import type { Board, ComponentInst } from '../types.js';
import { componentPins, type PinLookup } from '../checks/types.js';
import { kindFromRefdes, parseValue } from '../values.js';
import { isGroundNet } from './util.js';

export interface ExportSpiceOpts {
  /** Nets to include (every part with a pad on one of them). Default: every net. */
  nets?: string[];
  /** Symbol pins for diode orientation on older boards. */
  pins?: PinLookup;
  title?: string;
}

/** A SPICE node name for a net: ground nets are node 0. */
export function spiceNode(net: string): string {
  if (isGroundNet(net)) return '0';
  const s = net.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[0-9]/.test(s) ? `n_${s}` : s;
}

const num = (v: number): string => Number(v.toPrecision(6)).toString();

export function exportSpice(board: Board, opts: ExportSpiceOpts = {}): string {
  const want = opts.nets ? new Set(opts.nets) : undefined;
  if (want) {
    for (const n of want) {
      if (!board.nets.some((x) => x.name === n)) throw new Error(`${board.name}: no net ${n}`);
    }
  }
  const padNet = new Map<string, string>();
  for (const n of board.nets) for (const pin of n.pins) padNet.set(pin, n.name);
  const lines: string[] = [
    `* ${opts.title ?? `${board.name}: passive parts${want ? ` on ${[...want].join(', ')}` : ''}`}`,
    '* Exported by Flamingo from the board file. Ground nets are node 0.',
    '* Add sources, IC models and an analysis to simulate.',
  ];
  const params: string[] = [];
  const models = new Set<string>();
  const parts: string[] = [];
  const skipped: string[] = [];
  const sorted = [...board.components].sort((a, b) => a.refdes.localeCompare(b.refdes, 'en', { numeric: true }));
  for (const c of sorted) {
    const nets = c.footprint.pads.map((p) => padNet.get(`${c.refdes}.${p.number}`));
    if (want && !nets.some((n) => n && want.has(n))) continue;
    const kind = kindFromRefdes(c.refdes);
    const isDiode = /^(D|LED)\d/i.test(c.refdes);
    if (c.footprint.pads.length !== 2 || !(kind !== 'other' || isDiode)) {
      if (want) skipped.push(`${c.refdes} (${c.fields.value ?? ''})`);
      continue;
    }
    const node = (i: number): string => {
      const n = nets[i];
      return n ? spiceNode(n) : `nc_${c.refdes}_${c.footprint.pads[i]!.number}`;
    };
    if (isDiode) {
      const order = diodeOrder(c, opts.pins);
      const model = `D_${(c.lcsc || 'generic').replace(/\W/g, '_')}`;
      models.add(`.model ${model} D(IS=1e-14 N=1) ; generic placeholder for ${c.fields.value ?? c.lcsc}: replace with the part's model`);
      if (!order) {
        parts.push(`* ${c.refdes}: anode and cathode unknown (no A/K pin names); pads ${c.footprint.pads.map((p) => p.number).join(', ')} -> ${node(0)} ${node(1)}`);
        parts.push(`D${c.refdes} ${node(0)} ${node(1)} ${model}`);
      } else {
        parts.push(`D${c.refdes} ${node(order[0])} ${node(order[1])} ${model} ; ${c.fields.value ?? ''}`.trimEnd());
      }
      continue;
    }
    const letter = kind === 'resistor' || kind === 'fuse' ? 'R' : kind === 'capacitor' ? 'C' : 'L';
    const v = parseValue(c.fields.value, kind);
    let val: string;
    if (kind === 'fuse') {
      const key = `r_${c.refdes}`;
      params.push(`.param ${key}=0.05 ; ${c.refdes} ${c.fields.value ?? ''}: fuse rating, not a resistance; cold resistance assumed`);
      val = `{${key}}`;
    } else if (v) {
      val = num(v.value);
    } else {
      const key = `val_${c.refdes}`;
      params.push(`.param ${key}=0 ; ${c.refdes} value "${c.fields.value ?? ''}" cannot be read: set it`);
      val = `{${key}}`;
    }
    const name = c.refdes.startsWith(letter) ? c.refdes : `${letter}${c.refdes}`;
    parts.push(`${name} ${node(0)} ${node(1)} ${val}`);

  }
  if (params.length) lines.push('', ...params);
  if (models.size) lines.push('', ...models);
  lines.push('', ...parts);
  if (skipped.length) lines.push('', `* Not exported (not two-pad passives): ${skipped.join(', ')}`);
  return lines.join('\n') + '\n';
}

/** [anode pad index, cathode pad index] from symbol pin names A/K, or null. */
function diodeOrder(c: ComponentInst, pins?: PinLookup): [number, number] | null {
  const names = componentPins(c, pins);
  const pads = c.footprint.pads.map((p) => (names[p.number]?.name ?? '').toUpperCase());
  const a = pads.findIndex((n) => n === 'A' || n === '+' || n === 'ANODE');
  const k = pads.findIndex((n) => n === 'K' || n === 'C' || n === '-' || n === 'CATHODE');
  return a >= 0 && k >= 0 && a !== k ? [a, k] : null;
}

// ---------------------------------------------------------------------------
// Template helpers
// ---------------------------------------------------------------------------

/**
 * A complete ngspice deck: the circuit, then a .control block that runs the
 * analysis and writes `vectors` with wrdata to <name>.csv in the working
 * directory. Measurement happens on the written waveforms, so a threshold
 * that is never crossed is a finding about the board, not a failed run.
 */
export function wrapNetlist(opts: {
  title: string;
  name: string;
  body: string[];
  analysis: string;
  vectors: string[];
  models?: string[];
  options?: string;
  comments?: string[];
}): string {
  return [
    `* ${opts.title}`,
    ...(opts.comments ?? []).map((c) => `* ${c}`),
    ...opts.body,
    ...(opts.models ?? []),
    `.options noacct ${opts.options ?? ''}`.trimEnd(),
    '.control',
    opts.analysis,
    'set wr_singlescale',
    'set wr_vecnames',
    'option numdgt=9',
    `wrdata ${opts.name}.csv ${opts.vectors.join(' ')}`,
    'quit',
    '.endc',
    '.end',
    '',
  ].join('\n');
}

/** A flat-cable conductor as an R-L-C ladder from node a to node b. */
export function ribbon(
  tag: string,
  a: string,
  b: string,
  length: number,
  perM: { r: number; l: number; c: number },
  segsPerM = 10,
): string[] {
  const n = Math.max(1, Math.round(length * segsPerM));
  const out: string[] = [];
  let prev = a;
  for (let i = 0; i < n; i++) {
    const mid = `rib${tag}m${i}`;
    const nxt = i === n - 1 ? b : `rib${tag}n${i}`;
    out.push(
      `Rrib${tag}${i} ${prev} ${mid} ${num((perM.r * length) / n)}`,
      `Lrib${tag}${i} ${mid} ${nxt} ${num((perM.l * length) / n)}`,
      `Crib${tag}${i} ${nxt} 0 ${num((perM.c * length) / n)}`,
    );
    prev = nxt;
  }
  return out;
}

/** (start time, level) for 8N1 UART frames, LSB first, idle high. */
export function uartBits(data: number[], bit: number, idle: number): [number, number][] {
  const out: [number, number][] = [[0, 1]];
  let t = idle;
  for (const byte of data) {
    const frame = [0, ...Array.from({ length: 8 }, (_, i) => (byte >> i) & 1), 1];
    for (const b of frame) {
      out.push([t, b]);
      t += bit;
    }
  }
  out.push([t, 1]);
  return out;
}

/** A PWL source following `bits` between 0 and vhigh, with `edge` rise/fall. */
export function pwl(bits: [number, number][], vhigh: number, edge = 5e-9): string {
  let level = bits[0]![1];
  const pts: [number, number][] = [[0, level * vhigh]];
  for (const [t, b] of bits.slice(1)) {
    if (b === level) continue;
    pts.push([t, level * vhigh], [t + edge, b * vhigh]);
    level = b;
  }
  return `PWL(${pts.map(([t, y]) => `${Number(t.toPrecision(9))} ${Number(y.toPrecision(4))}`).join(' ')})`;
}

export { num as spiceNum };
