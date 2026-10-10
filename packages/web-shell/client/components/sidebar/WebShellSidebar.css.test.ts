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
