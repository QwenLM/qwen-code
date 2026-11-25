/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';
import { getModelToolErrorNote } from '../utils/api-history-metadata.js';
import { ToolErrorType } from '../utils/tool-error-type.js';
import {
  getToolOutputRecovery,
  setToolOutputRecovery,
} from './tool-output-recovery.js';

export { ToolErrorType };
export {
  copyModelToolErrorNote,
  setModelToolErrorNote,
} from '../utils/api-history-metadata.js';

export function limitModelToolErrorNotes(
  parts: Part[],
  remainingBudget: () => number,
): Part[] {
  let updated: Part[] | undefined;
  let remaining: number | undefined;
  for (const [index, part] of parts.entries()) {
    const functionResponse = part.functionResponse;
    const response = functionResponse?.response;
    if (!response) continue;
    const note = getModelToolErrorNote(response);
    if (!note) continue;
    remaining ??= remainingBudget();
    if (note.text.length > remaining) {
      // A pressure-budget preview must not discard the original candidate's note.
      const copy = {
        ...part,
        functionResponse: { ...functionResponse, response: { ...response } },
      };
      const recovery = getToolOutputRecovery(part);
      if (recovery) setToolOutputRecovery(copy, recovery);
      (updated ??= [...parts])[index] = copy;
    } else {
      remaining -= note.text.length;
    }
  }
  return updated ?? parts;
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
      const note = getModelToolErrorNote(response);
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
