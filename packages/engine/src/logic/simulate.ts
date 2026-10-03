/**
 * Netlist-driven logic simulation: enumerate free signals, check invariants.
 *
 * Every combination of the free signals is evaluated (or, past `maxStates`,
 * a seeded random sample of them, and the report says so). An invariant that
 * fails in any state is reported with one counterexample state.
 */

import type { CheckFinding, PinLookup } from '../checks/types.js';
import type {
  Cond,
  FreeSignal,
  Invariant,
  InvariantResult,
  Level,
  LogicReport,
  LogicSpec,
} from './types.js';
import { L0, LEVEL, LX, LZ, LogicSystem, MUX_OPEN, padNetMap, toCode, type EvalResult } from './system.js';

export const DEFAULT_MAX_STATES = 2_000_000;

export interface SimulateOpts {
  pins?: PinLookup;
  /** Past this many states, sample instead of enumerating (default 2,000,000). */
  maxStates?: number;
  seed?: number;
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

interface SelItem {
  id: number;
  inst: string;
  label: string;
  /** The number captured by {i}, when the selector has one. */
  index?: number;
}

function globRegex(glob: string): { re: RegExp; captures: boolean } {
  let src = '';
  let captures = false;
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (glob.startsWith('{i}', i)) {
      src += '(\\d+)';
      captures = true;
      i += 2;
    } else if (ch === '*') src += '.*';
    else if (ch === '?') src += '.';
    else src += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return { re: new RegExp(`^${src}$`, 'i'), captures };
}

function splitSel(sel: string): [string, string] {
  const i = sel.indexOf(':');
  if (i <= 0) throw new Error(`selector "${sel}" must look like "instance:NET" or "instance:REF.PIN"`);
  return [sel.slice(0, i), sel.slice(i + 1)];
}

/** Resolve a net or pin selector to canonical nets (deduplicated per instance). */
export function resolveSelector(sys: LogicSystem, sel: string): SelItem[] {
  const [instGlob, rest] = splitSel(sel);
  const ire = globRegex(instGlob).re;
  const out: SelItem[] = [];
  const seen = new Set<string>();
  const push = (it: SelItem) => {
    const k = `${it.inst}#${it.id}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(it);
    }
  };
  for (const [name, inst] of sys.instances) {
    if (!ire.test(name)) continue;
    const b = inst.board;
    const dot = rest.lastIndexOf('.');
    let matchedPin = false;
    if (dot > 0) {
      const { re: rre } = globRegex(rest.slice(0, dot));
      const pinSpec = rest.slice(dot + 1);
      const comps = b.components.filter((c) => rre.test(c.refdes));
      if (comps.length > 0) {
        matchedPin = true;
        const nets = padNetMap(b);
        for (const c of comps) {
          const m = globRegex(rest.slice(0, dot)).re.exec(c.refdes);
          const index = m && m[1] !== undefined ? Number(m[1]) : undefined;
          const names = sys.componentPinNames(c);
          const pads = c.footprint.pads.some((p) => p.number === pinSpec)
            ? [pinSpec]
            : Object.entries(names)
                .filter(([, n]) => n === pinSpec.toUpperCase())
                .map(([p]) => p);
          for (const pad of pads) {
            const net = nets.get(`${c.refdes}.${pad}`);
            if (!net) continue;
            const id = sys.netId(name, net);
            if (id !== undefined) push({ id, inst: name, label: `${name}:${c.refdes}.${pinSpec}`, ...(index !== undefined ? { index } : {}) });
          }
        }
      }
    }
    if (!matchedPin) {
      const { re } = globRegex(rest);
      for (const n of b.nets) {
        const m = re.exec(n.name);
        if (!m) continue;
        const id = sys.netId(name, n.name);
        if (id !== undefined) push({ id, inst: name, label: `${name}:${n.name}`, ...(m[1] !== undefined ? { index: Number(m[1]) } : {}) });
      }
    }
  }
  return out;
}

function resolveParts(sys: LogicSystem, sel: string, kind?: string): number[] {
  const [instGlob, refGlob] = splitSel(sel);
  const ire = globRegex(instGlob).re;
  const rre = globRegex(refGlob).re;
  return sys.parts
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => ire.test(p.inst) && rre.test(p.ref) && (!kind || p.kind === kind))
    .map(({ i }) => i);
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

type CompiledCond = (r: EvalResult) => boolean;

function compileCond(sys: LogicSystem, c: Cond): CompiledCond {
  const nets = (sel: string): number[] => {
    const items = resolveSelector(sys, sel);
    if (items.length === 0) throw new Error(`selector "${sel}" matches no net`);
    for (const it of items) sys.markRelevant(it.id);
    return items.map((i) => i.id);
  };
  if ('net' in c) {
    const ids = nets(c.net);
    const allowed = new Set((Array.isArray(c.is) ? c.is : [c.is]).map(toCode));
    return (r) => ids.every((i) => allowed.has(r.level[i]!));
  }
  if ('anyLow' in c) {
    const ids = nets(c.anyLow);
    return (r) => ids.some((i) => r.level[i] === L0);
  }
  if ('noneLow' in c) {
    const ids = nets(c.noneLow);
    return (r) => !ids.some((i) => r.level[i] === L0);
  }
  if ('atMostOneLow' in c) {
    const ids = nets(c.atMostOneLow);
    const allowFloating = c.allowFloating ?? false;
    return (r) => {
      let lows = 0;
      for (const i of ids) {
        const v = r.level[i]!;
        if (v === L0) lows++;
        else if (!allowFloating && (v === LX || v === LZ)) return false;
      }
      return lows <= 1;
    };
  }
  if ('noneFloating' in c) {
    const ids = nets(c.noneFloating);
    return (r) => ids.every((i) => r.level[i] !== LX && r.level[i] !== LZ);
  }
  if ('atMostOneConnected' in c) {
    const parts = resolveParts(sys, c.atMostOneConnected, 'hc4067');
    if (parts.length === 0) throw new Error(`selector "${c.atMostOneConnected}" matches no analog mux`);
    return (r) => {
      let on = 0;
      for (const p of parts) if (r.mux[p] !== MUX_OPEN) on++;
      return on <= 1;
    };
  }
  if ('all' in c) {
    const cs = c.all.map((x) => compileCond(sys, x));
    return (r) => cs.every((f) => f(r));
  }
  if ('any' in c) {
    const cs = c.any.map((x) => compileCond(sys, x));
    return (r) => cs.some((f) => f(r));
  }
  if ('not' in c) {
    const f = compileCond(sys, c.not);
    return (r) => !f(r);
  }
  throw new Error(`unknown condition ${JSON.stringify(c)}`);
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

interface CompiledInvariant {
  name: string;
  level: 'error' | 'warn';
  /** Returns false when the state violates the invariant. */
  check(r: EvalResult): boolean;
  /** Post-enumeration verdict for reachability invariants. */
  finish?(): { pass: boolean; failures: number; counterexample?: string };
  failures: number;
  counterexample?: string;
  detail?: string;
}

function compileInvariant(sys: LogicSystem, inv: Invariant): CompiledInvariant {
  const level = inv.level ?? 'error';
  const base = { name: inv.name, level, failures: 0 };
  if ('assert' in inv) {
    const when = inv.when ? compileCond(sys, inv.when) : () => true;
    const assert = compileCond(sys, inv.assert);
    return { ...base, check: (r) => !when(r) || assert(r) };
  }
  if ('selectFollows' in inv) {
    const { enable, mux, channel } = inv.selectFollows;
    const en = resolveSelector(sys, enable);
    const ch = resolveSelector(sys, channel);
    const muxes = resolveParts(sys, mux, 'hc4067');
    if (en.length === 0 || ch.length === 0 || muxes.length === 0) {
      throw new Error(`selectFollows "${inv.name}": enable, channel or mux matches nothing`);
    }
    if (en.some((e) => e.index === undefined)) throw new Error(`selectFollows "${inv.name}": enable needs {i}`);
    for (const it of [...en, ...ch]) sys.markRelevant(it.id);
    const groups = muxes.map((m) => {
      const inst = sys.parts[m]!.inst;
      const chan = new Map(ch.filter((c) => c.inst === inst).map((c) => [c.index!, c.id]));
      return { m, enables: en.filter((e) => e.inst === inst), chan };
    });
    return {
      ...base,
      check: (r) => {
        for (const g of groups) {
          let low: SelItem | undefined;
          let count = 0;
          for (const e of g.enables) {
            if (r.level[e.id] === L0) {
              low = e;
              count++;
            }
          }
          if (count !== 1) continue;
          const want = g.chan.get(low!.index!);
          if (want === undefined || r.mux[g.m] !== want) return false;
        }
        return true;
      },
    };
  }
  const items = resolveSelector(sys, inv.eachCanBeLowAlone);
  if (items.length === 0) throw new Error(`eachCanBeLowAlone "${inv.name}" matches no net`);
  for (const it of items) sys.markRelevant(it.id);
  const reached = new Set<number>();
  return {
    ...base,
    check: (r) => {
      let only = -1;
      for (let k = 0; k < items.length; k++) {
        const v = r.level[items[k]!.id]!;
        if (v === L0) {
          if (only >= 0) return true;
          only = k;
        } else if (v !== 1) return true; // X or Z elsewhere: not a clean state
      }
      if (only >= 0) reached.add(only);
      return true;
    },
    finish: () => {
      const missing = items.filter((_, k) => !reached.has(k)).map((i) => i.label);
      return missing.length
        ? { pass: false, failures: missing.length, counterexample: `never the only low one: ${missing.join(', ')}` }
        : { pass: true, failures: 0 };
    },
  };
}

// ---------------------------------------------------------------------------
// Free signals
// ---------------------------------------------------------------------------

interface FreeVar {
  label: string;
  levels: number[];
  apply(input: { forced: Int8Array; registers: Map<number, Int8Array> }, level: number): void;
}

function compileFree(sys: LogicSystem, f: FreeSignal): FreeVar[] {
  const levels = (f.levels ?? (['0', '1', 'Z'] as Level[])).map(toCode);
  if ('net' in f) {
    const items = resolveSelector(sys, f.net);
    if (items.length !== 1) throw new Error(`free signal "${f.net}" must match exactly one net (matched ${items.length})`);
    const id = items[0]!.id;
    sys.markRelevant(id);
    return [{ label: f.net, levels, apply: (inp, l) => void (inp.forced[id] = l) }];
  }
  const parts = resolveParts(sys, f.register, 'mcp23017');
  if (parts.length === 0) throw new Error(`free register "${f.register}" matches no MCP23017`);
  const out: FreeVar[] = [];
  for (const pi of parts) {
    const p = sys.parts[pi]!;
    const pins =
      f.pins === 'connected' ? p.gpio.filter((g) => (p.pin.get(g) ?? -1) >= 0) : f.pins.map((x) => x.toUpperCase());
    for (const pin of pins) {
      const g = p.gpio.indexOf(pin);
      if (g < 0) throw new Error(`${p.inst}:${p.ref} has no GPIO ${pin}`);
      out.push({
        label: `${p.inst}:${p.ref}.${pin}`,
        levels,
        apply: (inp, l) => {
          let reg = inp.registers.get(pi);
          if (!reg) {
            reg = new Int8Array(p.gpio.length).fill(LZ);
            inp.registers.set(pi, reg);
          }
          reg[g] = l;
        },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/** Build the system for a spec (exported for tools that want to inspect it). */
export function buildLogicSystem(spec: LogicSpec, pins?: PinLookup): LogicSystem {
  const sys = new LogicSystem(pins);
  for (const inst of spec.instances) sys.addInstance(inst);
  for (const l of spec.links ?? []) sys.addLink(l);
  sys.compile();
  return sys;
}

export function simulateLogic(spec: LogicSpec, opts: SimulateOpts = {}): { report: LogicReport; findings: CheckFinding[] } {
  const sys = buildLogicSystem(spec, opts.pins);
  const vars = spec.free.flatMap((f) => compileFree(sys, f));
  const invs = spec.invariants.map((i) => compileInvariant(sys, i));
  if (spec.checkContention ?? true) {
    let where = '';
    invs.unshift({
      name: 'no net is driven high and low at once',
      level: 'error',
      failures: 0,
      check: (r) => {
        if (r.contention.length === 0) return true;
        where = r.contention.map((i) => sys.names[i]).join(', ');
        return false;
      },
      get detail() {
        return where ? `contention on ${where}` : undefined;
      },
    });
  }

  const total = vars.reduce((n, v) => n * v.levels.length, 1);
  const maxStates = opts.maxStates ?? DEFAULT_MAX_STATES;
  const sampled = total > maxStates;
  const states = sampled ? maxStates : total;
  let seed = (opts.seed ?? 1) >>> 0;
  const rand = (n: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };

  const choice = new Array<number>(vars.length).fill(0);
  const describe = (): string =>
    vars.map((v, k) => `${v.label}=${LEVEL[v.levels[choice[k]!]!]}`).join(', ');

  // One input reused for every state: each free variable overwrites its own slot.
  const input = sys.emptyInput();
  for (let s = 0; s < states; s++) {
    if (sampled) for (let k = 0; k < vars.length; k++) choice[k] = rand(vars[k]!.levels.length);
    for (let k = 0; k < vars.length; k++) vars[k]!.apply(input, vars[k]!.levels[choice[k]!]!);
    const r = sys.evaluate(input);
    for (const inv of invs) {
      if (!inv.check(r)) {
        inv.failures++;
        if (!inv.counterexample) inv.counterexample = describe() || '(no free signals)';
      }
    }
    if (!sampled) {
      // odometer
      for (let k = vars.length - 1; k >= 0; k--) {
        choice[k]!++;
        if (choice[k]! < vars[k]!.levels.length) break;
        choice[k] = 0;
      }
    }
  }

  const results: InvariantResult[] = invs.map((inv) => {
    const fin = inv.finish?.();
    const pass = fin ? fin.pass : inv.failures === 0;
    const failures = fin ? fin.failures : inv.failures;
    const counterexample = fin ? fin.counterexample : inv.counterexample;
    return {
      name: inv.name,
      level: inv.level,
      pass,
      failures,
      ...(counterexample && !pass ? { counterexample } : {}),
      ...(inv.detail && !pass ? { detail: inv.detail } : {}),
    };
  });
  const report: LogicReport = {
    states,
    sampled,
    totalStates: total,
    results,
    modelled: sys.parts.map((p) => `${p.inst}:${p.ref} ${p.kind}`),
    unmodelled: sys.unmodelled,
  };
  return { report, findings: logicFindings(report) };
}

export function logicFindings(report: LogicReport): CheckFinding[] {
  const out: CheckFinding[] = [];
  const how = report.sampled
    ? `${report.states.toLocaleString('en')} sampled of ${report.totalStates.toLocaleString('en')} states`
    : `${report.states.toLocaleString('en')} states`;
  for (const r of report.results) {
    if (r.pass) {
      out.push({ check: 'logic', rule: r.name, level: 'info', message: `pass ${r.name} (${how})`, items: [r.name] });
    } else {
      const extra = r.detail ? `; ${r.detail}` : '';
      out.push({
        check: 'logic',
        rule: r.name,
        level: r.level,
        message: `FAIL ${r.name}: ${r.failures} ${r.counterexample?.startsWith('never') ? 'nets' : 'states'}, e.g. ${r.counterexample}${extra}`,
        items: [r.name],
      });
    }
  }
  out.push({
    check: 'logic',
    rule: 'model',
    level: 'info',
    message: `modelled ${report.modelled.join(', ') || 'nothing'}; not modelled: ${report.unmodelled.join(', ') || 'none'}`,
    items: [],
  });
  return out;
}
