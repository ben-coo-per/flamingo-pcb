/**
 * Flamingo UI - fetch client for the checks routes. Every call resolves to
 * data or throws an Error carrying the server's `error` text, so callers show
 * one message whatever went wrong (network, 4xx, 5xx, bad JSON).
 */

import type {
  CheckInfo,
  CheckRunResult,
  Paper,
  SimRunResult,
  SimSpecsResponse,
  WaiverOp,
} from './types.js';

async function json<T>(res: Response): Promise<T> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(`${res.status} ${res.statusText}`.trim());
  }
  const b = body as { ok?: boolean; error?: string };
  if (!res.ok || b.ok === false) throw new Error(b.error ?? `${res.status} ${res.statusText}`.trim());
  return body as T;
}

export async function listChecks(): Promise<CheckInfo[]> {
  return (await json<{ checks: CheckInfo[] }>(await fetch('/api/checks'))).checks;
}

export async function runCheck(name: string): Promise<CheckRunResult> {
  return json<CheckRunResult>(await fetch(`/api/checks/run?only=${encodeURIComponent(name)}`));
}

export async function postWaiverOp(op: WaiverOp): Promise<void> {
  await json<unknown>(
    await fetch('/api/op', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(op) }),
  );
}

export async function listSimSpecs(): Promise<SimSpecsResponse> {
  return json<SimSpecsResponse>(await fetch('/api/sim/specs'));
}

export async function runSim(path: string): Promise<SimRunResult> {
  return json<SimRunResult>(
    await fetch('/api/sim/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    }),
  );
}

/** GET /api/export.print. Resolves to the PDF and the server's file name. */
export async function fetchPrint(paper: Paper): Promise<{ blob: Blob; disposition: string }> {
  const res = await fetch(`/api/export.print?paper=${paper}`);
  if (!res.ok) await json<unknown>(res); // throws with the server's message
  return { blob: await res.blob(), disposition: res.headers.get('content-disposition') ?? '' };
}
