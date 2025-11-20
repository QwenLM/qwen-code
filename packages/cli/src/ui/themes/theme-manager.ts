/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AyuDark } from './ayu.js';
import { AyuLight } from './ayu-light.js';
import { AtomOneDark } from './atom-one-dark.js';
import { Dracula } from './dracula.js';
import { GitHubDark } from './github-dark.js';
import { GitHubLight } from './github-light.js';
import { GoogleCode } from './googlecode.js';
import { DefaultLight } from './default-light.js';
import { DefaultDark } from './default.js';
import { ShadesOfPurple } from './shades-of-purple.js';
import { XCode } from './xcode.js';
import { QwenLight } from './qwen-light.js';
import { QwenDark } from './qwen-dark.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Theme, ThemeType, CustomTheme } from './theme.js';
import { createCustomTheme, validateCustomTheme } from './theme.js';
import type { SemanticColors } from './semantic-tokens.js';
import { ANSI } from './ansi.js';
import { ANSILight } from './ansi-light.js';
import { NoColorTheme } from './no-color.js';
import process from 'node:process';
import { EventEmitter } from 'node:events';

export interface ThemeDisplay {
  name: string;
  type: ThemeType;
  isCustom?: boolean;
}

export const DEFAULT_THEME: Theme = QwenDark;

class ThemeManager extends EventEmitter {
  private readonly availableThemes: Theme[];
  private readonly themeNameMap: Map<string, Theme>;
  private activeTheme: Theme;
  private customThemes: Map<string, Theme> = new Map();
  private readonly fileThemeCache: Map<string, Theme> = new Map();

  constructor() {
    super();
    this.availableThemes = [
      AyuDark,
      AyuLight,
      AtomOneDark,
      Dracula,
      DefaultLight,
      DefaultDark,
      GitHubDark,
      GitHubLight,
      GoogleCode,
      QwenLight,
      QwenDark,
      ShadesOfPurple,
      XCode,
      ANSI,
      ANSILight,
    ];
    // Create a map for O(1) theme lookup by name
    this.themeNameMap = new Map();
    for (const theme of this.availableThemes) {
      this.themeNameMap.set(theme.name, theme);
    }
    this.activeTheme = DEFAULT_THEME;
  }

  /**
   * Loads custom themes from settings.
   * @param customThemesSettings Custom themes from settings.
   */
  loadCustomThemes(customThemesSettings?: Record<string, CustomTheme>): void {
    this.customThemes.clear();

    if (!customThemesSettings) {
      // If no custom themes are provided, ensure active theme isn't a custom one
      if (this.activeTheme.type === 'custom') {
        this.activeTheme = DEFAULT_THEME;
      }
      return;
    }

    // Process all custom themes first to avoid multiple setActiveTheme calls
    const validCustomThemes = new Map<string, Theme>();
    for (const [name, customThemeConfig] of Object.entries(
      customThemesSettings,
    )) {
      const validation = validateCustomTheme(customThemeConfig);
      if (validation.isValid) {
        if (validation.warning) {
          console.warn(`Theme "${name}": ${validation.warning}`);
        }
        const themeWithDefaults: CustomTheme = {
          ...DEFAULT_THEME.colors,
          ...customThemeConfig,
          name: customThemeConfig.name || name,
          type: 'custom',
        };

        try {
          const theme = createCustomTheme(themeWithDefaults);
          validCustomThemes.set(name, theme);
        } catch (error) {
          console.warn(`Failed to load custom theme "${name}":`, error);
        }
      } else {
        console.warn(`Invalid custom theme "${name}": ${validation.error}`);
      }
    }

    // Set the valid custom themes after processing all of them
    this.customThemes = validCustomThemes;

    // If the current active theme is a custom theme, keep it if still valid
    if (
      this.activeTheme &&
      this.activeTheme.type === 'custom' &&
      this.customThemes.has(this.activeTheme.name)
    ) {
      this.activeTheme = this.customThemes.get(this.activeTheme.name)!;
    }
  }

  /**
   * Sets the active theme.
   * @param themeName The name of the theme to set as active.
   * @returns True if the theme was successfully set, false otherwise.
   */
  setActiveTheme(themeName: string | undefined): boolean {
    const theme = this.findThemeByName(themeName);
    if (!theme) {
      return false;
    }

    const oldThemeName = this.activeTheme?.name;
    this.activeTheme = theme;

    // Emit theme change event
    this.emit('themeChanged', theme, oldThemeName);

    return true;
  }

  /**
   * Adds a listener for theme changes.
   * @param eventName The name of the event ('themeChanged').
   * @param listener The callback to execute when the theme changes.
   */
  onThemeChange(
    listener: (newTheme: Theme, oldThemeName: string | undefined) => void,
  ): void {
    this.on('themeChanged', listener);
  }

  /**
   * Removes a listener for theme changes.
   * @param eventName The name of the event ('themeChanged').
   * @param listener The callback to remove.
   */
  offThemeChange(
    listener: (newTheme: Theme, oldThemeName: string | undefined) => void,
  ): void {
    this.off('themeChanged', listener);
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
      const isCustom = [...this.customThemes.values()].includes(
        this.activeTheme,
      );
      const isFromFile = [...this.fileThemeCache.values()].includes(
        this.activeTheme,
      );

      if (isBuiltIn || isCustom || isFromFile) {
        return this.activeTheme;
      }
    }

    // Fallback to default if no active theme or if it's no longer valid.
    this.activeTheme = DEFAULT_THEME;
    return this.activeTheme;
  }

  /**
   * Gets the semantic colors for the active theme.
   * @returns The semantic colors.
   */
  getSemanticColors(): SemanticColors {
    return this.getActiveTheme().semanticColors;
  }

  /**
   * Gets a list of custom theme names.
   * @returns Array of custom theme names.
   */
  getCustomThemeNames(): string[] {
    return Array.from(this.customThemes.keys());
  }

  /**
   * Checks if a theme name is a custom theme.
   * @param themeName The theme name to check.
   * @returns True if the theme is custom.
   */
  isCustomTheme(themeName: string): boolean {
    return this.customThemes.has(themeName);
  }

  /**
   * Returns a list of available theme names.
   */
  getAvailableThemes(): ThemeDisplay[] {
    // Create theme displays from the cached map for better performance
    const builtInThemes: ThemeDisplay[] = [];
    const qwenThemes: ThemeDisplay[] = [];

    // Efficiently separate Qwen themes and other built-in themes
    for (const theme of this.availableThemes) {
      const themeDisplay: ThemeDisplay = {
        name: theme.name,
        type: theme.type,
        isCustom: false,
      };

      if (theme.name === QwenLight.name || theme.name === QwenDark.name) {
        qwenThemes.push(themeDisplay);
      } else {
        builtInThemes.push(themeDisplay);
      }
    }

    const customThemes = Array.from(this.customThemes.values()).map(
      (theme) => ({
        name: theme.name,
        type: theme.type,
        isCustom: true,
      }),
    );

    // Sort other themes by type and then name
    const sortedOtherThemes = [...builtInThemes, ...customThemes].sort(
      (a, b) => {
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
        return a.name.localeCompare(b.name);
      },
    );

    // Combine Qwen themes first, then sorted others
    return [...qwenThemes, ...sortedOtherThemes];
  }

  /**
   * Gets a theme by name.
   * @param themeName The name of the theme to get.
   * @returns The theme if found, undefined otherwise.
   */
  getTheme(themeName: string): Theme | undefined {
    return this.findThemeByName(themeName);
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
      const canonicalPath = fs.realpathSync(path.resolve(themePath));

      // 1. Check file theme cache using the canonical path.
      if (this.fileThemeCache.has(canonicalPath)) {
        return this.fileThemeCache.get(canonicalPath);
      }

      // 2. Perform security check.
      const homeDir = path.resolve(os.homedir());
      if (!canonicalPath.startsWith(homeDir)) {
        console.warn(
          `Theme file at "${themePath}" is outside your home directory. ` +
            `Only load themes from trusted sources.`,
        );
        return undefined;
      }

      // 3. Read, parse, and validate the theme file.
      const themeContent = fs.readFileSync(canonicalPath, 'utf-8');
      const customThemeConfig = JSON.parse(themeContent) as CustomTheme;

      const validation = validateCustomTheme(customThemeConfig);
      if (!validation.isValid) {
        console.warn(
          `Invalid custom theme from file "${themePath}": ${validation.error}`,
        );
        return undefined;
      }

      if (validation.warning) {
        console.warn(`Theme from "${themePath}": ${validation.warning}`);
      }

      // 4. Create and cache the theme.
      const themeWithDefaults: CustomTheme = {
        ...DEFAULT_THEME.colors,
        ...customThemeConfig,
        name: customThemeConfig.name || canonicalPath,
        type: 'custom',
      };

      const theme = createCustomTheme(themeWithDefaults);
      this.fileThemeCache.set(canonicalPath, theme); // Cache by canonical path
      return theme;
    } catch (error) {
      // Any error in the process (file not found, bad JSON, etc.) is caught here.
      // We can return undefined silently for file-not-found, and warn for others.
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      ) {
        console.warn(`Could not load theme from file "${themePath}":`, error);
      }
      return undefined;
    }
  }

  findThemeByName(themeName: string | undefined): Theme | undefined {
    if (!themeName) {
      return DEFAULT_THEME;
    }

    // First check built-in themes using the cached map for O(1) lookup
    const builtInTheme = this.themeNameMap.get(themeName);
    if (builtInTheme) {
      return builtInTheme;
    }

    // Then check custom themes that have been loaded from settings
    if (this.customThemes.has(themeName)) {
      return this.customThemes.get(themeName);
    }

    // Finally check file paths
    if (this.isPath(themeName)) {
      return this.loadThemeFromFile(themeName);
    }

    // If it's not a built-in, not in cache, and not a valid file path,
    // it's not a valid theme.
    return undefined;
  }

  /**
   * Clears the file theme cache to free up memory.
   * This is useful when reloading many theme files to prevent memory bloat.
   */
  clearFileThemeCache(): void {
    this.fileThemeCache.clear();
  }
}

// Export an instance of the ThemeManager
export const themeManager = new ThemeManager();
