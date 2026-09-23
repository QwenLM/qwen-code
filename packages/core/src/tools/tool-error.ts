/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolErrorType } from '../utils/tool-error-type.js';

export { ToolErrorType };

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
