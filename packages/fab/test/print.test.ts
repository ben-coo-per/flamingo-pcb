import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import type { Board } from '@flamingo/engine';
import { newBoard, padWorld, parseBoard } from '@flamingo/engine';
import { PT_PER_MM, PrintPage, pageSvg, writePdf } from '../src/print/pdf.js';
import { boardView, compressRefs, drawBoardSide, exportPrint, printPages } from '../src/print/layout.js';

const here = dirname(fileURLToPath(import.meta.url));
const blinker = (): Board =>
  parseBoard(readFileSync(join(here, '..', '..', 'engine', 'test', 'fixtures', 'blinker-routed.flamingo'), 'utf8'));

function streams(pdf: Buffer): string[] {
  const out: string[] = [];
  const s = pdf.toString('latin1');
  const re = /<< \/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    out.push(inflateSync(pdf.subarray(start, start + Number(m[1]))).toString('latin1'));
  }
  return out;
}

/** A 10 x 10 board with one through-hole part at the left edge and one SMD part. */
function smallBoard(): Board {
  const b = newBoard('small', 2);
  b.outline = [
    { type: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
    { type: 'line', start: { x: 10, y: 0 }, end: { x: 10, y: 10 } },
    { type: 'line', start: { x: 10, y: 10 }, end: { x: 0, y: 10 } },
    { type: 'line', start: { x: 0, y: 10 }, end: { x: 0, y: 0 } },
  ];
  b.components.push({
    refdes: 'J1',
    lcsc: 'C1',
    at: { x: 2, y: 5 },
    rotation: 0,
    side: 'top',
    fields: { value: 'hdr' },
    footprint: {
      name: 'HDR',
      lcsc: 'C1',
      courtyard: [],
      silk: [],
      pads: [1, 2, 3].map((n) => ({
        number: String(n),
        shape: 'circle' as const,
        at: { x: 0, y: (n - 2) * 2.54 },
        rotation: 0,
        size: { w: 1.7, h: 1.7 },
        layer: 'through' as const,
        drill: { diameter: 1, plated: true },
      })),
    },
  });
  b.components.push({
    refdes: 'R1',
    lcsc: 'C25804',
    at: { x: 7, y: 5 },
    rotation: 90,
    side: 'top',
    fields: { value: '10k' },
    footprint: {
      name: 'R0603',
      lcsc: 'C25804',
      courtyard: [],
      silk: [],
      pads: [
        { number: '1', shape: 'rect', at: { x: -0.75, y: 0 }, rotation: 0, size: { w: 0.8, h: 0.9 }, layer: 'top' },
        { number: '2', shape: 'rect', at: { x: 0.75, y: 0 }, rotation: 0, size: { w: 0.8, h: 0.9 }, layer: 'top' },
      ],
    },
  });
  return b;
}

describe('writePdf', () => {
  it('writes a valid xref and a 1:1 A4 page', () => {
    const pg = new PrintPage(210, 297);
    pg.line({ x: 10, y: 10 }, { x: 110, y: 10 }, { width: 0.3 });
    pg.text({ x: 10, y: 20 }, 'Hello (world) \\', 3);
    const pdf = writePdf([pg], 't');
    const s = pdf.toString('latin1');
    expect(s.startsWith('%PDF-1.4')).toBe(true);
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
    // Every xref row points at the start of its object.
    const xrefAt = Number(/startxref\n(\d+)/.exec(s)![1]);
    const rows = s.slice(xrefAt).split('\n').slice(3);
    let n = 0;
    for (const row of rows) {
      if (!row.endsWith(' n ')) break;
      n++;
      expect(s.slice(Number(row.slice(0, 10))).startsWith(`${n} 0 obj`)).toBe(true);
    }
    expect(n).toBeGreaterThan(4);
    expect(s).toContain('/MediaBox [0 0 595.276 841.89]');
    expect(s).toContain('/PrintScaling /None');
    const ops = streams(pdf)[0]!;
    const [x0] = /([\d.]+) [\d.]+ m/.exec(ops)!.slice(1).map(Number);
    const [x1] = /([\d.]+) [\d.]+ l/.exec(ops)!.slice(1).map(Number);
    expect((x1! - x0!) / PT_PER_MM).toBeCloseTo(100, 3);
    expect(ops).toContain('(Hello \\(world\\) \\\\) Tj');
  });

  it('svg escapes text', () => {
    const pg = new PrintPage(50, 50);
    pg.text({ x: 1, y: 1 }, 'a<b & c', 2);
    expect(pageSvg(pg)).toContain('a&lt;b &amp; c');
  });
});

describe('printPages', () => {
  it('top, bottom and a catalogue page, each with a 100 mm bar', () => {
    const pages = printPages(smallBoard(), { date: '2026-10-01' });
    expect(pages.length).toBe(3);
    for (const pg of pages) {
      const bars = pg.ops.filter(
        (o) => o.kind === 'poly' && o.pts.length === 2 && o.pts[0]!.y === o.pts[1]!.y && o.width === 0.3,
      );
      const lengths = bars.map((o) => (o.kind === 'poly' ? +(o.pts[1]!.x - o.pts[0]!.x).toFixed(3) : 0));
      expect(lengths).toEqual([100, 101.6]);
    }
  });

  it('letter paper is letter sized', () => {
    const pages = printPages(smallBoard(), { paper: 'letter' });
    expect(pages[0]!.w).toBe(215.9);
    expect(pages[0]!.h).toBe(279.4);
  });

  it('the bottom page mirrors left and right', () => {
    const b = smallBoard();
    const top = boardView(b, new PrintPage(210, 297), false);
    const bot = boardView(b, new PrintPage(210, 297), true);
    expect(top({ x: 1, y: 5 }).x - top.ox).toBeCloseTo(1);
    expect(bot({ x: 1, y: 5 }).x - bot.ox).toBeCloseTo(9);
    expect(bot({ x: 1, y: 5 }).y).toBeCloseTo(top({ x: 1, y: 5 }).y);
  });

  it('draws every pad: SMD pads on their side only, through-hole pads on both', () => {
    const b = smallBoard();
    const filled = (pg: PrintPage) => pg.ops.filter((o) => o.kind === 'poly' && o.fill && !o.stroke).length;
    const top = new PrintPage(210, 297);
    drawBoardSide(b, top, 'top');
    const bottom = new PrintPage(210, 297);
    drawBoardSide(b, bottom, 'bottom');
    expect(filled(top)).toBe(5); // 3 through + 2 SMD
    expect(filled(bottom)).toBe(3); // through-hole only
    // A drill (white circle) sits on each through-hole pad centre, in page space.
    const v = boardView(b, top, false);
    const drills = top.ops.filter((o) => o.kind === 'circle' && o.fill?.[0] === 1);
    for (const pad of b.components[0]!.footprint.pads) {
      const at = v(padWorld(b.components[0]!, pad).at);
      expect(drills.some((d) => d.kind === 'circle' && Math.hypot(d.center.x - at.x, d.center.y - at.y) < 1e-9)).toBe(
        true,
      );
    }
  });

  it('renders the blinker fixture: one cell per distinct footprint', () => {
    const b = blinker();
    const pages = printPages(b);
    const labels = pages.slice(2).flatMap((pg) => pg.ops.flatMap((o) => (o.kind === 'text' ? [o.text] : [])));
    const groups = new Set(b.components.map((c) => `${c.lcsc}  ${c.footprint.name}`));
    for (const g of groups) expect(labels.some((l) => l === g || l.startsWith(g.slice(0, 20)))).toBe(true);
  });

  it('refuses a board that does not fit at 1:1', () => {
    const b = smallBoard();
    b.outline = [
      { type: 'line', start: { x: 0, y: 0 }, end: { x: 300, y: 0 } },
      { type: 'line', start: { x: 300, y: 0 }, end: { x: 300, y: 10 } },
      { type: 'line', start: { x: 300, y: 10 }, end: { x: 0, y: 10 } },
      { type: 'line', start: { x: 0, y: 10 }, end: { x: 0, y: 0 } },
    ];
    expect(() => printPages(b)).toThrow(/does not fit/);
  });
});

describe('compressRefs', () => {
  it('collapses runs of three or more', () => {
    expect(compressRefs(['XP2', 'XP0', 'XP1', 'R5', 'J1', 'J2'])).toBe('J1, J2, R5, XP0-XP2');
    expect(compressRefs(['R1', 'R3', 'R4', 'R5', 'R30'])).toBe('R1, R3-R5, R30');
  });
});

describe('exportPrint', () => {
  it('writes the PDF and optional SVGs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flamingo-print-'));
    try {
      const r = await exportPrint(blinker(), dir, { svg: true });
      expect(r.pages).toBeGreaterThanOrEqual(3);
      expect(r.svgs).toHaveLength(r.pages);
      const pdf = await readFile(r.pdf);
      expect(pdf.toString('latin1').match(/\/Type \/Page /g)?.length).toBe(r.pages);
      expect((await readFile(r.svgs[0]!, 'utf8')).startsWith('<svg')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
