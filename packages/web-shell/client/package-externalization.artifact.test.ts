import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

const DIST_DIR = resolve(__dirname, '../dist');

function readPackageEntry(fileName: string): string {
  return readFileSync(resolve(DIST_DIR, fileName), 'utf8');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function packageImport(dependency: string): RegExp {
  return new RegExp(
    `from\\s*["']${escapeRegExp(dependency)}(?:/[^"']*)?["']`,
  );
}

function readInjectedCss(bundle: string): string {
  const match = bundle.match(/^const __qwenWebShellCss=("(?:[^"\\]|\\.)*");/);
  if (!match?.[1]) throw new Error('Injected component CSS not found');
  return JSON.parse(match[1]) as string;
}

describe('build artifact — manifest-derived externals', () => {
  it('keeps declared runtime dependencies external in the root entry', () => {
    const bundle = readPackageEntry('index.js');
    for (const dependency of [
      '@modelcontextprotocol/ext-apps',
      '@tanstack/react-table',
      '@tanstack/react-virtual',
      '@xterm/addon-fit',
      '@xterm/xterm',
      'fzf',
    ]) {
      expect(bundle, `${dependency} should remain external`).toMatch(
        packageImport(dependency),
      );
    }
  });

  it('keeps the MCP App bridge external in the transcript entry', () => {
    expect(readPackageEntry('transcript.js')).toMatch(
      /from\s*["']@modelcontextprotocol\/ext-apps\/app-bridge["']/,
    );
  });

  it('ships xterm styles in the interactive entry and scopes them', () => {
    const selectors: string[] = [];
    postcss.parse(readInjectedCss(readPackageEntry('index.js'))).walkRules(
      (rule) => {
        if (rule.selector.includes('.xterm')) selectors.push(rule.selector);
      },
    );

    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      expect(selector).toMatch(
        /\[data-web-shell-(?:root|portal-root)\]/,
      );
    }
  });

  it('keeps the externalized transcript JavaScript below the reviewed ratchet', () => {
    // 1,047,117 bytes at 1e4ecb66 after manifest-derived externalization,
    // against 6,428,095 bytes for the interactive entry in the same build.
    const js = readPackageEntry('transcript.js').replace(
      /^const __qwenWebShellCss=[^\n]*\n/,
      '',
    );
    expect(js.length).toBeLessThan(1_150_000);
  });
});
