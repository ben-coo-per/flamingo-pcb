/**
 * DRC check: annular ring against the ruleset minimum -- vias ((diameter -
 * drill) / 2) and plated through pads (narrowest copper around the drill,
 * across both the short axis and, for slots, the slot ends).
 */
import type { Board } from '../../types.js';
import { padWorld } from '../../geometry.js';
import { DRC_EPSILON } from '../rules.js';
import type { RuleSet } from '../rules.js';
import type { DrcViolation } from '../types.js';

export function check(b: Board, rules: RuleSet): DrcViolation[] {
  const violations: DrcViolation[] = [];
  for (const v of b.vias) {
    const annular = (v.diameter - v.drill) / 2;
    if (annular < rules.minAnnular - DRC_EPSILON) {
      violations.push({
        rule: 'via-annular',
        message: `Via ${v.id} (net "${v.net}") annular ring ${annular.toFixed(2)}mm is below minimum ${rules.minAnnular.toFixed(2)}mm`,
        at: v.at,
        items: [v.id],
      });
    }
  }
  for (const c of b.components) {
    for (const pad of c.footprint.pads) {
      if (!pad.drill?.plated) continue;
      const { diameter, slotLength } = pad.drill;
      const short = Math.min(pad.size.w, pad.size.h);
      const long = Math.max(pad.size.w, pad.size.h);
      const annular = Math.min((short - diameter) / 2, (long - Math.max(diameter, slotLength ?? 0)) / 2);
      if (annular < rules.minAnnular - DRC_EPSILON) {
        const ref = `${c.refdes}.${pad.number}`;
        violations.push({
          rule: 'pad-annular',
          message: `Pad ${ref} annular ring ${annular.toFixed(2)}mm is below minimum ${rules.minAnnular.toFixed(2)}mm`,
          at: padWorld(c, pad).at,
          items: [ref],
        });
      }
    }
  }
  return violations;
}
