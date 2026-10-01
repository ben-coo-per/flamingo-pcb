/**
 * The Checks drawer's pure logic: filtering, grouping, summaries, staleness,
 * marker building and waiver matching (src/checks/model.ts).
 */
import { describe, it, expect } from 'vitest';
import { newBoard } from '@flamingo/engine';
import type { Board, CheckFinding } from '@flamingo/engine';
import {
  buildMarkers,
  collect,
  countsText,
  defaultFilter,
  defaultSelection,
  emptyModel,
  filterFindings,
  findingKey,
  groupFindings,
  isStale,
  lastRun,
  locate,
  runText,
  summarize,
  waiverFor,
  waiverIndex,
  type ChecksModel,
} from '../src/checks/model.js';
import type { CheckInfo, CheckRunResult } from '../src/checks/types.js';

const f = (check: string, rule: string, level: CheckFinding['level'], items: string[] = [], at?: { x: number; y: number }): CheckFinding => ({
  check,
  rule,
  level,
  message: `${rule} on ${items.join(',') || 'board'}`,
  items,
  ...(at ? { at } : {}),
});

const CHECKS: CheckInfo[] = [
  { name: 'drc', description: 'Design rules' },
  { name: 'erc', description: 'Electrical rules' },
  { name: 'stock', description: 'JLCPCB stock', network: true },
];

function result(findings: CheckFinding[], waived: CheckRunResult['waived'] = []): CheckRunResult {
  return { sha: 'abcdef0123456789', ms: 1500, findings, waived };
}

/** A board with one two-pad part R1 at (10, 5), pads at x = 9.25 and 10.75. */
function boardWithR1(): Board {
  const b = newBoard('t', 2);
  b.components.push({
    refdes: 'R1',
    lcsc: 'C1',
    at: { x: 10, y: 5 },
    rotation: 0,
    side: 'top',
    fields: {},
    footprint: {
      name: 'R0603',
      lcsc: 'C1',
      silk: [],
      courtyard: [],
      pads: [
        { number: '1', shape: 'rect', at: { x: -0.75, y: 0 }, rotation: 0, size: { w: 0.8, h: 0.9 }, layer: 'top' },
        { number: '2', shape: 'rect', at: { x: 0.75, y: 0 }, rotation: 0, size: { w: 0.8, h: 0.9 }, layer: 'top' },
      ],
    },
  });
  return b;
}

function modelWith(board: Board | null, runs: Record<string, CheckFinding[]>): ChecksModel {
  const m = emptyModel(CHECKS);
  for (const [name, findings] of Object.entries(runs)) {
    m.runs[name] = { status: 'done', result: result(findings), at: 1000, board };
  }
  return m;
}

describe('filtering and grouping', () => {
  const findings = [
    f('erc', 'polarity', 'error', ['D1']),
    f('erc', 'decoupling', 'warn', ['U1.2']),
    f('drc', 'clearance', 'error', [], { x: 1, y: 1 }),
    f('erc', 'decoupling', 'info', ['U2.5']),
    f('erc', 'polarity', 'warn', ['D2']),
  ];

  it('hides info by default and filters text over message, rule and items', () => {
    expect(filterFindings(findings, defaultFilter())).toHaveLength(4);
    expect(filterFindings(findings, { levels: new Set(['error', 'warn', 'info']), text: 'u2.5' })).toHaveLength(1);
    expect(filterFindings(findings, { levels: new Set(['error']), text: 'ERC/POL' }).map((x) => x.items)).toEqual([['D1']]);
  });

  it('groups by check then rule, in registry order, worst level first within a check', () => {
    const groups = groupFindings(findings, 'check', ['drc', 'erc']);
    expect(groups.map((g) => g.key)).toEqual(['drc/clearance', 'erc/polarity', 'erc/decoupling']);
    expect(groups[1]!.level).toBe('error');
    expect(groups[2]!.level).toBe('warn');
    // Within a group, errors before warnings before info.
    expect(groups[1]!.findings.map((x) => x.level)).toEqual(['error', 'warn']);
  });

  it('groups by severity, dropping empty levels', () => {
    const groups = groupFindings(findings.filter((x) => x.level !== 'info'), 'severity');
    expect(groups.map((g) => [g.key, g.findings.length])).toEqual([
      ['error', 2],
      ['warn', 2],
    ]);
  });

  it('counts text', () => {
    expect(countsText(findings)).toBe('2 errors · 2 warnings');
    expect(countsText([f('erc', 'x', 'warn')])).toBe('1 warning');
    expect(countsText([f('erc', 'x', 'info')])).toBe('No errors or warnings');
  });
});

describe('model, summary and staleness', () => {
  it('starts not run, with network checks left out of the default selection', () => {
    const m = emptyModel(CHECKS);
    expect(summarize(m, null)).toEqual({ text: 'Not run', kind: 'none' });
    expect([...defaultSelection(CHECKS)]).toEqual(['drc', 'erc']);
    expect(runText(m.runs.drc)).toBe('not run');
    expect(lastRun(m)).toBeNull();
  });

  it('summarises finished runs, worst first, and goes stale when the board changes', () => {
    const b1 = newBoard('a', 2);
    const m = modelWith(b1, { drc: [], erc: [f('erc', 'polarity', 'error'), f('erc', 'd', 'warn')] });
    expect(summarize(m, b1)).toEqual({ text: '1 error · 1 warning', kind: 'err' });
    expect(isStale(m, b1)).toBe(false);
    const b2 = { ...b1 };
    expect(isStale(m, b2)).toBe(true);
    expect(summarize(m, b2)).toEqual({ text: '1 error · 1 warning · stale since last edit', kind: 'stale' });
    expect(runText(m.runs.drc)).toBe('clean · 1.5 s');
    expect(runText(m.runs.erc)).toBe('1 error · 1 warning · 1.5 s');
    expect(lastRun(m)).toEqual({ at: 1000, sha: 'abcdef0123456789' });
  });

  it('is clean, warn-only, running or failed', () => {
    const b = newBoard('a', 2);
    expect(summarize(modelWith(b, { erc: [] }), b)).toEqual({ text: 'No errors or warnings', kind: 'ok' });
    expect(summarize(modelWith(b, { erc: [f('erc', 'd', 'warn')] }), b).kind).toBe('warn');
    const running = modelWith(b, { erc: [] });
    running.runs.drc = { status: 'running' };
    expect(summarize(running, b).kind).toBe('busy');
    const failed = modelWith(b, { erc: [] });
    failed.runs.drc = { status: 'failed', error: 'boom' };
    expect(summarize(failed, b)).toEqual({ text: 'No errors or warnings · 1 check failed', kind: 'err' });
    expect(runText(failed.runs.drc)).toBe('failed: boom');
    const onlyFailed = emptyModel(CHECKS);
    onlyFailed.runs.drc = { status: 'failed', error: 'boom' };
    expect(summarize(onlyFailed, b).kind).toBe('err');
  });

  it('collects findings and waived findings across runs in registry order', () => {
    const m = emptyModel(CHECKS);
    const w = { finding: f('erc', 'unconnected-ic-pin', 'warn', ['J6.9']), waiver: { rule: 'unconnected-ic-pin', items: ['J6.9'], reason: 'MISO open' } };
    m.runs.erc = { status: 'done', result: result([f('erc', 'a', 'warn')], [w]), at: 1, board: null };
    m.runs.drc = { status: 'done', result: result([f('drc', 'b', 'error')]), at: 2, board: null };
    const { findings, waived } = collect(m);
    expect(findings.map((x) => x.check)).toEqual(['drc', 'erc']);
    expect(waived).toEqual([w]);
  });
});

describe('locating findings and markers', () => {
  it('uses at, then a pad item, then a component item', () => {
    const b = boardWithR1();
    expect(locate(f('drc', 'x', 'error', ['R1'], { x: 3, y: 4 }), b)).toEqual({ x: 3, y: 4 });
    const pad = locate(f('erc', 'x', 'warn', ['net:GND', 'R1.2']), b)!;
    expect(pad.x).toBeCloseTo(10.75);
    expect(pad.y).toBeCloseTo(5);
    const comp = locate(f('erc', 'x', 'warn', ['R1']), b)!;
    expect(comp.x).toBeCloseTo(10);
    expect(locate(f('erc', 'x', 'warn', ['net:GND', 'L1']), b)).toBeNull();
    expect(locate(f('erc', 'x', 'warn', ['R1']), null)).toBeNull();
  });

  it('builds one marker per located finding, keyed like the rows', () => {
    const b = boardWithR1();
    const fs = [f('erc', 'p', 'error', ['R1.1']), f('erc', 'q', 'warn', ['net:X']), f('drc', 'c', 'info', [], { x: 0, y: 0 })];
    const markers = buildMarkers(fs, b);
    expect(markers.map((m) => m.level)).toEqual(['error', 'info']);
    expect(markers[0]!.key).toBe(findingKey(fs[0]!));
  });

  it('finding keys are stable and distinguish items', () => {
    expect(findingKey(f('erc', 'p', 'error', ['D1']))).toBe(findingKey(f('erc', 'p', 'error', ['D1'])));
    expect(findingKey(f('erc', 'p', 'error', ['D1']))).not.toBe(findingKey(f('erc', 'p', 'error', ['D2'])));
  });
});

describe('waivers', () => {
  it('needs a reason and at least one item', () => {
    const fi = f('erc', 'unconnected-ic-pin', 'warn', ['J6.9', 'J6']);
    expect(waiverFor(fi, ['J6.9'], '   ')).toBeNull();
    expect(waiverFor(fi, [], 'open on purpose')).toBeNull();
    expect(waiverFor(fi, ['J6.9'], '  open on purpose ')).toEqual({
      check: 'erc',
      rule: 'unconnected-ic-pin',
      items: ['J6.9'],
      reason: 'open on purpose',
    });
  });

  it('finds a waiver on the board by value', () => {
    const b = newBoard('t', 2);
    b.checkWaivers = [
      { rule: 'a', items: ['X'], reason: 'r' },
      { check: 'erc', rule: 'unconnected-ic-pin', items: ['J6.9'], reason: 'MISO open' },
    ];
    expect(waiverIndex(b, { check: 'erc', rule: 'unconnected-ic-pin', items: ['J6.9'], reason: 'MISO open' })).toBe(1);
    expect(waiverIndex(b, { rule: 'a', items: ['X'], reason: 'r' })).toBe(0);
    expect(waiverIndex(b, { rule: 'a', items: ['Y'], reason: 'r' })).toBe(-1);
    expect(waiverIndex(null, { rule: 'a', items: ['X'], reason: 'r' })).toBe(-1);
  });
});
