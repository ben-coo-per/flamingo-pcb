/**
 * Flamingo UI - the Checks workspace's pure logic: no DOM, no fetch.
 *
 * The drawer (drawer.ts) keeps a `ChecksModel` per board session and asks
 * this module how to filter, group, summarise and mark it. Everything here
 * is deterministic so it is unit-tested directly (test/checks-model.test.ts).
 */

import type { Board, Point } from '@flamingo/engine';
import { padOutline } from '@flamingo/engine';
import type { CheckFinding, CheckInfo, CheckLevel, CheckRunResult, WaivedFinding } from './types.js';

export const LEVELS: readonly CheckLevel[] = ['error', 'warn', 'info'];
const LEVEL_ORDER: Record<CheckLevel, number> = { error: 0, warn: 1, info: 2 };

/** Where one check stands in the drawer. */
export type CheckRun =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; result: CheckRunResult; at: number; sig: string }
  | { status: 'failed'; error: string };

export interface ChecksModel {
  checks: CheckInfo[];
  runs: Record<string, CheckRun>;
}

export function emptyModel(checks: CheckInfo[] = []): ChecksModel {
  return { checks, runs: Object.fromEntries(checks.map((c) => [c.name, { status: 'idle' } as CheckRun])) };
}

/** The checks a "Run selected" starts with: everything that doesn't need the network. */
export function defaultSelection(checks: CheckInfo[]): Set<string> {
  return new Set(checks.filter((c) => !c.network).map((c) => c.name));
}

/** A stable identity for a finding, used for marker focus and DOM keys. */
export function findingKey(f: CheckFinding): string {
  return [f.check, f.rule, f.items.join(','), f.message].join('|');
}

/** Findings and waived findings of every finished run, in registry order. */
export function collect(model: ChecksModel): { findings: CheckFinding[]; waived: WaivedFinding[] } {
  const findings: CheckFinding[] = [];
  const waived: WaivedFinding[] = [];
  for (const c of model.checks) {
    const run = model.runs[c.name];
    if (run?.status !== 'done') continue;
    findings.push(...run.result.findings);
    waived.push(...run.result.waived);
  }
  return { findings, waived };
}

export interface FindingFilter {
  levels: ReadonlySet<CheckLevel>;
  /** Case-insensitive substring over message, check/rule and items. */
  text: string;
}

export function defaultFilter(): FindingFilter {
  return { levels: new Set<CheckLevel>(['error', 'warn']), text: '' };
}

export function filterFindings(findings: CheckFinding[], filter: FindingFilter): CheckFinding[] {
  const q = filter.text.trim().toLowerCase();
  return findings.filter((f) => {
    if (!filter.levels.has(f.level)) return false;
    if (!q) return true;
    const hay = `${f.check}/${f.rule} ${f.message} ${f.items.join(' ')}`.toLowerCase();
    return hay.includes(q);
  });
}

export type GroupMode = 'check' | 'severity';

export interface FindingGroup {
  key: string;
  title: string;
  /** Worst level in the group, for the group header's badge. */
  level: CheckLevel;
  findings: CheckFinding[];
}

function bySeverity(a: CheckFinding, b: CheckFinding): number {
  return LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level];
}

/**
 * Group findings for display. 'check' groups by check then rule, ordered by
 * the registry order of the check and then by each group's worst level;
 * 'severity' gives one group per level. Findings keep their order inside a
 * group except for a stable sort by level.
 */
export function groupFindings(findings: CheckFinding[], mode: GroupMode, checkOrder: string[] = []): FindingGroup[] {
  if (mode === 'severity') {
    return LEVELS.map((level) => ({
      key: level,
      title: level === 'error' ? 'Errors' : level === 'warn' ? 'Warnings' : 'Info',
      level,
      findings: findings.filter((f) => f.level === level),
    })).filter((g) => g.findings.length > 0);
  }
  const groups = new Map<string, FindingGroup>();
  for (const f of findings) {
    const key = `${f.check}/${f.rule}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, title: key, level: f.level, findings: [] };
      groups.set(key, g);
    }
    g.findings.push(f);
    if (LEVEL_ORDER[f.level] < LEVEL_ORDER[g.level]) g.level = f.level;
  }
  const rank = (check: string): number => {
    const i = checkOrder.indexOf(check);
    return i < 0 ? checkOrder.length : i;
  };
  const out = [...groups.values()];
  for (const g of out) g.findings.sort(bySeverity);
  out.sort((a, b) => {
    const [ca] = a.key.split('/');
    const [cb] = b.key.split('/');
    return rank(ca!) - rank(cb!) || LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.key.localeCompare(b.key);
  });
  return out;
}

export function countLevels(findings: CheckFinding[]): Record<CheckLevel, number> {
  const out: Record<CheckLevel, number> = { error: 0, warn: 0, info: 0 };
  for (const f of findings) out[f.level]++;
  return out;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "2 errors · 5 warnings", "No errors or warnings", for a list of findings. */
export function countsText(findings: CheckFinding[]): string {
  const c = countLevels(findings);
  if (c.error === 0 && c.warn === 0) return 'No errors or warnings';
  const parts: string[] = [];
  if (c.error > 0) parts.push(plural(c.error, 'error', 'errors'));
  if (c.warn > 0) parts.push(plural(c.warn, 'warning', 'warnings'));
  return parts.join(' · ');
}

const sigCache = new WeakMap<Board, string>();

/**
 * What a check's result depends on, as a string: the whole board except its
 * waivers. Waiving a finding is a board op, but it cannot change what any
 * check finds, so it must not make the other checks' results stale. Every
 * websocket push is a fresh object, hence a value comparison; cached per
 * board object so it is computed once per board version.
 */
export function boardSig(board: Board | null): string {
  if (!board) return '';
  let s = sigCache.get(board);
  if (s === undefined) {
    const { checkWaivers: _w, ...rest } = board;
    s = JSON.stringify(rest);
    sigCache.set(board, s);
  }
  return s;
}

/** True when the board has changed (waivers aside) since any finished run was made. */
export function isStale(model: ChecksModel, board: Board | null): boolean {
  const now = boardSig(board);
  return Object.values(model.runs).some((r) => r.status === 'done' && r.sig !== now);
}

export interface Summary {
  text: string;
  kind: 'none' | 'ok' | 'warn' | 'err' | 'stale' | 'busy';
}

/** The one-line summary shown in the right panel's Checks section. */
export function summarize(model: ChecksModel, board: Board | null): Summary {
  const runs = Object.values(model.runs);
  if (runs.some((r) => r.status === 'running')) return { text: 'Running…', kind: 'busy' };
  const done = runs.filter((r) => r.status === 'done');
  const failed = runs.filter((r) => r.status === 'failed');
  if (done.length === 0) {
    return failed.length > 0 ? { text: 'Check failed to run', kind: 'err' } : { text: 'Not run', kind: 'none' };
  }
  const { findings } = collect(model);
  const c = countLevels(findings);
  let text = countsText(findings);
  if (failed.length > 0) text += ` · ${plural(failed.length, 'check', 'checks')} failed`;
  if (isStale(model, board)) return { text: `${text} · stale since last edit`, kind: 'stale' };
  return { text, kind: c.error > 0 || failed.length > 0 ? 'err' : c.warn > 0 ? 'warn' : 'ok' };
}

/** A ring on the canvas: one per finding that has a location. */
export interface CheckMarker {
  at: Point;
  level: CheckLevel;
  key: string;
}

export function buildMarkers(findings: CheckFinding[], board: Board | null): CheckMarker[] {
  const out: CheckMarker[] = [];
  for (const f of findings) {
    const at = locate(f, board);
    if (at) out.push({ at, level: f.level, key: findingKey(f) });
  }
  return out;
}

function centreOf(pts: Point[]): Point | null {
  if (pts.length === 0) return null;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

/**
 * Where a finding is on the board: its own `at`, else the first item that
 * names a pad ("U2.9") or a component ("U2"). Items like "net:GND" or link
 * ids do not resolve. Null when nothing does.
 */
export function locate(f: CheckFinding, board: Board | null): Point | null {
  if (f.at) return f.at;
  if (!board) return null;
  for (const item of f.items) {
    const dot = item.indexOf('.');
    const ref = dot < 0 ? item : item.slice(0, dot);
    const comp = board.components.find((c) => c.refdes === ref);
    if (!comp) continue;
    if (dot >= 0) {
      const pad = comp.footprint.pads.find((p) => p.number === item.slice(dot + 1));
      if (pad) return centreOf(padOutline(comp, pad));
    }
    return centreOf(comp.footprint.pads.flatMap((p) => padOutline(comp, p))) ?? comp.at;
  }
  return null;
}

/** "12:04:31" for a run timestamp, "" for none. */
export function timeText(ms: number | undefined): string {
  if (!ms) return '';
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

/** The latest finished run's time and the sha it saw, for the drawer header. */
export function lastRun(model: ChecksModel): { at: number; sha: string } | null {
  let best: { at: number; sha: string } | null = null;
  for (const r of Object.values(model.runs)) {
    if (r.status === 'done' && (!best || r.at > best.at)) best = { at: r.at, sha: r.result.sha };
  }
  return best;
}

/** Per-check status text for a chip: "idle", "running", "2 errors · 1 warning", or the failure. */
export function runText(run: CheckRun | undefined): string {
  if (!run || run.status === 'idle') return 'not run';
  if (run.status === 'running') return 'running…';
  if (run.status === 'failed') return `failed: ${run.error}`;
  const c = countLevels(run.result.findings);
  if (c.error === 0 && c.warn === 0) return `clean · ${(run.result.ms / 1000).toFixed(1)} s`;
  return `${countsText(run.result.findings)} · ${(run.result.ms / 1000).toFixed(1)} s`;
}

/**
 * The waiver to post for a finding: its rule and check, the items the user
 * kept (at least one), and the trimmed reason. Null when the form is not
 * complete yet.
 */
export function waiverFor(
  f: CheckFinding,
  items: string[],
  reason: string,
): { check: string; rule: string; items: string[]; reason: string } | null {
  const r = reason.trim();
  if (!r || items.length === 0) return null;
  return { check: f.check, rule: f.rule, items: [...items], reason: r };
}

/**
 * Index of a waiver in board.checkWaivers, matched by value (the run result
 * hands back a copy, not the board's object). -1 when it is gone.
 */
export function waiverIndex(
  board: Board | null,
  w: { check?: string; rule: string; items: string[]; reason: string },
): number {
  const list = board?.checkWaivers ?? [];
  return list.findIndex(
    (x) =>
      x.rule === w.rule &&
      (x.check ?? '') === (w.check ?? '') &&
      x.reason === w.reason &&
      x.items.length === w.items.length &&
      x.items.every((it, i) => it === w.items[i]),
  );
}
