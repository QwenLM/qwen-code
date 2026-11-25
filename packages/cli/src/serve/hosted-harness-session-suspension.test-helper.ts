/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  PROMPT_ID,
  SESSION_ID,
  headers,
  state,
} from './hosted-harness-session.test-helper.js';
import { createHash, randomUUID } from 'node:crypto';
import { type Server } from 'node:http';
import supertest from 'supertest';
import { vi } from 'vitest';
import type { registerHostedHarnessSessionRoutes } from './hosted-harness-session.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import * as approvalContinuation from './hosted-approval-continuation.js';
import { HostedShellPublisher } from './hosted-shell-publisher.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import { PRIVATE_ROOT_CAPABILITY_DIGEST } from './managed-private-root.js';

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const statusOf = (server: Server, clientId: string) =>
  headers(supertest(server).get(`/session/${SESSION_ID}/status`)).set(
    'X-Qwen-Client-Id',
    clientId,
  );

// An approval the model raises once; only a resumed Turn ends.
function mockApprovalTurn(promptId = PROMPT_ID, confined = false): void {
  if (confined) {
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'capabilityDigest',
      'get',
    ).mockReturnValue(PRIVATE_ROOT_CAPABILITY_DIGEST);
  }
  vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockImplementation(
    async function (this: HostedWorkspaceBroker) {
      this.runtime = {
        bindingId: 'binding',
        generation: '1',
        workspaceGeneration: '1',
      };
    },
  );
  vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
  vi.spyOn(
    HostedWorkspaceBroker.prototype,
    'activeHoldRuntimeSessionIds',
  ).mockResolvedValue([]);
  vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockImplementation(
    async () => randomUUID(),
  );
  vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
  vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
  vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
    executionStatus: 'success',
    responseParts: [{ text: 'written' }],
  });
  state.model.mockImplementation(
    async ({ toolTurn, resumeFromToolResults, signal }) => {
      if (resumeFromToolResults)
        return { text: 'resumed', model: 'test-model' };
      const call = {
        name: confined ? 'run_shell_command' : 'write_file',
        callId: 'park-original-call',
        args: confined
          ? { command: 'pwd' }
          : { file_path: 'notes.txt', content: 'hello' },
        isClientInitiated: false,
        prompt_id: promptId,
      };
      await toolTurn!.execute(
        [call],
        [
          {
            functionCall: {
              id: call.callId,
              name: call.name,
              args: call.args,
            },
          },
        ],
        'test-model',
        signal,
      );
      throw new Error('The waiting Turn unexpectedly continued.');
    },
  );
}

// A public Shell approval the model raises once, with the Broker and output
// mocks each Shell lane needs to run it after the decision. `saved` observes
// the continuation the resume reads.
async function mockPublicShellApproval(
  background = false,
  shellLane = false,
  promptId = PROMPT_ID,
) {
  mockApprovalTurn(promptId);
  const prepareV3 = vi
    .spyOn(HostedWorkspaceBroker.prototype, 'prepareV3')
    .mockResolvedValue({
      executionCallId: 'shell-execution',
      runtimeBindingId: 'binding',
      bindingGeneration: '1',
    });
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: state.root,
    sessionKey: {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    },
  });
  const manifest = await resources.publish(
    'managed-tool-result-manifest',
    Buffer.from(
      JSON.stringify({
        toolResult: 'managed-tool-result/1',
        type: 'manifest',
        tenantId: 'tenant',
        sessionId: SESSION_ID,
        turnId: promptId,
        executionCallId: 'shell-execution',
        callId: 'park-shell-call',
        invocationDigest: 'digest',
        bindingGeneration: '1',
        captureId: randomUUID(),
        revision: 1,
        executionStatus: 'success',
        exitCode: 0,
        signal: null,
        captureScope: 'process_pipes',
        capturePolicy: 'complete_required',
        captureStatus: 'complete',
        captureReason: null,
        upstreamTruncated: false,
        contents: ['stdout', 'stderr'].map((streamId) => ({
          streamId,
          role: streamId,
          mimeType: 'application/octet-stream',
          state: 'sealed',
          byteLength: 0,
          digest: createHash('sha256').update('').digest('hex'),
          missingRanges: [],
          body: { pages: [] },
        })),
      }),
    ),
  );
  const envelope = {
    executionStatus: 'success' as const,
    responseParts: [{ text: 'touched' }],
    capture: background
      ? {
          manifest: null,
          captureStatus: 'detached' as const,
          captureReason: null,
          previewTruncated: false,
          deliveryStatus: 'pending' as const,
        }
      : {
          manifest,
          captureStatus: 'complete' as const,
          captureReason: null,
          previewTruncated: false,
          deliveryStatus: 'pending' as const,
        },
  };
  const executeV3 = vi
    .spyOn(HostedWorkspaceBroker.prototype, 'executeV3')
    .mockResolvedValue(envelope);
  vi.spyOn(
    HostedWorkspaceBroker.prototype,
    'acknowledgeV3',
  ).mockResolvedValue();
  const prepare = vi.mocked(HostedWorkspaceBroker.prototype.prepare);
  const execute = vi.mocked(HostedWorkspaceBroker.prototype.execute);
  if (shellLane) {
    prepare.mockResolvedValue('shell-execution');
    execute.mockResolvedValue(envelope as never);
    const outcomeRef = await resources.publish(
      'managed-tool-outcome',
      Buffer.from('{}'),
    );
    vi.spyOn(HostedShellPublisher.prototype, 'receipt').mockResolvedValue({
      executionCallId: 'shell-execution',
      manifest,
      deliveryStatus: 'committed',
      historyRevision: 1,
      outcomeRef,
    });
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'acknowledge',
    ).mockResolvedValue();
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'registerPublisher',
    ).mockResolvedValue('1');
  }
  state.publicationRequest.mockImplementation(
    async (
      resourceStore: LocalManagedSessionResourceStore,
      route: string,
      body: unknown,
    ) => {
      if (route === '/grants') return { state: 'OPEN' };
      if (route.endsWith('/finished')) return { result: envelope };
      if (route.endsWith('/admissions/prepare'))
        return resourceStore.publish(
          'managed-tool-outcome',
          Buffer.from(JSON.stringify(body)),
        );
      throw new Error('Unexpected publication route ' + route);
    },
  );
  state.model.mockImplementation(
    async ({ toolTurn, resumeFromToolResults, signal }) => {
      if (resumeFromToolResults)
        return { text: 'resumed', model: 'test-model' };
      const call = {
        name: 'run_shell_command',
        callId: 'park-shell-call',
        args: background
          ? { command: 'npm run dev', is_background: true }
          : { command: 'touch notes.txt' },
        isClientInitiated: false,
        prompt_id: promptId,
      };
      // The production model pins this route before every public-children
      // request; the saved plan is readable as public Shell only with it.
      toolTurn!.setChildModelRoute!('test-model', {
        authType: 'openai',
        endpointDigest: 'a'.repeat(64),
        providerPin: 'b'.repeat(64),
      });
      await toolTurn!.execute(
        [call],
        [
          {
            functionCall: {
              id: call.callId,
              name: call.name,
              args: call.args,
            },
          },
        ],
        'test-model',
        signal,
      );
      throw new Error('The waiting Turn unexpectedly continued.');
    },
  );
  // A background Shell registers its output publisher before it asks.
  if (background)
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'registerPublisher',
    ).mockResolvedValue('1');
  const saved = vi.spyOn(
    approvalContinuation,
    'findHostedApprovalContinuation',
  );
  return { prepareV3, executeV3, prepare, execute, saved };
}

const statsOf = (server: Server) =>
  (
    server as Server & {
      harnessRegistration: ReturnType<
        typeof registerHostedHarnessSessionRoutes
      >;
    }
  ).harnessRegistration.suspensionStats();

export { mockApprovalTurn, mockPublicShellApproval, sleep, statsOf, statusOf };
