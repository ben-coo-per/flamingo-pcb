import { EventEmitter } from 'node:events';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Board, Op, OpError, OpResult } from '@flamingo/engine';
import { applyOp, parseBoard, serializeBoard } from '@flamingo/engine';
import type { RouteStatus } from './autoroute.js';

const UNDO_CAP = 200;
const DEFAULT_DEBOUNCE_MS = 500;

/**
 * In-memory document host wrapping a Board with undo/redo and optional
 * debounced disk persistence.
 *
 * Snapshot safety: `applyOp` structuredClone()s the board on every call, so
 * boards pushed onto the undo/redo stacks are never mutated by later
 * operations -- a value returned by `undo()`/`redo()` stays exactly as it
 * was even after further `apply()` calls.
 */
export class Doc extends EventEmitter {
  private _board: Board;
  private _filePath: string | undefined;
  private readonly debounceMs: number;
  private undoStack: Board[] = [];
  private redoStack: Board[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  /** Bumped on every board mutation; lets a finishing save() tell whether the
   *  board it just wrote is still current (see doSave). */
  private version = 0;
  /** Every save() call chains onto this so writes to `_filePath` happen one
   *  at a time, in call order -- otherwise two overlapping saves can race
   *  their rename() calls and leave an older board's content on disk. */
  private saveChain: Promise<void> = Promise.resolve();
  private _lastSaveError: string | undefined;

  constructor(initial: Board, filePath?: string, debounceMs: number = DEFAULT_DEBOUNCE_MS) {
    super();
    this._board = initial;
    this._filePath = filePath;
    this.debounceMs = debounceMs;
  }

  get board(): Board {
    return this._board;
  }

  /** The board's current on-disk path, if any (set by the constructor/resetBoard). */
  get filePath(): string | undefined {
    return this._filePath;
  }

  /** Error message from the most recent save attempt (direct or debounced), or
   *  undefined if the last attempt (if any) succeeded. Surfaced in
   *  get_board_state so a failing debounced save isn't silently lost. */
  get lastSaveError(): string | undefined {
    return this._lastSaveError;
  }

  /**
   * Emit a transient autoroute progress/terminal status. Not document state
   * (no undo, no persistence) -- it rides the same emitter as 'change' so the
   * HTTP layer can fan it out to every websocket client (see attachWebSocket).
   */
  emitRouteStatus(status: RouteStatus): void {
    this.emit('routeStatus', status);
  }

  /**
   * Apply an Op to the current board. On success: push the pre-op board
   * onto the undo stack (capped at 200), clear the redo stack, emit
   * 'change' with the new board, and (if constructed with a filePath)
   * schedule a debounced save. Returns the OpResult/OpError from applyOp
   * unchanged.
   */
  apply(op: Op): OpResult | OpError {
    const result = applyOp(this._board, op);
    if (result.ok) {
      this.pushUndo(this._board);
      this.redoStack = [];
      this._board = result.board;
      this.version++;
      this.markDirty();
      this.emit('change', this._board);
      this.scheduleSave();
    }
    return result;
  }

  undo(): Board | null {
    const prev = this.undoStack.pop();
    if (prev === undefined) return null;
    this.redoStack.push(this._board);
    this._board = prev;
    this.version++;
    this.markDirty();
    this.emit('change', this._board);
    this.scheduleSave();
    return this._board;
  }

  redo(): Board | null {
    const next = this.redoStack.pop();
    if (next === undefined) return null;
    this.pushUndo(this._board);
    this._board = next;
    this.version++;
    this.markDirty();
    this.emit('change', this._board);
    this.scheduleSave();
    return this._board;
  }

  /**
   * Replace the entire board (and, optionally, the file path future saves
   * target), discarding undo/redo history. Used by the MCP new_board/
   * open_board tools, which point a *running* server at a different board --
   * every other route/socket keeps referencing this same Doc instance, so
   * this mutates state in place rather than requiring a new Doc.
   *
   * `persist` (default true) controls whether this swap marks the doc dirty
   * and schedules a debounced save -- new_board wants that (it's creating
   * content that needs to land on disk), but open_board is a pure read of an
   * already-on-disk file and must not trigger a rewrite of the file it just
   * read. Either way the board is swapped and 'change' is emitted.
   */
  resetBoard(board: Board, filePath?: string, persist = true): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this._board = board;
    this.version++;
    if (filePath !== undefined) this._filePath = filePath;
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    if (persist) this.markDirty();
    this.emit('change', this._board);
    if (persist) this.scheduleSave();
  }

  /**
   * Snapshot the undo stack depth so a multi-`apply()` pipeline (e.g.
   * autoroute) can later collapse everything it did into one undo step
   * (`collapseUndo`) or unwind it entirely on failure (`restoreUndo`).
   */
  undoMark(): number {
    return this.undoStack.length;
  }

  /**
   * Merge every undo entry pushed since `mark` into a single one, so a whole
   * multi-op pipeline undoes in one `undo()` call instead of one call per
   * internal op. No-op if nothing was applied since `mark`.
   */
  collapseUndo(mark: number): void {
    if (this.undoStack.length > mark + 1) this.undoStack.length = mark + 1;
  }

  /**
   * Roll the board back to exactly how it was at `mark`, discarding every op
   * applied since (and the undo entries they pushed) as if the pipeline never
   * ran. Used to abort a multi-op pipeline that fails partway through. No-op
   * if nothing was applied since `mark`.
   */
  restoreUndo(mark: number): void {
    if (this.undoStack.length <= mark) return;
    const target = this.undoStack[mark]!;
    this.undoStack.length = mark;
    this.redoStack = [];
    this._board = target;
    this.version++;
    this.markDirty();
    this.emit('change', this._board);
    this.scheduleSave();
  }

  private markDirty(): void {
    if (this._filePath) this.dirty = true;
  }

  private pushUndo(board: Board): void {
    this.undoStack.push(board);
    if (this.undoStack.length > UNDO_CAP) this.undoStack.shift();
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

  /**
   * Force an immediate, atomic write (write tmp file + rename). Throws if no
   * filePath is set -- there is nothing to write to, and silently succeeding
   * would let callers (e.g. the save_board MCP tool) report "Saved." having
   * written nothing. Also throws on write failure -- direct callers (HTTP
   * /api/save, close()) still see the rejection via the returned promise;
   * the debounced path installed by scheduleSave() catches instead (and
   * never fires without a filePath in the first place -- see scheduleSave).
   *
   * Chains onto `saveChain` so two save() calls in flight at once (a manual
   * save racing the debounce timer, or two quick manual saves) write and
   * rename in call order instead of racing -- otherwise the write that
   * finishes last always wins, even if it started first and captured an
   * older board. `lastSaveError` reflects the outcome of whichever save()
   * call most recently settled, so a failing debounced save is remembered
   * instead of silently vanishing (see get_board_state in mcp.ts).
   */
  save(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this._filePath) return Promise.reject(new Error('no file path set — cannot save'));
    const task = this.saveChain.then(() => this.doSave());
    this.saveChain = task.then(
      () => {
        this._lastSaveError = undefined;
      },
      (err: unknown) => {
        this._lastSaveError = err instanceof Error ? err.message : String(err);
      },
    );
    return task;
  }

  /** The actual write, run strictly after any earlier queued save (see save()). */
  private async doSave(): Promise<void> {
    const filePath = this._filePath;
    if (!filePath) throw new Error('no file path set — cannot save');
    const versionAtSerialize = this.version;
    const data = serializeBoard(this._board);
    const tmpPath = `${filePath}.tmp-${randomUUID()}`;
    await writeFile(tmpPath, data, 'utf8');
    await rename(tmpPath, filePath);
    // Only clear dirty if nothing changed since we serialized -- an apply()
    // that landed while this write was in flight already re-armed its own
    // debounced save (or will be caught by a later close()), so clearing
    // dirty here would make that edit look already-saved when it isn't.
    if (this.version === versionAtSerialize) this.dirty = false;
  }

  /**
   * Retarget the document at a new path and write there immediately ("save
   * as"). The board and undo/redo history carry over untouched -- only the
   * destination of this and all future saves changes. The old file is left
   * as it was last written.
   */
  async saveAs(filePath: string): Promise<void> {
    this._filePath = filePath;
    await this.save();
  }

  /**
   * Cancel any pending debounced save and, if there are unsaved changes,
   * flush them synchronously with respect to the caller. Safe to call
   * multiple times or with nothing dirty (no-op write in that case). Only
   * attempts the flush when a filePath is set -- markDirty() never sets
   * dirty without one, so this is belt-and-suspenders against save()'s new
   * throw-without-a-filePath behavior, keeping close() on an unpathed Doc a
   * clean no-op rather than a rejection.
   */
  async close(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty && this._filePath) {
      await this.save();
    }
  }

  static async load(filePath: string): Promise<Doc> {
    const data = await readFile(filePath, 'utf8');
    const board = parseBoard(data);
    return new Doc(board, filePath);
  }
}
