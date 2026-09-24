/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  enrollAgentHost,
  getThreadsDir,
  heartbeatAgentHost,
  issueAgentHostEnrollment,
} from '@qwen-code/qwen-code-core/agents/workspace-agents/store.js';
import {
  publishAgentEvent,
  subscribeAgentEvents,
  type AgentLiveEvent,
} from './agent-events.js';

let runtimeDir: string;

beforeEach(async () => {
  runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-events-'));
  vi.stubEnv('QWEN_RUNTIME_DIR', runtimeDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(runtimeDir, { recursive: true, force: true });
});

it('announces writes to a thread file once, naming the thread', async () => {
  const workspace = path.join(runtimeDir, 'project');
  const events: AgentLiveEvent[] = [];
  const stop = await subscribeAgentEvents(workspace, (event) =>
    events.push(event),
  );
  try {
    const file = path.join(getThreadsDir(workspace), 'th_1.json');
    await fs.writeFile(file, '{}');
    await fs.writeFile(file, '{"a":1}');
    await vi.waitFor(
      () =>
        expect(events).toContainEqual({ type: 'changed', threadId: 'th_1' }),
      { timeout: 3_000 },
    );
    expect(events).toHaveLength(1);
  } finally {
    stop();
  }
});

it('announces a runtime coming online, not each of its heartbeats', async () => {
  const workspace = path.join(runtimeDir, 'project');
  const events: AgentLiveEvent[] = [];
  const stop = await subscribeAgentEvents(workspace, (event) =>
    events.push(event),
  );
  try {
    const { token } = await issueAgentHostEnrollment(workspace);
    const input = { workspaceCwd: '/remote', providers: ['Qwen Code ACP'] };
    const { host, secret } = await enrollAgentHost(workspace, {
      token,
      name: 'laptop',
      ...input,
    });
    await heartbeatAgentHost(workspace, host.id, secret, input);
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'changed' }), {
      timeout: 3_000,
    });
    events.length = 0;
    await heartbeatAgentHost(workspace, host.id, secret, input);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(events).toEqual([]);
  } finally {
    stop();
  }
});

it('delivers progress to that workspace’s subscribers until they leave', async () => {
  const seen: AgentLiveEvent[] = [];
  const workspace = path.join(runtimeDir, 'a');
  const stop = await subscribeAgentEvents(workspace, (event) =>
    seen.push(event),
  );
  const progress: AgentLiveEvent = {
    type: 'progress',
    threadId: 'th_1',
    runId: 'run_1',
    attempt: 1,
    sessionId: 's',
    stage: 'responding',
    detail: '',
    outputText: 'hello',
    thoughtText: '',
    activityAt: 1,
  };
  publishAgentEvent(path.join(runtimeDir, 'b'), progress);
  publishAgentEvent(workspace, progress);
  expect(seen).toEqual([progress]);
  stop();
  publishAgentEvent(workspace, progress);
  expect(seen).toHaveLength(1);
});
