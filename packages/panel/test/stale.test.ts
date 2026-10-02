import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializeBoard } from '@flamingo/engine';
import { newPanel } from '../src/panel.js';
import { applyPanelOp } from '../src/ops.js';
import { hashBoard } from '../src/node/hash.js';
import { clearSourceCache, relativeSourcePath, resolveSources } from '../src/node/load.js';
import type { Panel } from '../src/types.js';
import { LIMITS, plainBoard } from './helpers.js';

describe('source resolution and stale detection', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'flamingo-panel-stale-'));
    await mkdir(join(dir, 'boards'));
    clearSourceCache();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function panelWith(path: string, hash: string): Promise<Panel> {
    const r = applyPanelOp(newPanel('p'), { op: 'addSource', source: { path, hash, name: 'sensor' } });
    if (!r.ok) throw new Error(r.error);
    return r.panel;
  }

  it('hashes content, not formatting', () => {
    const board = plainBoard('sensor', 20, 10);
    const reparsed = JSON.parse(JSON.stringify(board));
    expect(hashBoard(reparsed)).toBe(hashBoard(board));
    expect(hashBoard(board)).toMatch(/^sha256:[0-9a-f]{64}$/);
    const moved = structuredClone(board);
    moved.components[0]!.at.x += 0.5;
    expect(hashBoard(moved)).not.toBe(hashBoard(board));
  });

  it('a source whose board is unchanged is not stale', async () => {
    const board = plainBoard('sensor', 20, 10);
    await writeFile(join(dir, 'boards', 'sensor.flamingo'), serializeBoard(board));
    const panel = await panelWith('boards/sensor.flamingo', hashBoard(board));
    const [src] = await resolveSources(panel, dir, LIMITS);
    expect(src).toMatchObject({ key: 'S', stale: false, name: 'sensor' });
    expect(src!.error).toBeUndefined();
    expect(src!.geometry).toMatchObject({ width: 20, height: 10 });
  });

  it('re-indenting the board file does not make it stale', async () => {
    const board = plainBoard('sensor', 20, 10);
    await writeFile(join(dir, 'boards', 'sensor.flamingo'), JSON.stringify(board));
    const panel = await panelWith('boards/sensor.flamingo', hashBoard(board));
    const [src] = await resolveSources(panel, dir, LIMITS);
    expect(src!.stale).toBe(false);
  });

  it('editing the board marks the source stale, and refreshing clears it', async () => {
    const file = join(dir, 'boards', 'sensor.flamingo');
    const board = plainBoard('sensor', 20, 10);
    await writeFile(file, serializeBoard(board));
    let panel = await panelWith('boards/sensor.flamingo', hashBoard(board));
    expect((await resolveSources(panel, dir, LIMITS))[0]!.stale).toBe(false);

    const edited = structuredClone(board);
    edited.components[0]!.at.x += 1;
    await writeFile(file, serializeBoard(edited));
    // Same size, and possibly the same mtime tick: force the mtime forward so
    // the cache key differs, as a real later edit would.
    const later = new Date(Date.now() + 5000);
    await utimes(file, later, later);

    const [stale] = await resolveSources(panel, dir, LIMITS);
    expect(stale!.stale).toBe(true);
    expect(stale!.hash).toBe(hashBoard(edited));
    expect(stale!.recordedHash).toBe(hashBoard(board));
    // A stale source still resolves to the board as it is now.
    expect(stale!.geometry).toBeDefined();

    const r = applyPanelOp(panel, { op: 'refreshSource', key: 'S', hash: stale!.hash! });
    if (!r.ok) throw new Error(r.error);
    panel = r.panel;
    expect((await resolveSources(panel, dir, LIMITS))[0]!.stale).toBe(false);
  });

  it('a missing board file is an error, not a crash', async () => {
    const panel = await panelWith('boards/gone.flamingo', 'sha256:00');
    const [src] = await resolveSources(panel, dir, LIMITS);
    expect(src!.error).toContain('cannot read "boards/gone.flamingo"');
    expect(src!.geometry).toBeUndefined();
    expect(src!.stale).toBe(false);
  });

  it('an unparseable board file is an error', async () => {
    await writeFile(join(dir, 'boards', 'bad.flamingo'), '{nope');
    const panel = await panelWith('boards/bad.flamingo', 'sha256:00');
    const [src] = await resolveSources(panel, dir, LIMITS);
    expect(src!.error).toContain('Invalid JSON');
  });

  it('a board without an outline is an error', async () => {
    const board = plainBoard('bare', 20, 10);
    board.outline = [];
    await writeFile(join(dir, 'boards', 'bare.flamingo'), serializeBoard(board));
    const panel = await panelWith('boards/bare.flamingo', hashBoard(board));
    const [src] = await resolveSources(panel, dir, LIMITS);
    expect(src!.error).toContain('has no outline');
  });

  it('stores board paths relative to the panel directory', () => {
    expect(relativeSourcePath(dir, join(dir, 'boards', 'a.flamingo'))).toBe('boards/a.flamingo');
    expect(relativeSourcePath(dir, 'boards/a.flamingo')).toBe('boards/a.flamingo');
    expect(relativeSourcePath(join(dir, 'panels'), join(dir, 'boards', 'a.flamingo'))).toBe('../boards/a.flamingo');
  });
});
