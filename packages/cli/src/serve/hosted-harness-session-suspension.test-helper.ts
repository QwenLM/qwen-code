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
import { randomUUID } from 'node:crypto';
import { type Server } from 'node:http';
import supertest from 'supertest';
import { vi } from 'vitest';
import type { registerHostedHarnessSessionRoutes } from './hosted-harness-session.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const statusOf = (server: Server, clientId: string) =>
  headers(supertest(server).get(`/session/${SESSION_ID}/status`)).set(
    'X-Qwen-Client-Id',
    clientId,
  );

// A write_file approval the model raises once; only a resumed Turn ends.
function mockApprovalTurn(promptId = PROMPT_ID): void {
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
        name: 'write_file',
        callId: 'park-original-call',
        args: { file_path: 'notes.txt', content: 'hello' },
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

const statsOf = (server: Server) =>
  (
    server as Server & {
      harnessRegistration: ReturnType<
        typeof registerHostedHarnessSessionRoutes
      >;
    }
  ).harnessRegistration.suspensionStats();

export { mockApprovalTurn, sleep, statsOf, statusOf };
