import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss, { type ChildNode, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

// jsdom does not compute the cascade, so pin the stylesheet's source shape
// instead. The Plan chip's close mark is stacked over the Plan icon and the
// two trade places through opacity alone, so one stray rule is enough to show
// the mark at rest, to hide both, or to leave a chip too narrow for its label
// as a bare × that names nothing.
const root = postcss.parse(
  readFileSync(
    fileURLToPath(new URL('./ChatEditor.module.css', import.meta.url)),
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

// None of these rules depends on source order, so neither does the comparison.
const sorted = (list: Entry[]) =>
  [...list].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

const namesChipPart = (selector: string) =>
  /\.planChip(Close|Icon)\b/.test(selector);
const ICON = '.planChipIcon > :not(.planChipClose)';

describe('Plan chip close mark', () => {
  it('is styled by exactly these rules', () => {
    // The whole of every rule that names a part of the chip, so an override,
    // an extra selector in a list, a guard that excludes a disabled chip, a
    // reveal that leaves its media block, a dropped size reset or an
    // `!important` all fail here.
    expect(sorted(entries(namesChipPart))).toEqual(
      sorted([
        { at: '', selectors: ['.planChipIcon'], decls: ['position: relative'] },
        {
          at: '',
          selectors: ['.planChipIcon > .planChipClose'],
          decls: [
            'position: absolute',
            'inset: 0',
            'display: inline-flex',
            // `.toolBtnModeIcon > span` would otherwise pin the mark to 14px.
            'width: auto',
            'height: auto',
            'align-items: center',
            'justify-content: center',
            'opacity: 0',
          ],
        },
        {
          at: '',
          selectors: ['.planChipIcon > .planChipClose svg'],
          decls: ['width: 12px', 'height: 12px'],
        },
        // Not limited to a chip that is not busy: it is inert for the length
        // of the request its own click starts.
        {
          at: '',
          selectors: [`.planChip:focus-visible ${ICON}`],
          decls: ['opacity: 0'],
        },
        {
          at: '',
          selectors: ['.planChip:focus-visible .planChipClose'],
          decls: ['opacity: 1'],
        },
        // A touch browser keeps :hover on the last thing tapped.
        {
          at: '@media (hover: hover)',
          selectors: [`.planChip:hover ${ICON}`],
          decls: ['opacity: 0'],
        },
        {
          at: '@media (hover: hover)',
          selectors: ['.planChip:hover .planChipClose'],
          decls: ['opacity: 1'],
        },
        // Shown without hover only beside the label.
        {
          at: '@media (hover: none)',
          selectors: [`.planChip[data-labelled] ${ICON}`],
          decls: ['opacity: 0'],
        },
        {
          at: '@media (hover: none)',
          selectors: ['.planChip[data-labelled] .planChipClose'],
          decls: ['opacity: 1'],
        },
        // Forced colours repaint a masked background away.
        {
          at: '@media (forced-colors: active)',
          selectors: ['.planChipIcon > span:not(.planChipClose)'],
          decls: ['forced-color-adjust: none', 'background: ButtonText'],
        },
      ]),
    );
  });

  it('is not shown or hidden by a rule that reaches it without naming it', () => {
    // The mark is a span inside `.toolBtnModeIcon` inside `.planChip`, so a
    // rule written for either of those can reach it too. This cannot see a
    // rule that names neither.
    const reachesIt = (selector: string) =>
      !namesChipPart(selector) &&
      /\.planChip\b|\.toolBtnModeIcon\b/.test(selector);
    const hiding = entries(reachesIt).filter((entry) =>
      entry.decls.some((decl) => /^(opacity|visibility):/.test(decl)),
    );
    expect(hiding).toEqual([]);
  });

  it('keys its busy cursor on aria-disabled, never on the native attribute', () => {
    // A focused button that becomes natively disabled loses focus to the body,
    // so the chip is only ever inert; a `:disabled` rule would never match.
    // The markup side of that decision is pinned in ChatEditor.test.tsx.
    // State selectors on the chip itself, not on something inside it.
    const onChip = entries((selector) =>
      /^\.planChip(\[|:)[^ ]*$/.test(selector),
    );
    expect(onChip).toEqual([
      {
        at: '',
        selectors: [".planChip[aria-disabled='true']"],
        decls: ['cursor: default'],
      },
    ]);
  });

  it('keeps its hover tint over the generic toolbar hover', () => {
    // It ties the generic toolbar hover on specificity and wins only by coming
    // later, so the shorter `.toolBtn.planChip:hover` would lose to it.
    const line = (rule: Rule) => rule.source?.start?.line ?? 0;
    let generic = 0;
    let tint = 0;
    root.walkRules((rule) => {
      const selectors = rule.selectors.map(tidy);
      if (
        selectors.includes('.toolBtn:not(:disabled):not([data-disabled]):hover')
      ) {
        generic = line(rule);
      }
      if (selectors.some((entry) => entry.startsWith('.toolBtn.planChip'))) {
        tint = line(rule);
        expect(selectors).toEqual(['.toolBtn.planChip:not(:disabled):hover']);
      }
    });
    expect(generic).toBeGreaterThan(0);
    expect(tint).toBeGreaterThan(generic);
  });
});
