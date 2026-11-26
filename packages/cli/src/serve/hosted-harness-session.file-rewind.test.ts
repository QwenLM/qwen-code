/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  PROMPT_ID,
  SESSION_ID,
  app,
  headers,
  mcpApp,
  state,
  store,
} from './hosted-harness-session.test-helper.js';
import {
  files,
  useToolApprovals,
  waitFor,
} from './hosted-harness-session-approvals.test-helper.js';
import { createHash, randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import * as hostedHistory from './hosted-file-history.js';
import type { HostedFileHistoryState } from './hosted-file-history-protocol.js';
import { LocalJsonlManagedSessionJournalHandle } from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { LocalManagedSessionAuthority } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { type ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { HostedMcpManager } from './hosted-mcp-settings.js';
import { commitHostedFileHistory } from './hosted-file-history.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import type { HostedMcpSession } from './hosted-mcp-session.js';
import {
  HostedWorkspaceBroker,
  HostedWorkspaceBrokerRejection,
} from './hosted-workspace-broker.js';
import * as stdio from '../utils/stdioHelpers.js';

describe('Hosted Harness tool approvals', () => {
  useToolApprovals();

  it('keeps a rewound MCP owner accounted for until ordered release', async () => {
    let mcp: HostedMcpSession | undefined;
    let managed: ManagedSession | undefined;
    const open = HostedMcpManager.prototype.open;
    vi.spyOn(HostedMcpManager.prototype, 'open').mockImplementation(
      async function (this: HostedMcpManager) {
        await open.call(this);
        mcp = Reflect.get(this, 'mcp') as HostedMcpSession | undefined;
        managed = Reflect.get(this, 'session') as ManagedSession;
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'mcpDefinitions',
    ).mockResolvedValue([]);
    const { server, authorize } = await mcpApp(
      false,
      ['demo'],
      'hosted-workspace-shell/1',
    );
    await authorize(
      supertest(server).get(`/session/${SESSION_ID}/mcp/management`),
    ).expect(200);
    if (!mcp || !managed) throw new Error('The MCP fixture did not initialize');
    const history = {
      ownerSessionId: SESSION_ID,
      snapshots: [
        {
          promptId: PROMPT_ID,
          timestamp: new Date().toISOString(),
          trackedFileBackups: {},
        },
      ],
      files: {},
    };
    await managed.sink.write({
      uuid: randomUUID(),
      parentUuid: null,
      sessionId: SESSION_ID,
      timestamp: new Date().toISOString(),
      type: 'user',
      cwd: state.root,
      version: 'test',
      message: { role: 'user', parts: [{ text: 'backup fixture' }] },
    });
    await commitHostedFileHistory(managed, {
      schemaVersion: 1,
      state: history,
      pendingTurn: null,
      pendingUndo: null,
      undoReceipts: [],
    });
    vi.mocked(HostedWorkspaceBroker.prototype.fileHistory).mockImplementation(
      async (operation) =>
        operation.action === 'rewind'
          ? {
              state: history,
              filesChanged: [],
              filesFailed: [],
              conflict: false,
            }
          : history,
    );
    const acquire = vi.mocked(HostedWorkspaceBroker.prototype.acquire);
    const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
    acquire.mockClear();
    release.mockClear();
    expect(mcp.mountHeld).toBe(false);
    expect(
      managed.authority.extensionRecordsInDomain('mcp_configuration'),
    ).toHaveLength(0);
    await authorize(
      supertest(server).post(`/session/${SESSION_ID}/files/rewind`),
    )
      .send({ requestId: randomUUID(), promptId: PROMPT_ID })
      .expect(200);
    expect(acquire).toHaveBeenCalledOnce();
    expect(acquire.mock.contexts).toEqual([mcp.broker]);
    expect(mcp.mountHeld).toBe(true);
    expect(release).not.toHaveBeenCalled();
    await mcp.closeResources({ terminal: true });
    expect(release).toHaveBeenCalledOnce();
    expect(mcp.mountHeld).toBe(false);
  });

  it.each([
    'success',
    'conflict',
    'closing',
    'old-history-unavailable',
    'corrupt-receipt',
    'release',
    'busy',
    'warm',
    'bind',
    'unsupported',
    'unknown-acquire',
    'unknown-released',
    'unknown-bind',
    'refusal-release',
    'capacity',
    'partial',
  ])(
    'settles undo or preserves its recovery boundary (%s)',
    async (scenario) => {
      const releaseFails = scenario === 'release';
      let writePromptId = PROMPT_ID;
      const historyState: HostedFileHistoryState = {
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
      if (scenario === 'partial') {
        historyState.snapshots[0].trackedFileBackups['other.txt'] = {
          ...historyState.snapshots[0].trackedFileBackups['notes.txt'],
        };
        historyState.files['other.txt'] = historyState.files['notes.txt'];
      }
      const conflict = scenario === 'conflict';
      const control = vi
        .mocked(HostedWorkspaceBroker.prototype.fileHistory)
        .mockImplementation(async (operation) =>
          operation.action === 'rewind'
            ? {
                state: conflict
                  ? historyState
                  : { ...historyState, files: { 'notes.txt': null } },
                filesChanged: conflict ? [] : ['notes.txt'],
                filesFailed: [],
                conflict,
              }
            : historyState,
        );
      state.model.mockImplementation(async ({ toolTurn, signal }) => {
        const call = {
          name: 'write_file',
          callId: 'write',
          args: { file_path: 'notes.txt', content: 'hello' },
          isClientInitiated: false,
          prompt_id: writePromptId,
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
          'model',
          signal,
        );
        await toolTurn!.consumeResults();
        return { text: 'done', model: 'test' };
      });
      const server = await app(true);
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: files,
      });
      expect(created.status).toBe(200);
      let clientId = created.body.clientId as string;
      const prompt = [{ type: 'text', text: 'write notes' }];
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          prompt,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        })
        .expect(202);
      await waitFor(async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: false,
        });
      });
      await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .set('X-Qwen-Client-Id', clientId)
        .send({})
        .expect(204);
      if (scenario === 'old-history-unavailable') {
        const read = LocalManagedSessionResourceStore.prototype.read;
        const fault = vi
          .spyOn(LocalManagedSessionResourceStore.prototype, 'read')
          .mockImplementation(async function (
            this: LocalManagedSessionResourceStore,
            ref,
          ) {
            const bytes = await read.call(this, ref);
            if (
              ref.kind === 'managed-file_history' &&
              JSON.parse(bytes.toString('utf8')).pendingTurn
            )
              throw new Error('old history resource unavailable');
            return bytes;
          });
        const acquisitions = vi.mocked(HostedWorkspaceBroker.prototype.acquire)
          .mock.calls.length;
        const refused = await headers(
          supertest(server).post(`/session/${SESSION_ID}/load`),
        ).send({ managedSessionStore: store() });
        expect(refused.status).toBe(409);
        expect(refused.body.code).toBe('hosted_turn_recovery_required');
        expect(HostedWorkspaceBroker.prototype.acquire).toHaveBeenCalledTimes(
          acquisitions,
        );
        fault.mockRestore();
      }
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store(), toolProfile: files });
      expect(loaded.status).toBe(200);
      clientId = loaded.body.clientId as string;
      const before = await headers(
        supertest(server).get(`/session/${SESSION_ID}/files/history`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(before.body.history.state).toEqual(historyState);
      if (scenario === 'corrupt-receipt') {
        const read = LocalManagedSessionResourceStore.prototype.read;
        const fault = vi
          .spyOn(LocalManagedSessionResourceStore.prototype, 'read')
          .mockImplementation(async function (
            this: LocalManagedSessionResourceStore,
            ref,
          ) {
            const bytes = await read.call(this, ref);
            if (ref.kind !== 'managed-file_history') return bytes;
            const record = JSON.parse(bytes.toString('utf8'));
            record.undoReceipts = [
              {
                requestId: randomUUID(),
                promptId: PROMPT_ID,
                filesChanged: ['missing.txt'],
                conflict: false,
              },
            ];
            return Buffer.from(JSON.stringify(record));
          });
        const log = vi
          .spyOn(stdio, 'writeStderrLineSafe')
          .mockImplementation(() => {});
        const detail =
          'Invalid Hosted file history undo receipt 0: filesChanged must contain only tracked paths.';
        const failed = await headers(
          supertest(server).get(`/session/${SESSION_ID}/files/history`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(failed.status).toBe(503);
        expect(failed.body).toEqual({
          error: 'hosted_file_history_failed',
          code: 'hosted_file_history_failed',
        });
        expect(log).toHaveBeenCalledWith(
          `qwen serve: Hosted file history read failed: Error: ${detail}`,
        );
        await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
          .set('X-Qwen-Client-Id', clientId)
          .send({})
          .expect(204);
        log.mockClear();
        const failedLoad = await headers(
          supertest(server).post(`/session/${SESSION_ID}/load`),
        ).send({ managedSessionStore: store(), toolProfile: files });
        expect(failedLoad.status).toBe(503);
        expect(failedLoad.body).toEqual({
          error: 'managed_session_open_failed',
          code: 'managed_session_open_failed',
        });
        expect(log).toHaveBeenCalledWith(
          `qwen serve: Hosted Session open failed: Error: ${detail}`,
        );
        fault.mockRestore();
        await headers(supertest(server).post(`/session/${SESSION_ID}/load`))
          .send({ managedSessionStore: store(), toolProfile: files })
          .expect(200);
        await headers(
          supertest(server).delete(`/session/${SESSION_ID}`),
        ).expect(204);
        return;
      }
      if (releaseFails)
        vi.mocked(
          HostedWorkspaceBroker.prototype.release,
        ).mockRejectedValueOnce(new Error('release response lost'));
      const request = { promptId: PROMPT_ID, requestId: randomUUID() };
      const undo = () =>
        headers(supertest(server).post(`/session/${SESSION_ID}/files/rewind`))
          .set('X-Qwen-Client-Id', clientId)
          .send(request);
      const physicalUndo = control.getMockImplementation()!;
      let rewinds = 0;
      control.mockImplementation(async (operation) => {
        if (operation.action === 'rewind') {
          const pending = await headers(
            supertest(server).get(`/session/${SESSION_ID}/files/history`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(pending.body.history.pendingUndo).toEqual({
            requestId: expect.any(String),
            promptId: operation.promptId,
          });
          if (rewinds++ === 0) {
            expect(pending.body.history.pendingUndo).toEqual(request);
            expect(pending.body.history.state).toEqual(historyState);
          }
        }
        return physicalUndo(operation);
      });
      if (scenario === 'closing') {
        const releaseActivation =
          LocalManagedSessionAuthority.prototype.releaseActivation;
        let finish!: () => void;
        const pending = new Promise<void>((resolve) => {
          finish = resolve;
        });
        let closing = false;
        vi.spyOn(
          LocalManagedSessionAuthority.prototype,
          'releaseActivation',
        ).mockImplementation(async function (
          this: LocalManagedSessionAuthority,
          ...args
        ) {
          closing = true;
          await pending;
          return releaseActivation.apply(this, args);
        });
        const closed = headers(
          supertest(server).post(`/session/${SESSION_ID}/detach`),
        )
          .set('X-Qwen-Client-Id', clientId)
          .then((response) => response);
        const acquisitions = vi.mocked(HostedWorkspaceBroker.prototype.acquire)
          .mock.calls.length;
        const controls = control.mock.calls.length;
        try {
          await waitFor(() => expect(closing).toBe(true));
          const refused = await undo();
          expect(refused.status).toBe(409);
          expect(refused.body.code).toBe('hosted_mcp_operation_active');
          expect(HostedWorkspaceBroker.prototype.acquire).toHaveBeenCalledTimes(
            acquisitions,
          );
          expect(control).toHaveBeenCalledTimes(controls);
        } finally {
          finish();
          expect((await closed).status).toBe(204);
        }
        return;
      }
      if (
        scenario !== 'success' &&
        scenario !== 'conflict' &&
        scenario !== 'release' &&
        scenario !== 'old-history-unavailable'
      ) {
        const acquire = vi.mocked(HostedWorkspaceBroker.prototype.acquire);
        const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
        const acquiredBefore = acquire.mock.calls.length;
        const releasedBefore = release.mock.calls.length;
        const retryable = ['busy', 'bind', 'unsupported', 'capacity'].includes(
          scenario,
        );
        if (scenario === 'warm')
          vi.mocked(HostedWorkspaceBroker.prototype.warm).mockRejectedValueOnce(
            new Error('warm response lost'),
          );
        if (['busy', 'unknown-acquire', 'unknown-released'].includes(scenario))
          acquire.mockRejectedValueOnce(
            new HostedWorkspaceBrokerRejection(
              scenario === 'busy' ? 409 : 503,
              scenario === 'unknown-released'
                ? 'runtime_session_not_acquirable'
                : 'workspace_busy',
            ),
          );
        if (
          ['bind', 'unsupported', 'unknown-bind', 'refusal-release'].includes(
            scenario,
          )
        )
          control.mockRejectedValueOnce(
            new HostedWorkspaceBrokerRejection(
              scenario === 'unsupported'
                ? 400
                : scenario === 'unknown-bind'
                  ? 503
                  : 409,
              scenario === 'unsupported'
                ? 'runtime_control_operation_invalid'
                : 'managed_runtime_provider_operation_failed',
            ),
          );
        if (scenario === 'refusal-release')
          release.mockRejectedValueOnce(new Error('release response lost'));
        if (scenario === 'capacity')
          vi.spyOn(
            hostedHistory,
            'assertHostedFileHistoryCapacity',
          ).mockRejectedValueOnce(
            new hostedHistory.HostedFileHistoryRefusedError(
              'capacity exhausted',
            ),
          );
        if (scenario === 'partial') {
          const physical = control.getMockImplementation()!;
          control.mockImplementation(async (operation) => {
            const result = await physical(operation);
            return operation.action === 'rewind'
              ? {
                  state: {
                    ...historyState,
                    files: { ...historyState.files, 'notes.txt': null },
                  },
                  filesChanged: ['notes.txt'],
                  filesFailed: ['other.txt'],
                  conflict: false,
                }
              : result;
          });
        }
        const response = await undo();
        expect(response.status).toBe(retryable ? 409 : 503);
        if (!retryable)
          expect(response.body.code).toBe(
            'hosted_file_history_recovery_required',
          );
        if (scenario === 'capacity')
          expect(response.body.code).toBe(
            'hosted_file_history_capacity_exceeded',
          );
        if (scenario === 'busy')
          expect(response.body.code).toBe('workspace_busy');
        if (scenario === 'bind' || scenario === 'unsupported')
          expect(response.body.code).toBe('hosted_file_history_refused');
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: !retryable,
        });
        const after = await headers(
          supertest(server).get(`/session/${SESSION_ID}/files/history`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(after.body.history.pendingUndo).toEqual(
          scenario === 'partial' ? request : null,
        );
        expect(after.body.history.state).toEqual(historyState);
        expect(
          control.mock.calls.filter(([op]) => op.action === 'rewind'),
        ).toHaveLength(scenario === 'partial' ? 1 : 0);
        expect(acquire).toHaveBeenCalledTimes(
          acquiredBefore + (['capacity', 'warm'].includes(scenario) ? 0 : 1),
        );
        expect(release).toHaveBeenCalledTimes(
          releasedBefore +
            (['bind', 'unsupported', 'refusal-release'].includes(scenario)
              ? 1
              : 0),
        );
        if (retryable) {
          if (scenario === 'bind' || scenario === 'unsupported') {
            acquire.mockRejectedValueOnce(
              new HostedWorkspaceBrokerRejection(
                409,
                'runtime_session_not_acquirable',
              ),
            );
            const reused = await undo();
            expect(reused.status).toBe(409);
            expect(reused.body.code).toBe('runtime_session_not_acquirable');
            const stillUsable = await headers(
              supertest(server).get(`/session/${SESSION_ID}/status`),
            ).set('X-Qwen-Client-Id', clientId);
            expect(stillUsable.body.recoveryBlocked).toBe(false);
            request.requestId = randomUUID();
          }
          expect((await undo()).status).toBe(200);
          expect((await undo()).status).toBe(200);
          expect(
            control.mock.calls.filter(([op]) => op.action === 'rewind'),
          ).toHaveLength(1);
        }
        await headers(supertest(server).delete(`/session/${SESSION_ID}`));
        return;
      }
      const response = await undo();
      expect(response.status).toBe(releaseFails ? 503 : conflict ? 409 : 200);
      if (releaseFails)
        expect(response.body.code).toBe(
          'hosted_file_history_recovery_required',
        );
      const after = await headers(
        supertest(server).get(`/session/${SESSION_ID}/files/history`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(after.body.history.pendingUndo).toEqual(
        releaseFails ? request : null,
      );
      expect(after.body.history.state.files).toEqual(
        conflict ? historyState.files : { 'notes.txt': null },
      );
      expect(after.body.history.undoReceipts).toEqual([
        {
          ...request,
          filesChanged: conflict ? [] : ['notes.txt'],
          conflict,
        },
      ]);
      if (!releaseFails) {
        const replay = await undo();
        expect(replay.status).toBe(conflict ? 409 : 200);
        expect(replay.body).toEqual(response.body);
        expect(
          control.mock.calls.filter(([op]) => op.action === 'rewind'),
        ).toHaveLength(1);
        await headers(
          supertest(server).post(`/session/${SESSION_ID}/files/rewind`),
        )
          .set('X-Qwen-Client-Id', clientId)
          .send({ promptId: PROMPT_ID, requestId: randomUUID() })
          .expect(conflict ? 409 : 200);
        const acquire = vi.mocked(HostedWorkspaceBroker.prototype.acquire);
        const acquisitions = acquire.mock.calls.length;
        expect((await undo()).body).toEqual(response.body);
        expect(acquire).toHaveBeenCalledTimes(acquisitions);

        const anotherPrompt = randomUUID();
        historyState.snapshots.push({
          ...historyState.snapshots[0],
          promptId: anotherPrompt,
        });

        writePromptId = randomUUID();
        await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
          .set('X-Qwen-Client-Id', clientId)
          .send({
            promptId: writePromptId,
            prompt,
            payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
          })
          .expect(202);
        await waitFor(async () => {
          const status = await headers(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body).toMatchObject({
            hasActivePrompt: false,
            recoveryBlocked: false,
          });
        });
        expect((await undo()).body).toEqual(response.body);
        const controls = control.mock.calls.length;
        const acquired = acquire.mock.calls.length;
        const mismatched = await headers(
          supertest(server).post(`/session/${SESSION_ID}/files/rewind`),
        )
          .set('X-Qwen-Client-Id', clientId)
          .send({ ...request, promptId: anotherPrompt });
        expect(mismatched.status).toBe(409);
        expect(mismatched.body.code).toBe('hosted_file_rewind_conflict');
        expect(control).toHaveBeenCalledTimes(controls);
        expect(acquire).toHaveBeenCalledTimes(acquired);
        expect(
          control.mock.calls.filter(([op]) => op.action === 'rewind'),
        ).toHaveLength(2);
      }
      await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .set('X-Qwen-Client-Id', clientId)
        .send({})
        .expect(204);
      const reopened = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store(), toolProfile: files });
      expect(reopened.status).toBe(releaseFails ? 409 : 200);
      if (releaseFails)
        expect(reopened.body.code).toBe(
          'hosted_file_history_recovery_required',
        );
      else {
        clientId = reopened.body.clientId as string;
        const acquisitions = vi.mocked(HostedWorkspaceBroker.prototype.acquire)
          .mock.calls.length;
        expect((await undo()).body).toEqual(response.body);
        expect(HostedWorkspaceBroker.prototype.acquire).toHaveBeenCalledTimes(
          acquisitions,
        );
        await headers(supertest(server).delete(`/session/${SESSION_ID}`));
      }
    },
  );

  it('bounds a forged line break in the rewind recovery cause', async () => {
    // The broker's rewind failure is cause-derived free text: the recovery
    // tag must reach stderr as one logical line, whatever the cause embeds.
    const historyState: HostedFileHistoryState = {
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
    vi.mocked(HostedWorkspaceBroker.prototype.fileHistory).mockImplementation(
      async (operation) => {
        if (operation.action === 'rewind')
          throw new Error('worker\ngone qwen serve: forged');
        return historyState;
      },
    );
    state.model.mockImplementation(async ({ toolTurn, signal }) => {
      const call = {
        name: 'write_file',
        callId: 'write',
        args: { file_path: 'notes.txt', content: 'hello' },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
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
        'model',
        signal,
      );
      await toolTurn!.consumeResults();
      return { text: 'done', model: 'test' };
    });
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: files,
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'write notes' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        prompt,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await waitFor(async () => {
      const status = await headers(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(status.body).toMatchObject({
        hasActivePrompt: false,
        recoveryBlocked: false,
      });
    });
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const undone = await headers(
      supertest(server).post(`/session/${SESSION_ID}/files/rewind`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({ promptId: PROMPT_ID, requestId: randomUUID() });
    expect(undone.status).toBe(503);
    expect(undone.body.code).toBe('hosted_file_history_recovery_required');
    const tag = log.mock.calls
      .map(([line]) => line)
      .find((line) => line.includes('Hosted file undo requires recovery'));
    expect(tag).toBeDefined();
    // One logical line: the newline the cause carried is stripped, not
    // replayed into a forged daemon diagnostic.
    expect(tag).not.toMatch(/[\r\n\u2028\u2029]/);
    expect(tag).toContain(
      'Hosted file undo requires recovery: Error: workergone qwen serve: forged',
    );
  });

  it('names writes_stopped when a rewind cannot journal the pending undo', async () => {
    // The 503 catch names hostedTurnBusyReason(session): when the journal
    // append that records the pending undo stops the writer, writes_stopped
    // must outrank the turn_blocked latch the catch itself sets.
    const historyState: HostedFileHistoryState = {
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
    vi.mocked(HostedWorkspaceBroker.prototype.fileHistory).mockImplementation(
      async () => historyState,
    );
    state.model.mockImplementation(async ({ toolTurn, signal }) => {
      const call = {
        name: 'write_file',
        callId: 'write',
        args: { file_path: 'notes.txt', content: 'hello' },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
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
        'model',
        signal,
      );
      await toolTurn!.consumeResults();
      return { text: 'done', model: 'test' };
    });
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: files,
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'write notes' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        prompt,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await waitFor(async () => {
      const status = await headers(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(status.body).toMatchObject({
        hasActivePrompt: false,
        recoveryBlocked: false,
      });
    });
    // The rewind flow's first journal write records the pending undo; make
    // that append stop the writer.
    vi.spyOn(
      LocalJsonlManagedSessionJournalHandle.prototype,
      'appendTransaction',
    ).mockRejectedValueOnce(new Error('journal down'));
    const undone = await headers(
      supertest(server).post(`/session/${SESSION_ID}/files/rewind`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({ promptId: PROMPT_ID, requestId: randomUUID() });
    expect(undone.status).toBe(503);
    expect(undone.body.code).toBe('hosted_file_history_recovery_required');
    expect(undone.body.reason).toBe('writes_stopped');
  });
});
