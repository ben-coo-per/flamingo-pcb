/**
 * Flamingo Fab - the legend (silkscreen) of one board side, as strokes.
 *
 * Single source of truth for what the fab prints on the silk layers: the
 * Gerber legend (gerber.ts) emits these strokes as-is, and the 1:1 printout
 * (print/) tessellates and draws them. Keeping both on one function means the
 * paper test-fit shows exactly the legend the boards will come back with.
 *
 * Strokes come in board order: per component on this side its footprint silk
 * then its refdes label, then board-level silk text, then board silk lines.
 * Every width is already floored at the ruleset's minimum legend width.
 */

import type { Board, LayerId, PathSeg, Point } from '@flamingo/engine';
import {
  componentTransformPoints,
  componentTransformRotation,
  componentLabelPlacement,
  RULESETS,
} from '@flamingo/engine';
import { strokeText } from './strokefont.js';
import type { RefdesLabel } from './gerber.js';

export type LegendStroke =
  | { kind: 'seg'; seg: PathSeg; width: number }
  | { kind: 'circle'; center: Point; r: number; width: number }
  | { kind: 'poly'; pts: Point[]; width: number };

export function legendStrokes(
  b: Board,
  side: 'F' | 'B',
  labels?: Map<string, RefdesLabel>,
): LegendStroke[] {
  const silkLayer: LayerId = side === 'F' ? 'F.Silk' : 'B.Silk';
  const compSide: 'top' | 'bottom' = side === 'F' ? 'top' : 'bottom';
  // Every silk stroke is floored at the fab tier's minimum legend line width
  // (RuleSet.minSilkWidth -- 0.15mm on all JLCPCB tiers). Below it the fab
  // thins or drops the legend outright, which costs exactly the labels needed
  // for bring-up. It covers footprint lines/arcs/circles and board-level silk
  // lines as well as stroked text.
  const minSilk = RULESETS[b.rules].minSilkWidth;
  const w = (width: number): number => Math.max(minSilk, width);
  const out: LegendStroke[] = [];
  const text = (polys: Point[][], width: number): void => {
    for (const pts of polys) out.push({ kind: 'poly', pts, width: w(width) });
  };

  for (const comp of b.components) {
    if (comp.side !== compSide) continue;
    const mirror = comp.side === 'bottom';
    for (const item of comp.footprint.silk) {
      switch (item.kind) {
        case 'line': {
          const [s, e] = componentTransformPoints(comp, [item.start, item.end]);
          out.push({ kind: 'seg', seg: { type: 'line', start: s, end: e }, width: w(item.width) });
          break;
        }
        case 'arc': {
          const [s, e, ctr] = componentTransformPoints(comp, [item.start, item.end, item.center]);
          const seg: PathSeg = { type: 'arc', start: s, end: e, center: ctr, cw: mirror ? !item.cw : item.cw };
          out.push({ kind: 'seg', seg, width: w(item.width) });
          break;
        }
        case 'circle': {
          const [ctr] = componentTransformPoints(comp, [item.center]);
          out.push({ kind: 'circle', center: ctr, r: item.radius, width: w(item.width) });
          break;
        }
        case 'text': {
          const [at] = componentTransformPoints(comp, [item.at]);
          const rot = componentTransformRotation(comp, item.rotation);
          text(strokeText(item.text, at, item.height, rot, mirror), item.height * 0.12);
          break;
        }
      }
    }
    // refdes label (upright, adjacent to the component body, pad-avoiding —
    // anchor shared with the SVG/canvas renderers and DRC)
    const given = labels?.get(comp.refdes);
    const lp = given ?? { ...componentLabelPlacement(b, comp), text: comp.refdes };
    text(strokeText(lp.text, lp.at, lp.height, lp.rotation, mirror), 0.15);
  }

  // Board-level silk text. B.Silk text is mirrored (x -> -x about its anchor,
  // before rotation) like bottom-component text, so it reads correctly on the
  // fabbed board's underside — matching the 3D viewer's B.Silk convention.
  for (const s of b.silk) {
    if (s.layer !== silkLayer) continue;
    text(strokeText(s.text, s.at, s.height, s.rotation, side === 'B'), s.height * 0.12);
  }

  // Board-level silk lines (mechanical reference outlines) stroked at their width.
  for (const line of b.silkLines) {
    if (line.layer !== silkLayer) continue;
    out.push({ kind: 'seg', seg: { type: 'line', start: line.start, end: line.end }, width: w(line.width) });
  }
  return out;
}
