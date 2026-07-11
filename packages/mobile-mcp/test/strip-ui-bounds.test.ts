import { test, expect } from '@playwright/test';
import { stripUiBounds } from '../src/utils';

test('strips positive bounds attributes', () => {
  const xml = `<node text="ok" bounds="[0,0][1080,2160]" class="X"/>`;
  expect(stripUiBounds(xml)).toBe(`<node text="ok" class="X"/>`);
});

test('strips negative bounds for off-screen elements', () => {
  // UIAutomator reports negative coordinates for elements scrolled partially
  // off-screen; these must be stripped too.
  const xml = `<node bounds="[-5,-20][100,50]"/>`;
  expect(stripUiBounds(xml)).toBe(`<node/>`);
});

test('strips every bounds attribute in the dump', () => {
  const xml = `<a bounds="[0,0][10,10]"/><b bounds="[-1,-1][2,3]"/>`;
  expect(stripUiBounds(xml)).toBe(`<a/><b/>`);
});

test('leaves XML without bounds untouched', () => {
  const xml = `<node text="hi" class="android.widget.TextView"/>`;
  expect(stripUiBounds(xml)).toBe(xml);
});

test('preserves malformed bounds-like strings verbatim', () => {
  // Only well-formed `[x,y][x,y]` integer pairs are stripped; anything else
  // (extra coordinates, decimals, non-numeric) must pass through untouched.
  const threeCoords = `<node bounds="[0,0,0][10,10,10]"/>`;
  const decimal = `<node bounds="[0.5,0][10,10]"/>`;
  const nonNumeric = `<node bounds="abc"/>`;
  expect(stripUiBounds(threeCoords)).toBe(threeCoords);
  expect(stripUiBounds(decimal)).toBe(decimal);
  expect(stripUiBounds(nonNumeric)).toBe(nonNumeric);
});
