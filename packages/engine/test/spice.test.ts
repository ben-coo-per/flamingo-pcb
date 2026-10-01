import { describe, it, expect } from 'vitest';
import { SPICE_TEMPLATES, Wave, buildSpiceCircuit, exportSpice, parseMeasures, pwl, spiceNode, uartBits } from '../src/index.js';
import type { Board } from '../src/index.js';
import { board, capacitor, part, resistor } from './helpers/netlist.js';

function filterBoard(): Board {
  return board(
    'Filter',
    [
      resistor('R1', '10R'),
      capacitor('C1', '22uF'),
      capacitor('C2', '22uF'),
      capacitor('C3', '100nF'),
      resistor('R2', 'DNP'),
      part('D1', 'white', ['A', 'K']),
      part('D2', 'SS34', ['K', 'A']),
      part('F1', '2A 30V', ['1', '2']),
      part('U1', 'ADS1232', ['AVDD', 'AGND', 'X']),
    ],
    {
      '5V': ['R1.1', 'D2.1', 'F1.2'],
      AVDD: ['R1.2', 'C1.1', 'C2.1', 'C3.1', 'U1.1', 'R2.1'],
      GND: ['C1.2', 'C2.2', 'C3.2', 'U1.2', 'D1.1', 'R2.2'],
      LED: ['D1.2'],
      VIN: ['D2.2'],
      RAW: ['F1.1'],
    },
  );
}

describe('exportSpice', () => {
  it('writes the passives on the chosen nets, ground as node 0, nothing invented', () => {
    const net = exportSpice(filterBoard(), { nets: ['AVDD'] });
    expect(net).toContain('R1 n_5V AVDD 10');
    expect(net).toContain('C1 AVDD 0 0.000022');
    expect(net).toContain('C3 AVDD 0 1e-7');
    // An unreadable value becomes a parameter to fill in, not a guess.
    expect(net).toContain('.param val_R2=0 ; R2 value "DNP" cannot be read: set it');
    expect(net).toContain('R2 AVDD 0 {val_R2}');
    expect(net).toContain('* Not exported (not two-pad passives): U1 (ADS1232)');
    expect(net).not.toContain('D1');
  });

  it('orients diodes from their A/K pin names, and treats fuses as a stated resistance', () => {
    const net = exportSpice(filterBoard());
    expect(net).toMatch(/^DD1 0 LED D_C0/m); // anode pad 1 is on GND: the netlist shows it as it is
    expect(net).toMatch(/^DD2 VIN n_5V D_C0/m); // pad 2 is the anode
    expect(net).toContain('.param r_F1=0.05 ; F1 2A 30V: fuse rating, not a resistance; cold resistance assumed');
    expect(net).toContain('F1 RAW n_5V {r_F1}'.replace('F1 ', 'RF1 '));
  });

  it('names nodes safely', () => {
    expect(spiceNode('GND')).toBe('0');
    expect(spiceNode('AGND')).toBe('0');
    expect(spiceNode('3V3')).toBe('n_3V3');
    expect(spiceNode('LC1_S+')).toBe('LC1_S_');
  });

  it('rejects a net the board does not have', () => {
    expect(() => exportSpice(filterBoard(), { nets: ['NOPE'] })).toThrow(/no net NOPE/);
  });
});

describe('waves and measures', () => {
  const w = Wave.parse(['time v(a) i(vs)', '0 0 1', '1 1 2', '2 3 3', '3 1 4', ''].join('\n'));
  it('interpolates, finds crossings and extremes', () => {
    expect(w.at('a', 1.5)).toBeCloseTo(2);
    expect(w.cross('a', 2, true)).toBeCloseTo(1.5);
    expect(w.cross('a', 2, false)).toBeCloseTo(2.5);
    expect(w.cross('a', 5, true)).toBeNull();
    expect(w.max('a')).toBe(3);
    expect(w.min('i(vs)', 1, 2)).toBe(2);
    expect(() => w.col('b')).toThrow(/no column b/);
  });

  it('parses .measure output, RESULT lines and failed measurements', () => {
    const log = [
      'Circuit: test',
      'tr                  =  3.000000e-07 targ=  1.30e-06 trig=  1.00e-06',
      'vmax                =  3.31e+00 at=  2.0e-06',
      'RESULT corner 245.5',
      'Error: measure  tf  trig(TRIG) : out of interval',
      ' .measure tran tf trig v(out) val=5 rise=1 targ v(out) val=6 rise=1 failed!',
      'Doing analysis at TEMP = 27.000000',
      'Stack = 0 bytes.',
      'Error: measure  tf  failed!',
    ].join('\n');
    const m = parseMeasures(log);
    expect(m.tr).toBeCloseTo(3e-7);
    expect(m.vmax).toBeCloseTo(3.31);
    expect(m.corner).toBe(245.5);
    expect(Number.isNaN(m.tf)).toBe(true);
    expect(Object.keys(m).sort()).toEqual(['corner', 'tf', 'tr', 'vmax']);
  });

  it('builds 8N1 frames and PWL sources', () => {
    const bits = uartBits([0x01], 1, 0);
    expect(bits.map(([, b]) => b)).toEqual([1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
    expect(pwl([[0, 1], [1, 0], [2, 0], [3, 1]], 3.3, 0.1)).toBe('PWL(0 3.3 1 3.3 1.1 0 3 0 3.1 3.3)');
  });
});

describe('templates', () => {
  it('lists five templates', () => {
    expect(Object.keys(SPICE_TEMPLATES).sort()).toEqual(['hot-plug', 'i2c', 'ldo-step', 'rc-filter', 'single-wire-uart']);
  });

  it('rc-filter reads R and C from the board and states its assumptions', () => {
    const c = buildSpiceCircuit('rc-filter', { Filter: filterBoard() }, { board: 'Filter', inputNet: '5V', outputNet: 'AVDD' });
    expect(c.sims.map((s) => s.name)).toEqual(['rc_ac_nominal', 'rc_tran_nominal', 'rc_ac_derated', 'rc_tran_derated']);
    expect(c.inputs).toContainEqual(['series resistance', 'R1 10R (Filter)']);
    expect(c.inputs[1]![1]).toBe('44.1uF: C1 22uF + C2 22uF + C3 100nF (Filter)');
    expect(c.sims[0]!.netlist).toContain('Rs in out 10');
    // 22 uF parts are halved in the derated deck, 100 nF is not.
    expect(c.sims[2]!.netlist).toContain('CaC1 out aC1e 0.000011');
    expect(c.sims[2]!.netlist).toContain('CaC3 out aC3e 1e-7');
    expect(c.assumptions.map((a) => a.key)).toContain('mlcc_derate');
    expect(c.sims[0]!.netlist).toMatch(/wrdata rc_ac_nominal\.csv vdb\(out\)/);
  });

  it('parameter overrides reach the netlist and are labelled', () => {
    const c = buildSpiceCircuit('rc-filter', { Filter: filterBoard() }, { board: 'Filter', inputNet: '5V', outputNet: 'AVDD' }, { rc_load_r: 1000 });
    expect(c.sims[0]!.netlist).toContain('Rload out 0 1000');
    expect(c.assumptions.find((a) => a.key === 'rc_load_r')).toEqual({ key: 'rc_load_r', value: 1000, source: 'set for this run' });
    expect(() => buildSpiceCircuit('rc-filter', { Filter: filterBoard() }, { board: 'Filter', inputNet: '5V', outputNet: 'AVDD' }, { nope: 1 })).toThrow(
      /unknown SPICE parameter nope/,
    );
  });

  it('evaluates waveforms into findings (rc corner vs the stated claim)', () => {
    const c = buildSpiceCircuit('rc-filter', { Filter: filterBoard() }, { board: 'Filter', inputNet: '5V', outputNet: 'AVDD', claimHz: 100 });
    // Synthetic first-order response with a 360 Hz corner, flat input for the transient.
    const ac = (fc: number) => {
      const rows = ['frequency vdb(out)'];
      for (let f = 1; f <= 1e6; f *= 1.05) rows.push(`${f} ${-10 * Math.log10(1 + (f / fc) ** 2)}`);
      return Wave.parse(rows.join('\n'));
    };
    const tran = Wave.parse(['time v(in) v(out)', '0 5 4.9', '0.0009 5 4.9', '0.002 4.86 4.8', '0.012 5 4.9'].join('\n'));
    const { findings, summary } = c.evaluate({ rc_ac_nominal: ac(360), rc_tran_nominal: tran, rc_ac_derated: ac(700), rc_tran_derated: tran });
    expect(findings[0]).toMatchObject({ level: 'warn', check: 'spice', rule: 'rc-filter' });
    expect(findings[0]!.message).toMatch(/corner is 36\dHz, not the 100 Hz the design states/);
    expect(summary[0]).toMatch(/a 140mV input dip moves the output 100mV/);
  });

  it('fails loudly when the board lacks what the config names', () => {
    expect(() => buildSpiceCircuit('rc-filter', { Filter: filterBoard() }, { board: 'Filter', inputNet: 'RAW', outputNet: 'AVDD' })).toThrow(
      /no resistor from RAW to AVDD/,
    );
    expect(() => buildSpiceCircuit('rc-filter', {}, { board: 'Filter' })).toThrow(/no board named Filter/);
    expect(() => buildSpiceCircuit('nope', {}, {})).toThrow(/unknown SPICE template nope/);
  });

  it('i2c combines controller, device-board and module pull-ups', () => {
    const ctrl = board('Ctrl', [resistor('R3', '4.7k'), resistor('R20', '33R')], {
      '3V3': ['R3.1'],
      I2C_SDA: ['R3.2', 'R20.1'],
      BUS_SDA: ['R20.2'],
    });
    const dev = board('Dev', [part('J1', 'h', ['1'])], { SDA: ['J1.1'] });
    const c = buildSpiceCircuit(
      'i2c',
      { Ctrl: ctrl, Dev: dev },
      { controller: 'Ctrl', device: 'Dev', copies: 2, modulePullups: true, lines: [{ name: 'SDA', controllerNet: 'I2C_SDA', connectorNet: 'BUS_SDA', deviceNet: 'SDA' }] },
    );
    expect(c.sims.map((s) => s.name)).toEqual(['i2c_sda_modules', 'i2c_sda_no_module_pullups']);
    expect(c.sims[0]!.netlist).toContain('Rmod1 vdd b1 10000');
    expect(c.sims[1]!.netlist).not.toContain('Rmod');
    expect(c.inputs).toEqual([
      ['SDA pull-up', 'R3 4.7k (Ctrl)'],
      ['SDA series', 'R20 33R (Ctrl)'],
      ['SDA device-board pull-up', 'none'],
    ]);
  });
});
