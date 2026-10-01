import { describe, it, expect } from 'vitest';
import { newBoard, runErc } from '../src/index.js';
import type { Board, CheckFinding, ComponentInst, Footprint, Pad, SymbolPin } from '../src/index.js';

// ---------------------------------------------------------------------------
// Synthetic boards: parts are a row of SMD pads, named through footprint.pins.
// ---------------------------------------------------------------------------

function part(
  refdes: string,
  lcsc: string,
  pinNames: string[] | number,
  at = { x: 10, y: 10 },
  fields: ComponentInst['fields'] = {},
  footprintName = 'fp',
): ComponentInst {
  const names = typeof pinNames === 'number' ? Array.from({ length: pinNames }, (_, i) => String(i + 1)) : pinNames;
  const pads: Pad[] = names.map((_, i) => ({
    number: String(i + 1),
    shape: 'rect',
    at: { x: i * 1.0, y: 0 },
    rotation: 0,
    size: { w: 0.5, h: 0.5 },
    layer: 'top',
  }));
  const pins: Record<string, SymbolPin> = {};
  names.forEach((n, i) => (pins[String(i + 1)] = { name: n, type: 'undefined' }));
  const footprint: Footprint = { name: footprintName, lcsc, pads, silk: [], courtyard: [], pins };
  return { refdes, lcsc, footprint, at, rotation: 0, side: 'top', fields };
}

const res = (ref: string, value: string, at = { x: 12, y: 12 }) => part(ref, 'CR', 2, at, { value });
const cap = (ref: string, value: string, at = { x: 11, y: 11 }) => part(ref, 'CC', 2, at, { value });

function board(comps: ComponentInst[], nets: Record<string, string[]>): Board {
  const b = newBoard('t', 2);
  b.components = comps;
  b.nets = Object.entries(nets).map(([name, pins]) => ({ name, class: 'default', pins }));
  return b;
}

const XOR = 'C52350'; // SN74LVC1G86: A B GND Y VCC
const xor = (at = { x: 10, y: 10 }) => part('U1', XOR, ['A', 'B', 'GND', 'Y', 'VCC'], at);

/** A clean single-gate board: inputs pulled, supply decoupled next to the pin. */
function cleanXor(): { comps: ComponentInst[]; nets: Record<string, string[]> } {
  return {
    comps: [xor(), res('R1', '10k'), res('R2', '10k'), cap('C1', '100nF'), res('R3', '1k'), part('J1', 'CJ', 2, { x: 20, y: 20 })],
    nets: {
      GND: ['U1.3', 'R2.2', 'C1.2', 'J1.2'],
      '3V3': ['U1.5', 'R1.2', 'C1.1', 'J1.1'],
      IN_A: ['U1.1', 'R1.1'],
      IN_B: ['U1.2', 'R2.1'],
      OUT: ['U1.4', 'R3.1'],
      OUT2: ['R3.2', 'J1.1'],
    },
  };
}

const rules = (fs: CheckFinding[], level?: string) =>
  fs.filter((f) => !level || f.level === level).map((f) => f.rule);

describe('runErc', () => {
  it('a clean board has no errors or warnings', () => {
    const { comps, nets } = cleanXor();
    // OUT2 and 3V3 both hold J1.1 in this fixture only to keep every net two-pinned; drop it from OUT2.
    nets.OUT2 = ['R3.2', 'J1.2'];
    nets.GND = ['U1.3', 'R2.2', 'C1.2'];
    const f = runErc(board(comps, nets));
    expect(f.filter((x) => x.level !== 'info')).toEqual([]);
    expect(f.every((x) => x.check === 'erc')).toBe(true);
  });

  it('power-pins: unconnected supply, ground pin on a signal, supply pin on ground', () => {
    const { comps, nets } = cleanXor();
    nets['3V3'] = nets['3V3']!.filter((p) => p !== 'U1.5');
    expect(runErc(board(comps, nets)).find((f) => f.rule === 'power-pins')?.message).toMatch(/U1 VCC \(5\) is not connected/);

    const swapped = cleanXor();
    swapped.nets.GND = swapped.nets.GND!.filter((p) => p !== 'U1.3');
    swapped.nets.OUT!.push('U1.3');
    expect(runErc(board(swapped.comps, swapped.nets)).some((f) => f.rule === 'power-pins' && /ground pin on net OUT/.test(f.message))).toBe(true);

    const vccOnGnd = cleanXor();
    vccOnGnd.nets['3V3'] = vccOnGnd.nets['3V3']!.filter((p) => p !== 'U1.5');
    vccOnGnd.nets.GND!.push('U1.5');
    expect(rules(runErc(board(vccOnGnd.comps, vccOnGnd.nets)), 'error')).toContain('power-pins');
  });

  it('single-pin-net', () => {
    const { comps, nets } = cleanXor();
    nets.LONELY = ['R3.2'];
    delete nets.OUT2;
    const f = runErc(board(comps, nets)).filter((x) => x.rule === 'single-pin-net');
    expect(f).toHaveLength(1);
    expect(f[0]!.items).toContain('net:LONELY');
  });

  it('floating-input: input on no net, on an undriven net, and driven only through a connector', () => {
    const open = cleanXor();
    delete open.nets.IN_A;
    open.comps = open.comps.filter((c) => c.refdes !== 'R1');
    expect(runErc(board(open.comps, open.nets)).find((f) => f.rule === 'floating-input')).toMatchObject({
      level: 'error',
      items: ['U1.1', 'U1'],
    });

    const undriven = cleanXor();
    undriven.comps.push(cap('C9', '1nF', { x: 30, y: 30 }));
    undriven.nets.IN_A = ['U1.1', 'C9.1'];
    undriven.nets.GND!.push('C9.2');
    expect(rules(runErc(board(undriven.comps, undriven.nets)), 'error')).toContain('floating-input');

    const viaCable = cleanXor();
    viaCable.comps.push(part('J2', 'CJ', 2, { x: 40, y: 40 }));
    viaCable.nets.IN_A = ['U1.1', 'J2.1'];
    viaCable.nets.GND!.push('J2.2');
    const w = runErc(board(viaCable.comps, viaCable.nets)).find((f) => f.rule === 'floating-input');
    expect(w?.level).toBe('warn');
    expect(w?.message).toMatch(/floats when the cable is unplugged/);
  });

  it('unconnected-ic-pin: unknown roles warn, known outputs are info, inputs go to floating-input', () => {
    const { comps, nets } = cleanXor();
    comps.push(part('U2', 'CUNKNOWN', ['FOO', 'BAR'], { x: 50, y: 50 }));
    delete nets.OUT;
    delete nets.OUT2;
    const f = runErc(board(comps, nets)).filter((x) => x.rule === 'unconnected-ic-pin');
    expect(f.filter((x) => x.level === 'warn').map((x) => x.items[0])).toEqual(['U2.1', 'U2.2']);
    expect(f.find((x) => x.items[0] === 'U1.4')?.level).toBe('info');
  });

  it('decoupling: no capacitor, and a capacitor too far away', () => {
    const none = cleanXor();
    none.comps = none.comps.filter((c) => c.refdes !== 'C1');
    none.nets['3V3'] = none.nets['3V3']!.filter((p) => p !== 'C1.1');
    none.nets.GND = none.nets.GND!.filter((p) => p !== 'C1.2');
    expect(runErc(board(none.comps, none.nets)).find((f) => f.rule === 'decoupling')?.message).toMatch(/no capacitor/);

    const far = cleanXor();
    far.comps = far.comps.map((c) => (c.refdes === 'C1' ? cap('C1', '100nF', { x: 60, y: 10 }) : c));
    const f = runErc(board(far.comps, far.nets)).find((x) => x.rule === 'decoupling');
    expect(f?.message).toMatch(/C1 is 4\d\.\d mm/);
    expect(runErc(board(far.comps, far.nets), { decouplingMm: 100 }).some((x) => x.rule === 'decoupling')).toBe(false);
  });

  describe('polarity', () => {
    const LED = 'C2290';
    const led = (pins: string[]) => part('D1', LED, pins, { x: 30, y: 30 }, { value: 'white' }, 'LED0603-R-RD_WHITE');

    it('an LED with its anode on ground never lights (the KinAura bug)', () => {
      // design.py assumed pad 1 = cathode; the C2290 symbol has pad 1 = A.
      const f = runErc(
        board([led(['A', 'K']), res('R1', '1k')], { GND: ['D1.1'], LED_A: ['D1.2', 'R1.1'], '3V3': ['R1.2'] }),
      ).filter((x) => x.rule === 'polarity');
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ level: 'error', items: ['D1', 'D1.1', 'D1.2'] });
      expect(f[0]!.message).toMatch(/never light/);
    });

    it('the same LED the right way round is quiet', () => {
      const f = runErc(board([led(['A', 'K']), res('R1', '1k')], { GND: ['D1.2'], LED_A: ['D1.1', 'R1.1'], '3V3': ['R1.2'] }));
      expect(rules(f)).not.toContain('polarity');
    });

    it('an LED driven from a GPIO (unknown potential) is not guessed at', () => {
      const f = runErc(board([led(['A', 'K']), res('R1', '1k')], { GND: ['D1.2'], LED_A: ['D1.1', 'R1.1'], GPIO5: ['R1.2'] }));
      expect(rules(f)).not.toContain('polarity');
    });

    it('a diode forward across a rail is a short; a clamp across it is fine', () => {
      const diode = (pins: string[]) => part('D2', 'C8678', pins, { x: 40, y: 40 });
      expect(
        runErc(board([diode(['K', 'A'])], { GND: ['D2.1'], '12V': ['D2.2'] })).find((f) => f.rule === 'polarity')?.level,
      ).toBe('error');
      expect(rules(runErc(board([diode(['K', 'A'])], { '12V': ['D2.1'], GND: ['D2.2'] })))).not.toContain('polarity');
      // Schottky ORing two 5 V inputs onto the rail: quiet.
      expect(rules(runErc(board([diode(['K', 'A'])], { '5V': ['D2.1'], VBUS: ['D2.2'] })))).not.toContain('polarity');
    });

    it('warns when a part note claims a pad 1 polarity the symbol contradicts', () => {
      const p = part('D1', LED, ['A', 'K'], { x: 30, y: 30 }, { value: 'white', role: 'Power LED, pad 1 = cathode' }, 'LED0603');
      const f = runErc(board([p, res('R1', '1k')], { GND: ['D1.2'], LED_A: ['D1.1', 'R1.1'], '3V3': ['R1.2'] }));
      expect(f.find((x) => x.rule === 'polarity')).toMatchObject({ level: 'warn' });
    });
  });

  describe('esp32', () => {
    const ESP = 'C2913199';
    const esp = () => part('U1', ESP, ['GND', '3V3', 'EN', 'IO0', 'IO45', 'IO46', 'IO3'], { x: 10, y: 10 });

    it('IO0 pulled low, IO45 pulled high, EN without pull-up are errors', () => {
      const f = runErc(
        board([esp(), cap('C1', '100nF'), res('R1', '10k'), res('R2', '10k')], {
          GND: ['U1.1', 'C1.2', 'R1.2'],
          '3V3': ['U1.2', 'C1.1', 'R2.2'],
          BOOT: ['U1.4', 'R1.1'],
          VSPI: ['U1.5', 'R2.1'],
        }),
      ).filter((x) => x.rule === 'esp32' && x.level === 'error');
      expect(f.map((x) => x.message).join('\n')).toMatch(/IO0 .* download mode[\s\S]*IO45 .* pulled high[\s\S]*EN .*no pull-up/);
    });

    it('EN with 10k and 1uF is a 10 ms delay', () => {
      const f = runErc(
        board([esp(), cap('C1', '100nF'), res('R1', '10k'), cap('C2', '1uF', { x: 12, y: 10 })], {
          GND: ['U1.1', 'C1.2', 'C2.2'],
          '3V3': ['U1.2', 'C1.1', 'R1.2'],
          CHIP_EN: ['U1.3', 'R1.1', 'C2.1'],
        }),
      );
      expect(f.find((x) => x.rule === 'esp32' && /reset delay/.test(x.message))?.message).toMatch(/= 10ms/);
    });
  });

  it('usb-cc: CC pins need 5.1k pull-downs', () => {
    const usb = part('J1', 'CUSB', ['CC1', 'CC2', 'GND'], { x: 10, y: 10 });
    const f = runErc(board([usb, res('R1', '5.1k'), res('R2', '10k')], { GND: ['J1.3', 'R1.2', 'R2.2'], CC1: ['J1.1', 'R1.1'], CC2: ['J1.2', 'R2.1'] }));
    expect(f.filter((x) => x.rule === 'usb-cc').map((x) => x.level)).toEqual(['warn']);
    const none = runErc(board([usb], { GND: ['J1.3'], CC1: ['J1.1'], CC2: ['J1.2'] }));
    expect(none.filter((x) => x.rule === 'usb-cc' && x.level === 'error')).toHaveLength(2);
  });

  it('waivers silence a finding and record their reason', () => {
    const { comps, nets } = cleanXor();
    comps.push(part('U2', 'CUNKNOWN', ['FOO'], { x: 50, y: 50 }));
    const b = board(comps, nets);
    expect(runErc(b).some((f) => f.items.includes('U2.1'))).toBe(true);
    b.checkWaivers = [{ rule: 'unconnected-ic-pin', items: ['U2.1'], reason: 'test pad' }];
    expect(runErc(b).some((f) => f.items.includes('U2.1'))).toBe(false);
    const all = runErc(b, { includeWaived: true }).find((f) => f.items.includes('U2.1'));
    expect(all).toMatchObject({ level: 'info' });
    expect(all!.message).toMatch(/\[waived: test pad\]/);
  });

  it('parts without pin names are reported once and not checked by role', () => {
    const c = part('U1', XOR, 5);
    c.footprint.pins = undefined;
    const f = runErc(board([c], {}));
    expect(f.filter((x) => x.level === 'error')).toEqual([]);
    expect(f.find((x) => x.rule === 'symbols')?.message).toMatch(/no symbol pin names for C52350/);
    // A lookup fills them in.
    const looked = runErc(board([c], {}), { pins: () => xor().footprint.pins });
    expect(rules(looked, 'error')).toContain('power-pins');
  });
});
