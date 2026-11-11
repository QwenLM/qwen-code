/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CustomRequest,
  type CreateCustomRequestOptions,
} from './customRequest.js';
import { ClientError } from '../clientError.js';
import type { EndpointType } from '../endpoint/endpointType.js';
import type { ResolvedIp } from '../endpoint/ip/ipResolver.js';
import { setHeaderIfMissing } from '../utils/headerUtils.js';

/** 链式声明一个独立的 CustomRequest。 */
export class CustomRequestBuilder {
  protected _operation = '';
  protected _endpointType?: EndpointType;
  protected _origin?: string;
  protected _ips?: readonly ResolvedIp[];
  protected _ip?: string;
  protected _path?: string;
  protected _query?: Record<string, string>;
  protected _bearerLiteral?: string;
  protected _requestId?: string;
  protected _resetTimeoutOnStreamActivity?: boolean;
  protected _captureErrorBody = false;
  protected _maxResponseBytes?: number;
  protected _idempotent?: boolean;
  protected _maxAttempts?: number;
  protected _minRouteAttemptMs?: number;
  protected _firstPayloadTimeoutMs?: number;
  protected _establishmentTimeoutMs?: number;
  protected _addressFailover?: boolean;
  protected _preRequestAddressFailover?: boolean;
  protected _sensitivePathTemplate?: string;
  protected _passthroughErrorStatus?: boolean;
  protected _redirect?: RequestRedirect;
  protected _url?: string;
  protected _method = 'GET';
  protected _headers: Record<string, string> = {};
  protected _body?: BodyInit;
  protected _signal?: AbortSignal;
  protected _proxy?: string;
  protected _connectTimeoutMs?: number;
  protected _responseHeadersTimeoutMs?: number;
  protected _requestTimeoutMs?: number;
  protected _bodyIdleTimeoutMs?: number;
  protected _streamResponse = false;
  protected _requireBearer?: boolean;
  protected _requireApiKey?: boolean;

  protected constructor() {}

  static builder(): CustomRequestBuilder {
    return new CustomRequestBuilder();
  }

  url(url: string): this {
    this._url = url;
    return this;
  }

  get(url?: string): this {
    return this.verb('GET', url);
  }

  post(url?: string): this {
    return this.verb('POST', url);
  }

  put(url?: string): this {
    return this.verb('PUT', url);
  }

  delete(url?: string): this {
    return this.verb('DELETE', url);
  }

  patch(url?: string): this {
    return this.verb('PATCH', url);
  }

  method(method: string): this {
    this._method = method;
    return this;
  }

  body(body: BodyInit): this {
    this._body = body;
    return this;
  }

  headers(headers: Readonly<Record<string, string>>): this {
    for (const [name, value] of Object.entries(headers)) {
      this.header(name, value);
    }
    return this;
  }

  header(name: string, value: string): this {
    const normalizedName = name.toLowerCase();
    for (const existingName of Object.keys(this._headers)) {
      if (existingName.toLowerCase() === normalizedName) {
        delete this._headers[existingName];
      }
    }
    this._headers[name] = value;
    return this;
  }

  signal(signal: AbortSignal | undefined): this {
    this._signal = signal;
    return this;
  }

  proxy(url: string): this {
    this._proxy = url;
    return this;
  }

  connectTimeout(milliseconds: number): this {
    this._connectTimeoutMs = milliseconds;
    return this;
  }

  responseHeadersTimeout(milliseconds: number): this {
    this._responseHeadersTimeoutMs = milliseconds;
    return this;
  }

  timeout(milliseconds: number): this {
    this._requestTimeoutMs = milliseconds;
    return this;
  }

  bodyIdleTimeout(milliseconds: number): this {
    this._bodyIdleTimeoutMs = milliseconds;
    return this;
  }

  requireBearer(require: boolean): this {
    this._requireBearer = require;
    return this;
  }

  requireApiKey(require: boolean): this {
    this._requireApiKey = require;
    return this;
  }

  stream(): this {
    this._streamResponse = true;
    return this;
  }

  build(): CustomRequest {
    if (!this._url && this._path === undefined) {
      throw new Error('CustomRequestBuilder：build() 前必须提供 URL 或路径');
    }
    return new CustomRequest(this.buildOptions());
  }

  protected verb(method: string, url?: string): this {
    this._method = method;
    if (url !== undefined) {
      this._url = url;
    }
    return this;
  }

  operation(name: string): this {
    this._operation = name;
    return this;
  }

  endpoint(type: EndpointType): this {
    this._endpointType = type;
    return this;
  }

  origin(origin: string): this {
    this._origin = origin;
    return this;
  }

  ips(ips: readonly ResolvedIp[]): this {
    this._ips = ips;
    return this;
  }

  ip(ip: string): this {
    this._ip = ip;
    return this;
  }

  path(path: string): this {
    this._path = path;
    return this;
  }

  query(query: Record<string, string>): this {
    this._query = query;
    return this;
  }

  json(json: unknown): this {
    this._body = JSON.stringify(json);
    setHeaderIfMissing(this._headers, 'Content-Type', 'application/json');
    return this;
  }

  /** Inject the active bearer credential reported by the BearerResolver. */
  withBearerToken(): this {
    this._requireBearer = true;
    return this;
  }

  withBearerTokenLiteral(token: string): this {
    this._bearerLiteral = token;
    return this;
  }

  requestId(id: string): this {
    this._requestId = id;
    return this;
  }

  resetTimeoutOnStreamActivity(enabled: boolean): this {
    this._resetTimeoutOnStreamActivity = enabled;
    return this;
  }

  idempotent(value: boolean): this {
    this._idempotent = value;
    return this;
  }

  maxAttempts(count: number): this {
    this._maxAttempts = count;
    return this;
  }

  minRouteAttempt(milliseconds: number): this {
    this._minRouteAttemptMs = milliseconds;
    return this;
  }

  firstPayloadTimeout(milliseconds: number): this {
    this._firstPayloadTimeoutMs = milliseconds;
    return this;
  }

  establishmentTimeout(milliseconds: number): this {
    this._establishmentTimeoutMs = milliseconds;
    return this;
  }

  addressFailover(enabled: boolean): this {
    this._addressFailover = enabled;
    return this;
  }

  preRequestAddressFailover(enabled: boolean): this {
    this._preRequestAddressFailover = enabled;
    return this;
  }

  /** Keep the body of a non-2xx response on the thrown ClientError. */
  captureErrorBody(): this {
    this._captureErrorBody = true;
    return this;
  }

  maxResponseBytes(bytes: number): this {
    if (!Number.isSafeInteger(bytes) || bytes <= 0)
      throw new ClientError('Response byte limit must be a positive integer');
    this._maxResponseBytes = bytes;
    return this;
  }

  sensitivePathTemplate(template: string): this {
    this._sensitivePathTemplate = template;
    return this;
  }

  passthroughErrorStatus(): this {
    this._passthroughErrorStatus = true;
    return this;
  }

  redirect(policy: RequestRedirect): this {
    this._redirect = policy;
    return this;
  }

  protected buildOptions(): CreateCustomRequestOptions {
    return {
      url: this._url ?? '',
      requireApiKey: this._requireApiKey,
      operation: this._operation,
      method: this._method,
      endpointType: this._endpointType,
      origin: this._origin,
      ips: this._ips,
      ip: this._ip,
      path: this._path,
      query: this._query,
      body: this._body,
      headers: this._headers,
      requireBearer: this._requireBearer,
      bearerLiteral: this._bearerLiteral,
      requestId: this._requestId,
      requestTimeoutMs: this._requestTimeoutMs,
      bodyIdleTimeoutMs: this._bodyIdleTimeoutMs,
      resetTimeoutOnStreamActivity: this._resetTimeoutOnStreamActivity,
      signal: this._signal,
      streamResponse: this._streamResponse,
      captureErrorBody: this._captureErrorBody,
      maxResponseBytes: this._maxResponseBytes,
      proxy: this._proxy,
      idempotent: this._idempotent,
      maxAttempts: this._maxAttempts,
      connectTimeoutMs: this._connectTimeoutMs,
      minRouteAttemptMs: this._minRouteAttemptMs,
      firstPayloadTimeoutMs: this._firstPayloadTimeoutMs,
      responseHeadersTimeoutMs: this._responseHeadersTimeoutMs,
      establishmentTimeoutMs: this._establishmentTimeoutMs,
      addressFailover: this._addressFailover,
      preRequestAddressFailover: this._preRequestAddressFailover,
      sensitivePathTemplate: this._sensitivePathTemplate,
      passthroughErrorStatus: this._passthroughErrorStatus,
      redirect: this._redirect,
    };
  }
}
