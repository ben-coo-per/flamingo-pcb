/**
 * export_print: the board as 1:1 printable sheets (PDF, optionally SVG), for
 * test-fitting real parts on paper before ordering. See fab/src/print/.
 */

import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { exportPrint } from '@flamingo/fab';
import type { McpContext } from './mcp.js';

/** Explicit outDir (absolute, or under projectDir), else "<board file dir>/print". */
export function resolvePrintOutDir(ctx: McpContext, outDir?: string): string {
  if (outDir) return isAbsolute(outDir) ? outDir : join(ctx.projectDir, outDir);
  const base = ctx.doc.filePath ? dirname(ctx.doc.filePath) : ctx.projectDir;
  return join(base, 'print');
}

export function registerPrintTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    'export_print',
    {
      description:
        'Write the board as 1:1 printable sheets for test-fitting real parts on paper before ordering: <name>.print.pdf with the top side seen from above, the bottom side seen from below, and every distinct footprint unrotated with pad numbers and pin 1 marked. Copper, drills, holes and the exact fab legend are drawn; every page has 100 mm and 4 inch scale bars to check the printer. Print at 100 % ("Actual size"). Defaults outDir to "<directory of the current board file>/print".',
      inputSchema: {
        outDir: z
          .string()
          .optional()
          .describe('Output directory, absolute or relative to the project directory. Defaults to "<board file dir>/print"'),
        paper: z.enum(['a4', 'letter']).optional().describe('Paper size (default a4)'),
        svg: z.boolean().optional().describe('Also write one SVG per page (default false)'),
      },
    },
    async ({ outDir, paper, svg }) => {
      const target = resolvePrintOutDir(ctx, outDir);
      try {
        const source = ctx.doc.filePath ? ctx.doc.filePath.split(/[\\/]/).pop() : undefined;
        const r = await exportPrint(ctx.doc.board, target, {
          ...(paper ? { paper } : {}),
          ...(svg ? { svg } : {}),
          ...(source ? { source } : {}),
        });
        const lines = [`Wrote ${r.pages} page(s) to ${r.pdf}`, ...r.svgs.map((s) => `  ${s}`)];
        lines.push('Print at 100 % (Actual size) and measure the scale bars before trusting a fit.');
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `ERROR: export_print failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );
}
