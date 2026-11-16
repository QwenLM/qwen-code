/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Theme parity: maps every built-in ink theme (the 15 selectable themes plus
 * the NO_COLOR theme the ink `ThemeManager` activates under `NO_COLOR`) onto
 * the OpenTUI rendering world — a `Palette` for the mutable `C`-style color
 * object and an opentui `SyntaxStyle` token map for markdown/code. The ink
 * side stays the single source of truth: definitions are derived from the
 * live `themeManager`, including its `NO_COLOR` override in
 * `getActiveTheme()`.
 */

import { SyntaxStyle, type StyleDefinitionInput } from '@opentui/core';
import type { Palette } from './theme.js';
import type { Theme, ThemeType } from '../themes/theme.js';
import { themeManager } from '../themes/theme-manager.js';
import { getRenderableGradientColors } from '../utils/gradientUtils.js';

export interface OpenTuiThemeDefinition {
  name: string;
  type: ThemeType;
  palette: Palette;
  syntaxStyles: Record<string, StyleDefinitionInput>;
  /** Banner wordmark ramp; empty means ink renders the logo uncolored. */
  gradient: string[];
}

/**
 * hljs token classes (ink's `Theme._colorMap` keys) mapped onto opentui
 * `SyntaxStyle` token names — the same names `theme.ts`'s built-in styles
 * use. Tokens without an hljs counterpart stay unset and fall back to the
 * element foreground, mirroring ink's "color omitted → default" behavior.
 */
export const HLJS_TO_SYNTAX_TOKEN: ReadonlyArray<readonly [string, string]> = [
  ['hljs-keyword', 'keyword'],
  ['hljs-string', 'string'],
  ['hljs-comment', 'comment'],
  ['hljs-function', 'function'],
  ['hljs-type', 'type'],
  ['hljs-number', 'number'],
  ['hljs-variable', 'variable'],
  ['hljs-link', 'link'],
  ['hljs-section', 'heading'],
];

/**
 * Derives the OpenTUI palette from an ink theme's semantic tokens. Empty
 * strings mean "no color" in ink and are passed through unset (e.g. the
 * NoColor theme), except for `text`: this port anchors both its plain-text
 * colour and the markdown syntax `default` token on that key, so a theme whose
 * primary is empty falls back to its own hljs foreground.
 */
export function paletteFromInkTheme(theme: Theme): Palette {
  const semantic = theme.semanticColors;
  return {
    text: semantic.text.primary || theme.defaultColor,
    dim: semantic.text.secondary,
    accent: semantic.text.accent,
    green: semantic.status.success,
    red: semantic.status.error,
    yellow: semantic.status.warning,
    warningDim: semantic.status.warningDim,
    errorDim: semantic.status.errorDim,
    purple: semantic.text.link,
    symbol: semantic.ui.symbol,
    borderFocused: semantic.border.focused,
    borderDefault: semantic.border.default,
    hover: semantic.background.primary,
  };
}

/**
 * The banner wordmark ramp, resolved exactly as the ink `Header` does:
 * `ui.gradient` when the theme declares one, otherwise the
 * `[secondary, link, accent]` fallback, otherwise no gradient at all (ink
 * then renders the logo uncolored rather than throwing).
 */
export function gradientFromInkTheme(theme: Theme): string[] {
  const semantic = theme.semanticColors;
  return (
    getRenderableGradientColors(semantic.ui.gradient, [
      semantic.text.secondary,
      semantic.text.link,
      semantic.text.accent,
    ]) ?? []
  );
}

/**
 * Derives the opentui `SyntaxStyle.fromStyles` input from an ink theme's
 * resolved hljs color map. Emphasis/strong keep their fixed markdown
 * semantics (italic/bold), as in both the ink renderer and the previous
 * hard-coded opentui styles.
 */
export function syntaxStylesFromInkTheme(
  theme: Theme,
): Record<string, StyleDefinitionInput> {
  const styles: Record<string, StyleDefinitionInput> = {};

  for (const [hljsClass, token] of HLJS_TO_SYNTAX_TOKEN) {
    const fg = theme.getInkColor(hljsClass);
    if (fg) {
      styles[token] = { fg };
    }
  }

  const emphasis = theme.getInkColor('hljs-emphasis');
  styles['emphasis'] = emphasis
    ? { fg: emphasis, italic: true }
    : { italic: true };
  const strong = theme.getInkColor('hljs-strong');
  styles['strong'] = strong ? { fg: strong, bold: true } : { bold: true };

  return styles;
}

/** Full OpenTUI theme definition derived from one ink theme. */
export function openTuiThemeFromInkTheme(theme: Theme): OpenTuiThemeDefinition {
  return {
    name: theme.name,
    type: theme.type,
    palette: paletteFromInkTheme(theme),
    syntaxStyles: syntaxStylesFromInkTheme(theme),
    gradient: gradientFromInkTheme(theme),
  };
}

/** Resolves one theme by name (built-in, custom or file path), or undefined. */
export function getOpenTuiTheme(
  name: string,
): OpenTuiThemeDefinition | undefined {
  const theme = themeManager.getTheme(name);
  return theme ? openTuiThemeFromInkTheme(theme) : undefined;
}

/** All built-in ink themes mapped for OpenTUI, in dialog order. */
export function getBuiltInOpenTuiThemes(): OpenTuiThemeDefinition[] {
  return themeManager
    .getAvailableThemes()
    .filter((display) => !display.isCustom)
    .flatMap((display) => {
      const definition = getOpenTuiTheme(display.name);
      return definition ? [definition] : [];
    });
}

/**
 * The currently active theme mapped for OpenTUI — includes the ink parity
 * rule that `NO_COLOR` forces the NoColor theme.
 */
export function getActiveOpenTuiTheme(): OpenTuiThemeDefinition {
  return openTuiThemeFromInkTheme(themeManager.getActiveTheme());
}

/** Builds a live opentui `SyntaxStyle` for a theme definition. */
export function createSyntaxStyle(
  definition: OpenTuiThemeDefinition,
): SyntaxStyle {
  return SyntaxStyle.fromStyles(definition.syntaxStyles);
}
