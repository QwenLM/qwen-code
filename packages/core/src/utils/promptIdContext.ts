/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { runLogger } from './runLogger.js';

export const promptIdContext = new AsyncLocalStorage<string>();

/**
 * Retrieves the prompt ID from the context, or generates a fallback if not found.
 * @param componentName The name of the component requesting the ID (used for the fallback prefix).
 * @returns The retrieved or generated prompt ID.
 */
export function getPromptIdWithFallback(componentName: string): string {
  const promptId = promptIdContext.getStore();
  if (promptId) {
    return promptId;
  }

  const fallbackId = `${componentName}-fallback-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  runLogger.warn(
    `Could not find promptId in context for ${componentName}. This is unexpected. Using a fallback ID: ${fallbackId}`,
  );
  return fallbackId;
}
