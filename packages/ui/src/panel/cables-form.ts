/**
 * Panel view - cables: the add-cable form as data, and links as text.
 * Pure, so the parsing that turns what someone typed into a PanelLink is
 * tested without a page.
 */

import type { PanelLink } from '@flamingo/panel';
import { validateLink } from '@flamingo/panel';

export interface CableForm {
  /** "S:J5". */
  from: string;
  /** "D:J6", one per far end. */
  to: string[];
  /** Straight (pad N meets pad N), or a custom map typed as text. */
  straight: boolean;
  /** "1=3, 2=4" or one pair per line; `=`, `>`, `->` or `:` between the pads. */
  pinMap: string;
  /** "M_EN = MOTION_EN" pairs, comma or line separated. */
  aliases: string;
  note: string;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Split "a=b, c=d" or one pair per line into trimmed [left, right] pairs. */
function pairs(text: string, what: string): Parsed<[string, string][]> {
  const out: [string, string][] = [];
  for (const raw of text.split(/[\n,;]+/)) {
    const part = raw.trim();
    if (!part) continue;
    const m = /^(.+?)\s*(?:->|=>|=|>|:)\s*(.+)$/.exec(part);
    if (!m || !m[1]!.trim() || !m[2]!.trim()) return { ok: false, error: `${what}: "${part}" is not a pair like "1 = 3"` };
    out.push([m[1]!.trim(), m[2]!.trim()]);
  }
  return { ok: true, value: out };
}

/**
 * A custom pin map, from-pad to to-pad. Each from-pad may appear once; pads
 * not listed are not carried by the cable.
 */
export function parsePinMap(text: string): Parsed<Record<string, string>> {
  const p = pairs(text, 'pin map');
  if (!p.ok) return p;
  if (p.value.length === 0) return { ok: false, error: 'pin map: list at least one pair, like "1 = 3"' };
  const map: Record<string, string> = {};
  for (const [a, b] of p.value) {
    if (/\s/.test(a) || /\s/.test(b)) return { ok: false, error: `pin map: pad numbers have no spaces ("${a} = ${b}")` };
    if (a in map) return { ok: false, error: `pin map: pad ${a} is mapped twice` };
    map[a] = b;
  }
  return { ok: true, value: map };
}

/** Net aliases, "M_EN = MOTION_EN": the left name means the same signal as the right. */
export function parseAliases(text: string): Parsed<Record<string, string>> {
  const p = pairs(text, 'aliases');
  if (!p.ok) return p;
  const aliases: Record<string, string> = {};
  for (const [a, b] of p.value) {
    if (a.toUpperCase() === b.toUpperCase()) continue; // says nothing
    if (a in aliases && aliases[a] !== b) return { ok: false, error: `aliases: ${a} is given two meanings` };
    aliases[a] = b;
  }
  return { ok: true, value: aliases };
}

/**
 * The form as a link ready for the `addLink` op, or what is wrong with it.
 * Shape and source keys are checked with the panel's own validateLink, so
 * the form refuses exactly what the server would.
 */
export function buildLink(form: CableForm, sourceKeys: ReadonlySet<string>): Parsed<Omit<PanelLink, 'id'>> {
  const from = form.from.trim();
  const to = form.to.map((t) => t.trim()).filter(Boolean);
  if (!from) return { ok: false, error: 'Pick the header the cable starts at.' };
  if (to.length === 0) return { ok: false, error: 'Pick at least one header the cable goes to.' };
  let map: PanelLink['map'] = 'straight';
  if (!form.straight) {
    const m = parsePinMap(form.pinMap);
    if (!m.ok) return m;
    map = m.value;
  }
  const a = parseAliases(form.aliases);
  if (!a.ok) return a;
  const link: Omit<PanelLink, 'id'> = {
    from,
    to,
    map,
    ...(Object.keys(a.value).length > 0 ? { aliases: a.value } : {}),
    ...(form.note.trim() ? { note: form.note.trim() } : {}),
  };
  const problem = validateLink(link, sourceKeys);
  return problem ? { ok: false, error: problem.charAt(0).toUpperCase() + problem.slice(1) + '.' } : { ok: true, value: link };
}

/** "S:J5 → D:J6, M:J2 · straight" or "· 3 pins mapped". */
export function describeLink(link: PanelLink): string {
  const how = link.map === 'straight' ? 'straight' : `${Object.keys(link.map).length} pin${Object.keys(link.map).length === 1 ? '' : 's'} mapped`;
  return `${link.from} → ${link.to.join(', ')} · ${how}`;
}

/** Aliases as the form shows them, "M_EN = MOTION_EN, ...". */
export function aliasesText(aliases: Record<string, string> | undefined): string {
  return Object.entries(aliases ?? {})
    .map(([a, b]) => `${a} = ${b}`)
    .join(', ');
}
