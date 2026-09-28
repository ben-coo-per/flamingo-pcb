/**
 * In-memory host for a panel: the panel counterpart of `Doc` (document.ts).
 *
 * Same behaviour on purpose: an op that succeeds pushes the state it replaced
 * onto the undo stack, clears redo, emits 'change' and schedules a debounced
 * atomic save; open/new swap the panel in place and forget history. The
 * undo/redo bookkeeping itself is the generic `History` from @flamingo/panel.
 *
 * `Doc` was left untouched rather than rebuilt on `History`, so the board
 * editor cannot change behaviour because panels exist.
 */

import { EventEmitter } from 'node:events';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Panel, PanelOp, PanelOpError, PanelOpResult } from '@flamingo/panel';
import { applyPanelOp, History, parsePanel, serializePanel } from '@flamingo/panel';

const DEFAULT_DEBOUNCE_MS = 500;

export class PanelDoc extends EventEmitter {
  private history: History<Panel>;
  private _filePath: string | undefined;
  private readonly debounceMs: number;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(initial: Panel, filePath?: string, debounceMs: number = DEFAULT_DEBOUNCE_MS) {
    super();
    this.history = new History(initial);
    this._filePath = filePath;
    this.debounceMs = debounceMs;
  }

  get panel(): Panel {
    return this.history.state;
  }

  get filePath(): string | undefined {
    return this._filePath;
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  /** Apply an op. On success it becomes one undo step; on failure nothing changes. */
  apply(op: PanelOp): PanelOpResult | PanelOpError {
    const result = applyPanelOp(this.history.state, op);
    if (result.ok) {
      this.history.commit(result.panel);
      this.changed();
    }
    return result;
  }

  undo(): Panel | null {
    const prev = this.history.undo();
    if (prev !== null) this.changed();
    return prev;
  }

  redo(): Panel | null {
    const next = this.history.redo();
    if (next !== null) this.changed();
    return next;
  }

  /**
   * Swap in another panel (and optionally the path saves go to), forgetting
   * history. `persist` false is for opening a file that is already on disk:
   * reading a file must not rewrite it.
   */
  reset(panel: Panel, filePath?: string, persist = true): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.history.reset(panel);
    if (filePath !== undefined) this._filePath = filePath;
    this.dirty = false;
    if (persist && this._filePath) this.dirty = true;
    this.emit('change', this.panel);
    if (persist) this.scheduleSave();
  }

  /**
   * Tell listeners that something the panel depends on changed without the
   * panel itself changing (a source board was edited on disk).
   */
  touch(): void {
    this.emit('change', this.panel);
  }

  private changed(): void {
    if (this._filePath) this.dirty = true;
    this.emit('change', this.panel);
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (!this._filePath) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save().catch((err: unknown) => {
        console.error(`[flamingo] failed to save ${this._filePath}:`, err);
        this.emit('saveError', err);
      });
    }, this.debounceMs);
  }

  /** Write now, atomically (tmp file + rename). Throws without a file path. */
  async save(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this._filePath) throw new Error('no file path set — cannot save');
    const tmpPath = `${this._filePath}.tmp-${randomUUID()}`;
    await writeFile(tmpPath, serializePanel(this.panel), 'utf8');
    await rename(tmpPath, this._filePath);
    this.dirty = false;
  }

  /** Flush unsaved changes, if any. Safe to call repeatedly. */
  async close(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty && this._filePath) await this.save();
  }

  static async load(filePath: string): Promise<PanelDoc> {
    return new PanelDoc(parsePanel(await readFile(filePath, 'utf8')), filePath);
  }
}
