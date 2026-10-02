import { describe, it, expect } from 'vitest';
import { newBoard } from '../src/board.js';
import { applyOp } from '../src/ops.js';
import type { Board } from '../src/types.js';

function apply(b: Board, op: Parameters<typeof applyOp>[1]): Board {
  const r = applyOp(b, op);
  if (!r.ok) throw new Error(r.error);
  return r.board;
}

describe('check waiver ops', () => {
  const waiver = { check: 'erc', rule: 'unconnected-ic-pin', items: ['J6.9'], reason: ' MISO left open on purpose ' };

  it('adds a waiver, trimming rule and reason, without touching the input board', () => {
    const b0 = newBoard('t', 2);
    const b1 = apply(b0, { op: 'addCheckWaiver', waiver });
    expect(b0.checkWaivers).toBeUndefined();
    expect(b1.checkWaivers).toEqual([{ check: 'erc', rule: 'unconnected-ic-pin', items: ['J6.9'], reason: 'MISO left open on purpose' }]);
    const b2 = apply(b1, { op: 'addCheckWaiver', waiver: { rule: 'polarity', items: [], reason: 'r' } });
    expect(b2.checkWaivers).toHaveLength(2);
    expect(b2.checkWaivers![1]).toEqual({ rule: 'polarity', items: [], reason: 'r' });
  });

  it('refuses a waiver without a rule, a reason, or string items', () => {
    const b = newBoard('t', 2);
    for (const bad of [
      { rule: '', items: [], reason: 'r' },
      { rule: 'x', items: [], reason: '   ' },
      { rule: 'x', items: [3], reason: 'r' },
      { rule: 'x', reason: 'r' },
      { rule: 'x', items: [], reason: 'r', check: 5 },
    ]) {
      const r = applyOp(b, { op: 'addCheckWaiver', waiver: bad as never });
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('removes by index and validates it', () => {
    const b1 = apply(apply(newBoard('t', 2), { op: 'addCheckWaiver', waiver }), {
      op: 'addCheckWaiver',
      waiver: { rule: 'polarity', items: ['D1'], reason: 'r' },
    });
    const b2 = apply(b1, { op: 'removeCheckWaiver', index: 0 });
    expect(b2.checkWaivers).toEqual([{ rule: 'polarity', items: ['D1'], reason: 'r' }]);
    const b3 = apply(b2, { op: 'removeCheckWaiver', index: 0 });
    expect(b3.checkWaivers).toBeUndefined();
    for (const index of [-1, 1, 0.5, NaN]) expect(applyOp(b2, { op: 'removeCheckWaiver', index }).ok).toBe(false);
    expect(applyOp(b3, { op: 'removeCheckWaiver', index: 0 }).ok).toBe(false);
  });
});
