import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseEasyedaFootprint, parseEasyedaSymbolPins } from '../src/easyeda-parse.js';

const here = dirname(fileURLToPath(import.meta.url));
function fixture(lcsc: string): unknown {
  return JSON.parse(readFileSync(join(here, 'fixtures', `${lcsc}.json`), 'utf8'));
}

describe('parseEasyedaSymbolPins', () => {
  it('C506653 (MCP23017, SSOP-28): all 28 pins named, keyed by pad number', () => {
    const pins = parseEasyedaSymbolPins(fixture('C506653'));
    expect(Object.keys(pins)).toHaveLength(28);
    expect(pins['1']!.name).toBe('GPB0');
    // Every symbol pin number is a footprint pad number.
    const { footprint } = parseEasyedaFootprint(fixture('C506653'));
    const pads = new Set(footprint.pads.map((p) => p.number));
    for (const n of Object.keys(pins)) expect(pads.has(n)).toBe(true);
  });

  it('C2290 (KT-0603W LED): pin 1 is the anode, pin 2 the cathode', () => {
    // The KinAura boards assumed the opposite and shipped three reversed LEDs to review.
    const pins = parseEasyedaSymbolPins(fixture('C2290'));
    expect(pins['1']!.name).toBe('A');
    expect(pins['2']!.name).toBe('K');
  });

  it('C165948 (USB-C): merged pads keep their combined symbol number', () => {
    const pins = parseEasyedaSymbolPins(fixture('C165948'));
    expect(pins['A1B12']?.name).toBe('GND');
    expect(pins['A4B9']?.name).toBe('VBUS');
  });

  it('C25804 (resistor): plain numbered pins', () => {
    const pins = parseEasyedaSymbolPins(fixture('C25804'));
    expect(Object.keys(pins).sort()).toEqual(['1', '2']);
  });

  it('reads units of multi-part symbols under subparts', () => {
    const pin = (n: string, name: string) =>
      `P~show~1~${n}~0~0~0~id${n}~0^^0~0^^M 0 0 h 10~#880000^^1~0~0~0~${name}~start~~~#0000FF^^x`;
    const raw = {
      result: {
        dataStr: {
          shape: [],
          subparts: [{ dataStr: { shape: [pin('1', '1A')] } }, { dataStr: { shape: [pin('2', '1B')] } }],
        },
      },
    };
    expect(parseEasyedaSymbolPins(raw)).toEqual({
      '1': { name: '1A', type: 'input' },
      '2': { name: '1B', type: 'input' },
    });
  });

  it('never throws on junk', () => {
    expect(parseEasyedaSymbolPins(null)).toEqual({});
    expect(parseEasyedaSymbolPins({ result: { dataStr: { shape: ['P~'] } } })).toEqual({});
  });

  it('parseEasyedaFootprint carries the pins on the footprint', () => {
    const { footprint } = parseEasyedaFootprint(fixture('C506653'));
    expect(footprint.pins?.['9']).toBeDefined();
  });
});
