/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export const DEFAULT_QWEN_MODEL = 'coder-model';
export const DEFAULT_QWEN_FLASH_MODEL = 'coder-model';
export const DEFAULT_QWEN_EMBEDDING_MODEL = 'text-embedding-v4';
export const MAINLINE_CODER_MODEL = 'qwen3.5-plus';

export function resolveModel(
  model: string,
  hasAccessToPreview: boolean = true,
): string {
  if (hasAccessToPreview) return model;

  const m = model.toLowerCase();
  if (!m.includes('preview')) return model;

  if (/gemini.*flash.*preview|gemini.*preview.*flash/.test(m)) {
    return model.replace(/[-_]?preview/gi, '').replace(/--+/g, '-');
  }

  if (/gemini.*pro.*preview|gemini.*preview.*pro|gemini-3\.1/.test(m)) {
    return model.replace(/[-_]?preview/gi, '').replace(/--+/g, '-');
  }

  const stripped = model.replace(/[-_]?preview/gi, '').replace(/--+/g, '-');
  return stripped || DEFAULT_QWEN_MODEL;
}
