/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { createHttpManagedSessionStores } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import {
  HookEventName,
  HookType,
} from '@qwen-code/qwen-code-core/hooks/types.js';
import type {
  ManagedHookCatalog,
  ManagedHookControl,
  ManagedHookOperationView,
  ManagedHookResult,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-protocol.js';
import {
  HostedWorkspaceBroker,
  HostedWorkspaceBrokerRejection,
} from './hosted-workspace-broker.js';
import {
  HostedHookSession,
  HostedHookInputConflictError,
  HostedHookRecoveryRequiredError,
  parseHostedHookPin,
  hostedHookOccurrenceId,
} from './hosted-hook-session.js';
import { ManagedHookRuntime } from './managed-hook-runtime.js';
import { HttpHookRunner } from '@qwen-code/qwen-code-core/hooks/httpHookRunner.js';
import { parseHookExecution } from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-record.js';
import { ManagedHookActivationController } from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-activation.js';

let root: string;
let session: ManagedSession;
let hooks: HostedHookSession;
let requests: ManagedHookControl[];
let catalog: ManagedHookCatalog;
let replies: Map<string, ManagedHookOperationView>;
let execute: (
  operation: Extract<ManagedHookControl, { kind: 'hook-execute' }>,
) => Promise<ManagedHookResult>;
const pin = {
  catalogId: 'deployment',
  catalogRevision: 1,
  definitionDigest: 'a'.repeat(64),
};
const options = { baseUrl: 'http://127.0.0.1:9999', token: 'test' };
const signal = () => new AbortController().signal;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'qwen-hosted-hooks-'));
  const key = {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    sessionId: randomUUID(),
  };
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: root,
    sessionKey: key,
  });
  session = await openManagedSession({
    runtimeBaseDir: root,
    cwd: root,
    transcriptPath: path.join(root, 'session.jsonl'),
    sessionId: key.sessionId,
    sessionKey: key,
    version: 'test',
    workerId: 'worker',
    activationLeaseDurationMs: 60_000,
    create: {
      definitionRef: await resources.publish(
        'managed-definition',
        Buffer.from('{}'),
      ),
      rootSnapshotRef: await resources.publish(
        'managed-root',
        Buffer.from('{}'),
      ),
      createdBy: 'test',
    },
  });
  requests = [];
  replies = new Map();
  catalog = {
    ...pin,
    hooks: [
      {
        hookId: 'before',
        eventName: HookEventName.PreToolUse,
        sequential: false,
        async: false,
        failClosed: true,
        onceKey: null,
        config: { type: 'command' },
      },
    ],
  };
  execute = async () => ({
    success: true,
    outcome: 'success',
    duration: 1,
    output: { hookSpecificOutput: { additionalContext: 'checked' } },
  });
  vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
  vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
    async function (this: HostedWorkspaceBroker) {
      this.runtime = {
        bindingId: 'binding',
        generation: '1',
        workspaceGeneration: '1',
      };
    },
  );
  vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
  vi.spyOn(HostedWorkspaceBroker.prototype, 'hookControl').mockImplementation(
    async (operation) => {
      requests.push(operation);
      if (operation.kind === 'hook-catalog')
        return {
          operationId: operation.operationId,
          state: 'settled',
          catalog: structuredClone(catalog),
        };
      if (operation.kind === 'hook-status' || operation.kind === 'hook-cancel')
        return (
          replies.get(operation.targetOperationId) ?? {
            operationId: operation.targetOperationId,
            state: 'outcome_unknown',
          }
        );
      expect(
        session.authority.extensionRecord(
          'hook_execution',
          operation.operationId,
        )?.run.execution,
      ).toBe('dispatch_started');
      if (operation.kind !== 'hook-execute')
        throw new Error('Unexpected control.');
      const result = await execute(operation);
      const view: ManagedHookOperationView = {
        operationId: operation.operationId,
        state: 'settled',
        result,
      };
      replies.set(operation.operationId, view);
      return view;
    },
  );
  hooks = new HostedHookSession(options, session, pin);
});

async function reopenSession(): Promise<void> {
  const key = session.authority.sessionHeader.sessionKey;
  await session.close();
  session = await openManagedSession({
    runtimeBaseDir: root,
    cwd: root,
    transcriptPath: path.join(root, 'session.jsonl'),
    sessionId: key.sessionId,
    sessionKey: key,
    version: 'test',
    workerId: 'replacement',
    activationLeaseDurationMs: 60_000,
  });
}

afterEach(async () => {
  await session.close();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

it('commits a pinned plan before dispatch and replays the original occurrence after reconstruction', async () => {
  const output = await hooks.fire(
    HookEventName.PreToolUse,
    'call-1',
    { tool_name: 'read_file' },
    signal(),
  );
  expect(output?.hookSpecificOutput?.['additionalContext']).toBe('checked');
  const replacement = new HostedHookSession(options, session, pin);
  expect(
    await replacement.fire(
      HookEventName.PreToolUse,
      'call-1',
      { tool_name: 'read_file' },
      signal(),
    ),
  ).toEqual(output);
  expect(
    requests.filter((request) => request.kind === 'hook-execute'),
  ).toHaveLength(1);
  await expect(
    replacement.fire(
      HookEventName.PreToolUse,
      'call-1',
      { tool_name: 'write_file' },
      signal(),
    ),
  ).rejects.toThrow('input conflict');
  expect(session.authority.taskViews()).toEqual([]);
});

it('consumes once at intent even when execution fails', async () => {
  catalog = {
    ...catalog,
    hooks: [{ ...catalog.hooks[0], onceKey: 'once-before' }],
  };
  execute = async () => ({
    success: false,
    outcome: 'non_blocking_error',
    duration: 0,
    error: 'failed',
  });
  const first = await hooks.fire(
    HookEventName.PreToolUse,
    'call-1',
    {},
    signal(),
  );
  expect(first?.decision).toBe('block');
  expect(
    await hooks.fire(HookEventName.PreToolUse, 'call-2', {}, signal()),
  ).toBeUndefined();
  expect(
    requests.filter((request) => request.kind === 'hook-execute'),
  ).toHaveLength(1);
});

it('keeps only the first matching hook for a shared once key in one plan', async () => {
  catalog = {
    ...catalog,
    hooks: ['first', 'second'].map((hookId) => ({
      ...catalog.hooks[0],
      hookId,
      plannerKey: hookId,
      onceKey: 'shared-once-key',
    })),
  };
  await hooks.fire(HookEventName.PreToolUse, 'call-1', {}, signal());
  const dispatched = requests.filter(
    (request) => request.kind === 'hook-execute',
  );
  expect(dispatched.map((request) => request.hookId)).toEqual(['first']);
  expect(hooks.hasPendingOperations).toBe(false);
  await hooks.fire(HookEventName.PreToolUse, 'call-2', {}, signal());
  expect(
    requests.filter((request) => request.kind === 'hook-execute'),
  ).toHaveLength(1);
});

it('consumes once without stranding concurrent permission occurrences', async () => {
  catalog = {
    ...catalog,
    hooks: [
      {
        ...catalog.hooks[0],
        eventName: HookEventName.PermissionRequest,
        onceKey: 'permission-once',
      },
    ],
  };
  await Promise.all(
    ['call-1', 'call-2'].map((id) =>
      hooks.fire(
        HookEventName.PermissionRequest,
        id,
        { tool_name: 'write_file', tool_use_id: id },
        signal(),
      ),
    ),
  );
  expect(
    requests.filter((request) => request.kind === 'hook-execute'),
  ).toHaveLength(1);
  expect(hooks.hasPendingOperations).toBe(false);
  expect(
    session.authority
      .extensionRecordsInDomain('hook_execution')
      .filter((record) => record.recordId.startsWith('hook-plan-')),
  ).toHaveLength(2);
});

it.each([false, true])(
  'keeps fail-closed permission denial when an allowing Hook runs first: %s',
  async (allowFirst) => {
    const hookIds = allowFirst ? ['allow', 'fail'] : ['fail', 'allow'];
    catalog = {
      ...catalog,
      hooks: hookIds.map((hookId) => ({
        ...catalog.hooks[0],
        hookId,
        eventName: HookEventName.PermissionRequest,
      })),
    };
    execute = async (operation) =>
      operation.hookId === 'fail'
        ? {
            success: false,
            outcome: 'non_blocking_error',
            duration: 0,
            error: 'evaluation failed',
          }
        : {
            success: true,
            outcome: 'success',
            duration: 0,
            output: {
              continue: true,
              hookSpecificOutput: { decision: { behavior: 'allow' } },
            },
          };
    const output = await hooks.fire(
      HookEventName.PermissionRequest,
      'call-1',
      { tool_name: 'write_file' },
      signal(),
    );
    expect(output?.hookSpecificOutput?.['decision']).toMatchObject({
      behavior: 'deny',
      interrupt: true,
    });
    const restored = new HostedHookSession(options, session, pin);
    expect(
      await restored.fire(
        HookEventName.PermissionRequest,
        'call-1',
        { tool_name: 'write_file' },
        signal(),
      ),
    ).toEqual(output);
    expect(
      requests.filter((request) => request.kind === 'hook-execute'),
    ).toHaveLength(2);
  },
);

it('refuses a queued new occurrence after its predecessor loses the outcome', async () => {
  execute = async () => {
    throw new Error('lost reply');
  };
  const results = await Promise.allSettled(
    ['call-1', 'call-2'].map((id) =>
      hooks.fire(HookEventName.PreToolUse, id, {}, signal()),
    ),
  );
  for (const result of results) {
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected')
      expect(result.reason).toBeInstanceOf(HostedHookRecoveryRequiredError);
  }
  expect(
    requests.filter((request) => request.kind === 'hook-execute'),
  ).toHaveLength(1);
  expect(
    session.authority.extensionRecord(
      'hook_execution',
      hostedHookOccurrenceId(HookEventName.PreToolUse, 'call-2'),
    ),
  ).toBeUndefined();
});

it('does not redispatch an unknown side effect', async () => {
  execute = async () => {
    throw new Error('lost reply');
  };
  await expect(
    hooks.fire(HookEventName.PreToolUse, 'call-1', {}, signal()),
  ).rejects.toBeInstanceOf(HostedHookRecoveryRequiredError);
  const replacement = new HostedHookSession(options, session, pin);
  await expect(
    replacement.fire(HookEventName.PreToolUse, 'call-1', {}, signal()),
  ).rejects.toBeInstanceOf(HostedHookRecoveryRequiredError);
  expect(
    requests.filter((request) => request.kind === 'hook-execute'),
  ).toHaveLength(1);
});

it.each([
  { cancel: false, matchingBinding: true },
  { cancel: true, matchingBinding: true },
  { cancel: false, matchingBinding: false },
])(
  'restores only the original broker owner for lookup (cancel=$cancel, matchingBinding=$matchingBinding)',
  async ({ cancel, matchingBinding }) => {
    execute = async () => {
      throw new Error('lost reply');
    };
    await expect(
      hooks.fire(HookEventName.PreToolUse, 'lost', {}, signal()),
    ).rejects.toBeInstanceOf(HostedHookRecoveryRequiredError);
    let restored = false;
    const acquire = vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire');
    const originalAcquire = acquire.getMockImplementation()!;
    acquire.mockImplementation(async function (this: HostedWorkspaceBroker) {
      expect(this.runtimeSessionId).toBe(hooks.broker.runtimeSessionId);
      await originalAcquire.call(this);
      if (!matchingBinding) this.runtime!.bindingId = 'replacement';
      restored = true;
    });
    acquire.mockClear();
    const control = vi.spyOn(HostedWorkspaceBroker.prototype, 'hookControl');
    const originalControl = control.getMockImplementation()!;
    let lookups = 0;
    control.mockImplementation(async function (
      this: HostedWorkspaceBroker,
      operation,
    ) {
      if (
        operation.kind === 'hook-status' ||
        operation.kind === 'hook-cancel'
      ) {
        lookups++;
        expect(this.runtimeSessionId).toBe(hooks.broker.runtimeSessionId);
        if (!restored)
          throw new HostedWorkspaceBrokerRejection(
            404,
            'runtime_session_not_found',
          );
        return {
          operationId: operation.targetOperationId,
          state: 'settled',
          result: { success: true, outcome: 'success', duration: 0 },
        };
      }
      return originalControl.call(this, operation);
    });
    const replacement = new HostedHookSession(options, session, pin);
    const marker = await replacement.status('lost', cancel);
    expect(acquire).toHaveBeenCalledOnce();
    expect(lookups).toBe(matchingBinding ? 2 : 1);
    expect(marker.resultRef !== null).toBe(matchingBinding);
    expect(replacement.hasPendingOperations).toBe(!matchingBinding);
    expect(
      requests.filter((request) => request.kind === 'hook-execute'),
    ).toHaveLength(1);
  },
);

it('aggregates parallel results in plan order rather than reply order', async () => {
  catalog = {
    ...catalog,
    hooks: [catalog.hooks[0], { ...catalog.hooks[0], hookId: 'second' }],
  };
  execute = async (operation) => {
    if (operation.hookId === 'before')
      await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      success: true,
      outcome: 'success',
      duration: 0,
      output: { hookSpecificOutput: { additionalContext: operation.hookId } },
    };
  };
  const output = await hooks.fire(
    HookEventName.PreToolUse,
    'call-1',
    {},
    signal(),
  );
  expect(output?.hookSpecificOutput?.['additionalContext']).toBe(
    'before\nsecond',
  );
});

it('passes committed effective inputs to sequential hooks and preserves aliases', async () => {
  catalog = {
    ...catalog,
    hooks: [
      { ...catalog.hooks[0], sequential: true, matcher: 'Read' },
      {
        ...catalog.hooks[0],
        hookId: 'second',
        sequential: true,
        matcher: 'Read',
      },
    ],
  };
  execute = async (operation) => {
    if (operation.hookId === 'second')
      expect(operation.input).toMatchObject({
        tool_input: { file_path: 'changed' },
      });
    return {
      success: true,
      outcome: 'success',
      duration: 0,
      output: {
        hookSpecificOutput: { updatedInput: { file_path: 'changed' } },
      },
    };
  };
  await hooks.fire(
    HookEventName.PreToolUse,
    'call-1',
    { tool_name: 'read_file', tool_input: { file_path: 'original' } },
    signal(),
  );
  expect(
    requests.filter((request) => request.kind === 'hook-execute'),
  ).toHaveLength(2);
});

it('rejects malformed or unpinned catalog requests', () => {
  expect(() => parseHostedHookPin({ ...pin, catalogRevision: 0 })).toThrow();
  expect(() =>
    parseHostedHookPin({ ...pin, command: 'echo injected' }),
  ).toThrow();
});

it.each([
  {
    event: HookEventName.UserPromptSubmit,
    fields: { prompt: 'original' },
    output: { additionalContext: 'context' },
    expected: { prompt: 'original\n\ncontext' },
  },
  {
    event: HookEventName.UserPromptExpansion,
    fields: { prompt: 'original' },
    output: { additionalContext: 'context' },
    expected: { prompt: 'original\n\ncontext' },
  },
  {
    event: HookEventName.PreToolUse,
    fields: { tool_input: { original: true, changed: false } },
    output: { tool_input: { changed: true } },
    expected: { tool_input: { original: true, changed: true } },
  },
])(
  'preserves native sequential input composition for $event',
  async ({ event, fields, output, expected }) => {
    catalog = {
      ...catalog,
      hooks: ['first', 'second'].map((hookId) => ({
        ...catalog.hooks[0],
        hookId,
        eventName: event,
        sequential: true,
      })),
    };
    execute = async (operation) => {
      if (operation.hookId === 'second')
        expect(operation.input).toMatchObject(expected);
      return {
        success: true,
        outcome: 'success',
        duration: 0,
        output: { hookSpecificOutput: output },
      };
    };
    await hooks.fire(event, 'compose', fields, signal());
    expect(
      requests.filter((request) => request.kind === 'hook-execute'),
    ).toHaveLength(2);
  },
);

it('does not compose failed Hook output into later sequential inputs', async () => {
  catalog = {
    ...catalog,
    hooks: ['first', 'second'].map((hookId) => ({
      ...catalog.hooks[0],
      hookId,
      sequential: true,
      failClosed: false,
    })),
  };
  execute = async (operation) => {
    if (operation.hookId === 'second')
      expect(
        'tool_input' in operation.input && operation.input.tool_input,
      ).toEqual({ original: true });
    return {
      success: false,
      outcome: 'non_blocking_error',
      duration: 0,
      output: {
        hookSpecificOutput: {
          tool_input: { unexpected: true },
          updatedInput: { unexpected: true },
        },
      },
    };
  };
  await hooks.fire(
    HookEventName.PreToolUse,
    'failed-composition',
    { tool_input: { original: true } },
    signal(),
  );
});

it('keeps the latest catalog active when an older registration is retried', async () => {
  await hooks.ensureReady();
  const original =
    session.authority.extensionRecordsInDomain('hook_registration')[0];
  const nextPin = {
    ...pin,
    catalogRevision: 2,
    definitionDigest: 'b'.repeat(64),
  };
  catalog = { ...catalog, ...nextPin };
  await hooks.configure('registration-2', nextPin, 1);
  await hooks.configure(original.recordId, pin, 0);
  expect(hooks.getCatalog()).toMatchObject(nextPin);
  await hooks.fire(HookEventName.PreToolUse, 'call-1', {}, signal());
  expect(
    session.authority.extensionRecord(
      'hook_execution',
      hostedHookOccurrenceId(HookEventName.PreToolUse, 'call-1'),
    )?.record,
  ).toMatchObject({ registrationId: 'registration-2' });
});

it('dispatches a recovered intent through its original Runtime Session', async () => {
  const owner = hooks.broker.runtimeSessionId;
  const originalCommit = session.authority.commitExtensionRecord.bind(
    session.authority,
  );
  const commit = vi
    .spyOn(session.authority, 'commitExtensionRecord')
    .mockImplementation(async (command, request, actor) => {
      const record = request.record as {
        hookId?: string;
        run: { execution: string };
      };
      if (
        record.hookId === 'before' &&
        record.run.execution === 'dispatch_started'
      )
        throw new Error('crash before dispatch');
      return originalCommit(command, request, actor);
    });
  await expect(
    hooks.fire(HookEventName.PreToolUse, 'call-1', {}, signal()),
  ).rejects.toThrow('crash before dispatch');
  commit.mockRestore();
  const control = vi.spyOn(HostedWorkspaceBroker.prototype, 'hookControl');
  const originalControl = control.getMockImplementation()!;
  let recoveredOwner: string | undefined;
  control.mockImplementation(function (this: HostedWorkspaceBroker, operation) {
    if (operation.kind === 'hook-execute')
      recoveredOwner = this.runtimeSessionId;
    return originalControl.call(this, operation);
  });
  await reopenSession();
  const replacement = new HostedHookSession(options, session, pin);
  expect(replacement.broker.runtimeSessionId).not.toBe(owner);
  await replacement.fire(HookEventName.PreToolUse, 'call-1', {}, signal());
  expect(recoveredOwner).toBe(owner);
  expect(
    requests.filter((request) => request.kind === 'hook-execute'),
  ).toHaveLength(1);
});

it('cancels a saved marker by its external id and never dispatches its cancelled intent', async () => {
  const originalCommit = session.authority.commitExtensionRecord.bind(
    session.authority,
  );
  const commit = vi
    .spyOn(session.authority, 'commitExtensionRecord')
    .mockImplementation(async (command, request, actor) => {
      const record = request.record as {
        hookId?: string;
        run: { execution: string };
      };
      if (
        record.hookId === 'before' &&
        record.run.execution === 'dispatch_started'
      )
        throw new Error('crash before dispatch');
      return originalCommit(command, request, actor);
    });
  await expect(
    hooks.fire(HookEventName.PreToolUse, 'call-1', {}, signal()),
  ).rejects.toThrow('crash before dispatch');
  commit.mockRestore();
  const marker = await hooks.status('call-1', true);
  expect(marker.run.state).toBe('cancelled');
  expect(hooks.hasCompletedOccurrence(HookEventName.PreToolUse, 'call-1')).toBe(
    true,
  );
  expect(
    (await hooks.fire(HookEventName.PreToolUse, 'call-1', {}, signal()))
      ?.decision,
  ).toBe('block');
  expect(
    requests.filter((request) => request.kind === 'hook-execute'),
  ).toHaveLength(0);
  const child = session.authority
    .extensionRecordsInDomain('hook_execution')
    .find((entry) => entry.recordId !== marker.hookExecutionId)!;
  expect(child.run).toMatchObject({
    state: 'cancelled',
    execution: 'not_started_proven',
  });
});

it('applies failClosed when a lost reply is settled through status after reconstruction', async () => {
  execute = async () => {
    throw new Error('lost reply');
  };
  await expect(
    hooks.fire(HookEventName.PreToolUse, 'call-1', {}, signal()),
  ).rejects.toBeInstanceOf(HostedHookRecoveryRequiredError);
  const execution = requests.find(
    (request) => request.kind === 'hook-execute',
  )!;
  replies.set(execution.operationId, {
    operationId: execution.operationId,
    state: 'settled',
    result: {
      success: false,
      outcome: 'non_blocking_error',
      duration: 0,
      error: 'timeout',
    },
  });
  await reopenSession();
  const replacement = new HostedHookSession(options, session, pin);
  const statuses = await Promise.all([
    replacement.status('call-1'),
    replacement.status('call-1'),
  ]);
  expect(statuses.map((record) => record.run.state)).toEqual([
    'settled',
    'settled',
  ]);
  expect(replacement.hasPendingOperations).toBe(false);
  expect(
    (await replacement.fire(HookEventName.PreToolUse, 'call-1', {}, signal()))
      ?.decision,
  ).toBe('block');
  expect(
    requests.filter((request) => request.kind === 'hook-execute'),
  ).toHaveLength(1);
  await replacement.close();
  const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
  expect(release).toHaveBeenCalledOnce();
  expect(release.mock.instances[0]).toMatchObject({
    runtimeSessionId: hooks.broker.runtimeSessionId,
  });
});

it('waits for Runtime admission before acknowledging an async Hook', async () => {
  catalog = { ...catalog, hooks: [{ ...catalog.hooks[0], async: true }] };
  let finish: ((result: ManagedHookResult) => void) | undefined;
  execute = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  let completed = false;
  const firing = hooks
    .fire(HookEventName.PreToolUse, 'call-1', {}, signal())
    .then((result) => {
      completed = true;
      return result;
    });
  await vi.waitFor(() => expect(finish).toBeDefined());
  expect(completed).toBe(false);
  finish!({ success: true, outcome: 'success', duration: 0 });
  await firing;
  expect(completed).toBe(true);
});

it('rejects async prompt Hooks instead of leaving a detached model request', async () => {
  catalog = {
    ...catalog,
    hooks: [
      {
        ...catalog.hooks[0],
        async: true,
        config: { type: HookType.Prompt, prompt: 'Decide' },
      },
    ],
  };
  await expect(hooks.ensureReady()).rejects.toThrow('Hook catalog unavailable');
  expect(
    session.authority.extensionRecordsInDomain('hook_registration'),
  ).toHaveLength(0);
});

it('rejects a changed input while the same occurrence is still running', async () => {
  let finish: ((result: ManagedHookResult) => void) | undefined;
  execute = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const firing = hooks.fire(
    HookEventName.PreToolUse,
    'call-1',
    { tool_name: 'read_file' },
    signal(),
  );
  await vi.waitFor(() => expect(finish).toBeDefined());
  await expect(
    hooks.fire(
      HookEventName.PreToolUse,
      'call-1',
      { tool_name: 'write_file' },
      signal(),
    ),
  ).rejects.toThrow(HostedHookInputConflictError);
  expect(hooks.hasPendingOperations).toBe(true);
  finish!({ success: true, outcome: 'success', duration: 0 });
  await firing;
  expect(hooks.hasPendingOperations).toBe(false);
});

it('cancels an active occurrence and does not dispatch later sequential hooks', async () => {
  catalog = {
    ...catalog,
    hooks: [
      { ...catalog.hooks[0], sequential: true },
      { ...catalog.hooks[0], sequential: true, hookId: 'second' },
    ],
  };
  let finish: ((result: ManagedHookResult) => void) | undefined;
  execute = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const firing = hooks.fire(HookEventName.PreToolUse, 'call-1', {}, signal());
  await vi.waitFor(() => expect(finish).toBeDefined());
  const cancelled = await hooks.status('call-1', true);
  expect(cancelled.cancelRequested).toBe(true);
  finish!({ success: false, outcome: 'cancelled', duration: 0 });
  expect((await firing)?.decision).toBe('block');
  expect(
    requests.filter((request) => request.kind === 'hook-execute'),
  ).toHaveLength(1);
  expect((await hooks.status('call-1')).run.state).toBe('cancelled');
  expect(hooks.hasPendingOperations).toBe(false);
});

it('refuses an ambiguous external occurrence id', async () => {
  await hooks.fire(HookEventName.PreToolUse, 'shared', {}, signal());
  await hooks.fire(HookEventName.Notification, 'shared', {}, signal());
  await expect(hooks.status('shared')).rejects.toThrow('ambiguous');
});

it('refuses a replacement binding while resuming a later intent on the original Runtime Session', async () => {
  catalog = {
    ...catalog,
    hooks: [
      { ...catalog.hooks[0], sequential: true },
      { ...catalog.hooks[0], sequential: true, hookId: 'second' },
    ],
  };
  const originalCommit = session.authority.commitExtensionRecord.bind(
    session.authority,
  );
  const commit = vi
    .spyOn(session.authority, 'commitExtensionRecord')
    .mockImplementation(async (command, request, actor) => {
      const record = request.record as {
        hookId?: string;
        run: { execution: string };
      };
      if (
        record.hookId === 'second' &&
        record.run.execution === 'dispatch_started'
      )
        throw new Error('crash before second dispatch');
      return originalCommit(command, request, actor);
    });
  await expect(
    hooks.fire(HookEventName.PreToolUse, 'call-1', {}, signal()),
  ).rejects.toThrow('crash before second dispatch');
  commit.mockRestore();
  vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
    async function (this: HostedWorkspaceBroker) {
      this.runtime = {
        bindingId: 'replacement',
        generation: '2',
        workspaceGeneration: '2',
      };
    },
  );
  const replacement = new HostedHookSession(options, session, pin);
  await expect(
    replacement.fire(HookEventName.PreToolUse, 'call-1', {}, signal()),
  ).rejects.toBeInstanceOf(HostedHookRecoveryRequiredError);
  expect(
    requests.filter((request) => request.kind === 'hook-execute'),
  ).toHaveLength(1);
});

it('cancels a detached child after its async marker has admitted it', async () => {
  catalog = { ...catalog, hooks: [{ ...catalog.hooks[0], async: true }] };
  const control = vi.spyOn(HostedWorkspaceBroker.prototype, 'hookControl');
  const originalControl = control.getMockImplementation()!;
  control.mockImplementation(async function (
    this: HostedWorkspaceBroker,
    operation,
  ) {
    if (operation.kind === 'hook-execute') {
      requests.push(operation);
      const running: ManagedHookOperationView = {
        operationId: operation.operationId,
        state: 'running',
      };
      replies.set(operation.operationId, running);
      return running;
    }
    if (operation.kind === 'hook-cancel')
      replies.set(operation.targetOperationId, {
        operationId: operation.targetOperationId,
        state: 'settled',
        result: { success: false, outcome: 'cancelled', duration: 0 },
      });
    return originalControl.call(this, operation);
  });
  await hooks.fire(HookEventName.PreToolUse, 'call-1', {}, signal());
  expect(hooks.hasPendingOperations).toBe(false);
  const nextPin = {
    ...pin,
    catalogRevision: 2,
    definitionDigest: 'b'.repeat(64),
  };
  catalog = { ...catalog, ...nextPin };
  await hooks.configure('async-replacement', nextPin, 1);
  expect(hooks.getCatalog()).toMatchObject(nextPin);
  expect(hooks.hasCompletedOccurrence(HookEventName.PreToolUse, 'call-1')).toBe(
    true,
  );
  await hooks.status('call-1', true);
  await vi.waitFor(() =>
    expect(
      session.authority
        .extensionRecordsInDomain('hook_execution')
        .filter((record) => !record.recordId.startsWith('hook-plan-'))
        .map((record) => record.run.state),
    ).toEqual(['cancelled']),
  );
  expect(
    requests.filter((request) => request.kind === 'hook-cancel').length,
  ).toBeGreaterThan(0);
});

it.each([
  'managed_hook_handler_unavailable',
  'managed_hook_command_isolation_unavailable',
])(
  'keeps %s blocked without marking an effect as dispatched or retrying it',
  async (code) => {
    const control = vi.spyOn(HostedWorkspaceBroker.prototype, 'hookControl');
    const originalControl = control.getMockImplementation()!;
    control.mockImplementation(async function (
      this: HostedWorkspaceBroker,
      operation,
    ) {
      if (operation.kind === 'hook-execute') {
        requests.push(operation);
        return {
          operationId: operation.operationId,
          state: 'settled',
          error: { code },
        };
      }
      return originalControl.call(this, operation);
    });
    await expect(
      hooks.fire(HookEventName.PreToolUse, 'call-1', {}, signal()),
    ).rejects.toBeInstanceOf(HostedHookRecoveryRequiredError);
    const child = session.authority
      .extensionRecordsInDomain('hook_execution')
      .find(
        (entry) =>
          entry.recordId.startsWith('hook-') &&
          !entry.recordId.startsWith('hook-plan-'),
      )!;
    expect(child.run).toMatchObject({
      state: 'recovery_blocked',
      execution: 'not_started_proven',
      reason: 'handler_unavailable',
    });
    expect(hooks.hasPendingOperations).toBe(true);
    await expect(
      hooks.fire(HookEventName.PreToolUse, 'call-1', {}, signal()),
    ).rejects.toBeInstanceOf(HostedHookRecoveryRequiredError);
    expect(
      requests.filter((request) => request.kind === 'hook-execute'),
    ).toHaveLength(1);
    await hooks.status('call-1', true);
    expect(hooks.hasPendingOperations).toBe(false);
  },
);

it('drains async execution before lifecycle hooks and retains the Runtime owner until close', async () => {
  catalog = {
    ...catalog,
    hooks: [
      { ...catalog.hooks[0], async: true },
      {
        ...catalog.hooks[0],
        hookId: 'end',
        eventName: HookEventName.SessionEnd,
      },
    ],
  };
  const control = vi.spyOn(HostedWorkspaceBroker.prototype, 'hookControl');
  const originalControl = control.getMockImplementation()!;
  control.mockImplementation(async function (
    this: HostedWorkspaceBroker,
    operation,
  ) {
    if (operation.kind === 'hook-execute' && operation.hookId === 'before') {
      requests.push(operation);
      const running: ManagedHookOperationView = {
        operationId: operation.operationId,
        state: 'running',
      };
      replies.set(operation.operationId, running);
      return running;
    }
    if (operation.kind === 'hook-cancel')
      replies.set(operation.targetOperationId, {
        operationId: operation.targetOperationId,
        state: 'settled',
        result: { success: false, outcome: 'cancelled', duration: 0 },
      });
    return originalControl.call(this, operation);
  });
  const release = vi.spyOn(HostedWorkspaceBroker.prototype, 'release');
  await hooks.fire(HookEventName.PreToolUse, 'call-1', {}, signal());
  await hooks.drain();
  expect(release).not.toHaveBeenCalled();
  expect(
    session.authority
      .extensionRecordsInDomain('hook_execution')
      .find((entry) => !entry.recordId.startsWith('hook-plan-'))?.run.state,
  ).toBe('cancelled');
  await hooks.fire(HookEventName.SessionEnd, 'end-1', {}, signal());
  const dispatched = requests.filter(
    (request) => request.kind === 'hook-execute',
  );
  expect(dispatched.map((request) => request.hookId)).toEqual([
    'before',
    'end',
  ]);
  await hooks.close();
  expect(release).toHaveBeenCalledOnce();
  expect(release.mock.instances[0]).toBe(hooks.broker);
});

it('releases its broker when a tool turn acquired it after catalog restoration', async () => {
  await hooks.ensureReady();
  const replacement = new HostedHookSession(options, session, pin);
  await replacement.ensureReady();
  await replacement.broker.acquire();
  const release = vi.spyOn(HostedWorkspaceBroker.prototype, 'release');
  release.mockClear();
  await replacement.close();
  expect(release).toHaveBeenCalledOnce();
  expect(release.mock.instances[0]).toBe(replacement.broker);
});

it.each(['catalog', 'settled', 'lost-ack'])(
  'releases an earlier owner before acquiring a replacement (%s)',
  async (phase) => {
    const lostAck = phase === 'lost-ack';
    let owner: string | undefined;
    const acquire = vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire');
    const originalAcquire = acquire.getMockImplementation()!;
    acquire.mockImplementation(async function (this: HostedWorkspaceBroker) {
      if (owner && owner !== this.runtimeSessionId)
        throw new HostedWorkspaceBrokerRejection(
          409,
          'workspace_execution_busy',
        );
      owner = this.runtimeSessionId;
      await originalAcquire.call(this);
    });
    const release = vi.spyOn(HostedWorkspaceBroker.prototype, 'release');
    release.mockImplementation(async function (this: HostedWorkspaceBroker) {
      if (owner === this.runtimeSessionId) owner = undefined;
    });
    if (lostAck)
      execute = async () => {
        throw new Error('lost reply');
      };
    const firing =
      phase === 'catalog'
        ? hooks.ensureReady()
        : hooks.fire(HookEventName.PreToolUse, 'old', {}, signal());
    if (lostAck)
      await expect(firing).rejects.toBeInstanceOf(
        HostedHookRecoveryRequiredError,
      );
    else await firing;
    await reopenSession();
    const replacement = new HostedHookSession(options, session, pin);
    await replacement.ensureReady();
    if (lostAck) {
      await expect(replacement.acquire()).rejects.toThrow(
        'workspace_execution_busy',
      );
      expect(release).not.toHaveBeenCalled();
      const child = requests.find(
        (request) => request.kind === 'hook-execute',
      )!;
      replies.set(child.operationId, {
        operationId: child.operationId,
        state: 'settled',
        result: { success: true, outcome: 'success', duration: 0 },
      });
      expect((await replacement.status('old')).resultRef).not.toBeNull();
    }
    await replacement.acquire();
    expect(owner).toBe(replacement.broker.runtimeSessionId);
    expect(release).toHaveBeenCalledOnce();
    expect(release.mock.contexts[0]).toMatchObject({
      runtimeSessionId: hooks.broker.runtimeSessionId,
    });
    await replacement.close();
    expect(release).toHaveBeenCalledTimes(2);
    expect(owner).toBeUndefined();
    expect(
      requests.filter((request) => request.kind === 'hook-execute'),
    ).toHaveLength(phase === 'catalog' ? 0 : 1);
  },
);

it.each([
  { status: 404, code: 'runtime_session_not_found', allowed: true },
  { status: 404, code: 'other_not_found', allowed: false },
  { status: 409, code: 'runtime_session_busy', allowed: false },
])(
  'reconciles only absent earlier owners ($code)',
  async ({ status, code, allowed }) => {
    await hooks.ensureReady();
    await hooks.close();
    await reopenSession();
    const unacquired = new HostedHookSession(options, session, pin);
    await unacquired.fire(HookEventName.Notification, 'empty', {}, signal());
    expect(unacquired.broker.runtime).toBeUndefined();
    const refusal = new HostedWorkspaceBrokerRejection(status, code);
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockImplementation(async function (this: HostedWorkspaceBroker) {
        if (this.runtimeSessionId === unacquired.broker.runtimeSessionId)
          throw refusal;
      });
    await reopenSession();
    const replacement = new HostedHookSession(options, session, pin);
    if (allowed) await replacement.acquire();
    else await expect(replacement.acquire()).rejects.toBe(refusal);
    expect(release.mock.contexts).toContainEqual(
      expect.objectContaining({
        runtimeSessionId: unacquired.broker.runtimeSessionId,
      }),
    );
    expect(Boolean(replacement.broker.runtime)).toBe(allowed);
  },
);

async function operate(
  managed: ManagedSession,
  target: HostedHookSession,
  id: string,
): Promise<void> {
  catalog = {
    ...catalog,
    hooks: [{ ...catalog.hooks[0], eventName: HookEventName.Notification }],
  };
  await target.ensureReady();
  await new ManagedHookActivationController(managed).runHookOperation(
    {
      operationId: id,
      occurrenceId: hostedHookOccurrenceId(HookEventName.Notification, id),
      originTurnId: null,
    },
    () => target.fire(HookEventName.Notification, id, {}, signal()),
  );
}

function released(): string[] {
  const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
  const ids = release.mock.contexts.map(
    (broker) => (broker as HostedWorkspaceBroker).runtimeSessionId,
  );
  release.mockClear();
  return ids;
}

it.each([true, false])(
  'releases only load owners after Hook operations replace the activation (detached: %s)',
  async (detached) => {
    for (const id of ['a', 'b', 'c']) await operate(session, hooks, id);
    if (detached) {
      await hooks.close();
      expect(released()).toEqual([hooks.broker.runtimeSessionId]);
    }
    await reopenSession();
    const replacement = new HostedHookSession(options, session, pin);
    await operate(session, replacement, 'd');
    expect(released()).toEqual([hooks.broker.runtimeSessionId]);
    await operate(session, replacement, 'e');
    await replacement.close();
    expect(released()).toEqual([replacement.broker.runtimeSessionId]);
  },
);

it('skips the restore after a Hook operation activation fails to install', async () => {
  vi.spyOn(session.authority, 'installActivation').mockRejectedValueOnce(
    new Error('install resource failed'),
  );
  await expect(operate(session, hooks, 'a')).rejects.toThrow(
    'install resource failed',
  );
  await hooks.close();
  expect(released()).toEqual([hooks.broker.runtimeSessionId]);
});

it('skips a restore that replaces an unrestored Hook operation activation', async () => {
  const install = session.authority.installActivation.bind(session.authority);
  vi.spyOn(session.authority, 'installActivation')
    .mockImplementationOnce(install)
    .mockRejectedValueOnce(new Error('restore install failed'));
  await expect(operate(session, hooks, 'a')).rejects.toThrow(
    'restore install failed',
  );
  // The next restore derives from the first operation's own activation.
  await operate(session, hooks, 'b');
  await hooks.close();
  expect(released()).toEqual([hooks.broker.runtimeSessionId]);
});

it.each([
  ['after its install', false],
  ['after the Hook operation activation it renews is released', true],
])('skips an activation renewal recorded %s', async (_, late) => {
  const { authority } = session;
  const append = authority.appendExecutionEvent.bind(authority);
  const renewals: Array<Promise<unknown>> = [];
  if (late)
    vi.spyOn(authority, 'appendExecutionEvent').mockImplementation(
      (command, event, actor) => {
        const pending = append(command, event, actor);
        // The renewal timer can fire while the release is still committing.
        if (
          command.operation === 'releaseActivation' &&
          authority.currentActivationSubject?.type === 'hook_operation'
        )
          renewals.push(authority.renewActivation({ leaseDurationMs: 60_000 }));
        return pending;
      },
    );
  await operate(session, hooks, 'a');
  if (!late) await authority.renewActivation({ leaseDurationMs: 60_000 });
  await Promise.all(renewals);
  const changes = authority
    .eventsInSequenceRange(1, authority.committedSequence)
    .filter((event) => event.kind === 'activation.changed');
  // A late renewal is possible only because renewActivation checks the phase
  // outside the authority's serial queue. Once that race is closed, the late
  // case can no longer be produced and should be removed.
  expect(
    changes.some(
      (event, index) =>
        event.payload['renewalSeq'] !== undefined &&
        changes[index - 1].payload['phase'] === 'released' &&
        changes[index - 1].payload['activationId'] ===
          event.payload['activationId'],
    ),
  ).toBe(late);
  await hooks.close();
  expect(released()).toEqual([hooks.broker.runtimeSessionId]);
});

it.each([
  ['released before another worker loads', true, false],
  ['still open when the same worker installs', false, true],
  ['released before the same worker loads again', true, true],
])(
  'still releases a load that follows an unrestored Hook operation activation (%s)',
  async (_, releasedFirst, sameWorker) => {
    await hooks.ensureReady();
    await session.replaceActivation({
      type: 'hook_operation',
      operationId: 'lost',
      occurrenceId: 'lost',
    });
    if (releasedFirst) await session.releaseActivation();
    let crashed: HostedHookSession;
    if (sameWorker) {
      const activation = await session.authority.installActivation({
        activationId: randomUUID(),
        workerId: 'worker',
        leaseDurationMs: 60_000,
      });
      crashed = new HostedHookSession(options, { ...session, activation }, pin);
    } else {
      await reopenSession();
      crashed = new HostedHookSession(options, session, pin);
    }
    await crashed.acquire();
    await reopenSession();
    const replacement = new HostedHookSession(options, session, pin);
    vi.mocked(HostedWorkspaceBroker.prototype.release).mockClear();
    await replacement.acquire();
    expect(released()).toEqual([
      hooks.broker.runtimeSessionId,
      crashed.broker.runtimeSessionId,
    ]);
  },
);

it('shares one acquisition between parallel callers', async () => {
  await hooks.ensureReady();
  await reopenSession();
  const replacement = new HostedHookSession(options, session, pin);
  const acquire = vi.mocked(HostedWorkspaceBroker.prototype.acquire);
  vi.mocked(HostedWorkspaceBroker.prototype.release).mockClear();
  acquire.mockClear();
  await Promise.all([replacement.acquire(), replacement.acquire()]);
  expect(released()).toEqual([hooks.broker.runtimeSessionId]);
  expect(acquire).toHaveBeenCalledOnce();
});

it('leaves a shared MCP broker for its owner to release', async () => {
  const shared = new HostedWorkspaceBroker(
    options,
    session.authority.sessionHeader.sessionKey,
    'mcp-shared',
  );
  const linked = new HostedHookSession(options, session, pin, shared);
  await linked.ensureReady();
  const release = vi.spyOn(HostedWorkspaceBroker.prototype, 'release');
  release.mockClear();
  await linked.close();
  expect(release).not.toHaveBeenCalled();
});

it('requires increasing revisions within each catalog namespace', async () => {
  await hooks.ensureReady();
  await expect(hooks.configure('duplicate', pin, 1)).rejects.toThrow(
    'must advance',
  );
  const next = { ...pin, catalogRevision: 2, definitionDigest: 'b'.repeat(64) };
  catalog = { ...catalog, ...next };
  await hooks.configure('next', next, 1);
  await expect(hooks.configure('rollback', pin, 2)).rejects.toThrow(
    'must advance',
  );
  const other = { ...pin, catalogId: 'other' };
  catalog = { ...catalog, ...other };
  await hooks.configure('other', other, 2);
  expect(hooks.getCatalog()).toMatchObject(other);
  await expect(hooks.configure('reuse-old-namespace', next, 3)).rejects.toThrow(
    'must advance',
  );
});

it('restores prompt execution requirements from the original plan after catalog replacement', async () => {
  catalog = {
    ...catalog,
    hooks: [
      {
        ...catalog.hooks[0],
        config: { type: HookType.Prompt, prompt: 'check' },
      },
    ],
  };
  const runner = vi
    .fn<import('./hosted-hook-session.js').HostedPromptHookRunner>()
    .mockRejectedValue(new Error('model owner lost'));
  await expect(
    hooks.fire(
      HookEventName.PreToolUse,
      'original-plan',
      { tool_name: 'read_file' },
      signal(),
      runner,
    ),
  ).rejects.toThrow('model owner lost');
  catalog = { ...catalog, catalogRevision: 2, hooks: [] };
  await hooks.configure('replacement', { ...pin, catalogRevision: 2 }, 1);
  expect(
    await hooks.needsPromptRunner(HookEventName.PreToolUse, 'original-plan'),
  ).toBe(true);
  expect(
    await hooks.needsPromptRunner(HookEventName.PreToolUse, 'new-plan'),
  ).toBe(false);
});

it('preserves the original Session message snapshot when a function occurrence is replayed', async () => {
  catalog = {
    ...catalog,
    hooks: [{ ...catalog.hooks[0], config: { type: HookType.Function } }],
  };
  const user = {
    uuid: randomUUID(),
    parentUuid: null,
    sessionId: session.authority.sessionHeader.sessionKey.sessionId,
    timestamp: new Date().toISOString(),
    type: 'user' as const,
    cwd: root,
    version: 'test',
    message: { role: 'user' as const, parts: [{ text: 'original context' }] },
  };
  await session.sink.write(user);
  await hooks.fire(HookEventName.PreToolUse, 'call-1', {}, signal());
  const dispatched = requests.find(
    (request) => request.kind === 'hook-execute',
  );
  expect(dispatched?.input).toMatchObject({ messages: [user.message] });
  await session.sink.write({
    ...user,
    uuid: randomUUID(),
    parentUuid: user.uuid,
    message: { role: 'user', parts: [{ text: 'later context' }] },
  });
  const restored = new HostedHookSession(options, session, pin);
  await restored.fire(HookEventName.PreToolUse, 'call-1', {}, signal());
  expect(
    requests.filter((request) => request.kind === 'hook-execute'),
  ).toHaveLength(1);
});

it.each(['decision', 'continue'] as const)(
  'restores a Stop %s continuation only for the originating prompt after Session reopen',
  async (kind) => {
    catalog = {
      ...catalog,
      hooks: [{ ...catalog.hooks[0], eventName: HookEventName.Stop }],
    };
    expect(await hooks.wasStopBlocked('prompt-1')).toBe(false);
    execute = async () => ({
      success: true,
      outcome: 'blocking',
      duration: 0,
      output:
        kind === 'decision'
          ? { decision: 'block', reason: 'continue work' }
          : { continue: false, stopReason: 'continue work' },
    });
    await hooks.fire(
      HookEventName.Stop,
      'stop-1',
      { prompt_id: 'prompt-1' },
      signal(),
    );
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
    const restored = new HostedHookSession(options, session, pin);
    expect(await restored.wasStopBlocked('prompt-1')).toBe(true);
    expect(await restored.wasStopBlocked('prompt-2')).toBe(false);
  },
);

it('reads each saved Stop plan once however many turns check it', async () => {
  catalog = {
    ...catalog,
    hooks: [{ ...catalog.hooks[0], eventName: HookEventName.Stop }],
  };
  for (let turn = 0; turn < 12; turn++)
    await hooks.fire(
      HookEventName.Stop,
      `stop-${turn}`,
      { prompt_id: `prompt-${turn}` },
      signal(),
    );
  const read = vi.spyOn(session.resources, 'read');
  const plans = () =>
    read.mock.calls.filter(([ref]) => ref.kind === 'managed-hook-plan').length;
  for (let turn = 12; turn < 20; turn++)
    expect(await hooks.wasStopBlocked(`prompt-${turn}`)).toBe(false);
  expect(plans()).toBe(12);
  // A replacement Harness reads them once again, then not per turn.
  const restored = new HostedHookSession(options, session, pin);
  for (let turn = 0; turn < 3; turn++)
    expect(await restored.wasStopBlocked('prompt-new')).toBe(false);
  expect(plans()).toBe(24);
});

it('drains a long settled history without rescanning it per occurrence', async () => {
  catalog = {
    ...catalog,
    hooks: [{ ...catalog.hooks[0], eventName: HookEventName.Notification }],
  };
  for (let index = 0; index < 30; index++)
    await hooks.fire(
      HookEventName.Notification,
      `notification-${index}`,
      { message: `${index}` },
      signal(),
    );
  const scans = vi.spyOn(session.authority, 'extensionRecordsInDomain');
  const commits = vi.spyOn(session.authority, 'commitExtensionRecord');
  await hooks.drain();
  expect(commits).not.toHaveBeenCalled();
  // A fixed number of passes over the history, not one per occurrence.
  expect(scans.mock.calls.length).toBeLessThanOrEqual(3);
});

it('settles an occurrence whose children were committed after an earlier status check', async () => {
  await hooks.fire(HookEventName.PreToolUse, 'call-1', {}, signal());
  // A replacement Harness checks one occurrence before another commits.
  const replacement = new HostedHookSession(options, session, pin);
  expect((await replacement.status('call-1')).resultRef).not.toBeNull();
  execute = async () => {
    throw new Error('lost reply');
  };
  await expect(
    hooks.fire(HookEventName.PreToolUse, 'call-2', {}, signal()),
  ).rejects.toBeInstanceOf(HostedHookRecoveryRequiredError);
  const child = requests.filter(
    (request) => request.kind === 'hook-execute',
  )[1]!;
  replies.set(child.operationId, {
    operationId: child.operationId,
    state: 'settled',
    result: { success: true, outcome: 'success', duration: 0 },
  });
  // Its status reads the new child's reply, so the occurrence settles.
  expect((await replacement.status('call-2')).resultRef).not.toBeNull();
});

it.each([false, true])(
  'preserves a large Session context within individual resource limits (function Hook: %s)',
  async (hasFunction) => {
    catalog = {
      ...catalog,
      hooks: hasFunction
        ? [{ ...catalog.hooks[0], config: { type: HookType.Function } }]
        : [],
    };
    const messages = Array.from({ length: 4 }, (_, index) => ({
      role: 'user',
      parts: [{ text: `${index}:` + '会话上下文'.repeat(3000) }],
    }));
    hooks.setMessagesProvider(() => messages);
    const publish = session.resources.publish.bind(session.resources);
    const resourceSizes: number[] = [];
    vi.spyOn(session.resources, 'publish').mockImplementation(
      async (kind, bytes) => {
        expect(bytes.length).toBeLessThanOrEqual(64 * 1024);
        resourceSizes.push(bytes.length);
        return publish(kind, bytes);
      },
    );
    await hooks.fire(HookEventName.PreToolUse, 'large-context', {}, signal());
    const dispatched = requests.filter(
      (request) => request.kind === 'hook-execute',
    );
    expect(dispatched).toHaveLength(hasFunction ? 1 : 0);
    if (hasFunction) expect(dispatched[0].input).toMatchObject({ messages });
    else expect(resourceSizes.every((size) => size < 4096)).toBe(true);
    const restored = new HostedHookSession(options, session, pin);
    await restored.fire(
      HookEventName.PreToolUse,
      'large-context',
      {},
      signal(),
    );
    expect(
      requests.filter((request) => request.kind === 'hook-execute'),
    ).toHaveLength(hasFunction ? 1 : 0);
  },
);

it.each([8 * 1024 * 1024 - 256, 8 * 1024 * 1024 + 1])(
  'durably refuses a %s-byte snapshot before publishing its transaction',
  async (length) => {
    catalog = {
      ...catalog,
      hooks: [{ ...catalog.hooks[0], config: { type: HookType.Function } }],
    };
    hooks.setMessagesProvider(() => [{ text: 'x'.repeat(length) }]);
    const publish = vi.spyOn(session.resources, 'publish');
    const output = await hooks.fire(
      HookEventName.PreToolUse,
      'oversized',
      {},
      signal(),
    );
    expect(output?.decision).toBe('block');
    expect(output?.reason).toContain('8 MiB');
    expect(
      requests.filter((request) => request.kind === 'hook-execute'),
    ).toHaveLength(0);
    expect(
      session.authority.extensionRecordsInDomain('hook_execution'),
    ).toHaveLength(1);
    expect(
      publish.mock.calls.some(([kind]) => kind === 'managed-hook-message-part'),
    ).toBe(false);
    expect((await hooks.status('oversized')).run.state).toBe('settled');
    expect(hooks.hasPendingOperations).toBe(false);
    const restored = new HostedHookSession(options, session, pin);
    expect(
      await restored.fire(HookEventName.PreToolUse, 'oversized', {}, signal()),
    ).toEqual(output);
  },
);

it.each([false, true])(
  'settles a real oversized Hook result with the saved fail policy (closed: %s)',
  async (failClosed) => {
    const key = session.authority.sessionHeader.sessionKey;
    const modulePath = path.join(root, 'oversized-handler.mjs');
    const counter = path.join(root, 'oversized-counter');
    await writeFile(
      modulePath,
      `import {appendFileSync} from 'node:fs';
      export const handler = {handlerRevision: 1, callback: async () => {
        appendFileSync(${JSON.stringify(counter)}, 'x');
        return {systemMessage: 'x'.repeat(70 * 1024)};
      }};`,
    );
    const runtime = new ManagedHookRuntime(
      { ...key, workspaceGeneration: '1' },
      async () => root,
      {
        version: 1,
        catalogs: [
          {
            ...pin,
            tenantId: key.tenantId,
            workspaceId: key.workspaceId,
            hooks: [
              {
                ...catalog.hooks[0],
                failClosed,
                config: { type: HookType.Function, timeout: 1000 },
                handler: {
                  handlerId: 'large',
                  handlerRevision: 1,
                  modulePath,
                  exportName: 'handler',
                },
              },
            ],
          },
        ],
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'hookControl').mockImplementation(
      function (this: HostedWorkspaceBroker, operation) {
        return runtime.control(this.runtimeSessionId, operation);
      },
    );
    try {
      const output = await hooks.fire(
        HookEventName.PreToolUse,
        'large-output',
        {},
        signal(),
      );
      expect(output?.decision).toBe(failClosed ? 'block' : undefined);
      expect(hooks.hasPendingOperations).toBe(false);
      expect((await hooks.status('large-output')).run.state).toBe('settled');
      expect(runtime.hasHolds(hooks.broker.runtimeSessionId)).toBe(false);
      const restored = new HostedHookSession(options, session, pin);
      expect(
        await restored.fire(
          HookEventName.PreToolUse,
          'large-output',
          {},
          signal(),
        ),
      ).toEqual(output);
      expect(restored.hasPendingOperations).toBe(false);
      expect(await readFile(counter, 'utf8')).toBe('x');
    } finally {
      await runtime.close();
    }
  },
);

it.each([
  [HookEventName.PreToolUse, false],
  [HookEventName.PermissionRequest, false],
  [HookEventName.PreToolUse, true],
  [HookEventName.PermissionRequest, true],
] as const)(
  'persists a hard capacity refusal for fail-open %s Hooks across reconstruction (async: %s)',
  async (eventName, async) => {
    catalog = {
      ...catalog,
      hooks: [{ ...catalog.hooks[0], eventName, async, failClosed: false }],
    };
    execute = async () => ({
      success: false,
      outcome: 'blocking',
      duration: 0,
      output: {
        continue: false,
        decision: 'block',
        reason: 'Managed Hook receipt capacity is exhausted.',
        ...(eventName === HookEventName.PermissionRequest
          ? {
              hookSpecificOutput: {
                decision: { behavior: 'deny', interrupt: true },
              },
            }
          : {}),
      },
    });
    const output = await hooks.fire(eventName, 'full', {}, signal());
    if (eventName === HookEventName.PermissionRequest)
      expect(output?.hookSpecificOutput?.['decision']).toMatchObject({
        behavior: 'deny',
        interrupt: true,
      });
    else expect(output?.decision).toBe('block');
    expect(hooks.hasPendingOperations).toBe(false);
    expect((await hooks.status('full')).resultRef).not.toBeNull();
    const replacement = new HostedHookSession(options, session, pin);
    expect(await replacement.fire(eventName, 'full', {}, signal())).toEqual(
      output,
    );
    expect(
      requests.filter((request) => request.kind === 'hook-execute'),
    ).toHaveLength(1);
  },
);

it.each([false, true])(
  'settles parallel quota refusals after a lost reply using the saved fail policy (closed: %s)',
  async (failClosed) => {
    const key = session.authority.sessionHeader.sessionKey;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const execute = vi
      .spyOn(HttpHookRunner.prototype, 'execute')
      .mockImplementation(async () => {
        await pending;
        return {
          hookConfig: { type: HookType.Http, url: 'https://example.com/hook' },
          eventName: HookEventName.PreToolUse,
          success: true,
          outcome: 'success',
          httpRequestState: 'response_received',
          duration: 1,
        };
      });
    const runtime = new ManagedHookRuntime(
      { ...key, workspaceGeneration: '1' },
      async () => root,
      {
        version: 1,
        catalogs: [
          {
            ...pin,
            tenantId: key.tenantId,
            workspaceId: key.workspaceId,
            hooks: Array.from({ length: 17 }, (_, index) => ({
              hookId: `hook-${index}`,
              eventName: HookEventName.PreToolUse,
              sequential: false,
              async: false,
              onceKey: null,
              failClosed,
              config: {
                type: HookType.Http,
                url: `https://example.com/hook-${index}`,
              },
            })),
          },
        ],
      },
    );
    let lostReplies = 0;
    vi.spyOn(HostedWorkspaceBroker.prototype, 'hookControl').mockImplementation(
      async function (this: HostedWorkspaceBroker, operation) {
        const view = await runtime.control(this.runtimeSessionId, operation);
        if (
          operation.kind === 'hook-execute' &&
          view.result?.success === false
        ) {
          release();
          if (lostReplies++ === 0) throw new Error('lost quota receipt');
        }
        return view;
      },
    );
    try {
      const output = await hooks.fire(
        HookEventName.PreToolUse,
        'quota',
        {},
        signal(),
      );
      expect(output?.decision).toBe(failClosed ? 'block' : undefined);
      expect(lostReplies).toBe(1);
      expect(hooks.hasPendingOperations).toBe(false);
      expect((await hooks.status('quota')).run.state).toBe('settled');
      expect(execute).toHaveBeenCalledTimes(16);
      expect(runtime.hasHolds(hooks.broker.runtimeSessionId)).toBe(false);
      const restored = new HostedHookSession(options, session, pin);
      expect(
        await restored.fire(HookEventName.PreToolUse, 'quota', {}, signal()),
      ).toEqual(output);
      expect(execute).toHaveBeenCalledTimes(16);
      await restored.fire(HookEventName.PreToolUse, 'next', {}, signal());
      expect(restored.hasPendingOperations).toBe(false);
      expect(execute).toHaveBeenCalledTimes(33);
    } finally {
      release();
      await runtime.close();
    }
  },
);

function enforceHostedResourceLimit() {
  const remote = createHttpManagedSessionStores({
    baseUrl: options.baseUrl,
    sessionKey: session.authority.sessionHeader.sessionKey,
    writerId: 'test',
  });
  const publish = session.resources.publish.bind(session.resources);
  vi.spyOn(session.resources, 'publish').mockImplementation(
    async (kind, bytes) => {
      await remote.resourceStore.publish(kind, bytes);
      return publish(kind, bytes);
    },
  );
}

it.each(['input', 'plan'] as const)(
  'durably refuses an oversized initial %s without dispatch or once consumption',
  async (limit) => {
    enforceHostedResourceLimit();
    const original = catalog.hooks[0];
    catalog = {
      ...catalog,
      hooks: [
        {
          ...original,
          onceKey: 'available',
          config:
            limit === 'plan'
              ? { type: HookType.Prompt, prompt: 'x'.repeat(35 * 1024) }
              : original.config,
        },
      ],
    };
    const fields = {
      tool_name: 'write_file',
      tool_input: {
        text: 'x'.repeat((limit === 'input' ? 70 : 35) * 1024),
        file: 'a',
      },
    };
    const publish = vi
      .mocked(session.resources.publish)
      .getMockImplementation()!;
    let failResult = true;
    vi.spyOn(session.resources, 'publish').mockImplementation(
      async (kind, bytes) => {
        if (kind === 'managed-hook-result' && failResult) {
          failResult = false;
          throw new Error('lost marker result');
        }
        return publish(kind, bytes);
      },
    );
    await expect(
      hooks.fire(HookEventName.PreToolUse, 'large-plan', fields, signal()),
    ).rejects.toThrow('lost marker result');
    const restored = new HostedHookSession(options, session, pin);
    expect((await restored.status('large-plan')).run.state).toBe('settled');
    const output = await restored.fire(
      HookEventName.PreToolUse,
      'large-plan',
      {
        tool_input: { file: 'a', text: fields.tool_input.text },
        tool_name: fields.tool_name,
      },
      signal(),
    );
    expect(output).toMatchObject({ continue: false, decision: 'block' });
    expect(restored.hasPendingOperations).toBe(false);
    await expect(
      restored.fire(
        HookEventName.PreToolUse,
        'large-plan',
        {
          ...fields,
          tool_input: { ...fields.tool_input, file: 'changed' },
        },
        signal(),
      ),
    ).rejects.toThrow('input conflict');
    expect(
      requests.filter((request) => request.kind === 'hook-execute'),
    ).toHaveLength(0);
    expect(
      session.authority
        .extensionRecordsInDomain('hook_execution')
        .map((entry) => parseHookExecution(entry.record).onceKey),
    ).toEqual([null]);
    catalog = {
      ...catalog,
      catalogRevision: 2,
      hooks: [{ ...original, onceKey: 'available' }],
    };
    await restored.configure('small-plan', { ...pin, catalogRevision: 2 }, 1);
    await restored.fire(HookEventName.PreToolUse, 'next', {}, signal());
    expect(
      requests.filter((request) => request.kind === 'hook-execute'),
    ).toHaveLength(1);
  },
);

function loseFinalMarkerWrite() {
  const commit = session.authority.commitExtensionRecord.bind(
    session.authority,
  );
  return vi
    .spyOn(session.authority, 'commitExtensionRecord')
    .mockImplementation((command, request, actor) => {
      const record = request.record as { hookId?: string; resultRef?: unknown };
      if (record.hookId === '__plan__' && record.resultRef)
        throw new Error('lost final marker write');
      return commit(command, request, actor);
    });
}

it.each([
  [HookEventName.PreToolUse, false],
  [HookEventName.PreToolUse, true],
  [HookEventName.PermissionRequest, false],
  [HookEventName.PermissionRequest, true],
] as const)(
  'bounds combined %s decisions without losing denial (lost marker: %s)',
  async (event, loseMarker) => {
    enforceHostedResourceLimit();
    catalog = {
      ...catalog,
      hooks: ['first', 'second'].map((hookId) => ({
        ...catalog.hooks[0],
        hookId,
        eventName: event,
        failClosed: false,
      })),
    };
    execute = async (operation) => ({
      success: true,
      outcome: 'success',
      duration: 0,
      output:
        event === HookEventName.PermissionRequest
          ? {
              hookSpecificOutput: {
                decision: {
                  behavior: operation.hookId === 'first' ? 'deny' : 'allow',
                  message: 'x'.repeat(36 * 1024),
                },
              },
            }
          : {
              decision: operation.hookId === 'first' ? 'deny' : 'allow',
              hookSpecificOutput: { additionalContext: 'x'.repeat(36 * 1024) },
            },
    });
    const lost = loseMarker ? loseFinalMarkerWrite() : undefined;
    const firing = hooks.fire(event, 'large-aggregate', {}, signal());
    if (lost) {
      await expect(firing).rejects.toThrow('lost final marker write');
      lost.mockRestore();
    } else await expect(firing).resolves.toMatchObject({ decision: 'block' });
    const restored = new HostedHookSession(options, session, pin);
    expect((await restored.status('large-aggregate')).run.state).toBe(
      'settled',
    );
    const output = await restored.fire(event, 'large-aggregate', {}, signal());
    expect(output).toMatchObject({ continue: false, decision: 'block' });
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(1024);
    if (event === HookEventName.PermissionRequest)
      expect(output?.hookSpecificOutput?.['decision']).toMatchObject({
        behavior: 'deny',
      });
    expect(restored.hasPendingOperations).toBe(false);
    const children = session.authority
      .extensionRecordsInDomain('hook_execution')
      .map((entry) => parseHookExecution(entry.record))
      .filter((entry) => entry.hookId !== '__plan__');
    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(child.run.execution).toBe('settled');
      const result = JSON.parse(
        (await session.resources.read(child.resultRef!)).toString(),
      );
      expect(result.success).toBe(true);
      expect(JSON.stringify(result.output).length).toBeGreaterThan(36 * 1024);
    }
    expect(
      requests.filter((request) => request.kind === 'hook-execute'),
    ).toHaveLength(2);
  },
);

it.each([false, true])(
  'stops before an oversized sequential input without consuming its once intent (lost marker: %s)',
  async (loseMarker) => {
    enforceHostedResourceLimit();
    catalog = {
      ...catalog,
      hooks: ['first', 'second', 'third'].map((hookId) => ({
        ...catalog.hooks[0],
        hookId,
        eventName: HookEventName.UserPromptSubmit,
        sequential: true,
        onceKey: hookId === 'third' ? 'third-once' : null,
      })),
    };
    execute = async () => ({
      success: true,
      outcome: 'success',
      duration: 0,
      output: {
        hookSpecificOutput: { additionalContext: 'x'.repeat(36 * 1024) },
      },
    });
    const lost = loseMarker ? loseFinalMarkerWrite() : undefined;
    const firing = hooks.fire(
      HookEventName.UserPromptSubmit,
      'large-sequential',
      { prompt: 'original' },
      signal(),
    );
    if (lost) {
      await expect(firing).rejects.toThrow('lost final marker write');
      lost.mockRestore();
    } else await expect(firing).resolves.toMatchObject({ decision: 'block' });
    const restored = new HostedHookSession(options, session, pin);
    expect((await restored.status('large-sequential')).run.state).toBe(
      'settled',
    );
    expect(
      await restored.fire(
        HookEventName.UserPromptSubmit,
        'large-sequential',
        { prompt: 'original' },
        signal(),
      ),
    ).toMatchObject({ continue: false, decision: 'block' });
    expect(restored.hasPendingOperations).toBe(false);
    expect(
      requests
        .filter((request) => request.kind === 'hook-execute')
        .map((request) => request.hookId),
    ).toEqual(['first', 'second']);
    expect(
      session.authority
        .extensionRecordsInDomain('hook_execution')
        .some(
          (entry) => parseHookExecution(entry.record).onceKey === 'third-once',
        ),
    ).toBe(false);
    catalog = { ...catalog, catalogRevision: 2, hooks: [catalog.hooks[2]] };
    await restored.configure('only-third', { ...pin, catalogRevision: 2 }, 1);
    await restored.fire(
      HookEventName.UserPromptSubmit,
      'later',
      { prompt: 'small' },
      signal(),
    );
    expect(
      requests
        .filter((request) => request.kind === 'hook-execute')
        .map((request) => request.hookId),
    ).toEqual(['first', 'second', 'third']);
  },
);

it.each([false, true])(
  'bounds a Harness prompt receipt using the original fail policy (closed: %s)',
  async (failClosed) => {
    enforceHostedResourceLimit();
    catalog = {
      ...catalog,
      hooks: [
        {
          ...catalog.hooks[0],
          failClosed,
          config: { type: HookType.Prompt, prompt: 'Decide' },
        },
      ],
    };
    const runner = vi
      .fn<import('./hosted-hook-session.js').HostedPromptHookRunner>()
      .mockResolvedValue({
        hookConfig: { type: HookType.Prompt, prompt: 'Decide' },
        eventName: HookEventName.PreToolUse,
        success: true,
        outcome: 'success',
        duration: 0,
        output: {
          hookSpecificOutput: { additionalContext: 'x'.repeat(70 * 1024) },
        },
      });
    const output = await hooks.fire(
      HookEventName.PreToolUse,
      'large-prompt',
      {},
      signal(),
      runner,
    );
    expect(output?.decision).toBe(failClosed ? 'block' : undefined);
    expect(hooks.hasPendingOperations).toBe(false);
    const restored = new HostedHookSession(options, session, pin);
    expect(
      await restored.fire(
        HookEventName.PreToolUse,
        'large-prompt',
        {},
        signal(),
        runner,
      ),
    ).toEqual(output);
    expect(runner).toHaveBeenCalledOnce();
  },
);
