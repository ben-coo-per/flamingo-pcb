/**
 * ERC rule esp32: ESP32-S3 module bring-up pins (ESP32-S3 datasheet,
 * "Strapping Pins"; ESP32-S3-WROOM-1 datasheet, schematic checklist).
 *
 * - IO0 pulled low always boots into download mode: error. No external
 *   pull-up: warning (the internal one is weak).
 * - IO45 pulled high selects 1.8 V flash supply: error. IO46 pulled high:
 *   warning.
 * - EN needs a pull-up (error without) and a capacitor for the RC delay
 *   Espressif asks for (warning without, or when the delay is under 1 ms).
 * - Octal-PSRAM variants (R8, R16...) use GPIO35..37 internally: wiring
 *   them is an error.
 */

import type { CheckFinding } from '../../checks/types.js';
import type { Netlist } from '../netlist.js';
import { ercFinding } from '../finding.js';
import { ESP32S3_MODULES, ESP32S3_OCTAL_PSRAM, ESP32S3_STRAPS } from '../part-facts.js';
import { formatSi } from '../../values.js';

export function check(nl: Netlist): CheckFinding[] {
  const out: CheckFinding[] = [];
  for (const c of nl.ics()) {
    if (!ESP32S3_MODULES.has(c.lcsc)) continue;
    const ref = c.refdes;
    const at = (name: string) => {
      const pad = nl.padsNamed(ref, name)[0];
      return pad ? nl.padAt(ref, pad) : undefined;
    };
    const items = (name: string) => [ref, ...nl.padsNamed(ref, name).map((p) => `${ref}.${p}`)];

    for (const [name, { internal, effect }] of Object.entries(ESP32S3_STRAPS)) {
      const net = nl.netOfName(ref, name);
      if (net === undefined) {
        out.push(ercFinding('esp32', 'info', `${ref} ${name} open: internal ${internal}; ${effect}`, items(name), at(name)));
        continue;
      }
      const pulls = nl.pulls(net);
      const up = pulls.some((p) => p.direction === 'up') || nl.isSupplyNet(net);
      const down = pulls.some((p) => p.direction === 'down') || nl.isGroundNet(net);
      const desc = `${ref} ${name} on ${net}`;
      if (name === 'IO0' && down) {
        out.push(ercFinding('esp32', 'error', `${desc} is pulled low: the chip always boots into download mode`, items(name), at(name)));
      } else if (name === 'IO0' && !up) {
        out.push(ercFinding('esp32', 'warn', `${desc} has no external pull-up; it relies on the weak internal one`, items(name), at(name)));
      } else if (name === 'IO45' && up) {
        out.push(ercFinding('esp32', 'error', `${desc} is pulled high: ${effect}`, items(name), at(name)));
      } else if (name === 'IO46' && up) {
        out.push(ercFinding('esp32', 'warn', `${desc} is pulled high: ${effect}`, items(name), at(name)));
      } else {
        out.push(ercFinding('esp32', 'info', `${desc}: ${effect}`, items(name), at(name)));
      }
    }

    const en = nl.netOfName(ref, 'EN');
    const enUp = nl.pulls(en).filter((p) => p.direction === 'up');
    const enCaps = nl.capsToGround(en);
    if (en === undefined || enUp.length === 0) {
      out.push(ercFinding('esp32', 'error', `${ref} EN${en ? ` on ${en}` : ''} has no pull-up: the chip may never start`, items('EN'), at('EN')));
    } else if (enCaps.length === 0) {
      out.push(
        ercFinding('esp32', 'warn', `${ref} EN on ${en} has no capacitor: Espressif asks for an RC delay (10k and 1uF) so EN rises after the supply`, items('EN'), at('EN')),
      );
    } else {
      const farads = enCaps.reduce((s, [, f]) => s + (f ?? 0), 0);
      const tau = enUp[0]!.ohms * farads;
      out.push(
        ercFinding(
          'esp32',
          tau >= 1e-3 ? 'info' : 'warn',
          `${ref} EN reset delay ${formatSi(enUp[0]!.ohms, 'ohm')} x ${formatSi(farads, 'F')} = ${formatSi(tau, 's')}${tau >= 1e-3 ? '' : ' (shorter than 1 ms)'}`,
          items('EN'),
          at('EN'),
        ),
      );
    }

    const used = ['IO35', 'IO36', 'IO37'].filter((n) => nl.netOfName(ref, n) !== undefined);
    if (used.length > 0 && ESP32S3_OCTAL_PSRAM.test(c.fields.value ?? '')) {
      out.push(
        ercFinding('esp32', 'error', `${ref} is ${c.fields.value}, which has octal PSRAM on GPIO35..37, but ${used.join(', ')} are wired`, [ref], c.at),
      );
    }
  }
  return out;
}
