/**
 * Flamingo Fab - a tiny vector canvas with PDF and SVG writers, for the 1:1
 * printout.
 *
 * Coordinates are page millimetres, y-up, origin at the page's bottom-left,
 * so board coordinates (mm, y-up) only need an offset. The PDF writes 1 mm as
 * 72/25.4 points: printed at 100 % ("Actual size") the page is 1:1. Text uses
 * the PDF base-14 Helvetica, so no font is embedded and there are no
 * dependencies beyond node:zlib.
 */

import { deflateSync } from 'node:zlib';
import type { Point } from '@flamingo/engine';

export const PT_PER_MM = 72 / 25.4;

export const PAPER = {
  a4: { w: 210, h: 297 },
  letter: { w: 215.9, h: 279.4 },
} as const;
export type Paper = keyof typeof PAPER;

export type Rgb = [number, number, number];

export type PrintOp =
  | {
      kind: 'poly';
      pts: Point[];
      stroke: Rgb | null;
      fill: Rgb | null;
      width: number;
      closed: boolean;
      dash?: [number, number];
    }
  | { kind: 'circle'; center: Point; r: number; stroke: Rgb | null; fill: Rgb | null; width: number }
  | {
      kind: 'text';
      at: Point;
      text: string;
      /** Cap height in mm. */
      size: number;
      color: Rgb;
      anchor: 'start' | 'middle' | 'end';
      rotation: number;
      bold: boolean;
    };

export interface PolyStyle {
  stroke?: Rgb | null;
  fill?: Rgb | null;
  width?: number;
  closed?: boolean;
  dash?: [number, number];
}

export interface TextStyle {
  color?: Rgb;
  anchor?: 'start' | 'middle' | 'end';
  rotation?: number;
  bold?: boolean;
}

const BLACK: Rgb = [0, 0, 0];

/** Helvetica's cap height is about 0.72 em. */
const CAP_PER_EM = 0.72;

/** Rough Helvetica advance: about 0.55 em per character. Good enough to anchor labels. */
export function textWidth(text: string, capMm: number): number {
  return text.length * 0.55 * (capMm / CAP_PER_EM);
}

/** Truncate `text` with an ellipsis so it fits `maxMm` at cap height `capMm`. */
export function fitText(text: string, maxMm: number, capMm: number): string {
  if (textWidth(text, capMm) <= maxMm) return text;
  let s = text;
  while (s.length > 0 && textWidth(`${s}...`, capMm) > maxMm) s = s.slice(0, -1);
  return `${s}...`;
}

export class PrintPage {
  readonly ops: PrintOp[] = [];
  constructor(
    readonly w: number,
    readonly h: number,
  ) {}

  poly(pts: Point[], s: PolyStyle = {}): void {
    if (pts.length < 2) return;
    this.ops.push({
      kind: 'poly',
      pts,
      stroke: s.stroke === undefined ? BLACK : s.stroke,
      fill: s.fill ?? null,
      width: s.width ?? 0.15,
      closed: s.closed ?? false,
      ...(s.dash ? { dash: s.dash } : {}),
    });
  }

  line(a: Point, b: Point, s: PolyStyle = {}): void {
    this.poly([a, b], s);
  }

  circle(center: Point, r: number, s: { stroke?: Rgb | null; fill?: Rgb | null; width?: number } = {}): void {
    this.ops.push({
      kind: 'circle',
      center,
      r,
      stroke: s.stroke === undefined ? BLACK : s.stroke,
      fill: s.fill ?? null,
      width: s.width ?? 0.15,
    });
  }

  text(at: Point, text: string, size = 3, s: TextStyle = {}): void {
    this.ops.push({
      kind: 'text',
      at,
      text,
      size,
      color: s.color ?? BLACK,
      anchor: s.anchor ?? 'start',
      rotation: s.rotation ?? 0,
      bold: s.bold ?? false,
    });
  }
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

function num(v: number): string {
  const s = v.toFixed(3).replace(/\.?0+$/, '');
  return s === '' || s === '-0' ? '0' : s;
}

/** A PDF literal string body; non-Latin-1 characters become '?'. */
function pdfString(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    const c = code > 255 ? '?' : ch;
    out += c === '\\' || c === '(' || c === ')' ? `\\${c}` : c;
  }
  return out;
}

function paintOp(stroke: Rgb | null, fill: Rgb | null): string {
  return stroke && fill ? 'B' : stroke ? 'S' : 'f';
}

function contentStream(page: PrintPage): string {
  const k = PT_PER_MM;
  const P = (p: Point): string => `${num(p.x * k)} ${num(p.y * k)}`;
  const out: string[] = ['1 J 1 j']; // round caps and joins, like a circular Gerber aperture
  for (const op of page.ops) {
    if (op.kind === 'poly' || op.kind === 'circle') {
      if (!op.stroke && !op.fill) continue;
      out.push('q');
      if (op.kind === 'poly' && op.dash) out.push(`[${num(op.dash[0] * k)} ${num(op.dash[1] * k)}] 0 d`);
      if (op.stroke) out.push(`${op.stroke.map(num).join(' ')} RG ${num(op.width * k)} w`);
      if (op.fill) out.push(`${op.fill.map(num).join(' ')} rg`);
      if (op.kind === 'poly') {
        out.push(`${P(op.pts[0]!)} m`);
        for (const p of op.pts.slice(1)) out.push(`${P(p)} l`);
        if (op.closed || op.fill) out.push('h');
      } else {
        // Four Bezier quarters.
        const { x, y } = op.center;
        const r = op.r;
        const c = 0.5523 * r;
        out.push(`${P({ x: x + r, y })} m`);
        out.push(`${P({ x: x + r, y: y + c })} ${P({ x: x + c, y: y + r })} ${P({ x, y: y + r })} c`);
        out.push(`${P({ x: x - c, y: y + r })} ${P({ x: x - r, y: y + c })} ${P({ x: x - r, y })} c`);
        out.push(`${P({ x: x - r, y: y - c })} ${P({ x: x - c, y: y - r })} ${P({ x, y: y - r })} c`);
        out.push(`${P({ x: x + c, y: y - r })} ${P({ x: x + r, y: y - c })} ${P({ x: x + r, y })} c h`);
      }
      out.push(paintOp(op.stroke, op.fill), 'Q');
    } else {
      const em = op.size / CAP_PER_EM;
      const w = textWidth(op.text, op.size);
      const dx = op.anchor === 'start' ? 0 : op.anchor === 'middle' ? -w / 2 : -w;
      const a = (op.rotation * Math.PI) / 180;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const tx = op.at.x + dx * ca;
      const ty = op.at.y + dx * sa;
      out.push(
        `BT ${op.color.map(num).join(' ')} rg /${op.bold ? 'F2' : 'F1'} ${num(em * k)} Tf ` +
          `${num(ca)} ${num(sa)} ${num(-sa)} ${num(ca)} ${num(tx * k)} ${num(ty * k)} Tm ` +
          `(${pdfString(op.text)}) Tj ET`,
      );
    }
  }
  return out.join('\n');
}

/** Write `pages` as one PDF. Viewers are asked to print without scaling. */
export function writePdf(pages: PrintPage[], title = ''): Buffer {
  const objs: Buffer[] = [];
  const add = (body: Buffer | string): number => {
    objs.push(typeof body === 'string' ? Buffer.from(body, 'latin1') : body);
    return objs.length;
  };
  const catalog = add('');
  const pagesId = add('');
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  for (const pg of pages) {
    const data = deflateSync(Buffer.from(contentStream(pg), 'latin1'));
    const content = add(
      Buffer.concat([
        Buffer.from(`<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
        data,
        Buffer.from('\nendstream', 'latin1'),
      ]),
    );
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(pg.w * PT_PER_MM)} ${num(pg.h * PT_PER_MM)}] ` +
          `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  objs[catalog - 1] = Buffer.from(
    `<< /Type /Catalog /Pages ${pagesId} 0 R /ViewerPreferences << /PrintScaling /None >> >>`,
    'latin1',
  );
  objs[pagesId - 1] = Buffer.from(
    `<< /Type /Pages /Count ${kids.length} /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] >>`,
    'latin1',
  );
  const info = add(`<< /Title (${pdfString(title)}) /Producer (Flamingo export_print) >>`);

  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let len = parts[0]!.length;
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(len);
    const chunk = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
      body,
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    parts.push(chunk);
    len += chunk.length;
  });
  const xref = len;
  let tail = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) tail += `${String(off).padStart(10, '0')} 00000 n \n`;
  tail += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  parts.push(Buffer.from(tail, 'latin1'));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// SVG (one document per page)
// ---------------------------------------------------------------------------

function hex(c: Rgb | null): string {
  if (!c) return 'none';
  return `#${c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function pageSvg(page: PrintPage): string {
  const H = page.h;
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(page.w)}mm" height="${num(H)}mm" viewBox="0 0 ${num(page.w)} ${num(H)}">`,
    `<rect width="${num(page.w)}" height="${num(H)}" fill="#ffffff"/>`,
  ];
  for (const op of page.ops) {
    if (op.kind === 'poly') {
      const d = op.pts.map((p) => `${num(p.x)},${num(H - p.y)}`).join(' ');
      const tag = op.closed || op.fill ? 'polygon' : 'polyline';
      const dash = op.dash ? ` stroke-dasharray="${num(op.dash[0])} ${num(op.dash[1])}"` : '';
      out.push(
        `<${tag} points="${d}" fill="${hex(op.fill)}" stroke="${hex(op.stroke)}" stroke-width="${num(op.width)}" ` +
          `stroke-linecap="round" stroke-linejoin="round"${dash}/>`,
      );
    } else if (op.kind === 'circle') {
      out.push(
        `<circle cx="${num(op.center.x)}" cy="${num(H - op.center.y)}" r="${num(op.r)}" fill="${hex(op.fill)}" ` +
          `stroke="${hex(op.stroke)}" stroke-width="${num(op.width)}"/>`,
      );
    } else {
      const x = num(op.at.x);
      const y = num(H - op.at.y);
      out.push(
        `<text x="${x}" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="${num(op.size / CAP_PER_EM)}" ` +
          `fill="${hex(op.color)}" text-anchor="${op.anchor}"${op.bold ? ' font-weight="bold"' : ''} ` +
          `transform="rotate(${num(-op.rotation)} ${x} ${y})">${esc(op.text)}</text>`,
      );
    }
  }
  out.push('</svg>');
  return out.join('\n');
}
