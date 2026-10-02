import { describe, it, expect } from 'vitest';
import { buildLogicSystem, simulateLogic } from '../src/index.js';
import type { Board, LogicSpec } from '../src/index.js';
import { HC154, HC4067, MCP23017, board, pad, part, resistor } from './helpers/netlist.js';

/**
 * A miniature driver bank: an MCP23017 holds a driver number and an active-low
 * select, a 74HC154 turns it into one active-low EN, a 74HC4067 routes a UART
 * line to the selected driver. MOTION_EN holds the expander in reset.
 */
function miniBank(opts: { swapMuxSelect?: boolean; tieSelectLow?: boolean } = {}): Board {
  const m = (n: string) => `U2.${pad(MCP23017, n)}`;
  const d = (n: string) => `U3.${pad(HC154, n)}`;
  const x = (n: string) => `U4.${pad(HC4067, n)}`;
  const nets: Record<string, string[]> = {
    '3V3': [m('VDD'), d('VCC'), x('VCC'), 'R1.1', 'J1.2'],
    GND: [m('VSS'), d('E2#'), d('GND'), x('GND'), m('A1'), m('A2'), 'R2.2', 'J1.3', 'R10.2', 'R11.2', 'R12.2', 'R13.2'],
    MOTION_EN: [m('RESET#'), 'R2.1', 'J1.1'],
    SEL_N: [m('GPA4'), d('E1#'), x('E#'), 'R1.2'],
    // 10k pull-downs keep the address defined while the expander's pins are inputs.
    A0: [m('GPA0'), d('A0'), x(opts.swapMuxSelect ? 'S1' : 'S0'), 'R10.1'],
    A1: [m('GPA1'), d('A1'), x(opts.swapMuxSelect ? 'S0' : 'S1'), 'R11.1'],
    A2: [m('GPA2'), d('A2'), x('S2'), 'R12.1'],
    A3: [m('GPA3'), d('A3'), x('S3'), 'R13.1'],
    UART: [x('COMMON INOUT/OUTPUT'), 'J1.4'],
  };
  if (opts.tieSelectLow) {
    nets.GND!.push(...nets.SEL_N!.filter((p) => p !== 'R1.2'));
    delete nets.SEL_N;
    nets['3V3'] = nets['3V3']!.filter((p) => p !== 'R1.1');
  }
  for (let k = 0; k < 3; k++) {
    nets[`EN${k}`] = [d(`Y${k}#`), `XL${k}.1`];
    nets[`PDN${k}`] = [x(`I${k}`), `XL${k}.4`];
  }
  return board(
    'MiniBank',
    [
      part('U2', 'MCP23017', MCP23017),
      part('U3', 'CD74HC154', HC154),
      part('U4', 'CD74HC4067', HC4067),
      resistor('R1', '10k'),
      resistor('R2', '10k'),
      ...[10, 11, 12, 13].map((k) => resistor(`R${k}`, '10k')),
      part('J1', 'header', ['1', '2', '3', '4']),
      ...[0, 1, 2].map((k) => part(`XL${k}`, 'socket', ['1', '2', '3', '4'])),
    ],
    nets,
  );
}

function controller(): Board {
  return board(
    'Ctrl',
    [part('U1', 'MCU', ['IO6', 'IO7', 'VDD', 'GND']), resistor('R9', '33R'), part('J5', 'header', ['1', '2', '3', '4'])],
    {
      M_EN: ['U1.1', 'R9.1'],
      BUS_M_EN: ['R9.2', 'J5.1'],
      '3V3': ['U1.3', 'J5.2'],
      GND: ['U1.4', 'J5.3'],
      TMC: ['U1.2', 'J5.4'],
    },
  );
}

function spec(bank: Board, extra: Partial<LogicSpec> = {}): LogicSpec {
  return {
    instances: [
      { name: 'ctrl', board: controller(), supplies: { '3V3': '1' } },
      { name: 'bank0', board: bank },
    ],
    links: [{ from: 'ctrl:J5', to: ['bank0:J1'] }],
    free: [{ net: 'ctrl:U1.IO6' }, { register: 'bank0:U2', pins: ['GPA0', 'GPA1', 'GPA4'] }],
    invariants: [
      { name: 'one EN', assert: { atMostOneLow: 'bank0:XL*.1' } },
      { name: 'none while MOTION_EN low', when: { net: 'bank0:MOTION_EN', is: ['0', 'Z', 'X'] }, assert: { noneLow: 'bank0:XL*.1' } },
      { name: 'mux follows', selectFollows: { enable: 'bank0:XL{i}.1', mux: 'bank0:U4', channel: 'bank0:XL{i}.4' } },
      { name: 'each reachable', eachCanBeLowAlone: 'bank0:XL*.1' },
    ],
    ...extra,
  };
}

const byName = (r: { results: { name: string; pass: boolean }[] }, n: string) => r.results.find((x) => x.name === n)!;

describe('logic simulation', () => {
  it('a correct mini bank passes every invariant, exhaustively', () => {
    const { report, findings } = simulateLogic(spec(miniBank()));
    expect(report.sampled).toBe(false);
    expect(report.states).toBe(3 * 27); // IO6 x three register pins, each 0/1/Z
    for (const r of report.results) expect(r, r.name).toMatchObject({ pass: true });
    expect(findings.every((f) => f.level === 'info')).toBe(true);
    expect(report.modelled).toEqual(['bank0:U2 mcp23017', 'bank0:U3 hc154', 'bank0:U4 hc4067']);
    expect(report.unmodelled).toEqual(['ctrl:U1 MCU']); // ICs outside the model are listed, not guessed at
  });

  it('the 33 ohm series resistor and the ribbon join the MCU pin to RESET#', () => {
    const sys = buildLogicSystem(spec(miniBank()));
    expect(sys.netId('ctrl', 'M_EN')).toBe(sys.netId('bank0', 'MOTION_EN'));
    expect(sys.netId('ctrl', 'M_EN')).toBe(sys.netId('ctrl', 'BUS_M_EN'));
  });

  it('catches a mux whose select lines are swapped', () => {
    const { report, findings } = simulateLogic(spec(miniBank({ swapMuxSelect: true })));
    expect(byName(report, 'mux follows').pass).toBe(false);
    expect(byName(report, 'one EN').pass).toBe(true);
    const f = findings.find((x) => x.rule === 'mux follows')!;
    expect(f.level).toBe('error');
    expect(f.message).toMatch(/FAIL mux follows: \d+ states, e\.g\. ctrl:U1\.IO6=1/);
  });

  it('catches two banks that can both enable a driver (no bank select)', () => {
    const s = spec(miniBank());
    s.instances.push({ name: 'bank1', board: miniBank() });
    s.links = [{ from: 'ctrl:J5', to: ['bank0:J1', 'bank1:J1'] }];
    s.free = [{ net: 'ctrl:U1.IO6' }, { register: 'bank*:U2', pins: ['GPA0', 'GPA4'] }];
    s.invariants = [{ name: 'one EN machine-wide', assert: { atMostOneLow: 'bank*:XL*.1' } }];
    const { report } = simulateLogic(s);
    const r = byName(report, 'one EN machine-wide');
    expect(r.pass).toBe(false);
    expect((r as { counterexample?: string }).counterexample).toContain('bank1:U2.GPA4=0');
  });

  it('a select tied low lets a driver run while MOTION_EN is low', () => {
    // With SEL_N on GND the decoder stays enabled when the expander is in reset;
    // the pull-downs then select driver 0.
    const { report } = simulateLogic(spec(miniBank({ tieSelectLow: true }), { free: [{ net: 'ctrl:U1.IO6' }] }));
    expect(byName(report, 'none while MOTION_EN low').pass).toBe(false);
    expect(byName(report, 'one EN').pass).toBe(true);
  });

  it('an address line with no pull floats into the decoder and is rejected', () => {
    const b = miniBank();
    b.nets.find((n) => n.name === 'A3')!.pins.pop(); // drop R13
    const { report } = simulateLogic(spec(b));
    expect(byName(report, 'one EN').pass).toBe(false);
  });

  it('eachCanBeLowAlone names the drivers no state reaches', () => {
    const s = spec(miniBank());
    // GPA1 stays an input and its pull-down holds A1 low, so code 2 (XL2) is never selected.
    s.free = [{ net: 'ctrl:U1.IO6' }, { register: 'bank0:U2', pins: ['GPA0', 'GPA4'] }];
    const { report } = simulateLogic(s);
    const r = byName(report, 'each reachable');
    expect(r.pass).toBe(false);
    expect((r as { counterexample?: string }).counterexample).toBe('never the only low one: bank0:XL2.1');
  });

  it('reports contention', () => {
    const b = board(
      'Fight',
      [part('U1', 'SN74LVC1G86', ['A', 'B', 'GND', 'Y', 'VCC']), part('U2', 'SN74LVC1G08', ['A', 'B', 'GND', 'Y', 'VCC'])],
      { '3V3': ['U1.5', 'U2.5'], GND: ['U1.3', 'U2.3', 'U2.2'], IN: ['U1.1', 'U2.1'], HI: ['U1.2'], OUT: ['U1.4', 'U2.4'] },
    );
    const { report } = simulateLogic({
      instances: [{ name: 'b', board: b, supplies: { '3V3': '1' } }],
      free: [{ net: 'b:IN', levels: ['0', '1'] }, { net: 'b:HI', levels: ['1'] }],
      invariants: [],
    });
    // XOR(IN,1) = !IN against AND(IN,0) = 0: they disagree when IN = 0.
    const r = byName(report, 'no net is driven high and low at once') as { pass: boolean; detail?: string; failures: number };
    expect(r.pass).toBe(false);
    expect(r.failures).toBe(1);
    expect(r.detail).toBe('contention on b:OUT');
  });

  it('gate models: XOR, controlling inputs, and pulls', () => {
    const b = board(
      'Gates',
      [
        part('U1', 'SN74LVC1G86', ['A', 'B', 'GND', 'Y', 'VCC']),
        part('U2', 'SN74LVC1G00', ['A', 'B', 'GND', 'Y', 'VCC']),
        resistor('R1', '10k'),
        resistor('R2', '10k'),
        resistor('R3', '4.7k'),
      ],
      {
        '3V3': ['U1.5', 'U2.5', 'R1.1', 'R3.1'],
        GND: ['U1.3', 'U2.3', 'R3.2'],
        A: ['U1.1', 'U2.1'],
        B: ['U1.2', 'R1.2'], // pulled up
        FLOAT: ['U2.2'], // never driven: X in, but A=0 controls the NAND
        X1: ['U1.4'],
        X2: ['U2.4', 'R2.1'],
        PULLED: ['R2.2'],
      },
    );
    const s: LogicSpec = {
      instances: [{ name: 'g', board: b, supplies: { '3V3': '1' } }],
      free: [{ net: 'g:A', levels: ['0'] }],
      invariants: [
        { name: 'xor', assert: { net: 'g:X1', is: '1' } },
        { name: 'nand controlled', assert: { net: 'g:X2', is: '1' } },
        { name: 'pulled through 10k', assert: { net: 'g:PULLED', is: '1' } },
      ],
    };
    const { report } = simulateLogic(s);
    for (const r of report.results) expect(r, r.name).toMatchObject({ pass: true });
  });

  it('samples past maxStates and says so', () => {
    const { report, findings } = simulateLogic(spec(miniBank()), { maxStates: 10 });
    expect(report).toMatchObject({ sampled: true, states: 10, totalStates: 81 });
    expect(findings[0]!.message).toContain('10 sampled of 81 states');
  });

  it('rejects links between headers with different pads, and bad selectors', () => {
    const s = spec(miniBank());
    s.links = [{ from: 'ctrl:J5', to: ['bank0:U2'] }];
    expect(() => simulateLogic(s)).toThrow(/different pads/);
    expect(() => simulateLogic(spec(miniBank(), { free: [{ net: 'bank0:NOPE' }] }))).toThrow(/exactly one net/);
    expect(() => simulateLogic(spec(miniBank(), { invariants: [{ name: 'x', assert: { anyLow: 'bank0:NOPE*' } }] }))).toThrow(
      /matches no net/,
    );
  });
});
