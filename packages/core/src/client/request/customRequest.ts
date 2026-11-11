/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { INFERENCE, type EndpointType } from '../endpoint/endpointType.js';
import type { ResolvedIp } from '../endpoint/ip/ipResolver.js';
import { joinOriginPath } from '../utils/urlUtils.js';

export const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024 * 1024;

/** 链式请求声明支持的 HTTP 动词。 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

/** CustomRequest 的纯数据构造选项。 */
export interface CreateCustomRequestOptions {
  operation?: string;
  endpointType?: EndpointType;
  origin?: string;
  path?: string;
  query?: Readonly<Record<string, string>>;
  requestId?: string;
  resetTimeoutOnStreamActivity?: boolean;
  idempotent?: boolean;
  maxAttempts?: number;
  minRouteAttemptMs?: number;
  firstPayloadTimeoutMs?: number;
  addressFailover?: boolean;
  preRequestAddressFailover?: boolean;
  /** Attach a non-2xx response body to the thrown error. */
  captureErrorBody?: boolean;
  /**
   * Bound buffered/decrypted control bodies; does not cap a successful SSE
   * stream. Defaults to {@link DEFAULT_MAX_RESPONSE_BYTES}.
   */
  maxResponseBytes?: number;
  /**
   * Trusted, static path template used by every logging surface in
   * place of the concrete path, for requests whose URL embeds sensitive
   * resource names. Mirrors `sensitivePathTemplate` on the core server request.
   */
  sensitivePathTemplate?: string;
  /** Return a non-2xx response to the caller instead of throwing ClientError. */
  passthroughErrorStatus?: boolean;
  url?: string;
  method: string;
  headers: Readonly<Record<string, string>>;
  body?: BodyInit;
  signal?: AbortSignal;
  proxy?: string;
  ip?: string;
  ips?: readonly ResolvedIp[];
  connectTimeoutMs?: number;
  responseHeadersTimeoutMs?: number;
  requestTimeoutMs?: number;
  bodyIdleTimeoutMs?: number;
  establishmentTimeoutMs?: number;
  streamResponse: boolean;
  /** 向鉴权阀声明需要 bearer token；默认 true，凭证有无由 resolver 裁量。 */
  requireBearer?: boolean;
  /** 请求级显式 bearer token，优先于 resolver。 */
  bearerLiteral?: string;
  /** 向鉴权阀声明需要 API key；默认 true，凭证有无由 resolver 裁量。 */
  requireApiKey?: boolean;
  /** Fetch redirect policy; unset keeps the fetch default. */
  redirect?: RequestRedirect;
}

/** SDK 已物化的 HTTP 请求，供出站管线读取和补充；各 client 请求继承扩展。 */
export class CustomRequest {
  protected readonly _operation: string;
  protected readonly _endpointType: EndpointType;
  protected _origin?: string;
  protected _path?: string;
  protected _query?: Readonly<Record<string, string>>;
  protected readonly _requestId?: string;
  protected readonly _captureErrorBody: boolean;
  protected readonly _maxResponseBytes: number;

  protected _sensitivePathTemplate?: string;
  protected _passthroughErrorStatus: boolean;
  protected _idempotent?: boolean;
  protected _maxAttempts?: number;
  protected _minRouteAttemptMs?: number;
  protected _firstPayloadTimeoutMs?: number;
  protected _addressFailover?: boolean;
  protected _preRequestAddressFailover?: boolean;
  protected _resetTimeoutOnStreamActivity?: boolean;
  protected _bodyReplayable?: boolean;
  protected _url: string;
  protected readonly _method: string;
  protected _headers: Record<string, string>;
  protected _body?: BodyInit;
  protected readonly _signal?: AbortSignal;
  protected _proxy?: string;
  protected _ip?: string;
  protected _ips?: readonly ResolvedIp[];
  protected _connectTimeoutMs?: number;
  protected _responseHeadersTimeoutMs?: number;
  protected _requestTimeoutMs?: number;
  protected _bodyIdleTimeoutMs?: number;
  protected _establishmentTimeoutMs?: number;
  protected readonly _streamResponse: boolean;
  protected _requireBearer?: boolean;
  protected readonly _bearerLiteral?: string;
  protected readonly _requireApiKey: boolean;
  protected readonly _redirect?: RequestRedirect;

  constructor(options: CreateCustomRequestOptions) {
    this._url = options.url ?? '';
    this._method = options.method;
    this._headers = { ...options.headers };
    this._body = options.body;
    this._signal = options.signal;
    this._proxy = options.proxy;
    this._ip = options.ip;
    this._ips = options.ips;
    this._connectTimeoutMs = options.connectTimeoutMs;
    this._responseHeadersTimeoutMs = options.responseHeadersTimeoutMs;
    this._requestTimeoutMs = options.requestTimeoutMs;
    this._bodyIdleTimeoutMs = options.bodyIdleTimeoutMs;
    this._establishmentTimeoutMs = options.establishmentTimeoutMs;
    this._streamResponse = options.streamResponse;
    this._requireBearer = options.requireBearer ?? true;
    this._bearerLiteral = options.bearerLiteral;
    this._requireApiKey = options.requireApiKey ?? true;
    this._redirect = options.redirect;
    this._operation = options.operation ?? '';
    this._endpointType = options.endpointType ?? INFERENCE;
    this._origin = options.origin;
    this._path = options.path;
    this._query = options.query;
    this._requestId = options.requestId;
    this._captureErrorBody = options.captureErrorBody ?? false;
    this._maxResponseBytes =
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this._sensitivePathTemplate = options.sensitivePathTemplate;
    this._passthroughErrorStatus = options.passthroughErrorStatus ?? false;
    this._idempotent = options.idempotent;
    this._maxAttempts = options.maxAttempts;
    this._minRouteAttemptMs = options.minRouteAttemptMs;
    this._firstPayloadTimeoutMs = options.firstPayloadTimeoutMs;
    this._addressFailover = options.addressFailover;
    this._preRequestAddressFailover = options.preRequestAddressFailover;
    this._resetTimeoutOnStreamActivity = options.resetTimeoutOnStreamActivity;
  }

  get protocol(): 'http' {
    return 'http';
  }

  get url(): string {
    return this._path === undefined
      ? this._url
      : `${this._origin ?? ''}${this.pathWithQuery()}`;
  }

  /** url 为相对路径（端点阀未解析）时为 undefined。 */
  get origin(): string | undefined {
    if (this._path !== undefined) return this._origin;
    try {
      return new URL(this._url).origin;
    } catch {
      return undefined;
    }
  }

  /** 端点解析键；无配置上下文的基类请求默认推理端点。 */
  get endpointType(): EndpointType {
    return this._endpointType;
  }

  get method(): string {
    return this._method;
  }

  /** 含鉴权凭证，日志与诊断不得原样记录。 */
  get headers(): Readonly<Record<string, string>> {
    return this._headers;
  }

  get body(): BodyInit | undefined {
    return this._body;
  }

  get signal(): AbortSignal | undefined {
    return this._signal;
  }

  get proxy(): string | undefined {
    return this._proxy;
  }

  get ip(): string | undefined {
    return this._ip;
  }

  get ips(): readonly ResolvedIp[] | undefined {
    return this._ips;
  }

  get connectTimeoutMs(): number | undefined {
    return this._connectTimeoutMs;
  }

  set connectTimeoutMs(value: number | undefined) {
    this._connectTimeoutMs = value;
  }

  get responseHeadersTimeoutMs(): number | undefined {
    return this._responseHeadersTimeoutMs;
  }

  set responseHeadersTimeoutMs(value: number | undefined) {
    this._responseHeadersTimeoutMs = value;
  }

  get requestTimeoutMs(): number | undefined {
    return this._requestTimeoutMs;
  }

  get bodyIdleTimeoutMs(): number | undefined {
    return this._bodyIdleTimeoutMs;
  }

  set bodyIdleTimeoutMs(value: number | undefined) {
    this._bodyIdleTimeoutMs = value;
  }

  get establishmentTimeoutMs(): number | undefined {
    return this._establishmentTimeoutMs;
  }

  set establishmentTimeoutMs(value: number | undefined) {
    this._establishmentTimeoutMs = value;
  }

  get streamResponse(): boolean {
    return this._streamResponse;
  }

  get redirect(): RequestRedirect | undefined {
    return this._redirect;
  }

  get requireBearer(): boolean | undefined {
    return this._requireBearer;
  }

  get bearerLiteral(): string | undefined {
    return this._bearerLiteral;
  }

  get requireApiKey(): boolean {
    return this._requireApiKey;
  }

  /** HTTP 标头名不区分大小写，覆盖时移除已有的同名项。 */
  setHeader(name: string, value: string): void {
    const normalizedName = name.toLowerCase();
    for (const existingName of Object.keys(this._headers)) {
      if (existingName.toLowerCase() === normalizedName) {
        delete this._headers[existingName];
      }
    }
    this._headers[name] = value;
  }

  setProxy(proxyUrl: string | undefined): void {
    this._proxy = proxyUrl;
  }

  /** 更新完整 URL 及其路径、查询参数投影。 */
  setUrl(value: string): void {
    const url = new URL(value);
    this._url = value;
    this._origin = url.origin;
    this._path = url.pathname;
    this._query = url.search
      ? Object.fromEntries(new URLSearchParams(url.search))
      : undefined;
  }

  setBody(body: BodyInit | undefined): void {
    this._body = body;
  }

  /** Pins one selected address for the transport while retaining the URL hostname. */
  setIp(ip: string | undefined): void {
    this._ip = ip;
  }

  setIps(ips?: readonly ResolvedIp[]): void {
    this._ips = ips;
  }

  applyBearerToken(token: string): void {
    this.setHeader('Authorization', `Bearer ${token}`);
  }

  applyApiKeyToken(
    token: string,
    header: 'x-api-key' | 'x-goog-api-key' = 'x-api-key',
  ): void {
    this.setHeader(header, token);
  }

  /**
   * 把解析出的 origin 前缀到相对路径 url 上；已是绝对 url 时幂等。
   * origin 可带路径（如 `https://host/v1`）：其尾部与相对路径开头重合的段
   * 不重复拼接，origin 已以整个相对路径结尾时直接使用 origin。
   */
  setOrigin(origin: string): void {
    if (this._path !== undefined) {
      this._origin = origin;
    } else if (this.origin === undefined) {
      this._url = joinOriginPath(origin, this._url);
    }
  }

  get operation(): string {
    return this._operation;
  }

  /** The raw sensitive template, when the concrete path must not reach diagnostics. */
  get sensitivePathTemplate(): string | undefined {
    return this._sensitivePathTemplate;
  }

  /** The path safe to write into logs. */
  get logPath(): string {
    return this._sensitivePathTemplate ?? this.path;
  }

  get passthroughErrorStatus(): boolean {
    return this._passthroughErrorStatus;
  }

  get idempotent(): boolean | undefined {
    return this._idempotent;
  }

  set idempotent(value: boolean) {
    this._idempotent = value;
  }

  get maxAttempts(): number | undefined {
    return this._maxAttempts;
  }

  set maxAttempts(value: number) {
    this._maxAttempts = value;
  }

  get minRouteAttemptMs(): number | undefined {
    return this._minRouteAttemptMs;
  }

  set minRouteAttemptMs(value: number | undefined) {
    this._minRouteAttemptMs = value;
  }

  get firstPayloadTimeoutMs(): number | undefined {
    return this._firstPayloadTimeoutMs;
  }

  set firstPayloadTimeoutMs(value: number | undefined) {
    this._firstPayloadTimeoutMs = value;
  }

  get addressFailover(): boolean | undefined {
    return this._addressFailover;
  }

  set addressFailover(value: boolean) {
    this._addressFailover = value;
  }

  get preRequestAddressFailover(): boolean | undefined {
    return this._preRequestAddressFailover;
  }

  set preRequestAddressFailover(value: boolean) {
    this._preRequestAddressFailover = value;
  }

  get resetTimeoutOnStreamActivity(): boolean | undefined {
    return this._resetTimeoutOnStreamActivity;
  }

  set resetTimeoutOnStreamActivity(value: boolean) {
    this._resetTimeoutOnStreamActivity = value;
  }

  /** Whether the body can be re-sent on a retry; settled by ResilienceValve. */
  get bodyReplayable(): boolean | undefined {
    return this._bodyReplayable;
  }

  set bodyReplayable(value: boolean) {
    this._bodyReplayable = value;
  }

  get path(): string {
    if (this._path !== undefined) return this._path;
    try {
      return new URL(this._url).pathname;
    } catch {
      return this._url.split(/[?#]/, 1)[0] ?? '';
    }
  }

  get query(): Readonly<Record<string, string>> | undefined {
    return this._query;
  }

  get requestId(): string | undefined {
    return this._requestId;
  }

  get captureErrorBody(): boolean {
    return this._captureErrorBody;
  }

  get maxResponseBytes(): number {
    return this._maxResponseBytes;
  }

  // ─── In-place mutations ──────────────────────────────────────────────────

  /** Merge headers onto the request, overwriting same-name keys. */
  mergeHeaders(headers: Readonly<Record<string, string>>): void {
    Object.assign(this._headers, headers);
  }

  /**
   * Run a mutator over the headers in place, so callers can reuse header
   * utilities (case-insensitive writes, canonical request-id) without reaching
   * into the internal record directly.
   */
  mutateHeaders(mutator: (headers: Record<string, string>) => void): void {
    mutator(this._headers);
  }

  /** Whether an earlier pipeline stage has already selected authentication. */
  hasAuthorizationHeader(): boolean {
    return Object.keys(this._headers).some(
      (name) => name.toLowerCase() === 'authorization',
    );
  }

  pathWithQuery(): string {
    if (!this._query) return this.path;
    const search = new URLSearchParams(this._query).toString();
    return search.length > 0 ? `${this.path}?${search}` : this.path;
  }

  resolveTraceId(): string | undefined {
    const traceparent = Object.entries(this._headers).find(
      ([name]) => name.toLowerCase() === 'traceparent',
    )?.[1];
    const match = traceparent?.match(
      /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/i,
    );
    const traceId = match?.[1];
    return traceId && !/^0{32}$/.test(traceId)
      ? traceId.toLowerCase()
      : undefined;
  }
}
