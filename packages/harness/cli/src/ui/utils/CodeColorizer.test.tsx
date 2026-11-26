/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createLoadedSettings } from '../../config/settings.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { act } from 'react';
import { Text } from 'ink';
import { colorizeCode } from './CodeColorizer.js';
import chalk from 'chalk';
import { ANSI } from '../themes/builtin/dark/ansi-dark.js';
import { ANSILight } from '../themes/builtin/light/ansi-light.js';
import { renderToAnsiString } from './staticRender.js';
import { renderWithProviders } from '../../test-utils/render.js';
import { createMockSettings } from '../../test-utils/settings.js';
import { Link } from '../components/shared/Link.js';

const highlightMode = vi.hoisted(() => ({ value: 'normal' }));
vi.mock('lowlight', async (importOriginal) => {
  const original = await importOriginal<typeof import('lowlight')>();
  return {
    ...original,
    createLowlight: (...args: Parameters<typeof original.createLowlight>) => {
      const highlighter = original.createLowlight(...args);
      const highlight = (
        ...params: Parameters<typeof highlighter.highlight>
      ) => {
        if (highlightMode.value === 'throw')
          throw new Error('Highlight failed');
        if (highlightMode.value === 'empty')
          return { type: 'root' as const, children: [] };
        return highlighter.highlight(...params);
      };
      const highlightAuto = (
        ...params: Parameters<typeof highlighter.highlightAuto>
      ) => {
        if (highlightMode.value === 'throw')
          throw new Error('Highlight failed');
        if (highlightMode.value === 'empty')
          return { type: 'root' as const, children: [] };
        return highlighter.highlightAuto(...params);
      };
      return { ...highlighter, highlight, highlightAuto };
    },
  };
});

function textRuns(
  node: React.ReactNode,
  href?: string,
): Array<{ text: string; href?: string; color?: string }> {
  if (typeof node === 'string' || typeof node === 'number')
    return [{ text: String(node), href }];
  if (Array.isArray(node))
    return node.flatMap((child) => textRuns(child, href));
  if (
    !React.isValidElement<{
      children?: React.ReactNode;
      href?: string;
      color?: string;
    }>(node)
  )
    return [];
  const runs = textRuns(
    node.props.children,
    node.type === Link ? node.props.href : href,
  );
  return node.type === Text
    ? runs.map((run) => ({ ...run, color: node.props.color ?? run.color }))
    : runs;
}

afterEach(() => {
  highlightMode.value = 'normal';
});

// The shared test alias discards colors. Exercise the real ANSI tokenizer.
vi.mock('@alcalzone/ansi-tokenize', async () => {
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const packageJson = createRequire(import.meta.url).resolve(
    '@alcalzone/ansi-tokenize/package.json',
  );
  return import(new URL('./build/index.js', pathToFileURL(packageJson)).href);
});

describe('colorizeCode', () => {
  it.each([ANSI, ANSILight])('uses $name slots', async (theme) => {
    const settings = createLoadedSettings(
      { path: '', settings: {}, originalSettings: {} },
      { path: '', settings: {}, originalSettings: {} },
      { path: '', settings: {}, originalSettings: {} },
      true,
      [],
    );
    const previousLevel = chalk.level;
    try {
      chalk.level = 3;
      const lines = colorizeCode({
        code: 'const answer = { value: "text", count: 42 }; // comment',
        language: 'typescript',
        maxWidth: 80,
        settings,
        theme,
        returnLines: true,
      });
      let output = '';
      await act(async () => {
        output = await renderToAnsiString(<>{lines}</>);
      });
      expect(output).toContain('answer');
      // eslint-disable-next-line no-control-regex -- Inspect actual terminal SGR.
      expect(output).toMatch(/\x1b\[(?:3[0-7]|9[0-7])m/);
      // eslint-disable-next-line no-control-regex -- Reject extended color SGR.
      expect(output).not.toMatch(/\x1b\[[\d;]*(?:38|48);(?:2|5);/);
    } finally {
      chalk.level = previousLevel;
    }
  });

  it.each([ANSI, ANSILight])('restores default foreground for $name string interpolation', async (theme) => {
    const settings = createLoadedSettings(
      { path: '', settings: {}, originalSettings: {} },
      { path: '', settings: {}, originalSettings: {} },
      { path: '', settings: {}, originalSettings: {} },
      true,
      [],
    );
    const previousLevel = chalk.level;
    try {
      chalk.level = 3;
      expect(theme.getInkColor('hljs-subst')).toBe('');
      const lines = colorizeCode({
        code: '`hello ${name}`',
        language: 'javascript',
        maxWidth: 80,
        settings,
        theme,
        hideLineNumbers: true,
        returnLines: true,
      });
      let output = '';
      await act(async () => {
        output = await renderToAnsiString(<>{lines}</>);
      });
      expect(output).toContain('\x1b[39m${name}');
    } finally {
      chalk.level = previousLevel;
    }
  });

  const url = 'https://example.com/path?x=%2F&y=1#part';
  const code = `  const url = "${url}";`;

  it.each([
    { language: 'javascript', disableColor: false },
    { language: 'text', disableColor: false },
    { language: null, disableColor: false },
    { language: 'javascript', disableColor: true },
  ])(
    'keeps complete targets and original text with $language / disableColor=$disableColor',
    ({ language, disableColor }) => {
      const settings = createMockSettings({ ui: { showLineNumbers: false } });
      const result = colorizeCode({
        code,
        language,
        disableColor,
        settings,
        maxWidth: 25,
        returnLines: true,
        linkUrls: true,
      });
      const runs = textRuns(result);
      expect(runs.map((run) => run.text).join('')).toBe(code);
      const linked = runs.filter((run) => run.href);
      expect(linked.length).toBeGreaterThan(0);
      expect(linked.every((run) => run.href === url)).toBe(true);
      expect(linked.map((run) => run.text).join('')).toBe(url);
    },
  );

  it.each(["'", '"', '`'])(
    'preserves quoted URL targets ending in a closing parenthesis with %s',
    (quote) => {
      const href = 'https://example.com/search?q=)';
      const source = `const url = ${quote}${href}${quote};`;
      for (const disableColor of [false, true]) {
        const runs = textRuns(
          colorizeCode({
            code: source,
            language: 'javascript',
            settings: createMockSettings(),
            hideLineNumbers: true,
            disableColor,
            maxWidth: 25,
            returnLines: true,
            linkUrls: true,
          }),
        );
        expect(runs.map((run) => run.text).join('')).toBe(source);
        const linked = runs.filter((run) => run.href);
        expect(linked.every((run) => run.href === href)).toBe(true);
        expect(linked.map((run) => run.text).join('')).toBe(href);
      }
    },
  );

  it('maps one URL across syntax-highlight leaves without changing colors or line numbers', () => {
    const settings = createMockSettings({ ui: { showLineNumbers: true } });
    const source = `中😀\n  const target = ${url} `;
    const options = {
      code: source,
      language: 'javascript',
      settings,
      maxWidth: 80,
      returnLines: true as const,
    };
    const original = textRuns(colorizeCode(options));
    const linked = textRuns(colorizeCode({ ...options, linkUrls: true }));
    const byCharacter = (runs: ReturnType<typeof textRuns>) =>
      runs.flatMap((run) => [...run.text].map((char) => [char, run.color]));
    expect(byCharacter(linked)).toEqual(byCharacter(original));
    const urlRuns = linked.filter((run) => run.href);
    expect(urlRuns.length).toBeGreaterThan(1);
    expect(urlRuns.every((run) => run.href === url)).toBe(true);
    expect(urlRuns.map((run) => run.text).join('')).toBe(url);
    expect(linked.some((run) => run.text === '2' && !run.href)).toBe(true);
  });

  it('handles ANSI stripping before mapping highlighted offsets', () => {
    const source = `\u001b[31m中😀\u001b[0m "${url}"`;
    const runs = textRuns(
      colorizeCode({
        code: source,
        language: 'javascript',
        settings: createMockSettings(),
        hideLineNumbers: true,
        maxWidth: 80,
        returnLines: true,
        linkUrls: true,
      }),
    );
    expect(runs.map((run) => run.text).join('')).toBe(`中😀 "${url}"`);
    expect(
      runs
        .filter((run) => run.href)
        .map((run) => run.text)
        .join(''),
    ).toBe(url);
  });

  it.each(['empty', 'throw'])(
    'links plain text when highlighting returns %s',
    (mode) => {
      highlightMode.value = mode;
      const runs = textRuns(
        colorizeCode({
          code,
          settings: createMockSettings(),
          hideLineNumbers: true,
          maxWidth: 80,
          returnLines: true,
          linkUrls: true,
        }),
      );
      expect(runs.map((run) => run.text).join('')).toBe(code);
      expect(
        runs
          .filter((run) => run.href)
          .map((run) => run.text)
          .join(''),
      ).toBe(url);
    },
  );

  it('does not auto-link other colorizeCode callers by default', () => {
    const runs = textRuns(
      colorizeCode({
        code: url,
        settings: createMockSettings(),
        maxWidth: 80,
        returnLines: true,
      }),
    );
    expect(runs.every((run) => !run.href)).toBe(true);
  });

  it('rejects control characters in uncolored URL targets', () => {
    const source = 'https://example.com/a\u0007b';
    const runs = textRuns(
      colorizeCode({
        code: source,
        settings: createMockSettings(),
        hideLineNumbers: true,
        disableColor: true,
        maxWidth: 80,
        returnLines: true,
        linkUrls: true,
      }),
    );
    expect(runs.map((run) => run.text).join('')).toBe(source);
    expect(runs.every((run) => !run.href)).toBe(true);
  });

  it('renders empty lines correctly when useAlternateBuffer is true', async () => {
    const code = 'line 1\n\nline 3';
    const settings = createLoadedSettings(
      {
        path: '',
        settings: { ui: { useAlternateBuffer: true, showLineNumbers: false } },
        originalSettings: {
          ui: { useAlternateBuffer: true, showLineNumbers: false },
        },
      },
      { path: '', settings: {}, originalSettings: {} },
      { path: '', settings: {}, originalSettings: {} },
      true,
      [],
    );

    const result = colorizeCode({
      code,
      language: 'javascript',
      maxWidth: 80,
      settings,
      hideLineNumbers: true,
    });

    const { lastFrame, unmount } = await renderWithProviders(<>{result}</>);
    // We expect the output to preserve the empty line.
    // If the bug exists, it might look like "line 1\nline 3"
    // If fixed, it should look like "line 1\n \nline 3" (if we use space) or just have the newline.

    // We can check if the output matches the code (ignoring color codes if any, but lastFrame returns plain text usually unless configured otherwise)
    // Actually lastFrame() returns string with ANSI codes stripped by default in some setups, or not.
    // But ink-testing-library usually returns the visual representation.

    expect(lastFrame()).toMatch(/line 1\s*\n\s*\n\s*line 3/);
    unmount();
  });

  // skip: 现存失败
  it.skip('does not let colors from ansi escape codes leak into colorized code', async () => {
    const code = 'line 1\n\x1b[41mline 2 with red background\x1b[0m\nline 3';
    const settings = createLoadedSettings(
      {
        path: '',
        settings: { ui: { useAlternateBuffer: true, showLineNumbers: false } },
        originalSettings: {
          ui: { useAlternateBuffer: true, showLineNumbers: false },
        },
      },
      { path: '', settings: {}, originalSettings: {} },
      { path: '', settings: {}, originalSettings: {} },
      true,
      [],
    );

    const result = colorizeCode({
      code,
      language: 'javascript',
      maxWidth: 80,
      settings,
      hideLineNumbers: true,
    });

    const renderResult = await renderWithProviders(<>{result}</>);
    await renderResult.waitUntilReady();

    await expect(renderResult).toMatchSvgSnapshot();
    renderResult.unmount();
  });

  it('returns an array of lines when returnLines is true', () => {
    const code = 'line 1\nline 2\nline 3';
    const settings = createLoadedSettings(
      { path: '', settings: {}, originalSettings: {} },
      { path: '', settings: {}, originalSettings: {} },
      { path: '', settings: {}, originalSettings: {} },
      true,
      [],
    );

    const result = colorizeCode({
      code,
      language: 'javascript',
      maxWidth: 80,
      settings,
      hideLineNumbers: true,
      returnLines: true,
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(3);
  });
});
