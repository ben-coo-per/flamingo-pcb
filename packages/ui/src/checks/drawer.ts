/**
 * Flamingo UI - the Checks workspace: a drawer docked over the right panel.
 *
 * Three tabs. Findings runs the registered board checks one at a time (so a
 * slow DRC never hides a fast ERC), lists what they found with filters and
 * grouping, puts a ring on the canvas for every located finding, and waives a
 * finding (or removes a waiver) through the undoable waiver ops. Simulation
 * runs the logic specs and SPICE configs next to the board file. Printout
 * downloads the 1:1 PDF.
 *
 * DOM only: what to show is decided by checks/model.ts; requests go through
 * checks/api.ts. Design: docs/superpowers/specs/2026-10-01-checks-ui-design.md.
 */

import './checks.css';
import type { Board, Point } from '@flamingo/engine';
import { store } from '../state.js';
import * as api from './api.js';
import {
  LEVELS,
  boardSig,
  buildMarkers,
  collect,
  countLevels,
  defaultFilter,
  defaultSelection,
  emptyModel,
  filterFindings,
  findingKey,
  groupFindings,
  isStale,
  lastRun,
  locate,
  runText,
  summarize,
  timeText,
  waiverFor,
  waiverIndex,
  type ChecksModel,
  type FindingFilter,
  type GroupMode,
  type Summary,
} from './model.js';
import type { CheckFinding, CheckLevel, Paper, SimRunResult, SimSpecsResponse, WaivedFinding } from './types.js';

export type ChecksTab = 'findings' | 'simulation' | 'printout';

export interface ChecksDrawerDeps {
  /** Centre the canvas on a board point. */
  focusPoint(p: Point): void;
  /** Called whenever the one-line summary changes (the right panel shows it). */
  onSummary(summary: Summary): void;
  /** Save a downloaded file (panels.ts downloadBlob). */
  download(blob: Blob, disposition: string, fallbackName: string): void;
}

export interface ChecksDrawer {
  open(tab?: ChecksTab): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  /** Open on Findings and run the default checks (the export gate's "Show in Checks"). */
  showFindings(): void;
}

const LEVEL_LABEL: Record<CheckLevel, string> = { error: 'error', warn: 'warn', info: 'info' };

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', className, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function badge(level: CheckLevel): HTMLElement {
  return el('span', `chk-badge chk-badge-${level}`, LEVEL_LABEL[level]);
}

export function createChecksDrawer(deps: ChecksDrawerDeps): ChecksDrawer {
  // ---- state ----
  let model: ChecksModel = emptyModel();
  let selected = new Set<string>();
  let loaded = false;
  let loadError = '';
  const filter: FindingFilter = defaultFilter();
  let groupMode: GroupMode = 'check';
  let tab: ChecksTab = 'findings';
  let openFlag = false;
  let focusKey: string | null = null;
  /** The finding whose waive form is open, and its draft. */
  let waiveDraft: { key: string; items: string[]; reason: string; error: string; busy: boolean } | null = null;
  let waivedOpen = false;
  let paper: Paper = 'a4';
  let sim: SimSpecsResponse | null = null;
  let simError = '';
  const simRuns = new Map<string, { busy: boolean; result?: SimRunResult; error?: string }>();
  let lastSummary = '';

  const board = (): Board | null => store.get().board;

  // ---- skeleton ----
  const root = el('aside', 'chk-drawer');
  root.id = 'checks-drawer';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Checks');

  const head = el('div', 'chk-head');
  const titleRow = el('div', 'chk-title-row');
  const title = el('div', 'chk-title', 'Checks');
  const closeBtn = button('chk-close', '×', () => close());
  closeBtn.title = 'Close (Esc)';
  closeBtn.setAttribute('aria-label', 'Close checks');
  titleRow.append(title, closeBtn);
  const meta = el('div', 'chk-meta');
  const staleNote = el('div', 'chk-stale', 'Board changed since this run.');
  staleNote.hidden = true;
  head.append(titleRow, meta, staleNote);

  const tabs = el('div', 'chk-tabs');
  tabs.setAttribute('role', 'tablist');
  const tabBtns: Record<ChecksTab, HTMLButtonElement> = {
    findings: button('chk-tab', 'Findings', () => setTab('findings')),
    simulation: button('chk-tab', 'Simulation', () => setTab('simulation')),
    printout: button('chk-tab', 'Printout', () => setTab('printout')),
  };
  const panes: Record<ChecksTab, HTMLElement> = {
    findings: el('div', 'chk-pane'),
    simulation: el('div', 'chk-pane'),
    printout: el('div', 'chk-pane'),
  };
  for (const t of Object.keys(tabBtns) as ChecksTab[]) {
    const b = tabBtns[t];
    b.setAttribute('role', 'tab');
    b.id = `chk-tab-${t}`;
    panes[t].setAttribute('role', 'tabpanel');
    panes[t].setAttribute('aria-labelledby', b.id);
    tabs.appendChild(b);
  }
  // Arrow keys move between tabs (WAI-ARIA tabs pattern).
  tabs.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
    const order: ChecksTab[] = ['findings', 'simulation', 'printout'];
    const i = order.indexOf(tab);
    const next = order[(i + (ev.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length]!;
    setTab(next);
    tabBtns[next].focus();
    ev.preventDefault();
  });

  const body = el('div', 'chk-body');
  body.append(panes.findings, panes.simulation, panes.printout);
  root.append(head, tabs, body);
  document.body.appendChild(root);

  // Esc inside the drawer: cancel an open waive form first, else close. Stop
  // it here so the editor's own Esc (back to the select tool) doesn't also fire.
  root.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    ev.stopPropagation();
    if (waiveDraft) {
      waiveDraft = null;
      renderFindings();
    } else {
      close();
    }
  });

  // ---- Findings pane: fixed controls, then the list (re-rendered) ----
  const chipRow = el('div', 'chk-chips');
  const actionRow = el('div', 'chk-actions');
  const runBtn = button('chk-btn chk-btn-primary', 'Run selected', () => void runSelected());
  const clearBtn = button('chk-btn', 'Clear markers', () => {
    store.set({ checkMarkers: [], checkMarkerFocus: null });
    focusKey = null;
  });
  actionRow.append(runBtn, clearBtn);

  const filterRow = el('div', 'chk-filters');
  const levelBtns = {} as Record<CheckLevel, HTMLButtonElement>;
  const levelGroup = el('div', 'chk-seg');
  levelGroup.setAttribute('role', 'group');
  levelGroup.setAttribute('aria-label', 'Show levels');
  for (const level of LEVELS) {
    const b = button(`chk-seg-btn chk-level-${level}`, level, () => {
      const set = filter.levels as Set<CheckLevel>;
      if (set.has(level)) set.delete(level);
      else set.add(level);
      renderFindings();
    });
    levelBtns[level] = b;
    levelGroup.appendChild(b);
  }
  const search = el('input', 'chk-search');
  search.type = 'search';
  search.placeholder = 'Filter message, rule, items';
  search.setAttribute('aria-label', 'Filter findings');
  search.addEventListener('input', () => {
    filter.text = search.value;
    renderFindings();
  });
  const groupSeg = el('div', 'chk-seg');
  groupSeg.setAttribute('role', 'group');
  groupSeg.setAttribute('aria-label', 'Group by');
  const groupBtns: Record<GroupMode, HTMLButtonElement> = {
    check: button('chk-seg-btn', 'by rule', () => setGroup('check')),
    severity: button('chk-seg-btn', 'by level', () => setGroup('severity')),
  };
  groupSeg.append(groupBtns.check, groupBtns.severity);
  filterRow.append(levelGroup, groupSeg, search);

  const list = el('div', 'chk-list');
  panes.findings.append(chipRow, actionRow, filterRow, list);

  function setGroup(m: GroupMode): void {
    groupMode = m;
    renderFindings();
  }

  // ---- data loading ----
  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    try {
      const checks = await api.listChecks();
      model = emptyModel(checks);
      selected = defaultSelection(checks);
      loaded = true;
      loadError = '';
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    }
    renderChips();
    renderFindings();
  }

  async function runOne(name: string): Promise<void> {
    model.runs[name] = { status: 'running' };
    renderChips();
    publish();
    const sig = boardSig(board());
    try {
      const result = await api.runCheck(name);
      model.runs[name] = { status: 'done', result, at: Date.now(), sig };
    } catch (err) {
      model.runs[name] = { status: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
    afterRun();
  }

  let running = false;
  async function runSelected(names?: string[]): Promise<void> {
    if (running) return;
    await ensureLoaded();
    const todo = names ?? model.checks.map((c) => c.name).filter((n) => selected.has(n));
    if (todo.length === 0) return;
    running = true;
    runBtn.disabled = true;
    try {
      for (const name of todo) await runOne(name);
    } finally {
      running = false;
      runBtn.disabled = false;
    }
  }

  function afterRun(): void {
    const { findings } = collect(model);
    store.set({ checkMarkers: buildMarkers(findings, board()) });
    renderChips();
    renderFindings();
    renderHead();
    publish();
  }

  function publish(): void {
    const s = summarize(model, board());
    const key = `${s.kind}|${s.text}`;
    if (key !== lastSummary) {
      lastSummary = key;
      deps.onSummary(s);
    }
  }

  // ---- render: header ----
  function renderHead(): void {
    const b = board();
    const last = lastRun(model);
    const parts = [b?.name || 'untitled'];
    if (last) parts.push(`sha256 ${last.sha.slice(0, 12)}`, `run ${timeText(last.at)}`);
    else parts.push('not run yet');
    meta.textContent = parts.join(' · ');
    staleNote.hidden = !isStale(model, b);
  }

  // ---- render: check chips ----
  function renderChips(): void {
    chipRow.replaceChildren();
    if (loadError) {
      chipRow.appendChild(el('div', 'chk-error', `Could not load the checks: ${loadError}`));
      return;
    }
    if (!loaded) {
      chipRow.appendChild(el('div', 'chk-muted', 'Loading checks…'));
      return;
    }
    for (const c of model.checks) {
      const run = model.runs[c.name];
      const chip = el('label', `chk-chip chk-chip-${run?.status ?? 'idle'}`);
      chip.title = c.description + (c.network ? ' (needs the network)' : '');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = selected.has(c.name);
      box.addEventListener('change', () => {
        if (box.checked) selected.add(c.name);
        else selected.delete(c.name);
      });
      const name = el('span', 'chk-chip-name', c.name.toUpperCase());
      const state = el('span', 'chk-chip-state', runText(run));
      if (run?.status === 'done') {
        const n = countLevels(run.result.findings);
        state.classList.add(n.error > 0 ? 'err' : n.warn > 0 ? 'warn' : 'ok');
      } else if (run?.status === 'failed') state.classList.add('err');
      chip.append(box, name);
      if (c.network) chip.appendChild(el('span', 'chk-chip-net', 'network'));
      if (run?.status === 'running') chip.appendChild(el('span', 'chk-spinner'));
      chip.appendChild(state);
      chipRow.appendChild(chip);
    }
  }

  // ---- render: findings list ----
  function renderFindings(): void {
    const { findings, waived } = collect(model);
    const counts = countLevels(findings);
    for (const level of LEVELS) {
      const on = filter.levels.has(level);
      levelBtns[level].classList.toggle('active', on);
      levelBtns[level].setAttribute('aria-pressed', String(on));
      levelBtns[level].textContent = `${level} ${counts[level]}`;
    }
    for (const m of Object.keys(groupBtns) as GroupMode[]) {
      groupBtns[m].classList.toggle('active', m === groupMode);
      groupBtns[m].setAttribute('aria-pressed', String(m === groupMode));
    }

    list.replaceChildren();
    const anyDone = Object.values(model.runs).some((r) => r.status === 'done');
    if (!anyDone) {
      list.appendChild(
        el('div', 'chk-empty', loaded ? 'Run the checks to see what they find.' : ''),
      );
      return;
    }
    const shown = filterFindings(findings, filter);
    const groups = groupFindings(
      shown,
      groupMode,
      model.checks.map((c) => c.name),
    );
    if (shown.length === 0) {
      const hidden = findings.length;
      list.appendChild(
        el(
          'div',
          'chk-empty',
          hidden === 0 ? 'Nothing found. The checks that ran are clean.' : `Nothing matches the filters (${hidden} hidden).`,
        ),
      );
    }
    for (const g of groups) {
      const sec = el('section', 'chk-group');
      const gh = el('div', 'chk-group-head');
      gh.append(badge(g.level), el('span', 'chk-group-title', g.title), el('span', 'chk-group-count', String(g.findings.length)));
      sec.appendChild(gh);
      for (const f of g.findings) sec.appendChild(findingRow(f, groupMode === 'severity'));
      list.appendChild(sec);
    }
    // Waived findings follow the text filter (not the level toggles: a waived
    // finding is listed for its waiver, whatever its level).
    const waivedShown = filterFindings(
      waived.map((w) => w.finding),
      { levels: new Set(LEVELS), text: filter.text },
    );
    const keep = new Set(waivedShown);
    const waivedList = waived.filter((w) => keep.has(w.finding));
    if (waivedList.length > 0) list.appendChild(waivedSection(waivedList));
  }

  function findingRow(f: CheckFinding, showRule: boolean): HTMLElement {
    const key = findingKey(f);
    const row = el('div', `chk-row chk-row-${f.level}`);
    row.tabIndex = 0;
    row.dataset.key = key;
    if (key === focusKey) row.classList.add('selected');
    const line = el('div', 'chk-row-line');
    line.appendChild(badge(f.level));
    if (showRule) line.appendChild(el('span', 'chk-row-rule', `${f.check}/${f.rule}`));
    line.appendChild(el('span', 'chk-row-msg', f.message));
    const waiveBtn = button('chk-link', 'Waive…', () => {
      waiveDraft = { key, items: [...f.items], reason: '', error: '', busy: false };
      renderFindings();
      list.querySelector<HTMLTextAreaElement>(`.chk-waive textarea`)?.focus();
    });
    waiveBtn.addEventListener('click', (ev) => ev.stopPropagation());
    line.appendChild(waiveBtn);
    row.appendChild(line);
    if (f.items.length > 0) {
      const items = el('div', 'chk-items');
      for (const it of f.items) items.appendChild(el('span', 'chk-item', it));
      row.appendChild(items);
    }
    const at = locate(f, board());
    if (!at) row.classList.add('no-loc');
    row.title = at ? 'Show on the board' : 'No location on the board';

    const activate = (): void => {
      focusKey = key;
      store.set({ checkMarkerFocus: key });
      Array.from(list.querySelectorAll('.chk-row.selected')).forEach((r) => r.classList.remove('selected'));
      row.classList.add('selected');
      if (!at) return;
      // Full width (narrow screens) hides the canvas: step aside to show it.
      if (window.matchMedia('(max-width: 900px)').matches) close();
      deps.focusPoint(at);
    };
    row.addEventListener('click', activate);
    row.addEventListener('keydown', (ev) => {
      if (ev.target !== row) return;
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        activate();
      } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        const rows = Array.from(list.querySelectorAll<HTMLElement>('.chk-row'));
        const i = rows.indexOf(row);
        rows[i + (ev.key === 'ArrowDown' ? 1 : -1)]?.focus();
      }
    });
    row.addEventListener('mouseenter', () => store.set({ checkMarkerFocus: key }));
    row.addEventListener('mouseleave', () => store.set({ checkMarkerFocus: focusKey }));

    if (waiveDraft?.key === key) row.appendChild(waiveForm(f));
    return row;
  }

  function waiveForm(f: CheckFinding): HTMLElement {
    const d = waiveDraft!;
    const form = el('form', 'chk-waive');
    form.addEventListener('click', (ev) => ev.stopPropagation());
    form.appendChild(el('div', 'chk-waive-title', `Waive ${f.check}/${f.rule}`));
    const reasonLabel = el('label', 'chk-waive-label', 'Reason (required)');
    const reason = el('textarea');
    reason.rows = 2;
    reason.value = d.reason;
    reason.placeholder = 'Why this is fine, e.g. "MISO left open on purpose"';
    reason.addEventListener('input', () => {
      d.reason = reason.value;
      save.disabled = d.busy || !waiverFor(f, d.items, d.reason);
    });
    reasonLabel.appendChild(reason);
    form.appendChild(reasonLabel);

    if (f.items.length > 0) {
      form.appendChild(el('div', 'chk-waive-label', 'Matches findings naming all of'));
      const items = el('div', 'chk-items');
      for (const it of f.items) {
        const on = d.items.includes(it);
        const chip = button(`chk-item chk-item-toggle${on ? '' : ' off'}`, it, () => {
          d.items = on ? d.items.filter((x) => x !== it) : f.items.filter((x) => x === it || d.items.includes(x));
          renderFindings();
        });
        chip.setAttribute('aria-pressed', String(on));
        chip.title = on ? 'Click to leave this item out' : 'Click to match this item too';
        items.appendChild(chip);
      }
      form.appendChild(items);
      if (d.items.length === 0) form.appendChild(el('div', 'chk-error', 'Keep at least one item.'));
    }
    if (d.error) form.appendChild(el('div', 'chk-error', d.error));
    const row = el('div', 'chk-waive-actions');
    const save = el('button', 'chk-btn chk-btn-primary', d.busy ? 'Saving…' : 'Waive');
    save.type = 'submit';
    save.disabled = d.busy || !waiverFor(f, d.items, d.reason);
    const cancel = button('chk-btn', 'Cancel', () => {
      waiveDraft = null;
      renderFindings();
    });
    row.append(save, cancel);
    form.appendChild(row);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const waiver = waiverFor(f, d.items, d.reason);
      if (!waiver || d.busy) return;
      d.busy = true;
      d.error = '';
      renderFindings();
      void (async () => {
        try {
          await api.postWaiverOp({ op: 'addCheckWaiver', waiver });
          waiveDraft = null;
          await runSelected([f.check]);
        } catch (err) {
          d.busy = false;
          d.error = `Could not save the waiver: ${err instanceof Error ? err.message : String(err)}`;
          renderFindings();
        }
      })();
    });
    return form;
  }

  function waivedSection(waived: WaivedFinding[]): HTMLElement {
    const det = el('details', 'chk-waived');
    det.open = waivedOpen;
    det.addEventListener('toggle', () => {
      waivedOpen = det.open;
    });
    det.appendChild(el('summary', 'chk-waived-head', `Waived (${waived.length})`));
    for (const w of waived) {
      const row = el('div', 'chk-row chk-row-waived');
      const line = el('div', 'chk-row-line');
      line.append(
        badge(w.finding.level),
        el('span', 'chk-row-rule', `${w.finding.check}/${w.finding.rule}`),
        el('span', 'chk-row-msg', w.finding.message),
      );
      const remove = button('chk-link', 'Remove waiver', () => {
        const index = waiverIndex(board(), w.waiver);
        if (index < 0) {
          // Someone else already removed it: re-run to catch up.
          void runSelected([w.finding.check]);
          return;
        }
        remove.disabled = true;
        void (async () => {
          try {
            await api.postWaiverOp({ op: 'removeCheckWaiver', index });
            await runSelected([w.finding.check]);
          } catch (err) {
            remove.disabled = false;
            remove.textContent = `Failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        })();
      });
      line.appendChild(remove);
      row.appendChild(line);
      row.appendChild(el('div', 'chk-reason', `“${w.waiver.reason}”`));
      det.appendChild(row);
    }
    return det;
  }

  // ---- Simulation pane ----
  async function loadSim(): Promise<void> {
    simError = '';
    renderSim();
    try {
      sim = await api.listSimSpecs();
    } catch (err) {
      simError = err instanceof Error ? err.message : String(err);
    }
    renderSim();
  }

  function renderSim(): void {
    const p = panes.simulation;
    p.replaceChildren();
    const top = el('div', 'chk-actions');
    top.appendChild(button('chk-btn', 'Refresh', () => void loadSim()));
    p.appendChild(top);
    if (simError) {
      p.appendChild(el('div', 'chk-error', `Could not list specs: ${simError}`));
      return;
    }
    if (!sim) {
      p.appendChild(el('div', 'chk-muted', 'Loading…'));
      return;
    }
    const spice = sim.spice;
    p.appendChild(
      el(
        'div',
        spice.available ? 'chk-muted' : 'chk-note',
        spice.available
          ? `SPICE runs with ${spice.backend === 'docker' ? 'ngspice in Docker' : 'the local ngspice'}.`
          : `SPICE is unavailable: ${spice.reason ?? 'neither ngspice nor Docker was found'}. Logic specs still run.`,
      ),
    );

    p.appendChild(el('div', 'chk-subtitle', 'Spec files next to the board'));
    if (sim.specs.length === 0) {
      p.appendChild(
        el('div', 'chk-empty', 'No logic specs or SPICE configs (*.json) in the board’s folder.'),
      );
    }
    for (const spec of sim.specs) {
      const card = el('div', 'chk-spec');
      const line = el('div', 'chk-row-line');
      line.append(el('span', `chk-kind chk-kind-${spec.kind}`, spec.kind), el('span', 'chk-spec-name', spec.name));
      const state = simRuns.get(spec.path);
      const disabled = (spec.kind === 'spice' && !spice.available) || state?.busy === true;
      const run = button('chk-btn chk-btn-primary', state?.busy ? 'Running…' : 'Run', () => void runSpec(spec.path));
      run.disabled = disabled;
      line.appendChild(run);
      card.appendChild(line);
      if (spec.description) card.appendChild(el('div', 'chk-muted', spec.description));
      if (state?.error) card.appendChild(el('div', 'chk-error', state.error));
      if (state?.result) card.appendChild(simResult(state.result));
      p.appendChild(card);
    }

    p.appendChild(el('div', 'chk-subtitle', 'SPICE templates'));
    const tl = el('dl', 'chk-templates');
    for (const t of sim.templates) {
      const dd = el('dd', '', t.description);
      if (t.config) {
        const cfg = el('div', 'chk-template-cfg');
        cfg.append('config: ', el('code', '', t.config));
        dd.appendChild(cfg);
      }
      tl.append(el('dt', '', t.name), dd);
    }
    p.appendChild(tl);
    const hint = el('div', 'chk-muted');
    hint.append('A config names a template and its settings. See ');
    hint.appendChild(el('code', '', 'docs/simulation.md'));
    hint.append(' in the Flamingo repo for the format.');
    p.appendChild(hint);
  }

  async function runSpec(path: string): Promise<void> {
    simRuns.set(path, { busy: true });
    renderSim();
    try {
      simRuns.set(path, { busy: false, result: await api.runSim(path) });
    } catch (err) {
      simRuns.set(path, { busy: false, error: err instanceof Error ? err.message : String(err) });
    }
    renderSim();
  }

  function simResult(r: SimRunResult): HTMLElement {
    const box = el('div', 'chk-sim-result');
    if (r.kind === 'logic') {
      const failed = r.results.filter((x) => !x.pass).length;
      box.appendChild(
        el(
          'div',
          failed ? 'chk-sim-sum err' : 'chk-sim-sum ok',
          `${r.states.toLocaleString()} states · ${failed ? `${failed} of ${r.results.length} invariants fail` : `all ${r.results.length} invariants hold`}`,
        ),
      );
      for (const inv of r.results) {
        const row = el('div', 'chk-inv');
        row.append(el('span', `chk-pass ${inv.pass ? 'ok' : 'err'}`, inv.pass ? 'pass' : 'fail'), el('span', '', inv.name));
        box.appendChild(row);
        if (!inv.pass && inv.counterexample) {
          const table = el('table', 'chk-cex');
          const cap = el('caption', '', 'First failing state');
          table.appendChild(cap);
          const tb = el('tbody');
          for (const [sig, val] of Object.entries(inv.counterexample)) {
            const tr = el('tr');
            tr.append(el('th', '', sig), el('td', '', val));
            tb.appendChild(tr);
          }
          table.appendChild(tb);
          box.appendChild(table);
        }
      }
    } else {
      box.appendChild(el('div', 'chk-muted', `ran with ${r.backend}`));
      for (const run of r.runs) {
        box.appendChild(el('div', 'chk-subtitle', run.template));
        const pre = el('pre', 'chk-pre', run.summary.join('\n'));
        box.appendChild(pre);
      }
    }
    const shown = r.findings.filter((f) => f.level !== 'info');
    if (shown.length > 0) {
      const fl = el('div', 'chk-sim-findings');
      for (const f of shown) {
        const line = el('div', 'chk-row-line');
        line.append(badge(f.level), el('span', 'chk-row-msg', f.message));
        fl.appendChild(line);
      }
      box.appendChild(fl);
    }
    return box;
  }

  // ---- Printout pane ----
  function renderPrint(): void {
    const p = panes.printout;
    p.replaceChildren();
    p.appendChild(el('div', 'chk-subtitle', 'Paper'));
    const seg = el('div', 'chk-seg');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', 'Paper');
    for (const [value, label] of [
      ['a4', 'A4'],
      ['letter', 'Letter'],
    ] as const) {
      const b = button(`chk-seg-btn${paper === value ? ' active' : ''}`, label, () => {
        paper = value;
        renderPrint();
      });
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(paper === value));
      seg.appendChild(b);
    }
    p.appendChild(seg);
    const status = el('div', 'route-status');
    const dl = button('chk-btn chk-btn-primary chk-btn-wide', 'Download PDF', () => {
      dl.disabled = true;
      status.replaceChildren(el('div', 'route-busy', 'Rendering…'));
      void (async () => {
        try {
          const { blob, disposition } = await api.fetchPrint(paper);
          deps.download(blob, disposition, `${board()?.name || 'board'}.print.pdf`);
          status.replaceChildren(el('div', 'route-result ok', 'Downloaded.'));
        } catch (err) {
          status.replaceChildren(
            el('div', 'route-result err', `Print failed: ${err instanceof Error ? err.message : String(err)}`),
          );
        } finally {
          dl.disabled = false;
        }
      })();
    });
    p.append(dl, status);
    const howto = el('ol', 'chk-howto');
    for (const step of [
      'Print at 100 % (“Actual size”), never “Fit to page”.',
      'Measure the 100 mm and 4 in bars before trusting a fit.',
      'Page 1, top side: lay parts on their pads; pierce the drill crosshairs to push through-hole pins through card.',
      'Page 2, bottom side seen from below: the side through-hole parts are soldered from.',
      'Footprint pages: set each real part on its own footprint to check pitch, row spacing and pin 1.',
    ]) {
      howto.appendChild(el('li', '', step));
    }
    p.appendChild(howto);
  }

  // ---- tabs, open/close ----
  function setTab(t: ChecksTab): void {
    tab = t;
    for (const k of Object.keys(tabBtns) as ChecksTab[]) {
      const on = k === t;
      tabBtns[k].classList.toggle('active', on);
      tabBtns[k].setAttribute('aria-selected', String(on));
      tabBtns[k].tabIndex = on ? 0 : -1;
      panes[k].hidden = !on;
    }
    if (t === 'simulation' && !sim && !simError) void loadSim();
    if (t === 'printout') renderPrint();
  }

  function open(t: ChecksTab = tab): void {
    openFlag = true;
    root.hidden = false;
    document.body.classList.add('chk-open');
    setTab(t);
    renderHead();
    void ensureLoaded();
    tabBtns[t].focus();
  }

  function close(): void {
    openFlag = false;
    root.hidden = true;
    document.body.classList.remove('chk-open');
    waiveDraft = null;
    (document.getElementById('board-canvas') as HTMLElement | null)?.focus?.();
  }

  // Board edits: the header's stale note and the summary follow along.
  let seenBoard: Board | null = null;
  store.subscribe((s) => {
    if (s.board === seenBoard) return;
    seenBoard = s.board;
    if (openFlag) renderHead();
    publish();
  });

  setTab('findings');
  renderChips();
  renderFindings();
  publish();

  return {
    open,
    close,
    toggle: () => (openFlag ? close() : open()),
    isOpen: () => openFlag,
    showFindings: () => {
      open('findings');
      void runSelected();
    },
  };
}
