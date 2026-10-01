#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { newBoard, parseBoard } from '@flamingo/engine';
import { exportPrint } from '@flamingo/fab';
import { Doc } from './document.js';
import { startServer } from './http.js';
import { PanelDoc } from './panel/doc.js';
import { PANEL_EXTENSION } from '@flamingo/panel';
import { PANEL_USAGE, runPanelCli } from './panel/cli.js';
import { CHECK_USAGE, runCheckCli } from './check-cli.js';
import { PanelSession } from './panel/session.js';
import { fetchPart } from '@flamingo/parts';

const VERSION = '0.1.0';
/** What panel files were called before they were `.plamingo`. */
const OLD_PANEL_EXTENSION = '.flamingo-panel';

function priceLookup(lcsc: string): Promise<number | undefined> {
  return fetchPart(lcsc).then((part) => part.info.price);
}

function shutDownOn(close: () => Promise<unknown>): void {
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    close()
      .catch((err: unknown) => {
        console.error('[flamingo] failed to flush pending save on shutdown:', err);
      })
      .finally(() => {
        process.exit(0);
      });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Serve a panel file the way a board file is served: the file is created if
 * it is missing, and its view is the page at '/'.
 */
async function servePanel(fileArg: string): Promise<void> {
  const filePath = resolve(process.cwd(), fileArg);
  const projectDir = dirname(filePath);

  let panel: PanelSession;
  if (existsSync(filePath)) {
    panel = new PanelSession({ projectDir, priceLookup }, await PanelDoc.load(filePath));
    void panel.loadPrices(await panel.resolved()).then(() => panel.touch());
  } else {
    panel = new PanelSession({ projectDir, priceLookup });
    const created = await panel.create(basename(filePath, PANEL_EXTENSION) || 'panel', filePath);
    if (!created.ok) throw new Error(created.error);
  }
  panel.watchSources();

  const port = process.env.FLAMINGO_PORT ? Number(process.env.FLAMINGO_PORT) : 4242;
  // The server is built around a board; on a panel file it is handed an empty
  // one that nothing reads and nothing saves.
  const started = await startServer(new Doc(newBoard('panel', 2)), port, { projectDir, panel, panelOnly: true });
  console.log(`Flamingo v${VERSION} serving ${fileArg} at http://localhost:${started.port}`);
  shutDownOn(() => started.close());
}

async function serve(fileArg: string, panelArg?: string): Promise<void> {
  const filePath = resolve(process.cwd(), fileArg);

  let doc: Doc;
  if (existsSync(filePath)) {
    doc = await Doc.load(filePath);
  } else {
    const stem = basename(filePath, extname(filePath)) || 'board';
    doc = new Doc(newBoard(stem, 2), filePath);
    await doc.save();
  }

  // Panels are served next to the board: open the one named with --panel, or
  // start with an empty, unsaved one.
  const projectDir = dirname(filePath);
  let panel: PanelSession;
  if (panelArg) {
    const panelPath = resolve(process.cwd(), panelArg);
    if (!existsSync(panelPath)) throw new Error(`${panelPath} does not exist (create it with: flamingo panel new ${panelArg})`);
    panel = new PanelSession({ projectDir, priceLookup }, await PanelDoc.load(panelPath));
    void panel.loadPrices(await panel.resolved()).then(() => panel.touch());
  } else {
    panel = new PanelSession({ projectDir, priceLookup });
  }
  panel.watchSources();

  const port = process.env.FLAMINGO_PORT ? Number(process.env.FLAMINGO_PORT) : 4242;
  const started = await startServer(doc, port, { projectDir, panel });
  console.log(`Flamingo v${VERSION} serving ${fileArg} at http://localhost:${started.port}`);
  console.log(`Panel view at http://localhost:${started.port}/panel${panelArg ? ` (${panelArg})` : ''}`);

  shutDownOn(() => Promise.all([doc.close(), panel.close()]));
}

const PRINT_USAGE =
  'Usage: flamingo export-print <file.flamingo> [--out DIR] [--paper a4|letter] [--svg]\n' +
  '  1:1 printable sheets for test-fitting parts: <name>.print.pdf in DIR (default <board dir>/print)';

/** `flamingo export-print`: write the 1:1 printout without starting a server. Returns the exit code. */
async function exportPrintCli(args: string[]): Promise<number> {
  let file: string | undefined;
  let out: string | undefined;
  let paper: 'a4' | 'letter' = 'a4';
  let svg = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--out') out = args[++i];
    else if (a === '--paper') {
      const p = args[++i];
      if (p !== 'a4' && p !== 'letter') {
        console.error(`--paper must be a4 or letter\n${PRINT_USAGE}`);
        return 2;
      }
      paper = p;
    } else if (a === '--svg') svg = true;
    else if (!a.startsWith('--') && file === undefined) file = a;
    else {
      console.error(`unknown argument ${a}\n${PRINT_USAGE}`);
      return 2;
    }
  }
  if (!file || (out === undefined && args.includes('--out'))) {
    console.error(PRINT_USAGE);
    return 2;
  }
  const filePath = resolve(process.cwd(), file);
  const board = parseBoard(readFileSync(filePath, 'utf8'));
  const r = await exportPrint(board, out ? resolve(process.cwd(), out) : resolve(dirname(filePath), 'print'), {
    paper,
    svg,
    source: basename(filePath),
  });
  for (const p of [r.pdf, ...r.svgs]) console.log(p);
  return 0;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'panel') {
    process.exitCode = await runPanelCli(args.slice(1));
    return;
  }

  if (command === 'export-print') {
    process.exitCode = await exportPrintCli(args.slice(1));
    return;
  }
  if (command === 'check') {
    process.exitCode = await runCheckCli(args.slice(1));
    return;
  }

  if (command !== 'serve') {
    console.error(
      `Usage: flamingo serve [file.flamingo] [--panel file${PANEL_EXTENSION}]    the board editor, with a panel at /panel\n` +
        `       flamingo serve <file${PANEL_EXTENSION}>    the panel view\n\n${CHECK_USAGE}\n\n${PANEL_USAGE}\n\n${PRINT_USAGE}`,
    );
    process.exitCode = 1;
    return;
  }

  const rest = args.slice(1);
  const panelAt = rest.indexOf('--panel');
  const panelArg = panelAt >= 0 ? rest.splice(panelAt, 2)[1] : undefined;
  if (panelAt >= 0 && panelArg === undefined) {
    console.error('--panel needs a file');
    process.exitCode = 1;
    return;
  }
  const file = rest[0] ?? './board.flamingo';
  for (const f of [file, panelArg]) {
    if (f?.endsWith(OLD_PANEL_EXTENSION)) {
      throw new Error(`${f}: panel files end in ${PANEL_EXTENSION} now. Rename the file; its contents are unchanged.`);
    }
  }
  if (file.endsWith(PANEL_EXTENSION)) {
    if (panelArg !== undefined) throw new Error(`${file} is a panel already: leave out --panel`);
    await servePanel(file);
    return;
  }
  await serve(file, panelArg);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
