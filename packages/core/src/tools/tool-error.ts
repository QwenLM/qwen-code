/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';
import { ToolErrorType } from '../utils/tool-error-type.js';

export { ToolErrorType };

// Keep the insertion offset so the note precedes any appended hook context.
const modelToolErrorNotes = new WeakMap<
  object,
  { text: string; offset: number }
>();

export function setModelToolErrorNote(part: Part, note: string): void {
  const response = part.functionResponse?.response;
  const error = response?.['error'];
  if (response && typeof error === 'string') {
    modelToolErrorNotes.set(response, { text: note, offset: error.length });
  }
}

export function copyModelToolErrorNote(original: Part, updated: Part): void {
  const source = original.functionResponse?.response;
  const target = updated.functionResponse?.response;
  if (!source || !target) return;
  const note = modelToolErrorNotes.get(source);
  if (note) modelToolErrorNotes.set(target, note);
}

export function limitModelToolErrorNotes(
  parts: Part[],
  remainingBudget: () => number,
): void {
  let remaining: number | undefined;
  for (const part of parts) {
    const response = part.functionResponse?.response;
    if (!response) continue;
    const note = modelToolErrorNotes.get(response);
    if (!note) continue;
    remaining ??= remainingBudget();
    if (note.text.length > remaining) {
      modelToolErrorNotes.delete(response);
    } else {
      remaining -= note.text.length;
    }
  }
}

export function withModelToolErrorNotes(contents: Content[]): Content[] {
  let updated: Content[] | undefined;
  for (const [index, content] of contents.entries()) {
    const parts = content.parts;
    if (!parts || content.role !== 'user') continue;
    let updatedParts: Part[] | undefined;
    for (const [partIndex, part] of parts.entries()) {
      const functionResponse = part.functionResponse;
      const response = functionResponse?.response;
      const error = response?.['error'];
      if (!response || typeof error !== 'string') continue;
      const note = modelToolErrorNotes.get(response);
      if (!note) continue;
      (updatedParts ??= [...parts])[partIndex] = {
        ...part,
        functionResponse: {
          ...functionResponse,
          response: {
            ...response,
            error:
              error.slice(0, note.offset) +
              note.text +
              error.slice(note.offset),
          },
        },
      };
    }
    if (updatedParts) {
      (updated ??= [...contents])[index] = { ...content, parts: updatedParts };
    }
  }
  return updated ?? contents;
}

/**
 * Error thrown by `getConfirmationDetails()` when it needs to surface
 * a structured `ToolErrorType` to the scheduler instead of letting
 * the throw collapse into a generic `UNHANDLED_EXCEPTION`. Originally
 * introduced for prior-read enforcement
 * but now also carries other content-derived `calculateEdit` errors
 * — `EDIT_NO_OCCURRENCE_FOUND`, `EDIT_EXPECTED_OCCURRENCE_MISMATCH`,
 * `EDIT_NO_CHANGE`, `ATTEMPT_TO_CREATE_EXISTING_FILE` — through the
 * confirmation path so they keep their proper error code instead of
 * being reported as "unhandled exception".
 *
 * Caught by `coreToolScheduler` via the `errorType` instance field.
 *
 * Naming note: kept generic (`StructuredToolError`) rather than
 * `PriorReadEnforcementError` so the name matches the broader set of
 * `ToolErrorType` values it actually carries — an oncall engineer
 * seeing this in a log paired with `edit_no_occurrence_found` should
 * not have to wonder what prior-read has to do with it.
 */
export class StructuredToolError extends Error {
  override readonly name = 'StructuredToolError';
  constructor(
    message: string,
    readonly errorType: ToolErrorType,
  ) {
    super(message);
  }
}
