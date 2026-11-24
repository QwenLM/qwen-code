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

const statsOf = (server: Server) =>
  (
    server as Server & {
      harnessRegistration: ReturnType<
        typeof registerHostedHarnessSessionRoutes
      >;
    }
  ).harnessRegistration.suspensionStats();

export { mockApprovalTurn, sleep, statsOf, statusOf };
