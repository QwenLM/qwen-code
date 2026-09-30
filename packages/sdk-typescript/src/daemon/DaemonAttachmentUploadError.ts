/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { DaemonHttpError } from './DaemonHttpError.js';

/** A negotiated chunk upload failed; callers must not replay it as inline content. */
export class DaemonAttachmentUploadError extends Error {
  readonly status: number | undefined;
  readonly httpStatus: number | undefined;
  readonly body: unknown;

  constructor(cause: unknown) {
    super(
      `Attachment upload failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'DaemonAttachmentUploadError';
    this.httpStatus =
      cause instanceof DaemonHttpError ? cause.status : undefined;
    // An expired upload ID is not the legacy endpoint's unsupported-route 404.
    this.status = this.httpStatus === 404 ? undefined : this.httpStatus;
    this.body = cause instanceof DaemonHttpError ? cause.body : undefined;
  }
}
