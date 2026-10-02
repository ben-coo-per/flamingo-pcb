/**
 * Flamingo Panel - interconnect check: do the cables between boards join the
 * right nets?
 *
 * Each board can be DRC- and ERC-clean and the set still dead at the cable:
 * SDA on one header meeting SCL on the other, 3V3 landing on a signal pin. For
 * every link declared on the panel (`panel.links`) this walks the cable pin by
 * pin and compares the net at each end:
 *
 *   ground meets ground          GND-like names on both ends
 *   supply meets the same supply 3V3 to 3V3, never 3V3 to 5V
 *   no supply meets a signal
 *   signals agree by name        after the link's aliases (BUS_SDA = SDA)
 *   both ends are connected      a net on one end and nothing on the other is
 *                                a pin the cable carries to nowhere
 *
 * Optionally, a markdown pin table ("| Pin | Signal | Pin | Signal |") is
 * compared with the copper of the `from` header, so docs that drift from the
 * board are caught too.
 *
 * Pure: boards come from resolved sources, nothing is read from disk.
 */

import type { Board, CheckFinding, ComponentInst } from '@flamingo/engine';
import { parseEndpoint } from './panel.js';
import type { ResolvedSources } from './resolved.js';
import type { Panel, PanelLink } from './types.js';

const CHECK = 'interconnect';

const GROUND_RE = /^(A|D|P|S)?GND(_.*)?$|^VSS|^0V$/i;
const SUPPLY_RE = /^(\+?\d+V\d*|V\d+V\d*|VCC|VDD|VBUS|VM|VIN|AVDD|DVDD)(_.*)?$/i;

export type NetKind = 'ground' | 'supply' | 'signal';

export function netKind(board: Board, net: string): NetKind {
  if (GROUND_RE.test(net)) return 'ground';
  const cls = board.nets.find((n) => n.name === net)?.class;
  if (cls === 'power' || cls === 'supply') return 'supply';
  return SUPPLY_RE.test(net) ? 'supply' : 'signal';
}

/** Upper-cased, '-' and spaces as '_', then through the link's aliases. Ground is always "GND". */
export function canonicalNet(net: string, aliases: Record<string, string> = {}): string {
  if (GROUND_RE.test(net)) return 'GND';
  const norm = (s: string): string => s.trim().toUpperCase().replace(/[-\s]+/g, '_');
  const table = new Map(Object.entries(aliases).map(([k, v]) => [norm(k), norm(v)]));
  const n = norm(net);
  return table.get(n) ?? n;
}

function netOf(board: Board, refdes: string, pad: string): string | undefined {
  const ref = `${refdes}.${pad}`;
  return board.nets.find((n) => n.pins.includes(ref))?.name;
}

/** Pad numbers of a header, in natural order (2 before 10). */
function headerPads(c: ComponentInst): string[] {
  const pads = [...new Set(c.footprint.pads.map((p) => p.number))];
  return pads.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

interface End {
  ep: string;
  key: string;
  refdes: string;
  board: Board;
  comp: ComponentInst;
}

function resolveEnd(ep: string, sources: ResolvedSources, link: PanelLink, out: CheckFinding[]): End | null {
  const parsed = parseEndpoint(ep);
  const fail = (message: string): null => {
    out.push({ check: CHECK, rule: 'link-endpoint', level: 'error', message: `${link.id}: ${message}`, items: [link.id, ep] });
    return null;
  };
  if (!parsed) return fail(`endpoint "${ep}" must be "<source key>:<refdes>"`);
  const src = sources.find((s) => s.key === parsed.key);
  if (!src) return fail(`endpoint "${ep}" refers to unknown source "${parsed.key}"`);
  if (!src.board) return fail(`board ${src.path} cannot be read${src.error ? `: ${src.error}` : ''}`);
  const comp = src.board.components.find((c) => c.refdes === parsed.refdes);
  if (!comp) return fail(`${src.name} has no ${parsed.refdes}`);
  return { ep, key: parsed.key, refdes: parsed.refdes, board: src.board, comp };
}

/** Pad pairs (from pad, to pad) the cable joins. */
function padPairs(link: PanelLink, a: End, b: End, out: CheckFinding[]): [string, string][] {
  const padsA = headerPads(a.comp);
  const padsB = new Set(headerPads(b.comp));
  if (link.map === 'straight') {
    const onlyA = padsA.filter((p) => !padsB.has(p));
    const onlyB = [...padsB].filter((p) => !padsA.includes(p));
    if (onlyA.length > 0 || onlyB.length > 0) {
      out.push({
        check: CHECK,
        rule: 'pin-count',
        level: 'error',
        message:
          `${link.id}: ${a.ep} has ${padsA.length} pads and ${b.ep} has ${padsB.size}; a straight cable cannot join ` +
          `${[...onlyA.map((p) => `${a.ep}.${p}`), ...onlyB.map((p) => `${b.ep}.${p}`)].join(', ')}`,
        items: [link.id, a.ep, b.ep],
      });
    }
    return padsA.filter((p) => padsB.has(p)).map((p) => [p, p]);
  }
  const pairs: [string, string][] = [];
  for (const [pa, pb] of Object.entries(link.map)) {
    if (!padsA.includes(pa) || !padsB.has(pb)) {
      out.push({
        check: CHECK,
        rule: 'link-endpoint',
        level: 'error',
        message: `${link.id}: map entry ${pa} -> ${pb} names a pad that ${!padsA.includes(pa) ? a.ep : b.ep} does not have`,
        items: [link.id, `${a.ep}.${pa}`, `${b.ep}.${pb}`],
      });
      continue;
    }
    pairs.push([pa, pb]);
  }
  return pairs;
}

function comparePair(link: PanelLink, a: End, b: End, pa: string, pb: string, out: CheckFinding[]): boolean {
  const na = netOf(a.board, a.refdes, pa);
  const nb = netOf(b.board, b.refdes, pb);
  const where = `${a.ep}.${pa} -> ${b.ep}.${pb}`;
  const items = [link.id, `${a.ep}.${pa}`, `${b.ep}.${pb}`];
  const push = (rule: string, level: CheckFinding['level'], message: string): false => {
    out.push({ check: CHECK, rule, level, message: `${link.id} ${where}: ${message}`, items });
    return false;
  };
  if (!na && !nb) return true;
  if (!na || !nb) {
    return push(
      'one-sided',
      'warn',
      na ? `${na} reaches a pin that is not connected on ${b.ep}` : `${nb} reaches a pin that is not connected on ${a.ep}`,
    );
  }
  const ka = netKind(a.board, na);
  const kb = netKind(b.board, nb);
  const ca = canonicalNet(na, link.aliases);
  const cb = canonicalNet(nb, link.aliases);
  if (ka === 'ground' || kb === 'ground') {
    return ka === kb ? true : push('ground-mismatch', 'error', `ground (${ka === 'ground' ? na : nb}) meets ${ka === 'ground' ? nb : na}`);
  }
  if (ka === 'supply' && kb === 'supply') {
    return ca === cb ? true : push('supply-mismatch', 'error', `supply ${na} meets a different supply, ${nb}`);
  }
  if (ka === 'supply' || kb === 'supply') {
    return push('supply-on-signal', 'error', `supply ${ka === 'supply' ? na : nb} meets signal ${ka === 'supply' ? nb : na}`);
  }
  return ca === cb ? true : push('name-mismatch', 'error', `${na} meets ${nb}${link.aliases ? ' (after aliases)' : ''}`);
}

export interface InterconnectOptions {
  /**
   * Markdown documents to compare against the copper: every
   * "| Pin | Signal | Pin | Signal |" table found is checked against the
   * `from` header of each link whose pin count it matches.
   */
  docs?: { name: string; text: string }[];
}

/** Every "| Pin | Signal | Pin | Signal |" table in a markdown text, as pin -> signal. */
export function parsePinTables(markdown: string): Map<string, string>[] {
  const tables: Map<string, string>[] = [];
  let cur: Map<string, string> | null = null;
  for (const line of markdown.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('|')) {
      if (cur) tables.push(cur);
      cur = null;
      continue;
    }
    const cells = s.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells.map((c) => c.toLowerCase()).join('|') === 'pin|signal|pin|signal') {
      if (cur) tables.push(cur);
      cur = new Map();
      continue;
    }
    if (!cur || /^[-:\s|]*$/.test(cells.join(''))) continue;
    for (let i = 0; i + 1 < cells.length; i += 2) {
      if (/^\d+$/.test(cells[i]!)) cur.set(cells[i]!, cells[i + 1]!);
    }
  }
  if (cur) tables.push(cur);
  return tables.filter((t) => t.size > 0);
}

function checkDocs(link: PanelLink, a: End, docs: NonNullable<InterconnectOptions['docs']>, out: CheckFinding[]): void {
  const pads = headerPads(a.comp);
  for (const doc of docs) {
    parsePinTables(doc.text).forEach((table, t) => {
      if (table.size !== pads.length) return;
      const bad: string[] = [];
      for (const [pin, signal] of table) {
        const net = netOf(a.board, a.refdes, pin);
        const doc = canonicalNet(signal, link.aliases);
        if (!net || canonicalNet(net, link.aliases) !== doc) bad.push(`pin ${pin}: doc says ${signal}, copper has ${net ?? 'nothing'}`);
      }
      out.push(
        bad.length > 0
          ? {
              check: CHECK,
              rule: 'doc-mismatch',
              level: 'warn',
              message: `${link.id}: pin table ${t + 1} in ${doc.name} disagrees with ${a.ep}: ${bad.join('; ')}`,
              items: [link.id, a.ep, doc.name],
            }
          : {
              check: CHECK,
              rule: 'doc-match',
              level: 'info',
              message: `${link.id}: pin table ${t + 1} in ${doc.name} matches ${a.ep} on all ${table.size} pins`,
              items: [link.id, a.ep, doc.name],
            },
      );
    });
  }
}

/** Check every cable declared on the panel. Findings are data; an empty panel yields none. */
export function checkInterconnect(panel: Panel, sources: ResolvedSources, opts: InterconnectOptions = {}): CheckFinding[] {
  const out: CheckFinding[] = [];
  for (const link of panel.links ?? []) {
    const a = resolveEnd(link.from, sources, link, out);
    if (!a) continue;
    if (opts.docs?.length) checkDocs(link, a, opts.docs, out);
    for (const ep of link.to) {
      const b = resolveEnd(ep, sources, link, out);
      if (!b) continue;
      const pairs = padPairs(link, a, b, out);
      let good = 0;
      for (const [pa, pb] of pairs) if (comparePair(link, a, b, pa, pb, out)) good++;
      out.push({
        check: CHECK,
        rule: 'summary',
        level: 'info',
        message: `${link.id} ${a.ep} -> ${b.ep}: ${good} of ${pairs.length} pins agree`,
        items: [link.id, a.ep, b.ep],
      });
    }
  }
  return out;
}
