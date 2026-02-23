/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createWebRequestRecorder,
  mergeCapturedResponses,
  mergeDebuggerRequests,
  standardizeNetworkCapture,
} from '../network-capture-utils.ts';

test('createWebRequestRecorder filters static types when includeStatic=false', () => {
  const recorder = createWebRequestRecorder({ includeStatic: false });

  recorder.recordBeforeRequest({
    requestId: '1',
    url: 'https://example.com/api',
    method: 'GET',
    type: 'xmlhttprequest',
    timeStamp: 1,
  });

  recorder.recordBeforeRequest({
    requestId: '2',
    url: 'https://example.com/image.png',
    method: 'GET',
    type: 'image',
    timeStamp: 2,
  });

  const requests = recorder.getRequests();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].requestId, '1');
});

test('createWebRequestRecorder captures response headers and status', () => {
  const recorder = createWebRequestRecorder({ includeStatic: true });

  recorder.recordBeforeRequest({
    requestId: 'a',
    url: 'https://example.com/api',
    method: 'POST',
    type: 'fetch',
    timeStamp: 1,
  });

  recorder.recordCompleted({
    requestId: 'a',
    statusCode: 200,
    statusLine: 'HTTP/1.1 200 OK',
    responseHeaders: [{ name: 'content-type', value: 'application/json' }],
    type: 'fetch',
    timeStamp: 2,
  });

  const requests = recorder.getRequests();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].status, 200);
  assert.equal(requests[0].statusText, 'HTTP/1.1 200 OK');
  assert.equal(requests[0].responseHeaders['content-type'], 'application/json');
});

test('mergeCapturedResponses attaches body by url+method', () => {
  const requests = [
    { requestId: '1', url: 'https://example.com/api', method: 'GET' },
  ];
  const captured = [
    { url: 'https://example.com/api', method: 'GET', body: '{"ok":true}' },
  ];

  const merged = mergeCapturedResponses(requests, captured);
  assert.equal(merged[0].responseBody, '{"ok":true}');
});

test('mergeDebuggerRequests attaches debugger response body', () => {
  const requests = [
    { requestId: '1', url: 'https://example.com/api', method: 'GET' },
  ];
  const debuggerEntries = [
    {
      requestId: 'dbg-1',
      url: 'https://example.com/api',
      method: 'GET',
      responseBody: '{"debug":true}',
      responseBodyEncoding: 'utf-8',
    },
  ];

  const merged = mergeDebuggerRequests(requests, debuggerEntries);
  assert.equal(merged[0].responseBody, '{"debug":true}');
  assert.equal(merged[0].responseBodySource, 'debugger');
});

test('mergeDebuggerRequests appends unmatched debugger entries', () => {
  const requests = [
    { requestId: '1', url: 'https://example.com/api', method: 'GET' },
  ];
  const debuggerEntries = [
    { requestId: 'dbg-2', url: 'https://example.com/other', method: 'POST' },
  ];

  const merged = mergeDebuggerRequests(requests, debuggerEntries);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].url, 'https://example.com/other');
  assert.equal(merged[1].source.request, 'debugger');
});

test('standardizeNetworkCapture produces normalized structure', () => {
  const capture = standardizeNetworkCapture({
    tabId: 1,
    startedAt: 1000,
    endedAt: 2000,
    includeStatic: false,
    needResponseBody: true,
    requests: [
      {
        requestId: '1',
        url: 'https://example.com/api',
        method: 'GET',
        status: 200,
        responseBody: '{"ok":true}',
        responseBodyEncoding: 'utf-8',
      },
    ],
    websockets: [
      {
        requestId: 'ws-1',
        url: 'ws://example.com/socket',
        frames: [{ direction: 'received', opcode: 1, payload: 'hello' }],
      },
    ],
  });

  assert.equal(capture.version, '1.0');
  assert.equal(capture.requests.length, 1);
  assert.equal(capture.requests[0].response?.body?.text, '{"ok":true}');
  assert.equal(capture.websockets.length, 1);
  assert.equal(capture.stats.requestCount, 1);
  assert.equal(capture.stats.websocketCount, 1);
});

test('createWebRequestRecorder stores formData requestBody', () => {
  const recorder = createWebRequestRecorder({ includeStatic: true });

  recorder.recordBeforeRequest({
    requestId: 'form-1',
    url: 'https://example.com/form',
    method: 'POST',
    type: 'xmlhttprequest',
    timeStamp: 3,
    requestBody: {
      formData: {
        foo: ['bar'],
        baz: ['1', '2'],
      },
    },
  });

  const requests = recorder.getRequests();
  assert.deepEqual(requests[0].requestBody, {
    formData: {
      foo: ['bar'],
      baz: ['1', '2'],
    },
  });
});

test('createWebRequestRecorder stores raw requestBody', () => {
  const recorder = createWebRequestRecorder({ includeStatic: true });
  const encoder = new TextEncoder();
  const bytes = encoder.encode('hello=world');

  recorder.recordBeforeRequest({
    requestId: 'raw-1',
    url: 'https://example.com/raw',
    method: 'POST',
    type: 'fetch',
    timeStamp: 4,
    requestBody: {
      raw: [{ bytes }],
    },
  });

  const requests = recorder.getRequests();
  assert.equal(requests[0].requestBody.raw, 'hello=world');
  assert.equal(requests[0].requestBody.rawEncoding, 'utf-8');
});
