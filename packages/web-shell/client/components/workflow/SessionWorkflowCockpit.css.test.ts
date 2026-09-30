import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// jsdom does not compute the CSS cascade, so pin the stylesheet's source
// shape instead. A `.cockpit button` descendant reset (specificity 0,1,1)
// silently outranks the single-class (0,1,0) styles it envelops — this file's
// .backButton and the embedded PlanExecutionView's nested rows — and the
// matching :focus-visible form (0,2,1) stacks a second outline over
// PlanExecutionView's deliberate node focus rules. preflight.css already
// normalizes every button at zero specificity, so the reset must not return.
// Strip comments so the guards match selectors only, not prose about them.
const cockpitCss = readFileSync(
  fileURLToPath(
    new URL('./SessionWorkflowCockpit.module.css', import.meta.url),
  ),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

describe('SessionWorkflowCockpit stylesheet', () => {
  it('never targets `.cockpit button` descendants', () => {
    expect(cockpitCss).not.toMatch(/\.cockpit\s+button/);
    expect(cockpitCss).not.toMatch(/\.emptyCockpit\s+button\s*\{[^}]*font:/);
  });

  it("scopes the focus ring to the cockpit's own buttons", () => {
    expect(cockpitCss).toMatch(/\.backButton:focus-visible/);
    expect(cockpitCss).toMatch(/\.emptyCockpit\s+button:focus-visible/);
  });

  it('passes the page height to the embedded DAG viewport', () => {
    expect(cockpitCss).toMatch(/\.canvas\s*\{[^}]*display:\s*flex/);
    expect(cockpitCss).toMatch(
      /\.canvas\s*>\s*section\s*\{[^}]*min-height:\s*0[^}]*flex:/,
    );
  });
});
