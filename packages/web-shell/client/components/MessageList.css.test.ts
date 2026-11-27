import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// jsdom computes no cascade, so the mirroring is pinned at the source.
const css = readFileSync(
  fileURLToPath(new URL('./MessageList.module.css', import.meta.url)),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

describe('MessageList RTL timeline tick', () => {
  it('grows the hovered tick inward, toward the card anchor', () => {
    // buildTooltip anchors the card 28px inside rect.right under RTL, which
    // only holds while the tick scales from its inline-start (right) origin;
    // a physical left origin grows it outward, past the panel's clipped edge.
    expect(css).toMatch(
      /:global\(\[dir='rtl'\]\) \.sessionTimelineTick \{\s*transform-origin: right center;\s*\}/,
    );
  });
});
