/**
 * One check finding as a row: level badge, `check/rule`, message, and the
 * items it names as chips. Shared by the editor's Checks drawer and the panel
 * view's cable check, so a finding looks the same wherever it is shown.
 *
 * Self-contained: it brings its own styles (finding-row.css), drawn in
 * currentColor so the row takes the ink of the page it sits on.
 */

import type { CheckFinding } from '@flamingo/engine';
import './finding-row.css';

export interface FindingRowOptions {
  /** Called when the row (not an action) is clicked; makes the row focusable. */
  onClick?: (f: CheckFinding) => void;
  /** Called when an item chip is clicked. */
  onItem?: (item: string, f: CheckFinding) => void;
  /** Buttons or links placed at the row's end (e.g. "Waive…"). */
  actions?: HTMLElement[];
  /** Hide the `check/` prefix when every row on the page is from one check. */
  hideCheck?: boolean;
}

const BADGE: Record<CheckFinding['level'], { text: string; label: string }> = {
  error: { text: 'E', label: 'error' },
  warn: { text: 'W', label: 'warning' },
  info: { text: 'i', label: 'info' },
};

export function renderFindingRow(f: CheckFinding, opts: FindingRowOptions = {}): HTMLElement {
  const row = document.createElement('div');
  row.className = `finding-row finding-${f.level}`;
  row.dataset.check = f.check;
  row.dataset.rule = f.rule;

  const badge = document.createElement('span');
  badge.className = `finding-badge finding-badge-${f.level}`;
  badge.textContent = BADGE[f.level].text;
  badge.title = BADGE[f.level].label;

  const rule = document.createElement('span');
  rule.className = 'finding-rule';
  rule.textContent = opts.hideCheck ? f.rule : `${f.check}/${f.rule}`;

  const head = document.createElement('div');
  head.className = 'finding-head';
  head.append(badge, rule);
  if (opts.actions?.length) {
    const actions = document.createElement('span');
    actions.className = 'finding-actions';
    actions.append(...opts.actions);
    head.append(actions);
  }

  const msg = document.createElement('div');
  msg.className = 'finding-message';
  msg.textContent = f.message;

  row.append(head, msg);

  if (f.items.length > 0) {
    const items = document.createElement('div');
    items.className = 'finding-items';
    for (const item of f.items) {
      const chip = document.createElement(opts.onItem ? 'button' : 'span');
      chip.className = 'finding-item';
      chip.textContent = item;
      if (opts.onItem) {
        (chip as HTMLButtonElement).type = 'button';
        chip.addEventListener('click', (ev) => {
          ev.stopPropagation();
          opts.onItem!(item, f);
        });
      }
      items.append(chip);
    }
    row.append(items);
  }

  if (opts.onClick) {
    row.classList.add('finding-clickable');
    row.tabIndex = 0;
    const go = (): void => opts.onClick!(f);
    row.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).closest('.finding-actions')) return;
      go();
    });
    row.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        go();
      }
    });
  }
  return row;
}

/** `2 errors · 1 warning`, or `no problems` when there are no errors or warnings. */
export function findingSummary(findings: CheckFinding[]): string {
  const e = findings.filter((f) => f.level === 'error').length;
  const w = findings.filter((f) => f.level === 'warn').length;
  if (e === 0 && w === 0) return 'no problems';
  const parts: string[] = [];
  if (e > 0) parts.push(`${e} error${e === 1 ? '' : 's'}`);
  if (w > 0) parts.push(`${w} warning${w === 1 ? '' : 's'}`);
  return parts.join(' · ');
}
