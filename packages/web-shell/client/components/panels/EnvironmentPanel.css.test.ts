import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// jsdom computes no cascade, so the mirroring is pinned at the source.
const panelCss = readFileSync(
  fileURLToPath(new URL('./EnvironmentPanel.module.css', import.meta.url)),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');
const panelSource = readFileSync(
  fileURLToPath(new URL('./EnvironmentPanel.tsx', import.meta.url)),
  'utf8',
);

describe('EnvironmentPanel RTL chevrons', () => {
  it('mirrors the row action chevron once, through the Tailwind utility', () => {
    expect(panelSource).toMatch(/styles\.rowActionIcon\} rtl:-scale-x-100/);
    // Tailwind 4 compiles `-scale-x-100` to the individual `scale` property,
    // which composes with `transform` rather than replacing it: a stylesheet
    // `scaleX(-1)` on the same icon multiplies to +1 and leaves the chevron
    // pointing the LTR way in Arabic.
    expect(panelCss).not.toMatch(/scaleX\(-1\)/);
  });
});
