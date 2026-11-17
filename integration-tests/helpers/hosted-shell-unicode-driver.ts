/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import {
  fakeToolCall,
  startFakeOpenAIServer,
  type FakeOpenAIToolCall,
} from '../fake-openai-server.js';
import { HostedHarnessProcess, waitUntil } from './hosted-harness-process.js';
import { relayUpstream } from './hosted-relay-headers.js';

const config = JSON.parse(await readFile(process.argv[2], 'utf8')) as {
  tenantId: string;
  storeUrl: string;
  brokerUrl: string;
  secondarySessionId: string;
  sessions: Array<{
    sessionId: string;
    workspaceId: string;
    directory: string;
    toolProfile: string;
    fault: string;
  }>;
};
const controls: string[] = [];
const publications: string[] = [];
const proxy = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const payload = Buffer.concat(chunks);
    const brokerRequest = req.url!.startsWith('/internal/runtime-broker/');
    if (brokerRequest) controls.push(req.url!);
    if (req.url!.startsWith('/internal/managed-tool-publications/'))
      publications.push(req.url!);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (
        value !== undefined &&
        !['host', 'connection', 'content-length', 'transfer-encoding'].includes(
          name,
        )
      ) {
        headers[name] = Array.isArray(value) ? value.join(',') : value;
      }
    }
    const response = await fetch(
      new URL(req.url!, brokerRequest ? config.brokerUrl : config.storeUrl),
      {
        method: req.method,
        headers,
        ...(payload.length ? { body: payload } : {}),
        signal: AbortSignal.timeout(30_000),
      },
    );
    relayUpstream(res, response, Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.writeHead(503);
    res.end(String(error));
  }
});
await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
const address = proxy.address();
assert(address && typeof address !== 'string');

const validText = '中文😀é\\ud800';
let scenario: { field: string; value: string } | undefined;
let corrected = false;
let repairInTurn = false;
type Message = {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: FakeOpenAIToolCall[];
};
const refused = new Map<
  string,
  { call: FakeOpenAIToolCall; result?: Message }
>();
let correctedCallId = '';
const correction = () => {
  const file =
    sessionId === config.secondarySessionId
      ? 'unicode-secondary-ok.txt'
      : 'unicode-ok.txt';
  const call = fakeToolCall('run_shell_command', {
    command: "printf '%s' '中文😀é\\ud800' > " + file,
    description: validText,
  });
  correctedCallId = call.id;
  return { toolCalls: [call] };
};
const model = await startFakeOpenAIServer(({ body }) => {
  const messages = (body.messages ?? []) as Message[];
  const start = messages.findLastIndex((entry) => entry.role === 'user');
  const results = messages
    .slice(start + 1)
    .filter((entry) => entry.role === 'tool');
  if (results.length) {
    if (scenario) {
      assert.equal(
        results.length,
        repairInTurn && results.length === 3 ? 3 : 2,
      );
      for (const result of results.slice(0, 2)) {
        const snapshot = refused.get(result.tool_call_id!);
        assert(snapshot, 'Unexpected tool response');
        const call = messages
          .flatMap((entry) => entry.tool_calls ?? [])
          .find((entry) => entry.id === snapshot.call.id);
        assert.deepEqual(call, snapshot.call);
        snapshot.result = result;
      }
      assert.equal(results[0].tool_call_id, [...refused.keys()].at(-2));
      assert.equal(results[1].tool_call_id, [...refused.keys()].at(-1));
      assert.match(
        JSON.stringify(results[0].content),
        /unpaired UTF-16 surrogate/,
      );
      assert.match(JSON.stringify(results[1].content), /not executed/);
      if (repairInTurn && results.length === 2) return correction();
    }
    if (corrected || repairInTurn) {
      assert.equal(results.at(-1)!.tool_call_id, correctedCallId);
      assert.doesNotMatch(JSON.stringify(results.at(-1)!.content), /"error"/);
    }
    return { content: 'UNICODE_DONE' };
  }
  if (scenario) {
    const calls = [
      fakeToolCall('run_shell_command', {
        command: 'printf invalid > invalid.txt',
        [scenario.field]: scenario.value,
      }),
      fakeToolCall('write_file', {
        file_path: 'sibling.txt',
        content: 'must not execute',
      }),
    ];
    for (const call of calls) refused.set(call.id, { call });
    return { toolCalls: calls };
  }
  if (corrected) return correction();
  for (const snapshot of refused.values()) {
    assert(snapshot.result, 'Missing paired refusal');
    const call = messages
      .flatMap((entry) => entry.tool_calls ?? [])
      .find((entry) => entry.id === snapshot.call.id);
    assert.deepEqual(
      call,
      snapshot.call,
      'Original arguments changed after reload',
    );
    const result = messages.find(
      (entry) => entry.tool_call_id === snapshot.call.id,
    );
    assert.deepEqual(
      result,
      snapshot.result,
      'Paired refusal changed after reload',
    );
  }
  return { content: 'HISTORY_RELOADED' };
});
const cli = new HostedHarnessProcess();
let sessionId = '';
let clientId = '';
async function json(route: string, body?: unknown, expected = 200) {
  const response = await cli.request(route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...cli.headers(clientId), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert.equal(response.status, expected, text);
  return text ? JSON.parse(text) : undefined;
}
async function prompt() {
  const promptId = randomUUID();
  const prompt = [{ type: 'text', text: 'UNICODE_' + promptId }];
  await json(
    '/session/' + sessionId + '/prompt',
    {
      promptId,
      prompt,
      payloadDigest:
        'sha256:' +
        createHash('sha256').update(JSON.stringify(prompt)).digest('hex'),
    },
    202,
  );
  let status;
  try {
    await waitUntil(async () => {
      status = await json('/session/' + sessionId + '/status');
      assert.equal(
        status.recoveryBlocked,
        false,
        JSON.stringify({ status, controls, output: cli.output }),
      );
      return !status.hasActivePrompt;
    }, 30_000);
  } catch (error) {
    console.error(
      JSON.stringify({
        scenario,
        status,
        controls,
        modelRequests: model.requests.length,
        output: cli.output,
      }),
    );
    throw error;
  }
  const transcript = await json(
    '/session/' + sessionId + '/transcript?cursor=0&limit=256',
  );
  assert(
    transcript.events.some(
      (event: { type: string; promptId?: string }) =>
        event.type === 'turn_complete' && event.promptId === promptId,
    ),
    JSON.stringify(transcript) + cli.output,
  );
}
try {
  const proxyUrl = 'http://127.0.0.1:' + address.port;
  await cli.start(model.baseUrl, {
    extraArgs: [
      '--managed-runtime-broker-url',
      proxyUrl,
      '--managed-runtime-broker-token',
      'hosted-tools-broker-token',
    ],
  });
  for (const session of config.sessions) {
    refused.clear();
    sessionId = session.sessionId;
    clientId = '';
    const connection = {
      baseUrl: proxyUrl,
      tenantId: config.tenantId,
      workspaceId: session.workspaceId,
      writerId: cli.bootId,
      leaseDurationMs: 60_000,
    };
    const profile = {
      managedSessionStore: connection,
      toolProfile: session.toolProfile,
      ...(session.fault === 'o2' ? { captureBytes: 1024 * 1024 } : {}),
    };
    clientId = (
      await json('/session', { sessionId, sessionScope: 'thread', ...profile })
    ).clientId;
    for (const field of ['command', 'description']) {
      for (const value of ['\ud800', '\udc00', '😀\ud800', '\udc00\ud800']) {
        scenario = { field, value };
        const before = controls.length;
        const publicationBefore = publications.length;
        await prompt();
        const newControls = controls.slice(before);
        assert(
          newControls.every((route) => route.endsWith('/runtimes:warm')),
          JSON.stringify(newControls),
        );
        assert.equal(
          publications.length,
          publicationBefore,
          JSON.stringify(publications),
        );
        await assert.rejects(
          access(path.join(session.directory, 'invalid.txt')),
        );
        await assert.rejects(
          access(path.join(session.directory, 'sibling.txt')),
        );
      }
    }
    scenario = undefined;
    await json('/session/' + sessionId + '/detach', {}, 204);
    clientId = (await json('/session/' + sessionId + '/load', profile))
      .clientId;
    await prompt();
    scenario = { field: 'command', value: '\ud800' };
    repairInTurn = true;
    await prompt();
    scenario = undefined;
    repairInTurn = false;
    assert.equal(
      await readFile(path.join(session.directory, 'unicode-ok.txt'), 'utf8'),
      validText,
    );
    await json('/session/' + sessionId + '/detach', {}, 204);
    clientId = (await json('/session/' + sessionId + '/load', profile))
      .clientId;
    await prompt();
    await json('/session/' + sessionId + '/detach', {}, 204);
    refused.clear();
    {
      sessionId = config.secondarySessionId;
      clientId = '';
      clientId = (
        await json('/session', {
          sessionId,
          sessionScope: 'thread',
          ...profile,
        })
      ).clientId;
      await assert.rejects(
        access(path.join(session.directory, 'unicode-secondary-ok.txt')),
      );
      corrected = true;
      await prompt();
      corrected = false;
      assert.equal(
        await readFile(
          path.join(session.directory, 'unicode-secondary-ok.txt'),
          'utf8',
        ),
        validText,
      );
      await json('/session/' + sessionId + '/detach', {}, 204);
    }
  }
  console.log(
    'HOSTED_SHELL_UNICODE_OK: ' +
      config.sessions.map((session) => session.fault).join(',') +
      ', 9 refusals per capture, durable reload, Unicode correction, second Session',
  );
} finally {
  await cli.close();
  await model.close();
  proxy.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    proxy.close((error) => (error ? reject(error) : resolve())),
  );
}
