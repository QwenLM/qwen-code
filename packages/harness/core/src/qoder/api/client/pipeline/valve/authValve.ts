/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ClientError } from '../../../../../client/clientError.js';
import { BaseValve } from '../../../../../client/pipeline/valve/valve.js';
import { QoderOAuthError } from '../../../oauth-client.js';
import type { QoderRequest } from '../../request/qoderRequest.js';
import type { QoderResponse } from '../../response/qoderResponse.js';

/** Minimal token source; `QoderTokenManager` satisfies this shape. */
export interface QoderTokenProvider {
  getAccessToken(options?: { forceRefresh?: boolean }): Promise<string>;
  /** Drop any cached account so the next read observes a login/refresh. */
  invalidate?(): void;
}

/**
 * Head-of-chain login gate and bearer stage.
 *
 * The token is pulled at request time, so a refresh in another stage or
 * process is observed without rebuilding the client. A 401 cancels the failed
 * body, forces one refresh, and re-runs the rest of the chain once.
 */
export class QoderAuthValve extends BaseValve {
  constructor(private readonly tokens: QoderTokenProvider) {
    super();
  }

  async invoke(request: QoderRequest, response: QoderResponse): Promise<void> {
    let token: string;
    try {
      token = await this.tokens.getAccessToken();
    } catch (error) {
      throw this.toRequestError(request, error);
    }

    request.applyBearerToken(token);
    await this.getNext()!.invoke(request, response);
    if (response.raw?.status !== 401) {
      return;
    }

    await response.raw.body?.cancel().catch(() => {});
    response.raw = undefined;
    let refreshed: string;
    try {
      refreshed = await this.tokens.getAccessToken({ forceRefresh: true });
    } catch (error) {
      throw this.toRequestError(request, error);
    }
    request.applyBearerToken(refreshed);
    await this.getNext()!.invoke(request, response);
  }

  private toRequestError(request: QoderRequest, error: unknown): unknown {
    if (
      request.requireLogin &&
      error instanceof QoderOAuthError &&
      error.code === 'invalid_grant'
    ) {
      return new ClientError(
        `${request.operation}: request requires a logged-in Qoder account`,
        {
          operation: request.operation,
          code: 'auth_required',
          cause: error,
        },
      );
    }
    return error;
  }
}
