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

  // `text-overflow` applies to a block container's own inline content, so
  // declaring it on the inline-flex chip did nothing: the title sat in an
  // anonymous flex item and was clipped with no ellipsis. jsdom computes no
  // layout, so this is pinned at the source instead.
  it('puts dependency truncation on the title, not the flex box', () => {
    for (const name of ['dependencyChip', 'dependencyLink']) {
      const rule = planCss.match(
        new RegExp(`(^|\\n)\\.${name}\\s*\\{[^}]*\\}`),
      )?.[0];
      expect(rule).toBeTruthy();
      expect(rule).toMatch(/display:\s*inline-flex/);
      expect(rule).not.toMatch(/text-overflow/);
    }
    const title = planCss.match(
      /\.dependencyChip\s+\.dependencyTitle,\s*\n\s*\.dependencyLink\s+\.dependencyTitle\s*\{[^}]*\}/,
    )?.[0];
    expect(title).toMatch(/text-overflow:\s*ellipsis/);
    expect(title).toMatch(/min-width:\s*0/);
    // The `> span` rules mute every direct-child span, the title included;
    // without its own colour the title would render muted while the chip's
    // `color: var(--foreground)` applies to no rendered text.
    expect(title).toMatch(/color:\s*var\(--foreground\)/);
  });

  it('declares the attention tone after the blocked/ready tone', () => {
    // Both selectors carry the same specificity, so the cascade lets the
    // later rule win: attention must stay declared after the status tones,
    // or a blocked node that also needs attention would wear the muted
    // ring instead of the attention tone its comment promises.
    const attentionAt = planCss.indexOf(".node[data-attention='true']");
    const neutralAt = planCss.indexOf(".node[data-status='blocked']");
    expect(attentionAt).toBeGreaterThan(-1);
    expect(neutralAt).toBeGreaterThan(-1);
    expect(attentionAt).toBeGreaterThan(neutralAt);
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
