/**
 * Run ngspice decks in batch mode: the local `ngspice` if it is on PATH,
 * otherwise in a Docker image (built on demand from docker/ngspice). Each run
 * gets its own working directory under ~/.cache/flamingo/spice (or
 * FLAMINGO_SPICE_DIR), removed afterwards unless `keep` is set: waveforms
 * can run to tens of MB and must not land in a repo or a RAM-backed /tmp.
 *
 * ngspice is an optional dependency. `findNgspice` returns null when neither
 * is available, and callers report that as a skip, not a failure.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  Wave,
  buildSpiceCircuit,
  parseMeasures,
  spiceSummary,
  type Board,
  type CheckFinding,
  type SpiceCircuit,
  type SpiceParamOverrides,
} from '@flamingo/engine';

const run = promisify(execFile);

export const DEFAULT_NGSPICE_IMAGE = 'flamingo-ngspice:latest';
const DOCKERFILE_DIR = fileURLToPath(new URL('../docker/ngspice/', import.meta.url));

export class SpiceRunError extends Error {}

export type NgspiceBackend = { kind: 'local'; command: string } | { kind: 'docker'; image: string };

async function ok(cmd: string, args: string[]): Promise<boolean> {
  try {
    await run(cmd, args, { timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * The ngspice to use: FLAMINGO_NGSPICE=local|docker forces one; otherwise a
 * local ngspice wins, then Docker (image FLAMINGO_NGSPICE_IMAGE, default
 * flamingo-ngspice:latest). Null when neither is available.
 */
export async function findNgspice(): Promise<NgspiceBackend | null> {
  const force = process.env.FLAMINGO_NGSPICE;
  if (force !== 'docker' && (await ok('ngspice', ['--version']))) return { kind: 'local', command: 'ngspice' };
  if (force === 'local') return null;
  if (await ok('docker', ['info'])) return { kind: 'docker', image: process.env.FLAMINGO_NGSPICE_IMAGE || DEFAULT_NGSPICE_IMAGE };
  return null;
}

export function describeBackend(b: NgspiceBackend): string {
  return b.kind === 'local' ? 'local ngspice' : `ngspice in Docker (${b.image})`;
}

async function ensureImage(image: string, rebuild = false): Promise<void> {
  if (!rebuild && (await ok('docker', ['image', 'inspect', image]))) return;
  if (!existsSync(join(DOCKERFILE_DIR, 'Dockerfile'))) throw new SpiceRunError(`no Dockerfile at ${DOCKERFILE_DIR}`);
  try {
    await run('docker', ['build', '-q', '-t', image, DOCKERFILE_DIR], { timeout: 600_000 });
  } catch (e) {
    throw new SpiceRunError(`docker build of ${image} failed: ${(e as { stderr?: string }).stderr?.slice(-2000) ?? String(e)}`);
  }
}

export interface DeckResult {
  log: string;
  /** Contents of <name>.csv when the deck wrote one with wrdata. */
  wrdata?: string;
}

export interface RunOpts {
  backend?: NgspiceBackend;
  /** Keep the working directory and return its path (default false). */
  keep?: boolean;
  rebuildImage?: boolean;
}

function spiceRoot(): string {
  return process.env.FLAMINGO_SPICE_DIR || join(homedir(), '.cache', 'flamingo', 'spice');
}

/** Lines of an ngspice log that mean the run is not to be trusted. */
export function logErrors(log: string): string[] {
  return log
    .split(/\r?\n/)
    .filter(
      (ln) =>
        /^\s*(Error|ERROR)\b/.test(ln) ||
        /\bfatal\b/i.test(ln) ||
        /\bmeas\w*\b.*\bfailed\b/i.test(ln) ||
        /is not available/.test(ln) ||
        /timestep too small/i.test(ln),
    );
}

/** Write each deck to <dir>/<name>.cir, run them all, return logs and waveforms. */
export async function runDecks(
  decks: Record<string, string>,
  opts: RunOpts = {},
): Promise<{ results: Record<string, DeckResult>; backend: NgspiceBackend; dir?: string }> {
  const backend = opts.backend ?? (await findNgspice());
  if (!backend) throw new SpiceRunError('ngspice is not available: install it, or Docker to run it in a container');
  const names = Object.keys(decks);
  for (const name of names) if (!/^[\w.-]+$/.test(name)) throw new SpiceRunError(`bad deck name ${name}`);
  await mkdir(spiceRoot(), { recursive: true });
  const dir = await mkdtemp(join(spiceRoot(), 'run-'));
  try {
    for (const name of names) await writeFile(join(dir, `${name}.cir`), decks[name]!);
    if (backend.kind === 'local') {
      for (const name of names) {
        let out = '';
        try {
          const r = await run(backend.command, ['-b', `${name}.cir`], { cwd: dir, timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
          out = r.stdout + r.stderr;
        } catch (e) {
          const x = e as { stdout?: string; stderr?: string };
          out = (x.stdout ?? '') + (x.stderr ?? '') + `\nError: ngspice exited abnormally: ${String(e)}`;
        }
        await writeFile(join(dir, `${name}.log`), out);
      }
    } else {
      await ensureImage(backend.image, opts.rebuildImage);
      const script = `for f in ${names.map((n) => `${n}.cir`).join(' ')}; do ngspice -b "$f" > "\${f%.cir}.log" 2>&1; done`;
      const uid = process.getuid?.() ?? 1000;
      const gid = process.getgid?.() ?? 1000;
      try {
        await run(
          'docker',
          ['run', '--rm', '--network', 'none', '-u', `${uid}:${gid}`, '-v', `${dir}:/work`, '--entrypoint', 'sh', backend.image, '-c', script],
          { timeout: 900_000, maxBuffer: 16 * 1024 * 1024 },
        );
      } catch (e) {
        throw new SpiceRunError(`docker run failed: ${(e as { stderr?: string }).stderr?.slice(-2000) ?? String(e)}`);
      }
    }
    const results: Record<string, DeckResult> = {};
    for (const name of names) {
      const logPath = join(dir, `${name}.log`);
      if (!existsSync(logPath)) throw new SpiceRunError(`${name}: ngspice wrote no log`);
      const log = await readFile(logPath, 'utf8');
      const csv = join(dir, `${name}.csv`);
      results[name] = { log, ...(existsSync(csv) ? { wrdata: await readFile(csv, 'utf8') } : {}) };
    }
    return { results, backend, ...(opts.keep ? { dir } : {}) };
  } finally {
    if (!opts.keep) await rm(dir, { recursive: true, force: true });
  }
}

export interface SpiceTemplateRun {
  circuit: SpiceCircuit;
  findings: CheckFinding[];
  summary: string;
  backend: NgspiceBackend;
  dir?: string;
}

/** Build a template's decks from the boards, run them, and evaluate the waveforms. */
export async function runSpiceTemplate(
  template: string,
  boards: Record<string, Board>,
  config: unknown,
  params?: SpiceParamOverrides,
  opts: RunOpts = {},
): Promise<SpiceTemplateRun> {
  const circuit = buildSpiceCircuit(template, boards, config, params);
  const decks = Object.fromEntries(circuit.sims.map((s) => [s.name, s.netlist]));
  const { results, backend, dir } = await runDecks(decks, opts);
  const waves: Record<string, Wave> = {};
  for (const [name, r] of Object.entries(results)) {
    const errors = logErrors(r.log);
    if (errors.length) throw new SpiceRunError(`${name}: ngspice reported:\n  ${errors.slice(0, 10).join('\n  ')}`);
    if (!r.wrdata) throw new SpiceRunError(`${name}: ngspice wrote no waveform`);
    waves[name] = Wave.parse(r.wrdata, name);
  }
  const { findings, summary } = circuit.evaluate(waves);
  return { circuit, findings, summary: spiceSummary(circuit, summary), backend, ...(dir ? { dir } : {}) };
}

/** Run a hand-written deck and report its .measure results as findings. */
export async function runSpiceNetlist(
  netlist: string,
  opts: RunOpts = {},
): Promise<{ measures: Record<string, number>; findings: CheckFinding[]; log: string; backend: NgspiceBackend }> {
  const { results, backend } = await runDecks({ deck: netlist }, opts);
  const log = results.deck!.log;
  const measures = parseMeasures(log);
  const findings: CheckFinding[] = [];
  // Failed measurements are reported per measurement below, not as deck errors.
  const failedMeasure = (x: string) => /\bmeas\w*\b.*\bfailed\b/i.test(x) || /^\s*Error:\s*measure\b/i.test(x);
  for (const e of logErrors(log).filter((x) => !failedMeasure(x))) {
    findings.push({ check: 'spice', rule: 'netlist', level: 'error', message: e.trim(), items: [] });
  }
  for (const [k, v] of Object.entries(measures)) {
    findings.push(
      Number.isNaN(v)
        ? { check: 'spice', rule: 'measure', level: 'warn', message: `measurement ${k} failed (its trigger or target was never reached)`, items: [k] }
        : { check: 'spice', rule: 'measure', level: 'info', message: `${k} = ${v}`, items: [k] },
    );
  }
  return { measures, findings, log, backend };
}
