/**
 * ngspice `wrdata` output (written with wr_singlescale and wr_vecnames), and
 * measurements on it: crossings, extremes, means.
 */

export class Wave {
  readonly x: number[];

  constructor(readonly cols: Record<string, number[]>) {
    const first = Object.values(cols)[0];
    if (!first) throw new Error('wave has no columns');
    this.x = first;
  }

  static parse(text: string, label = 'wrdata'): Wave {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) throw new Error(`${label}: no data rows`);
    const names = lines[0]!.trim().split(/\s+/);
    const cols: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, []]));
    for (const ln of lines.slice(1)) {
      const parts = ln.trim().split(/\s+/);
      if (parts.length !== names.length) continue;
      parts.forEach((v, i) => cols[names[i]!]!.push(Number(v)));
    }
    return new Wave(cols);
  }

  col(name: string): number[] {
    const c = this.cols[name] ?? this.cols[`v(${name})`];
    if (!c) throw new Error(`no column ${name}; have ${Object.keys(this.cols).join(', ')}`);
    return c;
  }

  /** Linear interpolation of column `name` at x = t. */
  at(name: string, t: number): number {
    const y = this.col(name);
    const xs = this.x;
    let lo = 0;
    let hi = xs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid]! < t) lo = mid + 1;
      else hi = mid;
    }
    if (lo <= 0) return y[0]!;
    if (lo >= xs.length) return y[y.length - 1]!;
    const x0 = xs[lo - 1]!;
    const x1 = xs[lo]!;
    if (x1 === x0) return y[lo]!;
    return y[lo - 1]! + ((y[lo]! - y[lo - 1]!) * (t - x0)) / (x1 - x0);
  }

  window(name: string, t0 = -Infinity, t1 = Infinity): number[] {
    const y = this.col(name);
    return y.filter((_, i) => this.x[i]! >= t0 && this.x[i]! <= t1);
  }

  min(name: string, t0?: number, t1?: number): number {
    return Math.min(...this.window(name, t0, t1));
  }

  max(name: string, t0?: number, t1?: number): number {
    return Math.max(...this.window(name, t0, t1));
  }

  /** First x after `after` where `name` crosses `level` in the given direction, or null. */
  cross(name: string, level: number, rising: boolean, after = -Infinity): number | null {
    const y = this.col(name);
    for (let i = 1; i < this.x.length; i++) {
      if (this.x[i]! <= after) continue;
      const a = y[i - 1]!;
      const b = y[i]!;
      if (rising ? a < level && level <= b : a > level && level >= b) {
        return this.x[i - 1]! + ((level - a) * (this.x[i]! - this.x[i - 1]!)) / (b - a);
      }
    }
    return null;
  }
}

/**
 * Results printed by an ngspice batch run: `.measure` lines
 * ("tr = 3.0e-07 targ= ... trig= ...") and `echo "RESULT name value"` lines.
 * Measurements that failed are reported by name with NaN.
 */
export function parseMeasures(log: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const raw of log.split(/\r?\n/)) {
    const line = raw.trim();
    let m = /^RESULT\s+(\S+)\s+(\S+)$/.exec(line);
    if (m) {
      const v = Number(m[2]);
      if (Number.isFinite(v)) out[m[1]!] = v;
      continue;
    }
    // A .measure result: "name = value", then the end of the line or the
    // measurement's own fields (targ=, trig=, at=, from=, ...). That keeps
    // ngspice's statistics ("Stack = 0 bytes.") out.
    m = /^([A-Za-z_][\w.]*)\s*=\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(?:$|(?:targ|trig|at|from|to|when)\s*=)/i.exec(line);
    if (m) {
      out[m[1]!.toLowerCase()] = Number(m[2]);
      continue;
    }
    // A failed one: "Error: measure  tf  trig(TRIG) : out of interval", or
    // ".measure tran tf trig ... failed!".
    m = /^Error:\s*measure\s+(\S+)/i.exec(line) ?? /^\.meas\w*\s+\w+\s+(\S+)\s.*\bfailed/i.exec(line);
    if (m && !(m[1]!.toLowerCase() in out)) out[m[1]!.toLowerCase()] = NaN;
  }
  return out;
}
