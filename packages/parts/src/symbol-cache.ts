/**
 * Symbol pins for many parts at once, from the on-disk parts cache only.
 * Electrical checks call this to name the pins of parts placed before
 * footprints carried their own `pins`. Never fetches: a part that is not
 * cached simply has no pin names, and the checks say so.
 */

import type { SymbolPin } from '@flamingo/engine';
import { readCache } from './cache.js';
import { parseEasyedaSymbolPins } from './easyeda-parse.js';

export async function symbolPinsFromCache(
  lcscs: Iterable<string>,
): Promise<Map<string, Record<string, SymbolPin>>> {
  const out = new Map<string, Record<string, SymbolPin>>();
  for (const lcsc of new Set(lcscs)) {
    if (!lcsc) continue;
    const raw = await readCache(lcsc);
    if (raw) out.set(lcsc, parseEasyedaSymbolPins(raw));
  }
  return out;
}
