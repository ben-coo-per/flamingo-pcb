/**
 * Flamingo Panel - the view a client draws.
 *
 * Derived by the server from the panel and its source boards after every
 * change, and pushed to every connected browser. Plain data: it crosses the
 * WebSocket as JSON, so the browser draws exactly what MCP reads.
 */

import type { PanelIssue } from './check.js';
import type { PanelGeometry } from './geometry.js';
import type { PanelQuote } from './order.js';
import type { SourceGeometry } from './source.js';
import type { Panel } from './types.js';

/** A source as a client needs it: geometry and status, never the whole board. */
export interface SourceView {
  key: string;
  path: string;
  name: string;
  stale: boolean;
  error?: string;
  needed: number;
  niceToHave: number;
  instances: number;
  populated: number;
  geometry?: Omit<SourceGeometry, 'parts'> & { partLines: number; extendedParts: number };
}

export interface LimitView {
  label: string;
  width: number;
  height: number;
  /** false = an estimate or a design choice. */
  verified: boolean;
  source: string;
  /** This is the limit arrange packs against. */
  binding: boolean;
}

export interface PanelView {
  panel: Panel;
  filePath: string | null;
  canUndo: boolean;
  canRedo: boolean;
  sources: SourceView[];
  geometry: PanelGeometry;
  issues: PanelIssue[];
  quote: PanelQuote;
  limits: LimitView[];
  /** Layer count the panel will be made at; null while the boards disagree. */
  layers: 2 | 4 | 6 | null;
  /** Milliseconds it took to derive this view. */
  derivedMs: number;
  /** Counts up on every change, so a client can drop views that arrive late. */
  revision: number;
}
