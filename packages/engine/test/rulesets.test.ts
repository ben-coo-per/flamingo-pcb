import { describe, it, expect } from 'vitest';
import { RULESETS } from '../src/drc/rules.js';

describe('RULESETS', () => {
  it('has an advanced-via 4-layer tier that permits 0.25/0.15 vias, which the standard tier does not', () => {
    const std = RULESETS['jlcpcb-4l'];
    const adv = RULESETS['jlcpcb-4l-adv'];
    expect(adv.id).toBe('jlcpcb-4l-adv');
    expect(adv.minViaDiameter).toBeLessThan(std.minViaDiameter);
    expect(adv.minDrill).toBeLessThan(std.minDrill);
    expect(adv.minViaDiameter).toBe(0.25);
    expect(adv.minDrill).toBe(0.15);
    // A 0.25/0.15 via leaves a 0.05mm annular ring -- exactly the advanced tier's minimum.
    expect((0.25 - 0.15) / 2).toBeCloseTo(adv.minAnnular, 6);
  });
});
