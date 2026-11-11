/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shape of an output-style config.
 *
 * CLI-specific notes:
 *   - `keepCodingInstructions` controls whether the `# Doing tasks`
 *     section is included in the system prompt. When `false`, the
 *     assembler skips that section (matching CC behaviour). The
 *     mandatory prefix and all other safety sections are always applied.
 *   - `source` covers the four surfaces the CLI supports today:
 *     built-in, user settings dir, project settings dir, and plugins.
 *     Plugins contribute styles via
 *     `<plugin.path>/output-styles/*.md`; they are loaded at plugin
 *     build time. Plugin styles are namespaced as `pluginName:styleName`.
 *   - `forceForPlugin` allows a plugin to auto-activate its output
 *     style when the plugin is enabled, overriding the user's setting.
 */
export type OutputStyleSource =
  | 'built-in'
  | 'userSettings'
  | 'projectSettings'
  | 'plugin';

export interface OutputStyleConfig {
  /** Style name (becomes the value of the `outputStyle` setting). */
  name: string;
  /** Short, user-facing description shown in the `/settings` dialog. */
  description: string;
  /** Markdown body appended to the system prompt via the assembler. */
  prompt: string;
  /** Where this style was discovered. */
  source: OutputStyleSource;
  /**
   * Whether this style may appear in user-facing catalogs and protocol
   * metadata. Defaults to `true`. Internal host integrations can still
   * resolve a hidden style by its exact name.
   */
  isUserVisible?: boolean;
  /**
   * Populated only when `source === 'plugin'`. Names the plugin
   * that shipped this style — surfaced in the `/output-style` picker
   * UX and useful for collision debugging.
   */
  pluginName?: string;
  /**
   * When `false`, the assembler skips the `# Doing tasks` section,
   * allowing non-coding output styles (e.g. translation, writing) to
   * operate without software-engineering guidance. Defaults to `true`
   * (include coding instructions).
   */
  keepCodingInstructions?: boolean;
  /**
   * When `true`, this output style will be automatically applied when
   * the owning plugin is enabled, overriding the user's `outputStyle`
   * setting. Only applicable to plugin output styles (`source === 'plugin'`).
   * When multiple plugins have forced output styles, only one is chosen
   * (the first encountered) and a warning is logged.
   */
  forceForPlugin?: boolean;
}

export interface OutputStyleLoadError {
  filePath: string;
  message: string;
}

export interface OutputStyleLoadOptions {
  recursive?: boolean;
  onError?: (error: OutputStyleLoadError) => void;
}
