/**
 * @flamingo/panel - multi-board panelization and order cost model.
 *
 * This entry point is pure and browser-safe: no file system, no Node built-ins.
 * Everything that reads board files, hashes them or writes fab output lives
 * under `@flamingo/panel/node`.
 */

export type {
  Rotation,
  Side,
  Separation,
  PanelSource,
  PanelInstance,
  RailSettings,
  TabSettings,
  FiducialSettings,
  ToolingHoleSettings,
  PanelSettings,
  Panel,
  Box,
} from './types.js';
export { SIDES } from './types.js';

export { PANEL_EXTENSION, DEFAULT_SETTINGS, newPanel, serializePanel, parsePanel, mergeSettings } from './panel.js';

export type { PanelOp, PanelOpResult, PanelOpError, SettingsPatch, InstancePlacement } from './ops.js';
export { applyPanelOp, suggestSourceKey, nextInstanceId } from './ops.js';

export { History, HISTORY_CAP } from './history.js';

export type { Sourced, SizeRange, AssemblyType, AssemblyLimits, PanelLimits } from './config.js';
export { settingsFromLimits, listSourced } from './config.js';

export type { Transform } from './transform.js';
export {
  rotate90,
  boxOf,
  boxCorners,
  boxWidth,
  boxHeight,
  unionBox,
  rotatedSize,
  instanceTransform,
  applyTransform,
  applyTransformAll,
  rotateSide,
  unrotateSide,
  oppositeSide,
  atForRotationAboutCentre,
} from './transform.js';

export type { EdgeInfo, Overhang, EdgeKeepout, PartLine, SourceGeometry } from './source.js';
export { resolveSourceGeometry } from './source.js';

export type { ResolvedSource, ResolvedSources } from './resolved.js';
export { findSource } from './resolved.js';

export type {
  PlacedOverhang,
  PlacedInstance,
  UnplacedInstance,
  RailSide,
  Rail,
  Frame,
  Tab,
  Fiducial,
  ToolingHole,
  PanelGeometry,
} from './geometry.js';
export {
  effectiveSpacing,
  placeInstances,
  computeFrame,
  edgeSpans,
  tabCentres,
  computeGeometry,
  tabCounts,
} from './geometry.js';

export type { Severity, IssueCode, PanelIssue } from './check.js';
export { checkPanel, hasErrors, targetLayers, usedLayerCounts, assemblyFit } from './check.js';

export type { SizeLimit, ArrangeOptions, ArrangeOk, ArrangeFail, ArrangeResult } from './layout.js';
export { arrange, sizeLimit } from './layout.js';
