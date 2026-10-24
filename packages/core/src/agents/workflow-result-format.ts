/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { types } from 'node:util';
import { stripAnsiAndControl } from '../utils/textUtils.js';
import { stripDisplayControlChars } from '../utils/terminalSafe.js';

function renderError(error: Error): string {
  const ancestors = new Set<Error>();
  let remaining = 32;
  let text = '';
  let full = false;
  const append = (part: string) => {
    if (full) return;
    const next = text + part;
    full = next.length > 4_096;
    text = truncateWorkflowText(next, 4_096);
  };
  const visit = (value: unknown, depth: number): void => {
    if (full) return;
    if (depth > 4 || remaining-- <= 0) {
      append('… (truncated)');
      return;
    }
    let enteredError: Error | undefined;
    try {
      if (!types.isNativeError(value)) {
        append(String(value));
        return;
      }
      if (ancestors.has(value)) {
        append('[Circular error]');
        return;
      }
      enteredError = value;
      ancestors.add(value);
      const name = value.name;
      append(
        `${typeof name === 'string' ? name : 'Error'}: ${String(value.message ?? '')}`,
      );
      // Native cause/errors are data properties. Do not execute user getters.
      const errors = Object.getOwnPropertyDescriptor(value, 'errors')?.value;
      let length = 0;
      try {
        length = Array.isArray(errors) ? Number(errors.length) : 0;
      } catch {
        append(' [errors: [unrenderable object]]');
      }
      if (length > 0) {
        append(' [errors: ');
        const count = Math.min(length, 8);
        for (let i = 0; i < count; i++) {
          if (i > 0) append('; ');
          try {
            visit(errors[i], depth + 1);
          } catch {
            append('[unrenderable object]');
          }
        }
        if (length > count) append('; … (truncated)');
        append(']');
      }
      const cause = Object.getOwnPropertyDescriptor(value, 'cause')?.value;
      if (cause !== undefined) {
        append(' [cause: ');
        visit(cause, depth + 1);
        append(']');
      }
    } catch {
      append(`[unrenderable ${typeof value}]`);
    } finally {
      if (enteredError) ancestors.delete(enteredError);
    }
  };
  visit(error, 0);
  return text;
}

export function workflowResultReplacer(_key: string, value: unknown): unknown {
  // Workflow values cross a VM boundary, where instanceof checks fail.
  if (types.isNativeError(value)) return renderError(value);
  if (types.isMap(value)) return [...value.entries()];
  if (types.isSet(value)) return [...value.values()];
  return value;
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
      JSON.stringify(result, workflowResultReplacer, pretty ? 2 : undefined) ??
      String(result)
    );
  } catch {
    return `(workflow returned a non-JSON-serializable value of type ${typeof result})`;
  }
}

/**
 * Preserve line structure and indentation while removing terminal and bidi controls.
 * stripAnsiAndControl removes newlines and tabs, so sanitize per line after
 * expanding tabs to spaces.
 */
export function sanitizeWorkflowText(text: string): string {
  return text
    .replace(/\t/g, '  ')
    .split('\n')
    .map((line) => stripDisplayControlChars(stripAnsiAndControl(line)))
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
