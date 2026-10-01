/**
 * Board checks as one registry: DRC, ERC, and whatever registers later
 * (interconnect, SPICE, logic simulation). The MCP tools, the export gate and
 * `flamingo check` all run checks through here, so they agree on what a
 * board's findings are.
 *
 * A check is `{ name, description, run(board, ctx) }` returning CheckFinding
 * data. `error` findings gate export; `warn` and `info` never do.
 */

import { createHash } from 'node:crypto';
import {
  fillAllZones,
  runDRC,
  runErc,
  type Board,
  type CheckFinding,
  type DrcViolation,
  type PinLookup,
  type SymbolPin,
} from '@flamingo/engine';
import type { Panel } from '@flamingo/panel';
import { symbolPinsFromCache, type JlcStock } from '@flamingo/parts';
import { checkStock } from './stock.js';

export interface CheckContext {
  /** Symbol pins for parts whose footprint does not carry them. */
  pins: PinLookup;
  /** Look up JLCPCB stock; absent means the stock check is skipped. */
  fetchStock?: (lcsc: string) => Promise<JlcStock>;
  /** Directory of the board file, for checks that read files beside it. */
  boardDir?: string;
}

export interface BoardCheck {
  /** Short id used by `--only` and in findings' `check` field, e.g. 'erc'. */
  name: string;
  description: string;
  run(board: Board, ctx: CheckContext): CheckFinding[] | Promise<CheckFinding[]>;
}

const registry = new Map<string, BoardCheck>();

/** Add (or replace) a check. Order of registration is the order checks run in. */
export function registerCheck(check: BoardCheck): void {
  registry.set(check.name, check);
}

export function registeredChecks(): BoardCheck[] {
  return [...registry.values()];
}

/** DRC violations as findings. Stock advisories become warnings. */
export function drcFindings(violations: DrcViolation[], level: 'error' | 'warn' = 'error'): CheckFinding[] {
  return violations.map((v) => ({ check: 'drc', rule: v.rule, level, message: v.message, at: v.at, items: v.items }));
}

registerCheck({
  name: 'drc',
  description: 'Design rules against the fab ruleset (on the zone-filled board), plus JLCPCB stock when enabled',
  async run(board, ctx) {
    const filled = board.zones.length > 0 ? fillAllZones(board) : board;
    const out = drcFindings(runDRC(filled));
    if (ctx.fetchStock) {
      const stock = await checkStock(board, ctx.fetchStock);
      out.push(...drcFindings(stock.violations), ...drcFindings(stock.advisories, 'warn'));
    }
    return out;
  },
});

registerCheck({
  name: 'erc',
  description: 'Electrical rules on the netlist: power pins, floating inputs, decoupling, polarity, part facts',
  run: (board, ctx) => runErc(board, { pins: ctx.pins }),
});

/** A board on a panel, as panel checks see it. */
export interface PanelBoard {
  /** The panel source key (`S`, `D`, ...). */
  key: string;
  /** Board file, absolute. */
  path: string;
  board: Board;
}

/**
 * A check across the boards of a panel (e.g. the cables between them).
 * Its findings are reported once for the panel, not per board.
 */
export interface PanelCheck {
  name: string;
  description: string;
  run(panel: Panel, boards: PanelBoard[], ctx: CheckContext): CheckFinding[] | Promise<CheckFinding[]>;
}

const panelRegistry = new Map<string, PanelCheck>();

export function registerPanelCheck(check: PanelCheck): void {
  panelRegistry.set(check.name, check);
}

export function registeredPanelChecks(): PanelCheck[] {
  return [...panelRegistry.values()];
}

/** Every check name `--only` accepts: board checks, then panel checks. */
export function knownCheckNames(): string[] {
  return [...registry.keys(), ...panelRegistry.keys()];
}

export class UnknownCheckError extends Error {}

/**
 * Run the registered checks (or only those named) and return every finding.
 * A check that throws is a tool failure, not a finding: the error propagates.
 */
export async function runChecks(board: Board, ctx: CheckContext, only?: string[]): Promise<CheckFinding[]> {
  const checks = registeredChecks();
  assertKnown(only);
  const out: CheckFinding[] = [];
  for (const c of checks) {
    if (only && !only.includes(c.name)) continue;
    out.push(...(await c.run(board, ctx)));
  }
  return out;
}

function assertKnown(only?: string[]): void {
  if (!only) return;
  const known = knownCheckNames();
  const unknown = only.filter((n) => !known.includes(n));
  if (unknown.length > 0) {
    throw new UnknownCheckError(`unknown check(s): ${unknown.join(', ')} (known: ${known.join(', ')})`);
  }
}

/** Run the registered panel checks (or only those named). */
export async function runPanelChecks(
  panel: Panel,
  boards: PanelBoard[],
  ctx: CheckContext,
  only?: string[],
): Promise<CheckFinding[]> {
  assertKnown(only);
  const out: CheckFinding[] = [];
  for (const c of registeredPanelChecks()) {
    if (only && !only.includes(c.name)) continue;
    out.push(...(await c.run(panel, boards, ctx)));
  }
  return out;
}

/** A PinLookup over the parts cache, preloaded for every part on the board. */
export async function boardPinLookup(
  board: Board,
  load: (lcscs: Iterable<string>) => Promise<Map<string, Record<string, SymbolPin>>> = symbolPinsFromCache,
): Promise<PinLookup> {
  const missing = board.components.filter((c) => !c.footprint.pins).map((c) => c.lcsc);
  const pins = await load(missing);
  return (lcsc) => pins.get(lcsc);
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The report written beside fab files and printed by `flamingo check --json`. */
export interface ChecksReport {
  board: string;
  sha256?: string;
  generated: string;
  counts: { error: number; warn: number; info: number };
  findings: CheckFinding[];
}

export function checksReport(board: Board, findings: CheckFinding[], fileSha?: string): ChecksReport {
  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.level]++;
  return {
    board: board.name,
    ...(fileSha ? { sha256: fileSha } : {}),
    generated: new Date().toISOString(),
    counts,
    findings,
  };
}
