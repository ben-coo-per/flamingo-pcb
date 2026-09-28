/**
 * Panel view - state.
 *
 * One object, replaced on every change, with synchronous subscribers: the
 * same scheme as the board editor's store (../state.ts), kept separate so the
 * two pages share nothing at run time.
 */

import type { Point } from '@flamingo/engine';
import type { PanelView, QuoteResult } from '@flamingo/panel';
import type { ViewTransform } from '../state.js';
import type { BoardFile } from './api.js';

export interface Drag {
  id: string;
  /** Offset of the instance from where it was picked up, mm. */
  dx: number;
  dy: number;
  /**
   * Set on drop: the instance stays drawn where it was dropped until a view
   * newer than this revision arrives, so it does not jump back for a frame.
   */
  droppedAt?: number;
}

export interface Message {
  text: string;
  /** A problem is framed more heavily than a note. */
  problem: boolean;
  /** Download link offered by the export. */
  link?: { href: string; name: string; label: string };
}

export interface PanelState {
  view: PanelView | null;
  connected: boolean;
  transform: ViewTransform;
  hasFit: boolean;
  /** Selected instance id. */
  selection: string | null;
  drag: Drag | null;
  cursorMm: Point | null;
  quote: QuoteResult | null;
  quoteError: string | null;
  /** Scenario whose fee lines are shown. */
  scenario: string | null;
  arrangeMsg: Message | null;
  exportMsg: Message | null;
  scenarioMsg: Message | null;
  boardMsg: Message | null;
  /** Board files in the project that could be added to the panel. */
  boardFiles: BoardFile[];
  /** Open context menu: the instance it is for and where, in plate pixels. */
  menu: { id: string; x: number; y: number } | null;
  busy: boolean;
}

function initial(): PanelState {
  return {
    view: null,
    connected: false,
    transform: { scale: 6, originPxX: 40, originPxY: 400, flipped: false },
    hasFit: false,
    selection: null,
    drag: null,
    cursorMm: null,
    quote: null,
    quoteError: null,
    scenario: null,
    arrangeMsg: null,
    exportMsg: null,
    scenarioMsg: null,
    boardMsg: null,
    boardFiles: [],
    menu: null,
    busy: false,
  };
}

type Listener = (state: PanelState, previous: PanelState) => void;

export class PanelStore {
  private state: PanelState = initial();
  private listeners = new Set<Listener>();

  get(): PanelState {
    return this.state;
  }

  set(patch: Partial<PanelState>): void {
    const previous = this.state;
    this.state = { ...previous, ...patch };
    for (const fn of this.listeners) fn(this.state, previous);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
