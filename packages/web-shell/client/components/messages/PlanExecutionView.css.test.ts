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
    // No second copy of the constant as a var() fallback either: the pitch
    // has one source, and the default only covers the zero-lane case.
    expect(canvas).not.toMatch(/--plan-edge-lane-height,\s*9px/);
    // TS has to actually publish it, or the fallback silently takes over.
    expect(planSource).toMatch(
      /'--plan-edge-lane-height':\s*`\$\{EDGE_LANE_HEIGHT\}px`/,
    );
  });

  // The output port is positioned at `right: -4px`, deliberately outside the
  // node's box, so the node must not clip its overflow — and the status rule
  // must therefore be a border, which border-radius clips natively, rather
  // than a pseudo-element that would need `overflow: hidden` to be rounded.
  // Neither half of that is visible to jsdom or to a green unit run.
  it('keeps the node unclipped so its outgoing port survives', () => {
    const node = planCss.match(/(^|\n)\.node\s*\{[^}]*\}/)?.[0];
    expect(node).toBeTruthy();
    expect(node).not.toMatch(/overflow:\s*hidden/);
    expect(node).toMatch(/border-left:\s*3px solid var\(--node-rule\)/);
    expect(planCss).not.toMatch(/\.node::before\s*\{/);
    expect(planCss).toMatch(
      /\.dagCanvas\s+\.node\[data-plan-output='true'\]::after\s*\{[^}]*right:\s*-4px/,
    );
  });

  it('narrows the DAG lane at two viewport steps', () => {
    // Three 240px lanes plus two 64px gutters exceed a phone viewport, so the
    // canvas scrolled in both axes at once and the horizontal scroll hid the
    // layer the vertical scroll was looking for.
    expect(planCss).toMatch(
      /\.dagCanvas\s+\.layer\s*\{[^}]*flex:\s*0\s+0\s+var\(--plan-layer-width/,
    );
    // Pinned as the source shape, not as an outcome: jsdom computes no
    // cascade and no layout, so this cannot assert that a plan of a given
    // depth stops scrolling — only that both steps exist and narrow.
    const narrow = planCss.match(
      /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\n\}/,
    )?.[0];
    expect(narrow).toMatch(/--plan-layer-width:\s*168px/);
    const narrower = planCss.match(
      /@media\s*\(max-width:\s*480px\)\s*\{[\s\S]*?\n\}/,
    )?.[0];
    expect(narrower).toMatch(/--plan-layer-width:\s*116px/);
  });
});
