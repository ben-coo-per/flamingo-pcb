#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { newBoard } from '@flamingo/engine';
import { Doc } from './document.js';
import { startServer } from './http.js';
import { PanelDoc } from './panel/doc.js';
import { PANEL_USAGE, runPanelCli } from './panel/cli.js';
import { PanelSession } from './panel/session.js';
import { fetchPart } from '@flamingo/parts';

const VERSION = '0.1.0';

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
  const priceLookup = async (lcsc: string): Promise<number | undefined> => (await fetchPart(lcsc)).info.price;
  let panel: PanelSession;
  if (panelArg) {
    const panelPath = resolve(process.cwd(), panelArg);
    if (!existsSync(panelPath)) throw new Error(`${panelPath} does not exist (create it with: flamingo panel new ${panelArg})`);
    panel = new PanelSession({ projectDir, priceLookup }, await PanelDoc.load(panelPath));
    void panel.loadPrices(await panel.resolved()).then(() => panel.touch());
  } else {
    panel = new PanelSession({ projectDir, priceLookup });
  }

  const port = process.env.FLAMINGO_PORT ? Number(process.env.FLAMINGO_PORT) : 4242;
  const started = await startServer(doc, port, { projectDir, panel });
  console.log(`Flamingo v${VERSION} serving ${fileArg} at http://localhost:${started.port}`);
  console.log(`Panel view at http://localhost:${started.port}/panel${panelArg ? ` (${panelArg})` : ''}`);

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    Promise.all([doc.close(), panel.close()])
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'panel') {
    process.exitCode = await runPanelCli(args.slice(1));
    return;
  }

  if (command !== 'serve') {
    console.error(`Usage: flamingo serve [file.flamingo] [--panel file.flamingo-panel]\n\n${PANEL_USAGE}`);
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
  await serve(file, panelArg);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
