/**
 * HTTP routes behind the editor's Checks workspace (see
 * docs/superpowers/specs/2026-10-01-checks-ui-design.md):
 *
 *   GET  /api/checks          the board checks, in registry order, plus `stock`
 *   GET  /api/checks/run      run some of them; findings split into kept / waived
 *   GET  /api/sim/specs       logic specs and SPICE configs beside the board file
 *   POST /api/sim/run         run one of those files
 *   GET  /api/export.print    the 1:1 printout as a PDF download
 *
 * Waivers are added and removed through POST /api/op (addCheckWaiver /
 * removeCheckWaiver), so they get undo and live sync like any other edit.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import {
  SPICE_TEMPLATES,
  applyWaivers,
  parseBoard,
  serializeBoard,
  simulateLogic,
  type Board,
  type CheckFinding,
  type CheckWaiver,
} from '@flamingo/engine';
import { printPages, writePdf, type Paper } from '@flamingo/fab';
import { boardPinLookup, drcFindings, registeredChecks, runChecks, sha256, UnknownCheckError } from './checks.js';
import type { McpContext } from './mcp.js';
import { pinLookupFor, resolveLogicSpec } from './sim-tools.js';
import { findNgspice, runSpiceTemplate } from './spice-runner.js';
import { checkStock } from './stock.js';

/** JSON files larger than this beside the board are not read as specs. */
const MAX_SPEC_BYTES = 1024 * 1024;

const STOCK = {
  name: 'stock',
  description: 'JLCPCB assembly stock for every placed part (needs the network)',
  network: true,
} as const;

export interface CheckInfo {
  name: string;
  description: string;
  network?: boolean;
}

export interface SimSpecInfo {
  /** Path relative to the board's directory (what POST /api/sim/run takes). */
  path: string;
  name: string;
  kind: 'logic' | 'spice';
  description?: string;
}

function sendJSON(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      data += chunk;
    });
    req.on('end', () => resolveBody(data));
    req.on('error', reject);
  });
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function checkList(): CheckInfo[] {
  return [...registeredChecks().map((c) => ({ name: c.name, description: c.description })), { ...STOCK }];
}

/** Every non-network check, by default; `stock` only when named. */
async function runSelected(ctx: McpContext, board: Board, only: string[] | undefined): Promise<CheckFinding[]> {
  const wantStock = only?.includes(STOCK.name) ?? false;
  const rest = only?.filter((n) => n !== STOCK.name);
  const pins = await boardPinLookup(board, ctx.loadSymbolPins);
  const boardDir = ctx.doc.filePath ? dirname(ctx.doc.filePath) : undefined;
  const findings: CheckFinding[] = [];
  // `only=stock` alone runs no registry check.
  if (!only || (rest && rest.length > 0)) {
    findings.push(...(await runChecks(board, { pins, ignoreWaivers: true, ...(boardDir ? { boardDir } : {}) }, rest)));
  }
  if (wantStock) {
    const stock = await checkStock(board, (lcsc) => ctx.partsApi.fetchStock(lcsc));
    findings.push(
      ...[...drcFindings(stock.violations), ...drcFindings(stock.advisories, 'warn')].map((f) => ({ ...f, check: STOCK.name })),
    );
  }
  return findings;
}

/** Recognise a logic spec or a SPICE config by its shape. */
export function classifySpec(raw: unknown): 'logic' | 'spice' | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (Array.isArray(o.instances) && Array.isArray(o.invariants)) return 'logic';
  if (Array.isArray(o.runs) && o.runs.length > 0 && o.runs.every((r) => r && typeof (r as { template?: unknown }).template === 'string')) {
    return 'spice';
  }
  return null;
}

/** Logic specs and SPICE configs in `dir` (not recursive), sorted by name. */
export async function listSimSpecs(dir: string): Promise<SimSpecInfo[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: SimSpecInfo[] = [];
  for (const name of names.filter((n) => n.toLowerCase().endsWith('.json')).sort()) {
    const path = join(dir, name);
    try {
      const st = await stat(path);
      if (!st.isFile() || st.size > MAX_SPEC_BYTES) continue;
      const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      const kind = classifySpec(raw);
      if (!kind) continue;
      out.push({
        path: name,
        name: name.replace(/\.json$/i, ''),
        kind,
        ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      });
    } catch {
      // Not JSON, unreadable, or vanished: not a spec.
    }
  }
  return out;
}

/**
 * Resolve `p` inside `dir`, refusing anything that lands outside it --
 * `..`, absolute paths elsewhere, and symlinks pointing out.
 */
export async function resolveInside(dir: string, p: string): Promise<string> {
  const root = await realpath(dir);
  const target = resolve(root, p);
  const inside = (x: string): boolean => x === root || x.startsWith(root + sep);
  if (!inside(target)) throw new PathError(`${p} is outside the board's directory`);
  const real = await realpath(target).catch(() => {
    throw new PathError(`${p} does not exist`);
  });
  if (!inside(real)) throw new PathError(`${p} is outside the board's directory`);
  return real;
}

class PathError extends Error {}

async function runSpec(ctx: McpContext, path: string): Promise<Record<string, unknown>> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  const kind = classifySpec(raw);
  const baseDir = dirname(path);
  if (kind === 'logic') {
    const spec = await resolveLogicSpec(raw, ctx.doc.board, baseDir);
    const pins = await pinLookupFor(spec.instances.map((i) => i.board));
    const t0 = Date.now();
    const { report, findings } = simulateLogic(spec, { pins });
    return {
      ok: true,
      kind,
      states: report.states,
      totalStates: report.totalStates,
      sampled: report.sampled,
      ms: Date.now() - t0,
      results: report.results.map((r) => ({
        name: r.name,
        pass: r.pass,
        level: r.level,
        failures: r.failures,
        ...(r.counterexample ? { counterexample: parseCounterexample(r.counterexample) } : {}),
        ...(r.detail ? { detail: r.detail } : {}),
      })),
      findings,
    };
  }
  if (kind === 'spice') {
    const backend = await findNgspice();
    if (!backend) {
      return { ok: false, error: 'ngspice is not available: install it, or Docker to run it in a container', status: 503 };
    }
    const boards: Record<string, Board> = { [ctx.doc.board.name]: ctx.doc.board };
    for (const [name, p] of Object.entries((raw.boards as Record<string, string> | undefined) ?? {})) {
      boards[name] = parseBoard(await readFile(isAbsolute(p) ? p : resolve(baseDir, p), 'utf8'));
    }
    const runs: { template: string; summary: string[] }[] = [];
    const findings: CheckFinding[] = [];
    const t0 = Date.now();
    for (const r of raw.runs as { template: string; config?: unknown; params?: Record<string, number> }[]) {
      const res = await runSpiceTemplate(r.template, boards, r.config ?? {}, r.params, { backend });
      runs.push({ template: r.template, summary: res.summary.split('\n').filter((l) => l.trim() !== '') });
      findings.push(...res.findings);
    }
    return { ok: true, kind, backend: backend.kind, ms: Date.now() - t0, runs, findings };
  }
  return { ok: false, error: `${basename(path)} is neither a logic spec nor a SPICE config`, status: 400 };
}

/**
 * "a=0, b=Z, c=1" -> { a: '0', b: 'Z', c: '1' }. A counterexample that is not
 * a list of assignments (e.g. "never the only low one: ...") comes back
 * under the key "detail".
 */
export function parseCounterexample(text: string): Record<string, string> {
  const parts = text.split(/,\s*/);
  const out: Record<string, string> = {};
  for (const p of parts) {
    const m = /^(.+?)=(.+)$/.exec(p.trim());
    if (!m) return { detail: text };
    out[m[1]!] = m[2]!;
  }
  return out;
}

/** Handle a Checks-workspace route. Returns false when the route is not one of ours. */
export async function handleChecksApi(
  ctx: McpContext,
  method: string,
  pathname: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const doc = ctx.doc;

  if (method === 'GET' && pathname === '/api/checks') {
    sendJSON(res, 200, { ok: true, checks: checkList() });
    return true;
  }

  if (method === 'GET' && pathname === '/api/checks/run') {
    const param = url.searchParams.get('only');
    const only = param ? param.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const board = doc.board;
    const t0 = Date.now();
    try {
      const findings = await runSelected(ctx, board, only);
      const { kept, waived } = applyWaivers(findings, board.checkWaivers);
      sendJSON(res, 200, {
        ok: true,
        sha: sha256(serializeBoard(board)),
        ms: Date.now() - t0,
        findings: kept,
        waived: waived satisfies { finding: CheckFinding; waiver: CheckWaiver }[],
      });
    } catch (e) {
      sendJSON(res, e instanceof UnknownCheckError ? 400 : 500, { ok: false, error: msg(e) });
    }
    return true;
  }

  if (method === 'GET' && pathname === '/api/sim/specs') {
    const backend = await findNgspice();
    sendJSON(res, 200, {
      ok: true,
      specs: doc.filePath ? await listSimSpecs(dirname(doc.filePath)) : [],
      templates: Object.values(SPICE_TEMPLATES).map((t) => ({ name: t.name, description: t.title, config: t.configHelp })),
      spice: backend
        ? { available: true, backend: backend.kind }
        : { available: false, reason: 'neither ngspice nor Docker is available on the server' },
    });
    return true;
  }

  if (method === 'POST' && pathname === '/api/sim/run') {
    let body: { path?: unknown };
    try {
      const raw = await readBody(req);
      body = raw ? (JSON.parse(raw) as { path?: unknown }) : {};
    } catch {
      sendJSON(res, 400, { ok: false, error: 'invalid JSON body' });
      return true;
    }
    if (typeof body.path !== 'string' || body.path === '') {
      sendJSON(res, 400, { ok: false, error: 'body must be { path } naming a spec from /api/sim/specs' });
      return true;
    }
    if (!doc.filePath) {
      sendJSON(res, 400, { ok: false, error: 'the board has not been saved yet, so there is no directory to read specs from' });
      return true;
    }
    try {
      const path = await resolveInside(dirname(doc.filePath), body.path);
      const out = await runSpec(ctx, path);
      const { status, ...rest } = out as { status?: number };
      sendJSON(res, out.ok ? 200 : (status ?? 400), rest);
    } catch (e) {
      sendJSON(res, e instanceof PathError ? 403 : 500, { ok: false, error: msg(e) });
    }
    return true;
  }

  if (method === 'GET' && pathname === '/api/export.print') {
    const paperParam = url.searchParams.get('paper') ?? 'a4';
    if (paperParam !== 'a4' && paperParam !== 'letter') {
      sendJSON(res, 400, { ok: false, error: 'paper must be a4 or letter' });
      return true;
    }
    try {
      const board = doc.board;
      const source = doc.filePath ? basename(doc.filePath) : undefined;
      const pdf = writePdf(
        printPages(board, { paper: paperParam as Paper, ...(source ? { source } : {}) }),
        `${board.name} 1:1 print`,
      );
      const name = `${(board.name || 'board').replace(/[^\w.-]+/g, '_')}.print.pdf`;
      res.writeHead(200, {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="${name}"`,
        'content-length': String(pdf.length),
      });
      res.end(pdf);
    } catch (e) {
      sendJSON(res, 500, { ok: false, error: `export_print failed: ${msg(e)}` });
    }
    return true;
  }

  return false;
}

