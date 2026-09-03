import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// jsdom does not compute the CSS cascade, so pin the stylesheet's source
// shape instead. The DAG reserves bottom padding for its layer-spanning
// return lanes, and that reservation has to use the same pitch that places
// the lanes: TS owns `EDGE_LANE_HEIGHT` and the canvas placed lanes at
// `lane * EDGE_LANE_HEIGHT`, while the stylesheet re-stated the pitch as a
// literal `9px`. Raising the constant alone left the reservation short, the
// clamp pinned the outer lanes together, and layer-spanning edges overlapped
// again — the exact defect the lanes exist to fix — with no test signal,
// because the lane test mocks `offsetHeight` directly. Strip comments so the
// guards match declarations only, not prose about them.
const planCss = readFileSync(
  fileURLToPath(new URL('./PlanExecutionView.module.css', import.meta.url)),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');
const planSource = readFileSync(
  fileURLToPath(new URL('./PlanExecutionView.tsx', import.meta.url)),
  'utf8',
);

describe('PlanExecutionView stylesheet', () => {
  it('takes the edge-lane pitch from TS instead of restating it', () => {
    const canvas = planCss.match(/\.dagCanvas\s*\{[^}]*\}/)?.[0];
    expect(canvas).toBeTruthy();
    expect(canvas).toMatch(/var\(--plan-edge-lane-height/);
    // The literal that used to stand in for the constant must not return
    // anywhere in the reservation.
    expect(canvas).not.toMatch(/--plan-edge-lanes\)\s*\*\s*9px/);
    // TS has to actually publish it, or the fallback silently takes over.
    expect(planSource).toMatch(
      /'--plan-edge-lane-height':\s*`\$\{EDGE_LANE_HEIGHT\}px`/,
    );
  });

  it('keeps the DAG on one scroll axis at phone widths', () => {
    // Three 240px lanes plus two 64px gutters exceed a phone viewport, so the
    // canvas scrolled in both axes at once and the horizontal scroll hid the
    // layer the vertical scroll was looking for.
    expect(planCss).toMatch(
      /\.dagCanvas\s+\.layer\s*\{[^}]*flex:\s*0\s+0\s+var\(--plan-layer-width/,
    );
    const narrow = planCss.match(
      /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\n\}/,
    )?.[0];
    expect(narrow).toMatch(/--plan-layer-width:/);
  });
});
