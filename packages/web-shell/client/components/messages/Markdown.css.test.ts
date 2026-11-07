import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// jsdom neither computes the cascade nor lays anything out, so the pairing that
// holds the canvas together is pinned at the source. The canvas height is the
// diagram's own height plus `MERMAID_CANVAS_PADDING_PX` on both sides, and that
// constant is a second copy of the stylesheet's padding: change the stylesheet
// without it and a diagram that exactly fills the canvas is clipped — nothing in
// the jsdom suite can see that, because every test mocks the geometry. Strip
// comments so the guard matches declarations, not prose about them.
const markdownCss = readFileSync(
  fileURLToPath(new URL('./Markdown.module.css', import.meta.url)),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');
const markdownSource = readFileSync(
  fileURLToPath(new URL('./Markdown.tsx', import.meta.url)),
  'utf8',
);

describe('Mermaid canvas stylesheet', () => {
  it('keeps the canvas padding constant equal to the stylesheet padding', () => {
    const constant = markdownSource.match(
      /MERMAID_CANVAS_PADDING_PX\s*=\s*(\d+)/,
    )?.[1];
    const wrapper = markdownCss.match(/\.mermaidZoomWrapper\s*\{[^}]*\}/)?.[0];
    expect(constant).toBeTruthy();
    expect(wrapper).toBeTruthy();
    expect(wrapper).toMatch(new RegExp(`padding:\\s*${constant}px;`));
  });
});
