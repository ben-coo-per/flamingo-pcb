import { describe, it, expect } from 'vitest';
import { builtinFootprint, newBoard } from '@flamingo/engine';
import type { Board, ComponentInst, Footprint } from '@flamingo/engine';
import { generateBOM } from '../src/bom.js';
import { generateCPL } from '../src/cpl.js';
import { exportDSN } from '../src/dsn.js';
import { generateGerbers } from '../src/gerber.js';

const R0603: Footprint = {
  name: 'R0603',
  lcsc: 'C25804',
  pads: [
    { number: '1', shape: 'rect', at: { x: -0.75, y: 0 }, rotation: 0, size: { w: 0.8, h: 0.9 }, layer: 'top' },
    { number: '2', shape: 'rect', at: { x: 0.75, y: 0 }, rotation: 0, size: { w: 0.8, h: 0.9 }, layer: 'top' },
  ],
  silk: [],
  courtyard: [],
};

function comp(refdes: string, lcsc: string, footprint: Footprint, x: number, fields: ComponentInst['fields'] = {}): ComponentInst {
  return { refdes, lcsc, footprint, at: { x, y: 5 }, rotation: 0, side: 'top', fields: { value: '10k', ...fields } };
}

function boardWith(...components: ComponentInst[]): Board {
  const b = newBoard('jp', 2);
  b.outline = [
    { type: 'line', start: { x: 0, y: 0 }, end: { x: 30, y: 0 } },
    { type: 'line', start: { x: 30, y: 0 }, end: { x: 30, y: 10 } },
    { type: 'line', start: { x: 30, y: 10 }, end: { x: 0, y: 10 } },
    { type: 'line', start: { x: 0, y: 10 }, end: { x: 0, y: 0 } },
  ];
  b.components.push(...components);
  return b;
}

const jumper = builtinFootprint({ kind: 'solder-jumper-2', bridged: true }).footprint;
const testPoint = builtinFootprint({ kind: 'test-point' }).footprint;

describe('parts JLCPCB does not assemble', () => {
  const b = boardWith(
    comp('R1', 'C25804', R0603, 5),
    comp('R2', 'C25804', R0603, 10, { dnp: true }),
    comp('JP1', '', jumper, 15, { value: 'SJ closed' }),
    comp('TP1', '', testPoint, 20, { value: 'TP' }),
  );

  it('the BOM lists only the assembled part', () => {
    const rows = generateBOM(b).trim().split('\r\n');
    expect(rows).toEqual(['Comment,Designator,Footprint,LCSC Part #', '10k,R1,R0603,C25804']);
  });

  it('the CPL lists only the assembled part', () => {
    const rows = generateCPL(b).trim().split('\r\n');
    expect(rows.slice(1).map((r) => r.split(',')[0])).toEqual(['R1']);
  });

  it('a do-not-place part keeps its paste; jumpers and test points get none', () => {
    const paste = (board: Board) => generateGerbers(board).files.get('jp.GTP')!;
    const resistors = boardWith(comp('R1', 'C25804', R0603, 5), comp('R2', 'C25804', R0603, 10, { dnp: true }));
    expect(paste(b)).toBe(paste(resistors));
    expect(paste(boardWith(comp('JP1', '', jumper, 15), comp('TP1', '', testPoint, 20)))).toBe(paste(boardWith()));
  });

  it('the mask opens over the jumper link and the copper carries it', () => {
    const files = generateGerbers(boardWith(comp('JP1', '', jumper, 15))).files;
    // Polygon pads are drawn as regions.
    expect(files.get('jp.GTL')).toContain('G36*');
    expect(files.get('jp.GTS')).toContain('G36*');
  });

  it('the router gets a tied pad as its plain rectangle', () => {
    const dsn = exportDSN(boardWith(comp('JP1', '', jumper, 15)));
    expect(dsn).toContain('(rect F.Cu -500 -750 500 750)');
    expect(dsn).not.toContain('(polygon F.Cu');
  });
});
