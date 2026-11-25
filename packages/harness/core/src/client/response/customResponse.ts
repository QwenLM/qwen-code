/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { DEFAULT_MAX_RESPONSE_BYTES } from '../request/customRequest.js';
import { readBoundedResponseBody } from '../utils/bytesUtils.js';
import { decodeResponseBody } from '../utils/jsonUtils.js';
import { streamSse, type SseEvent } from '../utils/sseUtils.js';

export const DEFAULT_MAX_DOWNLOAD_BYTES = DEFAULT_MAX_RESPONSE_BYTES;

/** 通用 HTTP 响应的构造选项。 */
export interface CreateCustomResponseOptions {
  readonly raw?: Response;
  readonly operation?: string;
  readonly requestId?: string;
  readonly maxBytes?: number;
  readonly streamResponse?: boolean;
  readonly firstPayloadTimeoutMs?: number;
  readonly bodyIdleTimeoutMs?: number;
  readonly resetTimeoutOnStreamActivity?: boolean;
}

/** 出站管线填充的 HTTP 响应，提供有界读取、JSON 解码及 SSE 消费。 */
export class CustomResponse {
  protected _raw: Response | undefined;
  protected _operation = '';
  protected _requestId = '';
  protected _maxBytes = DEFAULT_MAX_DOWNLOAD_BYTES;
  protected _streamResponse = false;
  protected _firstPayloadTimeoutMs?: number;
  protected _bodyIdleTimeoutMs?: number;
  protected _resetTimeoutOnStreamActivity = false;

  constructor(options?: CreateCustomResponseOptions) {
    if (!options) return;
    this._raw = options.raw;
    this._operation = options.operation ?? '';
    this._requestId = options.requestId || '';
    this._maxBytes = options.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
    this._streamResponse = options.streamResponse ?? false;
    this._firstPayloadTimeoutMs = options.firstPayloadTimeoutMs;
    this._bodyIdleTimeoutMs = options.bodyIdleTimeoutMs;
    this._resetTimeoutOnStreamActivity =
      options.resetTimeoutOnStreamActivity ?? false;
  }

  get raw(): Response | undefined {
    return this._raw;
  }

  set raw(value: Response | undefined) {
    this._raw = value;
  }

  get operation(): string {
    return this._operation;
  }

  set operation(value: string) {
    this._operation = value;
  }

  protected get requestIdHeaderNames(): readonly string[] {
    return ['x-request-id', 'request-id'];
  }

  get requestId(): string {
    for (const name of this.requestIdHeaderNames) {
      const requestId = this._raw?.headers.get(name);
      if (requestId !== undefined && requestId !== null) return requestId;
    }
    return this._requestId;
  }

  set requestId(value: string) {
    this._requestId = value;
  }

  get maxBytes(): number {
    return this._maxBytes;
  }

  set maxBytes(value: number) {
    this._maxBytes = value;
  }

  get streamResponse(): boolean {
    return this._streamResponse;
  }

  set streamResponse(value: boolean) {
    this._streamResponse = value;
  }

  get firstPayloadTimeoutMs(): number | undefined {
    return this._firstPayloadTimeoutMs;
  }

  set firstPayloadTimeoutMs(value: number | undefined) {
    this._firstPayloadTimeoutMs = value;
  }

  get bodyIdleTimeoutMs(): number | undefined {
    return this._bodyIdleTimeoutMs;
  }

  set bodyIdleTimeoutMs(value: number | undefined) {
    this._bodyIdleTimeoutMs = value;
  }

  get resetTimeoutOnStreamActivity(): boolean {
    return this._resetTimeoutOnStreamActivity;
  }

  set resetTimeoutOnStreamActivity(value: boolean) {
    this._resetTimeoutOnStreamActivity = value;
  }

  get status(): number {
    return this._raw!.status;
  }

  get headers(): Headers {
    return this._raw!.headers;
  }

  static initial(): CustomResponse {
    return new CustomResponse();
  }

  async json<T>(map?: (json: unknown) => T): Promise<T> {
    const decoded = decodeResponseBody(await this.readText(), this._operation);
    return map ? map(decoded) : (decoded as T);
  }

  bytes(): Promise<Uint8Array> {
    return this.readBody();
  }

  protected readBody(): Promise<Uint8Array> {
    return readBoundedResponseBody(this._raw!, this._maxBytes, this._operation);
  }

  protected async readText(): Promise<string> {
    return new TextDecoder().decode(await this.readBody());
  }

  async *sse(): AsyncGenerator<SseEvent> {
    yield* streamSse(this._raw!, this._operation, {
      firstPayloadTimeoutMs: this._firstPayloadTimeoutMs,
      bodyIdleTimeoutMs: this._bodyIdleTimeoutMs,
      resetTimeoutOnStreamActivity: this._resetTimeoutOnStreamActivity,
    });
  }
}
