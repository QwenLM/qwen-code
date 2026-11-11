/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Aggregates built-in, plugin-contributed, and file-based output
 * styles into a single merged set.
 *
 * Precedence (lowest → highest):
 *   public built-in + visible product styles → plugin → user settings dir
 *   → project settings dir → hidden built-in + hidden product styles.
 *
 * This matches how `SkillManager` merges plugin-provided skills
 * before user/workspace skills
 * (`packages/core/src/skills/skillManager.ts:127-155`). Plugin
 * agents in `AgentRegistry` use the opposite order (user → project →
 * plugin). We pick the skills order here because user- and
 * project-level styles are closer to the user and should be the last
 * word on a name collision.
 */

import { BUILTIN_OUTPUT_STYLES, DEFAULT_OUTPUT_STYLE_NAME } from './builtin.js';
import { loadOutputStylesFromPath } from './loader.js';
import type { OutputStyleConfig } from './types.js';
import type { LoadedPlugin } from '../../plugins/types.js';
import { runLogger } from '../../utils/runLogger.js';

export { DEFAULT_OUTPUT_STYLE_NAME } from './builtin.js';

/** Options passed to the output-style resolvers. */
export interface GetOutputStylesOptions {
  /** Loaded plugins whose output-style directories should be scanned. */
  readonly plugins?: readonly LoadedPlugin[];
  /** File-backed candidates from the Config-owned scoped resources. */
  readonly resourceOutputStyles?: readonly OutputStyleConfig[];
  /** Product-contributed styles from builtin plugins. */
  readonly productOutputStyles?: readonly OutputStyleConfig[];
}

async function loadExternalOutputStyleDefinitions(
  options?: GetOutputStylesOptions,
): Promise<OutputStyleConfig[]> {
  const definitions: OutputStyleConfig[] = [];

  // Plugin-provided styles — loaded from plugin output-styles directories
  // and/or single-file `.md` paths declared in plugin manifests.
  if (options?.plugins) {
    for (const plugin of options.plugins) {
      if (plugin.enabled === false) continue;
      const stylePaths: string[] = [];
      if (plugin.outputStylesPath) stylePaths.push(plugin.outputStylesPath);
      if (plugin.outputStylesPaths)
        stylePaths.push(...plugin.outputStylesPaths);

      for (const entry of stylePaths) {
        try {
          definitions.push(
            ...(await loadOutputStylesFromPath(entry, 'plugin', plugin.name)),
          );
        } catch {
          // Silently skip inaccessible output-style paths
        }
      }
    }
  }

  definitions.push(...(options?.resourceOutputStyles ?? []));
  return definitions;
}

/**
 * Returns every known output style keyed by name. `default` maps to
 * `null` — i.e. no extra system-prompt content is emitted.
 *
 * Style precedence (lowest → highest): public built-in + visible product
 * style → plugin → user → project → hidden built-in + hidden product style.
 * Hidden styles are reserved for host integrations and cannot be replaced by
 * external sources.
 */
export async function getAllOutputStyles(
  options?: GetOutputStylesOptions,
): Promise<Record<string, OutputStyleConfig | null>> {
  const definitions = await loadExternalOutputStyleDefinitions(options);
  const productStyles = options?.productOutputStyles ?? [];

  const merged: Record<string, OutputStyleConfig | null> = {
    ...BUILTIN_OUTPUT_STYLES,
  };

  // 产品可见样式与公开内置样式同属 built-in 层，允许被外部同名样式覆盖。
  for (const style of productStyles) {
    if (style.isUserVisible !== false) merged[style.name] = style;
  }
  for (const definition of definitions) {
    merged[definition.name] = definition;
  }

  // 内置与产品的隐藏样式是宿主协议的一部分，不能被用户、项目或插件同名覆盖。
  for (const [name, style] of Object.entries(BUILTIN_OUTPUT_STYLES)) {
    if (style?.isUserVisible === false) merged[name] = style;
  }
  for (const style of productStyles) {
    if (style.isUserVisible === false) merged[style.name] = style;
  }

  return merged;
}

/**
 * Returns every user-visible output-style definition before name-based
 * precedence is applied. Unlike `getAvailableOutputStyles`, this preserves
 * shadowed definitions so callers can explain collisions without changing
 * the name-only `outputStyle` setting contract.
 *
 * The synthetic `default` option is omitted because it has no
 * `OutputStyleConfig`; callers that present it should add it separately.
 */
export async function getAvailableOutputStyleDefinitions(
  options?: GetOutputStylesOptions,
): Promise<OutputStyleConfig[]> {
  const productStyles = options?.productOutputStyles ?? [];
  const hiddenBuiltinNames = new Set([
    ...Object.entries(BUILTIN_OUTPUT_STYLES)
      .filter(([, style]) => style?.isUserVisible === false)
      .map(([name]) => name),
    ...productStyles
      .filter((style) => style.isUserVisible === false)
      .map((style) => style.name),
  ]);
  const builtinDefinitions = [
    ...Object.values(BUILTIN_OUTPUT_STYLES),
    ...productStyles,
  ].filter(
    (style): style is OutputStyleConfig =>
      style !== null && style.isUserVisible !== false,
  );
  const externalDefinitions = await loadExternalOutputStyleDefinitions(options);

  return [...builtinDefinitions, ...externalDefinitions].filter(
    (style) =>
      style.isUserVisible !== false && !hiddenBuiltinNames.has(style.name),
  );
}

/**
 * Returns only styles that may be advertised to users or SDK clients.
 * Hidden built-ins remain available to exact-name resolution for hosts.
 */
export async function getAvailableOutputStyles(
  options?: GetOutputStylesOptions,
): Promise<Record<string, OutputStyleConfig | null>> {
  const all = await getAllOutputStyles(options);
  return Object.fromEntries(
    Object.entries(all).filter(([, style]) => style?.isUserVisible !== false),
  );
}

/**
 * Resolves the effective style, checking for plugin styles that
 * have `forceForPlugin: true`. A forced plugin style takes priority
 * over the user-configured `name`.
 *
 * When multiple plugins declare forced styles, the first one encountered
 * wins and a warning is logged.
 */
export async function resolveOutputStyleWithForce(
  name: string | undefined,
  options?: GetOutputStylesOptions,
): Promise<OutputStyleConfig | null> {
  const all = await getAllOutputStyles(options);

  const forcedStyles = Object.values(all).filter(
    (s): s is OutputStyleConfig =>
      s !== null && s.source === 'plugin' && s.forceForPlugin === true,
  );

  if (forcedStyles.length > 0) {
    if (forcedStyles.length > 1) {
      runLogger.log(
        `[output-style] Multiple plugins have forced output styles: ${forcedStyles.map((s) => s.name).join(', ')}. Using: ${forcedStyles[0].name}`,
      );
    }
    return forcedStyles[0];
  }

  if (!name || name === DEFAULT_OUTPUT_STYLE_NAME) return null;
  return all[name] ?? null;
}
