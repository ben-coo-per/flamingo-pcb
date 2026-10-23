import { describe, expect, it } from 'vitest';
import type { Board } from '@flamingo/engine';
import { DIMS_KEY, LABEL_NETS_KEY, SILK_KEY, ZONES_KEY, exitSolo, soloCopperLayer, soloedCopperLayer } from '../src/state.js';
import { hitEditTargets, hitTest, hitTrackOrVia } from '../src/hit-test.js';

const copper = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'];
const allOn = Object.fromEntries([...copper, ZONES_KEY, SILK_KEY, LABEL_NETS_KEY, DIMS_KEY].map((k) => [k, true]));

describe('show only one copper layer', () => {
  it('keeps that layer and its zones, hides other copper and every overlay', () => {
    const vis = soloCopperLayer(allOn, copper, 'In2.Cu');
    expect(vis).toEqual({
      'F.Cu': false,
      'In1.Cu': false,
      'In2.Cu': true,
      'B.Cu': false,
      [ZONES_KEY]: true,
      [SILK_KEY]: false,
      [LABEL_NETS_KEY]: false,
      [DIMS_KEY]: false,
    });
    expect(soloedCopperLayer(vis, copper)).toBe('In2.Cu');
  });

  it('reports no solo layer when several or none are shown', () => {
    expect(soloedCopperLayer(allOn, copper)).toBeNull();
    expect(soloedCopperLayer({ ...allOn, 'F.Cu': false, 'In1.Cu': false, 'In2.Cu': false, 'B.Cu': false }, copper)).toBeNull();
    expect(soloedCopperLayer({ 'F.Cu': true, 'B.Cu': false }, ['F.Cu', 'B.Cu'])).toBe('F.Cu');
  });
});

describe('leaving show-only', () => {
  const RAT = 'Ratsnest';
  const before = { ...allOn, [RAT]: true, [SILK_KEY]: true, [DIMS_KEY]: false };
  const atSolo = soloCopperLayer(before, copper, 'B.Cu');

  it('puts the overlays back as they were before the solo', () => {
    const vis = exitSolo(atSolo, copper, { before, atSolo });
    expect(vis).toEqual({ ...before, 'F.Cu': true, 'In1.Cu': true, 'In2.Cu': true, 'B.Cu': true });
  });

  it('keeps an overlay the viewer toggled while soloed', () => {
    // Ratsnest back on and dimensions on during the solo: both survive "All".
    const during = { ...atSolo, [RAT]: true, [DIMS_KEY]: true };
    const vis = exitSolo(during, copper, { before, atSolo });
    expect(vis[RAT]).toBe(true);
    expect(vis[DIMS_KEY]).toBe(true);
    expect(vis[SILK_KEY]).toBe(true); // untouched: restored from before
    expect(copper.every((k) => vis[k])).toBe(true);
  });

  it('with no snapshot only turns the copper on', () => {
    const shiftedDown = { ...allOn, 'In1.Cu': false, 'In2.Cu': false, 'B.Cu': false, [SILK_KEY]: false };
    const vis = exitSolo(shiftedDown, copper, null);
    expect(copper.every((k) => vis[k])).toBe(true);
    expect(vis[SILK_KEY]).toBe(false);
  });
});

describe('hit-testing skips hidden layers', () => {
  const tracks = [
    { id: 't-f', layer: 'F.Cu', net: 'A', width: 0.3, seg: { type: 'line', start: { x: -5, y: 0 }, end: { x: 5, y: 0 } } },
    { id: 't-in2', layer: 'In2.Cu', net: 'B', width: 0.3, seg: { type: 'line', start: { x: 0, y: -5 }, end: { x: 0, y: 5 } } },
  ];
  const board = {
    copperLayers: 4,
    components: [],
    tracks,
    vias: [{ id: 'v1', at: { x: 3, y: 3 }, drill: 0.3, diameter: 0.6, net: 'A' }],
    holes: [],
    silk: [{ id: 's1', at: { x: -3, y: -3 }, height: 1, text: 'x' }],
    dimensions: [],
    keepouts: [],
    zones: [{ id: 'z1', layer: 'F.Cu', net: 'A', polygon: [{ x: -9, y: -9 }, { x: 9, y: -9 }, { x: 9, y: 9 }, { x: -9, y: 9 }] }],
    nets: [],
  } as unknown as Board;
  const crossing = { x: 0, y: 0 };
  const onlyIn2 = soloCopperLayer(allOn, copper, 'In2.Cu');

  it('selects whichever track is at the crossing when all layers show', () => {
    expect(hitTest(board, crossing, 10)?.kind).toBe('track');
    const kinds = hitEditTargets(board, crossing, 10, allOn).map((h) => (h.kind === 'track' ? h.id : h.kind));
    expect(kinds).toEqual(['t-f', 't-in2', 'zone']);
  });

  it('cannot select, rip up or route from an F.Cu track while only In2.Cu shows', () => {
    expect(hitTest(board, crossing, 10, onlyIn2)).toMatchObject({ kind: 'track', id: 't-in2' });
    expect(hitTrackOrVia(board, { x: 2, y: 0 }, 10, onlyIn2)).toBeNull();
    expect(hitTrackOrVia(board, { x: 0, y: 2 }, 10, onlyIn2)).toMatchObject({ id: 't-in2' });
    const targets = hitEditTargets(board, crossing, 10, onlyIn2);
    expect(targets).toEqual([{ kind: 'track', id: 't-in2', net: 'B' }]); // no F.Cu track, no F.Cu zone
    expect(hitEditTargets(board, { x: -3, y: -3 }, 10, onlyIn2)).toEqual([]); // silk is off while soloed
  });

  it('keeps vias while any copper shows and drops them when none does', () => {
    expect(hitTest(board, { x: 3, y: 3 }, 10, onlyIn2)).toMatchObject({ kind: 'via' });
    const none = { ...allOn, 'F.Cu': false, 'In1.Cu': false, 'In2.Cu': false, 'B.Cu': false };
    expect(hitTest(board, { x: 3, y: 3 }, 10, none)).toBeNull();
    expect(hitTrackOrVia(board, { x: 3, y: 3 }, 10, none)).toBeNull();
  });
});
