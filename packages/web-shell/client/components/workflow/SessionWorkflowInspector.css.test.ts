import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// jsdom does not compute the CSS cascade, so pin the stylesheet's source
// shape instead. A `.inspector button` descendant reset (specificity 0,1,1)
// silently outranks the single-class (0,1,0) styles it envelops — this file's
// .expandButton typography — and preflight.css already normalizes every
// button at zero specificity, so the reset must not return. Likewise a bare
// `.summaryHeading span` rule reaches the .summaryCount pill (a direct child
// of .summaryHeading) and overrides its declared tone and size; the label
// rule must stay scoped to the heading's inner div. Strip comments so the
// guards match selectors only, not prose about them.
const inspectorCss = readFileSync(
  fileURLToPath(
    new URL('./SessionWorkflowInspector.module.css', import.meta.url),
  ),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

describe('SessionWorkflowInspector stylesheet', () => {
  it('never resets `.inspector button` descendants', () => {
    expect(inspectorCss).not.toMatch(
      /\.inspector\s+button\s*\{[^}]*(font:|color:\s*inherit)/,
    );
  });

  it('scopes the summary label rule away from the count pill', () => {
    expect(inspectorCss).not.toMatch(/\.summaryHeading\s+span/);
    expect(inspectorCss).toMatch(/\.summaryHeading\s*>\s*div\s+span/);
  });
});
