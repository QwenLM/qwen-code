/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import highlights from './whats-new-content.json' with { type: 'json' };

export const whatsNewByVersion: Record<string, readonly string[]> = highlights;

export function getWhatsNewHighlights(
  version: string,
): readonly string[] | undefined {
  return whatsNewByVersion[version.replace(/-preview\.\d+$/, '')];
}
