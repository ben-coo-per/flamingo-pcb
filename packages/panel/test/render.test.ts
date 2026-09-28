import { describe, it, expect } from 'vitest';
import { checkPanel } from '../src/check.js';
import { computeGeometry } from '../src/geometry.js';
import { arrange } from '../src/layout.js';
import { boardColorAt, tint } from '../src/colors.js';
import { renderPanelSVG } from '../src/node/render.js';
import { LIMITS, applyAll, awkwardBoard, panelOf, plainBoard, resolved } from './helpers.js';

describe('renderPanelSVG', () => {
  const a = resolved('A', plainBoard('alpha', 40, 30));
  const w = resolved('W', awkwardBoard());

  function scene() {
    let panel = panelOf([a, w], [
      ['A', 0, 0],
      ['A', 0, 0, { populate: false }],
      ['W', 0, 0],
      ['W', 0, 0],
    ], [{ op: 'setSettings', settings: { rails: { left: 5, right: 5 } } }]);
    const r = arrange(panel, [a, w], LIMITS);
    if (!r.ok) throw new Error(r.reason);
    panel = applyAll(panel, { op: 'placeInstances', placements: r.placements }, { op: 'setPinned', id: 'A1', pinned: true });
    const geometry = computeGeometry(panel, [a, w]);
    return { panel, geometry, issues: checkPanel(panel, [a, w], LIMITS, geometry) };
  }

  it('is a well-formed SVG whose only colours are the boards\'', () => {
    const { panel, geometry, issues } = scene();
    const svg = renderPanelSVG(panel, [a, w], geometry, { issues, limits: [{ width: 250, height: 250, label: 'assembly max' }] });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    const colours = new Set([...svg.matchAll(/(?:fill|stroke)="(#[0-9a-fA-F]{3,8})"/g)].map((m) => m[1]));
    // Ink, paper, and for each of the two boards its colour and its tint.
    expect([...colours].sort()).toEqual(
      ['#000', '#fff', boardColorAt(0), tint(boardColorAt(0)), boardColorAt(1), tint(boardColorAt(1))].sort(),
    );
    expect(svg).not.toContain('<text');
    expect(svg).not.toMatch(/NaN|Infinity|undefined/);
  });

  it('draws every outline, tab and hole', () => {
    const { panel, geometry } = scene();
    const svg = renderPanelSVG(panel, [a, w], geometry, { labels: false });
    const holes = geometry.tabs.reduce((n, t) => n + t.holes.length, 0);
    const marks = new Set(geometry.fiducials.map((f) => `${f.at.x},${f.at.y}`)).size;
    expect((svg.match(/<circle/g) ?? []).length).toBe(holes + geometry.toolingHoles.length + 2 * marks);
    expect(geometry.tabs.length).toBeGreaterThan(0);
    expect((svg.match(/fill="#000" stroke="#000" stroke-width="0.100"/g) ?? []).length).toBeGreaterThanOrEqual(geometry.tabs.length);
  });

  it('marks bare boards, blocked edges and size limits by line style', () => {
    const { panel, geometry } = scene();
    const bare = renderPanelSVG(panel, [a, w], geometry, { labels: false });
    const allPopulated = renderPanelSVG(
      applyAll(panel, { op: 'setPopulate', id: 'A2', populate: true }),
      [a, w],
      geometry.instances.some((i) => !i.populate)
        ? computeGeometry(applyAll(panel, { op: 'setPopulate', id: 'A2', populate: true }), [a, w])
        : geometry,
      { labels: false },
    );
    expect(bare).toContain('stroke-dasharray="2 1"');
    expect(allPopulated).not.toContain('stroke-dasharray="2 1"');
    expect(bare).toContain('stroke-width="0.700"'); // blocked edge
    const limited = renderPanelSVG(panel, [a, w], geometry, { limits: [{ width: 250, height: 250, label: 'asm' }] });
    expect(limited).toContain('stroke-dasharray="4 2"');
  });

  it('gives every instance of a board that board\'s colour', () => {
    const { panel, geometry } = scene();
    const svg = renderPanelSVG(panel, [a, w], geometry, { labels: false });
    const fills = (c: string): number => (svg.match(new RegExp(`fill="${tint(c)}"`, 'g')) ?? []).length;
    expect(fills(boardColorAt(0))).toBe(panel.instances.filter((i) => i.source === 'A').length);
    expect(fills(boardColorAt(1))).toBe(panel.instances.filter((i) => i.source === 'W').length);
  });

  it('scales to the requested width', () => {
    const { panel, geometry } = scene();
    expect(renderPanelSVG(panel, [a, w], geometry, { widthPx: 640 })).toContain('width="640"');
  });

  it('renders an empty panel', () => {
    const panel = panelOf([a], []);
    const svg = renderPanelSVG(panel, [a], computeGeometry(panel, [a]));
    expect(svg).toContain('<svg');
    expect(svg).not.toMatch(/NaN/);
  });
});
