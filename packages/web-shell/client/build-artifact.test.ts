import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss, { type Rule } from 'postcss';

const DIST_DIR = resolve(__dirname, '../dist');
const DIST_PATH = resolve(DIST_DIR, 'index.js');
const TRANSCRIPT_DIST_PATH = resolve(DIST_DIR, 'transcript.js');

function readBundle(): string {
  return readFileSync(DIST_PATH, 'utf8');
}

function readTranscriptBundle(): string {
  return readFileSync(TRANSCRIPT_DIST_PATH, 'utf8');
}

function readPackageJavascript(): string {
  return readdirSync(DIST_DIR)
    .filter((fileName) => fileName.endsWith('.js'))
    .map((fileName) => readFileSync(resolve(DIST_DIR, fileName), 'utf8'))
    .join('\n');
}

function readInjectedCss(bundle = readBundle()): string {
  const match = bundle.match(/^const __qwenWebShellCss=("(?:[^"\\]|\\.)*");/);
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
  it('does not depend on @qwen-code/webui', () => {
    const bundle = readPackageJavascript();
    expect(bundle).not.toContain('@qwen-code/webui');
  });

  it('owns the DaemonSessionProvider source code', () => {
    const bundle = readPackageJavascript();
    expect(bundle).toContain(
      'useDaemonSessionNotices must be used within DaemonSessionProvider',
    );
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
    const bundle = readPackageJavascript();
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

  it('keeps scrollbar styles available inside component and portal roots', () => {
    let scrollbarRootRule: Rule | undefined;
    postcss.parse(readInjectedCss()).walkRules((rule) => {
      if (
        rule.nodes.some(
          (node) =>
            node.type === 'decl' &&
            node.prop === 'scrollbar-color' &&
            node.value === 'var(--scrollbar-thumb) var(--scrollbar-track)',
        )
      ) {
        scrollbarRootRule = rule;
      }
    });

    expect(scrollbarRootRule?.selector).toContain(
      ':is([data-web-shell-root]:where([data-web-shell-shadcn]),[data-web-shell-portal-root]:where([data-web-shell-shadcn]))',
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

  it('removes the transcript width cap from fullscreen panels', () => {
    let fullscreenRule: Rule | undefined;
    postcss.parse(readInjectedCss()).walkRules((rule) => {
      if (
        rule.selector.includes('panelFullscreen') &&
        rule.nodes.some(
          (node) =>
            node.type === 'decl' &&
            node.prop === '--chat-content-width' &&
            node.value === '100%',
        )
      ) {
        fullscreenRule = rule;
      }
    });

    expect(fullscreenRule).toBeDefined();
    expect(fullscreenRule?.selector).toMatch(
      /\._panelFullscreen_[A-Za-z0-9_]+$/,
    );
    expect(fullscreenRule?.selector).not.toContain('panelDrawer');
    expect(fullscreenRule?.selector).not.toContain(':not(');
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

  it('ships the ::selection highlight for message content in the lib bundle (#8214)', () => {
    // The defensive ::selection rule must reach embedded deployments -
    // i.e. it must be in the component-scoped CSS injected into dist/index.js,
    // not only the standalone app's standalone.css. Asserting the rule is
    // present and scoped under the WebShell root pins the lib-bundle fix.
    let matched: Rule | undefined;
    postcss.parse(readInjectedCss()).walkRules((rule) => {
      // Match the effect (selectable rows get a ::selection rule scoped to
      // the WebShell root), not the exact notation - a maintainer changing
      // `background` to `background-color` (the CSS Pseudo-Elements-4 name)
      // should not break this pin while the e2e one stays green.
      if (
        rule.selector.includes('[data-user-selectable]') &&
        rule.selector.includes('::selection')
      ) {
        matched = rule;
      }
    });
    expect(
      matched,
      '::selection rule for [data-user-selectable] missing from lib bundle',
    ).toBeDefined();
    expect(matched?.selector).toContain('[data-web-shell-root]');
    expect(
      matched?.nodes.some(
        (n) =>
          n.type === 'decl' &&
          (n.prop === 'background' || n.prop === 'background-color'),
      ),
    ).toBe(true);
  });

  it('ships self-contained KaTeX styles and fonts for embedded transcripts', () => {
    const css = readInjectedCss();
    const root = postcss.parse(css);
    let mathmlRule: Rule | undefined;
    let hasInlineFont = false;

    root.walkRules((rule) => {
      if (rule.selector.includes('.katex-mathml')) {
        mathmlRule = rule;
      }
    });
    root.walkAtRules('font-face', (atRule) => {
      if (
        atRule.nodes?.some(
          (node) =>
            node.type === 'decl' &&
            node.prop === 'src' &&
            node.value.includes('data:font/woff2;base64,'),
        )
      ) {
        hasInlineFont = true;
      }
    });

    expect(mathmlRule?.selector).toContain('[data-web-shell-root]');
    expect(hasInlineFont).toBe(true);
  });
});

describe('build artifact — transcript entry (#11031)', () => {
  // `@qwen-code/web-shell/transcript` exists so the self-contained
  // `/export html` document renderer can bundle the read-only transcript
  // without the interactive shell. Nothing here is enforced by tree shaking:
  // the package root injects its stylesheet as a top-level side effect, which
  // no bundler can drop, so the boundary has to be a real entry point.
  it('does not pull the editor stack into the transcript entry', () => {
    // Import specifiers of externals survive minification verbatim, so their
    // absence is a reliable signal that the module never entered the graph.
    // The signal lives in the JS only: injectCssModules (vite.lib.config.ts)
    // prepends the stylesheet as a single-line `__qwenWebShellCss` constant,
    // and Tailwind v4 compiles classes from every scanned source file rather
    // than this entry's graph, so the CSS carries e.g. drawer.tsx's
    // `data-[vaul-drawer-direction=…]` selectors even though no transcript JS
    // imports vaul. Guard the JS remainder; if the injection shape changes
    // the replace() is a no-op and these checks fail loudly, not falsely.
    const js = readTranscriptBundle().replace(
      /^const __qwenWebShellCss=[^\n]*\n/,
      '',
    );
    expect(js).not.toContain('@codemirror/');
    expect(js).not.toContain('"codemirror"');
    expect(js).not.toContain('vaul');
  });

  it('keeps the transcript entry a fraction of the interactive entry', () => {
    // The daemon hook runtime is NOT absent from this entry — MessageList
    // renders McpStatusMessage, TasksStatusMessage and the artifact turn
    // outputs, and those call the strict useDaemonActions /
    // useDaemonWorkspace hooks, so the provider guards ship. Asserting their
    // absence would assert something this entry does not deliver (see the
    // docblock in client/transcript.ts and #11100).
    //
    // What the entry does deliver is a bounded payload, so bound it. The JS
    // remainder measured 1,140,948 bytes at 1d94060f5 (a reviewer's local
    // build of this branch), against 7,021,715 for dist/index.js in the same
    // build. The ceiling is that measurement plus headroom; re-measure and
    // lower it if the entry gets leaner.
    const js = readTranscriptBundle().replace(
      /^const __qwenWebShellCss=[^\n]*\n/,
      '',
    );
    expect(js.length).toBeLessThan(1_300_000);
  });

  it('still carries what a transcript actually renders', () => {
    const bundle = readTranscriptBundle();
    expect(bundle).toContain('react-markdown');
    expect(bundle).toContain('WebShellTranscript');
  });

  it('injects its stylesheet under its own entry key', () => {
    // Separate rollup runs produce different stylesheets per entry, so the
    // injection guard is keyed per entry — a shared key would let whichever
    // entry loaded first suppress the other's rules.
    expect(readBundle()).toContain('data-qwen-web-shell-entry="index"');
    expect(readTranscriptBundle()).toContain(
      'data-qwen-web-shell-entry="transcript"',
    );
    // Both keep the shared marker that shadow-root style adoption reads.
    expect(readTranscriptBundle()).toContain(
      's.dataset.qwenWebShell="component"',
    );
  });

  it('keeps KaTeX border overrides after Tailwind preflight', () => {
    for (const bundle of [readBundle(), readTranscriptBundle()]) {
      const rules: Rule[] = [];
      postcss
        .parse(readInjectedCss(bundle))
        .walkRules((rule) => rules.push(rule));
      const preflightIndex = rules.findIndex(
        (rule) =>
          rule.selector.includes('[data-web-shell-shadcn]') &&
          rule.selector.includes('::backdrop') &&
          rule.nodes.some(
            (node) =>
              node.type === 'decl' &&
              node.prop === 'border-color' &&
              node.value === 'var(--border)',
          ),
      );
      const katexIndex = rules.findIndex(
        (rule) =>
          rule.selector.includes('.katex *') &&
          rule.nodes.some(
            (node) =>
              node.type === 'decl' &&
              node.prop === 'border-color' &&
              node.value === 'currentColor',
          ),
      );

      expect(preflightIndex).toBeGreaterThanOrEqual(0);
      expect(katexIndex).toBeGreaterThan(preflightIndex);
    }
  });
});
