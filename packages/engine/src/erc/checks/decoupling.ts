/**
 * ERC rule decoupling: every IC supply pin has a capacitor to ground on its
 * net, and the nearest one is within `maxMm` of the pin.
 */

import type { CheckFinding } from '../../checks/types.js';
import type { Netlist } from '../netlist.js';
import { ercFinding } from '../finding.js';

export const DEFAULT_DECOUPLING_MM = 10;

export function check(nl: Netlist, maxMm = DEFAULT_DECOUPLING_MM): CheckFinding[] {
  const out: CheckFinding[] = [];
  for (const c of nl.ics()) {
    const ref = c.refdes;
    for (const pad of nl.padNumbers(ref)) {
      if (nl.role(ref, pad) !== 'supply') continue;
      const net = nl.net(ref, pad);
      if (net === undefined || nl.isGroundNet(net)) continue; // power-pins reports it
      const at = nl.padAt(ref, pad);
      const items = [`${ref}.${pad}`, ref, `net:${net}`];
      const caps = nl.capsToGround(net);
      if (caps.length === 0) {
        out.push(ercFinding('decoupling', 'warn', `${nl.label(ref, pad)} on ${net}: no capacitor to ground on that net`, items, at));
        continue;
      }
      if (!at) continue;
      let best = Infinity;
      let bestRef = '';
      for (const [cref] of caps) {
        const cap = nl.component(cref);
        for (const p of cap?.footprint.pads ?? []) {
          const q = nl.padAt(cref, p.number);
          if (!q) continue;
          const d = Math.hypot(q.x - at.x, q.y - at.y);
          if (d < best) {
            best = d;
            bestRef = cref;
          }
        }
      }
      if (best > maxMm) {
        out.push(
          ercFinding(
            'decoupling',
            'warn',
            `${nl.label(ref, pad)} on ${net}: nearest capacitor ${bestRef} is ${best.toFixed(1)} mm from the pin (more than ${maxMm} mm)`,
            [...items, bestRef],
            at,
          ),
        );
      }
    }
  }
  return out;
}
