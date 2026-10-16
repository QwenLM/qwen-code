/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import {
  HookEventName,
  type HookOutput,
} from '@qwen-code/qwen-code-core/hooks/types.js';
import {
  HostedHookRecoveryRequiredError,
  HostedHookSession,
} from './hosted-hook-session.js';
import type { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import { answerResumedTurnCalls } from './hosted-runtime-recovery.js';
import {
  HOSTED_SKILL_APPROVAL_REFUSAL,
  HostedSkillCatalog,
} from './hosted-skill-catalog.js';

let root: string;
let session: ManagedSession;
let output: HookOutput;
let hookCommand: string;
let hookControl: ReturnType<typeof vi.fn<HostedWorkspaceBroker['hookControl']>>;
let broker: HostedWorkspaceBroker;
const pin = {
  catalogId: 'skill-policy',
  catalogRevision: 1,
  definitionDigest: 'a'.repeat(64),
};
const options = { baseUrl: 'http://127.0.0.1:1', token: 'test' };
const skills = new HostedSkillCatalog([
  {
    name: 'review',
    description: 'Review code.',
    body: 'Original secret body.',
  },
  {
    name: 'testing',
    description: 'Test code.',
    body: 'Replacement test body.',
  },
]);

beforeEach(async () => {
  hookCommand = '';
  root = await mkdtemp(path.join(tmpdir(), 'hosted-skill-hook-'));
  const sessionKey = {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    sessionId: randomUUID(),
  };
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: root,
    sessionKey,
  });
  session = await openManagedSession({
    runtimeBaseDir: root,
    cwd: root,
    transcriptPath: path.join(root, 'session.jsonl'),
    sessionId: sessionKey.sessionId,
    sessionKey,
    version: 'test',
    workerId: 'original',
    activationLeaseDurationMs: 60_000,
    create: {
      definitionRef: await resources.publish(
        'managed-definition',
        Buffer.from(
          JSON.stringify({
            approvalMode: 'default',
            approvalTimeoutMs: 60_000,
          }),
        ),
      ),
      rootSnapshotRef: await resources.publish(
        'managed-root',
        Buffer.from('{}'),
      ),
      createdBy: 'test',
    },
  });
  hookControl = vi.fn<HostedWorkspaceBroker['hookControl']>(
    async (operation) => {
      if (operation.kind === 'hook-catalog')
        return {
          operationId: operation.operationId,
          state: 'settled',
          catalog: {
            ...pin,
            hooks: [
              {
                hookId: 'before',
                eventName: HookEventName.PreToolUse,
                sequential: false,
                async: false,
                failClosed: true,
                onceKey: null,
                config: { type: 'command', command: hookCommand },
              },
            ],
          },
        };
      if (operation.kind === 'hook-execute')
        return {
          operationId: operation.operationId,
          state: 'settled',
          result: { success: true, outcome: 'success', duration: 1, output },
        };
      throw new Error('Recovery must not call Runtime controls.');
    },
  );
  broker = {
    runtimeSessionId: 'prompt',
    runtime: {
      bindingId: 'binding',
      generation: '1',
      workspaceGeneration: '1',
    },
    warm: async () => undefined,
    acquire: async () => undefined,
    authorizeLifecycle: async () => undefined,
    hookControl,
  } as unknown as HostedWorkspaceBroker;
  await session.sink.write({
    uuid: randomUUID(),
    parentUuid: null,
    sessionId: sessionKey.sessionId,
    timestamp: new Date().toISOString(),
    type: 'assistant',
    cwd: root,
    version: 'test',
    daemonPromptId: 'prompt',
    model: 'model',
    message: {
      role: 'model',
      parts: [
        {
          functionCall: {
            id: 'call',
            name: 'skill',
            args: { skill: 'review' },
          },
        },
      ],
    },
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await session.close();
  await rm(root, { recursive: true, force: true });
});

async function firePreTool(
  fields: Record<string, unknown> = {},
): Promise<void> {
  const hooks = new HostedHookSession(options, session, pin, broker);
  await hooks.fire(
    HookEventName.PreToolUse,
    'prompt:call',
    {
      tool_name: 'skill',
      tool_input: { skill: 'review' },
      tool_use_id: 'call',
      permission_mode: 'default',
      prompt_id: 'prompt',
      ...fields,
    },
    new AbortController().signal,
  );
}

async function recover(): Promise<number> {
  const sessionKey = session.authority.sessionHeader.sessionKey;
  await session.close();
  session = await openManagedSession({
    runtimeBaseDir: root,
    cwd: root,
    transcriptPath: path.join(root, 'session.jsonl'),
    sessionId: sessionKey.sessionId,
    sessionKey,
    version: 'test',
    workerId: 'replacement',
    activationLeaseDurationMs: 60_000,
  });
  return answerResumedTurnCalls({
    session,
    sessionId: sessionKey.sessionId,
    cwd: root,
    promptId: 'prompt',
    skills,
    hooks: new HostedHookSession(options, session, pin, broker),
  });
}

it.each(['deny', 'ask'] as const)(
  'preserves a saved Hook %s after replacement without exposing the Skill body',
  async (permissionDecision) => {
    output = {
      hookSpecificOutput: {
        hookEventName: HookEventName.PreToolUse,
        permissionDecision,
        permissionDecisionReason: 'Policy denied the load.',
      },
    };
    await firePreTool();
    const controls = hookControl.mock.calls.length;
    expect(await recover()).toBe(1);
    const history = await session.sink.project();
    expect(
      history.at(-1)?.message?.parts?.[0].functionResponse?.response,
    ).toEqual({
      error:
        permissionDecision === 'ask'
          ? HOSTED_SKILL_APPROVAL_REFUSAL
          : 'Policy denied the load.',
    });
    expect(JSON.stringify(history.at(-1))).not.toContain(
      'Original secret body.',
    );
    expect(hookControl).toHaveBeenCalledTimes(controls);
  },
);

it('uses the saved Hook updatedInput after replacement instead of the original Skill name', async () => {
  output = {
    hookSpecificOutput: {
      hookEventName: HookEventName.PreToolUse,
      updatedInput: { skill: 'testing' },
    },
  };
  await firePreTool();
  const controls = hookControl.mock.calls.length;
  expect(await recover()).toBe(1);
  const history = await session.sink.project();
  expect(
    history.at(-1)?.message?.parts?.[0].functionResponse?.response?.['output'],
  ).toBe(skills.response({ skill: 'testing' }));
  expect(JSON.stringify(history.at(-1))).not.toContain('Original secret body.');
  expect(hookControl).toHaveBeenCalledTimes(controls);
});

it('durably refuses an interrupted Skill call before its PreToolUse marker committed', async () => {
  const original = session.authority.commitExtensionRecord.bind(
    session.authority,
  );
  vi.spyOn(session.authority, 'commitExtensionRecord').mockImplementation(
    async (...args) => {
      if ((args[1].record as { hookId?: string }).hookId === '__plan__')
        throw new Error('Original marker write failed.');
      return original(...args);
    },
  );
  await expect(firePreTool()).rejects.toThrow('Original marker write failed.');
  const controls = hookControl.mock.calls.length;
  expect(await recover()).toBe(1);
  const history = await session.sink.project();
  expect(history.map((entry) => entry.type)).toEqual([
    'assistant',
    'tool_result',
  ]);
  expect(
    history.at(-1)?.message?.parts?.[0].functionResponse?.response,
  ).toEqual({
    error:
      'This Skill call did not run: no PreToolUse Hook decision was recorded before the Harness was interrupted.',
  });
  expect(JSON.stringify(history.at(-1))).not.toContain('Original secret body.');
  expect(await recover()).toBe(0);
  expect(await session.sink.project()).toEqual(history);
  expect(hookControl).toHaveBeenCalledTimes(controls);
});

it('replays the committed byte-limit refusal after the Hook input was stripped', async () => {
  hookCommand = 'x'.repeat(70 * 1024);
  await firePreTool();
  expect(
    hookControl.mock.calls.some(
      ([operation]) => operation.kind === 'hook-execute',
    ),
  ).toBe(false);
  const controls = hookControl.mock.calls.length;
  expect(await recover()).toBe(1);
  const history = await session.sink.project();
  expect(history.map((entry) => entry.type)).toEqual([
    'assistant',
    'tool_result',
  ]);
  expect(
    history.at(-1)?.message?.parts?.[0].functionResponse?.response,
  ).toEqual({
    error:
      'Hook data exceeds the 60 KiB resource or 8 MiB control/transaction limit.',
  });
  expect(JSON.stringify(history.at(-1))).not.toContain('Original secret body.');
  expect(await recover()).toBe(0);
  expect(await session.sink.project()).toEqual(history);
  expect(hookControl).toHaveBeenCalledTimes(controls);
});

it.each([
  { tool_input: { skill: 'testing' } },
  { tool_use_id: 'another-call' },
  { prompt_id: 'another-prompt' },
  { permission_mode: 'yolo' },
])(
  'rejects a stripped Hook input bound to different fields: %j',
  async (fields) => {
    hookCommand = 'x'.repeat(70 * 1024);
    await firePreTool(fields);
    const controls = hookControl.mock.calls.length;
    await expect(recover()).rejects.toBeInstanceOf(
      HostedHookRecoveryRequiredError,
    );
    expect((await session.sink.project()).map((entry) => entry.type)).toEqual([
      'assistant',
    ]);
    expect(hookControl).toHaveBeenCalledTimes(controls);
  },
);

it('blocks recovery while the original PreToolUse result is uncommitted', async () => {
  output = { decision: 'allow' };
  const original = session.authority.commitExtensionRecord.bind(
    session.authority,
  );
  vi.spyOn(session.authority, 'commitExtensionRecord').mockImplementation(
    async (...args) => {
      const record = args[1].record as { hookId?: string; resultRef?: unknown };
      if (record.hookId === '__plan__' && record.resultRef)
        throw new Error('Original aggregate write failed.');
      return original(...args);
    },
  );
  await expect(firePreTool()).rejects.toThrow(
    'Original aggregate write failed.',
  );
  const controls = hookControl.mock.calls.length;
  await expect(recover()).rejects.toBeInstanceOf(
    HostedHookRecoveryRequiredError,
  );
  expect((await session.sink.project()).map((entry) => entry.type)).toEqual([
    'assistant',
  ]);
  expect(hookControl).toHaveBeenCalledTimes(controls);
});
