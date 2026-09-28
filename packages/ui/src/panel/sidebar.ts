/**
 * Panel view - sidebar. Plain DOM, rebuilt section by section, and only when
 * what a section shows has changed, so typing in a field is never interrupted
 * by a view arriving from the server.
 *
 * The lists say things with shapes first and words second: a board is a
 * coloured chip, boards received are one mark each, cost is a bar. The full
 * sentence is behind a disclosure, never in the row.
 */

import type { CostLine, PanelView, PieceCount, Received, Scenario, ScenarioKind, ScenarioLine } from '@flamingo/panel';
import { boardColor } from '@flamingo/panel';
import type { BoardFile } from './api.js';
import {
  ESTIMATE_LEGEND,
  ESTIMATE_LEGEND_LONG,
  ESTIMATE_MARK,
  LEVEL_LABEL,
  SCENARIO_LABEL,
  SCENARIO_MEANING,
  composition,
  escapeHtml,
  groupCost,
  groupIssues,
  loadsOntoPanel,
  mm,
  money,
  pips,
  receivedLong,
  scenarioTags,
} from './format.js';
import type { Message, PanelState } from './store.js';

export interface SidebarEls {
  panelName: HTMLElement;
  panelFile: HTMLElement;
  boardList: HTMLElement;
  boardAdd: HTMLElement;
  boardMsg: HTMLElement;
  arrangeBtn: HTMLButtonElement;
  arrangeMsg: HTMLElement;
  costFlag: HTMLElement;
  costSummary: HTMLElement;
  scenarioList: HTMLElement;
  scenarioDetail: HTMLElement;
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
  selectScenario(id: string): void;
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

/** Boards received against needed: one mark per board, in the board's colour. */
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
    `<b>${escapeHtml(r.key)}</b><span class="got-n">${r.assembled}</span>${body}</span>`
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

function notesBlock(items: string[], label: string, id: string, open: Set<string>): string {
  if (items.length === 0) return '';
  return (
    `<details class="notes-block" data-open="${escapeHtml(id)}"${open.has(id) ? ' open' : ''}>` +
    `<summary>${items.length} ${label}${items.length === 1 ? '' : 's'}</summary>` +
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

  els.boardList.addEventListener('click', (ev) => {
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
  els.scenarioList.addEventListener('click', (ev) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-scenario]');
    if (row) actions.selectScenario(row.dataset.scenario!);
  });
  els.scenarioList.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-scenario]');
    if (!row) return;
    ev.preventDefault();
    actions.selectScenario(row.dataset.scenario!);
  });
  els.issueList.addEventListener('click', (ev) => {
    const c = (ev.target as HTMLElement).closest<HTMLElement>('[data-instance]');
    if (!c) return;
    // The chip sits in a <summary>: selecting an instance must not fold the row.
    ev.preventDefault();
    actions.selectInstance(c.dataset.instance!);
  });

  function boards(view: PanelView): void {
    const key = JSON.stringify(view.sources.map((s) => [s.key, s.name, s.stale, s.error, s.needed, s.niceToHave, s.instances, s.populated, s.geometry?.width, s.geometry?.height, s.geometry?.copperLayers]));
    once('boards', key, () => {
      const keys = view.sources.map((s) => s.key);
      els.boardList.innerHTML = view.sources
        .map((s) => {
          const size = s.geometry
            ? `${mm(s.geometry.width)} × ${mm(s.geometry.height)} mm · ${s.geometry.copperLayers}-layer`
            : escapeHtml(s.error ?? 'not resolved');
          const tags = [s.stale ? '<span class="tag">stale</span>' : '', s.error ? '<span class="tag">missing</span>' : ''].join(' ');
          const bare = s.instances - s.populated;
          const k = escapeHtml(s.key);
          return (
            `<div class="board" data-key="${k}" style="--board:${boardColor(keys, s.key)}">` +
            `<div class="board-head"><span class="swatch">${k}</span><span class="board-name" title="${escapeHtml(s.path)}">${escapeHtml(s.name)}</span>${tags}</div>` +
            `<div class="board-meta">${size}${bare > 0 ? ` · ${bare} bare` : ''}</div>` +
            `<div class="board-controls">` +
            `<label class="count-control">on panel <span class="stepper">` +
            `<button type="button" data-board="${k}" data-count="${s.instances - 1}" ${s.instances === 0 ? 'disabled' : ''} aria-label="one fewer ${k}">−</button>` +
            `<output>${s.instances}</output>` +
            `<button type="button" data-board="${k}" data-count="${s.instances + 1}" ${s.geometry ? '' : 'disabled'} aria-label="one more ${k}">+</button>` +
            `</span></label>` +
            `<label>needed <input class="qty" type="number" min="0" step="1" value="${s.needed}" data-board="${k}" data-field="needed" /></label>` +
            `<label>nice to have <input class="qty" type="number" min="0" step="1" value="${s.niceToHave}" data-board="${k}" data-field="niceToHave" /></label>` +
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

  function cost(view: PanelView): void {
    const q = view.quote;
    once('cost', JSON.stringify([q, [...open].filter((o) => o.startsWith('cost/'))]), () => {
      const keys = view.sources.map((s) => s.key);
      els.costFlag.hidden = !(q.cost?.estimate ?? false);
      if (!q.order || !q.cost) {
        els.costSummary.innerHTML =
          `<div class="hint">Not available yet.</div>` +
          `<ul class="notes">${q.problems.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`;
        return;
      }
      const asm = q.order.assembly;
      const what = q.order.piece.boards > 1 ? 'panel' : 'board';
      const order =
        `<span class="qty-made">${q.order.pcbQty} ${what}${q.order.pcbQty === 1 ? '' : 's'}</span>` +
        (asm
          ? `<span class="qty-asm">${asm.qty} assembled</span><span class="qty-service">${asm.type === 'economic' ? 'Economic' : 'Standard'} PCBA</span>`
          : '<span class="qty-asm">bare</span>');
      els.costSummary.innerHTML =
        `<div class="total"><span id="cost-total" class="total-amount">${money(q.cost.total)}</span>${flag(q.cost.estimate)}</div>` +
        `<div class="order-line">${order}</div>` +
        costGroups(q.cost.lines, q.cost.total, q.cost.estimate, 'cost', open) +
        `<div class="received">${q.received.map((r) => receivedMarks(r, boardColor(keys, r.key))).join('')}</div>` +
        notesBlock([...q.problems.map((p) => `Problem: ${p}`), ...q.notes], 'note', 'cost/notes', open) +
        `<div class="legend" title="${escapeHtml(ESTIMATE_LEGEND_LONG)}">${escapeHtml(ESTIMATE_LEGEND)}</div>`;
    });
  }

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

  function scenarios(state: PanelState): void {
    const quote = state.quote;
    const keys = state.view?.panel.sources.map((s) => s.key) ?? [];
    once(
      'scenarios',
      JSON.stringify([quote?.scenarios.map((s) => [s.id, s.total]), quote?.rejected, state.scenario, state.quoteError, keys, open.has('scenarios/rejected')]),
      () => {
        if (state.quoteError) {
          els.scenarioList.innerHTML = `<div class="hint">${escapeHtml(state.quoteError)}</div>`;
          return;
        }
        if (!quote) {
          els.scenarioList.innerHTML = '<div class="hint">Working…</div>';
          return;
        }
        const rejected = notesBlock(
          quote.rejected.map((r) => `${r.title}: ${r.reason}`),
          'way not possible',
          'scenarios/rejected',
          open,
        ).replace(/(\d+) way not possibles/, '$1 ways not possible');
        if (quote.scenarios.length === 0) {
          // With no board on the panel there is nothing that could have been possible.
          const nothingAsked = (state.view?.panel.sources.length ?? 0) === 0;
          els.scenarioList.innerHTML = `<div class="hint">Nothing to compare yet.</div>${nothingAsked ? '' : rejected}`;
          return;
        }
        const dearest = Math.max(...quote.scenarios.map((s) => s.total));
        const rows = quote.scenarios
          .map((s, i) => {
            const tags = scenarioTags(s)
              .map((t) => `<span class="tag">${escapeHtml(t)}</span>`)
              .join('');
            // What is on one piece, and how many pieces: a pair of lines per order.
            const orders = s.orders
              .map((o) => {
                const made = o.priced.order.pcbQty;
                const asm = o.priced.order.assembly?.qty ?? 0;
                const spare = made - asm;
                const what = compositionChips(o.counts, keys, o.panel);
                // Of the pieces made, some are assembled and the rest arrive bare.
                const qty =
                  `<b>${made}</b> ${o.panel ? 'panel' : 'board'}${made === 1 ? '' : 's'}<span class="sep">:</span>` +
                  (asm > 0 ? `<b>${asm}</b> assembled` : 'all bare') +
                  (spare > 0 && asm > 0 ? `<span class="sep">,</span><b>${spare}</b> bare` : '');
                return o.panel
                  ? `<dt>panel</dt><dd class="sc-panel">${what}</dd><dt>order</dt><dd class="sc-qty">${qty}</dd>`
                  : `<dt>order</dt><dd class="sc-qty">${what}${qty}</dd>`;
              })
              .join('');
            const shows = loadsOntoPanel(s) ? 'Loads this panel onto the plate' : 'Shows these orders on the plate; your panel stays as it is';
            return (
              `<div class="scenario${s.id === state.scenario ? ' selected' : ''}" data-scenario="${escapeHtml(s.id)}" role="button" tabindex="0" title="${escapeHtml(`${SCENARIO_MEANING[s.kind]}\n${shows}.`)}">` +
              `<span class="sc-rank">${i + 1}</span>` +
              `<div class="sc-main">` +
              `<div class="sc-name">${icon(s.kind)}<span>${SCENARIO_LABEL[s.kind]}</span>${tags}</div>` +
              `<dl class="sc-facts">${orders}` +
              `<dt>you get</dt><dd class="sc-got">${s.received.map((r) => receivedMarks(r, boardColor(keys, r.key))).join('')}</dd></dl>` +
              `</div>` +
              `<div class="sc-cost"><div class="sc-total">${money(s.total)}</div>` +
              `<div class="sc-per">${money(s.costPerNeededBoard)} / board ${flag(s.estimate)}</div>` +
              `<span class="meter"><i style="width:${Math.round((s.total / dearest) * 100)}%"></i></span>` +
              (s.warnings.length > 0
                ? `<div class="sc-warn" title="${escapeHtml(s.warnings.join('\n'))}">${s.warnings.length} note${s.warnings.length === 1 ? '' : 's'}</div>`
                : '') +
              `</div></div>`
            );
          })
          .join('');
        const anyBare = quote.scenarios.some((s) => s.orders.some((o) => o.counts.some((c) => c.populated > 0 && c.populated < c.total)));
        els.scenarioList.innerHTML =
          `<div class="sc-legend"><b>you get</b> = assembled boards delivered:` +
          `<span><i class="pip pip-met"></i> one you need</span><span><i class="pip pip-over"></i> one extra</span>` +
          (anyBare ? `<span><span class="chip chip-key chip-bare">S ×1</span> left bare</span>` : '') +
          `</div>` +
          `<div class="scenarios">${rows}</div>${rejected}`;
      },
    );

    const selected: Scenario | undefined = quote?.scenarios.find((s) => s.id === state.scenario);
    once('scenario-detail', JSON.stringify([selected?.id, selected?.total, state.scenarioMsg, [...open].filter((o) => o.startsWith('scenario/'))]), () => {
      if (!selected) {
        els.scenarioDetail.innerHTML = '';
        return;
      }
      els.scenarioDetail.innerHTML =
        `<div class="detail" id="scenario-lines">` +
        `<h3>${icon(selected.kind)}${SCENARIO_LABEL[selected.kind]}</h3>` +
        `<p class="meaning">${escapeHtml(SCENARIO_MEANING[selected.kind])}</p>` +
        (state.scenarioMsg ? `<div class="msg${state.scenarioMsg.problem ? ' msg-problem' : ''}">${escapeHtml(state.scenarioMsg.text)}</div>` : '') +
        costGroups(selected.lines, selected.total, selected.estimate, 'scenario', open) +
        notesBlock(selected.warnings, 'note', 'scenario/notes', open) +
        `</div>`;
    });
  }

  function issues(view: PanelView): void {
    once('issues', JSON.stringify([view.issues, view.panel.sources.map((s) => s.key), [...open].filter((o) => o.startsWith('issue/'))]), () => {
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
    els.arrangeBtn.disabled = state.busy || !state.view || state.view.panel.instances.length === 0;
    els.exportBtn.disabled = state.busy || !state.view || state.view.panel.instances.length === 0;
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
    els.plateEmpty.hidden = view.panel.instances.length > 0;
    if (!els.plateEmpty.hidden) {
      els.plateEmpty.textContent =
        view.sources.length === 0
          ? 'This panel has no boards yet.\nPick one under Boards, on the right, to start.'
          : 'The plate is empty.\nPress + next to a board to put it on the panel.';
    }

    boards(view);
    addable(state.boardFiles, view, state.busy);
    cost(view);
    scenarios(state);
    issues(view);
  };
}
