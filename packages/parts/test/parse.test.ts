import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseEasyedaFootprint } from '../src/easyeda-parse.js';
import { padOutline } from '@flamingo/engine';
import type { Pad, ComponentInst } from '@flamingo/engine';

const here = dirname(fileURLToPath(import.meta.url));
function fixture(lcsc: string): unknown {
  return JSON.parse(readFileSync(join(here, 'fixtures', `${lcsc}.json`), 'utf8'));
}
function padByNumber(pads: Pad[], n: string): Pad {
  const p = pads.find((x) => x.number === n);
  if (!p) throw new Error(`no pad ${n}`);
  return p;
}

/** Independently reproduce the raw-canvas -> mm conversion (same formula the
 * parser uses) so the regression test doesn't just re-check the parser's own
 * rotation math against itself. */
function convRaw(ox: number, oy: number, x: number, y: number): { x: number; y: number } {
  return { x: (x - ox) * 0.254, y: -(y - oy) * 0.254 };
}
function rawPolygonPoints(ox: number, oy: number, pairs: string): Array<{ x: number; y: number }> {
  const nums = pairs.trim().split(/\s+/).map(Number);
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push(convRaw(ox, oy, nums[i]!, nums[i + 1]!));
  return out;
}
/** padOutline normalizes winding to CCW (reversing point order when the raw
 * outline is CW), which is correct, unrelated behavior -- so compare the two
 * point sets order- and direction-agnostically (each expected point must have
 * a matching, not-yet-claimed actual point within tolerance). */
function expectSamePolygon(actual: Array<{ x: number; y: number }>, expected: Array<{ x: number; y: number }>): void {
  expect(actual).toHaveLength(expected.length);
  const remaining = actual.slice();
  for (const e of expected) {
    const i = remaining.findIndex((a) => Math.abs(a.x - e.x) < 1e-6 && Math.abs(a.y - e.y) < 1e-6);
    expect(i, `no actual point matched expected (${e.x}, ${e.y})`).toBeGreaterThanOrEqual(0);
    remaining.splice(i, 1);
  }
}
function identityComponent(footprint: ReturnType<typeof parseEasyedaFootprint>['footprint']): ComponentInst {
  return {
    refdes: 'U1',
    lcsc: '',
    footprint,
    at: { x: 0, y: 0 },
    rotation: 0,
    side: 'top',
    fields: {},
  };
}

// EasyEDA -> Flamingo conversion constant: 1 unit = 10 mil = 0.254 mm.
// Coords are relative to dataStr.head.x/y, and canvas y-down -> our y-up (negate Y).

describe('parseEasyedaFootprint', () => {
  it('C25804 (0603 resistor): 2 SMD rect pads, hand-converted position', () => {
    const { footprint, info } = parseEasyedaFootprint(fixture('C25804'));
    expect(footprint.pads).toHaveLength(2);
    // origin (4000,3000). pad "1" raw x=3997.034 y=3000.
    // x = (3997.034-4000)*0.254 = -0.753364 ; y = -(3000-3000)*0.254 = 0
    const p1 = padByNumber(footprint.pads, '1');
    expect(p1.shape).toBe('rect');
    expect(p1.at.x).toBeCloseTo(-0.753364, 4);
    expect(p1.at.y).toBeCloseTo(0, 4);
    // size w=3.1751*0.254=0.806475 h=3.4016*0.254=0.864006
    expect(p1.size.w).toBeCloseTo(0.806475, 4);
    expect(p1.size.h).toBeCloseTo(0.864006, 4);
    expect(p1.layer).toBe('top');
    expect(p1.drill).toBeUndefined();
    // courtyard + silk present
    expect(footprint.courtyard.length).toBeGreaterThan(0);
    expect(footprint.silk.length).toBeGreaterThan(0);
    // PartInfo derivation (from symbol dataStr head.c_para)
    expect(info.mpn).toBe('0603WAF1002T5E');
    expect(info.mfr).toContain('UNI-ROYAL');
    expect(info.package).toBe('R0603');
    expect(info.basic).toBe(true);
    expect(info.datasheet).toBeTruthy();
  });

  it('C2150 (SOT-23-3): 3 rect pads, hand-converted position', () => {
    const { footprint, info } = parseEasyedaFootprint(fixture('C2150'));
    expect(footprint.pads).toHaveLength(3);
    // pad "3" raw x=3996.063 y=3000, origin (4000,3000) => x=(3996.063-4000)*0.254=-0.999998
    const p3 = padByNumber(footprint.pads, '3');
    expect(p3.at.x).toBeCloseTo(-0.999998, 4);
    expect(p3.at.y).toBeCloseTo(0, 4);
    expect(p3.shape).toBe('rect');
    expect(info.basic).toBe(true);
    expect(footprint.courtyard.length).toBeGreaterThan(0);
  });

  it('C2040 (RP2040 LQFN-56): 57 pads incl. EP, rotated pad, hand-converted position', () => {
    const { footprint } = parseEasyedaFootprint(fixture('C2040'));
    expect(footprint.pads).toHaveLength(57);
    // pad "1" raw (3970.768,3002.7565) — origin (3984.252,3012.9925)
    // x=(3970.768-3984.252)*0.254=-3.424936 ; y=-(3002.7565-3012.9925)*0.254=2.599944
    const p1 = padByNumber(footprint.pads, '1');
    expect(p1.at.x).toBeCloseTo(-3.424936, 3);
    expect(p1.at.y).toBeCloseTo(2.599944, 3);
    // pad "56" has EasyEDA rotation 270 -> our y-up CCW = -270 normalized = 90
    const p56 = padByNumber(footprint.pads, '56');
    expect(p56.rotation).toBeCloseTo(90, 3);
    expect(footprint.silk.length).toBeGreaterThan(0);
  });

  it('C2913204 (ESP32-S3-WROOM): 49 pads, extended part', () => {
    const { footprint, info } = parseEasyedaFootprint(fixture('C2913204'));
    expect(footprint.pads).toHaveLength(49);
    // pad "1" raw (3995.551,3000) origin (4030,3035.0195)
    // x=(3995.551-4030)*0.254=-8.750046 ; y=-(3000-3035.0195)*0.254=8.894953
    const p1 = padByNumber(footprint.pads, '1');
    expect(p1.at.x).toBeCloseTo(-8.750046, 3);
    expect(p1.at.y).toBeCloseTo(8.894953, 3);
    expect(info.mpn).toBe('ESP32-S3-WROOM-1-N8R2');
    expect(info.basic).toBe(false);
    expect(footprint.courtyard.length).toBeGreaterThan(0);
  });

  it('C165948 (USB-C receptacle): THT pads with drill+slot, polygon pads', () => {
    const { footprint } = parseEasyedaFootprint(fixture('C165948'));
    expect(footprint.pads).toHaveLength(16);
    // THT pad "2": layer 11 -> 'through', holeRadius=1.5748 -> drill dia=2*1.5748*0.254=0.799998
    // holeLength=5.5118 -> slotLength=5.5118*0.254=1.399997
    const p2 = padByNumber(footprint.pads, '2');
    expect(p2.layer).toBe('through');
    expect(p2.drill).toBeDefined();
    expect(p2.drill!.diameter).toBeCloseTo(0.8, 3);
    expect(p2.drill!.plated).toBe(true);
    expect(p2.drill!.slotLength).toBeCloseTo(1.4, 3);
    // at least one polygon-shaped pad (USB-C castellated shield fingers)
    expect(footprint.pads.some((p) => p.shape === 'polygon' && p.polygon && p.polygon.length > 0)).toBe(true);
  });

  it('C165948 (USB-C receptacle): HOLE shapes become footprint holes, not dropped', () => {
    // Regression: HOLE was lumped in with cosmetic shapes and silently skipped,
    // so the connector's two locating posts never reached the drill file and the
    // part could not seat. Field [3] is a RADIUS: 1.4764*2*0.254 = 0.750 mm, and
    // the pair sits 5.80 mm apart -- the datasheet's "2-Ø0.50" posts at 5.78 mm.
    const { footprint } = parseEasyedaFootprint(fixture('C165948'));
    expect(footprint.holes).toHaveLength(2);
    for (const h of footprint.holes!) {
      expect(h.drill).toBeCloseTo(0.75, 3);
      expect(h.at.y).toBeCloseTo(1.2056, 3);
    }
    const xs = footprint.holes!.map((h) => h.at.x).sort((a, b) => a - b);
    expect(xs[1]! - xs[0]!).toBeCloseTo(5.8, 3);
  });

  it('footprints with no HOLE shapes leave holes undefined', () => {
    const { footprint } = parseEasyedaFootprint(fixture('C25804'));
    expect(footprint.holes).toBeUndefined();
  });

  it('C8734 (STM32 LQFP-48): 48 pads, silk arc present', () => {
    const { footprint } = parseEasyedaFootprint(fixture('C8734'));
    expect(footprint.pads).toHaveLength(48);
    expect(footprint.silk.some((s) => s.kind === 'arc')).toBe(true);
  });

  it('ARC sweep flag maps to visually-consistent cw (corner arcs bow outward)', () => {
    // Quarter arc "M 10 0 A 10 10 0 0 1 0 10" about head origin (0,0):
    // sweep=1 goes positive-angle in the y-down canvas frame, from (10,0) to
    // (0,10) through (7.07,7.07) -- center is the origin, arc bows away from it.
    // In our y-up frame that's start (2.54,0) -> end (0,-2.54) through
    // (1.796,-1.796): the angle *decreases* (0deg -> -90deg), i.e. clockwise,
    // so cw must be true (cw = sweep flag). The old `cw: !fS` bowed every such
    // arc toward the wrong side ("radius flipped on the corners").
    const synthetic = {
      packageDetail: {
        dataStr: {
          head: { x: 0, y: 0 },
          shape: ['ARC~1~3~~M 10 0 A 10 10 0 0 1 0 10~~gge1'],
        },
      },
    };
    const { footprint } = parseEasyedaFootprint(synthetic);
    const arc = footprint.silk.find((s) => s.kind === 'arc');
    expect(arc).toBeDefined();
    if (arc?.kind !== 'arc') throw new Error('unreachable');
    expect(arc.start.x).toBeCloseTo(2.54, 4);
    expect(arc.start.y).toBeCloseTo(0, 4);
    expect(arc.end.x).toBeCloseTo(0, 4);
    expect(arc.end.y).toBeCloseTo(-2.54, 4);
    expect(arc.center.x).toBeCloseTo(0, 4);
    expect(arc.center.y).toBeCloseTo(0, 4);
    expect(arc.cw).toBe(true);
  });

  it('never throws on unknown cosmetic shapes (all fixtures parse)', () => {
    for (const l of ['C25804', 'C2150', 'C2040', 'C2913204', 'C165948', 'C8734']) {
      expect(() => parseEasyedaFootprint(fixture(l))).not.toThrow();
    }
  });

  it('C5656610 (ICS-43434): SOLIDREGION arc paths do not explode the courtyard bbox', () => {
    // Real shape strings from the ICS-43434 package (cache C5656610.json). The
    // body SOLIDREGIONs on layer 100 use SVG path arcs ("A rx ry rot laf sf x y");
    // a naive number-pairing parser folds the arc's 5 non-coordinate params in as
    // fake vertices, producing courtyard points hundreds of mm from the part.
    const synthetic = {
      packageDetail: {
        dataStr: {
          head: { x: 4003.954, y: 2992.0275 },
          shape: [
            'PAD~RECT~3998.89~2995.571~2.3622~2.0472~1~~1~0~3997.8661 2996.752 3997.8661 2994.3898 3999.9133 2994.3898 3999.9133 2996.752~90~gge42~0~~Y~0~0~0.1969~3998.8897,2995.5709',
            'PAD~RECT~4002.126~2995.571~2.3622~2.0472~1~~2~0~4001.1023 2996.752 4001.1023 2994.3898 4003.1494 2994.3898 4003.1494 2996.752~90~gge62~0~~Y~0~0~0.1969~4002.1258,2995.5709',
            'PAD~RECT~4002.126~2988.484~2.3622~2.0472~1~~4~0~4001.1023 2989.6654 4001.1023 2987.3032 4003.1494 2987.3032 4003.1494 2989.6654~90~gge68~0~~Y~0~0~0.1969~4002.1258,2988.4843',
            // Plain rectangular body region (no arcs).
            'SOLIDREGION~99~~M 4011.1417 2997.2441 L 3997.3622 2997.2441 L 3997.3622 2986.811 L 4011.1417 2986.811 Z~solid~gge6~~~~0',
            // Body regions with 7-parameter SVG arc commands (the bug trigger).
            'SOLIDREGION~100~~M 4003.8531 2991.6431 L 4004.8464 2991.6431 L 4004.8468 2991.6428 A 2.2165 2.2165 0 0 1 4006.6448 2989.8447 L 4006.6448 2988.8548 L 4006.6408 2988.8508 A 3.2008 3.2008 0 0 0 4003.8531 2991.6385 L 4003.8531 2991.6431 Z ~solid~gge263~~~~0',
            'SOLIDREGION~100~~M 4007.414 2988.8512 L 4007.414 2989.8446 L 4007.4144 2989.845 A 2.2165 2.2165 0 0 1 4009.2125 2991.643 L 4010.2024 2991.643 L 4010.2064 2991.639 A 3.2008 3.2008 0 0 0 4007.4187 2988.8512 L 4007.414 2988.8512 Z~solid~gge332~~~~0',
          ],
        },
      },
    };

    const { footprint } = parseEasyedaFootprint(synthetic);
    expect(footprint.courtyard.length).toBeGreaterThan(0);

    // Pad bbox (pads are the ground-truth extent of the part).
    const padPts = footprint.pads.flatMap((p) => [
      { x: p.at.x - p.size.w / 2, y: p.at.y - p.size.h / 2 },
      { x: p.at.x + p.size.w / 2, y: p.at.y + p.size.h / 2 },
    ]);
    const padMinX = Math.min(...padPts.map((p) => p.x));
    const padMaxX = Math.max(...padPts.map((p) => p.x));
    const padMinY = Math.min(...padPts.map((p) => p.y));
    const padMaxY = Math.max(...padPts.map((p) => p.y));

    // Every courtyard vertex must stay within 20mm of the pad bbox. With the bug
    // present, arc params leak in as vertices hundreds of mm away and this fails.
    const M = 20;
    for (const poly of footprint.courtyard) {
      for (const pt of poly) {
        expect(pt.x).toBeGreaterThanOrEqual(padMinX - M);
        expect(pt.x).toBeLessThanOrEqual(padMaxX + M);
        expect(pt.y).toBeGreaterThanOrEqual(padMinY - M);
        expect(pt.y).toBeLessThanOrEqual(padMaxY + M);
      }
    }
  });

  it('warns once and skips unknown shape types, parses valid pads', () => {
    // Minimal synthetic API response with one valid PAD and two unknown WIDGET shapes
    const synthetic = {
      packageDetail: {
        dataStr: {
          head: { x: 4000, y: 3000 },
          shape: [
            // Valid PAD: RECT shape at (4000,3000) with width 3.937, height 2.5591, top layer, pad number "1"
            'PAD~RECT~4000~3000~3.937~2.5591~1~~1~0~3998.0315 2998.7205 4001.9685 2998.7205 4001.9685 3001.2795 3998.0315 3001.2795~0~gge1~0~~Y',
            // Bogus shape type (first occurrence): should warn
            'WIDGET~foo~bar',
            // Another bogus shape type (same type, should NOT warn again)
            'WIDGET~baz~qux',
          ],
        },
      },
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { footprint } = parseEasyedaFootprint(synthetic);
      // Should not throw
      expect(footprint).toBeDefined();
      // Should parse the one valid PAD
      expect(footprint.pads).toHaveLength(1);
      expect(footprint.pads[0]!.number).toBe('1');
      expect(footprint.pads[0]!.shape).toBe('rect');
      // Should warn exactly once for WIDGET (not twice, even though there are 2 instances)
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith('parseEasyedaFootprint: skipping unsupported shape "WIDGET"');
    } finally {
      warnSpy.mockRestore();
    }
  });

  // Regression for the POLYGON double-rotation bug: EasyEDA POLYGON pad
  // `points` are absolute canvas coords that already include the pad's
  // rotation. The parser used to store them as-is (relative to `at`), and
  // the engine's padLocalOutline then rotated them again by pad.rotation,
  // rotating every non-zero-rotation polygon pad twice. Fixed by un-rotating
  // the stored points; verify with a component at identity transform that
  // padOutline reproduces the raw converted canvas points exactly.
  it('C5656610 (ICS-43434): POLYGON pad "3" (quarter-ring, rot 0/90/180/270) is not double-rotated', () => {
    const head = { x: 4003.954, y: 2992.0275 };
    const raw: Record<string, string> = {
      '0': 'PAD~POLYGON~4005.249~2990.039~2.7917~2.7922~1~~3~0~4003.853 2991.6431 4004.8463 2991.6431 4004.8467 2991.6427 4004.8743 2991.5102 4004.9099 2991.3795 4004.9534 2991.2513 4005.0047 2991.126 4005.0635 2991.0041 4005.1296 2990.886 4005.2029 2990.7721 4005.2829 2990.6629 4005.3695 2990.5588 4005.4622 2990.4602 4005.5608 2990.3675 4005.6649 2990.2809 4005.7741 2990.2009 4005.888 2990.1276 4006.0061 2990.0615 4006.128 2990.0027 4006.2533 2989.9514 4006.3815 2989.9079 4006.5122 2989.8723 4006.6447 2989.8447 4006.6447 2988.8548 4006.6407 2988.8508 4006.4791 2988.8748 4006.319 2988.907 4006.1607 2988.9473 4006.0047 2988.9957 4005.8514 2989.0519 4005.7011 2989.1159 4005.5543 2989.1875 4005.4113 2989.2665 4005.2726 2989.3527 4005.1384 2989.4458 4005.0091 2989.5457 4004.8851 2989.652 4004.7667 2989.7645 4004.6542 2989.8829 4004.5479 2990.0069 4004.448 2990.1362 4004.3549 2990.2704 4004.2687 2990.4091 4004.1897 2990.5521 4004.1181 2990.6989 4004.0541 2990.8492 4003.9979 2991.0025 4003.9495 2991.1585 4003.9092 2991.3168 4003.877 2991.4769 4003.853 2991.6385 4003.853 2991.6431~0~gge257~0~~Y~0~~0.19685~4005.2489,2990.0392',
      '90': 'PAD~POLYGON~4005.041~2993.808~2.7917~2.7922~1~~3~0~4006.6454 2995.204 4006.6454 2994.2106 4006.6449 2994.2103 4006.5123 2994.1827 4006.3817 2994.1471 4006.2535 2994.1036 4006.1283 2994.0523 4006.0062 2993.9934 4005.8882 2993.9273 4005.7742 2993.854 4005.6652 2993.774 4005.5611 2993.6874 4005.4624 2993.5948 4005.3697 2993.4961 4005.2832 2993.392 4005.2032 2993.2829 4005.1299 2993.169 4005.0638 2993.0509 4005.0049 2992.9289 4004.9536 2992.8037 4004.91 2992.6755 4004.8745 2992.5448 4004.8468 2992.4123 4003.8569 2992.4123 4003.8529 2992.4163 4003.8769 2992.5779 4003.9091 2992.738 4003.9496 2992.8963 4003.9979 2993.0523 4004.0541 2993.2056 4004.1182 2993.3558 4004.1897 2993.5026 4004.2686 2993.6456 4004.3549 2993.7843 4004.448 2993.9186 4004.5478 2994.0478 4004.6541 2994.1719 4004.7668 2994.2903 4004.885 2994.4028 4005.0091 2994.5091 4005.1384 2994.609 4005.2726 2994.702 4005.4113 2994.7883 4005.5543 2994.8673 4005.7011 2994.9388 4005.8513 2995.0029 4006.0046 2995.0591 4006.1607 2995.1074 4006.3189 2995.1478 4006.479 2995.18 4006.6407 2995.204 4006.6454 2995.204~90~gge287~0~~Y~0~~0.19685~4005.0412,2993.8083',
      '180': 'PAD~POLYGON~4008.81~2994.016~2.7917~2.7922~1~~3~0~4010.2061 2992.412 4009.2128 2992.412 4009.2124 2992.4125 4009.1848 2992.5449 4009.1492 2992.6757 4009.1057 2992.8039 4009.0544 2992.9291 4008.9956 2993.0511 4008.9295 2993.1692 4008.8562 2993.2831 4008.7762 2993.3922 4008.6896 2993.4963 4008.5969 2993.595 4008.4983 2993.6877 4008.3942 2993.7742 4008.285 2993.8542 4008.1711 2993.9275 4008.053 2993.9936 4007.9311 2994.0525 4007.8058 2994.1038 4007.6776 2994.1473 4007.5469 2994.1829 4007.4144 2994.2105 4007.4144 2995.2004 4007.4184 2995.2044 4007.58 2995.1804 4007.7401 2995.1482 4007.8984 2995.1078 4008.0544 2995.0595 4008.2077 2995.0033 4008.358 2994.9392 4008.5048 2994.8677 4008.6478 2994.7886 4008.7865 2994.7025 4008.9207 2994.6094 4009.05 2994.5095 4009.174 2994.4032 4009.2924 2994.2906 4009.4049 2994.1723 4009.5112 2994.0483 4009.6111 2993.919 4009.7042 2993.7848 4009.7904 2993.6461 4009.8694 2993.5031 4009.941 2993.3563 4010.005 2993.206 4010.0612 2993.0527 4010.1096 2992.8967 4010.1499 2992.7384 4010.1821 2992.5783 4010.2061 2992.4167 4010.2061 2992.412~180~gge311~0~~Y~0~~0.19685~4008.8103,2994.016',
      '270': 'PAD~POLYGON~4009.018~2990.247~2.7917~2.7922~1~~3~0~4007.414 2988.8512 4007.414 2989.8445 4007.4144 2989.8449 4007.5469 2989.8725 4007.6777 2989.9081 4007.8058 2989.9516 4007.9311 2990.0029 4008.0531 2990.0616 4008.1712 2990.1277 4008.2851 2990.201 4008.3942 2990.2811 4008.4983 2990.3677 4008.597 2990.4604 4008.6896 2990.5589 4008.7762 2990.663 4008.8562 2990.7723 4008.9295 2990.8862 4008.9956 2991.0043 4009.0545 2991.1262 4009.1057 2991.2515 4009.1493 2991.3797 4009.1849 2991.5104 4009.2125 2991.6428 4010.2024 2991.6428 4010.2064 2991.6389 4010.1824 2991.4773 4010.1502 2991.3172 4010.1098 2991.1589 4010.0614 2991.0029 4010.0052 2990.8496 4009.9412 2990.6992 4009.8697 2990.5525 4009.7906 2990.4094 4009.7044 2990.2708 4009.6114 2990.1365 4009.5115 2990.0072 4009.4052 2989.8833 4009.2926 2989.7649 4009.1743 2989.6524 4009.0502 2989.5461 4008.9209 2989.4462 4008.7867 2989.353 4008.648 2989.2669 4008.505 2989.1879 4008.3582 2989.1163 4008.208 2989.0522 4008.0547 2988.996 4007.8987 2988.9476 4007.7404 2988.9074 4007.5803 2988.8752 4007.4187 2988.8512 4007.414 2988.8512~270~gge335~0~~Y~0~~0.19685~4009.018,2990.2469',
    };
    for (const line of Object.values(raw)) {
      const synthetic = { packageDetail: { dataStr: { head, shape: [line] } } };
      const { footprint } = parseEasyedaFootprint(synthetic);
      expect(footprint.pads).toHaveLength(1);
      const pad = footprint.pads[0]!;
      expect(pad.shape).toBe('polygon');
      const points = line.split('~')[10]!;
      const expected = rawPolygonPoints(head.x, head.y, points);
      const actual = padOutline(identityComponent(footprint), pad);
      expectSamePolygon(actual, expected);
    }
  });

  it('C54313 (BQ24074RGTR): exposed POLYGON pad "17" (rot 270) is not double-rotated', () => {
    const head = { x: 254.6625, y: -232.3375 };
    const line =
      'PAD~POLYGON~254.663~-232.338~6.6929~6.6929~1~~17~0~258.0094 -235.6844 258.0094 -228.9915 251.3165 -228.9915 251.3165 -234.0112 252.9898 -235.6845~270~rep19~0~~Y~0~-393.7~0.19685~254.663,-232.338';
    const synthetic = { packageDetail: { dataStr: { head, shape: [line] } } };
    const { footprint } = parseEasyedaFootprint(synthetic);
    expect(footprint.pads).toHaveLength(1);
    const pad = footprint.pads[0]!;
    expect(pad.shape).toBe('polygon');
    const points = line.split('~')[10]!;
    const expected = rawPolygonPoints(head.x, head.y, points);
    const actual = padOutline(identityComponent(footprint), pad);
    expectSamePolygon(actual, expected);
  });

  // Regression: `through = holeR > 0 || layerId === LAYER_MULTI` turned SMD
  // pads with a bogus near-zero holeRadius into plated through pads with a
  // sub-micron drill. C53100353 (MBR0530) has layer-1 RECT pads with
  // holeRadius 0.001 (drill dia 0.0005mm) -- through-ness must come from the
  // layer id alone, and the tiny hole must not produce a drill.
  it('C53100353 (MBR0530): layer-1 RECT pads with a bogus 0.001 holeRadius stay SMD, no drill', () => {
    const head = { x: 400, y: 300 };
    const synthetic = {
      packageDetail: {
        dataStr: {
          head,
          shape: [
            'PAD~RECT~406.4~300~3.58~4.8~1~~1~0.001~404.61 297.6 408.19 297.6 408.19 302.4 404.61 302.4~0~gge8~0~~Y~~~0.2~406.4,300',
            'PAD~RECT~393.6~300~3.58~4.8~1~~2~0.001~391.81 297.6 395.39 297.6 395.39 302.4 391.81 302.4~0~gge9~0~~Y~~~0.2~393.6,300',
          ],
        },
      },
    };
    const { footprint } = parseEasyedaFootprint(synthetic);
    expect(footprint.pads).toHaveLength(2);
    for (const pad of footprint.pads) {
      expect(pad.layer).toBe('top');
      expect(pad.drill).toBeUndefined();
    }
  });

  // Regression: bottom silk (layer 4) has no `side` field on SilkItem, so it
  // used to print on the top layer. Layer-4 items should be dropped, not
  // shown on top; layer 3 (top silk) is unaffected.
  it('drops bottom-silk (layer 4) items instead of printing them on top', () => {
    const synthetic = {
      packageDetail: {
        dataStr: {
          head: { x: 0, y: 0 },
          shape: [
            'TRACK~0.1524~3~~0 0 1 0~gge1',
            'TRACK~0.1524~4~~0 0 1 0~gge2',
            'CIRCLE~0~0~1~0.1524~4~gge3',
          ],
        },
      },
    };
    const { footprint } = parseEasyedaFootprint(synthetic);
    // Only the layer-3 TRACK survives; the layer-4 TRACK and CIRCLE are dropped.
    expect(footprint.silk).toHaveLength(1);
  });
});
