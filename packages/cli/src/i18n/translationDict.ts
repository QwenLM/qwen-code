/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type TranslationValue = string | string[];
export type TranslationDict = Record<string, TranslationValue>;

export function getTranslationModuleExport(
  module: Record<string, unknown>,
): unknown {
  return Object.prototype.hasOwnProperty.call(module, 'default')
    ? module['default']
    : module;
}

export function isTranslationDict(value: unknown): value is TranslationDict {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  );
}
