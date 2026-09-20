import { describe, it, expect } from 'vitest';
import { applyOp, newBoard } from '@flamingo/engine';
import type { Board, Footprint, Op } from '@flamingo/engine';
import { Doc } from '../src/document.js';
import { runAutoroute } from '../src/autoroute.js';
import type { RouteRunner } from '../src/route.js';

const R0603: Footprint = {
  name: 'R0603',
  lcsc: 'C25804',
  pads: [
    { number: '1', shape: 'rect', at: { x: -0.75, y: 0 }, rotation: 0, size: { w: 0.8, h: 0.9 }, layer: 'top' },
    { number: '2', shape: 'rect', at: { x: 0.75, y: 0 }, rotation: 0, size: { w: 0.8, h: 0.9 }, layer: 'top' },
  ],
  silk: [],
  courtyard: [],
};

function apply(b: Board, op: Op): Board {
  const r = applyOp(b, op);
  if (!r.ok) throw new Error(`op ${op.op} failed: ${r.error}`);
  return r.board;
}

/** R1 at (0,0), R2 at (5,0), one net N1 = R1.2 <-> R2.1 (anchors at x=0.75/4.25). */
function twoResistorBoard(): Board {
  let b = newBoard('t', 2);
  b = apply(b, { op: 'placeComponent', refdes: 'R1', lcsc: 'C25804', footprint: R0603, at: { x: 0, y: 0 }, rotation: 0, side: 'top', fields: {} });
  b = apply(b, { op: 'placeComponent', refdes: 'R2', lcsc: 'C25804', footprint: R0603, at: { x: 5, y: 0 }, rotation: 0, side: 'top', fields: {} });
  b = apply(b, { op: 'connectPins', net: 'N1', pins: ['R1.2', 'R2.1'] });
  return b;
}

const ROUTE_SES = `(session mock.ses
  (routes
    (resolution um 1)
    (network_out
      (net N1
        (wire (path F.Cu 250 750 0 4250 0) (type route))
      )
    )
  )
)
`;
const EMPTY_SES = `(session mock.ses
  (routes
    (resolution um 1)
    (network_out
    )
  )
)
`;

describe('runAutoroute', () => {
  it('item 5: restores the pre-run board (and undo stack) when the router fails', async () => {
    let b = twoResistorBoard();
    b = apply(b, {
      op: 'addTrack',
      track: { layer: 'F.Cu', width: 0.25, net: 'N1', seg: { type: 'line', start: { x: 0.75, y: 0 }, end: { x: 4.25, y: 0 } } },
    });
    const doc = new Doc(b); // no doc.apply() yet -- undo stack starts empty
    const failing: RouteRunner = { run: async () => { throw new Error('no Java found'); } };

    await expect(runAutoroute(doc, failing, {})).rejects.toThrow(/no Java found.*restored/);

    // The pre-run track (which step 1's unroute would have removed) is back.
    expect(doc.board.tracks).toHaveLength(1);
    expect(doc.board.tracks[0]?.net).toBe('N1');
    // Nothing the pipeline did is left on the undo stack.
    expect(doc.undo()).toBeNull();
  });

  it('item 6: keepExisting with no nets keeps all existing copper instead of a full unroute', async () => {
    let b = twoResistorBoard();
    b = apply(b, {
      op: 'addTrack',
      track: { layer: 'F.Cu', width: 0.25, net: 'N1', seg: { type: 'line', start: { x: 0.75, y: 0 }, end: { x: 4.25, y: 0 } } },
    });
    const doc = new Doc(b);
    const runner: RouteRunner = { run: async () => EMPTY_SES }; // nothing left to route

    const result = await runAutoroute(doc, runner, { keepExisting: true });

    expect(doc.board.tracks).toHaveLength(1); // the hand-placed track survived
    expect(result.remaining).toHaveLength(0); // N1 was already fully connected
  });

  it('item 7: a whole autoroute run undoes in a single undo() call', async () => {
    const b = twoResistorBoard(); // N1 not yet routed
    const doc = new Doc(b);
    const runner: RouteRunner = { run: async () => ROUTE_SES };

    const result = await runAutoroute(doc, runner, {});
    expect(result.tracksAdded).toBeGreaterThan(0);
    expect(doc.board.tracks.length).toBeGreaterThan(0);

    const afterUndo = doc.undo();
    expect(afterUndo).not.toBeNull();
    expect(afterUndo!.tracks).toHaveLength(0); // the whole pipeline reverted at once
    expect(doc.undo()).toBeNull(); // nothing left before it
  });
});
