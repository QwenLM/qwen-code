/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ModelPromptPatch {
  action: 'edit_system_prompt';
  content: string;
}

export type ModelPromptPatches = Record<string, ModelPromptPatch[]>;

/**
 * Validate and clone the model prompt patches received from an SDK initialize
 * request. Empty patch maps are normalized away so model requests never send
 * an empty `patches` object.
 */
export function parseModelPromptPatches(
  value: unknown,
): ModelPromptPatches | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error('invalid modelRequestPatches');
  }

  const resultEntries: Array<[string, ModelPromptPatch[]]> = [];
  for (const [routeKey, rawPatches] of Object.entries(value)) {
    if (!routeKey || !Array.isArray(rawPatches)) {
      throw new Error('invalid modelRequestPatches');
    }

    const patches = rawPatches.map((rawPatch) => {
      if (
        !isRecord(rawPatch) ||
        rawPatch['action'] !== 'edit_system_prompt' ||
        !isString(rawPatch['content'])
      ) {
        throw new Error('invalid modelRequestPatches');
      }
      return {
        action: 'edit_system_prompt' as const,
        content: rawPatch['content'],
      };
    });

    if (patches.length > 0) {
      resultEntries.push([routeKey, patches]);
    }
  }

  return resultEntries.length > 0
    ? Object.fromEntries(resultEntries)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}
