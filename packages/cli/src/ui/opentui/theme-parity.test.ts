/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies every built-in ink theme maps onto OpenTUI: the 15 selectable
 * themes plus the NoColor theme (the 16th, activated via NO_COLOR), palette
 * values taken from the same semantic tokens the ink UI renders with, and
 * syntax styles taken from each theme's resolved hljs color map.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@opentui/core', () => ({
  SyntaxStyle: {
    fromStyles: (styles: Record<string, unknown>) => ({ styles }),
  },
}));

import {
  createSyntaxStyle,
  getActiveOpenTuiTheme,
  getBuiltInOpenTuiThemes,
  getOpenTuiTheme,
  HLJS_TO_SYNTAX_TOKEN,
} from './theme-parity.js';
import { themeManager } from '../themes/theme-manager.js';
import { QwenDark } from '../themes/qwen-dark.js';

const PALETTE_KEYS = [
  'text',
  'dim',
  'accent',
  'green',
  'red',
  'yellow',
  'purple',
  'hover',
] as const;

describe('getBuiltInOpenTuiThemes', () => {
  it('maps all 15 selectable ink themes', () => {
    const builtIns = getBuiltInOpenTuiThemes();
    const expected = themeManager
      .getAvailableThemes()
      .filter((theme) => !theme.isCustom);
    expect(builtIns).toHaveLength(expected.length);
    expect(builtIns.map((theme) => theme.name)).toEqual(
      expected.map((theme) => theme.name),
    );
  });

  it('produces a full palette and syntax map for every built-in theme', () => {
    for (const definition of getBuiltInOpenTuiThemes()) {
      for (const key of PALETTE_KEYS) {
        expect(
          typeof definition.palette[key],
          `${definition.name}.${key}`,
        ).toBe('string');
      }
      expect(definition.syntaxStyles['emphasis']).toMatchObject({
        italic: true,
      });
      expect(definition.syntaxStyles['strong']).toMatchObject({ bold: true });
      expect(definition.type).toMatch(/^(dark|light|ansi)$/);
    }
  });

  it('includes the Qwen pair and the ANSI themes', () => {
    const names = getBuiltInOpenTuiThemes().map((theme) => theme.name);
    for (const expected of [
      'Qwen Dark',
      'Qwen Light',
      'Dracula',
      'ANSI',
      'ANSI Light',
      'GitHub Light',
    ]) {
      expect(names).toContain(expected);
    }
  });
});

describe('palette parity (semantic tokens → opentui palette)', () => {
  it('maps Qwen Dark through its semantic tokens with the hljs default text', () => {
    const definition = getOpenTuiTheme('Qwen Dark');
    expect(definition).toBeDefined();
    // Semantic text.primary is empty for this theme; ink falls back to the
    // theme default color, so opentui must too.
    expect(definition!.palette.text).toBe('#bfbdb6');
    expect(definition!.palette.dim).toBe('#6C7086');
    expect(definition!.palette.accent).toBe('#CBA6F7');
    expect(definition!.palette.green).toBe('#A6E3A1');
    expect(definition!.palette.red).toBe('#F38BA8');
    expect(definition!.palette.yellow).toBe('#F9E2AF');
    expect(definition!.palette.purple).toBe('#89B4FA');
    expect(definition!.palette.hover).toBe('#1E1E2E');
  });

  it('maps Dracula from its own color set', () => {
    const definition = getOpenTuiTheme('Dracula');
    expect(definition!.palette).toEqual({
      text: '#a3afb7',
      dim: '#6272a4',
      accent: '#ff79c6',
      green: '#50fa7b',
      red: '#ff5555',
      yellow: '#fff783',
      purple: '#8be9fd',
      hover: '#282a36',
    });
  });

  it('keeps ANSI color names in the syntax map (palette follows semantic tokens)', () => {
    const definition = getOpenTuiTheme('ANSI');
    // The ANSI theme wires its UI palette through the dark semantic tokens
    // (exactly as the ink theme passes darkSemanticColors), so the ANSI names
    // live in the syntax styles, not the palette.
    expect(definition!.palette.text).toBe('white');
    expect(definition!.syntaxStyles['keyword']).toEqual({ fg: 'blue' });
    expect(definition!.syntaxStyles['string']).toEqual({ fg: 'yellow' });
    expect(definition!.syntaxStyles['comment']).toEqual({ fg: 'green' });
  });
});

describe('syntax style parity (hljs map → opentui tokens)', () => {
  it('uses each theme’s own resolved hljs colors', () => {
    // Ink resolves hljs colors through `resolveColor`, which lowercases hex.
    const qwen = getOpenTuiTheme('Qwen Dark')!.syntaxStyles;
    expect(qwen['keyword']).toEqual({ fg: '#ffd700' });
    expect(qwen['string']).toEqual({ fg: '#aad94c' });
    expect(qwen['comment']).toEqual({ fg: '#646a71' });
    expect(qwen['variable']).toEqual({ fg: '#bfbdb6' });
    expect(qwen['type']).toEqual({ fg: '#39bae6' });

    const dracula = getOpenTuiTheme('Dracula')!.syntaxStyles;
    expect(dracula['keyword']).toEqual({ fg: '#8be9fd' });
    expect(dracula['string']).toEqual({ fg: '#fff783' });
    expect(dracula['comment']).toEqual({ fg: '#6272a4' });
    expect(dracula['heading']).toEqual({ fg: '#8be9fd' });
  });

  it('keeps the fixed italic/bold semantics for emphasis and strong', () => {
    const styles = getOpenTuiTheme('Dracula')!.syntaxStyles;
    expect(styles['emphasis']).toEqual({ italic: true });
    expect(styles['strong']).toEqual({ bold: true });
  });

  it('omits tokens the theme has no hljs color for (default-fg parity)', () => {
    const styles = getOpenTuiTheme('Dracula')!.syntaxStyles;
    // Dracula defines no hljs-number entry — opentui must fall back, not
    // invent a color.
    expect(styles['number']).toBeUndefined();
  });

  it('only emits token names the opentui renderer understands', () => {
    const known = new Set(HLJS_TO_SYNTAX_TOKEN.map(([, token]) => token));
    known.add('emphasis');
    known.add('strong');
    for (const definition of getBuiltInOpenTuiThemes()) {
      for (const token of Object.keys(definition.syntaxStyles)) {
        expect(
          known,
          `${definition.name}: unexpected token ${token}`,
        ).toContain(token);
      }
    }
  });
});

describe('getOpenTuiTheme / unknown themes', () => {
  it('returns undefined for unknown theme names', () => {
    expect(getOpenTuiTheme('does-not-exist')).toBeUndefined();
  });
});

describe('getActiveOpenTuiTheme (NO_COLOR parity)', () => {
  it('returns the active theme (Qwen Dark by default)', () => {
    expect(getActiveOpenTuiTheme().name).toBe(QwenDark.name);
  });

  it('switches to the empty NoColor palette under NO_COLOR', () => {
    const previous = process.env['NO_COLOR'];
    process.env['NO_COLOR'] = '1';
    try {
      const definition = getActiveOpenTuiTheme();
      expect(definition.name).toBe('NoColor');
      for (const key of PALETTE_KEYS) {
        expect(definition.palette[key]).toBe('');
      }
    } finally {
      if (previous === undefined) delete process.env['NO_COLOR'];
      else process.env['NO_COLOR'] = previous;
    }
  });
});

describe('createSyntaxStyle', () => {
  it('builds the opentui SyntaxStyle from the mapped styles', () => {
    const definition = getOpenTuiTheme('Dracula')!;
    const style = createSyntaxStyle(definition) as unknown as {
      styles: Record<string, unknown>;
    };
    expect(style.styles).toBe(definition.syntaxStyles);
  });
});
