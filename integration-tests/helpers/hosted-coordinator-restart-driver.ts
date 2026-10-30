/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { readFile, rename, writeFile } from 'node:fs/promises';
import {
  createServer,
  request as createRequest,
  type ServerResponse,
} from 'node:http';
import { HostedHarnessProcess } from './hosted-harness-process.js';

const configPath = process.argv[2];
const config = JSON.parse(await readFile(configPath, 'utf8')) as {
  readyPath: string;
};

let primaryRequests = 0;
let followupRequests = 0;
let loadResponses = 0;
let firstChunk = false;
let released = false;
let releasePrimary!: () => void;
const primaryGate = new Promise<void>((resolve) => {
  releasePrimary = resolve;
});
let stop!: () => void;
const stopped = new Promise<void>((resolve) => {
  stop = resolve;
});

function writeEvent(response: ServerResponse, value: unknown) {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function chunk(content: string, finishReason: string | null = null) {
  return {
    id: 'coordinator-restart-fixture',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'hosted-fixture',
    choices: [
      {
        index: 0,
        delta: content ? { role: 'assistant', content } : {},
        finish_reason: finishReason,
      },
    ],
  };
}

const model = createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/chat/completions');
    const body: Buffer[] = [];
    for await (const part of request) body.push(Buffer.from(part));
    const parsed = JSON.parse(Buffer.concat(body).toString()) as {
      messages?: unknown;
    };
    const history = JSON.stringify(parsed.messages ?? []);
    const followup = history.includes('FOLLOW_UP');
    if (followup) followupRequests++;
    else primaryRequests++;
    assert.equal(followup ? followupRequests : primaryRequests, 1, history);

    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    if (followup) {
      writeEvent(response, chunk('FOLLOW_UP_OK'));
    } else {
      writeEvent(response, chunk('RESTART_'));
      firstChunk = true;
      await primaryGate;
      writeEvent(response, chunk('OK'));
    }
    writeEvent(response, chunk('', 'stop'));
    response.end('data: [DONE]\n\n');
  } catch (error) {
    response.destroy(error as Error);
  }
});
await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
const modelAddress = model.address();
assert(modelAddress && typeof modelAddress !== 'string');

const harness = new HostedHarnessProcess();
let harnessProxy: ReturnType<typeof createServer> | undefined;
let control: ReturnType<typeof createServer> | undefined;
try {
  await harness.start(`http://127.0.0.1:${modelAddress.port}/v1`);
  harnessProxy = createServer((request, response) => {
    const target = new URL(request.url ?? '/', harness.baseUrl);
    const upstream = createRequest(
      target,
      {
        method: request.method,
        headers: { ...request.headers, host: target.host },
      },
      (upstreamResponse) => {
        if (
          request.method === 'POST' &&
          target.pathname.endsWith('/load') &&
          upstreamResponse.statusCode === 200
        ) {
          loadResponses++;
        }
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.headers,
        );
        upstreamResponse.pipe(response);
      },
    );
    upstream.on('error', (error) => response.destroy(error));
    request.pipe(upstream);
  });
  await new Promise<void>((resolve) =>
    harnessProxy!.listen(0, '127.0.0.1', resolve),
  );
  const harnessProxyAddress = harnessProxy.address();
  assert(harnessProxyAddress && typeof harnessProxyAddress !== 'string');
  control = createServer((request, response) => {
    const state = {
      primaryRequests,
      followupRequests,
      loadResponses,
      firstChunk,
      released,
      harnessAlive:
        harness.child?.exitCode === null && harness.child.signalCode === null,
    };
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && request.url === '/state') {
      response.end(JSON.stringify(state));
      return;
    }
    if (request.method === 'POST' && request.url === '/release') {
      if (!released) {
        released = true;
        releasePrimary();
      }
      response.end(JSON.stringify({ ...state, released: true }));
      return;
    }
    if (request.method === 'POST' && request.url === '/stop') {
      if (!released) releasePrimary();
      response.end(JSON.stringify(state));
      stop();
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise<void>((resolve) =>
    control!.listen(0, '127.0.0.1', resolve),
  );
  const controlAddress = control.address();
  assert(controlAddress && typeof controlAddress !== 'string');
  const temporary = `${config.readyPath}.tmp`;
  await writeFile(
    temporary,
    JSON.stringify({
      harnessUrl: `http://127.0.0.1:${harnessProxyAddress.port}`,
      controlUrl: `http://127.0.0.1:${controlAddress.port}`,
    }),
  );
  await rename(temporary, config.readyPath);
  await stopped;
} finally {
  if (harnessProxy?.listening) {
    harnessProxy.closeAllConnections();
    await new Promise<void>((resolve) => harnessProxy!.close(() => resolve()));
  }
  await harness.close();
  model.closeAllConnections();
  await new Promise<void>((resolve) => model.close(() => resolve()));
  if (control?.listening) {
    control.closeAllConnections();
    await new Promise<void>((resolve) => control!.close(() => resolve()));
  }
}
