/**
 * Flamingo Panel - constraint checks.
 *
 * `checkPanel` reports what is wrong with a panel as data, the way `runDRC`
 * does for a board. Three severities:
 *  - error:   the panel cannot be fabricated or assembled as it stands.
 *             Errors gate `export_panel_fab` (waivable).
 *  - warning: it can be made, but something deserves a look.
 *  - info:    a consequence worth knowing (an edge is blocked, a board is promoted).
 */

import type { Point } from '@flamingo/engine';
import { allHoles, padWorld, polyIntersects, polyPolyDistance, RULESETS } from '@flamingo/engine';
import type { AssemblyType, PanelLimits, SizeRange } from './config.js';
import type { PanelGeometry, PlacedInstance } from './geometry.js';
import { computeGeometry, effectiveSpacing, tabCounts } from './geometry.js';
import type { ResolvedSources } from './resolved.js';
import { applyTransform, boxCorners } from './transform.js';
import type { Box, Panel, Side } from './types.js';
import { SIDES } from './types.js';

export type Severity = 'error' | 'warning' | 'info';

export type IssueCode =
  | 'source-missing'
  | 'source-stale'
  | 'stackup-mismatch'
  | 'stackup-too-few'
  | 'stackup-promoted'
  | 'rules-mismatch'
  | 'overlap'
  | 'spacing'
  | 'blocked-edge-clearance'
  | 'overhang-collision'
  | 'blocked-edge'
  | 'blocked-edge-tab'
  | 'unsupported-instance'
  | 'tab-near-copper'
  | 'size-fab'
  | 'size-assembly'
  | 'spacing-setting'
  | 'hole-setting'
  | 'rail-features'
  | 'rails-required'
  | 'no-instances'
  | 'silk-divider-designs'
  | 'silk-divider-shape'
  | 'assembly-sides'
  | 'empty';

export interface PanelIssue {
  code: IssueCode;
  severity: Severity;
  message: string;
  /** Instance ids the issue is about; the canvas marks these. */
  instances: string[];
  /** Source keys the issue is about. */
  sources: string[];
  /** Where to point at, panel mm, when the issue has a place. */
  at?: Point;
  /** Machine-readable detail, e.g. `{promoteTo: 4}` on a stackup mismatch. */
  data?: Record<string, unknown>;
}

const EPS = 0.01;

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function centre(b: Box): Point {
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

function fitsEitherWay(w: number, h: number, maxW: number, maxH: number): boolean {
  return (w <= maxW + EPS && h <= maxH + EPS) || (w <= maxH + EPS && h <= maxW + EPS);
}

function atLeastEitherWay(w: number, h: number, minW: number, minH: number): boolean {
  return (w >= minW - EPS && h >= minH - EPS) || (w >= minH - EPS && h >= minW - EPS);
}

/** Layer count the panel is fabricated at, or null when the sources disagree and nothing was chosen. */
export function targetLayers(panel: Panel, sources: ResolvedSources): 2 | 4 | 6 | null {
  if (panel.settings.copperLayers !== 'auto') return panel.settings.copperLayers;
  const used = usedLayerCounts(panel, sources);
  if (used.length === 1) return used[0]!;
  if (used.length === 0) return 2;
  return null;
}

/** Distinct layer counts among the sources that have instances (all sources when none has). */
export function usedLayerCounts(panel: Panel, sources: ResolvedSources): Array<2 | 4 | 6> {
  const withInstances = new Set(panel.instances.map((i) => i.source));
  const pool = sources.filter((s) => s.geometry && (withInstances.size === 0 || withInstances.has(s.key)));
  return [...new Set(pool.map((s) => s.geometry!.copperLayers))].sort((a, b) => a - b);
}

/** Which assembly service a panel of this size and make-up can go to. */
export function assemblyFit(
  width: number,
  height: number,
  panelized: boolean,
  limits: PanelLimits,
): Record<AssemblyType, { fits: boolean; range: SizeRange; reason?: string }> {
  const out = {} as Record<AssemblyType, { fits: boolean; range: SizeRange; reason?: string }>;
  for (const type of ['economic', 'standard'] as const) {
    const range = (panelized ? limits.assembly[type].panelSize : limits.assembly[type].singleSize).value;
    let reason: string | undefined;
    if (!fitsEitherWay(width, height, range.maxWidth, range.maxHeight)) {
      reason = `${fmt(width)} x ${fmt(height)} mm exceeds the ${range.maxWidth} x ${range.maxHeight} mm maximum`;
    } else if (!atLeastEitherWay(width, height, range.minWidth, range.minHeight)) {
      reason = `${fmt(width)} x ${fmt(height)} mm is under the ${range.minWidth} x ${range.minHeight} mm minimum`;
    }
    out[type] = { fits: reason === undefined, range, ...(reason ? { reason } : {}) };
  }
  return out;
}

function sourceIssues(panel: Panel, sources: ResolvedSources): PanelIssue[] {
  const issues: PanelIssue[] = [];
  for (const s of sources) {
    const instances = panel.instances.filter((i) => i.source === s.key).map((i) => i.id);
    if (s.error) {
      issues.push({
        code: 'source-missing',
        severity: 'error',
        message: `${s.key}: ${s.error}`,
        instances,
        sources: [s.key],
      });
    } else if (s.stale) {
      issues.push({
        code: 'source-stale',
        severity: 'warning',
        message: `${s.key} (${s.path}) changed on disk since it was added to the panel. Everything shown uses the board as it is now; refresh the source to accept the change.`,
        instances,
        sources: [s.key],
      });
    }
  }
  for (const s of panel.sources) {
    if (s.needed > 0 && !panel.instances.some((i) => i.source === s.key && i.populate)) {
      const anyBare = panel.instances.some((i) => i.source === s.key);
      issues.push({
        code: 'no-instances',
        severity: 'warning',
        message: anyBare
          ? `${s.key}: ${s.needed} assembled board(s) needed, but every ${s.key} instance on the panel is bare`
          : `${s.key}: ${s.needed} board(s) needed, but the panel has no ${s.key} instance`,
        instances: [],
        sources: [s.key],
      });
    }
  }
  return issues;
}

function stackupIssues(panel: Panel, sources: ResolvedSources): PanelIssue[] {
  const issues: PanelIssue[] = [];
  const used = usedLayerCounts(panel, sources);
  const withInstances = new Set(panel.instances.map((i) => i.source));
  const pool = sources.filter((s) => s.geometry && (withInstances.size === 0 || withInstances.has(s.key)));
  const describe = (): string =>
    pool.map((s) => `${s.key} is ${s.geometry!.copperLayers}-layer`).join(', ');
  const idsOf = (keys: string[]): string[] =>
    panel.instances.filter((i) => keys.includes(i.source)).map((i) => i.id);

  const chosen = panel.settings.copperLayers;
  if (chosen === 'auto') {
    if (used.length > 1) {
      const promoteTo = used[used.length - 1]!;
      const minority = pool.filter((s) => s.geometry!.copperLayers !== promoteTo).map((s) => s.key);
      issues.push({
        code: 'stackup-mismatch',
        severity: 'error',
        message:
          `Boards on one panel must share a layer count: ${describe()}. ` +
          `Either promote the panel to ${promoteTo} layers (the boards with fewer layers are then made as ${promoteTo}-layer boards with empty inner layers), ` +
          `or put them on separate panels.`,
        instances: idsOf(minority),
        sources: pool.map((s) => s.key),
        data: { layers: used, promoteTo },
      });
    }
  } else {
    const tooMany = pool.filter((s) => s.geometry!.copperLayers > chosen);
    if (tooMany.length > 0) {
      issues.push({
        code: 'stackup-too-few',
        severity: 'error',
        message: `The panel is set to ${chosen} layers, but ${tooMany
          .map((s) => `${s.key} has ${s.geometry!.copperLayers}`)
          .join(', ')}. A board cannot be made with fewer layers than it was designed for.`,
        instances: idsOf(tooMany.map((s) => s.key)),
        sources: tooMany.map((s) => s.key),
        data: { promoteTo: Math.max(...pool.map((s) => s.geometry!.copperLayers)) },
      });
    }
    const promoted = pool.filter((s) => s.geometry!.copperLayers < chosen);
    if (promoted.length > 0) {
      issues.push({
        code: 'stackup-promoted',
        severity: 'info',
        message: `${promoted.map((s) => `${s.key} (${s.geometry!.copperLayers}-layer)`).join(', ')} will be made as ${chosen}-layer with empty inner layers.`,
        instances: idsOf(promoted.map((s) => s.key)),
        sources: promoted.map((s) => s.key),
      });
    }
  }

  // Rules: a board may have been designed to tighter limits than the panel's
  // ruleset allows only if the panel's ruleset is at least as permissive.
  const target = targetLayers(panel, sources);
  if (target !== null) {
    const panelRules = RULESETS[`jlcpcb-${target}l`];
    for (const s of pool) {
      const own = RULESETS[s.geometry!.rules];
      if (!own) {
        issues.push({
          code: 'rules-mismatch',
          severity: 'error',
          message: `${s.key} uses unknown rules set "${s.geometry!.rules}"`,
          instances: idsOf([s.key]),
          sources: [s.key],
        });
        continue;
      }
      const tighter = (Object.keys(panelRules) as Array<keyof typeof panelRules>).filter(
        (k) => typeof panelRules[k] === 'number' && (own[k] as number) < (panelRules[k] as number) - 1e-9,
      );
      if (tighter.length > 0) {
        issues.push({
          code: 'rules-mismatch',
          severity: 'error',
          message: `${s.key} was designed to ${own.id}, which allows smaller ${tighter.join(', ')} than the panel's ${panelRules.id}`,
          instances: idsOf([s.key]),
          sources: [s.key],
        });
      }
    }
  }
  return issues;
}

function facing(a: PlacedInstance, b: PlacedInstance): { side: Side; gap: number } | null {
  const gapX = Math.max(b.bbox.minX - a.bbox.maxX, a.bbox.minX - b.bbox.maxX);
  const gapY = Math.max(b.bbox.minY - a.bbox.maxY, a.bbox.minY - b.bbox.maxY);
  if (gapX >= -EPS && gapY < -EPS) return { side: b.bbox.minX >= a.bbox.maxX - EPS ? 'E' : 'W', gap: Math.max(0, gapX) };
  if (gapY >= -EPS && gapX < -EPS) return { side: b.bbox.minY >= a.bbox.maxY - EPS ? 'N' : 'S', gap: Math.max(0, gapY) };
  return null;
}

const OPPOSITE: Record<Side, Side> = { N: 'S', S: 'N', E: 'W', W: 'E' };

function placementIssues(panel: Panel, geometry: PanelGeometry): PanelIssue[] {
  const issues: PanelIssue[] = [];
  const spacing = effectiveSpacing(panel.settings);
  const list = geometry.instances;

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]!;
      const b = list[j]!;
      const mid: Point = {
        x: (centre(a.bbox).x + centre(b.bbox).x) / 2,
        y: (centre(a.bbox).y + centre(b.bbox).y) / 2,
      };
      const f = facing(a, b);
      if (f) {
        const need = Math.max(a.margins[f.side], b.margins[OPPOSITE[f.side]]);
        if (f.gap < need - EPS) {
          const blocked = need > spacing + EPS;
          const why = blocked
            ? [
                ...a.edges[f.side].reasons.map((r) => `${a.id}: ${r}`),
                ...b.edges[OPPOSITE[f.side]].reasons.map((r) => `${b.id}: ${r}`),
              ].join('; ')
            : '';
          issues.push({
            code: blocked ? 'blocked-edge-clearance' : 'spacing',
            severity: 'error',
            message: blocked
              ? `${a.id} and ${b.id} are ${fmt(f.gap)} mm apart; the blocked edge between them needs ${fmt(need)} mm (${why})`
              : `${a.id} and ${b.id} are ${fmt(f.gap)} mm apart; the panel spacing is ${fmt(need)} mm`,
            instances: [a.id, b.id],
            sources: [],
            at: mid,
          });
        }
        continue;
      }
      // Bounding boxes overlap on both axes, or sit diagonally.
      const gapX = Math.max(b.bbox.minX - a.bbox.maxX, a.bbox.minX - b.bbox.maxX);
      const gapY = Math.max(b.bbox.minY - a.bbox.maxY, a.bbox.minY - b.bbox.maxY);
      if (gapX < 0 && gapY < 0) {
        if (polyIntersects(a.outline, b.outline)) {
          issues.push({
            code: 'overlap',
            severity: 'error',
            message: `${a.id} and ${b.id} overlap`,
            instances: [a.id, b.id],
            sources: [],
            at: mid,
          });
        } else if (spacing > 0) {
          const d = polyPolyDistance(a.outline, b.outline);
          if (d < spacing - EPS) {
            issues.push({
              code: 'spacing',
              severity: 'error',
              message: `${a.id} and ${b.id} are ${fmt(d)} mm apart; the panel spacing is ${fmt(spacing)} mm`,
              instances: [a.id, b.id],
              sources: [],
              at: mid,
            });
          }
        }
      } else if (spacing > 0) {
        const d = Math.hypot(Math.max(0, gapX), Math.max(0, gapY));
        if (d < spacing - EPS) {
          issues.push({
            code: 'spacing',
            severity: 'error',
            message: `${a.id} and ${b.id} are ${fmt(d)} mm apart corner to corner; the panel spacing is ${fmt(spacing)} mm`,
            instances: [a.id, b.id],
            sources: [],
            at: mid,
          });
        }
      }
    }
  }

  // A part that sticks out past its board must not land on anything solid.
  for (const a of list) {
    for (const o of a.overhangs) {
      for (const b of list) {
        if (b === a) continue;
        if (polyIntersects(o.polygon, b.outline) || b.overhangs.some((p) => b.id > a.id && polyIntersects(o.polygon, p.polygon))) {
          issues.push({
            code: 'overhang-collision',
            severity: 'error',
            message: `${a.id}: ${o.refdes}, which overhangs the board edge, collides with ${b.id}`,
            instances: [a.id, b.id],
            sources: [],
            at: centre(b.bbox),
          });
        }
      }
      for (const r of geometry.rails) {
        if (polyIntersects(o.polygon, boxCorners(r.box))) {
          issues.push({
            code: 'overhang-collision',
            severity: 'error',
            message: `${a.id}: ${o.refdes}, which overhangs the board edge, collides with the ${r.side} rail`,
            instances: [a.id],
            sources: [],
            at: centre(a.bbox),
          });
        }
      }
    }
  }
  return issues;
}

function edgeAndTabIssues(panel: Panel, geometry: PanelGeometry, limits: PanelLimits): PanelIssue[] {
  const issues: PanelIssue[] = [];
  for (const i of geometry.instances) {
    for (const side of SIDES) {
      const e = i.edges[side];
      if (!e.blocked) continue;
      issues.push({
        code: 'blocked-edge',
        severity: 'info',
        message: `${i.id} edge ${side} is blocked (${e.reasons.join('; ')}): no tabs there, ${fmt(i.margins[side])} mm clearance`,
        instances: [i.id],
        sources: [i.source],
      });
    }
  }
  if (panel.settings.separation === 'silk-divider') return issues;

  // Tabs are generated clear of blocked edges; this guards that promise.
  for (const t of geometry.tabs) {
    const a = geometry.instances.find((i) => i.id === t.a);
    const b = geometry.instances.find((i) => i.id === t.b);
    const bad: string[] = [];
    if (a?.edges[t.side].blocked) bad.push(a.id);
    if (b?.edges[OPPOSITE[t.side]].blocked) bad.push(b.id);
    if (bad.length > 0) {
      issues.push({
        code: 'blocked-edge-tab',
        severity: 'error',
        message: `A tab between ${t.a} and ${t.b} lands on a blocked edge of ${bad.join(' and ')}`,
        instances: bad,
        sources: [],
        at: t.center,
      });
    }
  }

  const min = limits.tabs.minPerInstance.value;
  for (const [id, n] of tabCounts(geometry)) {
    if (n >= min) continue;
    const inst = geometry.instances.find((i) => i.id === id)!;
    const blocked = SIDES.filter((s) => inst.edges[s].blocked);
    const hint = blocked.length > 0 ? ` (edges ${blocked.join(', ')} are blocked)` : '';
    issues.push({
      code: 'unsupported-instance',
      severity: n === 0 ? 'error' : 'warning',
      message:
        n === 0
          ? `${id} has no tabs${hint}: nothing holds it in the panel. Move it within ${fmt(panel.settings.tabs.maxLength)} mm of a rail or another board.`
          : `${id} is held by ${n} tab${n === 1 ? '' : 's'}${hint}; ${min} or more are recommended`,
      instances: [id],
      sources: [],
      at: centre(inst.bbox),
    });
  }
  return issues;
}

/** Copper and drills of a board near its edge would be damaged by a mouse-bite hole: warn. */
function tabCopperIssues(panel: Panel, sources: ResolvedSources, geometry: PanelGeometry, limits: PanelLimits): PanelIssue[] {
  if (panel.settings.separation !== 'mouse-bite') return [];
  const issues: PanelIssue[] = [];
  const clearance = limits.tabs.copperClearance.value;
  const r = panel.settings.tabs.holeDiameter / 2;
  const reported = new Set<string>();

  for (const inst of geometry.instances) {
    const board = sources.find((s) => s.key === inst.source)?.board;
    if (!board) continue;
    const holes = geometry.tabs
      .filter((t) => t.a === inst.id || t.b === inst.id)
      .flatMap((t) => t.holes)
      .filter((h) => h.x >= inst.bbox.minX - r - EPS && h.x <= inst.bbox.maxX + r + EPS && h.y >= inst.bbox.minY - r - EPS && h.y <= inst.bbox.maxY + r + EPS);
    if (holes.length === 0) continue;

    // Obstacles as discs in panel space: cheap, and conservative enough for a warning.
    const discs: Array<{ at: Point; r: number; what: string }> = [];
    const toPanel = (p: Point): Point => applyTransform(inst.transform, p);
    for (const v of board.vias) discs.push({ at: toPanel(v.at), r: v.diameter / 2, what: 'a via' });
    for (const h of allHoles(board)) {
      discs.push({ at: toPanel(h.at), r: Math.max(h.drill, h.padDiameter) / 2, what: 'a hole' });
    }
    for (const t of board.tracks) {
      for (const p of [t.seg.start, t.seg.end]) {
        discs.push({ at: toPanel(p), r: t.width / 2, what: `a track on ${t.net}` });
      }
    }
    for (const c of board.components) {
      for (const pad of c.footprint.pads) {
        discs.push({
          at: toPanel(padWorld(c, pad).at),
          r: Math.hypot(pad.size.w, pad.size.h) / 2,
          what: `${c.refdes}.${pad.number}`,
        });
      }
    }
    for (const h of holes) {
      const hit = discs.find((d) => Math.hypot(d.at.x - h.x, d.at.y - h.y) < d.r + r + clearance);
      if (!hit) continue;
      const key = `${inst.id}:${hit.what}`;
      if (reported.has(key)) continue;
      reported.add(key);
      issues.push({
        code: 'tab-near-copper',
        severity: 'warning',
        message: `${inst.id}: a mouse-bite hole comes within ${fmt(clearance)} mm of ${hit.what}`,
        instances: [inst.id],
        sources: [inst.source],
        at: h,
      });
    }
  }
  return issues;
}

function sizeIssues(panel: Panel, sources: ResolvedSources, geometry: PanelGeometry, limits: PanelLimits): PanelIssue[] {
  const issues: PanelIssue[] = [];
  const frame = geometry.frame;
  if (!frame) return issues;
  const { width, height } = frame;
  const all = geometry.instances.map((i) => i.id);

  const layers = targetLayers(panel, sources) ?? Math.max(2, ...usedLayerCounts(panel, sources));
  const fabMax = limits.fab.maxSize[String(layers) as '2' | '4' | '6'].value;
  if (!fitsEitherWay(width, height, fabMax.width, fabMax.height)) {
    issues.push({
      code: 'size-fab',
      severity: 'error',
      message: `The panel is ${fmt(width)} x ${fmt(height)} mm; the largest ${layers}-layer board JLCPCB makes is ${fabMax.width} x ${fabMax.height} mm`,
      instances: all,
      sources: [],
      data: { width, height, max: fabMax },
    });
  }
  const fabMin = limits.fab.minSize.value;
  if (!atLeastEitherWay(width, height, fabMin.width, fabMin.height)) {
    issues.push({
      code: 'size-fab',
      severity: 'error',
      message: `The panel is ${fmt(width)} x ${fmt(height)} mm; the smallest board JLCPCB makes is ${fabMin.width} x ${fabMin.height} mm`,
      instances: all,
      sources: [],
    });
  }

  const populated = geometry.instances.filter((i) => i.populate);
  if (populated.length > 0) {
    // A silk-divider panel is one board as far as the assembly line can tell.
    const panelized = panel.settings.separation !== 'silk-divider' && geometry.instances.length > 1;
    const fit = assemblyFit(width, height, panelized, limits);
    const kind = panelized ? 'panel' : 'single board';
    if (!fit.economic.fits && !fit.standard.fits) {
      issues.push({
        code: 'size-assembly',
        severity: 'error',
        message: `Too ${/exceeds/.test(fit.standard.reason ?? '') ? 'large' : 'small'} to assemble as a ${kind}: Standard PCBA: ${fit.standard.reason}. Economic PCBA: ${fit.economic.reason}.`,
        instances: populated.map((i) => i.id),
        sources: [],
        data: { width, height, economic: fit.economic.range, standard: fit.standard.range },
      });
    } else {
      for (const type of ['economic', 'standard'] as const) {
        if (fit[type].fits) continue;
        const label = type === 'economic' ? 'Economic' : 'Standard';
        issues.push({
          code: 'size-assembly',
          severity: 'warning',
          message: `${label} PCBA cannot take this ${kind}: ${fit[type].reason}. ${type === 'economic' ? 'Standard' : 'Economic'} PCBA still can.`,
          instances: [],
          sources: [],
          data: { width, height, type, range: fit[type].range },
        });
      }
    }
  }
  return issues;
}

function settingIssues(panel: Panel, sources: ResolvedSources, geometry: PanelGeometry, limits: PanelLimits): PanelIssue[] {
  const issues: PanelIssue[] = [];
  const s = panel.settings;
  if (s.separation !== 'silk-divider') {
    if (s.spacing < limits.fab.minSpacing.value - 1e-9) {
      issues.push({
        code: 'spacing-setting',
        severity: 'error',
        message: `Panel spacing is ${fmt(s.spacing)} mm; JLCPCB routes ${fmt(limits.fab.minSpacing.value)} mm or wider between boards`,
        instances: [],
        sources: [],
      });
    }
  }
  if (s.separation === 'mouse-bite' && s.tabs.holeDiameter < limits.fab.minNpthDiameter.value - 1e-9) {
    issues.push({
      code: 'hole-setting',
      severity: 'error',
      message: `Mouse-bite holes are ${fmt(s.tabs.holeDiameter)} mm; the smallest non-plated hole JLCPCB drills is ${fmt(limits.fab.minNpthDiameter.value)} mm`,
      instances: [],
      sources: [],
    });
  }
  if (s.toolingHoles.enabled && s.toolingHoles.diameter < limits.fab.minNpthDiameter.value - 1e-9) {
    issues.push({
      code: 'hole-setting',
      severity: 'error',
      message: `Tooling holes are ${fmt(s.toolingHoles.diameter)} mm; the smallest non-plated hole JLCPCB drills is ${fmt(limits.fab.minNpthDiameter.value)} mm`,
      instances: [],
      sources: [],
    });
  }
  for (const note of geometry.featureNotes) {
    issues.push({ code: 'rail-features', severity: 'warning', message: note, instances: [], sources: [] });
  }

  const populated = geometry.instances.filter((i) => i.populate);
  if (populated.length > 0 && geometry.frame) {
    if (geometry.rails.length === 0 && limits.assembly.standard.railsRequired.value) {
      issues.push({
        code: 'rails-required',
        severity: 'warning',
        message: 'The panel has no rails. Standard PCBA needs edge rails and fiducials; Economic PCBA does not.',
        instances: [],
        sources: [],
      });
    }
    const bottom = populated.filter((i) => sources.find((x) => x.key === i.source)?.geometry?.hasBottomParts);
    if (bottom.length > 0) {
      issues.push({
        code: 'assembly-sides',
        severity: 'info',
        message: `${[...new Set(bottom.map((i) => i.source))].join(', ')} has parts on the bottom side: only Standard PCBA places both sides.`,
        instances: bottom.map((i) => i.id),
        sources: [...new Set(bottom.map((i) => i.source))],
      });
    }
  }

  if (s.separation === 'silk-divider') {
    const designs = new Set(geometry.instances.map((i) => i.source));
    const { maxDesigns, freeDesigns, minFillRatio } = limits.silkDivider;
    if (designs.size > maxDesigns.value) {
      issues.push({
        code: 'silk-divider-designs',
        severity: 'error',
        message: `${designs.size} designs on one silkscreen-divided board; JLCPCB allows ${maxDesigns.value}`,
        instances: [],
        sources: [...designs],
      });
    } else if (designs.size > freeDesigns.value) {
      issues.push({
        code: 'silk-divider-designs',
        severity: 'warning',
        message: `${designs.size} designs on one silkscreen-divided board; more than ${freeDesigns.value} may still be charged as different designs (unverified)`,
        instances: [],
        sources: [...designs],
      });
    }
    for (const key of designs) {
      const g = sources.find((x) => x.key === key)?.geometry;
      if (g && g.fillRatio < minFillRatio.value) {
        issues.push({
          code: 'silk-divider-shape',
          severity: 'warning',
          message: `${key} is not a plain rectangle (its outline fills ${Math.round(g.fillRatio * 100)}% of its bounding box): it cannot be cut out with straight cuts`,
          instances: geometry.instances.filter((i) => i.source === key).map((i) => i.id),
          sources: [key],
        });
      }
    }
  }
  return issues;
}

const ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/**
 * Check a panel. Pass `geometry` when it has already been computed for this
 * panel and these sources; it is derived otherwise.
 */
export function checkPanel(
  panel: Panel,
  sources: ResolvedSources,
  limits: PanelLimits,
  geometry: PanelGeometry = computeGeometry(panel, sources),
): PanelIssue[] {
  const issues: PanelIssue[] = [
    ...sourceIssues(panel, sources),
    ...stackupIssues(panel, sources),
  ];
  if (panel.instances.length === 0) {
    issues.push({
      code: 'empty',
      severity: 'info',
      message: 'The panel has no instances yet.',
      instances: [],
      sources: [],
    });
  }
  issues.push(
    ...placementIssues(panel, geometry),
    ...edgeAndTabIssues(panel, geometry, limits),
    ...tabCopperIssues(panel, sources, geometry, limits),
    ...sizeIssues(panel, sources, geometry, limits),
    ...settingIssues(panel, sources, geometry, limits),
  );
  // Stable: severity first, original order within a severity.
  return issues
    .map((issue, i) => ({ issue, i }))
    .sort((a, b) => ORDER[a.issue.severity] - ORDER[b.issue.severity] || a.i - b.i)
    .map((x) => x.issue);
}

export function hasErrors(issues: PanelIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}
