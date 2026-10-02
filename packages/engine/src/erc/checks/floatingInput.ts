/**
 * ERC rule floating-input: a logic input needs something to set its level.
 *
 * - An input on no net floats: error.
 * - An input whose net holds nothing that drives it (no IC output, no
 *   resistor, no supply) floats: error.
 * - An input driven only through a connector, with no pull resistor on this
 *   board, floats while the cable is out: warning (info for I2C lines, whose
 *   pull-ups usually sit on the other board).
 */

import type { CheckFinding } from '../../checks/types.js';
import { isConnector, type Netlist } from '../netlist.js';
import { ercFinding } from '../finding.js';

const DRIVING_ROLES = new Set(['out', 'bidir', 'passive', 'out_supply']);

export function check(nl: Netlist): CheckFinding[] {
  const out: CheckFinding[] = [];
  for (const c of nl.ics()) {
    const ref = c.refdes;
    for (const pad of nl.padNumbers(ref)) {
      if (nl.role(ref, pad) !== 'in') continue;
      const net = nl.net(ref, pad);
      const items = [`${ref}.${pad}`, ref];
      const at = nl.padAt(ref, pad);
      if (net === undefined) {
        out.push(ercFinding('floating-input', 'error', `${nl.label(ref, pad)} is an input on no net: it floats`, items, at));
        continue;
      }
      if (nl.isGroundNet(net) || nl.isSupplyNet(net)) continue;
      let driven = nl.pulls(net).length > 0;
      const connectors = new Set<string>();
      for (const [r2, p2] of nl.members(net)) {
        if (r2 === ref && p2 === pad) continue;
        if (isConnector(r2)) connectors.add(r2);
        else if (/^U\d/.test(r2) && DRIVING_ROLES.has(nl.role(r2, p2) ?? '')) driven = true;
        else if (/^R\d/.test(r2)) driven = true; // a series resistor from a driven net, or a pull
        else if (/^(SW|S)\d/.test(r2)) driven = driven || nl.pulls(net).length > 0;
      }
      if (driven) continue;
      const withNet = [...items, `net:${net}`];
      if (connectors.size > 0) {
        const via = [...connectors].sort().join(', ');
        const what = `${nl.label(ref, pad)} on ${net} is driven only through ${via} and has no pull resistor on this board`;
        if (/SDA|SCL/i.test(net)) {
          out.push(ercFinding('floating-input', 'info', `${what}; I2C pull-ups are expected off-board`, withNet, at));
        } else {
          out.push(ercFinding('floating-input', 'warn', `${what}: it floats when the cable is unplugged`, withNet, at));
        }
      } else {
        out.push(ercFinding('floating-input', 'error', `${nl.label(ref, pad)} on ${net}: nothing drives or pulls this net`, withNet, at));
      }
    }
  }
  return out;
}
