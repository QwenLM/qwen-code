/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export class DesktopHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function isDesktopHttpError(error: unknown): error is DesktopHttpError {
  return error instanceof DesktopHttpError;
}
