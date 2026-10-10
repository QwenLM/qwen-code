/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies the OpenTUI palette/syntax switching: light/dark mode swaps and
 * the settings `ui.theme` face (applyOpenTuiTheme), including the
 * `markup.*` markdown tokens the OpenTUI markdown renderable needs for
 * heading / inline-code / emphasis / link styling.
 */

import { describe, it, expect, vi } from 'vitest';

// theme.ts builds SyntaxStyles at module scope; the real implementation
// needs the OpenTUI native FFI. Capture the registered token maps instead.
vi.mock('@opentui/core', () => ({
  SyntaxStyle: {
    fromStyles: (styles: Record<string, unknown>) => ({ styles }),
  },
}));

import {
  C,
  GRADIENT,
  SYNTAX,
  SYNTAX_DIM,
  applyOpenTuiTheme,
  applyThemeMode,
  markdownMarkupTokens,
  type Palette,
} from './theme.js';
import type { OpenTuiThemeDefinition } from './theme-parity.js';

function syntaxTokens(): Record<string, unknown> {
  return (SYNTAX as unknown as { styles: Record<string, unknown> }).styles;
}

function dimSyntaxTokens(): Record<string, unknown> {
  return (SYNTAX_DIM as unknown as { styles: Record<string, unknown> }).styles;
}

const PALETTE = {
  text: '#112233',
  dim: '#445566',
  accent: '#778899',
  green: '#00aa00',
  red: '#aa0000',
  yellow: '#aaaa00',
  warningDim: '#bb1100',
  errorDim: '#bb0011',
  purple: '#aa00aa',
  symbol: '#00aaaa',
  borderFocused: '#0011aa',
  borderDefault: '#1100aa',
  hover: '#010101',
};

/** The NoColor theme maps every ink color to ''. */
const EMPTY_PALETTE: Palette = {
  text: '',
  dim: '',
  accent: '',
  green: '',
  red: '',
  yellow: '',
  warningDim: '',
  errorDim: '',
  purple: '',
  symbol: '',
  borderFocused: '',
  borderDefault: '',
  hover: '',
};

describe('markdownMarkupTokens', () => {
  it('covers the markdown renderable capture names', () => {
    for (const mode of ['dark', 'light'] as const) {
      const tokens = markdownMarkupTokens(mode);
      for (const key of [
        'markup.heading',
        'markup.heading.1',
        'markup.heading.2',
        'markup.heading.3',
        'markup.raw',
        'markup.italic',
        'markup.strong',
        'markup.link',
        'markup.link.url',
      ]) {
        expect(tokens[key], `${mode}:${key}`).toBeDefined();
      }
      expect(tokens['markup.heading.1']).toMatchObject({ bold: true });
      expect(tokens['markup.italic']).toMatchObject({ italic: true });
      expect(tokens['markup.link.url']).toMatchObject({ underline: true });
    }
  });
});

describe('applyThemeMode', () => {
  it('switches palette and syntax style by terminal mode', () => {
    applyThemeMode('light');
    expect(C.bg).toBe('#FAFAFA');
    expect(syntaxTokens()['default']).toMatchObject({ fg: '#1f2328' });
    expect(syntaxTokens()['markup.heading.1']).toBeDefined();

    applyThemeMode('dark');
    expect(C.bg).toBeUndefined();
    expect(syntaxTokens()['default']).toMatchObject({ fg: '#e6edf3' });
    expect(syntaxTokens()['markup.raw']).toBeDefined();
  });

  it('defaults unknown modes to dark', () => {
    applyThemeMode(null);
    expect(C.bg).toBeUndefined();
    applyThemeMode(undefined);
    expect(C.bg).toBeUndefined();
  });
});

describe('applyOpenTuiTheme (settings ui.theme face)', () => {
  it('applies the mapped palette and keeps dark transparency', () => {
    applyOpenTuiTheme({
      name: 'Some Dark',
      type: 'dark',
      palette: PALETTE,
      syntaxStyles: { keyword: { fg: '#abcdef' } },
      gradient: [],
    } satisfies OpenTuiThemeDefinition);
    expect(C.text).toBe('#112233');
    expect(C.hover).toBe('#010101');
    expect(C.bg).toBeUndefined();
    const tokens = syntaxTokens();
    expect(tokens['default']).toMatchObject({ fg: '#112233' });
    expect(tokens['keyword']).toMatchObject({ fg: '#abcdef' });
    // Markdown structure tokens survive the named-theme swap.
    expect(tokens['markup.heading.1']).toBeDefined();
  });

  it('paints the block background for light themes', () => {
    applyOpenTuiTheme({
      name: 'Some Light',
      type: 'light',
      palette: PALETTE,
      syntaxStyles: {},
      gradient: [],
    } satisfies OpenTuiThemeDefinition);
    expect(C.bg).toBe('#FAFAFA');
    expect(syntaxTokens()['markup.raw']).toBeDefined();
    // Restore the dark default for other suites.
    applyThemeMode('dark');
  });

  it('skips empty-string palette values (NoColor) instead of overwriting the surface', () => {
    // The NoColor theme maps every ink color to ''. Downstream parseColor('')
    // is not "unset" — it falls back to magenta — so the empties must be
    // dropped and the built-in dark surface left in place.
    applyOpenTuiTheme({
      name: 'NoColor',
      type: 'dark',
      palette: EMPTY_PALETTE,
      syntaxStyles: {},
      gradient: [],
    } satisfies OpenTuiThemeDefinition);
    expect(C.text).toBe('#CDD6F4');
    expect(C.hover).toBe('#313244');
    expect(C.errorDim).toBe('#8B3A4A');
    expect(C.bg).toBeUndefined();
    expect(syntaxTokens()['default']).toBeUndefined();
    // Restore the dark default for other suites.
    applyThemeMode('dark');
  });

  it('resolves CSS color names ink accepts (coral) instead of degrading to magenta', () => {
    // opentui's parseColor knows only a small named table; ink themes
    // accept the CSS names, so the palette must be resolved to hex first.
    applyOpenTuiTheme({
      name: 'Coral Dark',
      type: 'dark',
      palette: { ...PALETTE, text: 'coral' },
      syntaxStyles: {},
      gradient: [],
    } satisfies OpenTuiThemeDefinition);
    expect(C.text).toBe('#ff7f50');
    // Restore the dark default for other suites.
    applyThemeMode('dark');
  });

  it('keeps unresolvable palette values unset instead of degrading to magenta', () => {
    applyOpenTuiTheme({
      name: 'Odd Dark',
      type: 'dark',
      palette: { ...PALETTE, text: 'not-a-color' },
      syntaxStyles: { keyword: { fg: 'not-a-color' } },
      gradient: [],
    } satisfies OpenTuiThemeDefinition);
    expect(C.text).toBe('#CDD6F4');
    // The unresolvable style registered without a fg color.
    expect(syntaxTokens()['keyword']).toMatchObject({});
    expect((syntaxTokens()['keyword'] as { fg?: string }).fg).toBeUndefined();
    // Restore the dark default for other suites.
    applyThemeMode('dark');
  });
});

describe('GRADIENT (banner wordmark ramp)', () => {
  it('resolves each stop through toHex, CSS names included', () => {
    // The ANSI themes declare ink color names; opentui's parseColor knows
    // only a small named table, so the stops must arrive as #rrggbb.
    applyOpenTuiTheme({
      name: 'Some Dark',
      type: 'dark',
      palette: PALETTE,
      syntaxStyles: {},
      gradient: ['cyan', '#FF79C6'],
    } satisfies OpenTuiThemeDefinition);
    expect(GRADIENT).toEqual(['#00ffff', '#ff79c6']);
    // Restore the dark default for other suites.
    applyThemeMode('dark');
  });

  it('yields no ramp when fewer than two stops survive', () => {
    // ink renders the logo uncolored rather than painting a single stop.
    applyOpenTuiTheme({
      name: 'NoColor',
      type: 'dark',
      palette: EMPTY_PALETTE,
      syntaxStyles: {},
      gradient: ['not-a-color', '#ff0000'],
    } satisfies OpenTuiThemeDefinition);
    expect(GRADIENT).toEqual([]);
    // Restore the dark default for other suites.
    applyThemeMode('dark');
  });

  it('restores the built-in ramp on a mode switch', () => {
    applyThemeMode('dark');
    expect(GRADIENT).toEqual(['#4796E4', '#847ACE', '#C3677F']);
  });
});

describe('SYNTAX_DIM (thought body)', () => {
  it('dims plain text and headings, keeping inline code and links', () => {
    applyOpenTuiTheme({
      name: 'Some Dark',
      type: 'dark',
      palette: PALETTE,
      syntaxStyles: {},
      gradient: [],
    } satisfies OpenTuiThemeDefinition);
    // ink's ThinkBody paints the whole body with theme.text.secondary.
    expect(dimSyntaxTokens()['default']).toMatchObject({ fg: '#445566' });
    expect(dimSyntaxTokens()['markup.heading.1']).toMatchObject({
      fg: '#445566',
      bold: true,
    });
    // ink's InlineMarkdownRenderer keeps these on their own colors.
    expect(dimSyntaxTokens()['markup.raw']).toEqual(
      syntaxTokens()['markup.raw'],
    );
    expect(dimSyntaxTokens()['markup.link.url']).toEqual(
      syntaxTokens()['markup.link.url'],
    );
    // The main style still anchors plain text on the theme's foreground.
    expect(syntaxTokens()['default']).toMatchObject({ fg: '#112233' });
    // Restore the dark default for other suites.
    applyThemeMode('dark');
  });

  it('follows the palette across a mode switch', () => {
    applyThemeMode('light');
    expect(dimSyntaxTokens()['default']).toMatchObject({ fg: '#97a0b0' });
    applyThemeMode('dark');
    expect(dimSyntaxTokens()['default']).toMatchObject({ fg: '#6C7086' });
  });

  it('omits default when the theme does (NoColor)', () => {
    applyOpenTuiTheme({
      name: 'NoColor',
      type: 'dark',
      palette: EMPTY_PALETTE,
      syntaxStyles: {},
      gradient: [],
    } satisfies OpenTuiThemeDefinition);
    expect(dimSyntaxTokens()['default']).toBeUndefined();
    // Restore the dark default for other suites.
    applyThemeMode('dark');
  });
});
