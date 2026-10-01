/**
 * ERC rule polarity: polarised parts must point the right way.
 *
 * Applies to every part whose symbol names its pins A and K. Each pad's net
 * gets a potential when one can be known: ground nets 0 V, rails by name
 * (3V3 = 3.3 V, 5V, +12V, VBUS = 5 V), or a net whose pull resistors all lead
 * to the same known potential (an LED's resistor to 3V3). Unknown potentials
 * (GPIO-driven nets) are never guessed at.
 *
 * LEDs (footprint, description or value says LED) must be able to light:
 *   - anode on ground with the cathode elsewhere: error. Nothing on a board
 *     goes below ground, so it never conducts.
 *   - anode at a lower known potential than the cathode: error.
 * Other diodes are often meant to sit reverse-biased (clamps, flyback,
 * Zener), so only a diode that shorts two rails forward is flagged:
 *   - anode on a rail, cathode on ground: error (a forward short).
 *   - anode on a higher rail than the cathode's rail: warning.
 *
 * It also reads a part's `role` and `description` for a claim such as
 * "pad 1 = cathode" and warns when the symbol says otherwise -- the wrong
 * assumption that put three LEDs on the KinAura boards backwards.
 * Electrolytic capacitors are not checked: their EasyEDA symbols number the
 * pins without marking + and -.
 */

import type { CheckFinding } from '../../checks/types.js';
import type { Netlist } from '../netlist.js';
import { ercFinding } from '../finding.js';

function potential(nl: Netlist, net: string | undefined): number | undefined {
  if (!net) return undefined;
  const direct = nl.netVolts(net);
  if (direct !== undefined) return direct;
  const via = nl.pulls(net).map((p) => nl.netVolts(p.to));
  if (via.length === 0 || via.some((v) => v === undefined)) return undefined;
  return via.every((v) => v === via[0]) ? via[0] : undefined;
}

const fmtV = (v: number): string => `${Number(v.toPrecision(3))} V`;

export function check(nl: Netlist): CheckFinding[] {
  const out: CheckFinding[] = [];
  for (const c of nl.components) {
    const ref = c.refdes;
    const pins = nl.pins(ref);
    const aPad = Object.keys(pins).find((p) => pins[p]!.name.toUpperCase() === 'A');
    const kPad = Object.keys(pins).find((p) => pins[p]!.name.toUpperCase() === 'K');
    if (aPad === undefined || kPad === undefined) continue;

    const claim = /pad\s*1\s*(?:=|is)\s*(?:the\s+)?(cathode|anode)/i.exec(
      `${c.fields.role ?? ''} ${c.fields.description ?? ''}`,
    );
    if (claim) {
      const said = claim[1]!.toLowerCase();
      const actual = aPad === '1' ? 'anode' : kPad === '1' ? 'cathode' : undefined;
      if (actual && actual !== said) {
        out.push(
          ercFinding(
            'polarity',
            'warn',
            `${ref}'s notes say pad 1 = ${said}, but its symbol (${c.lcsc}) has pad 1 = ${actual}`,
            [ref, `${ref}.1`],
            nl.padAt(ref, '1'),
          ),
        );
      }
    }

    const aNet = nl.net(ref, aPad);
    const kNet = nl.net(ref, kPad);
    if (!aNet || !kNet) continue;
    const items = [ref, `${ref}.${aPad}`, `${ref}.${kPad}`];
    const at = nl.padAt(ref, aPad);
    const what = `${ref} (${c.fields.value ?? c.lcsc})`;
    if (aNet === kNet) {
      out.push(ercFinding('polarity', 'warn', `${what} has both pads on ${aNet}`, items, at));
      continue;
    }
    const isLed = /LED/i.test(`${c.footprint.name} ${c.fields.description ?? ''} ${c.fields.value ?? ''}`) || /^LED/i.test(ref);
    if (isLed) {
      const va = potential(nl, aNet);
      const vk = potential(nl, kNet);
      if (nl.isGroundNet(aNet) && !nl.isGroundNet(kNet)) {
        out.push(
          ercFinding(
            'polarity',
            'error',
            `${what} is reversed: anode pad ${aPad} is on ground (${aNet}) and cathode pad ${kPad} on ${kNet}${
              vk !== undefined ? ` (${fmtV(vk)})` : ''
            }. It will never light`,
            items,
            at,
          ),
        );
      } else if (va !== undefined && vk !== undefined && va < vk) {
        out.push(
          ercFinding(
            'polarity',
            'error',
            `${what} is reversed: anode pad ${aPad} on ${aNet} (${fmtV(va)}) is below cathode pad ${kPad} on ${kNet} (${fmtV(vk)}). It will never light`,
            items,
            at,
          ),
        );
      }
      continue;
    }
    // Other diodes: rails only, by name -- never through pulls.
    const ra = nl.isSupplyNet(aNet) || nl.isGroundNet(aNet) ? nl.netVolts(aNet) : undefined;
    const rk = nl.isSupplyNet(kNet) || nl.isGroundNet(kNet) ? nl.netVolts(kNet) : undefined;
    if (nl.isSupplyNet(aNet) && nl.isGroundNet(kNet)) {
      out.push(
        ercFinding(
          'polarity',
          'error',
          `${what} is reversed: anode pad ${aPad} on rail ${aNet}, cathode pad ${kPad} on ground (${kNet}). It shorts the rail`,
          items,
          at,
        ),
      );
    } else if (ra !== undefined && rk !== undefined && ra > rk) {
      out.push(
        ercFinding(
          'polarity',
          'warn',
          `${what} conducts from ${aNet} (${fmtV(ra)}) into ${kNet} (${fmtV(rk)}): check it is not reversed`,
          items,
          at,
        ),
      );
    }
  }
  return out;
}
