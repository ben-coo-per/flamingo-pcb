/**
 * Flamingo Engine - ERC orchestrator.
 *
 * Flamingo has no schematic step, so there is no classic ERC either: this
 * checks the netlist directly, using pin names from the parts' EasyEDA
 * symbols (footprint.pins, or a PinLookup for parts placed before footprints
 * carried them) and pin roles from part-facts.ts. Findings are data, like
 * DRC violations; `error` findings gate export. Waivers on the board
 * (board.checkWaivers) silence a rule for named items, with a reason.
 */

import type { Board } from '../types.js';
import { applyWaivers, type CheckFinding, type PinLookup } from '../checks/types.js';
import { Netlist } from './netlist.js';
import { ercFinding } from './finding.js';
import { check as powerPins } from './checks/powerPins.js';
import { check as singlePinNet } from './checks/singlePinNet.js';
import { check as unconnectedPin } from './checks/unconnectedPin.js';
import { check as floatingInput } from './checks/floatingInput.js';
import { check as decoupling, DEFAULT_DECOUPLING_MM } from './checks/decoupling.js';
import { check as polarity } from './checks/polarity.js';
import { check as esp32 } from './checks/esp32.js';
import { check as usbCc } from './checks/usbCc.js';

export interface ErcOptions {
  /** Symbol pins for parts whose footprint does not carry them. */
  pins?: PinLookup;
  /** Warn when an IC supply pin's nearest decoupling capacitor is further than this (default 10 mm). */
  decouplingMm?: number;
  /** Also return waived findings, at level 'info' with the waiver's reason appended. */
  includeWaived?: boolean;
}

export const ERC_RULES = [
  'power-pins',
  'single-pin-net',
  'unconnected-ic-pin',
  'floating-input',
  'decoupling',
  'polarity',
  'esp32',
  'usb-cc',
  'symbols',
] as const;

export function runErc(board: Board, opts: ErcOptions = {}): CheckFinding[] {
  const nl = new Netlist(board, opts.pins);
  const findings: CheckFinding[] = [];

  // Parts with no pin names can only be checked by number: say so once each.
  const unnamed = [...new Set(nl.ics().filter((c) => Object.keys(nl.pins(c.refdes)).length === 0).map((c) => c.lcsc))];
  for (const lcsc of unnamed.sort()) {
    const refs = nl.ics().filter((c) => c.lcsc === lcsc).map((c) => c.refdes);
    findings.push(
      ercFinding('symbols', 'info', `no symbol pin names for ${lcsc} (${refs.join(', ')}): its power and input pins are not checked`, refs),
    );
  }

  findings.push(
    ...powerPins(nl),
    ...singlePinNet(nl),
    ...unconnectedPin(nl),
    ...floatingInput(nl),
    ...decoupling(nl, opts.decouplingMm ?? DEFAULT_DECOUPLING_MM),
    ...polarity(nl),
    ...esp32(nl),
    ...usbCc(nl),
  );

  const { kept, waived } = applyWaivers(findings, board.checkWaivers?.filter((w) => !w.check || w.check === 'erc'));
  if (!opts.includeWaived) return kept;
  return [
    ...kept,
    ...waived.map(({ finding, waiver }) => ({ ...finding, level: 'info' as const, message: `${finding.message} [waived: ${waiver.reason}]` })),
  ];
}
