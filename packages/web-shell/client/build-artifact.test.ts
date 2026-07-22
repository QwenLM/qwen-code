import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss, { type Rule } from 'postcss';

const DIST_PATH = resolve(__dirname, '../dist/index.js');

function readBundle(): string {
  return readFileSync(DIST_PATH, 'utf8');
}

function readInjectedCss(): string {
  const match = readBundle().match(
    /^const __qwenWebShellCss=("(?:[^"\\]|\\.)*");/,
  );
  if (!match?.[1]) throw new Error('Injected component CSS not found');
  return JSON.parse(match[1]) as string;
}

function enclosingLayer(rule: Rule): string | undefined {
  let parent = rule.parent;
  while (parent) {
    if (parent.type === 'atrule' && parent.name.toLowerCase() === 'layer') {
      return parent.params;
    }
    parent = parent.parent;
  }
  return undefined;
}

describe('build artifact — package boundary', () => {
  it('externalizes @qwen-code/webui/daemon-react-sdk', () => {
    const bundle = readBundle();
    expect(bundle).toContain('from "@qwen-code/webui/daemon-react-sdk"');
  });

  it('does not inline DaemonSessionProvider source code', () => {
    const bundle = readBundle();
    expect(bundle).not.toMatch(/DaemonStoreContext\s*=\s*createContext/);
  });

  it('does not inline createContext from React for provider contexts', () => {
    const bundle = readBundle();
    const contextMatches = bundle.match(/createContext\(/g) ?? [];
    // WebShell's own ThemeContext is fine; but there should be at most
    // a small number of createContext calls (WebShell internal only).
    // If webui Provider got bundled, we'd see many more.
    expect(contextMatches.length).toBeLessThanOrEqual(3);
  });

  it('externalizes react and react-dom', () => {
    const bundle = readBundle();
    expect(bundle).toContain('from "react"');
    expect(bundle).toContain('from "react/jsx-runtime"');
    expect(bundle).not.toContain('react/jsx-dev-runtime');
    expect(bundle).not.toContain('jsxDEV');
    expect(bundle).not.toContain('fileName:');
  });

  it('externalizes @qwen-code/sdk subpaths', () => {
    const bundle = readBundle();
    // Should not contain raw SDK implementation
    expect(bundle).not.toMatch(/DaemonSessionClient\s*\{/);
  });

  it('scopes every component CSS rule to a WebShell root', () => {
    const unscoped: string[] = [];
    postcss.parse(readInjectedCss()).walkRules((rule) => {
      let parent = rule.parent;
      while (parent) {
        if (
          parent.type === 'atrule' &&
          parent.name.toLowerCase().endsWith('keyframes')
        ) {
          return;
        }
        parent = parent.parent;
      }
      if (
        !rule.selector.includes('[data-web-shell-root]') &&
        !rule.selector.includes('[data-web-shell-portal-root]')
      ) {
        unscoped.push(rule.selector);
      }
    });
    expect(unscoped).toEqual([]);
  });

  it('applies Tailwind theme variables to WebShell roots', () => {
    const themeRules: string[] = [];
    postcss.parse(readInjectedCss()).walkRules((rule) => {
      if (
        rule.nodes.some(
          (node) => node.type === 'decl' && node.prop === '--spacing',
        )
      ) {
        themeRules.push(rule.selector);
      }
    });

    expect(themeRules).toContain(
      ':is([data-web-shell-root]:where([data-web-shell-shadcn]), [data-web-shell-portal-root]:where([data-web-shell-shadcn]))',
    );
    expect(themeRules).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining(':root'),
        expect.stringContaining(':host'),
      ]),
    );
  });

  it('keeps component resets and utilities above plain host selectors', () => {
    const root = postcss.parse(readInjectedCss());
    const rules: Rule[] = [];
    root.walkRules((rule) => rules.push(rule));

    const headingIndex = rules.findIndex(
      (rule) =>
        rule.selector.includes(':where(h1,h2,h3,h4,h5,h6)') &&
        rule.nodes.some(
          (node) =>
            node.type === 'decl' &&
            node.prop === 'font' &&
            node.value === 'inherit',
        ),
    );
    const formControlIndex = rules.findIndex(
      (rule) =>
        rule.selector.includes(
          ':where(button,input,optgroup,select,textarea)',
        ) &&
        rule.nodes.some(
          (node) =>
            node.type === 'decl' &&
            node.prop === 'font' &&
            node.value === 'inherit',
        ),
    );
    const utilityIndex = rules.findIndex((rule) =>
      rule.selector.includes('.px-2\\.5'),
    );
    const cssModuleIndex = rules.findIndex((rule) =>
      rule.nodes.some(
        (node) => node.type === 'decl' && node.prop === '--chat-content-width',
      ),
    );

    expect(headingIndex).toBeGreaterThanOrEqual(0);
    expect(formControlIndex).toBeGreaterThanOrEqual(0);
    expect(utilityIndex).toBeGreaterThan(headingIndex);
    expect(utilityIndex).toBeGreaterThan(formControlIndex);
    expect(cssModuleIndex).toBeGreaterThan(utilityIndex);

    const headingRule = rules[headingIndex]!;
    const formControlRule = rules[formControlIndex]!;
    const utilityRule = rules[utilityIndex]!;
    const cssModuleRule = rules[cssModuleIndex]!;

    expect(enclosingLayer(headingRule)).toBeUndefined();
    expect(enclosingLayer(formControlRule)).toBeUndefined();
    expect(enclosingLayer(utilityRule)).toBeUndefined();
    expect(headingRule.selector).toContain(
      ':is([data-web-shell-root]:where([data-web-shell-shadcn]),[data-web-shell-portal-root]:where([data-web-shell-shadcn]))',
    );
    expect(cssModuleRule.selector).toContain(
      ':where([data-web-shell-root][data-web-shell-shadcn]',
    );
    expect(cssModuleRule.selector).not.toContain(':is([data-web-shell-root]');

    const conflictingLayers: string[] = [];
    root.walkAtRules('layer', (atRule) => {
      if (
        ['theme', 'base', 'components', 'utilities'].includes(atRule.params)
      ) {
        conflictingLayers.push(atRule.params);
      }
    });
    expect(conflictingLayers).toEqual([]);
  });

  it('prefixes global CSS registrations and animations', () => {
    const unscoped: string[] = [];
    postcss.parse(readInjectedCss()).walkAtRules((atRule) => {
      const name = atRule.name.toLowerCase();
      if (
        name.endsWith('keyframes') &&
        !atRule.params.startsWith('qwen-web-shell-')
      ) {
        unscoped.push(`@${atRule.name} ${atRule.params}`);
      }
      if (
        name === 'property' &&
        !atRule.params.startsWith('--qwen-web-shell-')
      ) {
        unscoped.push(`@property ${atRule.params}`);
      }
    });
    expect(unscoped).toEqual([]);
  });
});
