/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { CustomResponse } from '../../../../client/response/customResponse.js';

/** The executed result of a {@link QoderRequest}. */
export class QoderResponse extends CustomResponse {
  protected override get requestIdHeaderNames(): readonly string[] {
    return ['x-request-id', 'x-qoder-request-id', 'request-id'];
  }

  /** Gateway trace id, when the response carries one. */
  get traceId(): string | undefined {
    return this.raw?.headers.get('sw-trace-id') ?? undefined;
  }

  static override initial(): QoderResponse {
    return new QoderResponse();
  }
}
