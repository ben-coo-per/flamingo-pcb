/** Panel view - text formatting. Pure. */

import type { PanelIssue, Received, Scenario } from '@flamingo/panel';

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function mm(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/** The mark that follows every amount resting on an unverified number. */
export const ESTIMATE_MARK = 'est.';

export const ESTIMATE_LEGEND =
  'est. = estimate: the amount rests on a number that was not verified on a JLCPCB help page. Bare-board prices are always estimates. Shipping, tax and coupons are not included.';

/** `S 2/1  M 6/5`: boards received over boards needed, per design. */
export function receivedShort(received: Received[]): string {
  return received.map((r) => `${r.key} ${r.assembled}/${r.needed}`).join('  ');
}

export function receivedLong(r: Received): string {
  const bits = [`${r.assembled} assembled`];
  if (r.bare > 0) bits.push(`${r.bare} bare`);
  const need = r.niceToHave > r.needed ? `need ${r.needed}, nice to have ${r.niceToHave}` : `need ${r.needed}`;
  const verdict = r.shortfall > 0 ? `short by ${r.shortfall}` : r.overage > 0 ? `${r.overage} over` : 'exact';
  return `${r.key}  ${bits.join(' + ')}  (${need}; ${verdict})`;
}

export function issueCounts(issues: PanelIssue[]): string {
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  const notes = issues.filter((i) => i.severity === 'info').length;
  const part = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  return [part(errors, 'error'), part(warnings, 'warning'), part(notes, 'note')].join(', ');
}

export const LEVEL_LABEL: Record<PanelIssue['severity'], string> = {
  error: 'ERROR',
  warning: 'WARNING',
  info: 'NOTE',
};

/** Worst severity per instance id, for marking instances on the canvas. */
export function worstByInstance(issues: PanelIssue[]): Map<string, 'error' | 'warning'> {
  const out = new Map<string, 'error' | 'warning'>();
  for (const issue of issues) {
    if (issue.severity === 'info') continue;
    for (const id of issue.instances) {
      if (out.get(id) !== 'error') out.set(id, issue.severity);
    }
  }
  return out;
}

export function scenarioWarningCount(s: Scenario): string {
  return s.warnings.length === 0 ? '' : `${s.warnings.length} warning${s.warnings.length === 1 ? '' : 's'}`;
}

/** What decides whether the scenarios have to be fetched again. */
export function quoteKey(view: {
  panel: { sources: Array<{ key: string; hash: string; needed: number; niceToHave: number }>; settings: unknown };
  sources: Array<{ key: string; stale: boolean; error?: string }>;
}): string {
  return JSON.stringify([
    view.panel.sources.map((s) => [s.key, s.hash, s.needed, s.niceToHave]),
    view.sources.map((s) => [s.key, s.stale, s.error ?? '']),
    view.panel.settings,
  ]);
}
