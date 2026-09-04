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

  // `.activityList > button` (0,1,1) declares the four-column activity grid
  // for every direct-child button. A control styled with a bare class (0,1,0)
  // loses to it and has its label auto-placed into the 52px first column,
  // wrapping to three or four lines with three empty columns beside it —
  // invisible to jsdom, to the visuals suite and to a green unit run, so it
  // is pinned here at the source.
  it('lets the show-all control out-specify the activity grid', () => {
    expect(inspectorCss).toMatch(
      /\.activityList\s*>\s*button\.showAllActivity\s*\{/,
    );
    expect(inspectorCss).not.toMatch(/(^|\n)\.showAllActivity\s*\{/);
    const rule = inspectorCss.match(
      /\.activityList\s*>\s*button\.showAllActivity\s*\{[^}]*\}/,
    )?.[0];
    // It must actually undo the inherited grid, not merely win the cascade.
    expect(rule).toMatch(/display:\s*block/);
    expect(rule).toMatch(/grid-template-columns:\s*none/);
  });

  // Same collision, already fixed for the wrapping metrics row: keep both
  // pinned so neither regresses to a bare class.
  it('lets the metrics row out-specify its single-line row styles', () => {
    expect(inspectorCss).toMatch(/\.linkedAgents\s+button\s+small\.metrics/);
    expect(inspectorCss).toMatch(/\.deliverables\s+button\s+small\.metrics/);
  });
});
