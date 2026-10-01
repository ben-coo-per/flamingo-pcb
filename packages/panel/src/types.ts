/**
 * Flamingo Panel - panel model types.
 * Units: mm. Coordinate system: y-up. Angles: degrees CCW (as in the engine).
 *
 * A panel is plain JSON (`.plamingo`), diff-friendly like a board. It
 * never embeds board content: source boards are referenced by path plus a
 * content hash, so editing a source board marks the panel stale instead of
 * silently fabricating an old copy.
 */

import type { Point } from '@flamingo/engine';

/** Instances sit on the panel at right angles only. */
export type Rotation = 0 | 90 | 180 | 270;

/** A side of an axis-aligned box: N = +y, E = +x, S = -y, W = -x. */
export type Side = 'N' | 'E' | 'S' | 'W';

export const SIDES: readonly Side[] = ['N', 'E', 'S', 'W'];

/** How boards are separated from each other and from the rails. */
export type Separation =
  /** Routed gap bridged by tabs perforated with a row of NPTH holes. */
  | 'mouse-bite'
  /** Routed gap bridged by plain tabs (cut them yourself). */
  | 'solid-tab'
  /**
   * No routing at all: one rectangular outline with the boards drawn inside it
   * as silkscreen lines. JLCPCB treats that as a single design; you cut the
   * boards apart yourself.
   */
  | 'silk-divider';

export interface PanelSource {
  /**
   * Short label prefix, unique on the panel (`S`, `M`, ...). Instances are
   * named `<key><n>` and merged refdes are `<key><n>_<refdes>`.
   */
  key: string;
  /** Board file, relative to the directory holding the panel file. */
  path: string;
  /** `sha256:<hex>` of the board's canonical serialization when it was added or last refreshed. */
  hash: string;
  /** Board name when it was added or last refreshed (display only). */
  name: string;
  /** Assembled boards of this design that the order must deliver. */
  needed: number;
  /**
   * Total boards of this design that would be welcome if they come cheap.
   * 0 (or anything <= needed) means "no wish beyond needed".
   */
  niceToHave: number;
}

export interface PanelInstance {
  /** `<source key><n>`, e.g. `S1`, `M3`. A new instance takes one past the highest number in use. */
  id: string;
  /** Key of the source board this is a copy of. */
  source: string;
  /** Bottom-left corner of the instance's rotated outline bounding box, panel mm. */
  at: Point;
  rotation: Rotation;
  /** Pinned instances are never moved by arrange. */
  pinned: boolean;
  /** true = assemble; false = ship bare (every part on it becomes do-not-place). */
  populate: boolean;
}

export interface RailSettings {
  /** Rail width in mm on each panel side; 0 = no rail on that side. */
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface TabSettings {
  /** Tab width along the board edge, mm. */
  width: number;
  /** Target distance between tab centres along one edge, mm. */
  pitch: number;
  /** Longest gap a tab may bridge, mm. Wider gaps get no tab. */
  maxLength: number;
  /** Mouse-bite hole diameter, mm. */
  holeDiameter: number;
  /** Mouse-bite hole centre-to-centre distance, mm. */
  holePitch: number;
  /** Fraction of the hole diameter that reaches into the board (0..0.5). */
  holeOverlap: number;
}

export interface FiducialSettings {
  enabled: boolean;
  /** Bare copper dot diameter, mm. */
  copperDiameter: number;
  /** Solder mask opening diameter, mm. */
  maskDiameter: number;
  /** Distance from the fiducial centre to the outer edge of its rail, mm. */
  edgeDistance: number;
  /** Distance from the panel corner along the rail, mm. */
  cornerOffset: number;
}

export interface ToolingHoleSettings {
  enabled: boolean;
  /** NPTH diameter, mm. */
  diameter: number;
  /** Distance from the panel corner along the rail, mm. */
  cornerOffset: number;
}

export interface PanelSettings {
  separation: Separation;
  rails: RailSettings;
  /** Routed gap between boards, and between boards and rails, mm. Ignored for silk-divider. */
  spacing: number;
  tabs: TabSettings;
  fiducials: FiducialSettings;
  toolingHoles: ToolingHoleSettings;
  /**
   * Layer count the panel is fabricated at. `auto` requires every source board
   * to share one layer count; a number promotes boards with fewer layers.
   */
  copperLayers: 'auto' | 2 | 4 | 6;
}

/**
 * A cable between boards on the panel: header `from` on one board joined to
 * header(s) `to` on others (a daisy-chained ribbon has several). It describes
 * the system the boards make up, not anything fabricated: links never change
 * the panel's fab output, cost or staleness. `check_interconnect` uses them.
 *
 * Endpoints are `<source key>:<refdes>`, e.g. `S:J5`.
 */
export interface PanelLink {
  /** `L<n>`, unique on the panel. */
  id: string;
  from: string;
  to: string[];
  /**
   * `straight`: pad N meets pad N (a keyed IDC ribbon, every connector crimped
   * the same way up). Otherwise a map from `from` pad numbers to `to` pad
   * numbers; pads not in the map are not carried by the cable.
   */
  map: 'straight' | Record<string, string>;
  /**
   * Net names that mean the same signal on different boards, mapped to one
   * name: `{ "BUS_SDA": "SDA", "M_EN": "MOTION_EN" }`. Matching is
   * case-insensitive; ground nets always match each other.
   */
  aliases?: Record<string, string>;
  /** Free text: what the cable is ("14-way ribbon, 2 x 0.5 m"). */
  note?: string;
}

export interface Panel {
  formatVersion: 1;
  kind: 'flamingo-panel';
  name: string;
  sources: PanelSource[];
  instances: PanelInstance[];
  settings: PanelSettings;
  /** Cables between boards. Absent on panels that declare none. */
  links?: PanelLink[];
}

/** Axis-aligned box. */
export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
