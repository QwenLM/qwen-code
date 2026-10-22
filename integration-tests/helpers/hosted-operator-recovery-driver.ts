/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fakeToolCall, startFakeOpenAIServer } from '../fake-openai-server.js';
import { HostedHarnessProcess, waitUntil } from './hosted-harness-process.js';

const config = JSON.parse(await readFile(process.argv[2], 'utf8')) as {
  tenantId: string;
  storeUrl: string;
  brokerUrl: string;
  statusGateUrl: string;
  sessions: Array<{
    sessionId: string;
    secondarySessionId: string;
    workspaceId: string;
    directory: string;
    toolProfile: string;
    fault: string;
  }>;
};
let current = config.sessions[0];
let modelCalls = 0;
let replacement = false;
const model = await startFakeOpenAIServer(({ body }) => {
  modelCalls++;
  const messages = body['messages'] as Array<{
    role: string;
    content: unknown;
  }>;
  const last = messages.findLastIndex((message) => message.role === 'user');
  if (messages.slice(last + 1).some((message) => message.role === 'tool'))
    return { content: 'RECOVERY_CONTROL_DONE' };
  if (replacement || current.fault === 'independent')
    return {
      toolCalls: [
        fakeToolCall('write_file', {
          file_path: replacement ? 'replacement.txt' : 'control.txt',
          content: 'available',
        }),
      ],
    };
  const escaped =
    current.fault === 'detached'
      ? "setsid sh -c 'echo $$ > escaped.pid; while :; do printf x >> escaped.txt; sleep 0.1; done' >/dev/null 2>&1 & "
      : '';
  return {
    toolCalls: [
      fakeToolCall(
        'run_shell_command',
        {
          command: `printf x >> once.txt; ${escaped}cd . && sleep 20 >/dev/null 2>&1 & echo ok`,
        },
        'partial-shell',
      ),
    ],
  };
});
const cli = new HostedHarnessProcess();
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
async function probe(phase: string) {
  const response = await fetch(
    new URL(
      `/operator-recovery/${current.sessionId}/${phase}`,
      config.statusGateUrl,
    ),
    {
      method: 'POST',
      signal: AbortSignal.timeout(90_000),
    },
  );
  const text = await response.text();
  assert.equal(response.status, 200, text);
  console.log(`OPERATOR_RECOVERY ${current.fault} ${phase} ${text}`);
}
try {
  await cli.start(model.baseUrl, {
    extraArgs: [
      '--managed-runtime-broker-url',
      config.brokerUrl,
      '--managed-runtime-broker-token',
      'hosted-tools-broker-token',
    ],
  });
  // The independent Workspace remains usable while both damaged Workspaces are fenced.
  for (const session of config.sessions) {
    current = session;
    const created = await json('/session', {
      sessionId: session.sessionId,
      sessionScope: 'thread',
      toolProfile: session.toolProfile,
      managedSessionStore: {
        baseUrl: config.storeUrl,
        tenantId: config.tenantId,
        workspaceId: session.workspaceId,
        writerId: cli.bootId,
        leaseDurationMs: 60_000,
      },
    });
    clientId = created.clientId;
    const blocks = [{ type: 'text', text: `RECOVERY_${session.fault}` }];
    await json(
      `/session/${session.sessionId}/prompt`,
      {
        promptId: randomUUID(),
        prompt: blocks,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(blocks)).digest('hex')}`,
      },
      202,
    );
    await waitUntil(
      async () =>
        !(await json(`/session/${session.sessionId}/status`)).hasActivePrompt,
      60_000,
    );
    const status = await json(`/session/${session.sessionId}/status`);
    assert.equal(
      status.recoveryBlocked,
      session.fault !== 'independent',
      cli.output,
    );
    if (session.fault === 'independent') {
      assert.equal(
        await readFile(path.join(session.directory, 'control.txt'), 'utf8'),
        'available',
      );
    } else {
      assert.equal(
        await readFile(path.join(session.directory, 'once.txt'), 'utf8'),
        'x',
      );
      await probe('prepare');
    }
  }
  const callsBeforeRecovery = modelCalls;
  for (const session of config.sessions.slice(0, 2)) {
    current = session;
    await probe('complete');
    assert.equal(
      await readFile(path.join(session.directory, 'once.txt'), 'utf8'),
      'x',
    );
  }
  assert.equal(
    modelCalls,
    callsBeforeRecovery,
    'Operator recovery must never replay inference or Shell',
  );
  replacement = true;
  for (const session of config.sessions.slice(0, 2)) {
    current = session;
    const created = await json('/session', {
      sessionId: session.secondarySessionId,
      sessionScope: 'thread',
      toolProfile: session.toolProfile,
      managedSessionStore: {
        baseUrl: config.storeUrl,
        tenantId: config.tenantId,
        workspaceId: session.workspaceId,
        writerId: cli.bootId,
        leaseDurationMs: 60_000,
      },
    });
    clientId = created.clientId;
    const blocks = [{ type: 'text', text: 'RECOVERY_NEW_SESSION' }];
    await json(
      `/session/${session.secondarySessionId}/prompt`,
      {
        promptId: randomUUID(),
        prompt: blocks,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(blocks)).digest('hex')}`,
      },
      202,
    );
    await waitUntil(
      async () =>
        !(await json(`/session/${session.secondarySessionId}/status`))
          .hasActivePrompt,
      60_000,
    );
    assert.equal(
      (await json(`/session/${session.secondarySessionId}/status`))
        .recoveryBlocked,
      false,
    );
    assert.equal(
      await readFile(path.join(session.directory, 'replacement.txt'), 'utf8'),
      'available',
    );
    assert.equal(
      await readFile(path.join(session.directory, 'once.txt'), 'utf8'),
      'x',
    );
  }
  console.log('HOSTED_OPERATOR_RECOVERY_OK');
} finally {
  await cli.close();
  await model.close();
}
