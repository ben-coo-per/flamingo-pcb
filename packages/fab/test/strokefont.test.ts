import { describe, it, expect } from 'vitest';
import { strokeText } from '../src/strokefont.js';

// Regression: characters outside the original 0-9 A-Z space - . + _ / set were
// silently dropped ("4.7µF" -> "4.7F", "I2C: SDA" lost the ':'). Newly-added
// glyphs must survive, and any still-unknown character must render as '?'
// rather than vanish (both keep stroke output non-empty per input char).
describe('strokeText', () => {
  it('renders newly-added punctuation and micro-sign glyphs, one stroke-group per char', () => {
    const text = 'µ():,#%=~*<>\'"!?';
    const strokes = strokeText(text, { x: 0, y: 0 }, 1, 0, false);
    // Every character in this string has a non-empty glyph, so each
    // contributes at least one polyline.
    expect(strokes.length).toBeGreaterThanOrEqual(text.length);
  });

  it('an unknown character falls back to the "?" glyph instead of vanishing', () => {
    const known = strokeText('?', { x: 0, y: 0 }, 1, 0, false);
    const unknown = strokeText('@', { x: 0, y: 0 }, 1, 0, false);
    expect(unknown.length).toBe(known.length);
    expect(unknown).toEqual(known);
  });

  it('"4.7µF" keeps the µ instead of dropping it', () => {
    const withMicro = strokeText('4.7µF', { x: 0, y: 0 }, 1, 0, false);
    const withoutMicro = strokeText('4.7F', { x: 0, y: 0 }, 1, 0, false);
    expect(withMicro.length).toBeGreaterThan(withoutMicro.length);
  });

  it('"I2C: SDA" keeps the colon', () => {
    const withColon = strokeText('I2C: SDA', { x: 0, y: 0 }, 1, 0, false);
    const withoutColon = strokeText('I2C SDA', { x: 0, y: 0 }, 1, 0, false);
    expect(withColon.length).toBeGreaterThan(withoutColon.length);
  });
});
