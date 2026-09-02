/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished, test } from 'vitest';

import type { BridgeEvent } from '../bridge/index.js';
import {
  finalizeHarFromJournal,
  journalPathForHar,
  NetworkHarRecorder,
} from './network-har-recorder.js';

test('network recorder emits WebArena-compatible HAR request data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qwen-browser-use-har-'));
  onTestFinished(async () => await rm(root, { recursive: true, force: true }));
  const harPath = join(root, 'network.har');
  const recorder = new NetworkHarRecorder(harPath);

  recorder.record(
    networkEvent('Network.requestWillBeSent', {
      requestId: 'request-1',
      wallTime: 1_700_000_000,
      timestamp: 10,
      type: 'Fetch',
      request: {
        method: 'POST',
        url: 'http://example.test/api/items?page=2',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: 'session=secret',
          Authorization: 'Bearer secret',
          Referer: 'http://example.test/items',
        },
        postData: 'title=New+Item&enabled=1',
      },
    }),
  );
  recorder.record(
    networkEvent('Network.responseReceived', {
      requestId: 'request-1',
      timestamp: 10.125,
      response: {
        status: 201,
        statusText: 'Created',
        protocol: 'h2',
        mimeType: 'application/json',
        headers: {
          Location: '/api/items/7',
          'Set-Cookie': 'session=other-secret',
        },
      },
    }),
  );
  recorder.record(
    networkEvent('Network.loadingFinished', {
      requestId: 'request-1',
      timestamp: 10.25,
      encodedDataLength: 42,
    }),
  );
  await recorder.close();

  const har = JSON.parse(await readFile(harPath, 'utf8')) as {
    log: { entries: Array<Record<string, unknown>> };
  };
  assert.equal(har.log.entries.length, 1);
  const entry = har.log.entries[0] as {
    request: {
      method: string;
      url: string;
      headers: Array<{ name: string; value: string }>;
      queryString: Array<{ name: string; value: string }>;
      postData: { mimeType: string; text: string };
    };
    response: {
      status: number;
      httpVersion: string;
      headers: Array<{ name: string; value: string }>;
      content: { size: number };
    };
    time: number;
  };
  assert.equal(entry.request.method, 'POST');
  assert.equal(entry.request.postData.text, 'title=New+Item&enabled=1');
  assert.equal(
    entry.request.postData.mimeType,
    'application/x-www-form-urlencoded',
  );
  assert.deepEqual(entry.request.queryString, [{ name: 'page', value: '2' }]);
  assert.equal(
    entry.request.headers.find((header) => header.name === 'Cookie')?.value,
    '[REDACTED]',
  );
  assert.equal(
    entry.request.headers.find((header) => header.name === 'Authorization')
      ?.value,
    '[REDACTED]',
  );
  assert.equal(
    entry.request.headers.find((header) => header.name === 'Referer')?.value,
    'http://example.test/items',
  );
  assert.equal(
    entry.response.headers.find((header) => header.name === 'Set-Cookie')
      ?.value,
    '[REDACTED]',
  );
  assert.equal(entry.response.status, 201);
  assert.equal(entry.response.httpVersion, 'HTTP/2.0');
  assert.equal(entry.response.content.size, 42);
  assert.equal(entry.time, 250);
  assert.ok(
    (await readFile(journalPathForHar(harPath), 'utf8')).includes(
      'Network.requestWillBeSent',
    ),
  );
});

test('network recorder orders same-endpoint requests by start when they finish out of order', async () => {
  const root = await mkdtemp(
    join(tmpdir(), 'qwen-browser-use-har-start-order-'),
  );
  onTestFinished(async () => await rm(root, { recursive: true, force: true }));
  const harPath = join(root, 'network.har');
  const recorder = new NetworkHarRecorder(harPath);

  recorder.record(
    networkEvent('Network.requestWillBeSent', {
      requestId: 'save-first',
      wallTime: 1_700_000_000,
      timestamp: 10,
      request: {
        method: 'POST',
        url: 'http://example.test/-/profile',
        headers: {},
      },
    }),
  );
  recorder.record(
    networkEvent('Network.requestWillBeSent', {
      requestId: 'save-last',
      wallTime: 1_700_000_000.001,
      timestamp: 10.001,
      request: {
        method: 'POST',
        url: 'http://example.test/-/profile',
        headers: {},
      },
    }),
  );
  recorder.record(
    networkEvent('Network.responseReceived', {
      requestId: 'save-last',
      timestamp: 10.05,
      response: {
        status: 302,
        statusText: 'Found',
        mimeType: 'text/html',
        headers: {},
      },
    }),
  );
  recorder.record(
    networkEvent('Network.loadingFinished', {
      requestId: 'save-last',
      timestamp: 10.1,
      encodedDataLength: 0,
    }),
  );
  recorder.record(
    networkEvent('Network.responseReceived', {
      requestId: 'save-first',
      timestamp: 10.15,
      response: {
        status: 200,
        statusText: 'OK',
        mimeType: 'application/json',
        headers: {},
      },
    }),
  );
  recorder.record(
    networkEvent('Network.loadingFinished', {
      requestId: 'save-first',
      timestamp: 10.2,
      encodedDataLength: 2,
    }),
  );
  await recorder.close();

  const har = JSON.parse(await readFile(harPath, 'utf8')) as {
    log: {
      entries: Array<{
        request: { method: string; url: string };
        response: { status: number };
        _qwenBrowser: { requestId: string };
      }>;
    };
  };
  assert.deepEqual(
    har.log.entries.map((entry) => [
      entry._qwenBrowser.requestId,
      entry.response.status,
    ]),
    [
      ['save-first', 200],
      ['save-last', 302],
    ],
  );
  assert.equal(har.log.entries.at(-1)?.request.method, 'POST');
  assert.equal(
    har.log.entries.at(-1)?.request.url,
    'http://example.test/-/profile',
  );
});

test('network recorder embeds bounded JSON XHR response bodies', async () => {
  const root = await mkdtemp(
    join(tmpdir(), 'qwen-browser-use-har-response-body-'),
  );
  onTestFinished(async () => await rm(root, { recursive: true, force: true }));
  const harPath = join(root, 'network.har');
  const recorder = new NetworkHarRecorder(harPath);

  recorder.record(
    networkEvent('Network.requestWillBeSent', {
      requestId: 'json-xhr',
      wallTime: 1_700_000_000,
      timestamp: 10,
      request: {
        method: 'POST',
        url: 'http://example.test/toggle.json',
        headers: {},
      },
    }),
  );
  recorder.record(
    networkEvent('Network.responseReceived', {
      requestId: 'json-xhr',
      timestamp: 10.1,
      type: 'XHR',
      response: {
        status: 200,
        statusText: 'OK',
        mimeType: 'application/json',
        headers: {},
      },
    }),
  );
  const request = recorder.record(
    networkEvent('Network.loadingFinished', {
      requestId: 'json-xhr',
      timestamp: 10.2,
      encodedDataLength: 24,
    }),
  );
  assert.deepEqual(request, { requestId: 'json-xhr', tabId: 17 });
  assert.equal(
    recorder.recordResponseBody(request!, {
      body: '{"star_count":56}',
      base64Encoded: false,
    }),
    true,
  );
  await recorder.close();

  const har = JSON.parse(await readFile(harPath, 'utf8')) as {
    log: {
      entries: Array<{
        response: {
          bodySize: number;
          content: { size: number; mimeType: string; text: string };
        };
      }>;
    };
  };
  assert.equal(har.log.entries[0]?.response.bodySize, 24);
  assert.deepEqual(har.log.entries[0]?.response.content, {
    size: 17,
    mimeType: 'application/json',
    text: '{"star_count":56}',
  });
});

test('network journal can reconstruct a received response after an interrupted process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qwen-browser-use-har-recovery-'));
  onTestFinished(async () => await rm(root, { recursive: true, force: true }));
  const harPath = join(root, 'network.har');
  const recorder = new NetworkHarRecorder(harPath);
  recorder.record(
    networkEvent('Network.requestWillBeSent', {
      requestId: 'request-2',
      wallTime: 1_700_000_001,
      timestamp: 20,
      request: { method: 'GET', url: 'http://example.test/', headers: {} },
    }),
  );
  recorder.record(
    networkEvent('Network.responseReceived', {
      requestId: 'request-2',
      timestamp: 20.1,
      response: {
        status: 200,
        statusText: 'OK',
        mimeType: 'text/html',
        headers: {},
      },
    }),
  );

  await recorder.flush();
  const summary = finalizeHarFromJournal(harPath);
  assert.deepEqual(summary, {
    entries: 1,
    journalEvents: 2,
    truncatedEvents: 0,
  });
  const har = JSON.parse(await readFile(harPath, 'utf8')) as {
    log: {
      entries: Array<{
        time: number;
        timings: { wait: number; receive: number };
      }>;
    };
  };
  assert.equal(har.log.entries.length, 1);
  assert.equal(har.log.entries[0]?.time, 100);
  assert.deepEqual(har.log.entries[0]?.timings, {
    send: 0,
    wait: 100,
    receive: 0,
  });
  await recorder.close();
});

test('network recorder reports asynchronous journal failures without an unhandled stream error', async () => {
  const root = await mkdtemp(
    join(tmpdir(), 'qwen-browser-use-har-stream-error-'),
  );
  onTestFinished(async () => await rm(root, { recursive: true, force: true }));
  const recorder = new NetworkHarRecorder(join(root, 'network.har'));
  const stream = (
    recorder as unknown as {
      stream: NodeJS.WritableStream & { destroy(error?: Error): void };
    }
  ).stream;
  const closed = new Promise<void>((resolve) => stream.once('close', resolve));

  stream.destroy(new Error('simulated journal failure'));
  await closed;

  await assert.rejects(recorder.flush(), /simulated journal failure/);
  await assert.rejects(recorder.close(), /simulated journal failure/);
});

test('network recorder leaves pending speculative requests in the journal only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qwen-browser-use-har-pending-'));
  onTestFinished(async () => await rm(root, { recursive: true, force: true }));
  const harPath = join(root, 'network.har');
  const recorder = new NetworkHarRecorder(harPath);

  recorder.record(
    networkEvent('Network.requestWillBeSent', {
      requestId: 'navigation-complete',
      wallTime: 1_700_000_001,
      timestamp: 20,
      request: {
        method: 'GET',
        url: 'http://example.test/dashboard/todos',
        headers: {},
      },
    }),
  );
  recorder.record(
    networkEvent('Network.responseReceived', {
      requestId: 'navigation-complete',
      timestamp: 20.1,
      response: {
        status: 200,
        statusText: 'OK',
        mimeType: 'text/html',
        headers: {},
      },
    }),
  );
  recorder.record(
    networkEvent('Network.loadingFinished', {
      requestId: 'navigation-complete',
      timestamp: 20.2,
      encodedDataLength: 100,
    }),
  );
  recorder.record(
    networkEvent('Network.requestWillBeSent', {
      requestId: 'pending-prefetch',
      wallTime: 1_700_000_001.3,
      timestamp: 20.3,
      type: 'Other',
      request: {
        method: 'GET',
        url: 'http://example.test/dashboard/todos',
        headers: { Accept: 'text/html', 'Sec-Purpose': 'prefetch' },
      },
    }),
  );
  await recorder.close();

  const har = JSON.parse(await readFile(harPath, 'utf8')) as {
    log: { entries: Array<{ response: { status: number } }> };
  };
  assert.deepEqual(
    har.log.entries.map((entry) => entry.response.status),
    [200],
  );
  const journal = await readFile(journalPathForHar(harPath), 'utf8');
  assert.match(journal, /pending-prefetch/);
});

test('network recorder bounds queued journal data and records truncation metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qwen-browser-use-har-bounded-'));
  onTestFinished(async () => await rm(root, { recursive: true, force: true }));
  const harPath = join(root, 'network.har');
  const recorder = new NetworkHarRecorder(harPath, {
    maxJournalBytes: 256,
    maxBufferedBytes: 256,
  });

  for (let index = 0; index < 20; index += 1) {
    recorder.record(
      networkEvent('Network.requestWillBeSent', {
        requestId: `request-${index}`,
        request: {
          method: 'GET',
          url: `http://example.test/${index}`,
          headers: {},
        },
      }),
    );
  }
  await recorder.close();

  const journal = await readFile(journalPathForHar(harPath), 'utf8');
  assert.match(journal, /"type":"metadata","truncatedEvents":\d+/);
  assert.ok(finalizeHarFromJournal(harPath).truncatedEvents > 0);
  assert.ok(
    Buffer.byteLength(journal) < 1_024,
    'bounded journal should not retain the rejected event payloads',
  );
});

test('journal recovery ignores a torn final write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qwen-browser-use-har-torn-'));
  onTestFinished(async () => await rm(root, { recursive: true, force: true }));
  const harPath = join(root, 'network.har');
  const recorder = new NetworkHarRecorder(harPath);
  recorder.record(
    networkEvent('Network.requestWillBeSent', {
      requestId: 'complete-before-crash',
      request: {
        method: 'GET',
        url: 'http://example.test/complete',
        headers: {},
      },
    }),
  );
  recorder.record(
    networkEvent('Network.responseReceived', {
      requestId: 'complete-before-crash',
      timestamp: 1,
      response: { status: 200, statusText: 'OK', headers: {} },
    }),
  );
  await recorder.flush();
  await appendFile(journalPathForHar(harPath), '{"recordedAt":"torn"');

  assert.deepEqual(finalizeHarFromJournal(harPath), {
    entries: 1,
    journalEvents: 2,
    truncatedEvents: 0,
  });
  await recorder.close();
});

test('network recorder merges navigation headers from request extra info', async () => {
  const root = await mkdtemp(
    join(tmpdir(), 'qwen-browser-use-har-extra-info-'),
  );
  onTestFinished(async () => await rm(root, { recursive: true, force: true }));
  const harPath = join(root, 'network.har');
  const recorder = new NetworkHarRecorder(harPath);

  recorder.record(
    networkEvent('Network.requestWillBeSent', {
      requestId: 'navigation-1',
      wallTime: 1_700_000_002,
      timestamp: 30,
      type: 'Document',
      request: {
        method: 'GET',
        url: 'http://example.test/dashboard/todos',
        headers: { 'User-Agent': 'test-browser', Cookie: 'session=secret' },
      },
    }),
  );
  recorder.record(
    networkEvent('Network.requestWillBeSentExtraInfo', {
      requestId: 'navigation-1',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        Cookie: 'session=new-secret',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-User': '?1',
      },
    }),
  );
  recorder.record(
    networkEvent('Network.responseReceived', {
      requestId: 'navigation-1',
      timestamp: 30.1,
      response: {
        status: 200,
        statusText: 'OK',
        mimeType: 'text/html',
        headers: {},
      },
    }),
  );
  recorder.record(
    networkEvent('Network.loadingFinished', {
      requestId: 'navigation-1',
      timestamp: 30.2,
      encodedDataLength: 100,
    }),
  );
  await recorder.close();

  const har = JSON.parse(await readFile(harPath, 'utf8')) as {
    log: {
      entries: Array<{
        request: { headers: Array<{ name: string; value: string }> };
      }>;
    };
  };
  const headers = har.log.entries[0]?.request.headers ?? [];
  assert.equal(header(headers, 'accept'), 'text/html,application/xhtml+xml');
  assert.equal(header(headers, 'sec-fetch-dest'), 'document');
  assert.equal(header(headers, 'sec-fetch-mode'), 'navigate');
  assert.equal(header(headers, 'sec-fetch-user'), '?1');
  assert.equal(header(headers, 'cookie'), '[REDACTED]');
});

test('network recorder matches out-of-order extra info to redirect request segments', async () => {
  const root = await mkdtemp(
    join(tmpdir(), 'qwen-browser-use-har-extra-info-redirect-'),
  );
  onTestFinished(async () => await rm(root, { recursive: true, force: true }));
  const harPath = join(root, 'network.har');
  const recorder = new NetworkHarRecorder(harPath);

  recorder.record(
    networkEvent('Network.requestWillBeSentExtraInfo', {
      requestId: 'redirect-1',
      headers: { Accept: 'text/html', 'X-Request-Segment': 'initial' },
    }),
  );
  recorder.record(
    networkEvent('Network.requestWillBeSent', {
      requestId: 'redirect-1',
      wallTime: 1_700_000_003,
      timestamp: 40,
      type: 'Document',
      request: { method: 'GET', url: 'http://example.test/old', headers: {} },
    }),
  );
  recorder.record(
    networkEvent('Network.requestWillBeSentExtraInfo', {
      requestId: 'redirect-1',
      headers: { Accept: 'text/html', 'X-Request-Segment': 'redirected' },
    }),
  );
  recorder.record(
    networkEvent('Network.requestWillBeSent', {
      requestId: 'redirect-1',
      wallTime: 1_700_000_003.1,
      timestamp: 40.1,
      type: 'Document',
      redirectResponse: {
        status: 302,
        statusText: 'Found',
        headers: { Location: 'http://example.test/new' },
      },
      request: { method: 'GET', url: 'http://example.test/new', headers: {} },
    }),
  );
  recorder.record(
    networkEvent('Network.responseReceived', {
      requestId: 'redirect-1',
      timestamp: 40.2,
      response: {
        status: 200,
        statusText: 'OK',
        mimeType: 'text/html',
        headers: {},
      },
    }),
  );
  recorder.record(
    networkEvent('Network.loadingFinished', {
      requestId: 'redirect-1',
      timestamp: 40.3,
      encodedDataLength: 100,
    }),
  );
  await recorder.close();

  const har = JSON.parse(await readFile(harPath, 'utf8')) as {
    log: {
      entries: Array<{
        request: {
          url: string;
          headers: Array<{ name: string; value: string }>;
        };
      }>;
    };
  };
  assert.equal(har.log.entries.length, 2);
  assert.equal(har.log.entries[0]?.request.url, 'http://example.test/old');
  assert.equal(
    header(har.log.entries[0]?.request.headers ?? [], 'x-request-segment'),
    'initial',
  );
  assert.equal(har.log.entries[1]?.request.url, 'http://example.test/new');
  assert.equal(
    header(har.log.entries[1]?.request.headers ?? [], 'x-request-segment'),
    'redirected',
  );
});

function header(
  headers: Array<{ name: string; value: string }>,
  name: string,
): string | undefined {
  return headers.find((item) => item.name.toLowerCase() === name)?.value;
}

function networkEvent(
  method: string,
  params: Record<string, unknown>,
): BridgeEvent {
  return { type: 'event', tabId: 17, method, params };
}
