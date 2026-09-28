#!/usr/bin/env node
/**
 * Headless-browser check of the panel view, on the boards e2e-panel.ts builds.
 *
 *     npx tsx packages/server/scripts/e2e-panel.ts        # builds the boards
 *     npm run build                                       # builds the page
 *     npx tsx packages/server/scripts/verify-panel-ui.ts
 *
 * Starts the real server with the real built UI, opens /panel in headless
 * Chromium, and checks, in the page itself:
 *
 *   - the view loads and connects
 *   - + and - change what is on the plate
 *   - dragging an instance moves it and pins it
 *   - the right-click menu rotates, duplicates, toggles bare, unpins, deletes
 *   - A arranges, around a pinned instance, and explains a panel that cannot fit
 *   - the cost summary follows every change, and flags estimates
 *   - selecting a scenario shows its fee lines and loads its panel onto the plate
 *   - warnings from the check are listed
 *   - Delete, Ctrl+Z and Ctrl+Shift+Z work
 *   - an edit made outside the browser (as MCP would) shows up without a reload
 *   - Export offers a zip, and the zip holds the fab files
 *   - every pixel drawn is grey: the view is monochrome
 *
 * Screenshots go to panel-screenshots/ at the repo root. Exits 0 on success.
 *
 * Chromium is found in Playwright's cache (~/.cache/ms-playwright), or set
 * FLAMINGO_CHROMIUM to a Chromium or Chrome binary.
 *
 * On a machine without the libraries Chromium needs, run the browser in
 * Playwright's container and point the script at it:
 *
 *     docker run --rm -d --network host --name flamingo-pw \
 *       -v "$PWD/packages/server/scripts/lib/greyscale-fonts.conf:/fc/fonts.conf:ro" \
 *       -e FONTCONFIG_FILE=/fc/fonts.conf \
 *       mcr.microsoft.com/playwright:v1.61.1-noble \
 *       npx -y playwright@1.61.1 run-server --port 4177 --host 127.0.0.1
 *     FLAMINGO_PLAYWRIGHT_WS=ws://127.0.0.1:4177/ npx tsx packages/server/scripts/verify-panel-ui.ts
 *     docker stop flamingo-pw
 *
 * The font configuration matters to the last check only. A browser that
 * rasterizes text with subpixel (LCD) antialiasing tints the edges of every
 * letter red and blue; that is the rasterizer, not the page, and the
 * configuration turns it off so that "every pixel is grey" is a statement
 * about the page. (macOS has had no subpixel antialiasing since 10.14.)
 */

import { existsSync, readdirSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import { Resvg } from '@resvg/resvg-js';
import { newBoard } from '@flamingo/engine';
import type { PanelView } from '@flamingo/panel';
import { Doc } from '../src/document.js';
import { startServer } from '../src/http.js';
import type { StartedServer } from '../src/http.js';

process.env.FLAMINGO_STOCK_CHECK ??= 'off';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', '..');
const BOARDS_DIR = join(ROOT, '.superpowers', 'sdd', 'e2e-panel');
const SHOTS_DIR = join(ROOT, 'panel-screenshots');
const BOARDS = ['esp32-breakout.flamingo', 'usbc-breakout.flamingo'] as const;
const VIEWPORT = { width: 1600, height: 1000 };

let stepNo = 0;
function step(label: string): void {
  stepNo++;
  console.log(`\n[${stepNo}] ${label}`);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

function findChromium(): string | undefined {
  if (process.env.FLAMINGO_CHROMIUM) return process.env.FLAMINGO_CHROMIUM;
  const cache = join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(cache)) return undefined;
  const dirs = readdirSync(cache)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) {
    for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const p = join(cache, d, rel);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  for (const b of BOARDS) {
    assert(existsSync(join(BOARDS_DIR, b)), `${join(BOARDS_DIR, b)} is missing: run packages/server/scripts/e2e-panel.ts first`);
  }
  assert(existsSync(join(ROOT, 'packages', 'ui', 'dist', 'panel.html')), 'packages/ui/dist/panel.html is missing: run npm run build first');

  const projectDir = await mkdtemp(join(tmpdir(), 'flamingo-panel-ui-'));
  for (const b of BOARDS) await copyFile(join(BOARDS_DIR, b), join(projectDir, b));
  await mkdir(SHOTS_DIR, { recursive: true });

  let started: StartedServer | undefined;
  let browser: Browser | undefined;
  const shots: Array<[string, string]> = [];

  try {
    started = await startServer(new Doc(newBoard('editor', 2)), 0, { projectDir, panel: true });
    const base = `http://127.0.0.1:${started.port}`;
    console.log(`Server on ${base}, project dir ${projectDir}`);

    const post = async (path: string, body: unknown = {}): Promise<Record<string, unknown>> => {
      const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return (await res.json()) as Record<string, unknown>;
    };
    const getView = async (): Promise<PanelView> => (await (await fetch(`${base}/api/panel`)).json()) as PanelView;

    // The panel the page will open on: both boards, 1 + 5 needed, nothing placed.
    await post('/api/panel/new', { name: 'combo' });
    await post('/api/panel/add-board', { path: 'esp32-breakout.flamingo', key: 'S', needed: 1 });
    await post('/api/panel/add-board', { path: 'usbc-breakout.flamingo', key: 'M', needed: 5 });

    const remote = process.env.FLAMINGO_PLAYWRIGHT_WS;
    if (remote) {
      browser = await chromium.connect(remote);
      console.log(`Browser: Playwright server at ${remote}`);
    } else {
      const executablePath = findChromium();
      browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
      console.log(`Browser: ${executablePath ?? 'Playwright default Chromium'}`);
    }
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, acceptDownloads: true });
    const page: Page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      // The browser logs every non-2xx response. The refused export is one,
      // and it is asked for on purpose further down.
      if (m.location().url.includes('/api/panel/export.zip')) return;
      pageErrors.push(`${m.text()} (${m.location().url})`);
    });

    const shot = async (name: string, what: string): Promise<Buffer> => {
      const file = `${name}.png`;
      const png = await page.screenshot({ path: join(SHOTS_DIR, file) });
      shots.push([file, what]);
      console.log(`  screenshot ${file}`);
      return png;
    };
    /** The page's own state, read through its scripted-check handle. */
    const state = <T>(pick: string): Promise<T> => page.evaluate(`(() => { const s = window.flamingoPanel.state(); return ${pick}; })()`) as Promise<T>;
    const instances = (): Promise<Array<{ id: string; x: number; y: number; rotation: number; pinned: boolean; populate: boolean }>> =>
      state('s.view.panel.instances.map((i) => ({ id: i.id, x: i.at.x, y: i.at.y, rotation: i.rotation, pinned: i.pinned, populate: i.populate }))');
    /** Wait until the page's view satisfies `cond` (an expression over `v`, the view). */
    const until = async (cond: string, what: string): Promise<void> => {
      try {
        await page.waitForFunction(`(() => { const s = window.flamingoPanel && window.flamingoPanel.state(); const v = s && s.view; return !!v && (${cond}); })()`, undefined, { timeout: 8000 });
      } catch {
        throw new Error(`ASSERT FAILED: timed out waiting for: ${what}`);
      }
    };
    /** Centre of an instance in page pixels. */
    const centreOf = async (id: string): Promise<{ x: number; y: number }> => {
      const p = (await page.evaluate(
        `(() => { const s = window.flamingoPanel.state(); const i = s.view.geometry.instances.find((x) => x.id === ${JSON.stringify(id)}); if (!i) return null;
          const c = window.flamingoPanel.toPlate({ x: (i.bbox.minX + i.bbox.maxX) / 2, y: (i.bbox.minY + i.bbox.maxY) / 2 });
          const r = document.getElementById('plate-canvas').getBoundingClientRect(); return { x: r.left + c.x, y: r.top + c.y }; })()`,
      )) as { x: number; y: number } | null;
      assert(p, `instance ${id} is not on the plate`);
      return p;
    };
    const text = async (selector: string): Promise<string> => (await page.locator(selector).innerText()).trim();
    const errorCodes = (): Promise<string[]> => state("s.view.issues.filter((i) => i.severity === 'error').map((i) => i.code)");
    const menu = async (id: string, item: string): Promise<void> => {
      const c = await centreOf(id);
      await page.mouse.click(c.x, c.y, { button: 'right' });
      await page.locator('#context-menu:not([hidden])').waitFor();
      await page.locator('#context-menu button', { hasText: item }).click();
    };

    // --- load --------------------------------------------------------------
    step('the view loads');
    await page.goto(`${base}/panel`);
    await page.waitForFunction('window.flamingoPanel && window.flamingoPanel.state().view !== null');
    await page.waitForFunction("document.getElementById('status-conn').textContent === 'connected'");
    assert((await page.title()) === 'Flamingo — Panel', 'wrong page title');
    assert((await text('#panel-name')) === 'combo', 'the panel name is not shown');
    const rows = await page.locator('#board-list .board').count();
    assert(rows === 2, `expected 2 boards in the list, got ${rows}`);
    assert((await text('#board-list .board[data-key="S"] .board-name')) === 'esp32-breakout', 'board S is not listed by name');
    assert((await page.locator('#board-list .board[data-key="M"] input[data-field="needed"]').inputValue()) === '5', 'needed quantity of M is not shown');
    assert(await page.locator('#plate-empty').isVisible(), 'the empty plate does not say it is empty');
    const canvasBox = await page.locator('#plate-canvas').boundingBox();
    assert(canvasBox && canvasBox.width > VIEWPORT.width * 0.7 && canvasBox.height > VIEWPORT.height * 0.9, 'the canvas does not take most of the screen');
    await shot('01-loaded-empty', 'The view as it opens: both boards listed with needed 1 and 5, nothing on the plate yet.');

    // --- object list: + and - ----------------------------------------------
    step('+ puts instances on the plate');
    await page.locator('#board-list .board[data-key="S"] button[aria-label="one more S"]').click();
    await until('v.panel.instances.length === 1', 'S1 on the plate');
    for (let n = 1; n <= 5; n++) {
      await page.locator('#board-list .board[data-key="M"] button[aria-label="one more M"]').click();
      await until(`v.panel.instances.filter((i) => i.source === 'M').length === ${n}`, `${n} M instances`);
    }
    assert((await text('#board-list .board[data-key="M"] output')) === '5', 'the count of M does not read 5');
    assert((await errorCodes()).length === 0, `adding instances left errors: ${(await errorCodes()).join(', ')}`);
    assert(!(await page.locator('#plate-empty').isVisible()), 'the empty-plate note is still showing');
    const costAll = await text('#cost-total');
    assert(/^\$\d+\.\d\d$/.test(costAll), `the cost total reads "${costAll}"`);
    assert(await page.locator('#cost-flag').isVisible(), 'the cost is not flagged as an estimate');
    const flagged = await page.locator('#cost-summary table.lines td.flag', { hasText: 'est.' }).count();
    const unflagged = await page.locator('#cost-summary table.lines tr:not(.sum) td.flag:text-is("")').count();
    assert(flagged > 0 && unflagged > 0, `expected both estimated and verified fee lines, got ${flagged} and ${unflagged}`);
    assert((await text('#cost-summary .legend')).includes('est. = estimate'), 'the estimate mark is not explained');
    await shot('02-one-plus-five', 'After pressing + once for S and five times for M: 1 + 5 on the plate, arranged as they were added, with the live cost.');

    step('- takes one away, and the cost follows');
    await page.locator('#board-list .board[data-key="M"] button[aria-label="one fewer M"]').click();
    await until("v.panel.instances.filter((i) => i.source === 'M').length === 4", '4 M instances');
    await page.waitForFunction(`document.getElementById('cost-total').textContent !== ${JSON.stringify(costAll)}`);
    const costFour = await text('#cost-total');
    console.log(`  cost with 5 M: ${costAll}; with 4 M: ${costFour}`);
    assert(costFour !== costAll, 'the cost did not change when an instance was removed');
    await page.locator('#board-list .board[data-key="M"] button[aria-label="one more M"]').click();
    await until("v.panel.instances.filter((i) => i.source === 'M').length === 5", '5 M instances again');

    // --- drag pins ---------------------------------------------------------
    step('dragging an instance moves it and pins it');
    const before = (await instances()).find((i) => i.id === 'M3')!;
    assert(!before.pinned, 'M3 is pinned before it was ever dragged');
    const from = await centreOf('M3');
    const onto = await centreOf('S1');
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + onto.x) / 2, (from.y + onto.y) / 2, { steps: 6 });
    const dragging = await state<{ id: string } | null>('s.drag');
    assert(dragging?.id === 'M3', 'no drag is in progress while the button is held');
    await shot('03-dragging', 'M3 picked up and on its way: drawn where the pointer has it, with its position beside it.');
    await page.mouse.move(onto.x, onto.y, { steps: 6 });
    await page.mouse.up();
    await until("v.panel.instances.find((i) => i.id === 'M3').pinned === true", 'M3 pinned after the drop');
    const after = (await instances()).find((i) => i.id === 'M3')!;
    assert(Math.hypot(after.x - before.x, after.y - before.y) > 5, 'M3 did not move');
    const onServer = (await getView()).panel.instances.find((i) => i.id === 'M3')!;
    assert(onServer.pinned && onServer.at.x === after.x && onServer.at.y === after.y, 'the server does not have the dropped position');
    assert((await state<string | null>('s.selection')) === 'M3', 'the dragged instance is not selected');
    assert((await text('#status-selection')).includes('pinned'), 'the status bar does not say the selection is pinned');

    step('the check lists what the drop caused, and marks the instances');
    await until("v.issues.some((i) => i.code === 'overlap')", 'an overlap error');
    const overlap = await text('#issue-list .issue-error[data-code="overlap"] .issue-text');
    assert(/M3/.test(overlap) && /S1/.test(overlap), `the overlap warning reads "${overlap}"`);
    assert(/\d+ error/.test(await text('#issue-count')), 'the warnings heading does not count the errors');
    await shot('04-dropped-pinned-overlap', 'M3 dropped on S1: pinned (filled corner square, PINNED), both marked with a second outline and ERROR, and the overlap listed under Warnings.');

    // --- arrange -----------------------------------------------------------
    step('A arranges around the pinned instance');
    // Drag M3 somewhere it can stay: clear of everything, to the right of the panel.
    const frame = await state<{ maxX: number; minY: number }>('s.view.geometry.frame.outer');
    const clear = (await page.evaluate(
      `(() => { const c = window.flamingoPanel.toPlate({ x: ${frame.maxX} + 20, y: ${frame.minY} + 20 }); const r = document.getElementById('plate-canvas').getBoundingClientRect(); return { x: r.left + c.x, y: r.top + c.y }; })()`,
    )) as { x: number; y: number };
    const m3 = await centreOf('M3');
    await page.mouse.move(m3.x, m3.y);
    await page.mouse.down();
    await page.mouse.move(clear.x, clear.y, { steps: 8 });
    await page.mouse.up();
    await until("!v.issues.some((i) => i.code === 'overlap')", 'the overlap to clear');
    const pinnedAt = (await instances()).find((i) => i.id === 'M3')!;
    await page.locator('body').click({ position: { x: 5, y: 5 } }); // focus the page, not a field
    await page.keyboard.press('a');
    await page.locator('#arrange-msg:not([hidden])').waitFor();
    const arranged = await text('#arrange-msg');
    assert(/^Arranged 5 instances into [\d.]+ × [\d.]+ mm\.$/.test(arranged), `the arrange message reads "${arranged}"`);
    const kept = (await instances()).find((i) => i.id === 'M3')!;
    assert(kept.pinned && kept.x === pinnedAt.x && kept.y === pinnedAt.y, 'arrange moved the pinned instance');
    assert((await errorCodes()).length === 0, `arrange left errors: ${(await errorCodes()).join(', ')}`);
    await shot('05-arranged-around-pinned', 'After A: five instances packed, M3 left where it was pinned, and the message saying so.');

    // --- context menu ------------------------------------------------------
    step('the right-click menu');
    const c3 = await centreOf('M3');
    await page.mouse.click(c3.x, c3.y, { button: 'right' });
    await page.locator('#context-menu:not([hidden])').waitFor();
    const items = (await page.locator('#context-menu button').allInnerTexts()).map((t) => t.trim());
    assert(JSON.stringify(items) === JSON.stringify(['Rotate 90°', 'Duplicate', 'Delete', 'Make bare', 'Unpin']), `the menu reads ${JSON.stringify(items)}`);
    await shot('06-context-menu', 'Right-click on M3: rotate 90°, duplicate, delete, make bare, unpin.');
    await page.locator('#context-menu button', { hasText: 'Unpin' }).click();
    await until("v.panel.instances.find((i) => i.id === 'M3').pinned === false", 'M3 unpinned');
    assert(!(await page.locator('#context-menu').isVisible()), 'the menu stayed open');

    await menu('M3', 'Rotate 90°');
    await until("v.panel.instances.find((i) => i.id === 'M3').rotation !== " + kept.rotation, 'M3 rotated');
    await menu('M3', 'Make bare');
    await until("v.panel.instances.find((i) => i.id === 'M3').populate === false", 'M3 bare');
    assert((await text('#board-list .board[data-key="M"] .board-meta')).includes('1 bare'), 'the board list does not count the bare instance');
    await menu('M3', 'Duplicate');
    await until("v.panel.instances.filter((i) => i.source === 'M').length === 6", 'a sixth M');
    const copy = (await instances()).find((i) => i.id === 'M6')!;
    assert(!copy.populate && !copy.pinned, 'the duplicate did not keep bare, or came pinned');
    // The copy lands beside the original, which may be off the plate: arrange brings it in.
    await page.keyboard.press('a');
    await until("v.issues.filter((i) => i.severity === 'error').length === 0", 'a clean panel after arranging');
    await page.waitForFunction('window.flamingoPanel.state().busy === false');
    const unpinDisabled = await (async () => {
      const c = await centreOf('M6');
      await page.mouse.click(c.x, c.y, { button: 'right' });
      await page.locator('#context-menu:not([hidden])').waitFor();
      const disabled = await page.locator('#context-menu button', { hasText: 'Unpin' }).isDisabled();
      const label = await page.locator('#context-menu button', { hasText: /Make/ }).innerText();
      await page.keyboard.press('Escape');
      return { disabled, label: label.trim() };
    })();
    assert(unpinDisabled.disabled, 'Unpin is offered for an instance that is not pinned');
    assert(unpinDisabled.label === 'Make populated', 'a bare instance is not offered "Make populated"');
    assert(!(await page.locator('#context-menu').isVisible()), 'Escape did not close the menu');
    await shot('07-bare-instances', 'M3 turned and made bare, then duplicated as M6: bare instances are hatched with a dashed outline and read BARE.');
    await menu('M6', 'Delete');
    await until("!v.panel.instances.some((i) => i.id === 'M6')", 'M6 deleted');

    // --- keyboard ----------------------------------------------------------
    step('Delete, Ctrl+Z, Ctrl+Shift+Z');
    const c5 = await centreOf('M5');
    await page.mouse.click(c5.x, c5.y);
    assert((await state<string | null>('s.selection')) === 'M5', 'a click did not select M5');
    await page.keyboard.press('Delete');
    await until("!v.panel.instances.some((i) => i.id === 'M5')", 'M5 removed by Delete');
    await page.keyboard.press('Control+z');
    await until("v.panel.instances.some((i) => i.id === 'M5')", 'M5 back after undo');
    await page.keyboard.press('Control+Shift+z');
    await until("!v.panel.instances.some((i) => i.id === 'M5')", 'M5 gone again after redo');
    await page.keyboard.press('Control+z');
    await until("v.panel.instances.some((i) => i.id === 'M5')", 'M5 back');
    // A click on empty plate deselects; a drag there pans; the wheel zooms.
    const t0 = await state<{ scale: number; originPxX: number }>('s.transform');
    await page.mouse.move(canvasBox.x + 30, canvasBox.y + canvasBox.height - 30);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + 90, canvasBox.y + canvasBox.height - 60, { steps: 4 });
    await page.mouse.up();
    const t1 = await state<{ scale: number; originPxX: number }>('s.transform');
    assert(Math.abs(t1.originPxX - t0.originPxX - 60) < 1 && t1.scale === t0.scale, 'dragging empty space did not pan');
    assert((await state<string | null>('s.selection')) === null, 'a press on empty plate did not deselect');
    await page.mouse.wheel(0, -300);
    const t2 = await state<{ scale: number }>('s.transform');
    assert(t2.scale > t1.scale, 'scrolling did not zoom');
    await page.mouse.wheel(0, 300);
    await page.mouse.move(canvasBox.x + 90, canvasBox.y + canvasBox.height - 60);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + 30, canvasBox.y + canvasBox.height - 30, { steps: 4 });
    await page.mouse.up();

    // --- quantities and cost -----------------------------------------------
    step('the cost follows the needed quantity');
    await menu('M3', 'Make populated');
    await until("v.panel.instances.find((i) => i.id === 'M3').populate === true", 'M3 populated');
    const orderBefore = await text('#cost-summary .order-line');
    const totalBefore = await text('#cost-total');
    const needed = page.locator('#board-list .board[data-key="M"] input[data-field="needed"]');
    await needed.fill('12');
    await needed.press('Enter');
    await until("v.panel.sources.find((s) => s.key === 'M').needed === 12", 'needed 12 for M');
    await page.waitForFunction(`document.querySelector('#cost-summary .order-line').textContent !== ${JSON.stringify(orderBefore)}`);
    const orderAfter = await text('#cost-summary .order-line');
    const totalAfter = await text('#cost-total');
    console.log(`  needed 5: "${orderBefore}" ${totalBefore}; needed 12: "${orderAfter}" ${totalAfter}`);
    assert(orderAfter !== orderBefore && totalAfter !== totalBefore, 'the cost summary did not follow the needed quantity');
    assert((await text('#cost-summary .received')).includes('need 12'), 'boards received does not show the new need');
    const derived = await state<number>('s.view.derivedMs');
    console.log(`  the server derived this view, checks and cost included, in ${derived} ms`);
    await shot('08-cost-follows-quantity', 'Needed quantity of M raised to 12: more panels assembled, a new total, and new scenarios below.');
    await needed.fill('5');
    await needed.press('Enter');
    await until("v.panel.sources.find((s) => s.key === 'M').needed === 5", 'needed 5 for M');

    // --- scenarios ---------------------------------------------------------
    step('selecting a scenario shows its fees and loads its panel');
    await page.waitForFunction("document.querySelectorAll('#scenario-list tr[data-scenario]').length >= 4");
    await page.waitForFunction("window.flamingoPanel.state().quote.scenarios.every((s) => s.received.find((r) => r.key === 'M').needed === 5)");
    const head = (await page.locator('#scenario-list thead th').allInnerTexts()).map((t) => t.trim());
    assert(JSON.stringify(head) === JSON.stringify(['#', 'Scenario', 'Total', 'Per board']), `the scenario table is headed ${JSON.stringify(head)}`);
    const totals = (await page.locator('#scenario-list tbody tr td:nth-child(3)').allInnerTexts()).map((t) => Number(/\$([\d.]+)/.exec(t)![1]));
    assert(totals.every((t, i) => i === 0 || t >= totals[i - 1]!), `the scenarios are not ranked by total: ${totals.join(', ')}`);
    const firstRow = await text('#scenario-list tbody tr:first-child');
    assert(/got\/need S \d+\/1\s+M \d+\/5/.test(firstRow), `a scenario row does not show boards received against needed: "${firstRow}"`);
    assert(/warning/.test(firstRow) && /est\./.test(firstRow), 'a scenario row shows no warnings count or no estimate mark');

    const target = 'merged-needed-x2';
    const want = await state<{ n: number; total: number; w: number; h: number }>(
      `(() => { const q = s.quote.scenarios.find((x) => x.id === '${target}'); return { n: q.layout.instances.length, total: q.total, w: q.layout.width, h: q.layout.height }; })()`,
    );
    await page.locator(`#scenario-list tr[data-scenario="${target}"]`).click();
    await page.locator('#scenario-lines').waitFor();
    await until(`v.panel.instances.length === ${want.n}`, `${want.n} instances from the scenario`);
    const lines = await page.locator('#scenario-lines table.lines tr:not(.sum)').count();
    assert(lines >= 8, `the scenario shows ${lines} fee lines`);
    assert((await text('#scenario-lines')).includes('Different designs: 2 in one file'), 'the different-designs fee is not itemized');
    assert((await text('#scenario-lines table.lines tr.sum')).includes(`$${want.total.toFixed(2)}`), 'the scenario detail does not total to the scenario');
    const loaded = await state<{ w: number; h: number; sep: string }>('({ w: s.view.geometry.frame.width, h: s.view.geometry.frame.height, sep: s.view.panel.settings.separation })');
    assert(Math.abs(loaded.w - want.w) < 0.01 && Math.abs(loaded.h - want.h) < 0.01, `the plate is ${loaded.w} x ${loaded.h}, the scenario ${want.w} x ${want.h}`);
    await page.waitForFunction(`document.getElementById('cost-total').textContent === '$${want.total.toFixed(2)}'`);
    assert(await page.locator(`#scenario-list tr[data-scenario="${target}"].selected`).isVisible(), 'the selected scenario is not marked');
    assert((await errorCodes()).length === 0, `the loaded scenario has errors: ${(await errorCodes()).join(', ')}`);
    await shot('09-scenario-loaded', 'Scenario "One panel, mouse bites" selected: its fee lines below the table, its 1 + 3 panel on the plate, and the live cost equal to its total.');

    await page.locator('#scenario-list tr[data-scenario^="silk-divider"]').first().click();
    await until("v.panel.settings.separation === 'silk-divider'", 'a silk-divider panel on the plate');
    assert((await state<number>('s.view.geometry.tabs.length')) === 0, 'a silk-divider panel has tabs');
    assert(!(await text('#scenario-lines')).includes('Different designs'), 'a silk-divided board is charged for different designs');
    await shot('10-scenario-silk-divider', 'The cheapest scenario: boards inside one outline, divided by silkscreen lines (dotted), no rails, no tabs.');

    await page.locator('#scenario-list tr[data-scenario="separate"]').click();
    await page.locator('#scenario-lines .msg').waitFor();
    assert((await text('#scenario-lines .msg')).includes('there is no panel to load'), 'a scenario of single boards does not say the plate is unchanged');
    assert((await state<string>('s.view.panel.settings.separation')) === 'silk-divider', 'a scenario without a panel changed the plate');

    await page.locator(`#scenario-list tr[data-scenario="${target}"]`).click();
    await until(`v.panel.settings.separation === 'mouse-bite' && v.panel.instances.length === ${want.n}`, 'the mouse-bite scenario back on the plate');

    // --- sync --------------------------------------------------------------
    step('an edit made outside the browser shows up without a reload');
    const r = await post('/api/panel/op', { op: 'setPopulate', id: 'M2', populate: false });
    assert(r.ok === true, `the outside edit was rejected: ${JSON.stringify(r)}`);
    await until("v.panel.instances.find((i) => i.id === 'M2').populate === false", 'M2 bare in the page');
    await page.waitForFunction("document.querySelector('#board-list .board[data-key=\"M\"] .board-meta').textContent.includes('1 bare')");
    await post('/api/panel/undo');
    await until("v.panel.instances.find((i) => i.id === 'M2').populate === true", 'M2 populated again');

    // --- export ------------------------------------------------------------
    step('Export offers the zip');
    await page.locator('#export-btn').click();
    await page.locator('#export-link').waitFor();
    assert((await text('#export-msg')).startsWith('Exported:'), `the export message reads "${await text('#export-msg')}"`);
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#export-link').click()]);
    assert(download.suggestedFilename() === 'combo-panel-fab.zip', `the download is called ${download.suggestedFilename()}`);
    const zipPath = join(projectDir, 'download.zip');
    await download.saveAs(zipPath);
    const names = new AdmZip(zipPath).getEntries().map((e) => e.entryName).sort();
    for (const n of ['combo.GTL', 'combo.GBL', 'combo.GKO', 'combo-PTH.DRL', 'combo-NPTH.DRL', 'bom.csv', 'cpl.csv', 'panel.render.svg']) {
      assert(names.includes(n), `the zip has no ${n}`);
    }
    const bom = new AdmZip(zipPath).getEntry('bom.csv')!.getData().toString('utf8');
    assert(bom.includes('S1_U1') && bom.includes('M3_J1'), 'the BOM in the zip is not the merged one');
    console.log(`  ${download.suggestedFilename()}: ${names.length} files`);
    await shot('11-exported', 'Export fab files: the zip is ready and offered as a download link.');

    step('Export refuses a panel with errors, and says why');
    const s1 = (await instances()).find((i) => i.id === 'S1')!;
    await post('/api/panel/op', { op: 'moveInstance', id: 'M1', at: { x: s1.x + 2, y: s1.y + 2 }, pin: true });
    await until("v.issues.some((i) => i.code === 'overlap')", 'an overlap');
    await page.locator('#export-btn').click();
    await page.locator('#export-msg.msg-problem').waitFor();
    const refused = await text('#export-msg');
    assert(refused.startsWith('Not exported:') && refused.includes('overlap'), `the refusal reads "${refused}"`);
    assert((await page.locator('#export-link').count()) === 0, 'a download is offered for a panel with errors');
    await shot('12-export-refused', 'Export on a panel with an overlap: refused, with the findings that stopped it.');
    await post('/api/panel/undo');
    await until("!v.issues.some((i) => i.code === 'overlap')", 'the overlap undone');

    // --- does not fit ------------------------------------------------------
    step('arrange explains a panel that cannot fit');
    await post('/api/panel/count', { board: 'S', count: 44 });
    await until("v.panel.instances.filter((i) => i.source === 'S').length === 44", '44 S instances');
    const layoutBefore = JSON.stringify(await instances());
    await page.locator('#arrange-btn').click();
    await page.locator('#arrange-msg.msg-problem').waitFor();
    const noFit = await text('#arrange-msg');
    console.log(`  ${noFit.replace(/\n/g, ' | ')}`);
    assert(noFit.startsWith('Does not fit.'), `the message reads "${noFit}"`);
    assert(/instances do not fit within 250 x 250 mm \(the assembly panel limit\)/.test(noFit), 'the reason from the layout engine is missing');
    assert(/smallest panel that holds them is [\d.]+ x [\d.]+ mm/.test(noFit), 'the smallest panel that would fit is missing');
    assert(JSON.stringify(await instances()) === layoutBefore, 'a failed arrange moved something');
    await shot('13-does-not-fit', '44 + 3 instances: Arrange leaves the plate as it is and says why, with the smallest panel that would hold them.');
    await post('/api/panel/undo');
    await until("v.panel.instances.filter((i) => i.source === 'S').length === 1", 'back to one S');

    // --- stale -------------------------------------------------------------
    step('a source board edited on disk is marked stale');
    const boardPath = join(projectDir, 'usbc-breakout.flamingo');
    const edited = JSON.parse(await (await import('node:fs/promises')).readFile(boardPath, 'utf8')) as { silk: unknown[] };
    edited.silk.push({ id: 'note', layer: 'F.Silk', at: { x: 12, y: 8 }, text: 'rev b', height: 1, rotation: 0 });
    await writeFile(boardPath, JSON.stringify(edited, null, 2));
    started.panel!.touch();
    await until("v.sources.find((s) => s.key === 'M').stale === true", 'M stale in the page');
    assert((await text('#board-list .board[data-key="M"] .tag')) === 'stale', 'the board list does not tag M as stale');
    assert((await text('#issue-list')).includes('changed on disk'), 'the stale board is not listed under Warnings');
    await page.keyboard.press('a');
    await until("v.issues.filter((i) => i.severity === 'error').length === 0", 'a clean panel');
    const stalePng = await shot('14-stale-source', 'usbc-breakout edited on disk: tagged stale in the board list, its instances dotted and labelled STALE, and a warning listed.');

    // --- monochrome --------------------------------------------------------
    step('every pixel is grey');
    let coloured = 0;
    for (const png of [stalePng, await page.screenshot()]) {
      const img = new Resvg(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${VIEWPORT.width}" height="${VIEWPORT.height}"><image width="${VIEWPORT.width}" height="${VIEWPORT.height}" href="data:image/png;base64,${png.toString('base64')}"/></svg>`,
      ).render();
      const px = img.pixels;
      for (let i = 0; i < px.length; i += 4) {
        if (Math.abs(px[i]! - px[i + 1]!) > 2 || Math.abs(px[i + 1]! - px[i + 2]!) > 2) coloured++;
      }
    }
    assert(
      coloured === 0,
      `${coloured} pixels are not grey. If they all sit on the edges of text, the browser is antialiasing for an LCD: see the header of this script.`,
    );
    // And in the styles themselves, whatever the rasterizer does with them.
    const tinted = (await page.evaluate(`(() => {
      const grey = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c); if (!m) return true; const [r, g, b, a] = m[1].split(',').map(Number); return a === 0 || (r === g && g === b); };
      const out = [];
      for (const e of document.querySelectorAll('*')) {
        const c = getComputedStyle(e);
        for (const prop of ['color', 'backgroundColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'outlineColor']) {
          if (!grey(c[prop])) out.push(e.tagName + '#' + e.id + '.' + e.className + ' ' + prop + ' ' + c[prop]);
        }
      }
      return out;
    })()`)) as string[];
    assert(tinted.length === 0, `elements styled with a colour:\n${tinted.slice(0, 10).join('\n')}`);
    const motion = await page.evaluate(`(() => [...document.querySelectorAll('*')].filter((e) => { const c = getComputedStyle(e); return c.transitionDuration.split(',').some((d) => parseFloat(d) > 0) || c.animationName !== 'none' || c.boxShadow !== 'none' || c.backgroundImage !== 'none'; }).length)()`);
    assert(motion === 0, `${motion} element(s) have a transition, animation, shadow or gradient`);
    console.log('  no coloured pixel, no coloured style, no transition, animation, shadow or gradient');

    assert(pageErrors.length === 0, `the page logged errors:\n${pageErrors.join('\n')}`);

    // --- the board editor --------------------------------------------------
    step('the board editor still loads beside it');
    const editor = await context.newPage();
    const editorErrors: string[] = [];
    editor.on('pageerror', (e) => editorErrors.push(e.message));
    await editor.goto(`${base}/`);
    await editor.locator('#board-canvas').waitFor();
    await editor.waitForFunction("document.getElementById('status-conn').textContent.trim().length > 0 && !document.getElementById('status-conn').textContent.includes('connecting')");
    assert((await editor.title()) === 'Flamingo', `the editor page is titled "${await editor.title()}"`);
    assert((await editor.locator('#tool-buttons button').count()) > 5, 'the editor has no tool buttons');
    assert(editorErrors.length === 0, `the editor logged errors:\n${editorErrors.join('\n')}`);
    // The link in the panel view leads here.
    assert((await page.locator('a.bar-link').getAttribute('href')) === '/', 'the panel view does not link to the editor');
    await editor.close();

    await writeFile(
      join(SHOTS_DIR, 'README.md'),
      [
        '# Panel view screenshots',
        '',
        'Taken by `packages/server/scripts/verify-panel-ui.ts` in headless Chromium',
        `(${VIEWPORT.width} x ${VIEWPORT.height}), on the boards \`e2e-panel.ts\` builds.`,
        '',
        ...shots.map(([file, what]) => `- \`${file}\` — ${what}`),
        '',
      ].join('\n'),
    );

    console.log('\n' + '='.repeat(64));
    console.log('  FLAMINGO PANEL VIEW — PASS');
    console.log('='.repeat(64));
    console.log(`  ${stepNo} checks, ${shots.length} screenshots in ${SHOTS_DIR}`);
    console.log('='.repeat(64));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (started) await started.close().catch(() => {});
    await rm(projectDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err: unknown) => {
  console.error('\nPANEL VIEW CHECK FAILED:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
