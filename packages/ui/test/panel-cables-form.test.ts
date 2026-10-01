import { describe, it, expect } from 'vitest';
import type { CheckFinding } from '@flamingo/engine';
import { aliasesText, buildLink, describeLink, parseAliases, parsePinMap } from '../src/panel/cables-form.js';
import type { CableForm } from '../src/panel/cables-form.js';
import { findingSummary } from '../src/checks/finding-row.js';

const KEYS = new Set(['S', 'D', 'M']);
const form = (over: Partial<CableForm> = {}): CableForm => ({
  from: 'S:J5',
  to: ['D:J6'],
  straight: true,
  pinMap: '',
  aliases: '',
  note: '',
  ...over,
});

describe('parsePinMap', () => {
  it('reads pairs separated by commas, semicolons or lines, with any of = > -> :', () => {
    expect(parsePinMap('1 = 3, 2=4; 5 -> 7\n6 > 8\n9: 10')).toEqual({
      ok: true,
      value: { '1': '3', '2': '4', '5': '7', '6': '8', '9': '10' },
    });
  });

  it('keeps pad names that are not numbers', () => {
    expect(parsePinMap('A1B12 = A1')).toEqual({ ok: true, value: { A1B12: 'A1' } });
  });

  it('refuses an empty map, a lone pad, a pad mapped twice, and spaces in pad names', () => {
    expect(parsePinMap('  ').ok).toBe(false);
    expect(parsePinMap('1 = 3, 2').ok).toBe(false);
    const twice = parsePinMap('1 = 3, 1 = 4');
    expect(twice).toEqual({ ok: false, error: 'pin map: pad 1 is mapped twice' });
    expect(parsePinMap('1 2 = 3').ok).toBe(false);
  });
});

describe('parseAliases', () => {
  it('reads alias pairs and drops ones that only change case', () => {
    expect(parseAliases('M_EN = MOTION_EN, sda = SDA\nUART=TMC_UART')).toEqual({
      ok: true,
      value: { M_EN: 'MOTION_EN', UART: 'TMC_UART' },
    });
  });

  it('allows nothing at all', () => {
    expect(parseAliases('')).toEqual({ ok: true, value: {} });
  });

  it('refuses one name with two meanings', () => {
    expect(parseAliases('A = B, A = C').ok).toBe(false);
  });
});

describe('buildLink', () => {
  it('builds a straight link with no empty extras', () => {
    expect(buildLink(form(), KEYS)).toEqual({ ok: true, value: { from: 'S:J5', to: ['D:J6'], map: 'straight' } });
  });

  it('builds a mapped link with aliases and a note, trimming what was typed', () => {
    const r = buildLink(form({ to: [' D:J6 ', '', 'M:J2'], straight: false, pinMap: '1=2', aliases: 'M_EN=MOTION_EN', note: ' ribbon ' }), KEYS);
    expect(r).toEqual({
      ok: true,
      value: { from: 'S:J5', to: ['D:J6', 'M:J2'], map: { '1': '2' }, aliases: { M_EN: 'MOTION_EN' }, note: 'ribbon' },
    });
  });

  it('says what is missing', () => {
    expect(buildLink(form({ from: '' }), KEYS)).toEqual({ ok: false, error: 'Pick the header the cable starts at.' });
    expect(buildLink(form({ to: ['', ' '] }), KEYS)).toEqual({ ok: false, error: 'Pick at least one header the cable goes to.' });
    expect(buildLink(form({ straight: false, pinMap: '' }), KEYS).ok).toBe(false);
  });

  it('refuses what the server would: unknown boards, a header joined to itself', () => {
    const unknown = buildLink(form({ to: ['X:J1'] }), KEYS);
    expect(unknown.ok).toBe(false);
    expect(!unknown.ok && unknown.error).toMatch(/unknown source "X"/);
    const self = buildLink(form({ to: ['S:J5'] }), KEYS);
    expect(!self.ok && self.error).toMatch(/itself/);
  });
});

describe('describing links and findings', () => {
  it('describeLink and aliasesText', () => {
    expect(describeLink({ id: 'L1', from: 'S:J5', to: ['D:J6', 'M:J2'], map: 'straight' })).toBe('S:J5 → D:J6, M:J2 · straight');
    expect(describeLink({ id: 'L2', from: 'S:J5', to: ['D:J6'], map: { '1': '2' } })).toBe('S:J5 → D:J6 · 1 pin mapped');
    expect(aliasesText({ M_EN: 'MOTION_EN', UART: 'TMC_UART' })).toBe('M_EN = MOTION_EN, UART = TMC_UART');
    expect(aliasesText(undefined)).toBe('');
  });

  it('findingSummary counts errors and warnings, not info', () => {
    const f = (level: CheckFinding['level']): CheckFinding => ({ check: 'interconnect', rule: 'r', level, message: '', items: [] });
    expect(findingSummary([])).toBe('no problems');
    expect(findingSummary([f('info')])).toBe('no problems');
    expect(findingSummary([f('error'), f('error'), f('warn'), f('info')])).toBe('2 errors · 1 warning');
    expect(findingSummary([f('warn'), f('warn')])).toBe('2 warnings');
  });
});
