/**
 * ERC rule usb-cc: a USB-C sink needs 5.1k pull-downs on CC1 and CC2, or a
 * USB-C source will never turn VBUS on (USB Type-C spec, Rd = 5.1k).
 * Applies to connectors whose symbol names pins CC1/CC2.
 */

import type { CheckFinding } from '../../checks/types.js';
import { isConnector, type Netlist } from '../netlist.js';
import { ercFinding } from '../finding.js';
import { formatSi } from '../../values.js';

export function check(nl: Netlist): CheckFinding[] {
  const out: CheckFinding[] = [];
  for (const c of nl.components) {
    if (!isConnector(c.refdes)) continue;
    const ref = c.refdes;
    for (const [pad, pin] of Object.entries(nl.pins(ref))) {
      if (!/^CC\d$/.test(pin.name)) continue;
      const net = nl.net(ref, pad);
      const items = [`${ref}.${pad}`, ref];
      const at = nl.padAt(ref, pad);
      const downs = nl.pulls(net).filter((p) => p.direction === 'down');
      if (downs.length === 0) {
        out.push(ercFinding('usb-cc', 'error', `${ref} ${pin.name} has no pull-down: a USB-C source will not turn on VBUS`, items, at));
      } else if (!downs.some((p) => Math.abs(p.ohms - 5100) <= 510)) {
        out.push(ercFinding('usb-cc', 'warn', `${ref} ${pin.name} is pulled down by ${formatSi(downs[0]!.ohms, 'ohm')}, not 5.1k`, items, at));
      }
    }
  }
  return out;
}
