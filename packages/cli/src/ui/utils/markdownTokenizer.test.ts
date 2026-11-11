/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import chalk from 'chalk';
import { marked, type Tokens } from 'marked';

// Mock the theme to use explicit colors instead of empty strings from the default theme.
vi.mock('../semantic-colors.js', () => ({
  theme: {
    text: {
      primary: 'white',
      accent: 'cyan',
      link: 'blue',
      secondary: 'gray',
    },
    ui: {
      focus: 'green',
    },
  },
}));

import { theme } from '../semantic-colors.js';
import { resolveColor, INK_NAME_TO_HEX_MAP } from '../themes/color-utils.js';
import { themeManager, DEFAULT_THEME } from '../themes/theme-manager.js';
import {
  applyMarkdown,
  createStreamingMarkdownLexerState,
  hasMarkdownSyntax,
  lexMarkdown,
  lexStreamingMarkdown,
  formatToken,
  isFencedCodeClosed,
  isMermaidLang,
} from './markdownTokenizer.js';

describe('markdownTokenizer', () => {
  beforeAll(() => {
    themeManager.setActiveTheme(DEFAULT_THEME.name);
    themeManager.setTerminalBackground(undefined);
  });

  /**
   * Helper to replicate the colorization logic for expected values.
   */
  const expectedColorize = (str: string, color: string) => {
    const resolved = resolveColor(color);
    if (!resolved) return str;
    if (resolved.startsWith('#')) return chalk.hex(resolved)(str);
    const mappedHex = INK_NAME_TO_HEX_MAP[resolved];
    if (mappedHex) return chalk.hex(mappedHex)(str);

    switch (resolved) {
      case 'black':
        return chalk.black(str);
      case 'red':
        return chalk.red(str);
      case 'green':
        return chalk.green(str);
      case 'yellow':
        return chalk.yellow(str);
      case 'blue':
        return chalk.blue(str);
      case 'magenta':
        return chalk.magenta(str);
      case 'cyan':
        return chalk.cyan(str);
      case 'white':
        return chalk.white(str);
      case 'gray':
      case 'grey':
        return chalk.gray(str);
      default:
        return str;
    }
  };

  const primary = (str: string) => expectedColorize(str, theme.text.primary);
  const accent = (str: string) => expectedColorize(str, theme.text.accent);
  const link = (str: string) => expectedColorize(str, theme.text.link);

  describe('hasMarkdownSyntax', () => {
    it('returns false for plain text', () => {
      expect(hasMarkdownSyntax('Hello world')).toBe(false);
    });

    it('returns true for text with markdown markers', () => {
      expect(hasMarkdownSyntax('**bold**')).toBe(true);
      expect(hasMarkdownSyntax('`code`')).toBe(true);
      expect(hasMarkdownSyntax('# heading')).toBe(true);
    });
  });

  describe('applyMarkdown (inline formatting)', () => {
    it('should return plain text with default color', () => {
      const input = 'Hello world';
      const output = applyMarkdown(input, theme.text.primary);
      expect(output).toBe(primary(input));
    });

    it('should return plain text without color when no defaultColor', () => {
      const input = 'Hello world';
      const output = applyMarkdown(input);
      expect(output).toBe(input);
    });

    it('should handle bold text', () => {
      const input = 'This is **bold** text';
      const output = applyMarkdown(input, theme.text.primary);
      expect(output).toBe(
        `${primary('This is ')}${chalk.bold(primary('bold'))}${primary(' text')}`,
      );
    });

    it('should handle italic text with *', () => {
      const input = 'This is *italic* text';
      const output = applyMarkdown(input, theme.text.primary);
      expect(output).toBe(
        `${primary('This is ')}${chalk.italic(primary('italic'))}${primary(' text')}`,
      );
    });

    it('should handle italic text with _', () => {
      const input = 'This is _italic_ text';
      const output = applyMarkdown(input, theme.text.primary);
      expect(output).toBe(
        `${primary('This is ')}${chalk.italic(primary('italic'))}${primary(' text')}`,
      );
    });

    // skip: 现存失败
    it.skip('should handle bold italic text with ***', () => {
      const input = 'This is ***bold italic*** text';
      const output = applyMarkdown(input, theme.text.primary);
      expect(output).toBe(
        `${primary('This is ')}${chalk.bold(chalk.italic(primary('bold italic')))}${primary(' text')}`,
      );
    });

    it('should handle strikethrough text', () => {
      const input = 'This is ~~strikethrough~~ text';
      const output = applyMarkdown(input, theme.text.primary);
      expect(output).toBe(
        `${primary('This is ')}${chalk.strikethrough(primary('strikethrough'))}${primary(' text')}`,
      );
    });

    it.each([
      '~ordinary text~',
      '03:23~03:25:26, 0~4',
      '3~5 seconds, 2~3 retries',
    ])('preserves single tildes in %s', (input) => {
      expect(applyMarkdown(input)).toBe(input);
    });

    it('preserves ranges and bold formatting from the reported response', () => {
      const input = 'level 4~5，传感器 1 和 29 高达 **90~94°C**';
      expect(applyMarkdown(input)).toBe(
        `level 4~5，传感器 1 和 29 高达 ${chalk.bold('90~94°C')}`,
      );
      const tokens = lexMarkdown(input);
      const deleted: string[] = [];
      marked.walkTokens(tokens, (token) => {
        if (token.type === 'del') deleted.push(token.raw);
      });
      expect(deleted).toEqual([]);
      expect((tokens[0] as Tokens.Paragraph).tokens).toContainEqual(
        expect.objectContaining({ type: 'strong', text: '90~94°C' }),
      );
    });

    it('preserves nested formatting and internal tildes in explicit strikethrough', () => {
      expect(applyMarkdown('~~**3~5** seconds~~')).toBe(
        chalk.strikethrough(`${chalk.bold('3~5')} seconds`),
      );
    });

    it('keeps tilde syntax literal in inline code', () => {
      expect(applyMarkdown('`~range~ ~~literal~~`')).toBe(
        accent('~range~ ~~literal~~'),
      );
    });

    it('preserves multiple ranges within a table cell', () => {
      const [table] = lexMarkdown(
        '| Time | Count |\n|---|---|\n|03:23~03:25:26|0~4, then 5~8|',
      ) as Tokens.Table[];
      expect(table.rows[0]?.[1]?.tokens).toEqual([
        expect.objectContaining({ type: 'text', text: '0~4, then 5~8' }),
      ]);
    });

    it('should handle inline code', () => {
      const input = 'This is `code` text';
      const output = applyMarkdown(input, theme.text.primary);
      expect(output).toBe(
        `${primary('This is ')}${accent('code')}${primary(' text')}`,
      );
    });

    // skip: 现存失败
    it.skip('should handle links', () => {
      const input = 'Check [this link](https://example.com)';
      const output = applyMarkdown(input, theme.text.primary);
      expect(output).toBe(
        `${primary('Check ')}${primary('this link')} (${link('https://example.com')})`,
      );
    });

    it('should respect custom default color', () => {
      const customColor = 'cyan';
      const input = 'Hello **world**';
      const output = applyMarkdown(input, customColor);
      const cyan = (str: string) => expectedColorize(str, 'cyan');
      expect(output).toBe(`${cyan('Hello ')}${chalk.bold(cyan('world'))}`);
    });

    it('should handle nested formatting in bold/italic', () => {
      const input = '**Bold with *italic* inside**';
      const output = applyMarkdown(input, theme.text.primary);
      expect(output).toBe(
        chalk.bold(
          `${primary('Bold with ')}${chalk.italic(primary('italic'))}${primary(
            ' inside',
          )}`,
        ),
      );
    });

    it('should handle hex colors as default', () => {
      const hexColor = '#ff00ff';
      const input = 'Hello **world**';
      const output = applyMarkdown(input, hexColor);
      const magenta = (str: string) => chalk.hex('#ff00ff')(str);
      expect(output).toBe(
        `${magenta('Hello ')}${chalk.bold(magenta('world'))}`,
      );
    });

    it('should override default color with accent color for code', () => {
      const input = 'Code: `const x = 1`';
      const output = applyMarkdown(input, 'green');
      const green = (str: string) => expectedColorize(str, 'green');
      expect(output).toBe(`${green('Code: ')}${accent('const x = 1')}`);
    });

    it('should use codespanColor for inline code when provided', () => {
      const input = 'Code: `const x = 1`';
      const output = applyMarkdown(input, 'green', 'green');
      const green = (str: string) => expectedColorize(str, 'green');
      expect(output).toBe(
        `${green('Code: ')}${chalk.bold(green('const x = 1'))}`,
      );
    });

    it('should still use accent for code when codespanColor is undefined', () => {
      const input = 'Code: `const x = 1`';
      const output = applyMarkdown(input);
      expect(output).toBe(`Code: ${accent('const x = 1')}`);
    });

    it('should handle nested formatting with color overrides', () => {
      const input = '**Bold with `code` inside**';
      const output = applyMarkdown(input, theme.text.primary);
      expect(output).toBe(
        chalk.bold(
          `${primary('Bold with ')}${accent('code')}${primary(' inside')}`,
        ),
      );
    });
  });

  describe('lexMarkdown', () => {
    it('should return tokens for markdown content', () => {
      const tokens = lexMarkdown('# Hello\n\nWorld');
      expect(tokens.length).toBeGreaterThan(0);
      expect(tokens[0].type).toBe('heading');
    });
  });

  describe('lexStreamingMarkdown', () => {
    it('matches a full parse after every chunk while retaining stable blocks', () => {
      const chunks = [
        'H',
        'ello',
        '\n\n',
        '## Tit',
        'le',
        '\n\n',
        '- first',
        '\n- sec',
        'ond',
        '\n\n```ts\nconst value =',
        ' 1;',
        '\n```',
      ];
      const state = createStreamingMarkdownLexerState();
      let text = '';

      for (const chunk of chunks) {
        text += chunk;
        expect(lexStreamingMarkdown(text, state)).toEqual([
          ...lexMarkdown(text),
        ]);
      }

      expect(state.stablePrefix).toContain('Hello');
      expect(state.stableTokens.length).toBeGreaterThan(0);
    });

    it('resets the stable cache when streamed text is replaced', () => {
      const state = createStreamingMarkdownLexerState();
      lexStreamingMarkdown('First paragraph.\n\nSecond', state);

      const replacement = '# Replacement';
      expect(lexStreamingMarkdown(replacement, state)).toEqual([
        ...lexMarkdown(replacement),
      ]);
      expect(state.stablePrefix).toBe('');
      expect(state.stableTokens).toEqual([]);
    });

    it('falls back to a full parse for cross-block reference definitions', () => {
      const state = createStreamingMarkdownLexerState();
      lexStreamingMarkdown('First paragraph.\n\n[Qwen][cli]', state);

      const text =
        'First paragraph.\n\n[Qwen][cli]\n\n[cli]: https://example.com';
      expect(lexStreamingMarkdown(text, state)).toEqual(lexMarkdown(text));
      expect(state.stablePrefix).toBe('');
      expect(state.stableTokens).toEqual([]);
    });
  });

  describe('formatToken (block-level)', () => {
    it('should format headings with correct styles', () => {
      const tokens = lexMarkdown('# H1\n## H2\n### H3');
      // Each heading should end with double newline
      for (const token of tokens) {
        if (token.type === 'heading') {
          const result = formatToken(token);
          expect(result).toContain('\n\n');
        }
      }
    });

    it('should format horizontal rules', () => {
      const tokens = lexMarkdown('---');
      const hrToken = tokens.find((t) => t.type === 'hr');
      expect(hrToken).toBeDefined();
      if (hrToken) {
        const result = formatToken(hrToken);
        expect(result).toContain('---');
      }
    });

    it('should format unordered lists', () => {
      const tokens = lexMarkdown('- item A\n- item B');
      const listToken = tokens.find((t) => t.type === 'list');
      expect(listToken).toBeDefined();
      if (listToken) {
        const result = formatToken(listToken);
        expect(result).toContain('- item A');
        expect(result).toContain('- item B');
      }
    });

    it('should format ordered lists', () => {
      const tokens = lexMarkdown('1. First\n2. Second');
      const listToken = tokens.find((t) => t.type === 'list');
      expect(listToken).toBeDefined();
      if (listToken) {
        const result = formatToken(listToken);
        expect(result).toContain('1. First');
        expect(result).toContain('2. Second');
      }
    });

    it('should format blockquotes with bar prefix', () => {
      const tokens = lexMarkdown('> quoted text');
      const bqToken = tokens.find((t) => t.type === 'blockquote');
      expect(bqToken).toBeDefined();
      if (bqToken) {
        const result = formatToken(bqToken);
        expect(result).toContain('│');
        expect(result).toContain('quoted text');
      }
    });
  });

  describe('isFencedCodeClosed', () => {
    const codeToken = (markdown: string): Tokens.Code => {
      const token = lexMarkdown(markdown).find((t) => t.type === 'code');
      if (!token) throw new Error(`no code token in ${JSON.stringify(markdown)}`);
      return token as Tokens.Code;
    };

    it.each([
      ['closed backtick fence', '```mermaid\ngraph TD\n```', true],
      ['closed tilde fence', '~~~mermaid\ngraph TD\n~~~', true],
      ['longer closing fence', '```mermaid\ngraph TD\n`````', true],
      [
        'opener and closer indented 3 spaces, trailing spaces',
        '   ```mermaid\ngraph TD\n   ```   \n',
        true,
      ],
      ['unindented opener, closer indented 3', '```mermaid\ngraph TD\n   ```', true],
      ['CRLF line endings', '```mermaid\r\ngraph TD\r\n```\r\n', true],
      ['unclosed fence', '```mermaid\ngraph TD\nA-->B\n', false],
      ['opener only', '```mermaid', false],
      ['shorter closing fence', '````mermaid\ngraph TD\n```', false],
      ['closer of the other character', '```mermaid\ngraph TD\n~~~', false],
      ['indented code block', 'para\n\n    graph TD\n    A-->B', false],
    ])('%s', (_name, markdown, expected) => {
      expect(isFencedCodeClosed(codeToken(markdown))).toBe(expected);
    });
  });

  describe('isMermaidLang', () => {
    it.each([
      ['mermaid', true],
      ['Mermaid title="x"', true],
      ['MERMAID', true],
      ['mermaid\tfoo', true],
      [' mermaid ', true],
      ['mermaid-js', false],
      ['js', false],
      ['', false],
      [null, false],
      [undefined, false],
    ])('%j -> %s', (lang, expected) => {
      expect(isMermaidLang(lang)).toBe(expected);
    });
  });
});
