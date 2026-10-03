import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { newBoard, serializeBoard } from '@flamingo/engine';
import type { Board, ComponentInst, Footprint, SymbolPin } from '@flamingo/engine';
import { newPanel, serializePanel } from '@flamingo/panel';
import { Doc } from '../src/document.js';
import { startServer } from '../src/http.js';
import { runCheckCli } from '../src/check-cli.js';
import { registerCheck, registerPanelCheck, runChecks } from '../src/checks.js';

// ---------------------------------------------------------------------------
// A board with one reversed LED: the KinAura fault, in miniature.
// ---------------------------------------------------------------------------

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
      ? {
          pins: {
            '1': { name: pins[0], type: 'undefined' } as SymbolPin,
            '2': { name: pins[1], type: 'undefined' } as SymbolPin,
          },
        }
      : {}),
  };
  return { refdes, lcsc, footprint, at: { x, y: 10 }, rotation: 0, side: 'top', fields: value ? { value } : {} };
}

function ledBoard(reversed: boolean): Board {
  const b = newBoard('ledboard', 2);
  b.components = [twoPad('D1', 'C2290', 10, ['A', 'K'], 'white', 'LED0603-R-RD_WHITE'), twoPad('R1', 'C21190', 14, undefined, '1k')];
  const a = 'D1.1';
  const k = 'D1.2';
  b.nets = [
    { name: 'GND', class: 'default', pins: [reversed ? a : k] },
    { name: 'LED_A', class: 'default', pins: [reversed ? k : a, 'R1.1'] },
    { name: '3V3', class: 'default', pins: ['R1.2'] },
  ];
  return b;
}

const noPins = async () => new Map<string, Record<string, SymbolPin>>();

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t), loadSymbolPins: noPins } };
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'flamingo-checks-test-'));
  await writeFile(join(dir, 'bad.flamingo'), serializeBoard(ledBoard(true)));
  await writeFile(join(dir, 'good.flamingo'), serializeBoard(ledBoard(false)));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('flamingo check', () => {
  it('exits 1 on an ERC error and names it', async () => {
    const c = capture();
    expect(await runCheckCli([join(dir, 'bad.flamingo'), '--only', 'erc'], c.io)).toBe(1);
    const text = c.out.join('\n');
    expect(text).toMatch(/== ledboard .*bad\.flamingo {2}sha256 [0-9a-f]{12}/);
    expect(text).toMatch(/ERROR {2}erc\/polarity .*D1 \(white\) is reversed/);
    expect(text).toMatch(/-- 1 errors/);
  });

  it('exits 0 on a clean board, and --quiet leaves out info', async () => {
    const c = capture();
    expect(await runCheckCli([join(dir, 'good.flamingo'), '--only=erc', '--quiet'], c.io)).toBe(0);
    expect(c.out.join('\n')).not.toMatch(/^INFO/m);
  });

  it('--json prints a report with the file hash and counts', async () => {
    const c = capture();
    expect(await runCheckCli([join(dir, 'bad.flamingo'), '--only', 'erc', '--json'], c.io)).toBe(1);
    const report = JSON.parse(c.out.join('\n'));
    expect(report.board).toBe('ledboard');
    expect(report.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.counts.error).toBe(1);
    expect(report.findings.find((f: { level: string }) => f.level === 'error')).toMatchObject({ check: 'erc', rule: 'polarity' });
  });

  it('runs DRC too by default (the fresh board has no outline)', async () => {
    const c = capture();
    expect(await runCheckCli([join(dir, 'good.flamingo')], c.io)).toBe(1);
    expect(c.out.join('\n')).toMatch(/ERROR {2}drc\/missing-outline/);
  });

  it('exits 2 when the tool itself fails', async () => {
    for (const args of [[join(dir, 'missing.flamingo')], [join(dir, 'good.flamingo'), '--only', 'nope'], [], ['--bogus', 'x.flamingo']]) {
      const c = capture();
      expect(await runCheckCli(args, c.io), args.join(' ')).toBe(2);
      expect(c.err.join('\n')).not.toBe('');
    }
  });

  it('checks every board of a panel, then the panel checks', async () => {
    const panel = newPanel('order');
    panel.sources.push(
      { key: 'B', path: 'bad.flamingo', hash: 'sha256:0', name: 'ledboard', needed: 1, niceToHave: 0 } as never,
      { key: 'G', path: 'good.flamingo', hash: 'sha256:0', name: 'ledboard', needed: 1, niceToHave: 0 } as never,
    );
    await writeFile(join(dir, 'order.plamingo'), serializePanel(panel));
    let seen: string[] = [];
    registerPanelCheck({
      name: 'test-panel',
      description: 'records the boards it was given',
      run: (_p, boards) => {
        seen = boards.map((b) => b.key);
        return [{ check: 'test-panel', rule: 'seen', level: 'warn', message: `boards ${seen.join(',')}`, items: [] }];
      },
    });
    const c = capture();
    expect(await runCheckCli([join(dir, 'order.plamingo'), '--only', 'erc,test-panel', '--quiet'], c.io)).toBe(1);
    expect(seen).toEqual(['B', 'G']);
    const text = c.out.join('\n');
    expect(text.match(/^== ledboard/gm)).toHaveLength(2);
    expect(text).toMatch(/== order[\s\S]*WARN {3}test-panel\/seen +boards B,G/);
  });
});

describe('check registry', () => {
  it('runs registered checks in order, and --only picks them', async () => {
    registerCheck({
      name: 'test-board',
      description: 'one info per board',
      run: (b) => [{ check: 'test-board', rule: 'hello', level: 'info', message: b.name, items: [] }],
    });
    const ctx = { pins: () => undefined };
    const all = await runChecks(ledBoard(false), ctx);
    expect(all.map((f) => f.check)).toEqual(expect.arrayContaining(['drc', 'test-board']));
    const only = await runChecks(ledBoard(false), ctx, ['test-board']);
    expect(only).toEqual([{ check: 'test-board', rule: 'hello', level: 'info', message: 'ledboard', items: [] }]);
    await expect(runChecks(ledBoard(false), ctx, ['nope'])).rejects.toThrow(/unknown check/);
  });
});

describe('run_erc and the export gate', () => {
  it('run_erc reports the reversed LED; export_fab refuses, then exports with checks.json when waived', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'flamingo-erc-mcp-'));
    const doc = new Doc(ledBoard(true));
    const started = await startServer(doc, 0, { projectDir, loadSymbolPins: noPins });
    const client = new Client({ name: 't', version: '0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${started.port}/mcp`)));
      const text = (r: unknown) => (r as { content: { text?: string }[] }).content.map((x) => x.text ?? '').join('\n');

      const erc = await client.callTool({ name: 'run_erc', arguments: { quiet: true } });
      expect(erc.isError).toBeFalsy();
      expect(text(erc)).toMatch(/ERROR {2}erc\/polarity/);

      const refused = await client.callTool({ name: 'export_fab', arguments: {} });
      expect(refused.isError).toBe(true);
      expect(text(refused)).toMatch(/ERC errors:[\s\S]*polarity[\s\S]*Export refused/);

      const waived = await client.callTool({ name: 'export_fab', arguments: { waiveDrc: true } });
      expect(waived.isError).toBeFalsy();
      expect(text(waived)).toMatch(/Waived 1 ERC error/);
      const report = JSON.parse(await readFile(join(projectDir, 'fab', 'checks.json'), 'utf8'));
      expect(report.counts.error).toBeGreaterThanOrEqual(2); // missing outline + reversed LED
      expect(report.findings.some((f: { rule: string }) => f.rule === 'polarity')).toBe(true);

      const api = await (await fetch(`http://localhost:${started.port}/api/erc`)).json();
      expect(api.ok).toBe(true);
      expect(api.findings.some((f: { rule: string; level: string }) => f.rule === 'polarity' && f.level === 'error')).toBe(true);
    } finally {
      await client.close();
      await started.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

describe('interconnect through flamingo check', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'flamingo-link-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A board whose 2-pin header J1 carries `nets` on pads 1 and 2. */
  function headerBoard(name: string, nets: [string, string]): Board {
    const b = newBoard(name, 2);
    b.components.push(twoPad('J1', 'C1', 5));
    b.nets.push({ name: nets[0], class: 'default', pins: ['J1.1'] }, { name: nets[1], class: 'default', pins: ['J1.2'] });
    return b;
  }

  it('reports a cable whose pins disagree, and passes one that matches', async () => {
    await writeFile(join(dir, 'a.flamingo'), serializeBoard(headerBoard('a', ['SDA', 'GND'])));
    await writeFile(join(dir, 'ok.flamingo'), serializeBoard(headerBoard('ok', ['SDA', 'GND'])));
    await writeFile(join(dir, 'swapped.flamingo'), serializeBoard(headerBoard('swapped', ['GND', 'SDA'])));
    const write = async (file: string, to: string) => {
      const panel = newPanel('cable');
      panel.sources.push(
        { key: 'A', path: 'a.flamingo', hash: 'sha256:0', name: 'a', needed: 1, niceToHave: 0 } as never,
        { key: 'B', path: to, hash: 'sha256:0', name: 'b', needed: 1, niceToHave: 0 } as never,
      );
      panel.links = [{ id: 'L1', from: 'A:J1', to: ['B:J1'], map: 'straight' }];
      await writeFile(join(dir, file), serializePanel(panel));
    };
    await write('good.plamingo', 'ok.flamingo');
    await write('bad.plamingo', 'swapped.flamingo');

    const good = capture();
    expect(await runCheckCli([join(dir, 'good.plamingo'), '--only', 'interconnect'], good.io)).toBe(0);
    const bad = capture();
    expect(await runCheckCli([join(dir, 'bad.plamingo'), '--only', 'interconnect'], bad.io)).toBe(1);
    expect(bad.out.join('\n')).toMatch(/ERROR {2}interconnect\//);
  });
});
