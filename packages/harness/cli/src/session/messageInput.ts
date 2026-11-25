/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export function extractContentBlocks(
  content: unknown,
): Array<{ type: string; [key: string]: unknown }> {
  if (content == null) return [];
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }
  if (Array.isArray(content)) {
    return content.filter(
      (part): part is { type: string; [key: string]: unknown } =>
        part != null && typeof part === 'object' && 'type' in part,
    );
  }
  return [];
}

export function extractText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) => {
        if (part != null && typeof part === 'object' && 'text' in part) {
          const textVal = (part as { text: unknown }).text;
          return typeof textVal === 'string' ? textVal : '';
        }
        return '';
      })
      .filter(Boolean)
      .join('');
  }
  return String(content);
}
