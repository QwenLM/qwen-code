/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ToolConfirmationOutcome,
  type ManagedToolCallIdentity,
  type ManagedToolInvocationReference,
} from '@qwen-code/qwen-code-core';
import type { ManagedToolV2Client } from '@qwen-code/acp-bridge/bridgeTypes';
import { SERVE_CONTROL_EXT_METHODS as methods } from '@qwen-code/acp-bridge/status';
import {
  dispatchManagedToolRuntimeRequest,
  isManagedToolRuntimeDrainMethod,
  parseManagedToolRuntimeSessionId,
} from './managed-tool-runtime-session.js';

const sessionId = '01a05708-a79d-4a02-8b79-02c4120eb054';
const identity: ManagedToolCallIdentity = {
  sessionId,
  promptId: 'prompt-1',
  callId: 'call-1',
  capabilityDigest: 'a'.repeat(64),
  policyRevision: 'policy-1',
};
const reference: ManagedToolInvocationReference = {
  ...identity,
  invocationId: 'invocation-1',
  argsDigest: 'b'.repeat(64),
};

function makeClient() {
  const status = {
    state: 'prepared' as const,
    cancelRequested: false,
    lastSeq: 0,
    firstAvailableSeq: 1,
    progressGap: false,
    progress: [],
  };
  return {
    manifest: vi.fn<ManagedToolV2Client['manifest']>().mockResolvedValue({
      tools: [],
      capabilityDigest: identity.capabilityDigest,
      policyRevision: identity.policyRevision,
    }),
    beginTurn: vi
      .fn<ManagedToolV2Client['beginTurn']>()
      .mockResolvedValue(undefined),
    prepare: vi.fn<ManagedToolV2Client['prepare']>().mockResolvedValue({
      ...reference,
      params: { command: 'pwd' },
      description: 'pwd',
      locations: [],
      defaultPermission: 'ask',
      requiresUserInteraction: false,
      toolUseId: 'toolu_test',
    }),
    confirmation: vi
      .fn<ManagedToolV2Client['confirmation']>()
      .mockResolvedValue({
        type: 'exec',
        title: 'Run command',
        command: 'pwd',
        rootCommand: 'pwd',
      }),
    confirm: vi
      .fn<ManagedToolV2Client['confirm']>()
      .mockResolvedValue(undefined),
    preflight: vi
      .fn<ManagedToolV2Client['preflight']>()
      .mockResolvedValue({ shouldProceed: true }),
    execute: vi
      .fn<ManagedToolV2Client['execute']>()
      .mockResolvedValue({ executionStatus: 'success' }),
    status: vi.fn<ManagedToolV2Client['status']>().mockResolvedValue(status),
    cancel: vi
      .fn<ManagedToolV2Client['cancel']>()
      .mockResolvedValue({ ...status, cancelRequested: true }),
  };
}

describe('managed tool Runtime ACP request dispatch', () => {
  it('forwards a strictly parsed media snapshot separately from model arguments', async () => {
    const client = makeClient();
    const input = { file_path: '/runtime/image.png' };
    const mediaContext = { inputModalities: { image: true, pdf: false } };
    await dispatchManagedToolRuntimeRequest(
      client,
      methods.sessionManagedToolV2Prepare,
      { sessionId, identity, toolName: 'read_file', input, mediaContext },
    );
    expect(client.prepare).toHaveBeenCalledExactlyOnceWith(
      identity,
      'read_file',
      input,
      undefined,
      mediaContext,
    );
    for (const invalid of [
      null,
      { inputModalities: { image: 'true' } },
      { ...mediaContext, model: 'untrusted' },
    ]) {
      await expect(
        dispatchManagedToolRuntimeRequest(
          client,
          methods.sessionManagedToolV2Prepare,
          {
            sessionId,
            identity,
            toolName: 'read_file',
            input,
            mediaContext: invalid,
          },
        ),
      ).rejects.toThrow();
    }
    expect(client.prepare).toHaveBeenCalledOnce();
  });
  it('dispatches strictly parsed file history methods and admits only snapshots during draining', async () => {
    const state = { ownerSessionId: sessionId, revision: 0, snapshots: [] };
    const binding = {
      ownerSessionId: sessionId,
      ownerRuntimeSessionId: sessionId,
      executionCwd: process.cwd(),
      snapshots: [],
    };
    const fileHistory = {
      bind: vi.fn().mockResolvedValue(state),
      checkpoint: vi.fn().mockResolvedValue(state),
      snapshot: vi.fn().mockResolvedValue(state),
    };
    const client = { ...makeClient(), fileHistory };
    for (const [method, fields] of [
      [methods.sessionManagedToolV2BindHistory, { binding }],
      [methods.sessionManagedToolV2Checkpoint, { promptId: 'parent-turn' }],
      [methods.sessionManagedToolV2History, {}],
    ] as const) {
      await expect(
        dispatchManagedToolRuntimeRequest(client, method, {
          sessionId,
          ...fields,
        }),
      ).resolves.toEqual(state);
      expect(isManagedToolRuntimeDrainMethod(method)).toBe(
        method === methods.sessionManagedToolV2History,
      );
    }
    expect(fileHistory.bind).toHaveBeenCalledExactlyOnceWith(binding);
    expect(fileHistory.checkpoint).toHaveBeenCalledExactlyOnceWith(
      'parent-turn',
    );
    expect(fileHistory.snapshot).toHaveBeenCalledExactlyOnceWith();
    for (const [method, fields] of [
      [
        methods.sessionManagedToolV2BindHistory,
        { binding: { ...binding, extra: true } },
      ],
      [methods.sessionManagedToolV2Checkpoint, { promptId: '' }],
      [methods.sessionManagedToolV2History, { binding }],
    ] as const) {
      await expect(
        dispatchManagedToolRuntimeRequest(client, method, {
          sessionId,
          ...fields,
        }),
      ).rejects.toThrow();
    }
    expect(fileHistory.bind).toHaveBeenCalledOnce();
    expect(fileHistory.checkpoint).toHaveBeenCalledOnce();
    expect(fileHistory.snapshot).toHaveBeenCalledOnce();
    fileHistory.snapshot.mockResolvedValueOnce({ ...state, revision: -1 });
    await expect(
      dispatchManagedToolRuntimeRequest(
        client,
        methods.sessionManagedToolV2History,
        { sessionId },
      ),
    ).rejects.toThrow();
    await expect(
      dispatchManagedToolRuntimeRequest(
        makeClient(),
        methods.sessionManagedToolV2History,
        { sessionId },
      ),
    ).rejects.toThrow('unavailable');
  });

  it('awaits asynchronous clients and preserves all nine operation results', async () => {
    const client = makeClient();
    const dispatch = (method: string, fields = {}) =>
      dispatchManagedToolRuntimeRequest(client, method, {
        sessionId,
        ...fields,
      });
    await expect(
      dispatch(methods.sessionManagedToolV2Manifest),
    ).resolves.toMatchObject({ policyRevision: 'policy-1' });
    await expect(
      dispatch(methods.sessionManagedToolV2BeginTurn, { identity }),
    ).resolves.toEqual({ started: true });
    await expect(
      dispatch(methods.sessionManagedToolV2Prepare, {
        identity,
        toolName: 'run_shell_command',
        input: { command: 'pwd' },
      }),
    ).resolves.toMatchObject(reference);
    await expect(
      dispatch(methods.sessionManagedToolV2Confirmation, { reference }),
    ).resolves.toMatchObject({ type: 'exec' });
    await expect(
      dispatch(methods.sessionManagedToolV2Confirm, {
        reference,
        outcome: ToolConfirmationOutcome.ProceedOnce,
        phase: 'preflight',
        payload: { cancelMessage: 'reason' },
      }),
    ).resolves.toEqual({ confirmed: true });
    expect(client.confirm).toHaveBeenCalledWith(
      reference,
      ToolConfirmationOutcome.ProceedOnce,
      { cancelMessage: 'reason' },
      'preflight',
    );
    await expect(
      dispatch(methods.sessionManagedToolV2Preflight, { reference }),
    ).resolves.toEqual({ shouldProceed: true });
    await expect(
      dispatch(methods.sessionManagedToolV2Execute, { reference }),
    ).resolves.toEqual({ executionStatus: 'success' });
    await expect(
      dispatch(methods.sessionManagedToolV2Status, { reference, afterSeq: 7 }),
    ).resolves.toMatchObject({ state: 'prepared' });
    expect(client.status).toHaveBeenCalledWith(reference, 7);
    await expect(
      dispatch(methods.sessionManagedToolV2Cancel, { reference }),
    ).resolves.toMatchObject({ cancelRequested: true });
  });

  it.each([
    [
      methods.sessionManagedToolV2Execute,
      {
        reference: {
          ...reference,
          sessionId: '11a05708-a79d-4a02-8b79-02c4120eb054',
        },
      },
    ],
    [
      methods.sessionManagedToolV2Execute,
      { reference: { ...reference, extra: true } },
    ],
    [
      methods.sessionManagedToolV2Prepare,
      {
        identity: { ...identity, extra: true },
        toolName: 'read_file',
        input: {},
      },
    ],
    [
      methods.sessionManagedToolV2Prepare,
      { identity, toolName: 'read_file', input: [] },
    ],
    [methods.sessionManagedToolV2Confirm, { reference, outcome: 'unknown' }],
    [
      methods.sessionManagedToolV2Confirm,
      { reference, outcome: ToolConfirmationOutcome.ProceedOnce, phase: null },
    ],
    [
      methods.sessionManagedToolV2Confirm,
      {
        reference,
        outcome: ToolConfirmationOutcome.ProceedOnce,
        payload: { extra: true },
      },
    ],
    [methods.sessionManagedToolV2Status, { reference, afterSeq: null }],
    [methods.sessionManagedToolV2Status, { reference, afterSeq: -1 }],
    [methods.sessionManagedToolV2Status, { reference, afterSeq: 0.1 }],
    [methods.sessionManagedToolV2Manifest, { cwd: '/other/workspace' }],
  ])(
    'rejects malformed %s before calling the service',
    async (method, fields) => {
      const client = makeClient();
      await expect(
        dispatchManagedToolRuntimeRequest(client, method, {
          sessionId,
          ...fields,
        }),
      ).rejects.toThrow();
      for (const operation of Object.values(client))
        expect(operation).not.toHaveBeenCalled();
    },
  );

  it.each([true, 'true', null, 0])(
    'rejects background Shell value %s',
    async (is_background) => {
      const client = makeClient();
      await expect(
        dispatchManagedToolRuntimeRequest(
          client,
          methods.sessionManagedToolV2Prepare,
          {
            sessionId,
            identity,
            toolName: 'run_shell_command',
            input: { command: 'sleep 10', is_background },
          },
        ),
      ).rejects.toThrow('foreground Shell');
      expect(client.prepare).not.toHaveBeenCalled();
    },
  );

  it('rejects noncanonical Session IDs and non-JSON data', () => {
    expect(() =>
      parseManagedToolRuntimeSessionId(methods.sessionManagedToolV2Manifest, {
        sessionId: sessionId.toUpperCase(),
      }),
    ).toThrow();
    expect(() =>
      parseManagedToolRuntimeSessionId(methods.sessionManagedToolV2Prepare, {
        sessionId,
        identity,
        toolName: 'read_file',
        input: { path: undefined },
      }),
    ).toThrow();
  });
});

it('forwards notebook modification separately from input and rejects extension fields', async () => {
  const client = makeClient();
  const input = {
    notebook_path: '/workspace/test.ipynb',
    cell_id: 'a',
    new_source: 'value',
  };
  const modification = { source: reference, newContent: '{"cells":[]}' };
  const params = {
    sessionId,
    identity,
    toolName: 'notebook_edit',
    input,
    modification,
  };
  await dispatchManagedToolRuntimeRequest(
    client,
    methods.sessionManagedToolV2Prepare,
    params,
  );
  expect(client.prepare).toHaveBeenCalledWith(
    identity,
    'notebook_edit',
    input,
    modification,
  );
  await expect(
    dispatchManagedToolRuntimeRequest(
      client,
      methods.sessionManagedToolV2Prepare,
      {
        ...params,
        modification: { ...modification, approved: true },
      },
    ),
  ).rejects.toThrow();
  expect(client.prepare).toHaveBeenCalledOnce();
});
