/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';
import { ToolErrorType } from '../utils/tool-error-type.js';

export { ToolErrorType };

// Shallow copies keep the response object. Serializing or replacing it drops
// the note, so argument excerpts stay out of transcripts and tool telemetry.
const modelToolErrorNotes = new WeakMap<object, string>();

export function setModelToolErrorNote(part: Part, note: string): void {
  const response = part.functionResponse?.response;
  if (response) modelToolErrorNotes.set(response, note);
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
    if (note.length > remaining) {
      modelToolErrorNotes.delete(response);
    } else {
      remaining -= note.length;
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
      if (!response || typeof response['error'] !== 'string') continue;
      const note = modelToolErrorNotes.get(response);
      if (!note) continue;
      (updatedParts ??= [...parts])[partIndex] = {
        ...part,
        functionResponse: {
          ...functionResponse,
          response: { ...response, error: response['error'] + note },
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
