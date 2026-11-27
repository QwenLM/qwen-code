/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  PROMPT_ID,
  SESSION_ID,
  app,
  domainEnablement,
  headers,
  hookPin,
  settleTimeoutMs,
  state,
  store,
  wakeDeps,
} from './hosted-harness-session.test-helper.js';
import {
  BOOT_ID_2,
  CALL,
  loadReplacement,
  replacementApp,
  replacementHeaders,
  spyOnAcquire,
  storeFor,
  useRuntimeTakeover,
} from './hosted-harness-session-takeover.test-helper.js';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Part } from '@google/genai';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import {
  LocalJsonlManagedSessionJournalHandle,
  LocalJsonlManagedSessionJournalStore,
} from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { ManagedSessionStoreTransportError } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { type ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { ManagedSessionRecordSink } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-record-sink.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import { HostedWorkspaceToolTurn } from './hosted-workspace-tool-turn.js';
import { HostedTeamSession } from './hosted-team-session.js';

describe('Hosted Harness Runtime turn takeover', () => {
  useRuntimeTakeover();

  /**
   * Parks a Turn that reached the Runtime with a committed-but-unanswered
   * team_create: write_file executes and answers first, team_create's
   * record commits and its tool_result write is killed — the drive dies
   * recovery-blocked, stranding the committed call (R13-1's fixture). The
   * task_create after the crash point never runs and commits nothing.
   */
  async function parkCrashedTeamTurn(): Promise<void> {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    spyOnAcquire().mockImplementation(async function (
      this: HostedWorkspaceBroker,
    ) {
      this.runtime = {
        bindingId: 'binding',
        generation: '1',
        workspaceGeneration: '1',
      };
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
      '66666666-6666-4666-8666-666666666666',
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const server = await app(true);
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        captureBytes: 1024 * 1024,
      })
      .expect(200);
    const clientId = created.body.clientId as string;
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    let killed = false;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      async function (this: ManagedSessionRecordSink, item) {
        if (
          !killed &&
          item.type === 'tool_result' &&
          JSON.stringify(item.message).includes('"team_create"')
        ) {
          killed = true;
          throw new Error('Harness killed');
        }
        return originalWrite.call(this, item);
      },
    );
    const team = {
      name: 'team_create',
      callId: 'call-0',
      args: { team_name: 'review' },
      isClientInitiated: false,
      prompt_id: PROMPT_ID,
    };
    const later = {
      name: 'task_create',
      callId: 'call-2',
      args: { subject: 'Audit', description: 'a' },
      isClientInitiated: false,
      prompt_id: PROMPT_ID,
    };
    state.model.mockImplementationOnce(
      async ({ toolTurn, signal }) =>
        toolTurn!.execute(
          [CALL, team, later],
          [CALL, team, later].map((call) => ({
            functionCall: {
              id: call.callId,
              name: call.name,
              args: call.args,
            },
          })),
          'test-model',
          signal,
        ) as never,
    );
    const prompt = [{ type: 'text', text: 'a file and a team' }];
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
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: settleTimeoutMs() },
    );
    vi.mocked(ManagedSessionRecordSink.prototype.write).mockRestore();
    // The replacement's reconciliation reads the parked execution as
    // settled; the stop proof is quick and quiet.
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  }

  /** Reads the durable fold answer for call-0 from the transcript. */
  async function readSiblingAnswer(
    server: unknown,
    clientId: string,
  ): Promise<unknown> {
    const transcript = await replacementHeaders(
      supertest(server as never).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    return (
      transcript.body.events as Array<{
        type: string;
        data?: {
          record?: {
            type?: string;
            message?: {
              parts?: Array<{
                functionResponse?: { id?: string; response?: unknown };
              }>;
            };
          };
        };
      }>
    )
      .filter(
        (event) =>
          event.type === 'managed_journal_event' &&
          event.data?.record?.type === 'tool_result',
      )
      .flatMap((event) => event.data?.record?.message?.parts ?? [])
      .find((part) => part.functionResponse?.id === 'call-0');
  }

  it('answers the committed sibling when the continue drive compensates a lost resume', async () => {
    // R13-1: the continue route's compensating settle owes the same
    // committed-sibling fold the cancel route runs — the drive's first
    // project() read faults before the resume fold could run, and the
    // durable settle would otherwise strand the committed team_create
    // unanswered forever: the kept admission replays a retried continue
    // without re-driving.
    domainEnablement.childRun = true;
    domainEnablement.teams = true;
    try {
      await parkCrashedTeamTurn();
      const { server, loaded } = await loadReplacement(
        false,
        'hosted-workspace-shell/1',
      );
      expect(loaded.status).toBe(200);
      const clientId = loaded.body.clientId as string;
      const recovery = loaded.body._meta?.[
        'qwen.daemon.managedRuntimeRecovery'
      ] as { checkpointId: string; activationId: string };
      // The drive's first projection read fails before any resume runs, so
      // the compensating settle owns the fold as well as the terminal
      // record.
      vi.spyOn(
        ManagedSessionRecordSink.prototype,
        'project',
      ).mockRejectedValueOnce(new Error('projection lost'));
      const continued = await replacementHeaders(
        supertest(server).post(
          `/session/${SESSION_ID}/managed-runtime/continue`,
        ),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
      expect(continued.status).toBe(200);
      await vi.waitFor(
        async () => {
          const status = await replacementHeaders(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body.hasActivePrompt).toBe(false);
          expect(status.body.recoveryBlocked).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      // The fold's answer is durable: the committed team_create carries a
      // functionResponse in the projection, answered by what committed.
      const sibling = await readSiblingAnswer(server, clientId);
      expect(sibling).toBeDefined();
      expect(
        JSON.stringify(
          (sibling as { functionResponse?: { response?: unknown } })
            ?.functionResponse?.response,
        ),
      ).toContain('committed its team change');
      await replacementHeaders(
        supertest(server).delete(`/session/${SESSION_ID}`),
      );
    } finally {
      domainEnablement.teams = false;
      domainEnablement.childRun = false;
    }
  }, 30_000);

  it('answers the committed sibling when the resume fold write fails and the drive settles', async () => {
    // R13-1: the direct settle owes the fold too — the resume fold's
    // answer write for the orphaned team_create fails raw (not
    // recovery-classified), so the inner catch settles the Turn 'error'
    // with the call still unanswered, and the direct settle's fold is the
    // last chance to pair it before the durable record.
    domainEnablement.childRun = true;
    domainEnablement.teams = true;
    try {
      await parkCrashedTeamTurn();
      const { server, loaded } = await loadReplacement(
        false,
        'hosted-workspace-shell/1',
      );
      expect(loaded.status).toBe(200);
      const clientId = loaded.body.clientId as string;
      const recovery = loaded.body._meta?.[
        'qwen.daemon.managedRuntimeRecovery'
      ] as { checkpointId: string; activationId: string };
      // The resume fold's answer write for the orphaned team_create fails
      // once, so the drive throws raw into the error settle with the
      // answer still owed.
      const originalWrite = ManagedSessionRecordSink.prototype.write;
      let foldRefused = false;
      vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
        async function (this: ManagedSessionRecordSink, item) {
          if (
            !foldRefused &&
            item.type === 'tool_result' &&
            JSON.stringify(item.message).includes('"team_create"')
          ) {
            foldRefused = true;
            throw new Error('store refused the sibling answer');
          }
          return originalWrite.call(this, item);
        },
      );
      const continued = await replacementHeaders(
        supertest(server).post(
          `/session/${SESSION_ID}/managed-runtime/continue`,
        ),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
      expect(continued.status).toBe(200);
      await vi.waitFor(
        async () => {
          const status = await replacementHeaders(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      const settled = await replacementHeaders(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(settled.body.recoveryBlocked).toBe(false);
      const transcript = await replacementHeaders(
        supertest(server).get(`/session/${SESSION_ID}/transcript`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(transcript.body.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'turn_error',
            promptId: PROMPT_ID,
          }),
        ]),
      );
      const sibling = await readSiblingAnswer(server, clientId);
      expect(sibling).toBeDefined();
      expect(
        JSON.stringify(
          (sibling as { functionResponse?: { response?: unknown } })
            ?.functionResponse?.response,
        ),
      ).toContain('committed its team change');
      await replacementHeaders(
        supertest(server).delete(`/session/${SESSION_ID}`),
      );
    } finally {
      domainEnablement.teams = false;
      domainEnablement.childRun = false;
    }
  }, 30_000);

  it.each([
    // The drive's own settle: the model stage ended the Turn in error.
    ['direct', false],
    // The compensating arm: the tool turn's finish then dies against the
    // store too, so the settle and its fold run in the outer catch.
    ['compensating', true],
  ])(
    'names the store on the block a recovered turn leaves when its committed-call fold meets the store (%s settle)',
    async (_settle, finishFails) => {
      // The resume fold's answer for the orphaned team_create is the model
      // stage's first commit, and its journal batch dies against the store:
      // the stage names the failure and the authority latches its writer.
      // The settle's committed-call fold then owes the same answer, meets
      // only the stopped writer, and refuses — the Turn stays re-drivable,
      // and the block it leaves must carry the store's name like the
      // settlement-write exits' (#13800 R2-15).
      domainEnablement.childRun = true;
      domainEnablement.teams = true;
      try {
        await parkCrashedTeamTurn();
        const { server, loaded } = await loadReplacement(
          false,
          'hosted-workspace-shell/1',
        );
        expect(loaded.status).toBe(200);
        const clientId = loaded.body.clientId as string;
        const recovery = loaded.body._meta?.[
          'qwen.daemon.managedRuntimeRecovery'
        ] as { checkpointId: string; activationId: string };
        // A message batch names its record only by id, so the sink side
        // remembers each sibling answer's id and the journal side refuses the
        // batch that commits one.
        const siblingAnswers = new Set<string>();
        const originalWrite = ManagedSessionRecordSink.prototype.write;
        vi.spyOn(
          ManagedSessionRecordSink.prototype,
          'write',
        ).mockImplementation(async function (
          this: ManagedSessionRecordSink,
          item,
        ) {
          if (
            item.type === 'tool_result' &&
            JSON.stringify(item.message).includes('"team_create"')
          )
            siblingAnswers.add(item.uuid);
          return originalWrite.call(this, item);
        });
        const originalAppend =
          LocalJsonlManagedSessionJournalHandle.prototype.appendTransaction;
        let siblingAppends = 0;
        vi.spyOn(
          LocalJsonlManagedSessionJournalHandle.prototype,
          'appendTransaction',
        ).mockImplementation(async function (
          this: LocalJsonlManagedSessionJournalHandle,
          records: readonly unknown[],
        ) {
          const body = JSON.stringify(records);
          if (
            ![...siblingAnswers].some((id) => body.includes(`"message:${id}"`))
          )
            return originalAppend.call(this, records);
          siblingAppends += 1;
          throw new ManagedSessionStoreTransportError('store flap');
        });
        if (finishFails)
          vi.spyOn(
            HostedWorkspaceToolTurn.prototype,
            'finish',
          ).mockRejectedValueOnce(
            new ManagedSessionStoreTransportError('flap'),
          );
        const continued = await replacementHeaders(
          supertest(server).post(
            `/session/${SESSION_ID}/managed-runtime/continue`,
          ),
        )
          .set('X-Qwen-Client-Id', clientId)
          .send({
            promptId: PROMPT_ID,
            checkpointId: recovery.checkpointId,
            activationId: recovery.activationId,
          });
        expect(continued.status).toBe(200);
        await vi.waitFor(
          async () => {
            const status = await replacementHeaders(
              supertest(server).get(`/session/${SESSION_ID}/status`),
            ).set('X-Qwen-Client-Id', clientId);
            expect(status.body.hasActivePrompt).toBe(false);
            expect(status.body.recoveryBlocked).toBe(true);
            expect(status.body.recoveryReason).toBe(
              'managed_session_store_unavailable',
            );
          },
          { timeout: settleTimeoutMs() },
        );
        // Both folds tried the answer, and only the first reached the store:
        // the fold's refusal is the stopped writer, not a second outage.
        expect(siblingAnswers.size).toBe(2);
        expect(siblingAppends).toBe(1);
        await replacementHeaders(
          supertest(server).delete(`/session/${SESSION_ID}`),
        );
      } finally {
        domainEnablement.teams = false;
        domainEnablement.childRun = false;
      }
    },
    30_000,
  );

  // H4e-b1: a user Turn whose batch parks nothing (team calls only) dies
  // after a team call commits and before its tool_result lands. The
  // cancellation takeover answers the committed call truthfully in audit
  // history, while the next model request excludes the cancelled group.
  it('preserves a cancelled team call in audit history without carrying it into the next Turn', async () => {
    domainEnablement.childRun = true;
    try {
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
      const server = await app(true);
      const created = await headers(supertest(server).post('/session'))
        .send({
          sessionId: SESSION_ID,
          sessionScope: 'thread',
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-shell/1',
          captureBytes: 1024 * 1024,
        })
        .expect(200);
      const clientId = created.body.clientId as string;
      // The Harness dies right after task_create's record commits, before
      // its tool_result lands (that one write fails).
      const originalWrite = ManagedSessionRecordSink.prototype.write;
      let killed = false;
      vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
        async function (this: ManagedSessionRecordSink, item) {
          if (
            !killed &&
            item.type === 'tool_result' &&
            JSON.stringify(item.message).includes('"task_create"')
          ) {
            killed = true;
            throw new Error('Harness killed');
          }
          return originalWrite.call(this, item);
        },
      );
      const calls = [
        {
          name: 'team_create',
          callId: 'call-1',
          args: { team_name: 'review' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        },
        {
          name: 'task_create',
          callId: 'call-2',
          args: { subject: 'Audit the auth module', description: 'd' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        },
      ];
      state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
        await toolTurn!.declarations(signal);
        await toolTurn!.execute(
          calls,
          calls.map((call) => ({
            functionCall: {
              id: call.callId,
              name: call.name,
              args: call.args,
            },
          })),
          'test-model',
          signal,
        );
        return { text: 'done', model: 'test-model' };
      });
      const prompt = [{ type: 'text', text: 'make a team and a task' }];
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
          expect(status.body.recoveryBlocked).toBe(true);
        },
        { timeout: settleTimeoutMs() },
      );
      vi.mocked(ManagedSessionRecordSink.prototype.write).mockRestore();
      expect(
        (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
          .status,
      ).toBe(204);
      // The coordinator's explicit user-cancellation takeover.
      const replacement = await replacementApp();
      const loaded = await replacementHeaders(
        supertest(replacement).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        toolProfile: 'hosted-workspace-shell/1',
        passiveManagedRuntimeRecovery: true,
        cancellationTakeover: true,
      });
      expect(loaded.status).toBe(200);
      let seen: ChatRecord[] | undefined;
      state.model.mockImplementationOnce(async (input) => {
        seen = [...((input as { history?: ChatRecord[] }).history ?? [])];
        return { text: 'ok', model: 'test-model' };
      });
      const next = [{ type: 'text', text: 'what is on the board?' }];
      await replacementHeaders(
        supertest(replacement).post(`/session/${SESSION_ID}/prompt`),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId as string)
        .send({
          prompt: next,
          promptId: '44444444-4444-4444-8444-444444444444',
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(next)).digest('hex')}`,
        })
        .expect(202);
      await vi.waitFor(() => expect(seen).toBeDefined(), {
        timeout: settleTimeoutMs(),
      });
      const group = seen!.filter((entry) => entry.daemonPromptId === PROMPT_ID);
      expect(group).toEqual([]);
      const managed = (
        wakeDeps.last as { session: { managed: ManagedSession } }
      ).session.managed;
      expect(
        managed.authority
          .eventsInSequenceRange(1, managed.authority.committedSequence)
          .find(
            (event) =>
              event.kind === 'turn.settled' &&
              event.payload['turnId'] === PROMPT_ID,
          )?.payload,
      ).toMatchObject({
        outcome: 'cancelled',
        stopReason: 'cancelled',
      });
      const audit = await managed.sink.project();
      const answer = audit
        .filter(
          (record) =>
            record.daemonPromptId === PROMPT_ID &&
            record.type === 'tool_result',
        )
        .flatMap((record) => record.message?.parts ?? [])
        .find((part) => part.functionResponse?.id === 'call-2');
      expect(JSON.stringify(answer?.functionResponse?.response)).toContain(
        'committed its team change',
      );
      await vi.waitFor(
        async () => {
          const status = await replacementHeaders(
            supertest(replacement).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      await replacementHeaders(
        supertest(replacement).delete(`/session/${SESSION_ID}`),
      );
    } finally {
      domainEnablement.childRun = true;
    }
  }, 30_000);

  // H4e-b1: a Runtime-parked batch whose team sibling committed before the
  // Harness died, its tool_result never landing. Both settle routes of the
  // parked Turn answer it from its record: the cancel route before its
  // terminal, the continue route before the resumed round reads it.
  it.each(['cancel', 'continue'] as const)(
    'answers a committed team sibling of a Runtime park through the %s route',
    async (route) => {
      domainEnablement.childRun = true;
      try {
        vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
        spyOnAcquire().mockImplementation(async function (
          this: HostedWorkspaceBroker,
        ) {
          this.runtime = {
            bindingId: 'binding',
            generation: '1',
            workspaceGeneration: '1',
          };
        });
        vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
          '66666666-6666-4666-8666-666666666666',
        );
        vi.spyOn(
          HostedWorkspaceBroker.prototype,
          'release',
        ).mockResolvedValue();
        const server = await app(true);
        const created = await headers(supertest(server).post('/session'))
          .send({
            sessionId: SESSION_ID,
            sessionScope: 'thread',
            managedSessionStore: store(),
            toolProfile: 'hosted-workspace-shell/1',
            captureBytes: 1024 * 1024,
          })
          .expect(200);
        const clientId = created.body.clientId as string;
        const originalWrite = ManagedSessionRecordSink.prototype.write;
        let killed = false;
        vi.spyOn(
          ManagedSessionRecordSink.prototype,
          'write',
        ).mockImplementation(async function (
          this: ManagedSessionRecordSink,
          item,
        ) {
          if (
            !killed &&
            item.type === 'tool_result' &&
            JSON.stringify(item.message).includes('"team_create"')
          ) {
            killed = true;
            throw new Error('Harness killed');
          }
          return originalWrite.call(this, item);
        });
        // A team call after the crash point never runs: it commits nothing.
        const later = {
          name: 'task_create',
          callId: 'call-2',
          args: { subject: 'Audit', description: 'a' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        };
        const team = {
          name: 'team_create',
          callId: 'call-0',
          args: { team_name: 'review' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        };
        state.model.mockImplementationOnce(
          async ({ toolTurn, signal }) =>
            toolTurn!.execute(
              [team, CALL, later],
              [team, CALL, later].map((call) => ({
                functionCall: {
                  id: call.callId,
                  name: call.name,
                  args: call.args,
                },
              })),
              'test-model',
              signal,
            ) as never,
        );
        const prompt = [{ type: 'text', text: 'team and a file' }];
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
            expect(status.body.recoveryBlocked).toBe(true);
          },
          { timeout: settleTimeoutMs() },
        );
        vi.mocked(ManagedSessionRecordSink.prototype.write).mockRestore();
        expect(
          (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
            .status,
        ).toBe(204);
        const answerText = 'committed its team change';
        if (route === 'cancel') {
          let stopConfirmed = false;
          vi.spyOn(
            HostedWorkspaceBroker.prototype,
            'status',
          ).mockImplementation(async () => ({
            state: stopConfirmed ? 'settled' : 'prepared',
          }));
          vi.spyOn(
            HostedWorkspaceBroker.prototype,
            'cancel',
          ).mockImplementation(async () => {
            stopConfirmed = true;
          });
          const { server: replacement, loaded } = await loadReplacement(
            true,
            'hosted-workspace-shell/1',
          );
          expect(loaded.status).toBe(200);
          const recovery = loaded.body._meta?.[
            'qwen.daemon.managedRuntimeRecovery'
          ] as { checkpointId: string; activationId: string };
          const cancelled = await replacementHeaders(
            supertest(replacement).post(
              `/session/${SESSION_ID}/managed-runtime/cancel`,
            ),
          )
            .set('X-Qwen-Client-Id', loaded.body.clientId as string)
            .send({
              promptId: PROMPT_ID,
              checkpointId: recovery.checkpointId,
              activationId: recovery.activationId,
            });
          expect(cancelled.status).toBe(200);
          const transcript = await replacementHeaders(
            supertest(replacement).get(`/session/${SESSION_ID}/transcript`),
          ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
          const answer = (
            transcript.body.events as Array<{
              type: string;
              data?: {
                record?: {
                  type?: string;
                  message?: {
                    parts?: Array<{
                      functionResponse?: { id?: string; response?: unknown };
                    }>;
                  };
                };
              };
            }>
          )
            .filter(
              (event) =>
                event.type === 'managed_journal_event' &&
                event.data?.record?.type === 'tool_result',
            )
            .flatMap((event) => event.data?.record?.message?.parts ?? [])
            .find((part) => part.functionResponse?.id === 'call-0');
          expect(JSON.stringify(answer?.functionResponse?.response)).toContain(
            answerText,
          );
          await replacementHeaders(
            supertest(replacement).delete(`/session/${SESSION_ID}`),
          );
          return;
        }
        vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
          executionStatus: 'success',
          responseParts: [{ text: 'written' }],
        } as never);
        vi.spyOn(
          HostedWorkspaceBroker.prototype,
          'workspaceContext',
        ).mockResolvedValue([]);
        const { server: replacement, loaded } = await loadReplacement(
          false,
          'hosted-workspace-shell/1',
        );
        expect(loaded.status).toBe(200);
        const recovery = loaded.body._meta?.[
          'qwen.daemon.managedRuntimeRecovery'
        ] as { checkpointId: string; activationId: string };
        let resumed: Part[] | undefined;
        state.model.mockImplementationOnce(async (input) => {
          resumed = (input as { resumeFromToolResults?: Part[] })
            .resumeFromToolResults;
          return { text: 'continued', model: 'test-model' };
        });
        const continued = await replacementHeaders(
          supertest(replacement).post(
            `/session/${SESSION_ID}/managed-runtime/continue`,
          ),
        )
          .set('X-Qwen-Client-Id', loaded.body.clientId as string)
          .send({
            promptId: PROMPT_ID,
            checkpointId: recovery.checkpointId,
            activationId: recovery.activationId,
          });
        expect(continued.status).toBe(200);
        await vi.waitFor(() => expect(resumed).toBeDefined(), {
          timeout: settleTimeoutMs(),
        });
        expect(
          JSON.stringify(
            resumed!.find((part) => part.functionResponse?.id === 'call-0')
              ?.functionResponse?.response,
          ),
        ).toContain(answerText);
        expect(
          resumed!.some((part) => part.functionResponse?.id === CALL.callId),
        ).toBe(true);
        expect(
          JSON.stringify(
            resumed!.find((part) => part.functionResponse?.id === 'call-2')
              ?.functionResponse?.response,
          ),
        ).toContain('The tool call never ran');
        await vi.waitFor(
          async () => {
            const status = await replacementHeaders(
              supertest(replacement).get(`/session/${SESSION_ID}/status`),
            ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
            expect(status.body.hasActivePrompt).toBe(false);
          },
          { timeout: settleTimeoutMs() },
        );
        await replacementHeaders(
          supertest(replacement).delete(`/session/${SESSION_ID}`),
        );
      } finally {
        domainEnablement.childRun = true;
      }
    },
    30_000,
  );

  it('answers the committed sibling when the cancel drive compensates a lost fold', async () => {
    // R12-1: the settle landed but the happy-path fold's sibling answer
    // write failed, so the catch's compensating arm must re-run the fold
    // before its terminal record — the kept admission replays a retried
    // cancel without re-driving, so a call left unpaired there would stay
    // unpaired forever.
    domainEnablement.childRun = true;
    domainEnablement.teams = true;
    try {
      vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
      spyOnAcquire().mockImplementation(async function (
        this: HostedWorkspaceBroker,
      ) {
        this.runtime = {
          bindingId: 'binding',
          generation: '1',
          workspaceGeneration: '1',
        };
      });
      vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
        '66666666-6666-4666-8666-666666666666',
      );
      vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
      const server = await app(true);
      const created = await headers(supertest(server).post('/session'))
        .send({
          sessionId: SESSION_ID,
          sessionScope: 'thread',
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-shell/1',
          captureBytes: 1024 * 1024,
        })
        .expect(200);
      const clientId = created.body.clientId as string;
      const originalWrite = ManagedSessionRecordSink.prototype.write;
      let killed = false;
      vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
        async function (this: ManagedSessionRecordSink, item) {
          if (
            !killed &&
            item.type === 'tool_result' &&
            JSON.stringify(item.message).includes('"team_create"')
          ) {
            killed = true;
            throw new Error('Harness killed');
          }
          return originalWrite.call(this, item);
        },
      );
      // A team call after the crash point never runs: it commits nothing.
      const later = {
        name: 'task_create',
        callId: 'call-2',
        args: { subject: 'Audit', description: 'a' },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      };
      const team = {
        name: 'team_create',
        callId: 'call-0',
        args: { team_name: 'review' },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      };
      state.model.mockImplementationOnce(
        async ({ toolTurn, signal }) =>
          toolTurn!.execute(
            [team, CALL, later],
            [team, CALL, later].map((call) => ({
              functionCall: {
                id: call.callId,
                name: call.name,
                args: call.args,
              },
            })),
            'test-model',
            signal,
          ) as never,
      );
      const prompt = [{ type: 'text', text: 'team and a file' }];
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
          expect(status.body.recoveryBlocked).toBe(true);
        },
        { timeout: settleTimeoutMs() },
      );
      vi.mocked(ManagedSessionRecordSink.prototype.write).mockRestore();
      expect(
        (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
          .status,
      ).toBe(204);
      // The stop proves quickly; the fold's sibling answer write fails
      // once, so the first cancel reaches its compensating arm.
      vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
        state: 'settled',
      });
      vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
      const { server: replacement, loaded } = await loadReplacement(
        true,
        'hosted-workspace-shell/1',
      );
      expect(loaded.status).toBe(200);
      const recovery = loaded.body._meta?.[
        'qwen.daemon.managedRuntimeRecovery'
      ] as { checkpointId: string; activationId: string };
      let foldRefused = false;
      vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
        async function (this: ManagedSessionRecordSink, item) {
          if (
            !foldRefused &&
            item.type === 'tool_result' &&
            JSON.stringify(item.message).includes('"team_create"')
          ) {
            foldRefused = true;
            throw new Error('store refused the sibling answer');
          }
          return originalWrite.call(this, item);
        },
      );
      const send = () =>
        replacementHeaders(
          supertest(replacement).post(
            `/session/${SESSION_ID}/managed-runtime/cancel`,
          ),
        )
          .set('X-Qwen-Client-Id', loaded.body.clientId as string)
          .send({
            promptId: PROMPT_ID,
            checkpointId: recovery.checkpointId,
            activationId: recovery.activationId,
          });
      const cancelled = await send();
      expect(cancelled.status).toBe(503);
      expect(cancelled.body.code).toBe('managed_runtime_cancel_failed');
      const retried = await send();
      expect(retried.status).toBe(200);
      expect(retried.body.accepted).toBe(true);
      const transcript = await replacementHeaders(
        supertest(replacement).get(`/session/${SESSION_ID}/transcript`),
      ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
      const sibling = (
        transcript.body.events as Array<{
          type: string;
          data?: {
            record?: {
              type?: string;
              message?: {
                parts?: Array<{
                  functionResponse?: { id?: string; response?: unknown };
                }>;
              };
            };
          };
        }>
      )
        .filter(
          (event) =>
            event.type === 'managed_journal_event' &&
            event.data?.record?.type === 'tool_result',
        )
        .flatMap((event) => event.data?.record?.message?.parts ?? [])
        .find((part) => part.functionResponse?.id === 'call-0');
      expect(sibling).toBeDefined();
      expect(JSON.stringify(sibling?.functionResponse?.response)).toContain(
        'committed its team change',
      );
      await replacementHeaders(
        supertest(replacement).delete(`/session/${SESSION_ID}`),
      );
    } finally {
      domainEnablement.teams = false;
      domainEnablement.childRun = false;
    }
  }, 30_000);

  // H4e-b1: the bare load's resume reads only the round's journaled results.
  // A sibling the Runtime does not own that committed before the Harness
  // died — a task, a launch, a member before or after its join — must be
  // answered from its records before the resume, or core's orphan repair
  // has the model retry it and the retry redoes it.
  it.each([
    ['task_create', 'committed its team change'],
    ['agent', 'It joined team \\"review\\" as \\"alice\\"'],
    ['agent-before-join', 'Child agent started in the background'],
    ['agent-unnamed', 'started in the background'],
  ] as const)(
    'answers a committed %s sibling before the bare-load resume of a publication Session',
    async (sibling, expected) => {
      domainEnablement.childRun = true;
      try {
        const key = {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        };
        const resources = LocalManagedSessionResourceStore.create({
          runtimeBaseDir: state.root,
          sessionKey: key,
        });
        const manifest = await resources.publish(
          'managed-tool-result-manifest',
          Buffer.from(
            JSON.stringify({
              toolResult: 'managed-tool-result/1',
              type: 'manifest',
              tenantId: key.tenantId,
              sessionId: SESSION_ID,
              turnId: PROMPT_ID,
              executionCallId: 'shell-execution',
              callId: 'model-shell-call',
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
          responseParts: [{ text: 'hi' }],
          capture: {
            manifest,
            captureStatus: 'complete' as const,
            captureReason: null,
            previewTruncated: false,
            deliveryStatus: 'pending' as const,
          },
        };
        vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
        vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
          async function (this: HostedWorkspaceBroker) {
            this.runtime = {
              bindingId: 'binding-1',
              generation: '1',
              workspaceGeneration: '1',
            };
          },
        );
        vi.spyOn(
          HostedWorkspaceBroker.prototype,
          'prepareV3',
        ).mockResolvedValue({
          executionCallId: 'shell-execution',
          runtimeBindingId: 'binding-1',
          bindingGeneration: '1',
        });
        vi.spyOn(
          HostedWorkspaceBroker.prototype,
          'executeV3',
        ).mockResolvedValue(envelope);
        vi.spyOn(
          HostedWorkspaceBroker.prototype,
          'acknowledgeV3',
        ).mockResolvedValue();
        vi.spyOn(
          HostedWorkspaceBroker.prototype,
          'registerPublisher',
        ).mockResolvedValue('1');
        vi.spyOn(
          HostedWorkspaceBroker.prototype,
          'release',
        ).mockResolvedValue();
        state.publicationRequest.mockImplementation(
          async (
            resourceStore: LocalManagedSessionResourceStore,
            route: string,
            body: unknown,
          ) => {
            if (route === '/grants') return { state: 'OPEN' };
            if (route === '/receipts/verify') return body;
            if (route.endsWith('/finished')) return { result: envelope };
            if (route.endsWith('/admissions/prepare'))
              return resourceStore.publish(
                'managed-tool-outcome',
                Buffer.from(JSON.stringify(body)),
              );
            throw new Error('Unexpected publication route ' + route);
          },
        );
        const first = await app(true);
        const created = await headers(supertest(first).post('/session')).send({
          sessionId: SESSION_ID,
          sessionScope: 'thread',
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-shell/1',
          captureBytes: 1024 * 1024,
        });
        expect(created.status).toBe(200);
        const clientId = created.body.clientId as string;
        const originalWrite = ManagedSessionRecordSink.prototype.write;
        let killed = false;
        if (sibling === 'agent-before-join')
          vi.spyOn(HostedTeamSession.prototype, 'join').mockImplementationOnce(
            async () => {
              killed = true;
              throw new Error('Harness killed');
            },
          );
        vi.spyOn(
          ManagedSessionRecordSink.prototype,
          'write',
        ).mockImplementation(async function (
          this: ManagedSessionRecordSink,
          item,
        ) {
          if (
            sibling !== 'agent-before-join' &&
            !killed &&
            item.type === 'tool_result' &&
            JSON.stringify(item.message).includes(
              `"${sibling === 'agent-unnamed' ? 'agent' : sibling}"`,
            )
          ) {
            killed = true;
            throw new Error('Harness killed');
          }
          return originalWrite.call(this, item);
        });
        const teamCall = [
          {
            name: 'team_create',
            callId: 'call-0',
            args: { team_name: 'review' },
            isClientInitiated: false,
            prompt_id: PROMPT_ID,
          },
        ];
        const siblingCall =
          sibling === 'task_create'
            ? {
                name: 'task_create',
                callId: 'call-2',
                args: { subject: 'Audit the auth module', description: 'd' },
                isClientInitiated: false,
                prompt_id: PROMPT_ID,
              }
            : {
                name: 'agent',
                callId: 'call-2',
                args: {
                  description: 'audit auth',
                  prompt: 'audit the auth module',
                  ...(sibling === 'agent-unnamed' ? {} : { name: 'alice' }),
                },
                isClientInitiated: false,
                prompt_id: PROMPT_ID,
              };
        const batch = [
          {
            name: 'run_shell_command',
            callId: 'model-shell-call',
            args: { command: 'printf hi' },
            isClientInitiated: false,
            prompt_id: PROMPT_ID,
          },
          siblingCall,
          // A team call after the crash point never runs: it commits nothing.
          {
            name: 'task_create',
            callId: 'call-3',
            args: { subject: 'Fix the auth module', description: 'f' },
            isClientInitiated: false,
            prompt_id: PROMPT_ID,
          },
        ];
        state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
          await toolTurn!.declarations(signal);
          await toolTurn!.execute(
            teamCall,
            teamCall.map((call) => ({
              functionCall: {
                id: call.callId,
                name: call.name,
                args: call.args,
              },
            })),
            'test-model',
            signal,
          );
          const answers = await toolTurn!.execute(
            batch,
            batch.map((call) => ({
              functionCall: {
                id: call.callId,
                name: call.name,
                args: call.args,
              },
            })),
            'test-model',
            signal,
          );
          void answers;
          return { text: 'done', model: 'test-model' };
        });
        const prompt = [{ type: 'text', text: 'shell then sibling' }];
        await headers(supertest(first).post(`/session/${SESSION_ID}/prompt`))
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
              supertest(first).get(`/session/${SESSION_ID}/status`),
            ).set('X-Qwen-Client-Id', clientId);
            expect(status.body.hasActivePrompt).toBe(false);
            expect(status.body.recoveryBlocked).toBe(true);
          },
          { timeout: settleTimeoutMs() },
        );
        expect(killed).toBe(true);
        vi.mocked(ManagedSessionRecordSink.prototype.write).mockRestore();
        await headers(supertest(first).delete(`/session/${SESSION_ID}`));
        let resumed: Part[] | undefined;
        state.model.mockImplementationOnce(async (input) => {
          resumed = [
            ...((input as { resumeFromToolResults?: Part[] })
              .resumeFromToolResults ?? []),
          ];
          return { text: 'resumed', model: 'test-model' };
        });
        const second = await app(true);
        const loaded = await headers(
          supertest(second).post(`/session/${SESSION_ID}/load`),
        ).send({ managedSessionStore: store() });
        expect(loaded.status).toBe(200);
        await vi.waitFor(() => expect(resumed).toBeDefined(), {
          timeout: settleTimeoutMs(),
        });
        const answer = JSON.stringify(
          resumed!.find((part) => part.functionResponse?.id === 'call-2')
            ?.functionResponse?.response,
        );
        expect(answer).toContain(expected);
        if (sibling === 'agent-unnamed')
          expect(answer).not.toContain('joined team');
        expect(
          JSON.stringify(
            resumed!.find((part) => part.functionResponse?.id === 'call-3')
              ?.functionResponse?.response,
          ),
        ).toContain('The tool call never ran');
        expect(
          resumed!.some(
            (part) => part.functionResponse?.id === 'model-shell-call',
          ),
        ).toBe(true);
        await vi.waitFor(
          async () => {
            const status = await headers(
              supertest(second).get(`/session/${SESSION_ID}/status`),
            ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
            expect(status.body.hasActivePrompt).toBe(false);
          },
          { timeout: settleTimeoutMs() },
        );
        await headers(supertest(second).delete(`/session/${SESSION_ID}`));
      } finally {
        domainEnablement.childRun = true;
      }
    },
    30_000,
  );

  // H4e-b1: a Hooks Session never takes over; its bare load is the only
  // recovery route, and with a Write in the round the file-history gate
  // needs every call of the round answered. A committed team call the dead
  // Harness never answered is answered from its record before the gate and
  // before the resume, so the Session loads and the model never retries it.
  it.each(['read_file', 'write_file'] as const)(
    'answers a committed task_create before a Hooks Session resumes on its bare load (Runtime sibling %s)',
    async (sibling) => {
      const kind = 'task_create' as 'task_create' | 'agent';
      domainEnablement.childRun = true;
      try {
        vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
        vi.spyOn(
          HostedWorkspaceBroker.prototype,
          'hookControl',
        ).mockImplementation(async (operation) => ({
          operationId: operation.operationId,
          state: 'settled',
          catalog: { ...hookPin, hooks: [] },
        }));
        spyOnAcquire().mockImplementation(async function (
          this: HostedWorkspaceBroker,
        ) {
          this.runtime = {
            bindingId: 'binding',
            generation: '1',
            workspaceGeneration: '1',
          };
        });
        vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
          '66666666-6666-4666-8666-666666666666',
        );
        vi.spyOn(
          HostedWorkspaceBroker.prototype,
          'release',
        ).mockResolvedValue();
        vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
          executionStatus: 'success',
          responseParts: [{ text: 'file body' }],
        } as never);
        const first = await app(true);
        const created = await headers(supertest(first).post('/session')).send({
          sessionId: SESSION_ID,
          sessionScope: 'thread',
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-shell/1',
          hookCatalog: hookPin,
        });
        expect(created.status).toBe(200);
        const clientId = created.body.clientId as string;
        const originalWrite = ManagedSessionRecordSink.prototype.write;
        let killed = false;
        vi.spyOn(
          ManagedSessionRecordSink.prototype,
          'write',
        ).mockImplementation(async function (
          this: ManagedSessionRecordSink,
          item,
        ) {
          if (
            !killed &&
            item.type === 'tool_result' &&
            JSON.stringify(item.message).includes(`"${kind}"`)
          ) {
            killed = true;
            throw new Error('Harness killed');
          }
          return originalWrite.call(this, item);
        });
        const team = {
          name: 'team_create',
          callId: 'call-t',
          args: { team_name: 'review' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        };
        const read = {
          name: sibling,
          callId: 'call-r',
          args:
            sibling === 'read_file'
              ? { file_path: 'a.txt' }
              : { file_path: 'a.txt', content: 'x' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        };
        const second =
          kind === 'task_create'
            ? {
                name: 'task_create',
                callId: 'call-k',
                args: { subject: 'Audit the auth module', description: 'd' },
                isClientInitiated: false,
                prompt_id: PROMPT_ID,
              }
            : {
                name: 'agent',
                callId: 'call-k',
                args: {
                  description: 'audit',
                  prompt: 'audit the auth module',
                  run_in_background: true,
                },
                isClientInitiated: false,
                prompt_id: PROMPT_ID,
              };
        // A sibling after the crash point never runs: it commits nothing.
        const third = {
          name: 'task_create',
          callId: 'call-c',
          args: { subject: 'Fix the auth module', description: 'f' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        };
        const fc = (call: {
          callId: string;
          name: string;
          args: Record<string, unknown>;
        }) => ({
          functionCall: { id: call.callId, name: call.name, args: call.args },
        });
        state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
          await toolTurn!.declarations(signal);
          if (kind === 'task_create')
            await toolTurn!.execute([team], [fc(team)], 'test-model', signal);
          await toolTurn!.execute(
            [read, second, third],
            [fc(read), fc(second), fc(third)],
            'test-model',
            signal,
          );
          return { text: 'unreached', model: 'test-model' };
        });
        const prompt = [{ type: 'text', text: 'team, read, second' }];
        await headers(supertest(first).post(`/session/${SESSION_ID}/prompt`))
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
              supertest(first).get(`/session/${SESSION_ID}/status`),
            ).set('X-Qwen-Client-Id', clientId);
            expect(status.body.hasActivePrompt).toBe(false);
          },
          { timeout: settleTimeoutMs() },
        );
        expect(killed).toBe(true);
        vi.mocked(ManagedSessionRecordSink.prototype.write).mockRestore();
        await headers(
          supertest(first).post(`/session/${SESSION_ID}/detach`),
        ).set('X-Qwen-Client-Id', clientId);
        let resumed: Part[] | undefined;
        let retried = 0;
        state.model.mockImplementationOnce(async (input) => {
          const typed = input as {
            resumeFromToolResults?: Part[];
            toolTurn?: HostedWorkspaceToolTurn;
            signal: AbortSignal;
          };
          resumed = [...(typed.resumeFromToolResults ?? [])];
          // What the real model does after core's orphan repair told it the
          // call "was not recorded ... retry if needed": it retries.
          if (!resumed.some((p) => p.functionResponse?.id === 'call-k')) {
            retried += 1;
            const retry = { ...second, callId: 'call-retry' };
            await typed.toolTurn!.execute(
              [retry],
              [fc(retry)],
              'test-model',
              typed.signal,
            );
          }
          return { text: 'continued', model: 'test-model' };
        });
        const secondApp = await app(true);
        const loaded = await headers(
          supertest(secondApp).post(`/session/${SESSION_ID}/load`),
        ).send({ managedSessionStore: store() });
        expect(loaded.status).toBe(200);
        await vi.waitFor(() => expect(resumed).toBeDefined(), {
          timeout: settleTimeoutMs(),
        });
        await vi.waitFor(
          async () => {
            const status = await headers(
              supertest(secondApp).get(`/session/${SESSION_ID}/status`),
            ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
            expect(status.body.hasActivePrompt).toBe(false);
          },
          { timeout: settleTimeoutMs() },
        );
        const journal = await LocalJsonlManagedSessionJournalStore.read({
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
          runtimeBaseDir: state.root,
          sessionKey: {
            tenantId: 'tenant',
            workspaceId: 'workspace',
            sessionId: SESSION_ID,
          },
        });
        const domainCommits = (domain: string) =>
          journal.events.filter(
            (e) =>
              e.kind === 'domain.committed' &&
              (e.payload as Record<string, unknown>)['domain'] === domain,
          ).length;
        expect(
          JSON.stringify(
            resumed!.find((part) => part.functionResponse?.id === 'call-k')
              ?.functionResponse?.response,
          ),
        ).toContain('committed its team change');
        expect(
          JSON.stringify(
            resumed!.find((part) => part.functionResponse?.id === 'call-c')
              ?.functionResponse?.response,
          ),
        ).toContain('The tool call never ran');
        expect(retried).toBe(0);
        expect(domainCommits('team_task')).toBe(1);
      } finally {
        domainEnablement.childRun = true;
      }
    },
    30_000,
  );
});
