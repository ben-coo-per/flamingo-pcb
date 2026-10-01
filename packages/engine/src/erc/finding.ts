/** Flamingo Engine - ERC finding helper. */

import type { Point } from '../types.js';
import type { CheckFinding, CheckLevel } from '../checks/types.js';

export function ercFinding(
  rule: string,
  level: CheckLevel,
  message: string,
  items: string[],
  at?: Point,
): CheckFinding {
  return { check: 'erc', rule, level, message, items, ...(at ? { at } : {}) };
}
