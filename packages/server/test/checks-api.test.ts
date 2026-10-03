import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newBoard, parseBoard, serializeBoard } from '@flamingo/engine';
import type { Board, CheckFinding, ComponentInst, Footprint, SymbolPin } from '@flamingo/engine';
import type { JlcStock } from '@flamingo/parts';
import { Doc } from '../src/document.js';
import { startServer } from '../src/http.js';
import { classifySpec, parseCounterexample } from '../src/checks-api.js';
import { findNgspice } from '../src/spice-runner.js';

const here = dirname(fileURLToPath(import.meta.url));
const BLINKER = join(here, '../../engine/test/fixtures/blinker-routed.flamingo');

function twoPad(refdes: string, lcsc: string, x: number, pins?: [string, string], value?: string, fp = 'R0603'): ComponentInst {
  const footprint: Footprint = {
    name: fp,
    lcsc,
    pads: [
      { number: '1', shape: 'rect', at: { x: -0.75, y: 0 }, rotation: 0, size: { w: 0.8, h: 0.9 }, layer: 'top' },
      { number: '2', shape: 'rect', at: { x: 0.75, y: 0 }, rotation: 0, size: { w: 0.8, h: 0.9 }, layer: 'top' },
    ],
    silk: [],
    courtyard: [],
    ...(pins
      ? { pins: { '1': { name: pins[0], type: 'undefined' } as SymbolPin, '2': { name: pins[1], type: 'undefined' } as SymbolPin } }
      : {}),
  };
  return { refdes, lcsc, footprint, at: { x, y: 10 }, rotation: 0, side: 'top', fields: value ? { value } : {} };
}

/** One reversed LED (an ERC polarity error), plus an RC filter IN -R1- OUT -C1- GND for SPICE. */
function testBoard(): Board {
  const b = newBoard('apiboard', 2);
  b.components = [
    twoPad('D1', 'C2290', 10, ['A', 'K'], 'white', 'LED0603-R-RD_WHITE'),
    twoPad('R1', 'C21190', 14, undefined, '1k'),
    twoPad('R2', 'C21190', 18, undefined, '1k'),
    twoPad('C1', 'C14663', 22, undefined, '100nF'),
  ];
  b.nets = [
    { name: 'GND', class: 'default', pins: ['D1.1', 'C1.2'] },
    { name: 'LED_A', class: 'default', pins: ['D1.2', 'R1.1'] },
    { name: '3V3', class: 'default', pins: ['R1.2'] },
    { name: 'IN', class: 'default', pins: ['R2.1'] },
    { name: 'OUT', class: 'default', pins: ['R2.2', 'C1.1'] },
  ];
  return b;
}

const noPins = async () => new Map<string, Record<string, SymbolPin>>();
const fakeStock = async (lcsc: string): Promise<JlcStock> =>
  ({ lcsc, stock: lcsc === 'C2290' ? 0 : 100000, basic: true }) as unknown as JlcStock;

let dir: string;
let outside: string;
let doc: Doc;
let base: string;
let close: () => Promise<void>;

const get = async (path: string) => {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const post = async (path: string, body: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'flamingo-checks-api-'));
  outside = await mkdtemp(join(tmpdir(), 'flamingo-checks-api-out-'));
  const boardPath = join(dir, 'apiboard.flamingo');
  await writeFile(boardPath, serializeBoard(testBoard()));
  // Specs beside the board: a logic spec, a SPICE config, and things that are neither.
  await writeFile(
    join(dir, 'logic.json'),
    JSON.stringify({
      description: 'LED anode follows 3V3',
      instances: [{ name: 'b', board: '.', supplies: { '3V3': '1' } }],
      free: [],
      invariants: [
        { name: 'rail high', assert: { net: 'b:3V3', is: '1' } },
        { name: 'rail low', assert: { net: 'b:3V3', is: '0' } },
      ],
    }),
  );
  await writeFile(
    join(dir, 'filter.json'),
    JSON.stringify({ description: 'RC on IN', runs: [{ template: 'rc-filter', config: { board: 'apiboard', inputNet: 'IN', outputNet: 'OUT' } }] }),
  );
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
  await writeFile(join(dir, 'broken.json'), '{ not json');
  await writeFile(join(dir, 'big.json'), JSON.stringify({ instances: [], invariants: [], pad: 'x'.repeat(1024 * 1024 + 10) }));
  // A spec outside the board's directory, and a symlink in it pointing there.
  await writeFile(join(outside, 'evil.json'), JSON.stringify({ instances: [{ name: 'b', board: '.' }], invariants: [] }));
  await symlink(join(outside, 'evil.json'), join(dir, 'link.json'));
  await mkdir(join(dir, 'sub'));

  doc = new Doc(parseBoard(await readFile(boardPath, 'utf8')), boardPath);
  const started = await startServer(doc, 0, {
    projectDir: dir,
    loadSymbolPins: noPins,
    partsApi: {
      fetchPart: async () => {
        throw new Error('offline');
      },
      searchParts: async () => [],
      fetchStock: fakeStock,
    },
  });
  base = `http://localhost:${started.port}`;
  close = started.close;
});

afterAll(async () => {
  await close?.();
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('GET /api/checks', () => {
  it('lists the registry in order, then stock flagged as needing the network', async () => {
    const { status, body } = await get('/api/checks');
    expect(status).toBe(200);
    const names = body.checks.map((c: { name: string }) => c.name);
    expect(names.slice(0, 2)).toEqual(['drc', 'erc']);
    expect(names.at(-1)).toBe('stock');
    expect(body.checks.at(-1).network).toBe(true);
    for (const c of body.checks) expect(typeof c.description).toBe('string');
  });
});

describe('GET /api/checks/run', () => {
  it('runs one check and returns sha, timing and findings', async () => {
    const { status, body } = await get('/api/checks/run?only=erc');
    expect(status).toBe(200);
    expect(body.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof body.ms).toBe('number');
    expect(body.findings.every((f: CheckFinding) => f.check === 'erc')).toBe(true);
    expect(body.findings.some((f: CheckFinding) => f.rule === 'polarity' && f.level === 'error')).toBe(true);
    expect(body.waived).toEqual([]);
  });

  it('runs every non-network check by default', async () => {
    const { body } = await get('/api/checks/run');
    const checks = new Set(body.findings.map((f: CheckFinding) => f.check));
    expect(checks.has('drc')).toBe(true); // no outline: drc/missing-outline
    expect(checks.has('erc')).toBe(true);
    expect(checks.has('stock')).toBe(false);
  });

  it('runs stock only when named, through the server parts API', async () => {
    const { body } = await get('/api/checks/run?only=stock');
    expect(body.findings.length).toBeGreaterThan(0);
    expect(body.findings.every((f: CheckFinding) => f.check === 'stock')).toBe(true);
    expect(body.findings.some((f: CheckFinding) => f.items.join(' ').includes('C2290') || f.message.includes('C2290'))).toBe(true);
  });

  it('refuses an unknown check with 400', async () => {
    const { status, body } = await get('/api/checks/run?only=nope');
    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/unknown check/);
  });

  it('splits waived findings from kept ones; the waiver op undoes and the sha follows the board', async () => {
    const before = await get('/api/checks/run?only=erc');
    const polarity = before.body.findings.find((f: CheckFinding) => f.rule === 'polarity');
    const add = await post('/api/op', {
      op: 'addCheckWaiver',
      waiver: { check: 'erc', rule: 'polarity', items: polarity.items, reason: 'test waiver' },
    });
    expect(add.status).toBe(200);

    const after = await get('/api/checks/run?only=erc');
    expect(after.body.findings.some((f: CheckFinding) => f.rule === 'polarity')).toBe(false);
    expect(after.body.waived).toHaveLength(1);
    expect(after.body.waived[0].waiver.reason).toBe('test waiver');
    expect(after.body.waived[0].finding.rule).toBe('polarity');
    expect(after.body.sha).not.toBe(before.body.sha);

    // Bad waivers are refused by the op.
    expect((await post('/api/op', { op: 'addCheckWaiver', waiver: { rule: 'x', items: [], reason: '' } })).status).toBe(400);
    expect((await post('/api/op', { op: 'removeCheckWaiver', index: 5 })).status).toBe(400);

    // Remove it, then undo the removal, then undo the add.
    expect((await post('/api/op', { op: 'removeCheckWaiver', index: 0 })).status).toBe(200);
    expect((await get('/api/checks/run?only=erc')).body.waived).toHaveLength(0);
    await post('/api/undo', {});
    expect((await get('/api/checks/run?only=erc')).body.waived).toHaveLength(1);
    await post('/api/undo', {});
    const restored = await get('/api/checks/run?only=erc');
    expect(restored.body.waived).toHaveLength(0);
    expect(restored.body.sha).toBe(before.body.sha);
  });
});

describe('GET /api/sim/specs', () => {
  it('lists logic specs and SPICE configs beside the board, and nothing else', async () => {
    const { status, body } = await get('/api/sim/specs');
    expect(status).toBe(200);
    // link.json resolves outside but is listed by name only when it classifies; it does (a logic spec),
    // and running it is refused below.
    const byPath = Object.fromEntries(body.specs.map((s: { path: string }) => [s.path, s]));
    expect(byPath['logic.json']).toEqual({ path: 'logic.json', name: 'logic', kind: 'logic', description: 'LED anode follows 3V3' });
    expect(byPath['filter.json']).toMatchObject({ kind: 'spice', description: 'RC on IN' });
    for (const p of ['package.json', 'broken.json', 'big.json']) expect(byPath[p]).toBeUndefined();
    expect(body.templates.map((t: { name: string }) => t.name)).toEqual(
      expect.arrayContaining(['i2c', 'single-wire-uart', 'rc-filter', 'ldo-step', 'hot-plug']),
    );
    expect(typeof body.spice.available).toBe('boolean');
  });
});

describe('POST /api/sim/run', () => {
  it('runs a logic spec: states, per-invariant results with a parsed counterexample, findings', async () => {
    const { status, body } = await post('/api/sim/run', { path: 'logic.json' });
    expect(status).toBe(200);
    expect(body.kind).toBe('logic');
    expect(body.states).toBeGreaterThanOrEqual(1);
    const byName = Object.fromEntries(body.results.map((r: { name: string }) => [r.name, r]));
    expect(byName['rail high'].pass).toBe(true);
    expect(byName['rail low'].pass).toBe(false);
    expect(typeof byName['rail low'].counterexample).toBe('object');
    expect(Array.isArray(body.findings)).toBe(true);
  });

  it('refuses paths outside the board directory, including through a symlink', async () => {
    for (const path of ['../x.json', join(outside, 'evil.json'), 'link.json', `sub/../../${outside.split('/').pop()}/evil.json`]) {
      const { status, body } = await post('/api/sim/run', { path });
      expect(status, path).toBe(403);
      expect(body.error).toMatch(/outside the board's directory/);
    }
  });

  it('rejects bad bodies and files that are not specs', async () => {
    expect((await post('/api/sim/run', {})).status).toBe(400);
    expect((await post('/api/sim/run', { path: 'package.json' })).status).toBe(400);
    expect((await post('/api/sim/run', { path: 'missing.json' })).status).toBe(403);
    const res = await fetch(`${base}/api/sim/run`, { method: 'POST', body: '{nope' });
    expect(res.status).toBe(400);
  });

  it('runs a SPICE config when ngspice or Docker is available, else answers 503', async () => {
    const backend = await findNgspice();
    const { status, body } = await post('/api/sim/run', { path: 'filter.json' });
    if (!backend) {
      expect(status).toBe(503);
      expect(body.error).toMatch(/ngspice is not available/);
      return;
    }
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.kind).toBe('spice');
    expect(['local', 'docker']).toContain(body.backend);
    expect(body.runs[0].template).toBe('rc-filter');
    expect(body.runs[0].summary.length).toBeGreaterThan(0);
  }, 600_000);
});

describe('GET /api/export.print', () => {
  it('downloads the printout as a PDF named after the board', async () => {
    const res = await fetch(`${base}/api/export.print?paper=letter`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="apiboard.print.pdf"');
    const pdf = Buffer.from(await res.arrayBuffer());
    expect(pdf.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
    expect(pdf.toString('latin1')).toContain('/MediaBox [0 0 612 792]'); // US Letter in points
  });

  it('refuses an unknown paper size', async () => {
    expect((await get('/api/export.print?paper=a3')).status).toBe(400);
  });
});

describe('a board that has never been saved', () => {
  it('has no specs, refuses sim runs, and still runs checks and prints', async () => {
    const unsaved = new Doc(parseBoard(await readFile(BLINKER, 'utf8')));
    const started = await startServer(unsaved, 0, { projectDir: dir, loadSymbolPins: noPins });
    const b = `http://localhost:${started.port}`;
    try {
      const specs = (await (await fetch(`${b}/api/sim/specs`)).json()) as { specs: unknown[] };
      expect(specs.specs).toEqual([]);
      const run = await fetch(`${b}/api/sim/run`, { method: 'POST', body: JSON.stringify({ path: 'logic.json' }) });
      expect(run.status).toBe(400);
      const checks = (await (await fetch(`${b}/api/checks/run?only=drc`)).json()) as { ok: boolean; findings: CheckFinding[] };
      expect(checks.ok).toBe(true);
      expect((await fetch(`${b}/api/export.print`)).status).toBe(200);
    } finally {
      await started.close();
    }
  });
});

describe('helpers', () => {
  it('classifySpec', () => {
    expect(classifySpec({ instances: [], invariants: [] })).toBe('logic');
    expect(classifySpec({ runs: [{ template: 'i2c' }] })).toBe('spice');
    expect(classifySpec({ runs: [] })).toBeNull();
    expect(classifySpec({ runs: [{}] })).toBeNull();
    expect(classifySpec([1])).toBeNull();
    expect(classifySpec('x')).toBeNull();
  });

  it('parseCounterexample', () => {
    expect(parseCounterexample('ctrl:IO6=1, bank0:GPA4=Z')).toEqual({ 'ctrl:IO6': '1', 'bank0:GPA4': 'Z' });
    expect(parseCounterexample('never the only low one: a, b')).toEqual({ detail: 'never the only low one: a, b' });
  });
});
