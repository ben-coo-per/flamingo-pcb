/**
 * The driver-select invariants on the real KinAura boards: a ScaleController
 * and two driver banks on one ribbon. Skipped when the boards are not at
 * KINAURA_PCB (default ~/repos/kinaura/pcb); they are not in this repo.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newBoard, simulateLogic } from '@flamingo/engine';
import { pinLookupFor, resolveLogicSpec } from '../src/sim-tools.js';

const KINAURA = process.env.KINAURA_PCB || join(homedir(), 'repos', 'kinaura', 'pcb');
const specPath = fileURLToPath(new URL('./fixtures/logic/kinaura-driver-select.json', import.meta.url));
const raw = JSON.parse(await readFile(specPath, 'utf8')) as { instances: { board: string }[] };
const have = raw.instances.every((i) => existsSync(join(KINAURA, i.board)));

describe.skipIf(!have)(`KinAura driver select (${have ? 'boards found' : `SKIPPED: boards not at ${KINAURA}`})`, () => {
  it('holds every safety invariant over all 531,441 states', async () => {
    const spec = await resolveLogicSpec(raw as Record<string, unknown>, newBoard('unused', 2), KINAURA);
    const pins = await pinLookupFor(spec.instances.map((i) => i.board));
    const { report } = simulateLogic(spec, { pins });
    expect(report.sampled).toBe(false);
    expect(report.states).toBe(531_441); // IO6, IO16 and GPA0-4 on both banks, each 0/1/Z
    const res = Object.fromEntries(report.results.map((r) => [r.name, r]));
    for (const name of [
      'no net is driven high and low at once',
      'at most one StepStick EN low across both banks',
      'no EN low while MOTION_EN is low',
      "the enabled driver's bank mux connects the UART to that driver",
      'BANK_SEL low enables only bank 0',
      'BANK_SEL high enables only bank 1',
      'every driver on both banks can be enabled on its own',
    ]) {
      expect(res[name], name).toMatchObject({ pass: true });
    }

    // Known on 30 Sep 2026: the 74HC4067 enable (U4 E#) follows SEL_N only, not
    // BANK_MISS, so the unaddressed bank's mux can sit on the UART too. Expect
    // the warning while the board is wired that way, and a pass once it is gated.
    const bank = spec.instances.find((i) => i.name === 'bank0')!.board;
    const netOf = (ref: string, pinName: string) => {
      const c = bank.components.find((x) => x.refdes === ref)!;
      const pad = Object.entries(pins(c.lcsc) ?? {}).find(([, p]) => p.name === pinName)![0];
      return bank.nets.find((n) => n.pins.includes(`${ref}.${pad}`))?.name;
    };
    const ungated = netOf('U4', 'E#') === netOf('U3', 'E1#');
    const mux = res["while a driver is enabled no other bank's mux is on the UART"]!;
    expect(mux.pass).toBe(!ungated);
    if (ungated) expect(mux.level).toBe('warn');
  }, 120_000);
});

