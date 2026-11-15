import { describe, expect, it } from 'vitest';

import { EVENT_GLYPH, eventArt } from './event-art';

const IDS = [
  '00000000-0000-4000-8000-0000000000a1',
  '00000000-0000-4000-8000-0000000000a2',
  '00000000-0000-4000-8000-0000000000a3',
  '3f2b8c1e-5d6a-4e7f-9a0b-1c2d3e4f5a6b',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  '11111111-2222-4333-8444-555555555555',
  '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
  'c0ffee00-0000-4000-8000-000000000000',
  'deadbeef-dead-4eef-8ead-beefdeadbeef',
  '',
];

describe('eventArt', () => {
  it('is deterministic', () => {
    for (const id of IDS) expect(eventArt(id)).toEqual(eventArt(id));
  });

  it('gives an integer hue from 0 to 359 and a known glyph', () => {
    for (const id of IDS) {
      const { hue, glyph } = eventArt(id);
      expect(Number.isInteger(hue)).toBe(true);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
      expect(Object.values(EVENT_GLYPH)).toContain(glyph);
    }
  });

  it('tells neighbouring ids apart: ids that differ only in the last character', () => {
    const art = Array.from({ length: 20 }, (_, index) =>
      eventArt(`00000000-0000-4000-8000-0000000000${index.toString(16).padStart(2, '0')}`)
    );

    expect(new Set(art.map(({ glyph }) => glyph)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(art.map(({ hue }) => hue)).size).toBeGreaterThan(10);
  });

  it('gives the five seeded events, whose ids differ only in the last character, three or more glyphs', () => {
    // Without the final mix of the hash these five all land on two glyphs.
    const glyphs = [1, 2, 3, 4, 5].map(
      (index) => eventArt(`00000000-0000-4000-8000-0000000000a${index}`).glyph
    );

    expect(new Set(glyphs).size).toBeGreaterThanOrEqual(3);
  });
});
