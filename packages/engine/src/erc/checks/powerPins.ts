/**
 * ERC rule power-pins: every IC supply and ground pin is connected, ground
 * pins sit on a ground net, and supply pins sit on a power net.
 */

import type { CheckFinding } from '../../checks/types.js';
import type { Netlist } from '../netlist.js';
import { ercFinding } from '../finding.js';

export function check(nl: Netlist): CheckFinding[] {
  const out: CheckFinding[] = [];
  for (const c of nl.ics()) {
    const ref = c.refdes;
    for (const pad of nl.padNumbers(ref)) {
      const role = nl.role(ref, pad);
      if (role !== 'supply' && role !== 'ground') continue;
      const net = nl.net(ref, pad);
      const items = [`${ref}.${pad}`, ref];
      const at = nl.padAt(ref, pad);
      if (net === undefined) {
        out.push(ercFinding('power-pins', 'error', `${nl.label(ref, pad)} is not connected`, items, at));
      } else if (role === 'ground' && !nl.isGroundNet(net)) {
        out.push(ercFinding('power-pins', 'error', `${nl.label(ref, pad)} is a ground pin on net ${net}`, [...items, `net:${net}`], at));
      } else if (role === 'supply' && nl.isGroundNet(net)) {
        out.push(ercFinding('power-pins', 'error', `${nl.label(ref, pad)} is a supply pin on ground net ${net}`, [...items, `net:${net}`], at));
      } else if (role === 'supply' && !nl.isSupplyNet(net)) {
        out.push(
          ercFinding('power-pins', 'warn', `${nl.label(ref, pad)} is a supply pin on ${net}, which is not a power net`, [...items, `net:${net}`], at),
        );
      }
    }
  }
  return out;
}
