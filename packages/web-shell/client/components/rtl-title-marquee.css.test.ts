import { readFileSync } from 'node:fs';
import postcss, { type Root } from 'postcss';
import { describe, expect, it } from 'vitest';

function getEndTransform(css: Root, name: string): string[] {
  const values: string[] = [];
  css.walkAtRules('keyframes', (frames) => {
    if (frames.params !== name) return;
    frames.walkRules('to', (rule) => {
      rule.walkDecls('transform', (decl) => values.push(decl.value));
    });
  });
  return values;
}

describe('overflowing title marquee in RTL', () => {
  it.each([
    [
      './artifacts/ArtifactPanel.module.css',
      'artifactTabTitleScroll',
      ['.tabItem:hover .tabTitleInner', '.tabItem:focus-within .tabTitleInner'],
      '.tabTitle',
    ],
    [
      './sidebar/WebShellSidebar.module.css',
      'sessionTitleScroll',
      [
        '.sessionRow:hover .sessionTextInner',
        '.sessionRow:focus-within .sessionTextInner',
      ],
      '.sessionText',
    ],
    [
      './sidebar/WorkspaceSection.module.css',
      'sessionTitleScroll',
      ['.sessionItemReadOnly:hover .sessionNameInner'],
      '.sessionName',
    ],
  ] as const)(
    '%s mirrors reveal and fade without animating reduced-motion users',
    (file, name, triggers, clip) => {
      const css = postcss.parse(
        readFileSync(new URL(file, import.meta.url), 'utf8'),
      );
      const rtl = ":global([dir='rtl'])";
      const rtlName = `${name}Rtl`;
      const rtlTriggers = new Set<string>();
      const reducedTriggers = new Set<string>();
      const rtlMasks: string[] = [];
      css.walkRules((rule) => {
        for (const selector of rule.selectors) {
          const parent = rule.parent;
          if (parent?.type === 'atrule' && parent.name === 'media') {
            if (
              parent.params === '(prefers-reduced-motion: no-preference)' &&
              rule.nodes.some(
                (node) =>
                  node.type === 'decl' &&
                  node.prop === 'animation-name' &&
                  node.value === rtlName,
              )
            ) {
              rtlTriggers.add(selector);
            }
            if (
              parent.params === '(prefers-reduced-motion: reduce)' &&
              rule.nodes.some(
                (node) =>
                  node.type === 'decl' &&
                  node.prop === 'animation' &&
                  node.value === 'none',
              )
            ) {
              reducedTriggers.add(selector);
            }
          }
          if (selector === `${rtl} ${clip}[data-web-shell-title-overflow]`) {
            rule.walkDecls('mask-image', (decl) => rtlMasks.push(decl.value));
          }
        }
      });

      for (const trigger of triggers) {
        expect(rtlTriggers.has(`${rtl} ${trigger}`)).toBe(true);
        expect(reducedTriggers.has(trigger)).toBe(true);
      }
      expect(rtlMasks).toEqual([
        'linear-gradient(to left, #000 calc(100% - 10px), transparent)',
      ]);
      expect(getEndTransform(css, name)).toEqual([
        'translateX(calc(var(--session-title-scroll-distance, 0px) * -1))',
      ]);
      expect(getEndTransform(css, rtlName)).toEqual([
        'translateX(var(--session-title-scroll-distance, 0px))',
      ]);
    },
  );
});
