/** ERC rule single-pin-net: a net with one pin connects nothing. */

import type { CheckFinding } from '../../checks/types.js';
import type { Netlist } from '../netlist.js';
import { ercFinding } from '../finding.js';

export function check(nl: Netlist): CheckFinding[] {
  const out: CheckFinding[] = [];
  for (const n of nl.board.nets) {
    const pins = [...new Set(n.pins)];
    if (pins.length >= 2) continue;
    const [ref, pad] = pins[0]?.split('.') ?? [];
    out.push(
      ercFinding(
        'single-pin-net',
        'warn',
        pins.length === 0 ? `net ${n.name} has no pins` : `net ${n.name} has only ${pins[0]}`,
        [`net:${n.name}`, ...pins],
        ref && pad ? nl.padAt(ref, pad) : undefined,
      ),
    );
  }
  return out;
}
