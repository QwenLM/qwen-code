/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { ApprovalMode } from '../config/approval-mode.js';
import type { Config } from '../config/config.js';
import {
  getEditToolDefinition,
  getShellToolDefinition,
  getWriteFileToolDefinition,
} from './builtin-tool-definitions.js';
import {
  managedToolDigest,
  type ManagedToolConfirmationDetails,
  type ManagedToolDescriptor,
} from './managed-tool-protocol.js';
import type {
  ManagedToolInvocationStatus,
  ManagedToolV2Client,
} from './managed-tool-runtime.js';
import {
  createManagedBuiltinTool,
  type ManagedToolSession,
} from './managed-tool-session.js';
import { ToolConfirmationOutcome } from './tools.js';

const shellProfile = {
  shellConfiguration: {
    executable: 'bash',
    argsPrefix: ['-c'],
    shell: 'bash' as const,
  },
  platform: 'linux' as const,
};

async function prepareConfirmation(
  descriptor: ManagedToolDescriptor,
  type: 'edit' | 'exec' = 'edit',
) {
  const setApprovalMode = vi.fn();
  const config = {
    getTargetDir: () => '/workspace',
    isTruncateToolOutputThresholdExplicit: () => false,
    setApprovalMode,
  } as unknown as Config;
  const settled: ManagedToolInvocationStatus = {
    state: 'settled',
    cancelRequested: true,
    lastSeq: 0,
    firstAvailableSeq: 1,
    progressGap: false,
    progress: [],
    result: { executionStatus: 'not_started' },
  };
  const confirmation: ManagedToolConfirmationDetails =
    type === 'edit'
      ? {
          type,
          title: 'Edit',
          fileName: 'file',
          filePath: '/workspace/file',
          fileDiff: 'diff',
          originalContent: 'old',
          newContent: 'new',
        }
      : {
          type,
          title: 'Shell',
          command: 'git status',
          rootCommand: 'git',
        };
  const confirm = vi.fn<ManagedToolV2Client['confirm']>(async () => {});
  const client: ManagedToolV2Client = {
    manifest: async () => ({
      tools: [descriptor],
      capabilityDigest: managedToolDigest([descriptor]),
      policyRevision: 'policy',
    }),
    beginTurn: async () => {},
    prepare: async (identity, _name, input) => ({
      ...identity,
      invocationId: 'invocation',
      argsDigest: managedToolDigest(input),
      params: input,
      description: 'Prepared tool',
      locations: [],
      defaultPermission: 'ask',
      requiresUserInteraction: false,
      toolUseId: 'tool-use',
    }),
    confirmation: async () => confirmation,
    confirm,
    preflight: async () => ({ shouldProceed: true }),
    execute: async () => ({ executionStatus: 'not_started' }),
    status: async () => settled,
    cancel: async () => settled,
  };
  const session: ManagedToolSession = {
    ...shellProfile,
    sessionId: 'b8a456ee-8d8e-4c4a-adbd-9bacb4eb0ad7',
    getClient: async () => client,
    close: async () => {},
  };
  const tool = createManagedBuiltinTool(
    descriptor.name,
    config,
    session,
    session.getClient,
  )!;
  const invocation = tool.build({});
  const signal = new AbortController().signal;
  await invocation.managed.prepare(signal, {
    callId: 'call',
    promptId: 'prompt',
  });
  const details = await invocation.getConfirmationDetails(signal);
  return { invocation, details, confirm, setApprovalMode };
}

describe('managed tool Session confirmation policy', () => {
  it.each([
    getWriteFileToolDefinition(),
    getEditToolDefinition(),
    getShellToolDefinition(shellProfile),
  ])(
    'updates Gateway edit mode after $name confirms remotely',
    async (tool) => {
      const { invocation, details, confirm, setApprovalMode } =
        await prepareConfirmation(tool);
      let resolve!: () => void;
      confirm.mockImplementationOnce(
        () => new Promise<void>((done) => (resolve = done)),
      );
      const confirmation = details.onConfirm(
        ToolConfirmationOutcome.ProceedAlways,
      );
      expect(setApprovalMode).not.toHaveBeenCalled();
      resolve();
      await confirmation;
      expect(setApprovalMode).toHaveBeenCalledExactlyOnceWith(
        ApprovalMode.AUTO_EDIT,
      );
      await invocation.managed.cancelAndDrain();
    },
  );

  it('does not change Gateway mode when the Runtime rejects confirmation', async () => {
    const { invocation, details, confirm, setApprovalMode } =
      await prepareConfirmation(getWriteFileToolDefinition());
    confirm.mockRejectedValueOnce(new Error('Runtime confirmation failed'));
    await expect(
      details.onConfirm(ToolConfirmationOutcome.ProceedAlways),
    ).rejects.toThrow('Runtime confirmation failed');
    expect(setApprovalMode).not.toHaveBeenCalled();
    await invocation.managed.cancelAndDrain();
  });

  it('keeps ordinary exec permission persistence with the scheduler', async () => {
    const { invocation, details, setApprovalMode } = await prepareConfirmation(
      getShellToolDefinition(shellProfile),
      'exec',
    );
    await details.onConfirm(ToolConfirmationOutcome.ProceedAlways);
    expect(setApprovalMode).not.toHaveBeenCalled();
    await invocation.managed.cancelAndDrain();
  });
});
