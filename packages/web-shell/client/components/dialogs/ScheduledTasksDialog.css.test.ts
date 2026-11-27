import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// jsdom computes no cascade and no layout, so the switch's travel is pinned
// at the source.
const dialogCss = readFileSync(
  fileURLToPath(new URL('./ScheduledTasksDialog.module.css', import.meta.url)),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

describe('ScheduledTasksDialog toggle', () => {
  it('rests the knob at the inline start and travels toward the inline end', () => {
    const knob = dialogCss.match(/(^|\n)\.toggleKnob\s*\{[^}]*\}/)?.[0];
    expect(knob).toBeTruthy();
    expect(knob).toMatch(/inset-inline-start:\s*2px/);
    expect(knob).not.toMatch(/(^|\s)left:/);
    expect(dialogCss).toMatch(
      /\.toggleOn \.toggleKnob\s*\{[^}]*translateX\(16px\)/,
    );
    // A physical translate would drive the knob back over its own resting
    // edge in Arabic, where the track's start is the right edge.
    expect(dialogCss).toMatch(
      /:global\(\[dir='rtl'\]\) \.toggleOn \.toggleKnob\s*\{[^}]*translateX\(-16px\)/,
    );
  });
});
