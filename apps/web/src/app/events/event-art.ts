export const EVENT_GLYPH = { STAGE: 'STAGE', NOTE: 'NOTE', STAR: 'STAR', MASK: 'MASK' } as const;

export type EventGlyph = (typeof EVENT_GLYPH)[keyof typeof EVENT_GLYPH];

const GLYPHS: readonly EventGlyph[] = Object.values(EVENT_GLYPH);
const HUES = 360;

/** FNV-1a with a final mix: a stable 32-bit hash, so an event keeps its look across reloads and clients. */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value = Math.imul(value ^ text.charCodeAt(index), 0x01000193) >>> 0;
  }
  // Ids that differ in one trailing character would otherwise share most bits: mix them.
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b) >>> 0;
  return (value ^ (value >>> 13)) >>> 0;
}

/** Decorative only: events have no category, so the glyph carries no meaning. */
export function eventArt(id: string): { hue: number; glyph: EventGlyph } {
  const value = hash(id);
  // SAFETY: the index is below GLYPHS.length, so the element exists.
  const glyph = GLYPHS[(value >>> 9) % GLYPHS.length] as EventGlyph;
  return { hue: value % HUES, glyph };
}
