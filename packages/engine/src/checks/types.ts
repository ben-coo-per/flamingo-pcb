/**
 * Shared vocabulary for electrical checks (ERC, interconnect, logic, SPICE).
 *
 * DRC answers "can the fab make this?"; these answer "is the circuit right?".
 * Like DRC they report findings as data, never as errors. `error` findings
 * gate export (waivable); `warn` and `info` never gate.
 */

import type { Board, CheckWaiver, ComponentInst, Point, SymbolPin } from '../types.js';

export type { CheckWaiver };

export type CheckLevel = 'error' | 'warn' | 'info';

export interface CheckFinding {
  /** Which check produced it: 'erc', 'interconnect', 'logic', 'spice', ... */
  check: string;
  /** Stable rule id within the check, e.g. 'polarity'. Waivers match on it. */
  rule: string;
  level: CheckLevel;
  message: string;
  /** Where to point at on the board, when there is one place. */
  at?: Point;
  /** Refs the finding is about: "U2.9", "U2", "net:GND". Waivers match on these. */
  items: string[];
}

/** Symbol pins for a part, by LCSC number. Supplied by the caller (the parts cache). */
export type PinLookup = (lcsc: string) => Record<string, SymbolPin> | undefined;

/**
 * Pin names for a placed component: the footprint's own copy when it has one
 * (parts placed since symbol pins were parsed), else the lookup (older boards).
 */
export function componentPins(c: ComponentInst, lookup?: PinLookup): Record<string, SymbolPin> {
  return c.footprint.pins ?? lookup?.(c.lcsc) ?? {};
}

/** "REFDES.PAD" -> net name, for every pad on a net. */
export function pinNetMap(board: Board): Map<string, string> {
  const m = new Map<string, string>();
  for (const n of board.nets) for (const p of n.pins) m.set(p, n.name);
  return m;
}

export function countByLevel(findings: CheckFinding[]): Record<CheckLevel, number> {
  const out: Record<CheckLevel, number> = { error: 0, warn: 0, info: 0 };
  for (const f of findings) out[f.level]++;
  return out;
}

const ORDER: Record<CheckLevel, number> = { error: 0, warn: 1, info: 2 };

/** One line per finding, `ERROR erc/polarity  message`, most severe first. */
export function formatFindings(findings: CheckFinding[], opts: { quiet?: boolean } = {}): string {
  const lines = [...findings]
    .sort((a, b) => ORDER[a.level] - ORDER[b.level] || a.check.localeCompare(b.check))
    .filter((f) => !(opts.quiet && f.level === 'info'))
    .map((f) => `${f.level.toUpperCase().padEnd(5)}  ${`${f.check}/${f.rule}`.padEnd(26)} ${f.message}`);
  const c = countByLevel(findings);
  lines.push(`-- ${c.error} errors, ${c.warn} warnings, ${c.info} info`);
  return lines.join('\n');
}

export function applyWaivers(
  findings: CheckFinding[],
  waivers: CheckWaiver[] | undefined,
): { kept: CheckFinding[]; waived: { finding: CheckFinding; waiver: CheckWaiver }[] } {
  const kept: CheckFinding[] = [];
  const waived: { finding: CheckFinding; waiver: CheckWaiver }[] = [];
  for (const f of findings) {
    const w = (waivers ?? []).find(
      (w) =>
        w.rule === f.rule && (!w.check || w.check === f.check) && w.items.every((i) => f.items.includes(i)),
    );
    if (w) waived.push({ finding: f, waiver: w });
    else kept.push(f);
  }
  return { kept, waived };
}
