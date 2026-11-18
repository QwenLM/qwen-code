import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// jsdom computes no cascade, so the cell's stylesheet geometry is pinned at the
// source. The bar offsets come from inline styles; these two do not, and a
// physical value here would run the waterfall against the RTL row text.
const css = readFileSync(
  fileURLToPath(
    new URL('./TrajectoryWaterfallCell.module.css', import.meta.url),
  ),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

describe('TrajectoryWaterfallCell RTL geometry', () => {
  it('positions the TTFT overlay and the end marker with logical offsets', () => {
    expect(css).toMatch(
      /\.ttft \{[^}]*inset-block: 0;\s*inset-inline: 0 auto;/,
    );
    expect(css).toMatch(
      /\.bar\[data-at-end='true'\] \{\s*margin-inline-start: -2px;\s*\}/,
    );
  });
});
