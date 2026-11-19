import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// jsdom computes no cascade, so the strip's stylesheet geometry is pinned at
// the source. The domain offset comes from an inline style; these three do
// not, and a physical value here would run the strip against the logical
// waterfall rows below it under RTL.
const css = readFileSync(
  fileURLToPath(new URL('./TrajectoryOverview.module.css', import.meta.url)),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

describe('TrajectoryOverview RTL geometry', () => {
  it('positions the selection, turn marks and spans with logical offsets', () => {
    expect(css).toMatch(
      /\.selection \{[^}]*inset-inline-start: var\(--left\);/,
    );
    expect(css).toMatch(/\.turnMark \{[^}]*inset-inline-start: var\(--left\);/);
    expect(css).toMatch(
      /\.span \{[^}]*inset-inline-start: min\(var\(--left\), calc\(100% - 3px\)\);/,
    );
  });

  it('mirrors the TTFT gradient with the axis', () => {
    expect(css).toMatch(
      /:global\(\[dir='rtl'\]\) \.span\[data-lane='0'\]\[data-ttft='true'\] \{[^}]*to left,/,
    );
  });
});
