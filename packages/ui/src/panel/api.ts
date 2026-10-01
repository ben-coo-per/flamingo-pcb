/**
 * Panel view - server calls. Same-origin paths only, so the page works behind
 * the Vite dev proxy and when served by the Flamingo server itself.
 */

import type { CheckFinding } from '@flamingo/engine';
import type { ArrangeResult, PanelOp, QuoteResult } from '@flamingo/panel';

export interface ApiError {
  ok: false;
  error: string;
  issues?: Array<{ severity: string; code: string; message: string }>;
}

async function post<T>(path: string, body: unknown = {}): Promise<T | ApiError> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as T | ApiError;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const api = {
  op: (op: PanelOp) => post<{ ok: true; created: string[] }>('/api/panel/op', op),
  undo: () => post<{ ok: boolean }>('/api/panel/undo'),
  redo: () => post<{ ok: boolean }>('/api/panel/redo'),
  arrange: () => post<ArrangeResult>('/api/panel/arrange'),
  count: (board: string, count: number) =>
    post<{ ok: true; added: string[]; removed: string[]; arranged: ArrangeResult | null }>('/api/panel/count', { board, count }),
  rotate: (id: string) => post<{ ok: true }>('/api/panel/rotate', { id, by: 90 }),
  duplicate: (id: string) => post<{ ok: true; created: string[] }>('/api/panel/duplicate', { id }),
  applyScenario: (id: string) => post<{ ok: true; loaded: boolean }>('/api/panel/apply-scenario', { id }),
  /** Accept source boards as they are on disk now, which clears `stale`. */
  refresh: (boards: string[]) => post<{ ok: true; refreshed: string[] }>('/api/panel/refresh', { boards }),

  async quote(): Promise<QuoteResult | ApiError> {
    try {
      const res = await fetch('/api/panel/quote?objective=total');
      return (await res.json()) as QuoteResult | ApiError;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  /** Run the export and return the zip, or the findings that stopped it. */
  async exportZip(): Promise<{ ok: true; blob: Blob; name: string } | ApiError> {
    try {
      const res = await fetch('/api/panel/export.zip');
      if (!res.ok) return (await res.json()) as ApiError;
      const disposition = res.headers.get('content-disposition') ?? '';
      const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'panel-fab.zip';
      return { ok: true, blob: await res.blob(), name };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

async function get<T>(path: string): Promise<T | ApiError> {
  try {
    const res = await fetch(path);
    return (await res.json()) as T | ApiError;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface BoardHeaders {
  key: string;
  name: string;
  headers: { refdes: string; pads: number; value: string }[];
  error?: string;
}

/** The cable check, and what the cable form needs to offer ends. */
export const cablesApi = {
  check: () => get<{ ok: true; findings: CheckFinding[] }>('/api/panel/interconnect'),
  headers: () => get<{ ok: true; boards: BoardHeaders[] }>('/api/panel/headers'),
};

export function isError(r: unknown): r is ApiError {
  return typeof r === 'object' && r !== null && (r as { ok?: unknown }).ok === false;
}

export interface BoardFile {
  /** Absolute path; what add-board takes. */
  path: string;
  name: string;
  mtimeMs: number;
  onPanel: boolean;
}

/** Board files in the project, newest first, each marked if it is on the panel already. */
export async function listBoards(): Promise<BoardFile[]> {
  try {
    const res = await fetch('/api/panel/files');
    const body = (await res.json()) as { ok?: boolean; boards?: BoardFile[] };
    return body.boards ?? [];
  } catch {
    return [];
  }
}

export function addBoard(path: string): Promise<{ ok: true; key: string; name: string } | ApiError> {
  return post<{ ok: true; key: string; name: string }>('/api/panel/add-board', { path });
}
