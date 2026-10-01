/**
 * ERC rule unconnected-ic-pin: IC and connector pads on no net.
 *
 * Inputs on no net are floating-input's business. Everything else is a
 * warning when nothing is known about the pin, and info when its role says
 * leaving it open is harmless (an output, a GPIO, a mux channel, NC) or when
 * the part is a connector. Waive a deliberate one with its reason.
 */

import type { CheckFinding } from '../../checks/types.js';
import { isConnector, type Netlist } from '../netlist.js';
import { ercFinding } from '../finding.js';

export function check(nl: Netlist): CheckFinding[] {
  const out: CheckFinding[] = [];
  for (const c of nl.components) {
    const ref = c.refdes;
    const ic = /^U\d/.test(ref);
    if (!ic && !isConnector(ref)) continue;
    for (const pad of nl.padNumbers(ref)) {
      if (nl.net(ref, pad) !== undefined) continue;
      const role = ic ? nl.role(ref, pad) : undefined;
      if (role === 'in' || role === 'supply' || role === 'ground') continue; // other rules
      const known = !ic || role !== undefined;
      const why =
        role === 'nc' ? ' (no internal connection)' : role ? ` (${role})` : ic ? ' (role unknown)' : '';
      out.push(
        ercFinding(
          'unconnected-ic-pin',
          known ? 'info' : 'warn',
          `${nl.label(ref, pad)} is on no net${why}`,
          [`${ref}.${pad}`, ref],
          nl.padAt(ref, pad),
        ),
      );
    }
  }
  return out;
}
