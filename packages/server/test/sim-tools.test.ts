import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { newBoard, serializeBoard, type Board, type ComponentInst } from '@flamingo/engine';
import { Doc } from '../src/document.js';
import { startServer, type StartedServer } from '../src/http.js';
import type { PartsApi } from '../src/mcp.js';
import { findNgspice } from '../src/spice-runner.js';

function part(refdes: string, value: string, names: string[]): ComponentInst {
  return {
    refdes,
    lcsc: 'C0',
    at: { x: 0, y: 0 },
    rotation: 0,
    side: 'top',
    fields: { value },
    footprint: {
      name: 'test',
      lcsc: 'C0',
      pads: names.map((_, i) => ({
        number: String(i + 1),
        shape: 'rect' as const,
        at: { x: i, y: 0 },
        rotation: 0,
        size: { w: 0.5, h: 0.5 },
        layer: 'top' as const,
      })),
      silk: [],
      courtyard: [],
      pins: Object.fromEntries(names.map((n, i) => [String(i + 1), { name: n, type: 'undefined' as const }])),
    },
  };
}

/** An RC filter and an XOR gate whose output is pulled down. */
function simBoard(): Board {
  const b = newBoard('simtest', 2);
  b.components = [
    part('R1', '10R', ['1', '2']),
    part('C1', '22uF', ['1', '2']),
    part('U1', 'SN74LVC1G86', ['A', 'B', 'GND', 'Y', 'VCC']),
    part('R2', '10k', ['1', '2']),
  ];
  b.nets = [
    { name: '5V', class: 'default', pins: ['R1.1'] },
    { name: 'AVDD', class: 'default', pins: ['R1.2', 'C1.1'] },
    { name: 'GND', class: 'default', pins: ['C1.2', 'U1.3', 'R2.2'] },
    { name: '3V3', class: 'default', pins: ['U1.5'] },
    { name: 'IN_A', class: 'default', pins: ['U1.1'] },
    { name: 'IN_B', class: 'default', pins: ['U1.2'] },
    { name: 'OUT', class: 'default', pins: ['U1.4', 'R2.1'] },
  ];
  return b;
}

const partsApi: PartsApi = {
  fetchPart: async () => {
    throw new Error('no parts in this test');
  },
  searchParts: async () => [],
  fetchStock: async (lcsc) => ({ lcsc, stock: 1, basic: false }),
};

const xorSpec = (invariant: object) => ({
  instances: [{ name: 'b', board: '.', supplies: { '3V3': '1' } }],
  free: [
    { net: 'b:IN_A', levels: ['0', '1'] },
    { net: 'b:IN_B', levels: ['0', '1'] },
  ],
  invariants: [invariant],
});

describe('simulation MCP tools', () => {
  let started: StartedServer;
  let client: Client;
  let projectDir: string;
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text?: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text ?? '').join('\n'), isError: r.isError ?? false };
  };

  beforeAll(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'flamingo-sim-test-'));
    started = await startServer(new Doc(simBoard()), 0, { partsApi, projectDir });
    client = new Client({ name: 'sim-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${started.port}/mcp`)));
  });

  afterAll(async () => {
    await client.close();
    await started.close();
    await rm(projectDir, { recursive: true, force: true });
  });

  it('export_spice writes the passives on the chosen nets', async () => {
    const r = await call('export_spice', { nets: ['AVDD'] });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('R1 n_5V AVDD 10');
    expect(r.text).toContain('C1 AVDD 0 0.000022');
  });

  it('export_spice builds a template from the open board', async () => {
    const r = await call('export_spice', { template: 'rc-filter', config: { board: 'simtest', inputNet: '5V', outputNet: 'AVDD' } });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('* from the board: series resistance: R1 10R (simtest)');
    expect(r.text).toContain('* ===== deck rc_ac_nominal.cir =====');
  });

  it('export_spice reports a config the board cannot satisfy as an error', async () => {
    const r = await call('export_spice', { template: 'rc-filter', config: { board: 'simtest', inputNet: 'OUT', outputNet: 'AVDD' } });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('no resistor from OUT to AVDD');
  });

  it('simulate_logic checks an invariant over every state of the open board', async () => {
    const pass = await call('simulate_logic', { spec: xorSpec({ name: 'xor', when: { net: 'b:IN_A', is: '1' }, assert: { net: 'b:OUT', is: ['0', '1'] } }) });
    expect(pass.isError).toBe(false);
    expect(pass.text).toContain('Checked all 4 states');
    expect(pass.text).toContain('pass xor');
    const fail = await call('simulate_logic', { spec: xorSpec({ name: 'never high', assert: { net: 'b:OUT', is: '0' } }) });
    expect(fail.text).toMatch(/ERROR  logic\/never high +FAIL never high: 2 states, e\.g\. b:IN_A=0, b:IN_B=1/);
  });

  it('simulate_logic reads a spec file with board paths relative to it', async () => {
    await writeFile(join(projectDir, 'other.flamingo'), serializeBoard(simBoard()));
    const spec = xorSpec({ name: 'xor', assert: { noneFloating: 'b:OUT' } });
    spec.instances[0]!.board = 'other.flamingo';
    await writeFile(join(projectDir, 'spec.json'), JSON.stringify(spec));
    const r = await call('simulate_logic', { specPath: 'spec.json', quiet: true });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('-- 0 errors, 0 warnings, 3 info'); // contention, xor, and the model summary
  });

  it('simulate_logic reports a bad spec as an error', async () => {
    const r = await call('simulate_logic', { spec: xorSpec({ name: 'x', assert: { anyLow: 'b:NOPE' } }) });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('matches no net');
  });

  it('run_spice runs a template, or says it is skipped without ngspice', async () => {
    const backend = await findNgspice();
    const r = await call('run_spice', { template: 'rc-filter', config: { board: 'simtest', inputNet: '5V', outputNet: 'AVDD' } });
    expect(r.isError).toBe(false);
    if (!backend) {
      expect(r.text).toContain('SKIPPED: ngspice is not available');
      return;
    }
    expect(r.text).toMatch(/^Ran with (local ngspice|ngspice in Docker)/);
    // 10 ohm into 22 uF with the 500 ohm assumed load: (1/10 + 1/500) / (2 pi 22 uF) = 738 Hz.
    expect(r.text).toMatch(/rc_nominal: -3 dB at 73\dHz/);
  }, 600_000);
});
