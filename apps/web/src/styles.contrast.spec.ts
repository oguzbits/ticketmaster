import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// `ng test` runs in the package folder and bundles the spec, so `import.meta.url` is no file URL.
const css = readFileSync('src/styles.css', 'utf8');

const HEX = /^#([0-9a-f]{6})$/i;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const match = HEX.exec(hex);
  if (!match?.[1]) throw new Error(`Not a 6-digit hex color: ${hex}`);
  const n = Number.parseInt(match[1], 16);
  return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

function ratio(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

/** The color tokens of the `@theme` block, keyed without the `--color-` prefix. */
function tokens(): Map<string, string> {
  const theme = /@theme\s*\{([^}]*)\}/.exec(css)?.[1];
  if (!theme) throw new Error('styles.css has no @theme block');
  return new Map(
    [...theme.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [
      m[1] ?? '',
      m[2] ?? '',
    ])
  );
}

const TEXT = 4.5;
const NON_TEXT = 3;
const SURFACES = ['surface', 'surface-raised'];

// [foreground, background, minimum ratio]
const PAIRS: [string, string, number][] = [
  ...SURFACES.flatMap((bg): [string, string, number][] => [
    ['text', bg, TEXT],
    ['text-muted', bg, TEXT],
    ['danger', bg, TEXT],
    ['accent', bg, TEXT],
    ['edge', bg, NON_TEXT],
    ['focus', bg, NON_TEXT],
    ['seat-available-edge', bg, NON_TEXT],
    ['seat-held-edge', bg, NON_TEXT],
  ]),
  ['on-accent', 'accent', TEXT],
  ['on-accent', 'accent-strong', TEXT],
  ['seat-sold-text', 'seat-sold', TEXT],
  ['text', 'seat-available', TEXT],
  ['text', 'seat-held', TEXT],
  ['text', 'seat-held-stripe', TEXT],
  ['seat-sold', 'surface', NON_TEXT],
];

describe('contrast helper', () => {
  it('rates black on white 21 and #777777 on white below the text minimum', () => {
    expect(ratio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(ratio('#777777', '#ffffff')).toBeLessThan(TEXT);
  });
});

describe('design tokens', () => {
  const map = tokens();

  it.each(PAIRS)('%s on %s reaches %d:1', (foreground, background, minimum) => {
    const fg = map.get(foreground);
    const bg = map.get(background);
    if (!fg || !bg) throw new Error(`Token missing: ${foreground} or ${background}`);
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(minimum);
  });

  it('the theme is light and tells native controls so', () => {
    const lum = (name: string): number => {
      const value = map.get(name);
      if (!value) throw new Error(`Token missing: ${name}`);
      return luminance(value);
    };
    expect(lum('surface-raised')).toBeGreaterThan(0.9);
    expect(lum('surface')).toBeGreaterThan(0.8);
    expect(lum('text')).toBeLessThan(0.1);
    expect(css).toMatch(/color-scheme:\s*light/);
  });

  it('a divider is visible on the page', () => {
    const divider = map.get('edge-subtle');
    const page = map.get('surface');
    if (!divider || !page) throw new Error('Token missing: edge-subtle or surface');
    expect(ratio(divider, page)).toBeGreaterThanOrEqual(1.1);
  });

  it('defines the decorative divider token', () => {
    expect(map.has('edge-subtle')).toBe(true);
  });
});
