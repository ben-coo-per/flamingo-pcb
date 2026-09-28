import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newPanel, parsePanel, serializePanel } from '@flamingo/panel';
import { PanelDoc } from '../src/panel/doc.js';

const ADD = { op: 'addSource', source: { path: 'a.flamingo', hash: 'h', name: 'alpha' } } as const;

describe('PanelDoc', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'flamingo-paneldoc-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('apply emits change, and undo/redo walk the op log', () => {
    const doc = new PanelDoc(newPanel('p'));
    const seen: number[] = [];
    doc.on('change', (p) => seen.push(p.instances.length));

    expect(doc.apply(ADD).ok).toBe(true);
    expect(doc.apply({ op: 'addInstance', source: 'A' }).ok).toBe(true);
    expect(doc.panel.instances).toHaveLength(1);
    expect(doc.canUndo).toBe(true);

    expect(doc.undo()!.instances).toHaveLength(0);
    expect(doc.canRedo).toBe(true);
    expect(doc.redo()!.instances).toHaveLength(1);
    expect(doc.redo()).toBeNull();
    expect(seen).toEqual([0, 1, 0, 1]);
  });

  it('a rejected op changes nothing and emits nothing', () => {
    const doc = new PanelDoc(newPanel('p'));
    let changes = 0;
    doc.on('change', () => changes++);
    const r = doc.apply({ op: 'removeInstance', id: 'X1' });
    expect(r.ok).toBe(false);
    expect(changes).toBe(0);
    expect(doc.canUndo).toBe(false);
  });

  it('save writes the panel atomically and load reads it back', async () => {
    const file = join(dir, 'p.flamingo-panel');
    const doc = new PanelDoc(newPanel('p'), file, 10_000);
    doc.apply(ADD);
    doc.apply({ op: 'addInstance', source: 'A', at: { x: 3, y: 4 } });
    await doc.save();

    expect(parsePanel(await readFile(file, 'utf8'))).toEqual(doc.panel);
    expect((await readdir(dir)).filter((f) => f.includes('.tmp-'))).toEqual([]);

    const loaded = await PanelDoc.load(file);
    expect(loaded.panel).toEqual(doc.panel);
    expect(loaded.filePath).toBe(file);
    expect(loaded.canUndo).toBe(false);
  });

  it('autosaves after the debounce', async () => {
    const file = join(dir, 'p.flamingo-panel');
    const doc = new PanelDoc(newPanel('p'), file, 20);
    doc.apply(ADD);
    await new Promise((r) => setTimeout(r, 80));
    expect(parsePanel(await readFile(file, 'utf8')).sources).toHaveLength(1);
  });

  it('close flushes a pending save', async () => {
    const file = join(dir, 'p.flamingo-panel');
    const doc = new PanelDoc(newPanel('p'), file, 10_000);
    doc.apply(ADD);
    await doc.close();
    expect(parsePanel(await readFile(file, 'utf8')).sources).toHaveLength(1);
  });

  it('save without a file path throws; close without one is a no-op', async () => {
    const doc = new PanelDoc(newPanel('p'));
    doc.apply(ADD);
    await expect(doc.save()).rejects.toThrow('no file path');
    await expect(doc.close()).resolves.toBeUndefined();
  });

  it('reset with persist=false does not rewrite the file it just read', async () => {
    const file = join(dir, 'p.flamingo-panel');
    const original = JSON.stringify(JSON.parse(serializePanel(newPanel('compact'))));
    await writeFile(file, original);
    const doc = new PanelDoc(newPanel('other'), undefined, 10);
    doc.apply(ADD);
    doc.reset(parsePanel(original), file, false);
    expect(doc.canUndo).toBe(false);
    expect(doc.panel.name).toBe('compact');
    await new Promise((r) => setTimeout(r, 60));
    await doc.close();
    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it('load rejects a board file', async () => {
    const file = join(dir, 'b.flamingo');
    await writeFile(file, JSON.stringify({ formatVersion: 1, name: 'b', outline: [] }));
    await expect(PanelDoc.load(file)).rejects.toThrow('Not a panel file');
  });
});
