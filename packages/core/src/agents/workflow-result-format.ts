/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { types } from 'node:util';
import { stripAnsiAndControl } from '../utils/textUtils.js';

function renderError(error: Error): string {
  const name = typeof error.name === 'string' ? error.name : 'Error';
  const message = String(error.message ?? '');
  return typeof error.stack === 'string' && error.stack.includes(message)
    ? error.stack
    : `${name}: ${message}`;
}

export function stringifyWorkflowResult(
  result: unknown,
  pretty = false,
): string {
  if (result === undefined) return '(workflow returned no value)';
  if (typeof result === 'string') return result;
  try {
    // Workflow values cross a VM boundary, where instanceof Error is false.
    if (types.isNativeError(result)) return renderError(result);
    return (
      JSON.stringify(
        result,
        (_key, value: unknown) =>
          types.isNativeError(value) ? renderError(value) : value,
        pretty ? 2 : undefined,
      ) ?? String(result)
    );
  } catch {
    return `(workflow returned a non-JSON-serializable value of type ${typeof result})`;
  }
}

/**
 * Preserve line structure and indentation while removing terminal controls.
 * stripAnsiAndControl removes newlines and tabs, so sanitize per line after
 * expanding tabs to spaces.
 */
export function sanitizeWorkflowText(text: string): string {
  return text
    .replace(/\t/g, '  ')
    .split('\n')
    .map((line) => stripAnsiAndControl(line))
    .join('\n');
}

export function truncateWorkflowText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = '… (truncated)';
  let end = Math.max(0, maxChars - marker.length);
  const before = text.charCodeAt(end - 1);
  const after = text.charCodeAt(end);
  if (
    before >= 0xd800 &&
    before <= 0xdbff &&
    after >= 0xdc00 &&
    after <= 0xdfff
  ) {
    end -= 1;
  }
  return `${text.slice(0, end)}${marker.slice(0, maxChars)}`;
}
