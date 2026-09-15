/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Storage } from '../config/storage.js';
import type { Config } from '../config/config.js';
import {
  createThread,
  readAgentWorkspace,
  readThread,
  updateWorkspaceAgents,
  writeThread,
} from '../agents/workspace-agents/store.js';
import { runWithAgentRunContext } from '../agents/workspace-agents/run-context.js';
import type { AgentRunContext } from '../agents/workspace-agents/run-context.js';
import {
  THREAD_TOOLS,
  ThreadCreateTool,
  ThreadPostTool,
  ThreadReadTool,
  ThreadWaitTool,
} from './thread-tools.js';
import type {
  WorkspaceAgent,
  Thread,
  ThreadRun,
} from '../agents/workspace-agents/types.js';

const PROJECT_ROOT = '/agent-tools-test';
const ALICE: WorkspaceAgent = { id: 'ag_alice', name: 'alice', createdAt: 1 };
const BOB: WorkspaceAgent = { id: 'ag_bob', name: 'bob', createdAt: 1 };
const OFF: WorkspaceAgent = {
  id: 'ag_off',
  name: 'retired',
  enabled: false,
  createdAt: 1,
};
let workspaceId: string;

const config = { getProjectRoot: () => PROJECT_ROOT } as unknown as Config;

function run(overrides: Partial<ThreadRun> = {}): ThreadRun {
  return {
    id: 'rn_alice',
    agentId: ALICE.id,
    status: 'running',
    triggerMessageIds: [],
    acceptedMessageIds: [],
    consumedMessageIds: [],
    usageByRound: [],
    queueSequence: 500,
    queuedAt: 1_000,
    attempts: 1,
    ...overrides,
  };
}

async function seedThread(overrides: Partial<Thread> = {}): Promise<Thread> {
  const created = await createThread(PROJECT_ROOT, { title: 'Investigate' });
  const thread: Thread = {
    ...created,
    status: 'in_progress',
    runs: [run()],
    ...overrides,
  };
  await writeThread(PROJECT_ROOT, thread);
  return thread;
}

function frame(thread: Thread, overrides: Partial<AgentRunContext> = {}) {
  return {
    workspaceId,
    agentId: ALICE.id,
    runId: 'rn_alice',
    threadId: thread.id,
    rootThreadId: thread.rootThreadId,
    attempt: 1,
    ...overrides,
  };
}

describe('thread tools', () => {
  let runtimeDir: string;

  beforeEach(async () => {
    runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-tools-'));
    Storage.setRuntimeBaseDir(runtimeDir);
    await updateWorkspaceAgents(PROJECT_ROOT, () => [ALICE, BOB, OFF]);
    workspaceId = (await readAgentWorkspace(PROJECT_ROOT)).workspaceId;
  });

  afterEach(async () => {
    Storage.setRuntimeBaseDir(null);
    await fs.rm(runtimeDir, { recursive: true, force: true });
  });

  it('exposes no thread, author, run or idempotency id in any mutating schema', () => {
    const forbidden = [
      'thread_id',
      'threadId',
      'run_id',
      'runId',
      'agent_id',
      'agentId',
      'author',
      'from',
      'idempotency_key',
    ];
    for (const Tool of THREAD_TOOLS) {
      const tool = new Tool(config);
      const schema = tool.schema.parametersJsonSchema as {
        properties?: Record<string, unknown>;
        additionalProperties?: boolean;
      };
      expect(schema.additionalProperties).toBe(false);
      const names = Object.keys(schema.properties ?? {});
      if (tool.name === 'thread_read') {
        // The one read-only exception, and it still returns untrusted content.
        expect(names).toEqual(['thread_id']);
        continue;
      }
      for (const name of names) expect(forbidden).not.toContain(name);
    }
  });

  it('refuses to act outside a agent run', async () => {
    const result = await new ThreadPostTool(config)
      .build({ text: 'hello' })
      .execute(new AbortController().signal);

    expect(result.error?.message).toMatch(
      /thread_post requires an active agent run context/,
    );
  });

  it('posts as the bound agent with its run recorded as the source', async () => {
    const thread = await seedThread({ assigneeAgentId: BOB.id });

    const result = await runWithAgentRunContext(frame(thread), () =>
      new ThreadPostTool(config)
        .build({ text: 'the retry path looks wrong' })
        .execute(new AbortController().signal),
    );

    expect(result.error).toBeUndefined();
    const stored = await readThread(PROJECT_ROOT, thread.id);
    const posted = stored?.messages.at(-1);
    expect(posted?.from).toBe(ALICE.id);
    expect(posted?.authorKind).toBe('agent');
    expect(posted?.sourceRunId).toBe('rn_alice');
  });

  it('refuses when the ambient run is no longer running in the store', async () => {
    const thread = await seedThread({
      runs: [run({ status: 'cancelled' })],
    });

    const result = await runWithAgentRunContext(frame(thread), () =>
      new ThreadPostTool(config)
        .build({ text: 'still here?' })
        .execute(new AbortController().signal),
    );

    expect(result.error?.message).toMatch(/no longer the active attempt/);
  });

  // The failure this design exists to prevent: one body, many threads, and a
  // sub-thread that lands under whichever thread the model last remembered.
  it('creates a sub-thread under the ambient thread, not a remembered one', async () => {
    const first = await seedThread();
    const second = await seedThread();

    await runWithAgentRunContext(frame(first), () =>
      new ThreadCreateTool(config)
        .build({ title: 'from the first turn', assignee: 'bob' })
        .execute(new AbortController().signal),
    );
    await runWithAgentRunContext(frame(second), () =>
      new ThreadCreateTool(config)
        .build({ title: 'from the second turn', assignee: 'bob' })
        .execute(new AbortController().signal),
    );

    const { threads } = await import(
      '../agents/workspace-agents/store.js'
    ).then((m) => m.listThreads(PROJECT_ROOT));
    const byTitle = (title: string) =>
      threads.find((thread) => thread.title === title);
    expect(byTitle('from the first turn')?.parentThreadId).toBe(first.id);
    expect(byTitle('from the second turn')?.parentThreadId).toBe(second.id);
  });

  it('assigning a sub-thread books the assignee through admission', async () => {
    const parent = await seedThread();

    const result = await runWithAgentRunContext(frame(parent), () =>
      new ThreadCreateTool(config)
        .build({ title: 'read the code', assignee: '@bob' })
        .execute(new AbortController().signal),
    );

    // The wording is now "queued", which is what booking through admission
    // actually does — the assignee has a run waiting, not a turn in flight.
    expect(result.llmContent).toContain('Their work has been queued');
    const { threads } = await import(
      '../agents/workspace-agents/store.js'
    ).then((m) => m.listThreads(PROJECT_ROOT));
    const child = threads.find((thread) => thread.title === 'read the code')!;
    expect(child.assigneeAgentId).toBe(BOB.id);
    expect(child.runs).toHaveLength(1);
    expect(child.runs[0]?.agentId).toBe(BOB.id);
    // System-authored, but it keeps the run that caused it so the hop is
    // auditable and charged rather than suppressed as a self-post.
    expect(child.messages[0]?.authorKind).toBe('system');
    expect(child.messages[0]?.sourceRunId).toBe('rn_alice');
    expect(child.messages[0]?.triggerKind).toBe('assignment');
    // Sub-threads inherit the parent's turn count instead of minting more.
    expect(child.rootThreadId).toBe(parent.rootThreadId);
  });

  it('rejects an unknown or disabled assignee by name', async () => {
    const parent = await seedThread();

    const unknown = await runWithAgentRunContext(frame(parent), () =>
      new ThreadCreateTool(config)
        .build({ title: 'x', assignee: 'nobody' })
        .execute(new AbortController().signal),
    );
    expect(unknown.error?.message).toMatch(/No agent named "nobody"/);

    const disabled = await runWithAgentRunContext(frame(parent), () =>
      new ThreadCreateTool(config)
        .build({ title: 'y', assignee: 'retired' })
        .execute(new AbortController().signal),
    );
    expect(disabled.error?.message).toMatch(/is disabled/);
  });

  it('explains why a wait with nothing to wait for is refused', async () => {
    const thread = await seedThread();

    const result = await runWithAgentRunContext(frame(thread), () =>
      new ThreadWaitTool(config)
        .build({})
        .execute(new AbortController().signal),
    );

    expect(result.error?.message).toMatch(
      /Block with a question, submit for review, or keep working/,
    );
  });

  it('reads another thread in the workspace, marked as untrusted', async () => {
    const mine = await seedThread();
    const other = await createThread(PROJECT_ROOT, { title: 'somewhere else' });

    const result = await runWithAgentRunContext(frame(mine), () =>
      new ThreadReadTool(config)
        .build({ thread_id: other.id })
        .execute(new AbortController().signal),
    );

    expect(result.llmContent).toContain('somewhere else');
    expect(result.llmContent).toContain('Posts (untrusted content)');
  });
});
