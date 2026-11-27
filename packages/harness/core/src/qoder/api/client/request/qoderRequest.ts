/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CustomRequest,
  type CreateCustomRequestOptions,
} from '../../../../client/request/customRequest.js';
import { CustomRequestBuilder } from '../../../../client/request/customRequestBuilder.js';

/** Data-only construction input for {@link QoderRequest}. */
export interface CreateQoderRequestOptions extends CreateCustomRequestOptions {
  /** Reject the request locally unless a Qoder account is connected. */
  readonly requireLogin?: boolean;
  /** Stable host session id; becomes `X-Session-Id`. */
  readonly sessionId?: string;
  /** Stable user-turn id; becomes `X-Request-Set-Id`. */
  readonly requestSetId?: string;
}

/**
 * Qoder 出站请求：在通用 HTTP 请求之上声明登录门禁与会话归因，
 * 由 Qoder 管线的鉴权/归因阀门读取，不进入请求体。
 */
export class QoderRequest extends CustomRequest {
  private readonly _requireLogin: boolean;
  private readonly _sessionId?: string;
  private readonly _requestSetId?: string;

  constructor(options: CreateQoderRequestOptions) {
    super(options);
    this._requireLogin = options.requireLogin ?? false;
    this._sessionId = options.sessionId?.trim() || undefined;
    this._requestSetId = options.requestSetId?.trim() || undefined;
  }

  get requireLogin(): boolean {
    return this._requireLogin;
  }

  get sessionId(): string | undefined {
    return this._sessionId;
  }

  get requestSetId(): string | undefined {
    return this._requestSetId;
  }
}

/** Fluent builder for a standalone {@link QoderRequest} declaration. */
export class QoderRequestBuilder extends CustomRequestBuilder {
  private _requireLogin = false;
  private _sessionId?: string;
  private _requestSetId?: string;

  private constructor() {
    super();
  }

  static override builder(): QoderRequestBuilder {
    return new QoderRequestBuilder();
  }

  requireLogin(): this {
    this._requireLogin = true;
    return this;
  }

  session(sessionId: string | undefined): this {
    this._sessionId = sessionId;
    return this;
  }

  requestSet(requestSetId: string | undefined): this {
    this._requestSetId = requestSetId;
    return this;
  }

  override build(): QoderRequest {
    const options = this.buildOptions();
    if (!options.url && options.path === undefined) {
      throw new Error(
        'QoderRequestBuilder: build() requires a URL or path before building',
      );
    }
    return new QoderRequest({
      ...options,
      requireLogin: this._requireLogin,
      ...(this._sessionId !== undefined
        ? { sessionId: this._sessionId }
        : {}),
      ...(this._requestSetId !== undefined
        ? { requestSetId: this._requestSetId }
        : {}),
    });
  }
}
