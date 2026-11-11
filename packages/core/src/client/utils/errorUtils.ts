/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export function getRequestErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
