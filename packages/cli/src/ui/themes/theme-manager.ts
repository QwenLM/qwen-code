/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AyuDark } from './builtin/dark/ayu-dark.js';
import { AyuLight } from './builtin/light/ayu-light.js';
import { AtomOneDark } from './builtin/dark/atom-one-dark.js';
import { Dracula } from './builtin/dark/dracula-dark.js';
import { GitHubDark } from './builtin/dark/github-dark.js';
import { GitHubLight } from './builtin/light/github-light.js';
import { GoogleCode } from './builtin/light/googlecode-light.js';
import { Holiday } from './builtin/dark/holiday-dark.js';
import { DefaultLight } from './builtin/light/default-light.js';
import { DefaultDark } from './builtin/dark/default-dark.js';
import { QwenDark } from './builtin/dark/qwen-dark.js';
import { QwenLight } from './builtin/light/qwen-light.js';
import { ShadesOfPurple } from './builtin/dark/shades-of-purple-dark.js';
import { SolarizedDark } from './builtin/dark/solarized-dark.js';
import { SolarizedLight } from './builtin/light/solarized-light.js';
import { XCode } from './builtin/light/xcode-light.js';
import { TokyoNight } from './builtin/dark/tokyonight-dark.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Theme, ThemeType, ColorsTheme, CustomTheme } from './theme.js';
import {
  createCustomTheme,
  validateCustomTheme,
  interpolateColor,
  getThemeTypeFromBackgroundColor,
  getLuminance,
  pickDefaultThemeName,
  resolveColor,
} from './theme.js';
import {
  DARK_THEME_LUMINANCE_THRESHOLD,
  getBackgroundTypeWithHysteresis,
  LIGHT_THEME_LUMINANCE_THRESHOLD,
} from './color-utils.js';
import type { SemanticColors } from './semantic-tokens.js';
import {
  DEFAULT_BACKGROUND_OPACITY,
  DEFAULT_INPUT_BACKGROUND_OPACITY,
  DEFAULT_SELECTION_OPACITY,
  DEFAULT_BORDER_OPACITY,
} from '../constants.js';
import { ANSI } from './builtin/dark/ansi-dark.js';
import { ANSILight } from './builtin/light/ansi-light.js';
import { NoColorTheme } from './builtin/no-color.js';
import process from 'node:process';
import { runLogger, homedir } from '@qwen-code/core';

export interface ThemeDisplay {
  name: string;
  type: ThemeType;
  isCustom?: boolean;
}

export const DEFAULT_THEME: Theme = DefaultDark;

/**
 * Product-level defaults used when `ui.theme` is unset or `auto`.
 * Commercial entries keep Default/DefaultLight; the open entry installs the
 * Qwen pair before the TUI starts.
 */
let defaultTheme: Theme = DEFAULT_THEME;
let defaultLightTheme: Theme = DefaultLight;
let productThemeDefaults = false;

export function setDefaultThemeNames(names: {
  readonly dark?: string;
  readonly light?: string;
}): void {
  const dark = names.dark ? themeManager.findThemeByName(names.dark) : undefined;
  const light = names.light
    ? themeManager.findThemeByName(names.light)
    : undefined;
  if (dark) defaultTheme = dark;
  if (light) defaultLightTheme = light;
  productThemeDefaults = Boolean(dark || light);
}

/**
 * The `ui.theme` value meaning "follow the terminal background".
 *
 * It is deliberately a value of `ui.theme` rather than a separate flag: the
 * setting then holds the user's *intent*, and the concrete theme is derived on
 * every read instead of being written back to disk. Storing the derived name is
 * what made two terminals overwrite each other's global preference.
 */
export const AUTO_THEME_SETTING = 'auto';

/** Themes to use for dark / light terminal backgrounds in `auto` mode. */
export interface AutoThemePair {
  dark?: string;
  light?: string;
}

/**
 * True when the setting expresses "follow the terminal background".
 *
 * An unset `ui.theme` counts: that has always been resolved from the background
 * at startup and followed at runtime, so treating it as auto preserves existing
 * behavior rather than changing it.
 */
export function isAutoThemeSetting(setting: string | undefined): boolean {
  return setting === undefined || setting === AUTO_THEME_SETTING;
}

class ThemeManager {
  private readonly availableThemes: Theme[];
  private activeTheme: Theme;
  private settingsThemes: Map<string, Theme> = new Map();
  private fileThemes: Map<string, Theme> = new Map();
  private terminalBackground: string | undefined;

  // Cache for dynamic colors
  private cachedColors: ColorsTheme | undefined;
  private cachedSemanticColors: SemanticColors | undefined;
  private lastCacheKey: string | undefined;

  private fs: typeof fs;
  private homedir: () => string;

  constructor(dependencies?: { fs?: typeof fs; homedir?: () => string }) {
    this.fs = dependencies?.fs ?? fs;
    this.homedir = dependencies?.homedir ?? homedir;

    this.availableThemes = [
      AyuDark,
      AyuLight,
      AtomOneDark,
      Dracula,
      DefaultLight,
      DefaultDark,
      QwenDark,
      QwenLight,
      GitHubDark,
      GitHubLight,
      GoogleCode,
      Holiday,
      ShadesOfPurple,
      SolarizedDark,
      SolarizedLight,
      XCode,
      TokyoNight,
      ANSI,
      ANSILight,
    ];
    this.activeTheme = DEFAULT_THEME;
  }

  setTerminalBackground(color: string | undefined): void {
    if (this.terminalBackground !== color) {
      this.terminalBackground = color;
      this.clearCache();
    }
  }

  getTerminalBackground(): string | undefined {
    return this.terminalBackground;
  }

  private clearCache(): void {
    this.cachedColors = undefined;
    this.cachedSemanticColors = undefined;
    this.lastCacheKey = undefined;
  }

  /**
   * Resolves a `ui.theme` setting to a concrete theme name.
   *
   * Concrete names pass through untouched. `'auto'` (and unset) are resolved
   * from the terminal background so the setting never has to store the result.
   *
   * @param setting The raw `ui.theme` value.
   * @param terminalBackground The detected terminal background color.
   * @param pair Optional dark/light theme pair for auto mode.
   * @param currentThemeName The previous resolution, when re-resolving at
   *   runtime. Supplying it enables hysteresis, which is what stops the theme
   *   flickering on a background sitting near the light/dark boundary. Omit it
   *   at startup, where there is no previous state to be sticky about.
   */
  resolveThemeSetting(
    setting: string | undefined,
    terminalBackground: string | undefined,
    pair?: AutoThemePair,
    currentThemeName?: string,
  ): string {
    if (!isAutoThemeSetting(setting)) {
      return setting!;
    }

    const pairConfigured = Boolean(pair?.dark || pair?.light);
    const dark = this.validateAutoPairName(pair?.dark) ?? defaultTheme.name;
    const light =
      this.validateAutoPairName(pair?.light) ?? defaultLightTheme.name;

    const luminance = this.backgroundLuminance(terminalBackground);

    // Runtime re-resolution: stay put unless the background is unambiguous.
    if (currentThemeName === dark || currentThemeName === light) {
      if (luminance === undefined) {
        return currentThemeName;
      }
      if (luminance > LIGHT_THEME_LUMINANCE_THRESHOLD) {
        return light;
      }
      if (luminance < DARK_THEME_LUMINANCE_THRESHOLD) {
        return dark;
      }
      return currentThemeName;
    }

    // Cold start. With no configured pair this is exactly the pre-existing
    // call, so an unset `ui.theme` keeps the exact-background-match heuristic
    // and the 128 midpoint it has always had.
    if (!pairConfigured) {
      // A product that installs its own pair (the open entry) owns the
      // default look; an incidental exact background match must not override
      // it. Commercial entries keep the historical heuristic.
      if (productThemeDefaults) {
        return getThemeTypeFromBackgroundColor(terminalBackground) === 'light'
          ? light
          : dark;
      }
      return pickDefaultThemeName(
        terminalBackground,
        this.getAllThemes(),
        dark,
        light,
      );
    }

    // An explicitly configured pair outranks the exact-match heuristic: if the
    // user named the two themes they want, an incidental background collision
    // with some other theme must not override them.
    return getThemeTypeFromBackgroundColor(terminalBackground) === 'light'
      ? light
      : dark;
  }

  /**
   * Returns the background's type when it definitively disagrees with the
   * theme, i.e. exactly when auto mode would switch away from it. Returns
   * undefined when they agree or when the background is ambiguous.
   *
   * Separate from `isThemeCompatible` on purpose: that predicate also gates
   * terminal-background blending and the theme picker's "(Incompatible)" badge,
   * so widening its dead band would silently change rendering.
   */
  getMismatchedBackgroundType(
    theme: Theme,
    terminalBackground: string | undefined,
  ): 'light' | 'dark' | undefined {
    if (theme.type === 'ansi') {
      return undefined;
    }

    const backgroundType =
      getBackgroundTypeWithHysteresis(terminalBackground);
    if (!backgroundType) {
      return undefined;
    }

    const themeType =
      theme.type === 'custom'
        ? getThemeTypeFromBackgroundColor(
            resolveColor(theme.colors.Background) || theme.colors.Background,
          )
        : theme.type;

    return themeType && themeType !== backgroundType
      ? backgroundType
      : undefined;
  }

  private backgroundLuminance(
    terminalBackground: string | undefined,
  ): number | undefined {
    if (!terminalBackground) {
      return undefined;
    }
    const resolved = resolveColor(terminalBackground);
    return resolved ? getLuminance(resolved) : undefined;
  }

  /** Returns the name if it maps to a real theme, warning and returning undefined otherwise. */
  private validateAutoPairName(name: string | undefined): string | undefined {
    if (!name) {
      return undefined;
    }
    if (!this.findThemeByName(name)) {
      runLogger.warn(
        `Theme "${name}" in ui.autoThemePair not found; falling back to the default.`,
      );
      return undefined;
    }
    return name;
  }

  /**
   * Loads custom themes from settings.
   * @param customThemesSettings Custom themes from settings.
   */
  loadCustomThemes(customThemesSettings?: Record<string, CustomTheme>): void {
    this.settingsThemes.clear();

    if (!customThemesSettings) {
      return;
    }

    for (const [name, customThemeConfig] of Object.entries(
      customThemesSettings,
    )) {
      const validation = validateCustomTheme(customThemeConfig);
      if (validation.isValid) {
        if (validation.warning) {
          runLogger.warn(`Theme "${name}": ${validation.warning}`);
        }
        const themeWithDefaults: CustomTheme = {
          ...defaultTheme.colors,
          ...customThemeConfig,
          name: customThemeConfig.name || name,
          type: 'custom',
        };

        try {
          const theme = createCustomTheme(themeWithDefaults);
          this.settingsThemes.set(name, theme);
        } catch (error) {
          runLogger.warn(`Failed to load custom theme "${name}":`, error);
        }
      } else {
        runLogger.warn(`Invalid custom theme "${name}": ${validation.error}`);
      }
    }
    // If the current active theme is a settings theme, keep it if still valid
    if (
      this.activeTheme &&
      this.activeTheme.type === 'custom' &&
      this.settingsThemes.has(this.activeTheme.name)
    ) {
      this.activeTheme = this.settingsThemes.get(this.activeTheme.name)!;
    }
  }

  /**
   * Clears all themes loaded from files.
   * This is primarily for testing purposes to reset state between tests.
   */
  clearFileThemes(): void {
    this.fileThemes.clear();
  }

  /**
   * Re-initializes the ThemeManager with new dependencies.
   * This is primarily for testing to allow injecting mocks.
   */
  reinitialize(dependencies: { fs?: typeof fs; homedir?: () => string }): void {
    if (dependencies.fs) {
      this.fs = dependencies.fs;
    }
    if (dependencies.homedir) {
      this.homedir = dependencies.homedir;
    }
  }

  /**
   * Resets the ThemeManager state to defaults.
   * This is for testing purposes to ensure test isolation.
   */
  resetForTesting(dependencies?: {
    fs?: typeof fs;
    homedir?: () => string;
  }): void {
    if (dependencies) {
      this.reinitialize(dependencies);
    }
    this.settingsThemes.clear();
    this.fileThemes.clear();
    this.activeTheme = defaultTheme;
    this.terminalBackground = undefined;
    this.clearCache();
  }
  setActiveTheme(themeName: string | undefined): boolean {
    const theme = this.findThemeByName(themeName);
    if (!theme) {
      return false;
    }
    if (this.activeTheme !== theme) {
      this.activeTheme = theme;
      this.clearCache();
    }
    return true;
  }

  /**
   * Gets the currently active theme.
   * @returns The active theme.
   */
  getActiveTheme(): Theme {
    if (process.env['NO_COLOR']) {
      return NoColorTheme;
    }

    if (this.activeTheme) {
      const isBuiltIn = this.availableThemes.some(
        (t) => t.name === this.activeTheme.name,
      );
      const isCustom =
        [...this.settingsThemes.values()].includes(this.activeTheme) ||
        [...this.fileThemes.values()].includes(this.activeTheme);

      if (isBuiltIn || isCustom) {
        return this.activeTheme;
      }

      // If the theme object is no longer valid, try to find it again by name.
      // This handles the case where extensions are reloaded and theme objects
      // are re-created.
      const reloadedTheme = this.findThemeByName(this.activeTheme.name);
      if (reloadedTheme) {
        this.activeTheme = reloadedTheme;
        return this.activeTheme;
      }
    }

    // Fallback to default if no active theme or if it's no longer valid.
    this.activeTheme = defaultTheme;
    return this.activeTheme;
  }

  /**
   * Gets the ThemeType of the currently active theme.
   */
  getThemeType(): ThemeType {
    return this.getActiveTheme().type;
  }

  /**
   * Gets the name of the currently active theme.
   */
  getThemeName(): string {
    return this.getActiveTheme().name;
  }

  /**
   * Gets the colors for the active theme, respecting the terminal background.
   * @returns The theme colors.
   */
  getColors(): ColorsTheme {
    const activeTheme = this.getActiveTheme();
    const cacheKey = `${activeTheme.name}:${this.terminalBackground}`;
    if (this.cachedColors && this.lastCacheKey === cacheKey) {
      return this.cachedColors;
    }

    const colors = activeTheme.colors;
    if (
      this.terminalBackground &&
      this.isThemeCompatible(activeTheme, this.terminalBackground)
    ) {
      this.cachedColors = {
        ...colors,
        Background: this.terminalBackground,
        DarkGray: interpolateColor(
          this.terminalBackground,
          colors.Gray,
          DEFAULT_BORDER_OPACITY,
        ),
        InputBackground: interpolateColor(
          this.terminalBackground,
          colors.Gray,
          DEFAULT_INPUT_BACKGROUND_OPACITY,
        ),
        MessageBackground: interpolateColor(
          this.terminalBackground,
          colors.Gray,
          DEFAULT_BACKGROUND_OPACITY,
        ),
        FocusBackground: interpolateColor(
          this.terminalBackground,
          activeTheme.colors.FocusColor ?? activeTheme.colors.AccentGreen,
          DEFAULT_SELECTION_OPACITY,
        ),
      };
    } else {
      this.cachedColors = colors;
    }

    this.lastCacheKey = cacheKey;
    return this.cachedColors;
  }

  /**
   * Gets the semantic colors for the active theme.
   * @returns The semantic colors.
   */
  getSemanticColors(): SemanticColors {
    const activeTheme = this.getActiveTheme();
    const cacheKey = `${activeTheme.name}:${this.terminalBackground}`;
    if (this.cachedSemanticColors && this.lastCacheKey === cacheKey) {
      return this.cachedSemanticColors;
    }

    const semanticColors = activeTheme.semanticColors;
    if (
      this.terminalBackground &&
      this.isThemeCompatible(activeTheme, this.terminalBackground)
    ) {
      const colors = this.getColors();
      this.cachedSemanticColors = {
        ...semanticColors,
        background: {
          ...semanticColors.background,
          primary: this.terminalBackground,
          message: colors.MessageBackground!,
          focus: colors.FocusBackground!,
        },
        border: {
          ...semanticColors.border,
          default: colors.DarkGray,
          input: colors.InputBackground!,
        },
        ui: {
          ...semanticColors.ui,
          dark: colors.DarkGray,
          focus: colors.FocusColor ?? colors.AccentGreen,
        },
      };
    } else {
      this.cachedSemanticColors = semanticColors;
    }

    this.lastCacheKey = cacheKey;
    return this.cachedSemanticColors;
  }

  isThemeCompatible(
    activeTheme: Theme,
    terminalBackground: string | undefined,
  ): boolean {
    if (activeTheme.type === 'ansi') {
      return true;
    }

    const backgroundType = getThemeTypeFromBackgroundColor(terminalBackground);
    if (!backgroundType) {
      return true;
    }

    const themeType =
      activeTheme.type === 'custom'
        ? getThemeTypeFromBackgroundColor(
            resolveColor(activeTheme.colors.Background) ||
              activeTheme.colors.Background,
          )
        : activeTheme.type;

    return themeType === backgroundType;
  }

  private _getAllCustomThemes(): Theme[] {
    return [
      ...Array.from(this.settingsThemes.values()),
      ...Array.from(this.fileThemes.values()),
    ];
  }

  /**
   * Gets a list of custom theme names.
   * @returns Array of custom theme names.
   */
  getCustomThemeNames(): string[] {
    return this._getAllCustomThemes().map((theme) => theme.name);
  }

  /**
   * Checks if a theme name is a custom theme.
   * @param themeName The theme name to check.
   * @returns True if the theme is custom.
   */
  isCustomTheme(themeName: string): boolean {
    return (
      this.settingsThemes.has(themeName) ||
      this.fileThemes.has(themeName)
    );
  }

  /**
   * Returns a list of available theme names.
   */
  getAvailableThemes(): ThemeDisplay[] {
    const builtInThemes = this.availableThemes.map((theme) => ({
      name: theme.name,
      type: theme.type,
      isCustom: false,
    }));

    const customThemes = this._getAllCustomThemes().map((theme) => ({
      name: theme.name,
      type: theme.type,
      isCustom: true,
    }));

    const allThemes = [...builtInThemes, ...customThemes];

    const sortedThemes = allThemes.sort((a, b) => {
      const typeOrder = (type: ThemeType): number => {
        switch (type) {
          case 'dark':
            return 1;
          case 'light':
            return 2;
          case 'ansi':
            return 3;
          case 'custom':
            return 4; // Custom themes at the end
          default:
            return 5;
        }
      };

      const typeComparison = typeOrder(a.type) - typeOrder(b.type);
      if (typeComparison !== 0) {
        return typeComparison;
      }
      // Pin "Default" and "Default Light" to the top of their respective groups
      const isDefaultA = a.name === 'Default' || a.name === 'Default Light';
      const isDefaultB = b.name === 'Default' || b.name === 'Default Light';
      if (isDefaultA && !isDefaultB) return -1;
      if (!isDefaultA && isDefaultB) return 1;
      return a.name.localeCompare(b.name);
    });

    return sortedThemes;
  }

  /**
   * Gets a theme by name.
   * @param themeName The name of the theme to get.
   * @returns The theme if found, undefined otherwise.
   */
  getTheme(themeName: string): Theme | undefined {
    return this.findThemeByName(themeName);
  }

  /**
   * Gets all available themes.
   * @returns A list of all available themes.
   */
  getAllThemes(): Theme[] {
    return [...this.availableThemes, ...this._getAllCustomThemes()];
  }

  private isPath(themeName: string): boolean {
    return (
      themeName.endsWith('.json') ||
      themeName.startsWith('.') ||
      path.isAbsolute(themeName)
    );
  }

  private loadThemeFromFile(themePath: string): Theme | undefined {
    try {
      // realpathSync resolves the path and throws if it doesn't exist.
      const canonicalPath = this.fs.realpathSync(path.resolve(themePath));

      // 1. Check cache using the canonical path.
      if (this.fileThemes.has(canonicalPath)) {
        return this.fileThemes.get(canonicalPath);
      }

      // 2. Perform security check.
      const homeDir = path.resolve(this.homedir());
      if (!canonicalPath.startsWith(homeDir)) {
        runLogger.warn(
          `Theme file at "${themePath}" is outside your home directory. ` +
            `Only load themes from trusted sources.`,
        );
        return undefined;
      }

      // 3. Read, parse, and validate the theme file.
      const themeContent = this.fs.readFileSync(canonicalPath, 'utf-8');
      const customThemeConfig = JSON.parse(themeContent) as CustomTheme;

      const validation = validateCustomTheme(customThemeConfig);
      if (!validation.isValid) {
        runLogger.warn(
          `Invalid custom theme from file "${themePath}": ${validation.error}`,
        );
        return undefined;
      }

      if (validation.warning) {
        runLogger.warn(`Theme from "${themePath}": ${validation.warning}`);
      }

      // 4. Create and cache the theme.
      const themeWithDefaults: CustomTheme = {
        ...defaultTheme.colors,
        ...customThemeConfig,
        name: customThemeConfig.name || canonicalPath,
        type: 'custom',
      };

      const theme = createCustomTheme(themeWithDefaults);
      this.fileThemes.set(canonicalPath, theme); // Cache by canonical path
      return theme;
    } catch (error) {
      // Any error in the process (file not found, bad JSON, etc.) is caught here.
      // We can return undefined silently for file-not-found, and warn for others.
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      ) {
        runLogger.warn(`Could not load theme from file "${themePath}":`, error);
      }
      return undefined;
    }
  }

  findThemeByName(themeName: string | undefined): Theme | undefined {
    if (!themeName) {
      return defaultTheme;
    }

    // First check built-in themes
    const builtInTheme = this.availableThemes.find(
      (theme) => theme.name === themeName,
    );
    if (builtInTheme) {
      return builtInTheme;
    }

    // Then check custom themes that have been loaded from settings, extensions, or file paths
    if (this.isPath(themeName)) {
      return this.loadThemeFromFile(themeName);
    }

    if (this.settingsThemes.has(themeName)) {
      return this.settingsThemes.get(themeName);
    }

    if (this.fileThemes.has(themeName)) {
      return this.fileThemes.get(themeName);
    }

    // If it's not a built-in, not in cache, and not a valid file path,
    // it's not a valid theme.
    return undefined;
  }
}

// Export an instance of the ThemeManager
export const themeManager = new ThemeManager();
