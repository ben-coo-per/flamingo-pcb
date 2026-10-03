/**
 * `flamingo check`: run the board checks headless, for CI and before ordering.
 *
 *   flamingo check board.flamingo [more.flamingo ...] [--json] [--quiet] [--only drc,erc] [--stock]
 *   flamingo check combo.plamingo [...]     every board on the panel, then the panel checks
 *
 * Output is one line per finding, then a count; `--json` prints a report per
 * board with the board file's sha256, so findings can be tied to a revision.
 * Exit status: 0 no errors, 1 any error finding, 2 the tool itself failed
 * (unreadable file, unknown check name).
 *
 * The JLCPCB stock check needs the network, so it is off unless `--stock`.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { formatFindings, parseBoard, type Board, type CheckFinding } from '@flamingo/engine';
import { fetchJlcStock, symbolPinsFromCache } from '@flamingo/parts';
import { PANEL_EXTENSION, parsePanel } from '@flamingo/panel';
import {
  boardPinLookup,
  checksReport,
  knownCheckNames,
  registeredChecks,
  registeredPanelChecks,
  runChecks,
  runPanelChecks,
  sha256,
  UnknownCheckError,
  type ChecksReport,
  type PanelBoard,
} from './checks.js';

export const CHECK_USAGE =
  'Usage: flamingo check <file.flamingo|file.plamingo> [...] [--json] [--quiet] [--only drc,erc] [--stock]';

export interface CheckCliIo {
  out(text: string): void;
  err(text: string): void;
  /** Override where symbol pins come from (tests). Defaults to the parts cache. */
  loadSymbolPins?: Parameters<typeof boardPinLookup>[1];
}

const defaultIo: CheckCliIo = {
  out: (t) => process.stdout.write(`${t}\n`),
  err: (t) => process.stderr.write(`${t}\n`),
};

interface Parsed {
  files: string[];
  json: boolean;
  quiet: boolean;
  stock: boolean;
  only?: string[];
}

function parseArgs(args: string[]): Parsed | string {
  const p: Parsed = { files: [], json: false, quiet: false, stock: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') p.json = true;
    else if (a === '--quiet') p.quiet = true;
    else if (a === '--stock') p.stock = true;
    else if (a === '--only' || a.startsWith('--only=')) {
      const v = a === '--only' ? args[++i] : a.slice('--only='.length);
      if (!v) return '--only needs a comma-separated list of checks';
      p.only = v.split(',').map((x) => x.trim()).filter(Boolean);
    } else if (a.startsWith('--')) return `unknown option ${a}`;
    else p.files.push(a);
  }
  if (p.files.length === 0) return 'no file given';
  return p;
}

async function loadBoard(path: string): Promise<{ board: Board; sha: string }> {
  const text = await readFile(path, 'utf8');
  return { board: parseBoard(text), sha: sha256(text) };
}

export async function runCheckCli(args: string[], io: CheckCliIo = defaultIo): Promise<number> {
  const p = parseArgs(args);
  if (typeof p === 'string') {
    io.err(`${p}\n${CHECK_USAGE}`);
    return 2;
  }
  // `--only` names checks of either kind: split it between board and panel checks.
  let boardOnly: string[] | undefined;
  let panelOnly: string[] | undefined;
  if (p.only) {
    const unknown = p.only.filter((n) => !knownCheckNames().includes(n));
    if (unknown.length > 0) {
      io.err(`flamingo check: ${new UnknownCheckError(`unknown check(s): ${unknown.join(', ')} (known: ${knownCheckNames().join(', ')})`).message}`);
      return 2;
    }
    const boardNames = new Set(registeredChecks().map((c) => c.name));
    const panelNames = new Set(registeredPanelChecks().map((c) => c.name));
    boardOnly = p.only.filter((n) => boardNames.has(n));
    panelOnly = p.only.filter((n) => panelNames.has(n));
  }

  const reports: (ChecksReport & { file: string })[] = [];
  try {
    for (const file of p.files) {
      const path = resolve(process.cwd(), file);
      const targets: { path: string; key?: string }[] = [];
      let panel: ReturnType<typeof parsePanel> | undefined;
      if (path.endsWith(PANEL_EXTENSION)) {
        panel = parsePanel(await readFile(path, 'utf8'));
        for (const s of panel.sources) targets.push({ path: resolve(dirname(path), s.path), key: s.key });
      } else {
        targets.push({ path });
      }

      const panelBoards: PanelBoard[] = [];
      for (const t of targets) {
        const { board, sha } = await loadBoard(t.path);
        const ctx = {
          pins: await boardPinLookup(board, io.loadSymbolPins ?? symbolPinsFromCache),
          boardDir: dirname(t.path),
          ...(p.stock ? { fetchStock: fetchJlcStock } : {}),
        };
        const findings = await runChecks(board, ctx, boardOnly);
        reports.push({ file: t.path, ...checksReport(board, findings, sha) });
        if (t.key) panelBoards.push({ key: t.key, path: t.path, board });
      }
      if (panel) {
        const ctx = { pins: () => undefined, boardDir: dirname(path) };
        const findings = await runPanelChecks(panel, panelBoards, ctx, panelOnly);
        reports.push({
          file: path,
          board: panel.name,
          generated: new Date().toISOString(),
          counts: count(findings),
          findings,
        });
      }
    }
  } catch (err) {
    io.err(`flamingo check: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  if (p.json) {
    io.out(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2));
  } else {
    for (const r of reports) {
      io.out(`== ${r.board}  ${r.file}${r.sha256 ? `  sha256 ${r.sha256.slice(0, 12)}` : ''}`);
      io.out(formatFindings(r.findings, { quiet: p.quiet }));
    }
  }
  return reports.some((r) => r.counts.error > 0) ? 1 : 0;
}

function count(findings: CheckFinding[]): ChecksReport['counts'] {
  const c = { error: 0, warn: 0, info: 0 };
  for (const f of findings) c[f.level]++;
  return c;
}
