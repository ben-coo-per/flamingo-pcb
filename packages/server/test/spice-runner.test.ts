/**
 * The ngspice runner, and the SPICE templates on the KinAura boards.
 *
 * Tests that run ngspice are skipped (with the reason in their name) when
 * neither a local ngspice nor Docker is available. The KinAura tests also need
 * the boards, which are not in this repo: they are read from KINAURA_PCB
 * (default ~/repos/kinaura/pcb) and skipped when absent.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseBoard, type Board, type CheckFinding } from '@flamingo/engine';
import { findNgspice, logErrors, runSpiceNetlist, runSpiceTemplate, type NgspiceBackend } from '../src/spice-runner.js';

const backend: NgspiceBackend | null = await findNgspice();
const KINAURA = process.env.KINAURA_PCB || join(homedir(), 'repos', 'kinaura', 'pcb');
const fixture = JSON.parse(await readFile(new URL('./fixtures/spice/kinaura.json', import.meta.url), 'utf8')) as {
  boards: Record<string, string>;
  runs: { template: string; config: unknown; params?: Record<string, number> }[];
};
const haveBoards = Object.values(fixture.boards).every((p) => existsSync(join(KINAURA, p)));

describe('logErrors', () => {
  it('flags errors, failed measurements and timestep failures, not ordinary log lines', () => {
    const log = ['Circuit: x', 'Error: unknown model swx', 'tr = 1e-7', 'measure tf failed!', "doAnalyses: TRAN:  Timestep too small", 'Note: ok'].join('\n');
    expect(logErrors(log)).toEqual(['Error: unknown model swx', 'measure tf failed!', 'doAnalyses: TRAN:  Timestep too small']);
  });
});

describe.skipIf(!backend)(`ngspice runner (${backend ? 'available' : 'SKIPPED: no ngspice or Docker'})`, () => {
  it('runs a hand-written deck, reports its .measure results, and cleans up', async () => {
    const before = existsSync(join(homedir(), '.cache/flamingo/spice')) ? readdirSync(join(homedir(), '.cache/flamingo/spice')).length : 0;
    const deck = [
      '* RC step',
      'V1 in 0 PULSE(0 1 1u 1n 1n 1 2)',
      'R1 in out 1k',
      'C1 out 0 1n',
      '.tran 10n 10u',
      '.measure tran tr trig v(out) val=0.1 rise=1 targ v(out) val=0.9 rise=1',
      '.measure tran never trig v(out) val=5 rise=1 targ v(out) val=6 rise=1',
      '.end',
      '',
    ].join('\n');
    const r = await runSpiceNetlist(deck, { backend: backend! });
    // 10-90 % of an RC step is RC ln 9 = 2.197 us.
    expect(r.measures.tr).toBeCloseTo(2.197e-6, 8);
    expect(Number.isNaN(r.measures.never)).toBe(true);
    expect(r.findings.find((f) => f.items[0] === 'never')?.level).toBe('warn');
    expect(r.findings.some((f) => f.level === 'error')).toBe(false);
    const after = readdirSync(join(homedir(), '.cache/flamingo/spice')).length;
    expect(after).toBe(before);
  }, 600_000);
});

describe.skipIf(!backend || !haveBoards)(
  `SPICE templates on the KinAura boards (${!haveBoards ? `SKIPPED: boards not at ${KINAURA}` : !backend ? 'SKIPPED: no ngspice or Docker' : 'available'})`,
  () => {
    let boards: Record<string, Board>;
    beforeAll(async () => {
      boards = {};
      for (const [k, p] of Object.entries(fixture.boards)) boards[k] = parseBoard(await readFile(join(KINAURA, p), 'utf8'));
      // The numbers below were taken on 30 Sep 2026, when R26 (the TX-to-RX
      // resistor) was 1k. Pin it, so later board edits do not move them.
      boards.ScaleController!.components.find((c) => c.refdes === 'R26')!.fields.value = '1k';
    });
    const run = (template: string) => {
      const r = fixture.runs.find((x) => x.template === template)!;
      return runSpiceTemplate(template, boards, r.config, r.params, { backend: backend! });
    };
    const summaryLine = (s: string, name: string) => s.split('\n').find((l) => l.trim().startsWith(name))!;
    const num = (line: string, re: RegExp): number => {
      const m = re.exec(line);
      if (!m) throw new Error(`no match for ${re} in ${line}`);
      const unit = { n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, '': 1 }[m[2] ?? ''] ?? 1;
      return Number(m[1]) * unit;
    };
    const levels = (f: CheckFinding[]) => f.map((x) => x.level);

    it('i2c: 300 ns worst rise with the breakouts, 582 ns without (prototype: 300 / 582)', async () => {
      const r = await run('i2c');
      expect(num(summaryLine(r.summary, 'i2c_sda_modules'), /worst ([\d.]+)(n|u)s/)).toBeCloseTo(300e-9, 8.5);
      expect(num(summaryLine(r.summary, 'i2c_sda_no_module_pullups'), /worst ([\d.]+)(n|u)s/)).toBeCloseTo(582e-9, 8);
      expect(levels(r.findings).filter((l) => l === 'warn')).toHaveLength(2);
    }, 600_000);

    it('single-wire UART: host RX low 0.71 V typ / 0.98 V worst with 1k; 2.2k passes (prototype: 0.712 / 0.977 / 0.537)', async () => {
      const r = await run('single-wire-uart');
      expect(num(summaryLine(r.summary, 'uart_rx_typ'), /low max ([\d.]+)(m?)V/)).toBeCloseTo(0.712, 2);
      expect(num(summaryLine(r.summary, 'uart_rx_worst '), /low max ([\d.]+)(m?)V/)).toBeCloseTo(0.977, 2);
      expect(num(summaryLine(r.summary, 'uart_rx_worst_2.2k'), /low max ([\d.]+)(m?)V/)).toBeCloseTo(0.537, 2);
      const worst = r.findings.find((f) => f.message.includes('Ron 300 ohm at the host RX'))!;
      expect(worst.level).toBe('warn');
      expect(r.findings.some((f) => /what-if: a 2.2k ohm .* passes: low 537mV/.test(f.message))).toBe(true);
    }, 600_000);

    it('rc-filter: AVDD corner 245 Hz against the README 240 Hz (prototype 235 Hz, measured from 0 dB rather than DC gain)', async () => {
      const r = await run('rc-filter');
      const f3 = num(summaryLine(r.summary, 'rc_nominal'), /-3 dB at ([\d.]+)(k?)Hz/);
      expect(f3).toBeGreaterThan(235);
      expect(f3).toBeLessThan(255);
      expect(levels(r.findings)).toEqual(['info', 'info']);
    }, 600_000);

    it('ldo-step: 3V3 dips to 3.23 V at worst (prototype 3.23 V)', async () => {
      const r = await run('ldo-step');
      expect(num(summaryLine(r.summary, 'ldo_worst '), /dips to ([\d.]+)(m?)V/)).toBeCloseTo(3.23, 2);
      expect(levels(r.findings).every((l) => l === 'info')).toBe(true);
    }, 600_000);

    it('hot-plug: 51 A peak into VM, 17 A into the servo rail (prototype 51.3 / 17.1 A)', async () => {
      const r = await run('hot-plug');
      expect(num(summaryLine(r.summary, 'hotplug_vm'), /peaks at ([\d.]+)()A/)).toBeCloseTo(51.3, 0);
      expect(num(summaryLine(r.summary, 'hotplug_5v_servo'), /peaks at ([\d.]+)()A/)).toBeCloseTo(17.1, 0);
    }, 600_000);
  },
);
