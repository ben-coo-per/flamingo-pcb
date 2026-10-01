/**
 * MCP tools for electrical checks (run_erc), and the helpers export_fab uses
 * to gate on them. Registered from createMcpServer with one call, so the
 * checks live apart from the board-editing tools.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { formatFindings, runErc, type Board, type CheckFinding } from '@flamingo/engine';
import { boardPinLookup, checksReport } from './checks.js';
import type { McpContext } from './mcp.js';

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

/** ERC findings for a board, with pin names from the context's loader (or the parts cache). */
export async function ercFindings(ctx: Pick<McpContext, 'loadSymbolPins'>, board: Board): Promise<CheckFinding[]> {
  const pins = await boardPinLookup(board, ctx.loadSymbolPins);
  return runErc(board, { pins });
}

/** Write the findings that gated (or passed) an export beside the fab files. */
export async function writeChecksReport(dir: string, board: Board, findings: CheckFinding[]): Promise<string> {
  const path = join(dir, 'checks.json');
  await writeFile(path, `${JSON.stringify(checksReport(board, findings), null, 2)}\n`, 'utf8');
  return path;
}

export function registerCheckTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    'run_erc',
    {
      description:
        'Run the electrical rules check (ERC) on the netlist. Uses each part\'s symbol pin names and a table of pin roles to check: IC power and ground pins connected to the right kind of net, single-pin nets, unconnected IC pins, floating logic inputs, decoupling capacitors on supply pins (within 10 mm by default), polarity of LEDs and diodes, ESP32-S3 strapping pins and EN delay, and USB-C CC pull-downs. Findings are reported as data (error / warn / info), never as a tool error; error findings make export_fab refuse unless waived. Deliberate exceptions go in board.checkWaivers with a reason.',
      inputSchema: {
        quiet: z.boolean().optional().describe('Leave out info findings (default false)'),
        decouplingMm: z.number().positive().optional().describe('Decoupling distance limit in mm (default 10)'),
      },
    },
    async ({ quiet, decouplingMm }) => {
      const board = ctx.doc.board;
      const pins = await boardPinLookup(board, ctx.loadSymbolPins);
      const findings = runErc(board, { pins, ...(decouplingMm !== undefined ? { decouplingMm } : {}) });
      if (findings.length === 0) return textResult('ERC clean: no findings.');
      return textResult(formatFindings(findings, { quiet: quiet ?? false }));
    },
  );
}
