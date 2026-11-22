import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

// jsdom does not compute the CSS cascade, so pin the stylesheet's source
// shape instead. The session row action overlay is `position: absolute;
// inset: 0` over the meta slot: without `pointer-events: none` on the hidden
// container it swallows row taps (including on destructive Delete); without a
// touch-media reveal, touch devices cannot reach pin/rename/export/delete
// at all; and the meta slot's width reservation must follow the same
// conditions as the reveal, or focus reserves a gutter for controls it never
// shows. Strip comments so the guards match selectors only.
const sidebarCss = readFileSync(
  fileURLToPath(new URL('./WebShellSidebar.module.css', import.meta.url)),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The :has() rules live inside @supports blocks with nested @media, so the
 * stylesheet is parsed instead of sliced with regex. `media(query)` returns
 * the text of the top-level @media blocks matching the query (nested blocks
 * belong to capability-guarded rule groups, not to the row-action layout
 * contract this test pins); `withoutAll(query)` is the stylesheet with every
 * @media block matching the query removed, nested ones included.
 */
function parseOnce() {
  return postcss.parse(sidebarCss);
}

function mediaBlocks(query: RegExp): string[] {
  const blocks: string[] = [];
  parseOnce().walkAtRules('media', (rule) => {
    if (!query.test(rule.params)) return;
    if (rule.parent?.type !== 'root') return;
    blocks.push(rule.toString());
  });
  return blocks;
}

function withoutMedia(query: RegExp): string {
  const root = parseOnce();
  root.walkAtRules('media', (rule) => {
    if (query.test(rule.params)) rule.remove();
  });
  return root.toString();
}

function mediaText(query: RegExp): string {
  return mediaBlocks(query).join('\n');
}

const hoverMedia = mediaText(/hover: hover/);
const nonHoverCss = withoutMedia(/hover: hover/);
// The repo's touch query, matching TOUCH_COMPOSER_QUERY in
// client/hooks/useIsTouchComposer.ts.
const touchMedia = mediaText(/hover: none/);

describe('WebShellSidebar session row actions stylesheet', () => {
  it('keeps the hidden actions overlay inert until revealed', () => {
    expect(sidebarCss).toMatch(
      /\.sessionActions\s*\{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;[^}]*\}/,
    );
  });

  it('reveals the overlay on hover only where hover exists', () => {
    expect(hoverMedia).toMatch(
      /\.sessionRow:hover:not\(\.runningSession\)\s*\.sessionActions,[^}]*\{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;/,
    );
  });

  it('reveals the overlay whenever focus is inside it', () => {
    // :focus-visible alone misses pointer-modality focus on the buttons.
    expect(sidebarCss).toMatch(
      /\.sessionActions:focus-within,[^{]*\{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;/,
    );
  });

  it('keeps the actions visible and tappable on touch devices', () => {
    expect(touchMedia).toMatch(
      /\.sessionActions\s*\{[^}]*position:\s*static;[^}]*opacity:\s*1;/,
    );
    expect(touchMedia).toMatch(
      /\.sessionActionButton\s*\{[^}]*pointer-events:\s*auto;/,
    );
    // On touch the buttons share the slot with the trailing markers instead
    // of overlaying them, so the block must not hide any marker —
    // .sessionAttention is the only per-row carrier of "input needed" and
    // .sessionSourceIcon is the scheduled-task marker — nor reserve a gutter
    // for an overlay.
    expect(touchMedia).not.toMatch(/opacity:\s*0;/);
    expect(touchMedia).not.toMatch(/min-width:\s*var\(--session-actions-width/);
    for (const marker of [
      'sessionGitIcon',
      'sessionLoading',
      'sessionAttention',
      'sessionSourceIcon',
    ]) {
      expect(nonHoverCss).not.toMatch(
        new RegExp(`[^{}]*\\.${marker}[^{}]*\\{[^{}]*opacity:\\s*0;`),
      );
    }
  });

  it('reserves meta slot width only where the overlay can appear', () => {
    expect(sidebarCss).not.toMatch(
      /\.sessionRow:focus-within\s*\.sessionMetaSlot/,
    );
    expect(sidebarCss).toMatch(
      /\.sessionMetaSlot:has\(\.sessionActions:focus-within\),[^{]*\{[^}]*min-width:\s*var\(--session-actions-width/,
    );
    expect(hoverMedia).toMatch(
      /\.sessionRow:hover\s*\.sessionMetaSlot\s*\{[^}]*min-width:\s*var\(--session-actions-width/,
    );
  });

  it('holds the overlay width at rest on rows that show a PR badge', () => {
    // The badge sits right before the slot; growing the slot on hover slid it
    // left and put Pin under the pointer. Narrow touch rows anchor only the
    // action slot so intrinsic badge widths cannot move it outside the row.
    expect(hoverMedia).toMatch(
      /\.sessionMetaSlotReserved\s*\{[^}]*min-width:\s*var\(--session-actions-width/,
    );
    expect(nonHoverCss).not.toMatch(/^[ \t]*\.sessionMetaSlotReserved\s*\{/m);
    expect(touchMedia).toMatch(
      /\.sessionMetaSlotReserved:has\(\.sessionActions\)\s*\{[^}]*display:\s*contents;/,
    );
    expect(touchMedia).toMatch(
      /\.sidebar\.mobileOpen\[data-narrow\]\s+\.sessionRow\s+\.sessionMetaSlotReserved\s+\.sessionActions\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*2px 0 2px auto;[^}]*width:\s*var\(--session-actions-width, 26px\)/,
    );
  });

  it('hides the busy marker when a background-only row reveals its actions', () => {
    // A background-only row is not .runningSession, so hovering anywhere on
    // the row reveals the overlay — not just hovering the meta slot. Without
    // this the amber busy marker sits under the revealed action buttons.
    expect(hoverMedia).toMatch(
      /\.sessionRow:hover:not\(\.runningSession\)\s*\.sessionLoading,[^{]*\{[^}]*opacity:\s*0;/,
    );
  });

  it('keeps the background busy marker on the warning token', () => {
    // The amber is what makes a background-only row read as busy rather than
    // merely spinning, and the component test can only see the class name.
    // Swapping the token for the muted one would keep every suite green, so
    // pin the declaration itself. Prettier wraps the color-mix across lines,
    // so the body must not be assumed to sit on one line.
    expect(sidebarCss).toMatch(
      /\.sessionLoadingBackground\s*\{[^}]*border-top-color:\s*var\(--warning-color/,
    );
    expect(sidebarCss).toMatch(
      /\.sessionLoadingBackground\s*\{[^}]*border-color:\s*color-mix\([^)]*var\(--warning-color/,
    );
  });

  it('hides the trailing markers whenever the overlay is revealed', () => {
    for (const marker of [
      'sessionGitIcon',
      'sessionLoading',
      'sessionAttention',
      'sessionSourceIcon',
    ]) {
      expect(sidebarCss).toMatch(
        new RegExp(
          `\\.sessionMetaSlot:has\\(\\.sessionActions:focus-within\\) \\.${marker},`,
        ),
      );
    }
  });
});

describe('WebShellSidebar more-menu stylesheet', () => {
  it('sizes the popup to its longest label instead of a fixed English width', () => {
    expect(sidebarCss).toMatch(
      /\.moreMenu\s*\{[^}]*width:\s*max-content;[^}]*min-width:\s*240px;[^}]*max-width:\s*min\(22rem,\s*calc\(100vw - 24px\)\);/,
    );
    expect(sidebarCss).not.toMatch(/\.moreMenu\s*\{[^}]*[^-\w]width:\s*240px;/);
  });

  it('keeps more-menu rows a uniform height with left-aligned, unwrapped labels', () => {
    expect(sidebarCss).toMatch(
      /\.moreMenu \.footerButton,\s*\.moreMenu \.collapseButton,[\s\S]*?height:\s*36px;[\s\S]*?text-align:\s*start;/,
    );
    expect(sidebarCss).toMatch(
      /\.moreMenu \.footerButtonLabel,\s*\.moreMenu \.collapseButton > span\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;[^}]*text-align:\s*start;/,
    );
  });
});
