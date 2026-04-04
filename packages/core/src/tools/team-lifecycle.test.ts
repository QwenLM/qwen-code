/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Full team lifecycle E2E test.
 *
 * Exercises the complete flow through real tool execute() methods
 * backed by a real TeamManager + FakeBackend:
 *
 *   create team → spawn teammates → create tasks → send messages
 *   → list tasks → update tasks → delete team
 *
 * This validates the full wiring between tools, config, team
 * manager, mailbox, and task system — everything except the LLM
 * and CLI rendering.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { TeamCreateTool } from './team-create.js';
import { TeamDeleteTool } from './team-delete.js';
import { SendMessageTool } from './send-message.js';
import { TaskCreateTool } from './task-create.js';
import { TaskUpdateTool } from './task-update.js';
import { TaskListTool } from './task-list.js';
import type { Config } from '../config/config.js';
import type { TeamManager } from '../agents/team/TeamManager.js';
import type { TeamContext } from '../agents/team/types.js';
import type { FakeBackend } from '../agents/team/test-utils/fake-backend.js';
import type { FakeAgent } from '../agents/team/test-utils/fake-agent.js';
import { formatAgentId } from '../agents/team/teamHelpers.js';

// ─── Mock Storage ──────────────────────────────────────────

vi.mock('../config/storage.js', () => {
  let mockDir = '/tmp/test';
  return {
    QWEN_DIR: '.qwen',
    Storage: {
      getGlobalQwenDir: () => mockDir,
    },
    __setMockGlobalDir: (d: string) => {
      mockDir = d;
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { __setMockGlobalDir } = (await import('../config/storage.js')) as any;

// ─── Mock InProcessBackend → FakeBackend ───────────────────

// Capture the backend created by TeamCreateTool so we can
// script FakeAgents on it.
let capturedBackend: FakeBackend | null = null;

vi.mock('../agents/backends/InProcessBackend.js', async () => {
  const { FakeBackend: FB } = await import(
    '../agents/team/test-utils/fake-backend.js'
  );
  return {
    InProcessBackend: class MockInProcessBackend extends FB {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      constructor(_config: any) {
        super();
        capturedBackend = this as unknown as FakeBackend;
      }
    },
  };
});

// ─── Helpers ───────────────────────────────────────────────

let tmpDir: string;

/**
 * Mutable config mock that tracks state set by tools.
 */
function makeConfig(): Config {
  let teamManager: TeamManager | null = null;
  let teamContext: TeamContext | null = null;

  return {
    getArenaManager: () => null,
    getTeamManager: () => teamManager,
    getSubagentManager: () => null,
    setTeamManager: vi.fn((m: TeamManager | null) => {
      teamManager = m;
    }),
    getTeamContext: () => teamContext,
    setTeamContext: vi.fn((c: TeamContext | null) => {
      teamContext = c;
    }),
  } as unknown as Config;
}

const signal = new AbortController().signal;

async function exec(
  tool: {
    build: (p: never) => { execute: (s: AbortSignal) => Promise<unknown> };
  },
  params: Record<string, unknown>,
) {
  const invocation = tool.build(params as never);
  return invocation.execute(signal) as Promise<{
    llmContent: string;
    error?: { message: string };
    returnDisplay?: unknown;
  }>;
}

// ─── Setup / Teardown ──────────────────────────────────────

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-lifecycle-'));
  __setMockGlobalDir(tmpDir);
  capturedBackend = null;
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── Tests ─────────────────────────────────────────────────

describe('Team lifecycle E2E', () => {
  it('full lifecycle: create → tasks → messages → list → update → delete', async () => {
    const config = makeConfig();

    // ── Step 1: Create team ──────────────────────────────
    const createTool = new TeamCreateTool(config);
    const createResult = await exec(createTool, {
      team_name: 'lifecycle',
      description: 'E2E test team',
    });

    expect(createResult.error).toBeUndefined();
    expect(createResult.llmContent).toContain('lifecycle');
    expect(createResult.llmContent).toContain('created');
    expect(createResult.llmContent).toContain('E2E test team');
    expect(config.getTeamManager()).not.toBeNull();
    expect(config.getTeamContext()).not.toBeNull();
    expect(config.getTeamContext()!.teamName).toBe('lifecycle');

    // Verify file was written to disk.
    const teamConfigPath = path.join(
      tmpDir,
      'teams',
      'lifecycle',
      'config.json',
    );
    const raw = await fs.readFile(teamConfigPath, 'utf-8');
    const teamFile = JSON.parse(raw);
    expect(teamFile.name).toBe('lifecycle');

    // ── Step 2: Create tasks BEFORE teammates ──────────────
    // Tasks created without idle teammates stay pending
    // (no auto-claiming).
    const taskCreateTool = new TaskCreateTool(config);

    const task1Result = await exec(taskCreateTool, {
      subject: 'Fix login bug',
      description: 'SSO login fails for new users',
    });
    expect(task1Result.error).toBeUndefined();
    expect(task1Result.llmContent).toContain('Fix login bug');
    expect(task1Result.llmContent).toMatch(/Task #\d+ created/);

    const task1Id = task1Result.llmContent.match(/Task #(\d+)/)![1];

    const task2Result = await exec(taskCreateTool, {
      subject: 'Add unit tests',
      description: 'Cover the auth module',
    });
    expect(task2Result.error).toBeUndefined();

    const task3Result = await exec(taskCreateTool, {
      subject: 'Write docs',
      description: 'Document the auth API',
    });
    expect(task3Result.error).toBeUndefined();
    const task3Id = task3Result.llmContent.match(/Task #(\d+)/)![1];

    // ── Step 3: List tasks — all pending ─────────────────
    const taskListTool = new TaskListTool(config);

    const listResult = await exec(taskListTool, {});
    expect(listResult.error).toBeUndefined();
    expect(listResult.llmContent).toContain('Fix login bug');
    expect(listResult.llmContent).toContain('Add unit tests');
    expect(listResult.llmContent).toContain('Write docs');
    expect(listResult.llmContent).toContain('[pending]');

    const display = listResult.returnDisplay as {
      type: string;
      tasks: Array<{
        id: string;
        subject: string;
        status: string;
      }>;
    };
    expect(display.type).toBe('task_list');
    expect(display.tasks).toHaveLength(3);

    // ── Step 4: Update task status and ownership ─────────
    const taskUpdateTool = new TaskUpdateTool(config);

    const updateResult = await exec(taskUpdateTool, {
      taskId: task1Id,
      status: 'in_progress',
      owner: 'alice',
    });
    expect(updateResult.error).toBeUndefined();
    expect(updateResult.llmContent).toContain('in_progress');
    expect(updateResult.llmContent).toContain('alice');

    // Verify status filter works.
    const inProgressList = await exec(taskListTool, {
      status: 'in_progress',
    });
    expect(inProgressList.llmContent).toContain('Fix login bug');
    expect(inProgressList.llmContent).not.toContain('Add unit tests');
    expect(inProgressList.llmContent).not.toContain('Write docs');

    // Complete task 1.
    const completeResult = await exec(taskUpdateTool, {
      taskId: task1Id,
      status: 'completed',
    });
    expect(completeResult.error).toBeUndefined();
    expect(completeResult.llmContent).toContain('completed');

    // ── Step 5: Spawn teammates ──────────────────────────
    const backend = capturedBackend!;
    expect(backend).not.toBeNull();

    const manager = config.getTeamManager()!;
    const aliceId = formatAgentId('alice', 'lifecycle');
    const bobId = formatAgentId('bob', 'lifecycle');

    backend.setScript(aliceId, {});
    backend.setScript(bobId, {});

    await manager.spawnTeammate({ name: 'alice', cwd: tmpDir });
    await manager.spawnTeammate({ name: 'bob', cwd: tmpDir });

    const alice = backend.getAgent(aliceId) as FakeAgent;
    const bob = backend.getAgent(bobId) as FakeAgent;
    expect(alice).toBeDefined();
    expect(bob).toBeDefined();

    // Let auto-claiming settle — idle agents will claim
    // pending tasks in the background.
    await new Promise((r) => setTimeout(r, 150));

    // ── Step 6: Send messages via SendMessageTool ────────
    const sendTool = new SendMessageTool(config);

    // Note how many messages each agent has from auto-claiming.
    const aliceBaseCount = alice.getReceivedMessages().length;

    const sendResult = await exec(sendTool, {
      to: 'alice',
      message: 'Please review the auth changes.',
    });
    expect(sendResult.error).toBeUndefined();
    expect(sendResult.llmContent).toContain('alice');

    // Wait for message delivery.
    await alice.waitForMessageCount(aliceBaseCount + 1);
    expect(
      alice
        .getReceivedMessages()
        .some((m: string) => m.includes('review the auth')),
    ).toBe(true);

    // Broadcast to all teammates.
    const broadcastResult = await exec(sendTool, {
      to: '*',
      message: 'Standup in 5 minutes.',
    });
    expect(broadcastResult.error).toBeUndefined();
    expect(broadcastResult.llmContent).toContain('broadcast');

    // ── Step 7: Delete a task ────────────────────────────
    const deleteTaskResult = await exec(taskUpdateTool, {
      taskId: task3Id,
      status: 'deleted',
    });
    expect(deleteTaskResult.error).toBeUndefined();
    expect(deleteTaskResult.llmContent).toContain('deleted');

    // Verify it's gone from the list.
    const afterDeleteList = await exec(taskListTool, {});
    expect(afterDeleteList.llmContent).not.toContain('Write docs');

    // ── Step 8: Delete team ──────────────────────────────
    const deleteTool = new TeamDeleteTool(config);
    const deleteResult = await exec(deleteTool, {});

    expect(deleteResult.error).toBeUndefined();
    expect(deleteResult.llmContent).toContain('deleted');
    expect(deleteResult.llmContent).toContain('lifecycle');

    const deleteDisplay = deleteResult.returnDisplay as {
      type: string;
      action: string;
    };
    expect(deleteDisplay.type).toBe('team_result');
    expect(deleteDisplay.action).toBe('deleted');

    // Config is cleared.
    expect(config.getTeamManager()).toBeNull();
    expect(config.getTeamContext()).toBeNull();

    // Let any pending async operations settle before
    // afterEach removes tmpDir.
    await new Promise((r) => setTimeout(r, 100));

    // ── Step 9: Verify tools fail without a team ─────────
    const noTeamTask = await exec(taskCreateTool, {
      subject: 'Should fail',
      description: 'No team active',
    });
    expect(noTeamTask.error).toBeDefined();
    expect(noTeamTask.llmContent).toContain('No active team');

    const noTeamSend = await exec(sendTool, {
      to: 'alice',
      message: 'Should fail',
    });
    expect(noTeamSend.error).toBeDefined();
    expect(noTeamSend.llmContent).toContain('No active team');

    const noTeamDelete = await exec(deleteTool, {});
    expect(noTeamDelete.error).toBeDefined();
    expect(noTeamDelete.llmContent).toContain('No active team');
  });

  it('prevents creating a second team', async () => {
    const config = makeConfig();
    const createTool = new TeamCreateTool(config);

    // Create first team.
    const first = await exec(createTool, {
      team_name: 'first',
    });
    expect(first.error).toBeUndefined();

    // Attempt to create second.
    const second = await exec(createTool, {
      team_name: 'second',
    });
    expect(second.error).toBeDefined();
    expect(second.llmContent).toContain('already active');
  });

  it('team file tracks spawned members', async () => {
    const config = makeConfig();
    const createTool = new TeamCreateTool(config);
    await exec(createTool, { team_name: 'tracked' });

    const manager = config.getTeamManager()!;
    await manager.spawnTeammate({
      name: 'worker-1',
      cwd: tmpDir,
    });
    await manager.spawnTeammate({
      name: 'worker-2',
      cwd: tmpDir,
    });

    const teamFile = manager.getTeamFile();
    expect(teamFile.members).toHaveLength(2);
    const names = teamFile.members.map((m: { name: string }) => m.name);
    expect(names).toContain('worker-1');
    expect(names).toContain('worker-2');
  });

  it('injects prompt addendum into spawned teammates', async () => {
    const config = makeConfig();
    const createTool = new TeamCreateTool(config);
    await exec(createTool, { team_name: 'prompt-test' });

    const backend = capturedBackend!;
    const manager = config.getTeamManager()!;

    await manager.spawnTeammate({
      name: 'worker',
      cwd: tmpDir,
    });

    const workerId = formatAgentId('worker', 'prompt-test');
    const spawnConfig = backend.getSpawnConfig(workerId);
    const prompt =
      spawnConfig?.inProcess?.runtimeConfig?.promptConfig?.systemPrompt ?? '';

    // Should contain team addendum content.
    expect(prompt).toContain('You are agent');
    expect(prompt).toContain('prompt-test');
    expect(prompt).toContain('send_message');
    expect(prompt).toContain('Do not spawn sub-agents');
  });

  it('appends addendum to custom prompt', async () => {
    const config = makeConfig();
    const createTool = new TeamCreateTool(config);
    await exec(createTool, { team_name: 'custom' });

    const backend = capturedBackend!;
    const manager = config.getTeamManager()!;

    await manager.spawnTeammate({
      name: 'dev',
      cwd: tmpDir,
      prompt: 'You are a code reviewer.',
    });

    const devId = formatAgentId('dev', 'custom');
    const spawnConfig = backend.getSpawnConfig(devId);
    const prompt =
      spawnConfig?.inProcess?.runtimeConfig?.promptConfig?.systemPrompt ?? '';

    // Custom prompt + addendum both present.
    expect(prompt).toContain('You are a code reviewer.');
    expect(prompt).toContain('You are agent');
    expect(prompt).toContain('custom');
  });
});
