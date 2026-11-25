/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BOOT_ID,
  PROMPT_ID,
  SESSION_ID,
  app,
  headers,
  hookApp,
  mcpApp,
  parkBlockedTextTurn,
  settleTimeoutMs,
  state,
  store,
} from './hosted-harness-session.test-helper.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalJsonlManagedSessionJournalHandle } from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { resetManagedRuntimeDispatchGatesForTest } from '@qwen-code/qwen-code-core/managed-runtime/managed-runtime-dispatch-gate.js';
import { LocalManagedSessionAuthority } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import {
  ManagedSessionAppendUnsettledError,
  ManagedSessionJournalFencedError,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  createHostedHarnessContract,
  installHostedHarnessContractMiddleware,
} from './hosted-harness-contract.js';
import { registerHostedHarnessSessionRoutes } from './hosted-harness-session.js';
import { HostedHookSession } from './hosted-hook-session.js';
import { HostedMcpSession } from './hosted-mcp-session.js';
import { installAccessLogMiddleware } from './server/access-log.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import { HostedToolRecoveryRequiredError } from './hosted-workspace-tool-turn.js';
import * as stdio from '../utils/stdioHelpers.js';

describe('Hosted Harness refusal reasons', () => {
  beforeEach(async () => {
    resetManagedRuntimeDispatchGatesForTest();
    state.root = await mkdtemp(path.join(tmpdir(), 'hosted-harness-test-'));
    state.model.mockReset();
    state.model.mockImplementation(async () => ({
      text: 'hello back',
      model: 'test-model',
    }));
    state.toolResults = null;
    state.assertWritable.mockReset();
    state.assertWritable.mockResolvedValue(undefined);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'fileHistory').mockResolvedValue({
      ownerSessionId: SESSION_ID,
      snapshots: [],
      files: {},
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(state.root, {
      recursive: true,
      force: true,
      // A wake pump's final writes can still be in flight at teardown.
      maxRetries: 5,
      retryDelay: 100,
    });
  });

  async function createAndDetach() {
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(created.status).toBe(200);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  }

  // The lifecycle protocol is why a Shell Session cannot be retired by
  // default, so the refusal has to name itself instead of reading like a
  // missing guard: protocol 1 commits one effects phase and stays with the
  // files profile, protocol 2 only admits the profiles the Harness contract
  // lists.
  it('names a lifecycle protocol the Session profile is not admitted for', async () => {
    const server = await app(true);
    const load = (toolProfile: string, lifecycleProtocolVersion: 1 | 2) =>
      headers(supertest(server).post(`/session/${SESSION_ID}/load`)).send({
        managedSessionStore: store(),
        toolProfile,
        lifecycleProtocolVersion,
        lifecycleAuthority: {
          operationId: `lifecycle-${lifecycleProtocolVersion}`,
          claimGeneration: 1,
        },
      });
    // files/1 is a real profile, but the contract admits only shell/1 and
    // mcp/1 for protocol 2.
    const v2 = await load('hosted-workspace-files/1', 2);
    expect(v2.status).toBe(409);
    expect(v2.body.code).toBe('hosted_lifecycle_profile_unavailable');
    // shell/1 is a lifecycle-v2 profile, but protocol 1 stays with files/1.
    const v1 = await load('hosted-workspace-shell/1', 1);
    expect(v1.status).toBe(409);
    expect(v1.body.code).toBe('hosted_lifecycle_profile_unavailable');
  });

  it('names a blocked restore bundle on a cold load', async () => {
    await createAndDetach();
    // A blocked bundle without a basis must carry both refs null
    // (assertManagedSessionRestoreBundle); throughSequence is always set.
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'restoreBundle',
    ).mockResolvedValue({
      recoveryStatus: 'blocked',
      restoreBasis: null,
      checkpointRef: null,
      restoreProofRef: null,
      throughSequence: 41,
    } as never);
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(loaded.body.reason).toBe('restore_blocked');
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        'load refused (restore_blocked): basis=null through=41',
      ),
    );
    log.mockRestore();
  });

  it('finishes a turn whose lost journal acknowledgement then settles', async () => {
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    let resumed = false;
    state.appendFault = async (journal, records, append) => {
      if (resumed) return false;
      resumed = true;
      (
        journal as LocalJsonlManagedSessionJournalHandle & {
          settleAppend?: () => Promise<'landed' | 'absent'>;
        }
      ).settleAppend = async () => 'landed';
      await append(records);
      throw new ManagedSessionAppendUnsettledError(new Error('ack lost'));
    };
    const prompt = [{ type: 'text', text: 'hello' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(resumed).toBe(true);
        expect(status.body.recoveryBlocked).toBe(false);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
  });

  it('blocks a turn whose journal append is fenced', async () => {
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    let writes = 0;
    state.appendFault = async () => {
      writes += 1;
      if (writes < 2) return false;
      throw new ManagedSessionJournalFencedError('head moved');
    };
    const prompt = [{ type: 'text', text: 'hello' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.recoveryBlocked).toBe(true);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
  });

  it('names an unsettled turn on a bare cold load', async () => {
    await parkBlockedTextTurn(true);
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(loaded.body.reason).toBe('turn_unsettled');
  });

  it('names an unsettled undo on a cold load', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
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
    } as never);
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'acknowledge',
    ).mockResolvedValue();
    const historyState = {
      ownerSessionId: SESSION_ID,
      snapshots: [
        {
          promptId: PROMPT_ID,
          timestamp: '2026-09-30T00:00:00.000Z',
          trackedFileBackups: {
            'notes.txt': {
              backupFileName: null,
              version: 1,
              backupTime: '2026-09-30T00:00:00.000Z',
            },
          },
        },
      ],
      files: {
        'notes.txt': { digest: `sha256:${'a'.repeat(64)}`, mode: 0o644 },
      },
    };
    const control = vi
      .mocked(HostedWorkspaceBroker.prototype.fileHistory)
      .mockResolvedValue(historyState);
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const call = {
        name: 'write_file',
        callId: 'write',
        args: { file_path: 'notes.txt', content: 'hello' },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      };
      return toolTurn!.execute(
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
        'model',
        signal,
      ) as never;
    });
    const prompt = [{ type: 'text', text: 'hello' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    // The worker dies mid-undo: the marker must stay so the next load still
    // refuses to settle a Shell the history never finished.
    control.mockImplementation(async (operation) =>
      operation.action === 'rewind'
        ? Promise.reject(new Error('worker gone'))
        : historyState,
    );
    const undo = await headers(
      supertest(server).post(`/session/${SESSION_ID}/files/rewind`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({ requestId: randomUUID(), promptId: PROMPT_ID });
    expect(undo.status).toBe(503);
    expect(undo.body.code).toBe('hosted_file_history_recovery_required');
    expect(undo.body.reason).toBe('turn_blocked');
    await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', clientId)
      .send({});
    const replacement = await app(true);
    const loaded = await headers(
      supertest(replacement).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_file_history_recovery_required');
    expect(loaded.body.reason).toBe('undo_unsettled');
  });

  it('names an inactive activation on a prompt refusal', async () => {
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'currentActivation',
      'get',
    ).mockReturnValue({ activationId: 'a', phase: 'draining' } as never);
    const prompt = [{ type: 'text', text: 'hello' }];
    const refused = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(refused.body.reason).toBe('activation_inactive');
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('names pending MCP operations on a prompt refusal', async () => {
    const { server, authorize } = await mcpApp();
    const pending = vi
      .spyOn(HostedMcpSession.prototype, 'hasPendingOperations')
      .mockReturnValue(true);
    const prompt = [{ type: 'text', text: 'hello' }];
    const refused = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    ).send({
      prompt,
      promptId: PROMPT_ID,
      payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(refused.body.reason).toBe('mcp_operations_pending');
    pending.mockRestore();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).expect(
      204,
    );
  });

  it('names pending MCP operations on the operations gate', async () => {
    const { server, authorize } = await mcpApp();
    const pending = vi
      .spyOn(HostedMcpSession.prototype, 'hasPendingOperations')
      .mockReturnValue(true);
    const refused = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
    ).send({
      operationId: randomUUID(),
      serverId: 'demo',
      request: { kind: 'resource_read', uri: 'memory://note' },
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(refused.body.reason).toBe('mcp_operations_pending');
    pending.mockRestore();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).expect(
      204,
    );
  });

  it('names pending Hook operations on prompt and rewind refusals', async () => {
    const { server, authorize } = await hookApp();
    const pending = vi
      .spyOn(HostedHookSession.prototype, 'hasPendingOperations', 'get')
      .mockReturnValue(true);
    const prompt = [{ type: 'text', text: 'hello' }];
    const refused = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    ).send({
      prompt,
      promptId: PROMPT_ID,
      payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(refused.body.reason).toBe('hook_operations_pending');
    const rewound = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/files/rewind`),
    ).send({ requestId: randomUUID(), promptId: PROMPT_ID });
    expect(rewound.status).toBe(409);
    expect(rewound.body.code).toBe('hosted_turn_recovery_required');
    expect(rewound.body.reason).toBe('hook_operations_pending');
    pending.mockRestore();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).expect(
      204,
    );
  });

  it('leaves reason off the Hook busy code on a rewind refusal', async () => {
    const { server, authorize } = await hookApp();
    vi.spyOn(
      HostedHookSession.prototype,
      'hasUnsettledExecutions',
      'get',
    ).mockReturnValue(true);
    const rewound = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/files/rewind`),
    ).send({ requestId: randomUUID(), promptId: PROMPT_ID });
    expect(rewound.status).toBe(409);
    expect(rewound.body.code).toBe('hosted_hook_operation_active');
    expect('reason' in (rewound.body as object)).toBe(false);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('records the refusal branch in the daemon access log', async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      raw: vi.fn(),
      setPort: vi.fn(),
      getLogPath: () => '',
      getDaemonId: () => 'daemon:test',
      getStatus: () => ({
        runId: '0'.repeat(32),
        mode: 'stderr-only' as const,
        health: 'ok' as const,
        issues: [],
        droppedRecords: 0,
        droppedBytes: 0,
      }),
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const result = express();
    installAccessLogMiddleware(result, logger);
    result.use(express.json());
    const contract = createHostedHarnessContract(
      `sha256:${'a'.repeat(64)}`,
      BOOT_ID,
    );
    installHostedHarnessContractMiddleware(result, contract);
    registerHostedHarnessSessionRoutes(result, contract, state.root, {
      baseUrl: 'http://127.0.0.1:1',
      token: 'test',
    });
    const created = await headers(supertest(result).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(created.status).toBe(200);
    await headers(supertest(result).delete(`/session/${SESSION_ID}`));
    state.assertWritable.mockRejectedValueOnce(new Error('writer lost'));
    const refused = await headers(
      supertest(result).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(refused.status).toBe(409);
    expect(refused.body.reason).toBe('workspace_not_writable');
    expect(logger.warn).toHaveBeenCalledWith(
      'request completed',
      expect.objectContaining({
        status: 409,
        code: 'hosted_turn_recovery_required',
        reason: 'workspace_not_writable',
      }),
    );
    // The contract middleware's rejections ride the same locals (R1-21):
    // a generation skew is tagged with its code just like a route 409.
    const mismatched = await supertest(result)
      .post(`/session/${SESSION_ID}/load`)
      .set('X-Qwen-Harness-Protocol-Version', '1')
      .set('X-Qwen-Harness-Boot-Id', '99999999-9999-4999-8999-999999999999')
      .send({ managedSessionStore: store() });
    expect(mismatched.status).toBe(409);
    expect(mismatched.body.code).toBe('hosted_harness_generation_mismatch');
    expect(logger.warn).toHaveBeenCalledWith(
      'request completed',
      expect.objectContaining({
        status: 409,
        code: 'hosted_harness_generation_mismatch',
      }),
    );
    // Declined takeovers stamp the locals too (R3-1): the body reason rides
    // through to the access log instead of vanishing between the body and it.
    const DECLINE_SESSION = '55555555-5555-4555-8555-555555555555';
    const declineCreated = await headers(
      supertest(result).post('/session'),
    ).send({
      sessionId: DECLINE_SESSION,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(declineCreated.status).toBe(200);
    state.model.mockRejectedValueOnce(
      new HostedToolRecoveryRequiredError(new Error('store gone')),
    );
    const declinePrompt = [{ type: 'text', text: 'hello' }];
    await headers(supertest(result).post(`/session/${DECLINE_SESSION}/prompt`))
      .set('X-Qwen-Client-Id', declineCreated.body.clientId as string)
      .send({
        prompt: declinePrompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(declinePrompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(result).get(`/session/${DECLINE_SESSION}/status`),
        ).set('X-Qwen-Client-Id', declineCreated.body.clientId as string);
        expect(status.body.recoveryBlocked).toBe(true);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    await headers(
      supertest(result).delete(`/session/${DECLINE_SESSION}`),
    ).expect(204);
    // R3-1's stamp needs a shape that still declines: a durably blocked
    // checkpoint verdict keeps its typed terminal (`checkpoint_blocked`)
    // where the journal-only park above now settles (#13847).
    const blockedVerdict = {
      status: 'blocked',
      reason: 'opaque_state',
    };
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockResolvedValue(blockedVerdict as never);
    const declined = await headers(
      supertest(result).post(`/session/${DECLINE_SESSION}/load`),
    ).send({
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
      driveRuntimeRecovery: true,
    });
    expect(declined.status).toBe(409);
    expect(declined.body.code).toBe('hosted_turn_recovery_declined');
    expect(declined.body.reason).toBe('checkpoint_blocked');
    expect(logger.warn).toHaveBeenCalledWith(
      'request completed',
      expect.objectContaining({
        status: 409,
        code: 'hosted_turn_recovery_declined',
        reason: 'checkpoint_blocked',
      }),
    );
  });
});
