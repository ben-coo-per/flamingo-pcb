import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Board, Footprint } from '@flamingo/engine';
import { newBoard, parseBoard } from '@flamingo/engine';
import { applyPanelOp } from '../src/ops.js';
import { newPanel, parsePanel, serializePanel } from '../src/panel.js';
import { canonicalNet, checkInterconnect, parsePinTables } from '../src/interconnect.js';
import type { ResolvedSource } from '../src/resolved.js';
import type { Panel, PanelLink } from '../src/types.js';
import { rectOutline } from './helpers.js';

/** A 2xN through-hole header with pads 1..n. */
function header(n: number): Footprint {
  return {
    name: `HDR-2x${n / 2}`,
    lcsc: 'C1',
    silk: [],
    courtyard: [],
    pads: Array.from({ length: n }, (_, i) => ({
      number: String(i + 1),
      shape: 'circle' as const,
      at: { x: Math.floor(i / 2) * 2.54, y: (i % 2) * 2.54 },
      rotation: 0,
      size: { w: 1.7, h: 1.7 },
      layer: 'through' as const,
      drill: { diameter: 1, plated: true },
    })),
  };
}

/** A board with header `ref` whose pad i is on nets[i-1] (undefined = unconnected). */
function boardWith(name: string, ref: string, nets: (string | undefined)[], classes: Record<string, string> = {}): Board {
  const b = newBoard(name, 2);
  b.outline = rectOutline(30, 20);
  b.components.push({
    refdes: ref,
    lcsc: 'C1',
    at: { x: 5, y: 5 },
    rotation: 0,
    side: 'top',
    fields: {},
    footprint: header(nets.length),
  });
  const byNet = new Map<string, string[]>();
  nets.forEach((n, i) => {
    if (n) byNet.set(n, [...(byNet.get(n) ?? []), `${ref}.${i + 1}`]);
  });
  for (const [name, pins] of byNet) b.nets.push({ name, class: classes[name] ?? 'default', pins });
  return b;
}

function source(key: string, board: Board): ResolvedSource {
  return { key, path: `${board.name}.flamingo`, name: board.name, recordedHash: '', stale: false, board };
}

function panelWith(link: Omit<PanelLink, 'id'>, keys = ['A', 'B']): Panel {
  let p = newPanel('t');
  for (const k of keys) {
    const r = applyPanelOp(p, { op: 'addSource', source: { key: k, path: `${k}.flamingo`, hash: '', name: k } });
    if (!r.ok) throw new Error(r.error);
    p = r.panel;
  }
  const r = applyPanelOp(p, { op: 'addLink', link });
  if (!r.ok) throw new Error(r.error);
  return r.panel;
}

const BUS = ['STEP', 'GND', 'DIR', 'GND', 'SDA', 'GND', 'SCL', '3V3'];

describe('panel links', () => {
  it('are absent from panels that declare none, so old files round-trip unchanged', () => {
    const p = newPanel('x');
    expect(serializePanel(parsePanel(serializePanel(p)))).toBe(serializePanel(p));
    expect('links' in parsePanel(serializePanel(p))).toBe(false);
  });

  it('round-trip through the file and get ids L1, L2', () => {
    let p = panelWith({ from: 'A:J1', to: ['B:J2'], map: 'straight', aliases: { M_EN: 'MOTION_EN' } });
    const r = applyPanelOp(p, { op: 'addLink', link: { from: 'A:J1', to: ['B:J3'], map: { '1': '2' } } });
    expect(r.ok).toBe(true);
    p = (r as { panel: Panel }).panel;
    expect(p.links!.map((l) => l.id)).toEqual(['L1', 'L2']);
    expect(parsePanel(serializePanel(p))).toEqual(p);
  });

  it('are validated', () => {
    const p = panelWith({ from: 'A:J1', to: ['B:J2'], map: 'straight' });
    const bad = (link: Omit<PanelLink, 'id'>) => applyPanelOp(p, { op: 'addLink', link });
    expect(bad({ from: 'Z:J1', to: ['B:J2'], map: 'straight' }).ok).toBe(false);
    expect(bad({ from: 'A-J1', to: ['B:J2'], map: 'straight' }).ok).toBe(false);
    expect(bad({ from: 'A:J1', to: [], map: 'straight' }).ok).toBe(false);
    expect(bad({ from: 'A:J1', to: ['A:J1'], map: 'straight' }).ok).toBe(false);
    expect(() => parsePanel(JSON.stringify({ ...p, links: [{ id: 'L1', from: 'Q:J1', to: ['B:J2'], map: 'straight' }] }))).toThrow(
      /unknown source/,
    );
  });

  it('removeLink, and removing a board drops its links', () => {
    const p = panelWith({ from: 'A:J1', to: ['B:J2'], map: 'straight' });
    const r1 = applyPanelOp(p, { op: 'removeLink', id: 'L1' });
    expect(r1.ok && r1.panel.links).toBeUndefined();
    expect(applyPanelOp(p, { op: 'removeLink', id: 'L9' }).ok).toBe(false);
    const r2 = applyPanelOp(p, { op: 'removeSource', key: 'B' });
    expect(r2.ok && r2.panel.links).toBeUndefined();
  });
});

describe('checkInterconnect', () => {
  const errors = (f: ReturnType<typeof checkInterconnect>) => f.filter((x) => x.level === 'error');

  it('a straight cable between matching headers passes', () => {
    const p = panelWith({ from: 'A:J1', to: ['B:J2'], map: 'straight' });
    const f = checkInterconnect(p, [source('A', boardWith('a', 'J1', BUS)), source('B', boardWith('b', 'J2', BUS))]);
    expect(errors(f)).toEqual([]);
    expect(f.find((x) => x.rule === 'summary')!.message).toContain('8 of 8 pins agree');
  });

  it('SDA and SCL swapped on one side fails on both pins', () => {
    const swapped = [...BUS];
    [swapped[4], swapped[6]] = [swapped[6]!, swapped[4]!];
    const p = panelWith({ from: 'A:J1', to: ['B:J2'], map: 'straight' });
    const f = errors(checkInterconnect(p, [source('A', boardWith('a', 'J1', BUS)), source('B', boardWith('b', 'J2', swapped))]));
    expect(f.map((x) => x.rule)).toEqual(['name-mismatch', 'name-mismatch']);
    expect(f[0]!.items).toEqual(['L1', 'A:J1.5', 'B:J2.5']);
  });

  it('3V3 on a signal pin fails as supply-on-signal', () => {
    const wrong = [...BUS];
    wrong[2] = '3V3';
    const p = panelWith({ from: 'A:J1', to: ['B:J2'], map: 'straight' });
    const f = errors(checkInterconnect(p, [source('A', boardWith('a', 'J1', BUS)), source('B', boardWith('b', 'J2', wrong))]));
    expect(f.map((x) => x.rule)).toEqual(['supply-on-signal']);
    expect(f[0]!.message).toContain('supply 3V3 meets signal DIR');
  });

  it('different supplies and ground against a signal are errors', () => {
    const other = [...BUS];
    other[7] = '5V';
    other[1] = 'STEP2';
    const p = panelWith({ from: 'A:J1', to: ['B:J2'], map: 'straight' });
    const f = errors(checkInterconnect(p, [source('A', boardWith('a', 'J1', BUS)), source('B', boardWith('b', 'J2', other))]));
    expect(f.map((x) => x.rule).sort()).toEqual(['ground-mismatch', 'supply-mismatch']);
  });

  it('aliases join different names for one signal, and grounds always match', () => {
    const b = ['STEP', 'AGND', 'DIR', 'GND', 'BUS_SDA', 'GND', 'BUS_SCL', '3V3'];
    const p = panelWith({ from: 'A:J1', to: ['B:J2'], map: 'straight', aliases: { BUS_SDA: 'SDA', bus_scl: 'scl' } });
    expect(errors(checkInterconnect(p, [source('A', boardWith('a', 'J1', BUS)), source('B', boardWith('b', 'J2', b))]))).toEqual([]);
    expect(canonicalNet('m-en', { M_EN: 'MOTION_EN' })).toBe('MOTION_EN');
  });

  it('a pin connected on one end only is a warning', () => {
    const open = [...BUS];
    open[0] = undefined;
    const p = panelWith({ from: 'A:J1', to: ['B:J2'], map: 'straight' });
    const f = checkInterconnect(p, [source('A', boardWith('a', 'J1', BUS)), source('B', boardWith('b', 'J2', open))]);
    expect(errors(f)).toEqual([]);
    expect(f.filter((x) => x.level === 'warn').map((x) => x.rule)).toEqual(['one-sided']);
  });

  it('a pad map routes pins explicitly, and different pin counts fail a straight cable', () => {
    const crossed = ['SCL', 'SDA'];
    const p = panelWith({ from: 'A:J1', to: ['B:J2'], map: { '1': '2', '2': '1' } });
    expect(
      errors(checkInterconnect(p, [source('A', boardWith('a', 'J1', ['SDA', 'SCL'])), source('B', boardWith('b', 'J2', crossed))])),
    ).toEqual([]);
    const s = panelWith({ from: 'A:J1', to: ['B:J2'], map: 'straight' });
    const f = errors(checkInterconnect(s, [source('A', boardWith('a', 'J1', BUS)), source('B', boardWith('b', 'J2', BUS.slice(0, 6)))]));
    expect(f.map((x) => x.rule)).toEqual(['pin-count']);
  });

  it('a missing header or unreadable board is an endpoint error', () => {
    const p = panelWith({ from: 'A:J1', to: ['B:J9'], map: 'straight' });
    const f = errors(checkInterconnect(p, [source('A', boardWith('a', 'J1', BUS)), source('B', boardWith('b', 'J2', BUS))]));
    expect(f.map((x) => x.rule)).toEqual(['link-endpoint']);
    const unread: ResolvedSource = { key: 'B', path: 'b.flamingo', name: 'b', recordedHash: '', stale: false, error: 'missing' };
    expect(errors(checkInterconnect(p, [source('A', boardWith('a', 'J1', BUS)), unread]))[0]!.message).toContain('missing');
  });

  it('a daisy chain checks every far end', () => {
    const wrong = [...BUS];
    wrong[0] = 'DIR';
    const p = panelWith({ from: 'A:J1', to: ['B:J2', 'C:J2'], map: 'straight' }, ['A', 'B', 'C']);
    const f = checkInterconnect(p, [
      source('A', boardWith('a', 'J1', BUS)),
      source('B', boardWith('b', 'J2', BUS)),
      source('C', boardWith('c', 'J2', wrong)),
    ]);
    expect(errors(f).map((x) => x.items[2])).toEqual(['C:J2.1']);
    expect(f.filter((x) => x.rule === 'summary')).toHaveLength(2);
  });

  it('compares markdown pin tables with the copper', () => {
    const md = [
      '| Pin | Signal | Pin | Signal |',
      '|---|---|---|---|',
      '| 1 | STEP | 2 | GND |',
      '| 3 | DIR | 4 | GND |',
      '| 5 | SDA | 6 | GND |',
      '| 7 | SCL | 8 | 3V3 |',
      '',
      'text',
      '| Pin | Signal | Pin | Signal |',
      '|---|---|---|---|',
      '| 1 | STEP | 2 | GND |',
      '| 3 | DIR | 4 | GND |',
      '| 5 | SCL | 6 | GND |',
      '| 7 | SDA | 8 | 3V3 |',
    ].join('\n');
    expect(parsePinTables(md)).toHaveLength(2);
    const p = panelWith({ from: 'A:J1', to: ['B:J2'], map: 'straight' });
    const f = checkInterconnect(p, [source('A', boardWith('a', 'J1', BUS)), source('B', boardWith('b', 'J2', BUS))], {
      docs: [{ name: 'spec.md', text: md }],
    });
    expect(f.filter((x) => x.rule === 'doc-match')).toHaveLength(1);
    const bad = f.filter((x) => x.rule === 'doc-mismatch');
    expect(bad).toHaveLength(1);
    expect(bad[0]!.message).toContain('pin 5: doc says SCL, copper has SDA');
  });
});

// The KinAura boards (not in this repo): ScaleController J5 feeds both driver
// banks' J6 over one 14-way ribbon. Runs only where the boards are checked out.
const KINAURA = process.env.KINAURA_PCB ?? join(homedir(), 'repos', 'kinaura', 'pcb');
const SC = join(KINAURA, 'scale-controller-flamingo', 'ScaleController.flamingo');
const BANK = join(KINAURA, 'driver-bank', 'DriverBank.flamingo');
describe.skipIf(!existsSync(SC) || !existsSync(BANK))('KinAura bus (local boards)', () => {
  it('J5 -> J6 agrees on all 14 pins, and the spec table matches', () => {
    const sc = parseBoard(readFileSync(SC, 'utf8'));
    const bank = parseBoard(readFileSync(BANK, 'utf8'));
    const p = panelWith({
      from: 'S:J5',
      to: ['D:J6'],
      map: 'straight',
      aliases: { BUS_SDA: 'SDA', BUS_SCL: 'SCL', UART: 'TMC_UART', 'TMC UART': 'TMC_UART', M_EN: 'MOTION_EN' },
    }, ['S', 'D']);
    const docs = [join(KINAURA, 'driver-bank', 'spec.md')]
      .filter(existsSync)
      .map((f) => ({ name: 'spec.md', text: readFileSync(f, 'utf8') }));
    const f = checkInterconnect(p, [source('S', sc), source('D', bank)], { docs });
    expect(f.filter((x) => x.level !== 'info')).toEqual([]);
    expect(f.find((x) => x.rule === 'summary')!.message).toContain('14 of 14 pins agree');
    if (docs.length > 0) expect(f.some((x) => x.rule === 'doc-match')).toBe(true);
  });
});
