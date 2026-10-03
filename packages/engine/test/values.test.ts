import { describe, it, expect } from 'vitest';
import { formatSi, kindFromRefdes, parseValue } from '../src/values.js';

describe('parseValue', () => {
  // Every value on the two KinAura boards, 30 Sep 2026.
  const cases: [string, string, number, Record<string, number>?][] = [
    ['R1', '10k', 10e3],
    ['R3', '4.7k', 4.7e3],
    ['R13', '5.1k', 5.1e3],
    ['R20', '33R', 33],
    ['R19', '10R', 10],
    ['R5', '1k', 1e3],
    ['R10', '100k', 100e3],
    ['R9', '4k7', 4.7e3],
    ['R9', '2R2', 2.2],
    ['R9', '0R', 0],
    ['R9', '1M', 1e6],
    ['R9', '470 ohm', 470],
    ['C5', '100nF', 100e-9],
    ['C14', '10nF', 10e-9],
    ['C8', '1uF', 1e-6],
    ['C2', '10uF', 10e-6],
    ['C1', '22uF', 22e-6],
    ['C3', '4n7', 4.7e-9],
    ['C3', '100 nF', 100e-9],
    ['C3', '100µF', 100e-6],
    ['C1', '100uF 35V', 100e-6, { V: 35 }],
    ['F1', '2A 30V', 2, { V: 30 }],
    ['F1', '1.1A', 1.1],
    ['L1', '10uH', 10e-6],
  ];
  for (const [ref, text, n, ratings] of cases) {
    it(`${ref} ${text}`, () => {
      const v = parseValue(text, kindFromRefdes(ref));
      expect(v).not.toBeNull();
      expect(v!.value).toBeCloseTo(n, 15);
      expect(v!.ratings).toEqual(ratings ?? {});
    });
  }

  it('returns null rather than guessing', () => {
    expect(parseValue('', 'resistor')).toBeNull();
    expect(parseValue(undefined, 'resistor')).toBeNull();
    expect(parseValue('white', 'other')).toBeNull();
    expect(parseValue('Mini-Fit 2x6', 'other')).toBeNull();
    expect(parseValue('100nF', 'resistor')).toBeNull(); // unit contradicts the kind
    expect(parseValue('10k', 'other')).toBeNull(); // no unit and no kind to lend one
    expect(parseValue('DNP', 'resistor')).toBeNull();
  });

  it('kindFromRefdes', () => {
    expect(kindFromRefdes('R12')).toBe('resistor');
    expect(kindFromRefdes('C3')).toBe('capacitor');
    expect(kindFromRefdes('F1')).toBe('fuse');
    expect(kindFromRefdes('U1')).toBe('other');
  });

  it('formatSi', () => {
    expect(formatSi(4700, 'ohm')).toBe('4.7kohm');
    expect(formatSi(100e-9, 'F')).toBe('100nF');
    expect(formatSi(0.0005, 'A')).toBe('500uA');
    expect(formatSi(0)).toBe('0');
  });
});
