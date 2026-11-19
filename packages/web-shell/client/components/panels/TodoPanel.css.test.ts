import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss, { type ChildNode, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

// jsdom does not compute the cascade, so pin the stylesheet's source shape
// instead. `.detail` is `position: absolute`, and its containing block is
// App's `.bottomPanels` (`position: absolute; left: 0; right: 0` in
// App.module.css), which spans the column — that is what makes
// `width: min(560px, 100%)` mean "the column width", and it is what fixes
// #16970. The card must therefore stay anchored to `.bottomPanels`:
// re-adding `position: relative` to `.panel` (a plausible "the card is
// absolute but the wrapper is not a positioning context" cleanup) silently
// re-anchors it to the fit-content pill and restores the clipping with every
// other test green. Re-basing the width on the viewport does the same in
// split view.
const root = postcss.parse(
  readFileSync(
    fileURLToPath(new URL('./TodoPanel.module.css', import.meta.url)),
    'utf8',
  ),
);

interface Entry {
  at: string;
  selectors: string[];
  decls: string[];
}

// A formatter may wrap a long selector at a combinator.
const tidy = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Every enclosing at-rule, outermost first: a rule can be switched off from
    further out than its direct parent. */
function atRulesAround(rule: Rule): string {
  const chain: string[] = [];
  for (let node = rule.parent; node; node = node.parent) {
    if (node.type === 'atrule') {
      chain.unshift(`@${node.name} ${tidy(node.params)}`);
    }
  }
  return chain.join(' > ');
}

function declarations(rule: Rule): string[] {
  return (rule.nodes ?? [])
    .filter((node: ChildNode) => node.type !== 'comment')
    .map((node: ChildNode) =>
      node.type === 'decl'
        ? `${node.prop}: ${node.value}${node.important ? ' !important' : ''}`
        : // Nested rules would hide declarations from a flat reading.
          `<nested ${node.type}>`,
    );
}

function entries(matches: (selector: string) => boolean): Entry[] {
  const found: Entry[] = [];
  root.walkRules((rule) => {
    const selectors = rule.selectors.map(tidy);
    if (!selectors.some(matches)) return;
    found.push({
      at: atRulesAround(rule),
      selectors,
      decls: declarations(rule),
    });
  });
  return found;
}

const sorted = (list: Entry[]) =>
  [...list].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

describe('Todo detail tooltip layout contract', () => {
  it('keeps .panel out of the containing block of .detail', () => {
    // The whole of the rule, so a re-added `position: relative` (or any
    // other positioning declaration) fails here.
    expect(sorted(entries((selector) => selector === '.panel'))).toEqual([
      {
        at: '',
        selectors: ['.panel'],
        decls: [
          'width: fit-content',
          'max-width: min(100%, 560px)',
          'margin: 0 auto',
          'color: var(--muted-foreground)',
          'outline: none',
        ],
      },
    ]);
  });

  it('sizes the card to the column, not the viewport', () => {
    const decls = entries((selector) => selector === '.detail').flatMap(
      (entry) => entry.decls,
    );
    expect(decls).toContain('position: absolute');
    expect(decls).toContain('width: min(560px, 100%)');
    expect(decls).toContain('left: 50%');
    expect(decls).toContain('bottom: calc(100% + 8px)');
    expect(decls).toContain('transform: translate(-50%, 6px)');
    expect(decls).toContain('pointer-events: none');
    // The pre-#16970 width measured against the browser viewport, which a
    // split pane's overflow:hidden then clips.
    expect(decls).not.toContain(
      expect.stringMatching(/^width:\s*min\(560px,\s*calc\(100vw/),
    );
  });

  it('bridges the 8px band between the bar and the card', () => {
    // The card floats 8px above the bar; a real pointer crosses that band on
    // the way from the pill to the card. The band is a pseudo-element of
    // .panel — the only .bottomPanels child that is hit-testable — and it
    // must not make .panel a positioning context (see the .panel rule
    // above), so it resolves against .bottomPanels like the card does.
    expect(sorted(entries((selector) => selector === '.panel::after'))).toEqual(
      [
        {
          at: '',
          selectors: ['.panel::after'],
          decls: [
            "content: ''",
            'position: absolute',
            'left: 50%',
            'bottom: 100%',
            'width: min(560px, 100%)',
            'height: 8px',
            'transform: translateX(-50%)',
            'pointer-events: none',
          ],
        },
      ],
    );
  });

  it('lifts the card and the band together, on hover and focus-within only', () => {
    // While the card is hidden, the band must pass clicks to the transcript,
    // and the card must stay out of the hit path.
    expect(
      sorted(
        entries(
          (selector) =>
            selector === '.panel:hover .detail' ||
            selector === '.panel:focus-within .detail',
        ),
      ),
    ).toEqual([
      {
        at: '',
        selectors: ['.panel:hover .detail', '.panel:focus-within .detail'],
        decls: [
          'opacity: 1',
          'pointer-events: auto',
          'transform: translate(-50%, 0)',
        ],
      },
    ]);
    expect(
      sorted(
        entries(
          (selector) =>
            selector === '.panel:hover::after' ||
            selector === '.panel:focus-within::after',
        ),
      ),
    ).toEqual([
      {
        at: '',
        selectors: ['.panel:hover::after', '.panel:focus-within::after'],
        decls: ['pointer-events: auto'],
      },
    ]);
  });

  it('gives the clickable card its cursor from the module, not inline', () => {
    expect(
      sorted(entries((selector) => selector === '.detailClickable')),
    ).toEqual([
      { at: '', selectors: ['.detailClickable'], decls: ['cursor: pointer'] },
    ]);
  });
});
