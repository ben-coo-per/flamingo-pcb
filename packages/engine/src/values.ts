/**
 * Component values as numbers.
 *
 * `fields.value` is free text ("4.7k", "100nF", "100uF 35V", "2A 30V", "33R").
 * Electrical checks need numbers: the size of a pull resistor, the bulk
 * capacitance on a rail, every R and C for a SPICE netlist. `parseValue`
 * returns null for anything it cannot read with certainty -- never a guess.
 */

export type ValueUnit = 'ohm' | 'F' | 'H' | 'V' | 'A' | 'W' | 'Hz';
export type ValueKind = 'resistor' | 'capacitor' | 'inductor' | 'fuse' | 'other';

export interface ParsedValue {
  /** The primary quantity in SI base units (ohms, farads, henries, amps for a fuse). */
  value: number;
  unit: ValueUnit;
  /** Further ratings found after the primary value, e.g. { V: 35 } for "100uF 35V". */
  ratings: Partial<Record<ValueUnit, number>>;
}

const PREFIX: Record<string, number> = {
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  µ: 1e-6,
  μ: 1e-6,
  m: 1e-3,
  '': 1,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
};

const PRIMARY: Record<ValueKind, ValueUnit | null> = {
  resistor: 'ohm',
  capacitor: 'F',
  inductor: 'H',
  fuse: 'A',
  other: null,
};

/** Kind from the reference designator's letter prefix (R1 -> resistor). */
export function kindFromRefdes(refdes: string): ValueKind {
  const p = /^[A-Za-z]+/.exec(refdes)?.[0]?.toUpperCase() ?? '';
  if (p === 'R' || p === 'RN') return 'resistor';
  if (p === 'C') return 'capacitor';
  if (p === 'L' || p === 'FB') return 'inductor';
  if (p === 'F') return 'fuse';
  return 'other';
}

function unitOf(token: string): ValueUnit | null {
  const t = token.toLowerCase();
  if (t === 'r' || t === 'ohm' || t === 'ohms' || t === 'Ω'.toLowerCase()) return 'ohm';
  if (t === 'f') return 'F';
  if (t === 'h') return 'H';
  if (t === 'v') return 'V';
  if (t === 'a') return 'A';
  if (t === 'w') return 'W';
  if (t === 'hz') return 'Hz';
  return null;
}

/**
 * One token: "4.7k", "4k7", "2R2", "100nF", "35V", "0R", "1.1A".
 * Returns the number and the unit written on it (if any).
 */
function parseToken(tok: string): { n: number; unit: ValueUnit | null } | null {
  // Infix style: 4k7, 2R2, 1M5, 4n7.
  let m = /^(\d+)([pnuµμmkKMGR])(\d+)([A-Za-zΩ]*)$/.exec(tok);
  if (m) {
    const [, a, p, b, u] = m;
    const mult = p === 'R' ? 1 : PREFIX[p!]!;
    const unit = p === 'R' ? 'ohm' : u ? unitOf(u) : null;
    if (u && !unit) return null;
    return { n: Number(`${a}.${b}`) * mult, unit };
  }
  m = /^(\d+(?:\.\d+)?|\.\d+)\s*([pnuµμmkKMG]?)(ohms?|Ω|Hz|[RFHVAW]?)$/i.exec(tok);
  if (!m) return null;
  const [, num, p, u] = m;
  // "m" before a unit is milli; a lone "M" is mega. Case matters for m/M only.
  const mult = PREFIX[p!];
  if (mult === undefined) return null;
  const unit = u ? unitOf(u) : null;
  if (u && !unit) return null;
  return { n: Number(num) * mult, unit };
}

/**
 * Parse `text` as a value of `kind`. The first token is the primary value;
 * later tokens with an explicit unit are ratings. Returns null when the
 * primary value cannot be read, or carries a unit that contradicts `kind`.
 */
export function parseValue(text: string | undefined, kind: ValueKind): ParsedValue | null {
  if (!text) return null;
  const tokens = text
    .replace(/(\d)\s+(?=[pnuµμmkKMG]?(?:F|H|V|A|ohm|Ω)\b)/g, '$1') // "100 nF" -> "100nF"
    .split(/[\s,/]+/)
    .filter(Boolean);
  if (tokens.length === 0) return null;
  const first = parseToken(tokens[0]!);
  if (!first) return null;
  const expected = PRIMARY[kind];
  const unit = first.unit ?? expected;
  if (!unit) return null;
  if (expected && unit !== expected) return null;
  const ratings: ParsedValue['ratings'] = {};
  for (const t of tokens.slice(1)) {
    const r = parseToken(t);
    if (r?.unit && r.unit !== unit) ratings[r.unit] = r.n;
  }
  return { value: first.n, unit, ratings };
}

/** Format a number with an SI prefix, e.g. 4700 -> "4.7k". */
export function formatSi(n: number, unit = ''): string {
  if (n === 0) return `0${unit}`;
  const steps: [number, string][] = [
    [1e9, 'G'],
    [1e6, 'M'],
    [1e3, 'k'],
    [1, ''],
    [1e-3, 'm'],
    [1e-6, 'u'],
    [1e-9, 'n'],
    [1e-12, 'p'],
  ];
  const a = Math.abs(n);
  const [mult, p] = steps.find(([m]) => a >= m * 0.9995) ?? steps[steps.length - 1]!;
  const v = n / mult;
  return `${Number(v.toPrecision(3))}${p}${unit}`;
}
