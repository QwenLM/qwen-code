/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assertManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';
import {
  HostedHarnessProcess,
  waitUntil,
} from '../helpers/hosted-harness-process.js';
import { startHostedSessionStore } from '../helpers/hosted-session-store.js';
import { debugLog, loopEnv, mode, saveEvidence } from './evidence.js';

type TranscriptEvent = {
  type: string;
  promptId?: string;
  data?: {
    stopReason?: string;
    update?: { content?: { text?: string } };
  };
};

let cli: HostedHarnessProcess | undefined;
let model: FakeOpenAIServer | undefined;
let store: Awaited<ReturnType<typeof startHostedSessionStore>> | undefined;
let sessionId = '';
let clientId = '';
let transcriptEvidence: unknown;
let durableResult: string | undefined;
let passed = false;

async function json<T>(
  route: string,
  body?: unknown,
  expected = 200,
): Promise<T> {
  const response = await cli!.request(route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...cli!.headers(clientId), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  expect(response.status, text).toBe(expected);
  return (text ? JSON.parse(text) : undefined) as T;
}

afterEach(async () => {
  try {
    await saveEvidence('hosted-agent-core', {
      status: passed ? 'pass' : 'fail',
      output: cli?.output,
      requests: model?.requests,
      transcript: transcriptEvidence,
      durable: store ? await store.scan() : undefined,
      durableResult,
      debug: cli?.root ? await debugLog(path.join(cli.root, 'runtime')) : '',
    });
  } finally {
    try {
      await cli?.close();
    } finally {
      try {
        await store?.close();
      } finally {
        await model?.close();
      }
    }
  }
});

it(`Hosted workflow_launch executes agent() on the ${mode} loop`, async () => {
  sessionId = randomUUID();
  const parentSessionId = randomUUID();
  const sentinel = `HOSTED_SUBAGENT_${randomUUID()}`;
  model = await startFakeOpenAIServer(() => ({
    content: sentinel,
  }));
  cli = await new HostedHarnessProcess().start(model.baseUrl, { env: loopEnv });
  store = await startHostedSessionStore(sessionId);

  const connection = {
    baseUrl: store.baseUrl,
    tenantId: 'tenant',
    workspaceId: 'workspace',
    writerId: cli.bootId,
    leaseDurationMs: 60_000,
  };
  const created = await json<{ sessionId: string; clientId: string }>(
    '/session',
    {
      sessionId,
      sessionScope: 'thread',
      managedSessionStore: connection,
      lineage: {
        parentSessionId,
        rootSessionId: parentSessionId,
        parentChildRunId: 'run-1',
        depth: 1,
      },
    },
  );
  expect(created.sessionId).toBe(sessionId);
  clientId = created.clientId;

  const script =
    'const answer = await agent("Complete the managed loop probe."); return { answer };';
  const prompt = [
    {
      type: 'workflow_launch',
      definition: {
        definitionId: 'workflow/managed-loop',
        definitionRevision: 1,
        definitionDigest: createHash('sha256')
          .update(script, 'utf8')
          .digest('hex'),
      },
      script,
    },
  ];
  const promptId = randomUUID();
  const body = {
    prompt,
    promptId,
    payloadDigest: `sha256:${createHash('sha256')
      .update(JSON.stringify(prompt))
      .digest('hex')}`,
  };
  const submitted = await json<{ promptId: string }>(
    `/session/${sessionId}/prompt`,
    body,
    202,
  );
  expect(submitted.promptId).toBe(promptId);

  await waitUntil(async () => {
    const status = await json<{ hasActivePrompt: boolean }>(
      `/session/${sessionId}/status`,
    );
    return status.hasActivePrompt === false;
  }, 60_000);

  const transcript = await json<{ events: TranscriptEvent[] }>(
    `/session/${sessionId}/transcript?cursor=0&limit=256`,
  );
  transcriptEvidence = transcript;
  const visible = transcript.events.filter(
    (event) => event.promptId === promptId,
  );
  // The turn-scoped spine here is two events, not three. A `workflow_launch`
  // run result is committed as one message that never streamed as deltas, so
  // it projects as a single `session_update` chunk rather than as the
  // `managed_journal_event` a streamed message produces. The transcript's
  // other entries are the projector's `managed_journal_event` fallback for
  // journal kinds with no dedicated projection (activation.changed,
  // input.accepted, wake.requested, both checkpoints and the user-message
  // commit); that fallback returns `{ sessionId }` only — by design it carries
  // no `promptId` — so filtering on `promptId` cannot see them.
  expect(visible.map((event) => event.type)).toEqual([
    'session_update',
    'turn_complete',
  ]);
  expect(visible[0]?.data?.update?.content?.text).toContain(sentinel);
  expect(visible[1]?.data?.stopReason).toBe('end_turn');

  const committed = (await store.scan()).events;
  const settled = committed.find(
    (event) =>
      event.kind === 'turn.settled' && event.payload['turnId'] === promptId,
  );
  expect(settled).toMatchObject({
    kind: 'turn.settled',
    payload: {
      turnId: promptId,
      outcome: 'completed',
      stopReason: 'end_turn',
    },
  });
  // Narrow through the module's own validator: `payload` is a JSON value map,
  // so asserting the ref's shape directly neither compiles (it does not
  // overlap `ManagedSessionDurableRef`) nor would it check `resourceId` or
  // `digest` against the bytes read back below.
  const resultRef = assertManagedSessionDurableRef(
    settled?.payload['resultRef'],
    'turn.settled resultRef',
  );
  // `turn.settled` carries the turn *record* (`managed-session-record-sink`'s
  // `commitTurnSettled` publishes the `turn_result` record: promptId, state,
  // stopReason, endedAt), not the answer text. The answer's durable home is
  // the assistant message commit, so read the text from there and keep the
  // turn record as the settlement witness it is.
  expect(resultRef.kind).toBe('managed-turn-result');
  const assistantMessage = committed.find(
    (event) =>
      event.kind === 'message.committed' &&
      event.payload['role'] === 'assistant',
  );
  const answerRef = assertManagedSessionDurableRef(
    assistantMessage?.payload['contentRef'],
    'message.committed contentRef',
  );
  durableResult = Buffer.from(await store.readResource(answerRef)).toString(
    'utf8',
  );
  expect(durableResult).toContain(sentinel);
  expect(store.failures).toEqual([]);

  const requests = model.requests.filter(
    ({ body: request }) => request['stream'] === true,
  );
  expect(requests).toHaveLength(1);
  const request = requests[0]!.body;
  const tools = request['tools'];
  expect(
    tools === undefined ||
      tools === null ||
      (Array.isArray(tools) && tools.length === 0),
  ).toBe(true);
  expect(JSON.stringify(request['messages'])).toContain(
    'Complete the managed loop probe.',
  );

  const loopMarker =
    /\[AgentCore\] subagent .* round .* on the shared agent loop[^\n]*/;
  let executedLoop = '';
  await waitUntil(async () => {
    const debug = await debugLog(path.join(cli!.root, 'runtime'));
    executedLoop = debug.match(loopMarker)?.[0] ?? '';
    return executedLoop !== '';
  });
  if (mode === 'kernel') expect(executedLoop).toContain('on the event bus');
  else expect(executedLoop).not.toContain('on the event bus');

  passed = true;
});
