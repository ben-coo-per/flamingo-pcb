import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Board, Footprint } from '@flamingo/engine';
import { newBoard, serializeBoard } from '@flamingo/engine';
import type { CheckFinding } from '@flamingo/engine';
import type { StartedServer } from '../src/http.js';
import { rect, startPanelServer } from './panel-helpers.js';

/** A 2xN header with pads 1..n. */
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

/** A board with header J1 on `nets`, plus a P2 and a non-header R1. */
function cableBoard(name: string, nets: string[]): Board {
  const b = newBoard(name, 2);
  b.outline = rect(40, 30);
  const comp = (refdes: string, fp: Footprint, x: number, value: string) => ({
    refdes,
    lcsc: 'C1',
    footprint: fp,
    at: { x, y: 10 },
    rotation: 0,
    side: 'top' as const,
    fields: { value },
  });
  b.components.push(comp('J1', header(nets.length), 5, '2x2 header'), comp('R1', header(2), 20, '10k'), comp('P2', header(2), 30, 'pins'));
  nets.forEach((n, i) => {
    const net = b.nets.find((x) => x.name === n);
    if (net) net.pins.push(`J1.${i + 1}`);
    else b.nets.push({ name: n, class: 'default', pins: [`J1.${i + 1}`] });
  });
  return b;
}

describe('panel cable routes', () => {
  let dir: string;
  let started: StartedServer;
  let base: string;

  const post = async (path: string, body: unknown) =>
    (await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<{
      ok: boolean;
      error?: string;
    }>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'flamingo-panel-cables-'));
    await writeFile(join(dir, 'ctrl.flamingo'), serializeBoard(cableBoard('ctrl', ['SDA', 'GND', 'SCL', 'GND'])));
    await writeFile(join(dir, 'bank.flamingo'), serializeBoard(cableBoard('bank', ['SDA', 'GND', 'SCL', 'GND'])));
    await writeFile(join(dir, 'swapped.flamingo'), serializeBoard(cableBoard('swapped', ['SCL', 'GND', 'SDA', 'GND'])));
    started = await startPanelServer(dir, undefined, { panelOnly: true });
    base = `http://localhost:${started.port}`;
    expect((await post('/api/panel/new', { name: 'cables' })).ok).toBe(true);
    for (const f of ['ctrl', 'bank', 'swapped']) expect((await post('/api/panel/add-board', { path: join(dir, `${f}.flamingo`) })).ok).toBe(true);
  });

  afterEach(async () => {
    await started.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function keys(): Promise<Record<string, string>> {
    const body = (await (await fetch(`${base}/api/panel/headers`)).json()) as { boards: { key: string; name: string }[] };
    return Object.fromEntries(body.boards.map((b) => [b.name, b.key]));
  }

  it('lists the J and P connectors of each board, not its other parts', async () => {
    const body = (await (await fetch(`${base}/api/panel/headers`)).json()) as {
      ok: boolean;
      boards: { key: string; name: string; headers: { refdes: string; pads: number; value: string }[] }[];
    };
    expect(body.ok).toBe(true);
    const ctrl = body.boards.find((b) => b.name === 'ctrl')!;
    expect(ctrl.headers).toEqual([
      { refdes: 'J1', pads: 4, value: '2x2 header' },
      { refdes: 'P2', pads: 2, value: 'pins' },
    ]);
  });

  it('checks the cables: a straight match passes, swapped signals fail', async () => {
    const k = await keys();
    const check = async () =>
      (await (await fetch(`${base}/api/panel/interconnect`)).json()) as { ok: boolean; findings: CheckFinding[] };

    expect((await check()).findings).toEqual([]); // no cables, nothing to say

    expect((await post('/api/panel/op', { op: 'addLink', link: { from: `${k.ctrl}:J1`, to: [`${k.bank}:J1`], map: 'straight' } })).ok).toBe(true);
    const good = await check();
    expect(good.ok).toBe(true);
    expect(good.findings.filter((f) => f.level === 'error')).toEqual([]);

    expect((await post('/api/panel/op', { op: 'addLink', link: { from: `${k.ctrl}:J1`, to: [`${k.swapped}:J1`], map: 'straight' } })).ok).toBe(true);
    const bad = await check();
    expect(bad.findings.some((f) => f.level === 'error' && f.check === 'interconnect')).toBe(true);
  });

  it('refuses a malformed link through the op route', async () => {
    const r = await post('/api/panel/op', { op: 'addLink', link: { from: 'nope', to: [], map: 'straight' } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/to must list|endpoint/);
  });
});
