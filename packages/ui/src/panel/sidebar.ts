/**
 * Panel view - sidebar. Plain DOM, rebuilt section by section, and only when
 * what a section shows has changed, so typing in a field is never interrupted
 * by a view arriving from the server.
 *
 * Three steps, top to bottom, each feeding the next:
 *
 *   1  Boards you need      what has to be delivered
 *   2  Ways to order them   every option for that need, cheapest first; the
 *                           panel on the plate is one of them
 *   3  On the plate         the option in view: the tools to change it, what
 *                           it costs, what is wrong with it, and the export
 *
 * The lists say things with shapes first and words second: a board is a
 * coloured chip, boards received are one mark each, cost is a bar. The full
 * sentence is behind a disclosure, never in the row.
 */

import type { CostLine, PanelView, PieceCount, Received, ScenarioKind, ScenarioLine } from '@flamingo/panel';
import { boardColor } from '@flamingo/panel';
import type { BoardFile } from './api.js';
import {
  ESTIMATE_LEGEND,
  ESTIMATE_LEGEND_LONG,
  ESTIMATE_MARK,
  LEVEL_LABEL,
  composition,
  escapeHtml,
  groupCost,
  groupIssues,
  mm,
  money,
  pips,
  receivedLong,
} from './format.js';
import type { Option } from './options.js';
import { buildOptions, optionInView } from './options.js';
import type { Message, PanelState } from './store.js';

export interface SidebarEls {
  panelName: HTMLElement;
  panelFile: HTMLElement;
  boardList: HTMLElement;
  boardAdd: HTMLElement;
  boardMsg: HTMLElement;
  optionList: HTMLElement;
  plateTitle: HTMLElement;
  plateMeaning: HTMLElement;
  plateEdit: HTMLElement;
  plateCounts: HTMLElement;
  arrangeBtn: HTMLButtonElement;
  arrangeMsg: HTMLElement;
  costFlag: HTMLElement;
  costSummary: HTMLElement;
  checks: HTMLElement;
  issueCount: HTMLElement;
  issueList: HTMLElement;
  exportBtn: HTMLButtonElement;
  exportMsg: HTMLElement;
  plateEmpty: HTMLElement;
  statusCursor: HTMLElement;
  statusZoom: HTMLElement;
  statusSize: HTMLElement;
  statusSelection: HTMLElement;
  statusConn: HTMLElement;
}

export interface SidebarActions {
  setCount(board: string, count: number): void;
  setQuantity(board: string, field: 'needed' | 'niceToHave', value: number): void;
  selectOption(id: string): void;
  selectInstance(id: string): void;
  addBoard(path: string): void;
}

/**
 * A scenario's kind as a small drawing: what is fabricated, seen from above.
 * Solid outlines are cut, dashed lines are printed, short bars are tabs.
 */
const SCENARIO_ICON: Record<ScenarioKind, string> = {
  // Two boards, each on its own.
  separate:
    '<rect x="1.5" y="4.5" width="14" height="11"/><rect x="21.5" y="7.5" width="9" height="8"/>',
  // Two panels, each with copies of one board.
  'own-panels':
    '<rect x="1.5" y="2.5" width="13" height="15"/><rect x="4" y="5" width="8" height="4"/><rect x="4" y="11" width="8" height="4"/>' +
    '<rect x="18.5" y="2.5" width="12" height="15"/><rect x="21" y="5" width="7" height="4"/><rect x="21" y="11" width="7" height="4"/>',
  // One panel: rails, boards with gaps between them, tabs across the gaps.
  merged:
    '<rect x="1.5" y="1.5" width="29" height="17"/><line x1="1.5" y1="4.5" x2="30.5" y2="4.5"/><line x1="1.5" y1="15.5" x2="30.5" y2="15.5"/>' +
    '<rect x="4" y="6.5" width="12" height="7"/><rect x="19" y="6.5" width="9" height="7"/>' +
    '<line x1="16" y1="10" x2="19" y2="10" stroke-width="2.5"/>',
  // One outline, printed lines between the boards.
  'silk-divider':
    '<rect x="1.5" y="2.5" width="29" height="15"/><line x1="17" y1="2.5" x2="17" y2="17.5" stroke-dasharray="2 1.5"/>' +
    '<line x1="17" y1="10" x2="30.5" y2="10" stroke-dasharray="2 1.5"/>',
  // Two panels of different make.
  split:
    '<rect x="1.5" y="2.5" width="13" height="15"/><rect x="4" y="5" width="8" height="10"/>' +
    '<rect x="18.5" y="2.5" width="12" height="15" stroke-width="2.5"/><rect x="21" y="5.5" width="7" height="9"/>',
};

function icon(kind: ScenarioKind): string {
  return `<svg class="sc-icon" viewBox="0 0 32 20" width="32" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.2">${SCENARIO_ICON[kind]}</svg>`;
}

function flag(estimate: boolean): string {
  return estimate ? `<span class="est" title="${escapeHtml(ESTIMATE_LEGEND_LONG)}">${ESTIMATE_MARK}</span>` : '';
}

/** A board, as a chip in its colour. `bare` draws it hollow. */
function chip(key: string, colour: string, text: string, opts: { bare?: boolean; instance?: string; title?: string } = {}): string {
  const cls = `chip${opts.bare ? ' chip-bare' : ''}${opts.instance ? ' chip-instance' : ''}`;
  const attrs =
    `class="${cls}" style="--board:${colour}"` +
    (opts.instance ? ` data-instance="${escapeHtml(opts.instance)}"` : '') +
    (opts.title ? ` title="${escapeHtml(opts.title)}"` : '');
  const tag = opts.instance ? 'button type="button"' : 'span';
  return `<${tag} ${attrs} data-board="${escapeHtml(key)}">${escapeHtml(text)}</${opts.instance ? 'button' : 'span'}>`;
}

/**
 * Boards received against needed: one mark per assembled board, in the board's
 * colour, and the bare boards that come with them as a count.
 */
function receivedMarks(r: Received, colour: string): string {
  const p = pips(r);
  const body = p.asText
    ? `<span class="pips-text">${p.label}</span>`
    : '<span class="pips">' +
      '<i class="pip pip-met"></i>'.repeat(p.met) +
      '<i class="pip pip-over"></i>'.repeat(p.over) +
      '<i class="pip pip-short"></i>'.repeat(p.short) +
      '</span>';
  return (
    `<span class="got" style="--board:${colour}" title="${escapeHtml(receivedLong(r))}" data-board="${escapeHtml(r.key)}" data-got="${r.assembled}" data-need="${r.needed}">` +
    `<b>${escapeHtml(r.key)}</b><span class="got-n">${r.assembled}</span>${body}` +
    (r.bare > 0 ? `<span class="got-bare" data-bare="${r.bare}">+ ${r.bare} bare</span>` : '') +
    `</span>`
  );
}

function costGroups(lines: Array<CostLine | ScenarioLine>, total: number, estimate: boolean, scope: string, open: Set<string>): string {
  const orderOf = (l: CostLine | ScenarioLine): string => (l as Partial<ScenarioLine>).order ?? '';
  const multi = new Set(lines.map(orderOf)).size > 1;
  const groups = groupCost(lines)
    .map((g) => {
      const id = `${scope}/${g.name}`;
      let order = '';
      const rows = g.lines
        .map((l) => {
          let head = '';
          if (multi && orderOf(l) !== order) {
            order = orderOf(l);
            head = `<tr class="order"><td colspan="3">${escapeHtml(order)}</td></tr>`;
          }
          return (
            `${head}<tr title="${escapeHtml(l.detail ?? '')}"><td>${escapeHtml(l.label)}</td>` +
            `<td class="amount">${money(l.amount)}</td><td class="flag">${flag(l.estimate)}</td></tr>`
          );
        })
        .join('');
      const share = total > 0 ? Math.round((g.amount / total) * 100) : 0;
      return (
        `<details class="cost-group" data-open="${escapeHtml(id)}"${open.has(id) ? ' open' : ''}>` +
        `<summary><span class="cost-name">${g.name}</span>` +
        `<span class="meter"><i style="width:${share}%"></i></span>` +
        `<span class="amount">${money(g.amount)}</span><span class="flag">${flag(g.estimate)}</span></summary>` +
        `<table class="lines">${rows}</table></details>`
      );
    })
    .join('');
  return (
    `<div class="cost-groups">${groups}` +
    `<div class="cost-total"><span class="cost-name">Total</span><span class="meter"></span>` +
    `<span class="amount">${money(total)}</span><span class="flag">${flag(estimate)}</span></div></div>`
  );
}

function notesBlock(items: string[], label: string, id: string, open: Set<string>, plural = `${label}s`): string {
  if (items.length === 0) return '';
  return (
    `<details class="notes-block" data-open="${escapeHtml(id)}"${open.has(id) ? ' open' : ''}>` +
    `<summary>${items.length} ${items.length === 1 ? label : plural}</summary>` +
    `<ul class="notes">${items.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul></details>`
  );
}

function renderMessage(el: HTMLElement, msg: Message | null): void {
  if (!msg) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.className = msg.problem ? 'msg msg-problem' : 'msg';
  el.textContent = msg.text;
  if (msg.link) {
    el.append(document.createElement('br'));
    const a = document.createElement('a');
    a.id = 'export-link';
    a.href = msg.link.href;
    a.download = msg.link.name;
    a.textContent = msg.link.label;
    el.append(a);
  }
}

export function createSidebar(els: SidebarEls, actions: SidebarActions): (state: PanelState) => void {
  const shown = new Map<string, string>();
  /** Rebuild a section only if `key` differs from what it was built from last. */
  const once = (name: string, key: string, build: () => void): void => {
    if (shown.get(name) === key) return;
    shown.set(name, key);
    build();
  };
  /** Disclosures the user has opened; a rebuilt section reopens them. */
  const open = new Set<string>();
  const opened = (prefix: string): string => [...open].filter((o) => o.startsWith(prefix)).join('|');
  document.addEventListener(
    'toggle',
    (ev) => {
      const d = ev.target as HTMLDetailsElement;
      const id = d.dataset?.open;
      if (!id) return;
      if (d.open) open.add(id);
      else open.delete(id);
    },
    true,
  );

  els.plateCounts.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-count]');
    if (!btn || btn.disabled) return;
    actions.setCount(btn.dataset.board!, Number(btn.dataset.count));
  });
  els.boardList.addEventListener('change', (ev) => {
    const input = ev.target as HTMLInputElement;
    if (!input.matches('input.qty')) return;
    const value = Math.max(0, Math.floor(Number(input.value) || 0));
    input.value = String(value);
    actions.setQuantity(input.dataset.board!, input.dataset.field as 'needed' | 'niceToHave', value);
  });
  els.boardAdd.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-path]');
    if (btn && !btn.disabled) actions.addBoard(btn.dataset.path!);
  });
  els.optionList.addEventListener('click', (ev) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-option]');
    if (row) actions.selectOption(row.dataset.option!);
  });
  els.optionList.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-option]');
    if (!row) return;
    ev.preventDefault();
    actions.selectOption(row.dataset.option!);
  });
  els.issueList.addEventListener('click', (ev) => {
    const c = (ev.target as HTMLElement).closest<HTMLElement>('[data-instance]');
    if (!c) return;
    // The chip sits in a <summary>: selecting an instance must not fold the row.
    ev.preventDefault();
    actions.selectInstance(c.dataset.instance!);
  });

  // The options are worked out once per change of what they depend on.
  let optionsFor = '';
  let options: Option[] = [];
  function optionsOf(state: PanelState): Option[] {
    const key = `${state.view?.revision}/${state.quoteRev}/${state.preview}`;
    if (key !== optionsFor && state.view) {
      optionsFor = key;
      options = buildOptions(state.view, state.quote, state.preview);
    }
    return options;
  }

  // --- 1: boards you need ----------------------------------------------------

  function boards(view: PanelView): void {
    const key = JSON.stringify(view.sources.map((s) => [s.key, s.name, s.stale, s.error, s.needed, s.niceToHave, s.geometry?.width, s.geometry?.height, s.geometry?.copperLayers]));
    once('boards', key, () => {
      const keys = view.sources.map((s) => s.key);
      els.boardList.innerHTML = view.sources
        .map((s) => {
          const size = s.geometry
            ? `${mm(s.geometry.width)} × ${mm(s.geometry.height)} mm · ${s.geometry.copperLayers}-layer`
            : escapeHtml(s.error ?? 'not resolved');
          const tags = [s.stale ? '<span class="tag">stale</span>' : '', s.error ? '<span class="tag">missing</span>' : ''].join(' ');
          const k = escapeHtml(s.key);
          return (
            `<div class="board" data-key="${k}" style="--board:${boardColor(keys, s.key)}">` +
            `<div class="board-head"><span class="swatch">${k}</span><span class="board-name" title="${escapeHtml(s.path)}">${escapeHtml(s.name)}</span>${tags}<span class="board-meta">${size}</span></div>` +
            `<div class="board-controls">` +
            `<label title="Assembled boards of this design that you must end up with">needed <input class="qty" type="number" min="0" step="1" value="${s.needed}" data-board="${k}" data-field="needed" /></label>` +
            `<label title="Boards of this design you would welcome if they come cheap, assembled or bare. 0 = no wish beyond needed">nice to have <input class="qty" type="number" min="0" step="1" value="${s.niceToHave}" data-board="${k}" data-field="niceToHave" /></label>` +
            `</div></div>`
          );
        })
        .join('');
    });
  }

  function addable(files: BoardFile[], view: PanelView, busy: boolean): void {
    const free = files.filter((f) => !f.onPanel);
    once('add', JSON.stringify([free.map((f) => f.path), view.sources.length, busy]), () => {
      if (free.length === 0) {
        els.boardAdd.innerHTML =
          view.sources.length === 0
            ? '<div class="hint">No board files found next to this panel. Create or open a board in the board editor first.</div>'
            : '';
        return;
      }
      els.boardAdd.innerHTML =
        `<div class="add-title">${view.sources.length === 0 ? 'Add a board to start' : 'Add a board'}</div>` +
        free
          .map(
            (f) =>
              `<button type="button" class="add-board" data-path="${escapeHtml(f.path)}" ${busy ? 'disabled' : ''} title="${escapeHtml(f.path)}">` +
              `<span class="plus">+</span>${escapeHtml(f.name)}</button>`,
          )
          .join('');
    });
  }

  // --- 2: ways to order them -------------------------------------------------

  function compositionChips(counts: PieceCount[], keys: string[], isPanel: boolean): string {
    return counts
      .filter((c) => c.total > 0)
      .map((c) => {
        const colour = boardColor(keys, c.key);
        const { populated, bare } = composition(c);
        const n = (k: number): string => (isPanel ? `${c.key} ×${k}` : c.key);
        return (
          (populated > 0 ? chip(c.key, colour, n(populated), { title: `${populated} × ${c.key} populated per panel` }) : '') +
          (bare > 0 ? chip(c.key, colour, n(bare), { bare: true, title: `${bare} × ${c.key} bare per panel` }) : '')
        );
      })
      .join('');
  }

  function orderFacts(o: Option, keys: string[], min: PanelView['minimums']): string {
    return o.orders
      .map((order) => {
        const spare = order.made - order.assembled;
        const what = compositionChips(order.counts, keys, order.panel);
        const piece = order.panel ? 'panel' : 'board';
        const least = (n: number, does: string): string =>
          ` <span class="min" title="${escapeHtml(`JLCPCB ${does} no fewer than ${n} in one order${min.verified ? '' : ' (estimate)'}. The need alone asks for fewer.`)}">min</span>`;
        // Of the pieces made, some are assembled and the rest arrive bare.
        const qty =
          order.made === 0
            ? 'not ready to order'
            : `<b>${order.made}</b> ${piece}${order.made === 1 ? '' : 's'}${order.minMade ? least(min.made, 'makes') : ''}: ` +
              (order.assembled > 0 ? `<b>${order.assembled}</b> assembled${order.minAssembled ? least(min.assembled, 'assembles') : ''}` : 'all bare') +
              (spare > 0 && order.assembled > 0 ? ` + <b>${spare}</b> bare` : '');
        return order.panel
          ? `<dt>panel</dt><dd class="sc-panel">${what}</dd><dt>order</dt><dd class="sc-qty">${qty}</dd>`
          : `<dt>order</dt><dd class="sc-qty">${what}${qty}</dd>`;
      })
      .join('');
  }

  function ways(state: PanelState, list: Option[]): void {
    const view = state.view!;
    const quote = state.quote;
    once('ways', `${optionsFor}/${state.quoteError}/${opened('ways/')}`, () => {
      const keys = view.panel.sources.map((s) => s.key);
      const min = view.minimums;
      if (view.sources.length === 0) {
        els.optionList.innerHTML = '<div class="hint">Add a board in step 1 and the ways to order it appear here.</div>';
        return;
      }
      if (state.quoteError) {
        els.optionList.innerHTML = `<div class="hint">${escapeHtml(state.quoteError)}</div>`;
        return;
      }
      if (!quote) {
        els.optionList.innerHTML = '<div class="hint">Working…</div>';
        return;
      }
      const rejected = notesBlock(
        quote.rejected.map((r) => `${r.title}: ${r.reason}`),
        'way not possible',
        'ways/rejected',
        open,
        'ways not possible',
      );
      if (list.length === 0) {
        els.optionList.innerHTML = `<div class="hint">Nothing to compare yet: no board has a needed quantity.</div>${rejected}`;
        return;
      }
      const dearest = Math.max(...list.map((o) => o.total ?? 0), 0.01);
      const rows = list
        .map((o, i) => {
          const tags = o.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('');
          const where = o.shown
            ? '<span class="where where-shown">shown</span>'
            : o.onPlate
              ? '<span class="where where-plate">on the plate</span>'
              : '';
          const inView = o.shown || (o.onPlate && !list.some((x) => x.shown));
          const does = o.onPlate
            ? 'This is the panel on the plate'
            : o.loads
              ? 'Puts this panel on the plate, in place of the one there'
              : 'Shows these orders on the plate; the panel stays as it is';
          return (
            `<div class="scenario${inView ? ' selected' : ''}" data-option="${escapeHtml(o.id)}" data-scenario="${escapeHtml(o.id)}" role="button" tabindex="0" title="${escapeHtml(`${o.meaning}\n${does}.`)}">` +
            `<span class="sc-rank">${i + 1}</span>` +
            `<div class="sc-name">${icon(o.kind)}<span>${escapeHtml(o.label)}</span>${tags}${where}</div>` +
            `<div class="sc-total">${o.total === null ? '—' : `${money(o.total)} ${flag(o.estimate)}`}</div>` +
            // The facts run the full width of the row, under the name and the total.
            `<dl class="sc-facts">${orderFacts(o, keys, min)}` +
            `<dt>you get</dt><dd class="sc-got">${o.received.map((r) => receivedMarks(r, boardColor(keys, r.key))).join('')}</dd></dl>` +
            `<div class="sc-foot">` +
            (o.total === null
              ? `<span class="sc-per">no price yet</span>`
              : `<span class="meter"><i style="width:${Math.round((o.total / dearest) * 100)}%"></i></span>` +
                `<span class="sc-per">${money(o.perBoard ?? o.total)} / board</span>`) +
            (o.notes.length > 0
              ? `<span class="sc-warn" title="${escapeHtml(o.notes.join('\n'))}">${o.notes.length} note${o.notes.length === 1 ? '' : 's'}</span>`
              : '') +
            `</div></div>`
          );
        })
        .join('');
      const anyBare = list.some((o) => o.received.some((r) => r.bare > 0));
      const anyMin = list.some((o) => o.orders.some((x) => x.minMade || x.minAssembled));
      els.optionList.innerHTML =
        `<div class="sc-legend">` +
        `<span><i class="pip pip-met"></i> assembled, needed</span><span><i class="pip pip-over"></i> assembled, extra</span>` +
        (anyBare ? `<span><b>bare</b> = delivered without parts</span>` : '') +
        (anyMin ? `<span><span class="min">min</span> = the smallest order JLCPCB takes</span>` : '') +
        `</div>` +
        `<div class="scenarios">${rows}</div>${rejected}`;
    });
  }

  // --- 3: on the plate -------------------------------------------------------

  function plate(state: PanelState, list: Option[]): void {
    const view = state.view!;
    const inView = optionInView(list);
    const showing = inView?.shown === true;
    const empty = view.panel.instances.length === 0;

    els.plateTitle.textContent = showing ? `Shown: ${inView!.label}` : inView ? `On the plate: ${inView.label}` : 'On the plate: nothing yet';
    els.plateMeaning.textContent = inView
      ? inView.meaning
      : view.sources.length === 0
        ? ''
        : 'Pick a way to order in step 2, or build a panel yourself with the counts below.';
    // What is shown for comparison is not the panel: it has nothing to edit, check or export.
    els.plateEdit.hidden = showing || view.sources.length === 0;
    els.checks.hidden = showing;
    els.arrangeBtn.disabled = state.busy || empty || showing;
    els.exportBtn.disabled = state.busy || empty || showing;
    els.exportBtn.title = showing
      ? 'What is shown is ordered board by board: export each from the board editor. Go back to your panel to export that.'
      : '';

    once('counts', JSON.stringify([view.sources.map((s) => [s.key, s.instances, s.populated, !!s.geometry]), state.busy]), () => {
      const keys = view.sources.map((s) => s.key);
      els.plateCounts.innerHTML = view.sources
        .map((s) => {
          const k = escapeHtml(s.key);
          const bare = s.instances - s.populated;
          return (
            `<span class="count-control" data-key="${k}" style="--board:${boardColor(keys, s.key)}">` +
            `<span class="swatch">${k}</span><span class="stepper">` +
            `<button type="button" data-board="${k}" data-count="${s.instances - 1}" ${s.instances === 0 ? 'disabled' : ''} aria-label="one fewer ${k}">−</button>` +
            `<output>${s.instances}</output>` +
            `<button type="button" data-board="${k}" data-count="${s.instances + 1}" ${s.geometry ? '' : 'disabled'} aria-label="one more ${k}">+</button>` +
            `</span>${bare > 0 ? `<span class="bare-n">${bare} bare</span>` : ''}</span>`
          );
        })
        .join('');
    });

    once('cost', `${optionsFor}/${inView?.id}/${opened('cost/')}`, () => {
      const keys = view.sources.map((s) => s.key);
      els.costFlag.hidden = !(inView?.estimate ?? false);
      if (!inView) {
        els.costSummary.innerHTML = '<div class="hint">Nothing to price yet.</div>';
        return;
      }
      if (inView.total === null) {
        els.costSummary.innerHTML =
          `<div class="hint">No price yet.</div>` +
          `<ul class="notes">${inView.notes.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`;
        return;
      }
      const service = showing ? undefined : view.quote.order?.assembly?.type;
      const order = inView.orders
        .map(
          (o) =>
            `<span class="qty-made">${o.made} ${o.panel ? 'panel' : 'board'}${o.made === 1 ? '' : 's'}</span>` +
            `<span class="qty-asm">${o.assembled > 0 ? `${o.assembled} assembled` : 'bare'}</span>`,
        )
        .join('<span class="qty-and">and</span>');
      els.costSummary.innerHTML =
        `<div class="total"><span id="cost-total" class="total-amount">${money(inView.total)}</span>${flag(inView.estimate)}</div>` +
        `<div class="order-line">${order}${service ? `<span class="qty-service">${service === 'economic' ? 'Economic' : 'Standard'} PCBA</span>` : ''}</div>` +
        costGroups(inView.lines, inView.total, inView.estimate, 'cost', open) +
        `<div class="received">${inView.received.map((r) => receivedMarks(r, boardColor(keys, r.key))).join('')}</div>` +
        notesBlock(inView.notes, 'note', 'cost/notes', open) +
        `<div class="legend" title="${escapeHtml(ESTIMATE_LEGEND_LONG)}">${escapeHtml(ESTIMATE_LEGEND)}</div>`;
    });
  }

  function issues(view: PanelView): void {
    once('issues', `${view.revision}/${opened('issue/')}`, () => {
      const keys = view.sources.map((s) => s.key);
      const sourceOf = new Map(view.panel.instances.map((i) => [i.id, i.source]));
      const n = (sev: string): number => view.issues.filter((i) => i.severity === sev).length;
      els.issueCount.innerHTML =
        `<span class="level level-error${n('error') === 0 ? ' level-none' : ''}">${n('error')}</span>` +
        `<span class="level level-warning${n('warning') === 0 ? ' level-none' : ''}">${n('warning')}</span>` +
        `<span class="level level-info${n('info') === 0 ? ' level-none' : ''}">${n('info')}</span>`;
      const groups = groupIssues(view.issues);
      if (groups.length === 0) {
        els.issueList.innerHTML = '<div class="hint">None.</div>';
        return;
      }
      els.issueList.innerHTML = groups
        .map((g) => {
          const id = `issue/${g.severity}/${g.code}`;
          const chips = g.instances
            .map((inst) => chip(sourceOf.get(inst) ?? '', boardColor(keys, sourceOf.get(inst) ?? ''), inst, { instance: inst, title: `Select ${inst}` }))
            .join('');
          return (
            `<details class="issue issue-${g.severity}" data-code="${escapeHtml(g.code)}" data-open="${escapeHtml(id)}"${open.has(id) ? ' open' : ''}>` +
            `<summary><span class="level level-${g.severity}" title="${LEVEL_LABEL[g.severity]}">${g.severity === 'error' ? 'E' : g.severity === 'warning' ? 'W' : 'i'}</span>` +
            `<span class="issue-title">${escapeHtml(g.title)}</span>` +
            (g.messages.length > 1 ? `<span class="issue-n">×${g.messages.length}</span>` : '') +
            `<span class="issue-chips">${chips}</span></summary>` +
            `<ul class="notes issue-text">${g.messages.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}</ul></details>`
          );
        })
        .join('');
    });
  }

  return (state: PanelState): void => {
    els.statusConn.textContent = state.connected ? 'connected' : 'disconnected — retrying';
    els.statusCursor.textContent = state.cursorMm ? `x: ${state.cursorMm.x.toFixed(2)} y: ${state.cursorMm.y.toFixed(2)} mm` : 'x: -- y: --';
    els.statusZoom.textContent = `zoom: ${state.transform.scale.toFixed(1)} px/mm`;
    renderMessage(els.arrangeMsg, state.arrangeMsg);
    renderMessage(els.exportMsg, state.exportMsg);
    renderMessage(els.boardMsg, state.boardMsg);

    const view = state.view;
    if (!view) return;
    els.panelName.textContent = view.panel.name;
    els.panelFile.textContent = view.filePath ?? 'not saved yet';
    const frame = view.geometry.frame;
    els.statusSize.textContent = frame
      ? `panel: ${mm(frame.width)} × ${mm(frame.height)} mm · ${view.layers ?? '?'}-layer · ${view.panel.settings.separation}`
      : 'panel: empty';
    const sel = view.panel.instances.find((i) => i.id === state.selection);
    els.statusSelection.textContent = sel
      ? `selected: ${sel.id} at ${mm(sel.at.x)}, ${mm(sel.at.y)} · rotation ${sel.rotation} · ${sel.populate ? 'populated' : 'bare'}${sel.pinned ? ' · pinned' : ''}`
      : '';
    els.plateEmpty.hidden = view.panel.instances.length > 0 || state.preview !== null;
    if (!els.plateEmpty.hidden) {
      els.plateEmpty.textContent =
        view.sources.length === 0
          ? 'Step 1: say which boards you need.\nPick one under "Boards you need", on the right.'
          : 'Nothing on the plate yet.\nStep 2: pick a way to order, on the right.\nOr build a panel yourself with the counts in step 3.';
    }

    const list = optionsOf(state);
    boards(view);
    addable(state.boardFiles, view, state.busy);
    ways(state, list);
    plate(state, list);
    issues(view);
  };
}
