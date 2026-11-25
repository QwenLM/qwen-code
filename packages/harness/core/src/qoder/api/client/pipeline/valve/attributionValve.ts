/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';

import { BaseValve } from '../../../../../client/pipeline/valve/valve.js';
import { QODER_CLIENT_TYPE } from '../../../regions.js';
import type { QoderRequest } from '../../request/qoderRequest.js';
import type { QoderResponse } from '../../response/qoderResponse.js';

export interface QoderAttributionValveOptions {
  readonly clientVersion: string;
  readonly generateId?: () => string;
}

/**
 * Qoder attribution and per-request correlation headers.
 *
 * Sits after the retry stage so every physical send gets a fresh
 * `X-Request-Id`, while `X-Session-Id` and `X-Request-Set-Id` stay stable for
 * the session and user turn.
 */
export class QoderAttributionValve extends BaseValve {
  private readonly generateId: () => string;

  constructor(private readonly options: QoderAttributionValveOptions) {
    super();
    this.generateId = options.generateId ?? randomUUID;
  }

  async invoke(request: QoderRequest, response: QoderResponse): Promise<void> {
    request.setHeader('Cosy-ClientType', QODER_CLIENT_TYPE);
    request.setHeader('Cosy-Version', this.options.clientVersion);
    request.setHeader('X-Request-Id', this.generateId());
    if (request.sessionId) {
      request.setHeader('X-Session-Id', request.sessionId);
    }
    if (request.requestSetId) {
      request.setHeader('X-Request-Set-Id', request.requestSetId);
    }
    await this.getNext()!.invoke(request, response);
  }
}
