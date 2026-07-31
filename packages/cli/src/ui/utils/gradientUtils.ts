/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export function getRenderableGradientColors(
  ...candidates: Array<string[] | undefined>
): string[] | undefined {
  return candidates.find(
    (colors): colors is string[] =>
      Array.isArray(colors) &&
      colors.length >= 2 &&
      colors.every(
        (color) => typeof color === 'string' && color.trim().length > 0,
      ),
  );
}
