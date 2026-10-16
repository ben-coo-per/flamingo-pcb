/**
 * Zones hit-test on their outline only. A board-sized pour must not be
 * selectable (and thus deletable) by clicking anywhere on empty board.
 */
import { describe, it, expect } from 'vitest';
import { newBoard } from '@flamingo/engine';
import { hitEditTargets } from '../src/hit-test.js';

describe('zone hit-test', () => {
  const board = newBoard('t', 2);
  board.zones.push({
    id: 'z1',
    layer: 'B.Cu',
    net: 'GND',
    polygon: [{ x: -28, y: -44 }, { x: 28, y: -44 }, { x: 28, y: 44 }, { x: -28, y: 44 }],
    clearance: 0.3,
    minWidth: 0.15,
    thermal: { gap: 0.3, spokeWidth: 0.4 },
  });
  const scale = 10; // px per mm -> 4px tolerance = 0.4 mm

  it('ignores clicks inside the pour', () => {
    expect(hitEditTargets(board, { x: 5, y: 5 }, scale)).toEqual([]);
  });

  it('hits the pour on its outline', () => {
    expect(hitEditTargets(board, { x: 28.1, y: 0 }, scale)).toEqual([{ kind: 'zone', id: 'z1' }]);
  });
});
