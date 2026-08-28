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
  SYNTAX,
  applyOpenTuiTheme,
  applyThemeMode,
  markdownMarkupTokens,
} from './theme.js';
import type { OpenTuiThemeDefinition } from './theme-parity.js';

function syntaxTokens(): Record<string, unknown> {
  return (SYNTAX as unknown as { styles: Record<string, unknown> }).styles;
}

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
  const palette = {
    text: '#112233',
    dim: '#445566',
    accent: '#778899',
    green: '#00aa00',
    red: '#aa0000',
    yellow: '#aaaa00',
    purple: '#aa00aa',
    hover: '#010101',
  };

  it('applies the mapped palette and keeps dark transparency', () => {
    applyOpenTuiTheme({
      name: 'Some Dark',
      type: 'dark',
      palette,
      syntaxStyles: { keyword: { fg: '#abcdef' } },
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
      palette,
      syntaxStyles: {},
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
    const empty = {
      text: '',
      dim: '',
      accent: '',
      green: '',
      red: '',
      yellow: '',
      purple: '',
      hover: '',
    };
    applyOpenTuiTheme({
      name: 'NoColor',
      type: 'dark',
      palette: empty,
      syntaxStyles: {},
    } satisfies OpenTuiThemeDefinition);
    expect(C.text).toBe('#CDD6F4');
    expect(C.hover).toBe('#313244');
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
      palette: { ...palette, text: 'coral' },
      syntaxStyles: {},
    } satisfies OpenTuiThemeDefinition);
    expect(C.text).toBe('#ff7f50');
    // Restore the dark default for other suites.
    applyThemeMode('dark');
  });

  it('keeps unresolvable palette values unset instead of degrading to magenta', () => {
    applyOpenTuiTheme({
      name: 'Odd Dark',
      type: 'dark',
      palette: { ...palette, text: 'not-a-color' },
      syntaxStyles: { keyword: { fg: 'not-a-color' } },
    } satisfies OpenTuiThemeDefinition);
    expect(C.text).toBe('#CDD6F4');
    // The unresolvable style registered without a fg color.
    expect(syntaxTokens()['keyword']).toMatchObject({});
    expect((syntaxTokens()['keyword'] as { fg?: string }).fg).toBeUndefined();
    // Restore the dark default for other suites.
    applyThemeMode('dark');
  });
});
