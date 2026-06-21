// resolveFont / bundledFonts — mirrors tracks.js but NEVER throws (font lookup is best-effort).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFont, bundledFonts, defaultFontName, regularFont, boldFont } from '../../src/fonts.js';

test('defaultFontName is Inter', () => {
  assert.equal(defaultFontName(), 'Inter');
});

test('bundledFonts lists the committed Inter faces', () => {
  const fonts = bundledFonts();
  const slugs = fonts.map((f) => f.slug);
  assert.ok(slugs.includes('inter-regular'));
  assert.ok(slugs.includes('inter-bold'));
});

test('empty font returns the fallback (default = regular Inter)', () => {
  assert.equal(resolveFont(''), regularFont());
  assert.equal(resolveFont(undefined), regularFont());
});

test('a custom fallback is honoured when the font is empty', () => {
  assert.equal(resolveFont('', boldFont()), boldFont());
});

test('exact alias resolves to the matching face', () => {
  assert.equal(resolveFont('inter-bold'), boldFont());
});

test('an unmatched font falls back instead of throwing', () => {
  assert.equal(resolveFont('no-such-font-xyz'), regularFont());
  assert.doesNotThrow(() => resolveFont('no-such-font-xyz'));
});
