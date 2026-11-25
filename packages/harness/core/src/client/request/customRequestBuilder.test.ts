/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  CustomRequest,
  type CreateCustomRequestOptions,
} from './customRequest.js';
import { CustomRequestBuilder } from './customRequestBuilder.js';

const url = 'https://provider.test/v1/messages?beta=1';

describe('CustomRequestBuilder', () => {
  it('默认构建 GET 非流式请求，完整 URL 原样保留', () => {
    const request = CustomRequestBuilder.builder().url(url).build();

    expect(request).toBeInstanceOf(CustomRequest);
    expect(request.url).toBe(url);
    expect(request.origin).toBe('https://provider.test');
    expect(request.protocol).toBe('http');
    expect(request.method).toBe('GET');
    expect(request.headers).toEqual({});
    expect(request.streamResponse).toBe(false);
    expect(request.body).toBeUndefined();
    expect(request.signal).toBeUndefined();
    expect(request.proxy).toBeUndefined();
    expect(request.ip).toBeUndefined();
  });

  it('缺少 URL 时拒绝构建', () => {
    expect(() => CustomRequestBuilder.builder().build()).toThrow(
      'CustomRequestBuilder',
    );
    expect(() => CustomRequestBuilder.builder().url('').build()).toThrow(
      'CustomRequestBuilder',
    );
  });

  it.each([
    ['get', 'GET'],
    ['post', 'POST'],
    ['put', 'PUT'],
    ['delete', 'DELETE'],
    ['patch', 'PATCH'],
  ] as const)('%s 设置 HTTP 方法并接受完整 URL', (verb, method) => {
    const request = CustomRequestBuilder.builder()[verb](url).build();
    expect(request.url).toBe(url);
    expect(request.method).toBe(method);
  });

  it('不传 URL 的方法调用保留已配置的 URL', () => {
    const request = CustomRequestBuilder.builder().url(url).post().build();
    expect(request.url).toBe(url);
    expect(request.method).toBe('POST');
  });

  it('链式选项与 CreateCustomRequestOptions 的直接构造结果一致', () => {
    const signal = new AbortController().signal;
    const options: CreateCustomRequestOptions = {
      url,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"model":"test"}',
      signal,
      proxy: 'http://proxy.test:8080',
      connectTimeoutMs: 0,
      responseHeadersTimeoutMs: 100,
      requestTimeoutMs: 200,
      bodyIdleTimeoutMs: 300,
      streamResponse: true,
    };
    const built = CustomRequestBuilder.builder()
      .url(url)
      .method(options.method)
      .headers(options.headers)
      .body(options.body!)
      .signal(signal)
      .proxy(options.proxy!)
      .connectTimeout(0)
      .responseHeadersTimeout(100)
      .timeout(200)
      .bodyIdleTimeout(300)
      .stream()
      .build();
    const direct = new CustomRequest(options);

    for (const field of Object.keys(options) as Array<
      keyof CreateCustomRequestOptions
    >) {
      expect(built[field]).toEqual(direct[field]);
    }
    expect(built.signal).toBe(signal);
    expect(built.body).toBe(options.body);
  });

  it('单个和批量标头设置均按大小写不敏感规则覆盖', () => {
    const request = CustomRequestBuilder.builder()
      .url(url)
      .headers({ Authorization: 'first', 'x-request-id': 'id' })
      .header('authorization', 'second')
      .headers({ AUTHORIZATION: 'third' })
      .build();

    expect(request.headers).toEqual({
      AUTHORIZATION: 'third',
      'x-request-id': 'id',
    });
  });

  it('输入标头、Builder 和各次构建的请求互不影响', () => {
    const headers = { 'x-request-id': 'original' };
    const builder = CustomRequestBuilder.builder().url(url).headers(headers);
    const first = builder.build();
    headers['x-request-id'] = 'caller';
    builder.header('x-request-id', 'builder');
    const second = builder.build();
    first.setHeader('x-request-id', 'request');
    first.setProxy('http://proxy.test:8080');

    expect(first.headers['x-request-id']).toBe('request');
    expect(second.headers['x-request-id']).toBe('builder');
    expect(builder.build().headers['x-request-id']).toBe('builder');
    expect(headers['x-request-id']).toBe('caller');
    expect(second.proxy).toBeUndefined();
  });

  it('可以清除调用方取消信号', () => {
    const request = CustomRequestBuilder.builder()
      .url(url)
      .signal(new AbortController().signal)
      .signal(undefined)
      .build();

    expect(request.signal).toBeUndefined();
  });
});
