/**
 * Tiny netlist-only boards for electrical-check tests: parts with symbol pin
 * names and pads, nets by "REF.PAD". No geometry beyond what the types need.
 */
import { newBoard } from '../../src/index.js';
import type { Board, ComponentInst, SymbolPin } from '../../src/index.js';

/** A part whose pad n (1-based) has symbol pin name names[n-1]. */
export function part(refdes: string, value: string, names: string[], lcsc = 'C0'): ComponentInst {
  const pins: Record<string, SymbolPin> = {};
  names.forEach((n, i) => (pins[String(i + 1)] = { name: n, type: 'undefined' }));
  return {
    refdes,
    lcsc,
    at: { x: 0, y: 0 },
    rotation: 0,
    side: 'top',
    fields: { value },
    footprint: {
      name: 'test',
      lcsc,
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
      pins,
    },
  };
}

export const resistor = (refdes: string, value: string): ComponentInst => part(refdes, value, ['1', '2']);
export const capacitor = (refdes: string, value: string): ComponentInst => part(refdes, value, ['1', '2']);

export function board(name: string, parts: ComponentInst[], nets: Record<string, string[]>): Board {
  const b = newBoard(name, 2);
  b.components = parts;
  b.nets = Object.entries(nets).map(([n, pins]) => ({ name: n, class: 'default', pins }));
  return b;
}

/** 74HC154 pin names in pad order for tests (pad numbers are arbitrary but fixed). */
export const HC154 = [
  ...Array.from({ length: 16 }, (_, k) => `Y${k}#`),
  'E1#', 'E2#', 'A0', 'A1', 'A2', 'A3', 'VCC', 'GND',
];
export const HC4067 = [
  'COMMON INOUT/OUTPUT', ...Array.from({ length: 16 }, (_, k) => `I${k}`), 'S0', 'S1', 'S2', 'S3', 'E#', 'VCC', 'GND',
];
export const MCP23017 = [
  ...Array.from({ length: 8 }, (_, k) => `GPB${k}`), 'VDD', 'VSS', 'NC', 'SCK', 'SDA', 'NC',
  'A0', 'A1', 'A2', 'RESET#', 'INTB', 'INTA', ...Array.from({ length: 8 }, (_, k) => `GPA${k}`),
];
/** Pad number of a pin name in one of the tables above. */
export const pad = (table: string[], name: string): string => String(table.indexOf(name) + 1);
