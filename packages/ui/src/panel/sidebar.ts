/**
 * Panel view - sidebar. Plain DOM, rebuilt section by section, and only when
 * what a section shows has changed, so typing in a field is never interrupted
 * by a view arriving from the server.
 */

import type { CostLine, PanelView, Scenario, ScenarioLine } from '@flamingo/panel';
import {
  ESTIMATE_LEGEND,
  ESTIMATE_MARK,
  LEVEL_LABEL,
  escapeHtml,
  issueCounts,
  mm,
  money,
  receivedLong,
  receivedShort,
  scenarioWarningCount,
} from './format.js';
import type { Message, PanelState } from './store.js';

export interface SidebarEls {
  panelName: HTMLElement;
  panelFile: HTMLElement;
  boardList: HTMLElement;
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
}

const NO_BOARDS =
  'No boards on this panel yet.\n\n' +
  'Add them over MCP:\n  panel_add_board path="board.flamingo" needed=5\n\n' +
  'or from the shell:\n  flamingo panel add-board <panel file> board.flamingo --needed 5';

function flag(estimate: boolean): string {
  return estimate ? ESTIMATE_MARK : '';
}

function linesTable(lines: Array<CostLine | ScenarioLine>, total: number, estimate: boolean): string {
  let html = '<table class="lines">';
  let order = '';
  const grouped = lines.some((l) => 'order' in l) && new Set(lines.map((l) => ('order' in l ? l.order : ''))).size > 1;
  for (const l of lines) {
    if (grouped && 'order' in l && l.order !== order) {
      order = l.order;
      html += `<tr class="group"><td colspan="3">${escapeHtml(order)}</td></tr>`;
    }
    html +=
      `<tr title="${escapeHtml(l.detail ?? '')}"><td>${escapeHtml(l.label)}</td>` +
      `<td class="amount">${money(l.amount)}</td><td class="flag">${flag(l.estimate)}</td></tr>`;
  }
  html += `<tr class="sum"><td>Total</td><td class="amount">${money(total)}</td><td class="flag">${flag(estimate)}</td></tr>`;
  return `${html}</table>`;
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
  /** Rebuild `el` only if `key` differs from what it was built from last. */
  const once = (name: string, key: string, build: () => void): void => {
    if (shown.get(name) === key) return;
    shown.set(name, key);
    build();
  };

  els.boardList.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-board]');
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
  els.scenarioList.addEventListener('click', (ev) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>('tr[data-scenario]');
    if (row) actions.selectScenario(row.dataset.scenario!);
  });

  function boards(view: PanelView): void {
    const key = JSON.stringify(view.sources.map((s) => [s.key, s.name, s.stale, s.error, s.needed, s.niceToHave, s.instances, s.populated, s.geometry?.width, s.geometry?.height, s.geometry?.copperLayers]));
    once('boards', key, () => {
      if (view.sources.length === 0) {
        els.boardList.innerHTML = `<div class="hint">${escapeHtml(NO_BOARDS)}</div>`;
        return;
      }
      els.boardList.innerHTML = view.sources
        .map((s) => {
          const size = s.geometry
            ? `${mm(s.geometry.width)} × ${mm(s.geometry.height)} mm · ${s.geometry.copperLayers}-layer · ${s.geometry.partLines} part line${s.geometry.partLines === 1 ? '' : 's'}`
            : escapeHtml(s.error ?? 'not resolved');
          const tags = [s.stale ? '<span class="tag">stale</span>' : '', s.error ? '<span class="tag">missing</span>' : ''].join(' ');
          const bare = s.instances - s.populated;
          const k = escapeHtml(s.key);
          return (
            `<div class="board" data-key="${k}">` +
            `<div class="board-head"><span class="board-key">${k}</span><span class="board-name" title="${escapeHtml(s.path)}">${escapeHtml(s.name)}</span>${tags}</div>` +
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

  function cost(view: PanelView): void {
    const q = view.quote;
    once('cost', JSON.stringify(q), () => {
      els.costFlag.hidden = !(q.cost?.estimate ?? false);
      if (!q.order || !q.cost) {
        els.costSummary.innerHTML =
          `<div class="hint">Not available.</div>` +
          `<ul class="notes">${q.problems.map((p) => `<li>— ${escapeHtml(p)}</li>`).join('')}</ul>`;
        return;
      }
      const asm = q.order.assembly;
      const what = q.order.piece.boards > 1 ? 'panel' : 'board';
      const order =
        `${q.order.pcbQty} ${what}${q.order.pcbQty === 1 ? '' : 's'}` +
        (asm ? `, ${asm.qty} assembled (${asm.type === 'economic' ? 'Economic' : 'Standard'} PCBA)` : ', bare');
      els.costSummary.innerHTML =
        `<div class="total"><span id="cost-total" class="total-amount">${money(q.cost.total)}</span><span>${flag(q.cost.estimate)}</span></div>` +
        `<div class="order-line">${escapeHtml(order)}</div>` +
        linesTable(q.cost.lines, q.cost.total, q.cost.estimate) +
        `<div class="received">${q.received.map((r) => `<div>${escapeHtml(receivedLong(r))}</div>`).join('')}</div>` +
        (q.problems.length + q.notes.length > 0
          ? `<ul class="notes">${[...q.problems.map((p) => `Problem: ${p}`), ...q.notes].map((n) => `<li>— ${escapeHtml(n)}</li>`).join('')}</ul>`
          : '') +
        `<div class="legend">${escapeHtml(ESTIMATE_LEGEND)}</div>`;
    });
  }

  function scenarios(state: PanelState): void {
    const quote = state.quote;
    once('scenarios', JSON.stringify([quote?.scenarios.map((s) => [s.id, s.total]), quote?.rejected, state.scenario, state.quoteError]), () => {
      if (state.quoteError) {
        els.scenarioList.innerHTML = `<div class="hint">${escapeHtml(state.quoteError)}</div>`;
        return;
      }
      if (!quote) {
        els.scenarioList.innerHTML = '<div class="hint">Working…</div>';
        return;
      }
      if (quote.scenarios.length === 0) {
        els.scenarioList.innerHTML =
          `<div class="hint">No scenarios.</div>` +
          `<ul class="notes">${quote.rejected.map((r) => `<li>— ${escapeHtml(r.title)}: ${escapeHtml(r.reason)}</li>`).join('')}</ul>`;
        return;
      }
      const rows = quote.scenarios
        .map((s, i) => {
          const warn = scenarioWarningCount(s);
          return (
            `<tr data-scenario="${escapeHtml(s.id)}" class="${s.id === state.scenario ? 'selected' : ''}">` +
            `<td class="num">${i + 1}</td>` +
            `<td>${escapeHtml(s.title)}<div class="scenario-sub">${escapeHtml(s.summary)}</div>` +
            `<div class="scenario-sub">got/need ${escapeHtml(receivedShort(s.received))}${warn ? ` · ${warn}` : ''}</div></td>` +
            `<td class="num">${money(s.total)}<div class="scenario-sub">${flag(s.estimate)}</div></td>` +
            `<td class="num">${money(s.costPerNeededBoard)}</td>` +
            `</tr>`
          );
        })
        .join('');
      els.scenarioList.innerHTML =
        `<table class="scenarios"><thead><tr><th class="num">#</th><th>Scenario</th><th class="num">Total</th><th class="num">Per board</th></tr></thead>` +
        `<tbody>${rows}</tbody></table>` +
        (quote.rejected.length > 0
          ? `<ul class="notes">${quote.rejected.map((r) => `<li>— Not possible: ${escapeHtml(r.title)} (${escapeHtml(r.reason)})</li>`).join('')}</ul>`
          : '');
    });

    const selected: Scenario | undefined = quote?.scenarios.find((s) => s.id === state.scenario);
    once('scenario-detail', JSON.stringify([selected?.id, selected?.total, state.scenarioMsg]), () => {
      if (!selected) {
        els.scenarioDetail.innerHTML = '';
        return;
      }
      els.scenarioDetail.innerHTML =
        `<div class="detail" id="scenario-lines">` +
        `<h3>${escapeHtml(selected.title)}</h3>` +
        `<div class="order-line">${escapeHtml(selected.summary)}</div>` +
        linesTable(selected.lines, selected.total, selected.estimate) +
        `<div class="received">${selected.received.map((r) => `<div>${escapeHtml(receivedLong(r))}</div>`).join('')}</div>` +
        (selected.warnings.length > 0
          ? `<ul class="notes">${selected.warnings.map((w) => `<li>— ${escapeHtml(w)}</li>`).join('')}</ul>`
          : '') +
        (state.scenarioMsg ? `<div class="msg${state.scenarioMsg.problem ? ' msg-problem' : ''}">${escapeHtml(state.scenarioMsg.text)}</div>` : '') +
        `</div>`;
    });
  }

  function issues(view: PanelView): void {
    once('issues', JSON.stringify(view.issues), () => {
      els.issueCount.textContent = view.issues.length > 0 ? `(${issueCounts(view.issues)})` : '';
      if (view.issues.length === 0) {
        els.issueList.innerHTML = '<div class="hint">None.</div>';
        return;
      }
      els.issueList.innerHTML = view.issues
        .map(
          (i) =>
            `<div class="issue issue-${i.severity}" data-code="${escapeHtml(i.code)}">` +
            `<span class="issue-level">${LEVEL_LABEL[i.severity]}</span>` +
            `<span class="issue-text">${escapeHtml(i.message)}</span></div>`,
        )
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
        view.sources.length === 0 ? NO_BOARDS : 'The plate is empty. Use + next to a board to put it on the panel.';
    }

    boards(view);
    cost(view);
    scenarios(state);
    issues(view);
  };
}
