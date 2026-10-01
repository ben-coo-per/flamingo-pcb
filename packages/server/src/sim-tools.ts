/**
 * Simulation MCP tools: SPICE netlist export and runs, and logic simulation.
 *
 * Registered next to the board tools (see mcp.ts). Like run_drc, results are
 * findings reported as data; `isError` is only for real failures (a missing
 * board file, a config that names nets the board lacks, ngspice crashing).
 * A missing ngspice is reported as a skip, not an error.
 *
 * Other boards are named by file path, resolved against the config or spec
 * file's directory when one is given, else the project directory. The open
 * board is always available under its own name.
 */

import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  SPICE_TEMPLATES,
  buildSpiceCircuit,
  exportSpice,
  formatFindings,
  parseBoard,
  simulateLogic,
  type Board,
  type CheckFinding,
  type LogicSpec,
  type PinLookup,
  type SpiceParamOverrides,
} from '@flamingo/engine';
import { symbolPinsFromCache } from '@flamingo/parts';
import type { McpContext } from './mcp.js';
import { describeBackend, findNgspice, runSpiceNetlist, runSpiceTemplate } from './spice-runner.js';

export const SIM_TOOL_NAMES = ['export_spice', 'run_spice', 'simulate_logic'] as const;

function text(t: string): CallToolResult {
  return { content: [{ type: 'text', text: t }] };
}

function error(e: string): CallToolResult {
  return { content: [{ type: 'text', text: `ERROR: ${e}` }], isError: true };
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function loadBoard(path: string): Promise<Board> {
  return parseBoard(await readFile(path, 'utf8'));
}

/** The open board under its name, plus each named board file. */
async function loadBoards(ctx: McpContext, files: Record<string, string> | undefined, baseDir: string): Promise<Record<string, Board>> {
  const out: Record<string, Board> = { [ctx.doc.board.name]: ctx.doc.board };
  for (const [name, p] of Object.entries(files ?? {})) {
    out[name] = await loadBoard(isAbsolute(p) ? p : resolve(baseDir, p));
  }
  return out;
}

/** Symbol pin names for every part on these boards, from the parts cache only. */
export async function pinLookupFor(boards: Board[]): Promise<PinLookup> {
  const pins = await symbolPinsFromCache(boards.flatMap((b) => b.components.map((c) => c.lcsc)));
  return (lcsc) => pins.get(lcsc);
}

const templateNames = Object.keys(SPICE_TEMPLATES) as [string, ...string[]];
const templateHelp = Object.values(SPICE_TEMPLATES)
  .map((t) => `${t.name}: ${t.title} (config: ${t.configHelp})`)
  .join('; ');

interface SpiceRunSpec {
  template: string;
  config?: unknown;
  params?: SpiceParamOverrides;
}

export function registerSimTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    'export_spice',
    {
      description:
        'Write a SPICE netlist from the board. Without a template: the passive parts (R, C, L, D, fuses) on the given nets, values from the board, unreadable values as .params to fill in, ground nets as node 0; add sources and an analysis to simulate. With a template: the complete ngspice decks that run_spice would run. ' +
        `Templates: ${templateHelp}.`,
      inputSchema: {
        nets: z.array(z.string()).optional().describe('Nets to export (default: every net). Ignored with a template.'),
        template: z.enum(templateNames).optional().describe('A SPICE template to build instead of a plain netlist'),
        config: z.record(z.string(), z.unknown()).optional().describe("The template's config: boards by name, and net names"),
        boards: z
          .record(z.string(), z.string())
          .optional()
          .describe('Other boards the template uses: name -> .flamingo path (relative to the project). The open board is always present under its own name.'),
        params: z.record(z.string(), z.number()).optional().describe('Overrides for assumed values (SPICE_PARAMS keys), e.g. {"ribbon_len_a": 1.2}'),
      },
    },
    async ({ nets, template, config, boards, params }) => {
      try {
        if (!template) {
          const pins = await pinLookupFor([ctx.doc.board]);
          return text(exportSpice(ctx.doc.board, { ...(nets ? { nets } : {}), pins }));
        }
        const all = await loadBoards(ctx, boards, ctx.projectDir);
        const c = buildSpiceCircuit(template, all, config ?? {}, params);
        const parts = c.sims.map((s) => `* ===== deck ${s.name}.cir =====\n${s.netlist}`);
        return text([`* ${c.title}`, ...c.inputs.map(([w, s]) => `* from the board: ${w}: ${s}`), ...parts].join('\n'));
      } catch (e) {
        return error(msg(e));
      }
    },
  );

  server.registerTool(
    'run_spice',
    {
      description:
        'Run SPICE checks in ngspice (local, or in Docker when ngspice is not installed) and report findings with limits and sources. Give a template and its config, or configPath (a JSON file {boards: {name: path}, runs: [{template, config, params}]}, board paths relative to it), or a hand-written netlist whose .measure results are reported. ' +
        `Templates: ${templateHelp}. Reports a skip when neither ngspice nor Docker is available.`,
      inputSchema: {
        template: z.enum(templateNames).optional().describe('Template to run'),
        config: z.record(z.string(), z.unknown()).optional().describe("The template's config"),
        boards: z.record(z.string(), z.string()).optional().describe('Other boards: name -> .flamingo path (relative to the project)'),
        params: z.record(z.string(), z.number()).optional().describe('Overrides for assumed values'),
        configPath: z.string().optional().describe('JSON file with boards and a list of runs (relative to the project)'),
        netlist: z.string().optional().describe('A complete ngspice deck to run as-is; its .measure results are reported'),
        quiet: z.boolean().optional().describe('Leave out INFO findings (default false)'),
      },
    },
    async ({ template, config, boards, params, configPath, netlist, quiet }) => {
      const backend = await findNgspice();
      if (!backend) return text('SKIPPED: ngspice is not available. Install ngspice, or Docker to run it in a container.');
      try {
        if (netlist) {
          const r = await runSpiceNetlist(netlist, { backend });
          const tail = r.log.trim().split('\n').slice(-30).join('\n');
          return text(`Ran with ${describeBackend(r.backend)}.\n${formatFindings(r.findings, { quiet: quiet ?? false })}\n\nLog (last lines):\n${tail}`);
        }
        let runs: SpiceRunSpec[];
        let all: Record<string, Board>;
        if (configPath) {
          const path = isAbsolute(configPath) ? configPath : resolve(ctx.projectDir, configPath);
          const spec = JSON.parse(await readFile(path, 'utf8')) as { boards?: Record<string, string>; runs?: SpiceRunSpec[] };
          if (!Array.isArray(spec.runs) || spec.runs.length === 0) return error(`${configPath}: no runs`);
          all = await loadBoards(ctx, spec.boards, dirname(path));
          runs = spec.runs;
        } else {
          if (!template) return error('give a template, a configPath, or a netlist');
          all = await loadBoards(ctx, boards, ctx.projectDir);
          runs = [{ template, config: config ?? {}, ...(params ? { params } : {}) }];
        }
        const findings: CheckFinding[] = [];
        const summaries: string[] = [];
        for (const r of runs) {
          const res = await runSpiceTemplate(r.template, all, r.config ?? {}, r.params, { backend });
          findings.push(...res.findings);
          summaries.push(res.summary);
        }
        return text(`Ran with ${describeBackend(backend)}.\n\n${summaries.join('\n')}\n${formatFindings(findings, { quiet: quiet ?? false })}`);
      } catch (e) {
        return error(msg(e));
      }
    },
  );

  server.registerTool(
    'simulate_logic',
    {
      description:
        'Simulate the digital control logic of one or more boards joined by cables, over every combination of free signals (MCU pins, MCP23017 registers: 0, 1 or Z), and check declared invariants in each state. Modelled from symbol pin names: MCP23017, 74HC154, 74HC4067, 74x125, single gates (1G86/08/32/00/02); resistors over 100 ohm are pulls, smaller ones wires. ' +
        'Spec: {instances: [{name, board: path or "." for the open board, fitted?: [jumper refs], supplies?: {net: "1"}}], links?: [{from: "inst:J5", to: ["inst:J6"], map?: "straight"}], free: [{net: "inst:U1.IO6"} | {register: "inst*:U2", pins: [..] | "connected"}], invariants: [{name, assert: Cond, when?: Cond, level?} | {name, selectFollows: {enable: "b*:XL{i}.1", mux: "b*:U4", channel: "b*:XL{i}.4"}} | {name, eachCanBeLowAlone: sel}]}. ' +
        'Cond: {net: sel, is: level(s)} | {anyLow|noneLow|atMostOneLow|noneFloating: sel} | {atMostOneConnected: mux sel} | {all|any: [Cond]} | {not: Cond}. Selectors: "inst:NET", "inst*:REF*.PIN" (glob; PIN is a pad number or symbol pin name).',
      inputSchema: {
        spec: z.record(z.string(), z.unknown()).optional().describe('The logic spec (see the description)'),
        specPath: z.string().optional().describe('A JSON file holding the spec; board paths in it are relative to the file'),
        maxStates: z.number().int().positive().optional().describe('Sample instead of enumerating past this many states (default 2,000,000)'),
        quiet: z.boolean().optional().describe('Leave out INFO findings (default false)'),
      },
    },
    async ({ spec, specPath, maxStates, quiet }) => {
      try {
        let raw: Record<string, unknown>;
        let baseDir = ctx.projectDir;
        if (specPath) {
          const path = isAbsolute(specPath) ? specPath : resolve(ctx.projectDir, specPath);
          raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
          baseDir = dirname(path);
        } else if (spec) {
          raw = spec;
        } else {
          return error('give a spec or a specPath');
        }
        const resolved = await resolveLogicSpec(raw, ctx.doc.board, baseDir);
        const pins = await pinLookupFor(resolved.instances.map((i) => i.board));
        const t0 = Date.now();
        const { report, findings } = simulateLogic(resolved, { pins, ...(maxStates ? { maxStates } : {}) });
        const head = `${report.sampled ? `Sampled ${report.states} of ${report.totalStates}` : `Checked all ${report.states}`} states in ${((Date.now() - t0) / 1000).toFixed(1)} s.`;
        return text(`${head}\n${formatFindings(findings, { quiet: quiet ?? false })}`);
      } catch (e) {
        return error(msg(e));
      }
    },
  );
}

/** Turn a JSON logic spec (boards as paths) into a LogicSpec (boards loaded). */
export async function resolveLogicSpec(raw: Record<string, unknown>, openBoard: Board, baseDir: string): Promise<LogicSpec> {
  const instances = raw.instances;
  if (!Array.isArray(instances) || instances.length === 0) throw new Error('spec.instances must list at least one board instance');
  const cache = new Map<string, Board>();
  const out = [];
  for (const i of instances as Record<string, unknown>[]) {
    const ref = i.board;
    let board: Board;
    if (ref === undefined || ref === '.') board = openBoard;
    else if (typeof ref === 'string') {
      const path = isAbsolute(ref) ? ref : resolve(baseDir, ref);
      if (!cache.has(path)) cache.set(path, await loadBoard(path));
      board = cache.get(path)!;
    } else throw new Error(`instance ${String(i.name)}: board must be a path or "."`);
    out.push({ ...(i as object), board } as LogicSpec['instances'][number]);
  }
  return {
    instances: out,
    links: (raw.links as LogicSpec['links']) ?? [],
    free: (raw.free as LogicSpec['free']) ?? [],
    invariants: (raw.invariants as LogicSpec['invariants']) ?? [],
    ...(raw.checkContention !== undefined ? { checkContention: Boolean(raw.checkContention) } : {}),
  };
}
