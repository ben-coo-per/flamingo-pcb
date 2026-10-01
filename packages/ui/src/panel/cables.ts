/**
 * Panel view - cables. The panel's `links`: the cables between its boards,
 * each from one header to one or more others. Lists them, adds and removes
 * them (panel ops, so undo works), and runs the cable check.
 *
 * Built once into its container; each part is rebuilt only when what it shows
 * has changed, so a half-filled form survives views arriving from the server.
 */

import type { CheckFinding } from '@flamingo/engine';
import type { PanelLink, PanelOp } from '@flamingo/panel';
import { boardColor } from '@flamingo/panel';
import { findingSummary, renderFindingRow } from '../checks/finding-row.js';
import type { ApiError, BoardHeaders } from './api.js';
import { cablesApi, isError } from './api.js';
import { aliasesText, buildLink, describeLink } from './cables-form.js';
import type { CableForm } from './cables-form.js';
import { escapeHtml } from './format.js';
import type { PanelState } from './store.js';

export interface CablesDeps {
  op(op: PanelOp): Promise<{ ok: true } | ApiError>;
}

interface Sources {
  keys: string[];
  names: Record<string, string>;
}

const linksSig = (links: PanelLink[] | undefined): string => JSON.stringify(links ?? []);

export function createCables(root: HTMLElement, deps: CablesDeps): (state: PanelState) => void {
  root.innerHTML =
    '<h3>Cables <span class="count" data-el="count"></span></h3>' +
    '<p class="meaning">Ribbons and leads between the boards. Checking them compares the nets at both ends, pin by pin.</p>' +
    '<div class="cable-list" data-el="list"></div>' +
    '<details class="cable-add" data-el="add"><summary>Add cable</summary>' +
    '<form class="cable-form" data-el="form" novalidate>' +
    '<div class="cable-field"><span class="cable-label">from</span><span class="cable-end" data-end="from"></span></div>' +
    '<div class="cable-field cable-tos"><span class="cable-label">to</span><div data-el="tos"></div></div>' +
    '<div class="cable-field"><span class="cable-label"></span><button type="button" class="tag tag-btn" data-act="add-to">+ another end</button></div>' +
    '<fieldset class="cable-field cable-map"><legend class="cable-label">pins</legend>' +
    '<label><input type="radio" name="cable-map" value="straight" checked> straight (1 to 1, 2 to 2 …)</label>' +
    '<label><input type="radio" name="cable-map" value="custom"> custom</label>' +
    '<textarea data-el="pinmap" rows="3" placeholder="1 = 3, 2 = 4" hidden></textarea></fieldset>' +
    '<label class="cable-field"><span class="cable-label">aliases</span>' +
    '<input type="text" data-el="aliases" placeholder="M_EN = MOTION_EN" spellcheck="false"></label>' +
    '<label class="cable-field"><span class="cable-label">note</span>' +
    '<input type="text" data-el="note" placeholder="14-way ribbon, 0.5 m"></label>' +
    '<button type="submit" class="btn">Add cable</button>' +
    '<div class="msg msg-problem" data-el="formmsg" hidden></div>' +
    '</form></details>' +
    '<button type="button" class="btn cable-check" data-act="check">Check cables</button>' +
    '<div class="msg" data-el="checkmsg" hidden></div>' +
    '<div class="cable-findings" data-el="findings"></div>';

  const el = <T extends HTMLElement = HTMLElement>(name: string): T => root.querySelector<T>(`[data-el="${name}"]`)!;
  const countEl = el('count');
  const listEl = el('list');
  const formEl = el<HTMLFormElement>('form');
  const tosEl = el('tos');
  const pinMapEl = el<HTMLTextAreaElement>('pinmap');
  const aliasesEl = el<HTMLInputElement>('aliases');
  const noteEl = el<HTMLInputElement>('note');
  const formMsg = el('formmsg');
  const checkMsg = el('checkmsg');
  const findingsEl = el('findings');
  const checkBtn = root.querySelector<HTMLButtonElement>('[data-act="check"]')!;

  let sources: Sources = { keys: [], names: {} };
  let headers: Record<string, BoardHeaders> = {};
  let lastLinks = '';
  let lastSources = '';
  let checkedLinks: string | null = null; // links signature the shown findings are for
  let busy = false;

  function say(target: HTMLElement, text: string | null): void {
    target.hidden = !text;
    target.textContent = text ?? '';
  }

  // ---- an end: board select + header field -----------------------------------

  function boardOptions(selected: string): string {
    return sources.keys
      .map((k) => `<option value="${escapeHtml(k)}"${k === selected ? ' selected' : ''}>${escapeHtml(k)} · ${escapeHtml(sources.names[k] ?? '')}</option>`)
      .join('');
  }

  function headerOptions(key: string): string {
    const h = headers[key];
    if (!h) return '';
    return h.headers
      .map((x) => `<option value="${escapeHtml(x.refdes)}">${escapeHtml(`${x.pads} pads${x.value ? ` · ${x.value}` : ''}`)}</option>`)
      .join('');
  }

  /** One cable end. Each header field has its own datalist, for its board. */
  function endHtml(id: string, key: string, refdes: string, removable: boolean): string {
    return (
      `<span class="cable-end-row" data-end-id="${id}">` +
      `<select data-part="board" aria-label="board">${boardOptions(key)}</select>` +
      `<input type="text" data-part="refdes" list="dl-${id}" value="${escapeHtml(refdes)}" placeholder="J1" size="6" spellcheck="false" aria-label="header refdes">` +
      `<datalist id="dl-${id}">${headerOptions(key)}</datalist>` +
      (removable ? '<button type="button" class="tag tag-btn" data-act="remove-to" title="Remove this end">×</button>' : '') +
      '</span>'
    );
  }

  let endSeq = 0;
  function readEnd(row: Element): string {
    const key = row.querySelector<HTMLSelectElement>('[data-part="board"]')!.value;
    const refdes = row.querySelector<HTMLInputElement>('[data-part="refdes"]')!.value.trim();
    return key && refdes ? `${key}:${refdes}` : '';
  }

  function firstHeader(key: string): string {
    return headers[key]?.headers[0]?.refdes ?? '';
  }

  function resetEnds(): void {
    const [a, b] = [sources.keys[0] ?? '', sources.keys[1] ?? sources.keys[0] ?? ''];
    root.querySelector('[data-end="from"]')!.innerHTML = endHtml(`e${endSeq++}`, a, firstHeader(a), false);
    tosEl.innerHTML = endHtml(`e${endSeq++}`, b, firstHeader(b), false);
  }

  /** Keep what was picked, with the board lists and header suggestions brought up to date. */
  function refreshEnds(): void {
    for (const row of Array.from(root.querySelectorAll('.cable-end-row'))) {
      const sel = row.querySelector<HTMLSelectElement>('[data-part="board"]')!;
      const key = sources.keys.includes(sel.value) ? sel.value : (sources.keys[0] ?? '');
      sel.innerHTML = boardOptions(key);
      row.querySelector('datalist')!.innerHTML = headerOptions(key);
    }
  }

  root.addEventListener('change', (ev) => {
    const t = ev.target as HTMLElement;
    if (t.matches('[data-part="board"]')) {
      const row = t.closest('.cable-end-row')!;
      const key = (t as HTMLSelectElement).value;
      row.querySelector('datalist')!.innerHTML = headerOptions(key);
      const input = row.querySelector<HTMLInputElement>('[data-part="refdes"]')!;
      // A refdes the new board does not have is replaced by its first header.
      if (!headers[key]?.headers.some((h) => h.refdes === input.value.trim())) input.value = firstHeader(key);
    }
    if (t.matches('input[name="cable-map"]')) pinMapEl.hidden = (t as HTMLInputElement).value !== 'custom';
  });

  root.addEventListener('click', (ev) => {
    const act = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'add-to') {
      const used = new Set(Array.from(root.querySelectorAll('.cable-end-row')).map((r) => r.querySelector<HTMLSelectElement>('select')!.value));
      const key = sources.keys.find((k) => !used.has(k)) ?? sources.keys[0] ?? '';
      tosEl.insertAdjacentHTML('beforeend', endHtml(`e${endSeq++}`, key, firstHeader(key), true));
    } else if (act === 'remove-to') {
      (ev.target as HTMLElement).closest('.cable-end-row')!.remove();
    } else if (act === 'remove-link') {
      const id = (ev.target as HTMLElement).closest<HTMLElement>('[data-link]')!.dataset.link!;
      void (async () => {
        const r = await deps.op({ op: 'removeLink', id });
        if (isError(r)) say(checkMsg, `Could not remove ${id}: ${r.error}`);
      })();
    } else if (act === 'check') {
      void check();
    }
  });

  formEl.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const form: CableForm = {
      from: readEnd(root.querySelector('[data-end="from"] .cable-end-row')!),
      to: Array.from(tosEl.querySelectorAll('.cable-end-row')).map(readEnd),
      straight: root.querySelector<HTMLInputElement>('input[name="cable-map"]:checked')!.value === 'straight',
      pinMap: pinMapEl.value,
      aliases: aliasesEl.value,
      note: noteEl.value,
    };
    const built = buildLink(form, new Set(sources.keys));
    if (!built.ok) {
      say(formMsg, built.error);
      return;
    }
    say(formMsg, null);
    void (async () => {
      const r = await deps.op({ op: 'addLink', link: built.value });
      if (isError(r)) {
        say(formMsg, r.error);
        return;
      }
      aliasesEl.value = '';
      noteEl.value = '';
      pinMapEl.value = '';
      el<HTMLDetailsElement>('add').open = false;
    })();
  });

  // ---- check -----------------------------------------------------------------

  async function check(): Promise<void> {
    if (busy) return;
    busy = true;
    checkBtn.disabled = true;
    checkBtn.textContent = 'Checking…';
    try {
      const r = await cablesApi.check();
      if (isError(r)) {
        say(checkMsg, `Check failed: ${r.error}`);
        checkMsg.classList.add('msg-problem');
        return;
      }
      checkedLinks = lastLinks;
      showFindings(r.findings);
    } finally {
      busy = false;
      checkBtn.disabled = false;
      checkBtn.textContent = 'Check cables';
    }
  }

  function showFindings(findings: CheckFinding[]): void {
    const shown = findings.filter((f) => f.level !== 'info');
    const errors = shown.some((f) => f.level === 'error');
    checkMsg.classList.toggle('msg-problem', errors);
    say(checkMsg, shown.length === 0 ? 'Every pin agrees at both ends.' : `${findingSummary(shown)}.`);
    findingsEl.replaceChildren(...shown.map((f) => renderFindingRow(f, { hideCheck: true })));
  }

  // ---- render ----------------------------------------------------------------

  function renderList(links: PanelLink[]): void {
    countEl.textContent = links.length > 0 ? String(links.length) : '';
    if (links.length === 0) {
      listEl.innerHTML = '<div class="hint">None yet.</div>';
      return;
    }
    const chip = (ep: string): string => {
      const key = ep.split(':')[0] ?? '';
      return `<span class="chip" style="--board:${boardColor(sources.keys, key)}">${escapeHtml(ep)}</span>`;
    };
    listEl.innerHTML = links
      .map((l) => {
        const extra = [
          l.aliases && Object.keys(l.aliases).length > 0 ? `aliases ${aliasesText(l.aliases)}` : '',
          l.note ?? '',
        ].filter(Boolean);
        return (
          `<div class="cable" data-link="${escapeHtml(l.id)}" title="${escapeHtml(describeLink(l))}">` +
          `<span class="cable-id">${escapeHtml(l.id)}</span>` +
          `<span class="cable-ends">${chip(l.from)}<span class="cable-arrow">→</span>${l.to.map(chip).join(' ')}</span>` +
          `<span class="cable-how">${l.map === 'straight' ? 'straight' : `${Object.keys(l.map).length} mapped`}</span>` +
          '<button type="button" class="tag tag-btn" data-act="remove-link" title="Remove this cable">remove</button>' +
          (extra.length > 0 ? `<div class="cable-extra">${extra.map(escapeHtml).join(' · ')}</div>` : '') +
          '</div>'
        );
      })
      .join('');
  }

  async function loadHeaders(): Promise<void> {
    const r = await cablesApi.headers();
    if (isError(r)) return;
    headers = Object.fromEntries(r.boards.map((b) => [b.key, b]));
    if (!root.querySelector('.cable-end-row')) resetEnds();
    else refreshEnds();
  }

  return (state: PanelState): void => {
    const view = state.view;
    if (!view) return;
    const srcSig = JSON.stringify(view.sources.map((s) => [s.key, s.name, s.path, s.stale]));
    if (srcSig !== lastSources) {
      lastSources = srcSig;
      sources = { keys: view.sources.map((s) => s.key), names: Object.fromEntries(view.sources.map((s) => [s.key, s.name])) };
      root.querySelector<HTMLElement>('.cable-add')!.hidden = sources.keys.length === 0;
      void loadHeaders();
    }
    const sig = linksSig(view.panel.links);
    if (sig !== lastLinks) {
      lastLinks = sig;
      renderList(view.panel.links ?? []);
      checkBtn.disabled = (view.panel.links ?? []).length === 0;
      if (checkedLinks !== null && checkedLinks !== sig) {
        // The findings shown are for cables that have since changed.
        checkMsg.classList.remove('msg-problem');
        say(checkMsg, 'The cables changed since this check. Check again.');
        findingsEl.replaceChildren();
        checkedLinks = null;
      }
    }
  };
}
