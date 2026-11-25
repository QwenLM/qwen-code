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
  settleTimeoutMs,
  state,
  store,
  wakeDeps,
} from './hosted-harness-session.test-helper.js';
import {
  BOOT_ID_2,
  CALL,
  FILE_PROFILE,
  acquireSpy,
  loadReplacement,
  parkToolTurn,
  replacementApp,
  replacementHeaders,
  storeFor,
  useRuntimeTakeover,
} from './hosted-harness-session-takeover.test-helper.js';
import { createHash, randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import * as hostedHistory from './hosted-file-history.js';
import { LocalManagedSessionAuthority } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import type { openManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { ManagedSessionRecordSink } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-record-sink.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import {
  HostedWorkspaceBroker,
  HostedWorkspaceBrokerRejection,
} from './hosted-workspace-broker.js';
import { HostedToolRecoveryRequiredError } from './hosted-workspace-tool-turn.js';
import * as stdio from '../utils/stdioHelpers.js';
import { HostedChildAgentSession } from './hosted-child-agent-session.js';

describe('Hosted Harness Runtime turn takeover', () => {
  useRuntimeTakeover();

  const CALL_B = {
    name: 'write_file',
    callId: 'call-2',
    args: { file_path: 'b.txt', content: 'y' },
    isClientInitiated: false,
    prompt_id: PROMPT_ID,
  };

  it.each([null, FILE_PROFILE])(
    'settles the cancellation of an ownerless parked Turn on the takeover load (profile=%s)',
    async (toolProfile) => {
      // Arm B: a Turn parked mid model round (the settlement write failed,
      // then its Harness generation died for good). The takeover load
      // carrying the explicit cancellation signal settles the park itself
      // — the writer fence on the load proves the producer generation is
      // dead — instead of refusing forever (round-6 wedge). With tools
      // configured but NOTHING settled (no execution ever ran, the park's
      // checkpoint names no work yet) the same split applies: tools vs the
      // Turn's unpaid Runtime work (P1-1).
      const server = await app(true);
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        ...(toolProfile === null ? {} : { toolProfile }),
      });
      expect(created.status).toBe(200);
      const clientId = created.body.clientId as string;
      const originalWrite = ManagedSessionRecordSink.prototype.write;
      const write = vi
        .spyOn(ManagedSessionRecordSink.prototype, 'write')
        .mockImplementation(async function (
          this: ManagedSessionRecordSink,
          record,
        ) {
          if (record.subtype === 'turn_result')
            throw new Error('settlement unavailable');
          return originalWrite.call(this, record);
        });
      const prompt = [{ type: 'text', text: 'hello' }];
      const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({ prompt, promptId: PROMPT_ID, payloadDigest })
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
      write.mockRestore();
      await headers(supertest(server).delete(`/session/${SESSION_ID}`));
      const log = vi
        .spyOn(stdio, 'writeStderrLineSafe')
        .mockImplementation(() => {});
      // Without the explicit signal the very same shape keeps the baseline
      // retriable refusal first: nothing may mint a canned CANCELLED record
      // for a wait whose owner could still exist (the collision guard).
      const parkedRefused = await replacementHeaders(
        supertest(await replacementApp()).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        passiveManagedRuntimeRecovery: true,
      });
      expect(parkedRefused.status).toBe(409);
      expect(parkedRefused.body.code).toBe('hosted_turn_recovery_required');
      const replacement = await replacementApp();
      const taken = await replacementHeaders(
        supertest(replacement).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        passiveManagedRuntimeRecovery: true,
        cancellationTakeover: true,
      });
      expect(taken.status).toBe(200);
      expect(taken.body.recoveryRequired).toBeUndefined();
      expect(
        log.mock.calls
          .map(([line]) => line)
          .some((line) => line.includes('settles the cancelled park on load')),
      ).toBe(true);
      // The cancelled terminal is durable: the plain cancel route reads it
      // back as settled-at-tail (204, nothing left to abort), and the next
      // prompt admits — the park is closed, not hidden.
      const cancelled = await replacementHeaders(
        supertest(replacement).post(`/session/${SESSION_ID}/cancel`),
      ).set('X-Qwen-Client-Id', taken.body.clientId as string);
      expect(cancelled.status).toBe(204);
      const fresh = [
        { type: 'text', text: 'second turn after the cancelled park' },
      ];
      const admitted = await replacementHeaders(
        supertest(replacement).post(`/session/${SESSION_ID}/prompt`),
      )
        .set('X-Qwen-Client-Id', taken.body.clientId as string)
        .send({
          prompt: fresh,
          promptId: randomUUID(),
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(fresh)).digest('hex')}`,
        });
      expect(admitted.status).toBe(202);
      await vi.waitFor(
        async () => {
          const status = await replacementHeaders(
            supertest(replacement).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', taken.body.clientId as string);
          expect(status.body.hasActivePrompt).toBe(false);
          expect(status.body.recoveryBlocked).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
    },
  );

  it.each([null, FILE_PROFILE])(
    'settles the cancellation takeover of a park that is not the first Turn (profile=%s)',
    async (toolProfile) => {
      // R9: Turn 1 completed first, so the sabotaged Turn 2 parks with
      // history behind it — a no-tool Session's restore basis is blocked
      // (history without a checkpoint) and a tool Session's checkpoint
      // names Turn 1, whose tools all settled and were consumed. Neither
      // shape owes Runtime work for a Turn that never reached a tool call;
      // the cancellation takeover settles them exactly like the
      // first-Turn park above.
      const server = await app(true);
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        ...(toolProfile === null ? {} : { toolProfile }),
      });
      expect(created.status).toBe(200);
      const clientId = created.body.clientId as string;
      const first = [{ type: 'text', text: 'first turn completes' }];
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({
          prompt: first,
          promptId: randomUUID(),
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(first)).digest('hex')}`,
        })
        .expect(202);
      await vi.waitFor(
        async () => {
          const status = await headers(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body.hasActivePrompt).toBe(false);
          expect(status.body.recoveryBlocked).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      const originalWrite = ManagedSessionRecordSink.prototype.write;
      const write = vi
        .spyOn(ManagedSessionRecordSink.prototype, 'write')
        .mockImplementation(async function (
          this: ManagedSessionRecordSink,
          record,
        ) {
          if (record.subtype === 'turn_result')
            throw new Error('settlement unavailable');
          return originalWrite.call(this, record);
        });
      const prompt = [{ type: 'text', text: 'hello' }];
      const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({ prompt, promptId: PROMPT_ID, payloadDigest })
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
      write.mockRestore();
      await headers(supertest(server).delete(`/session/${SESSION_ID}`));
      const log = vi
        .spyOn(stdio, 'writeStderrLineSafe')
        .mockImplementation(() => {});
      const taken = await replacementHeaders(
        supertest(await replacementApp()).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        passiveManagedRuntimeRecovery: true,
        cancellationTakeover: true,
      });
      expect(taken.status).toBe(200);
      expect(taken.body.recoveryRequired).toBeUndefined();
      expect(
        log.mock.calls
          .map(([line]) => line)
          .some((line) => line.includes('settles the cancelled park on load')),
      ).toBe(true);
    },
  );

  it.each(['cancelled', 'decided'])(
    'settles a cancellation takeover whose durable approval already ended (state=%s)',
    async (durableState) => {
      // P1-2: the wait the USER owns is payable while requested; once the
      // durable record ends it, a CANCELLING takeover has only the
      // cancelled-wait answer — the approval copy the dead owner left
      // behind must not hold the session (plain attach + 409 streams
      // forever per round-7's probe).
      await parkToolTurn();
      mockApprovalWaitAuthorization();
      vi.spyOn(
        LocalManagedSessionAuthority.prototype,
        'action',
      ).mockReturnValue({ state: durableState } as never);
      const parkedRefused = await replacementHeaders(
        supertest(await replacementApp()).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        toolProfile: FILE_PROFILE,
        passiveManagedRuntimeRecovery: true,
      });
      expect(parkedRefused.status).toBe(409);
      expect(parkedRefused.body.code).toBe('hosted_turn_recovery_required');
      const taken = await replacementHeaders(
        supertest(await replacementApp()).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        toolProfile: FILE_PROFILE,
        passiveManagedRuntimeRecovery: true,
        cancellationTakeover: true,
      });
      expect(taken.status).toBe(200);
      expect(taken.body.recoveryRequired).toBeUndefined();
    },
  );

  // A REAL checkpoint structurally read as an approval wait: the phase and
  // approval copy are overridden while identity, sequence and the rest of
  // the underlying authority pass through. The approval-only fixture clears
  // Runtime groups so its resolved checkpoint satisfies the write schema.
  function mockApprovalWaitAuthorization() {
    const original =
      LocalManagedSessionAuthority.prototype.harnessRunAuthorization;
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockImplementation(async function (this: LocalManagedSessionAuthority) {
      const authorization = await original.call(this);
      if (authorization.status !== 'runnable') return authorization;
      return {
        ...authorization,
        checkpoint: {
          ...authorization.checkpoint,
          continuation: {
            ...authorization.checkpoint.continuation,
            phase: 'await_action',
          },
          approval: { state: 'requested', requestId: 'request-1' },
          tools: null,
          runtime: null,
        },
      } as never;
    });
  }

  it.each(['allow', 'deny'])(
    'settles the redriven cancellation takeover whose approval was answered since the attach (answer=%s)',
    async (optionId) => {
      // R9-2 + R9-3 (round-10/11 probes): the first takeover attaches
      // plain because the durable record says requested; the user answers
      // AFTER the attach through the real resolve route, so the
      // checkpoint copy stays the stale await_action one. The attached
      // branch never consulted the cancellation signal, and the passive
      // kernel threw the park back as an unknown phase. Now the settle
      // pays identically there, AND the wait closes with it — the SAME
      // Session's next prompt executes instead of failing its model-start
      // check on the obsolete phase.
      await parkToolTurn();
      mockApprovalWaitAuthorization();
      const action = vi
        .spyOn(LocalManagedSessionAuthority.prototype, 'action')
        .mockReturnValue({ state: 'requested' } as never);
      const { server, loaded } = await loadReplacement(true);
      expect(loaded.status).toBe(200);
      expect(loaded.body.recoveryRequired).toBeUndefined();
      // The wait the USER owns ends after the attach: the record decides,
      // the copy the dead owner left still says requested.
      action.mockReturnValue({
        state: optionId === 'allow' ? 'decided' : 'cancelled',
      } as never);
      const log = vi
        .spyOn(stdio, 'writeStderrLineSafe')
        .mockImplementation(() => {});
      const commits: string[] = [];
      const commitOriginal =
        LocalManagedSessionAuthority.prototype.commitCheckpoint;
      vi.spyOn(
        LocalManagedSessionAuthority.prototype,
        'commitCheckpoint',
      ).mockImplementation(function (
        this: LocalManagedSessionAuthority,
        command,
        request,
        actor,
      ) {
        if (typeof command !== 'function') commits.push(command.commandId);
        return commitOriginal.call(
          this,
          typeof command === 'function'
            ? (state, coveredSequence) => {
                const assigned = command(state, coveredSequence);
                commits.push(assigned.commandId);
                return assigned;
              }
            : command,
          request,
          actor,
        );
      });
      const taken = await replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        passiveManagedRuntimeRecovery: true,
        cancellationTakeover: true,
      });
      expect(taken.status).toBe(200);
      expect(
        log.mock.calls
          .map(([line]) => line)
          .some((line) =>
            line.includes('settles the cancelled park on the redriven load'),
          ),
      ).toBe(true);
      // The same signal redriven inside the stream's landing window is a
      // re-answer, not a second settle: one Cancelled record total, and
      // no `turn:<id> is already committed` conflict in its place
      // (the round-10 minor).
      const raced = await replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        passiveManagedRuntimeRecovery: true,
        cancellationTakeover: true,
      });
      expect(raced.status).toBe(200);
      expect(
        log.mock.calls
          .map(([line]) => line)
          .filter((line) =>
            line.includes('settles the cancelled park on the redriven load'),
          ),
      ).toHaveLength(1);
      expect(
        log.mock.calls
          .map(([line]) => line)
          .some((line) => line.includes('takeover_unavailable')),
      ).toBe(false);
      // The cancelled terminal is durable: the plain cancel route reads
      // settled-at-tail (204, nothing left to abort).
      const cancelled = await replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/cancel`),
      ).set('X-Qwen-Client-Id', taken.body.clientId as string);
      expect(cancelled.status).toBe(204);
      // And the cancelled settle closed the WAIT first: ahead of the
      // terminal record, the durable gate committed its own advance —
      // `model_output_committed`, a model-start family phase the next
      // prompt's run check accepts — so the checkpoint never dies one
      // phase behind the journal's terminal (R9-3, whose obsolete
      // `await_action` wedged the relief turn before it ever called the
      // model; the end-to-end relief-turn proof belongs to the
      // real-stack probe, whose approval-first park has no dangling
      // tool call to answer).
      expect(
        commits.some((id) => id.startsWith('harness:model_output_committed:')),
      ).toBe(true);
    },
  );

  it.each(['exception', 'missing_state'])(
    'refuses retriably when the wait-check reports %s, then settles on the replay',
    async (fault) => {
      // R9-5 (round-11 fault injection, both shapes): an exhausted store
      // retry used to hide as `undefined` inside the cancellation settle
      // — the cancelled terminal got minted over a wait the fault hid,
      // and the Session died on its stale checkpoint afterwards. Whether
      // the fault arrives as an exception or as the authority's own
      // blocked/missing_state verdict (its TransportError conversion
      // never throws), the answer is the same retriable refusal; once it
      // clears, the same shape settles.
      await parkToolTurn();
      mockApprovalWaitAuthorization();
      const action = vi
        .spyOn(LocalManagedSessionAuthority.prototype, 'action')
        .mockReturnValue({ state: 'requested' } as never);
      const { server, loaded } = await loadReplacement(true);
      expect(loaded.status).toBe(200);
      expect(loaded.body.recoveryRequired).toBeUndefined();
      action.mockReturnValue({ state: 'decided' } as never);
      // The caller's wait-gate reads fine (#1); the settle's own
      // wait-check is the one that faults (#2) — mirroring the probe's
      // two faces of the same store failure.
      const authorizationMethod = LocalManagedSessionAuthority.prototype
        .harnessRunAuthorization as (
        this: LocalManagedSessionAuthority,
      ) => ReturnType<LocalManagedSessionAuthority['harnessRunAuthorization']>;
      let helperReads = 0;
      vi.spyOn(
        LocalManagedSessionAuthority.prototype,
        'harnessRunAuthorization',
      ).mockImplementation(async function (this: LocalManagedSessionAuthority) {
        helperReads += 1;
        if (helperReads === 2) {
          if (fault === 'exception') throw new Error('store transport failed');
          return { status: 'blocked', reason: 'missing_state' } as never;
        }
        return authorizationMethod.call(this);
      });
      const log = vi
        .spyOn(stdio, 'writeStderrLineSafe')
        .mockImplementation(() => {});
      const send = () =>
        replacementHeaders(
          supertest(server).post(`/session/${SESSION_ID}/load`),
        ).send({
          managedSessionStore: storeFor(BOOT_ID_2),
          passiveManagedRuntimeRecovery: true,
          cancellationTakeover: true,
        });
      const refused = await send();
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('hosted_turn_recovery_required');
      expect(
        log.mock.calls
          .map(([line]) => line)
          .some((line) => line.includes('settles the cancelled park')),
      ).toBe(false);
      // Nothing terminal was minted: the plain cancel still answers the
      // unsettled Turn honestly, exactly like pre-settle stock.
      const cancelled = await replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/cancel`),
      ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
      expect(cancelled.status).toBe(409);
      expect(cancelled.body.code).toBe('hosted_turn_recovery_required');
      // The fault gone, the same shape settles through the same annex.
      const taken = await send();
      expect(taken.status).toBe(200);
      expect(
        log.mock.calls
          .map(([line]) => line)
          .filter((line) =>
            line.includes('settles the cancelled park on the redriven load'),
          ),
      ).toHaveLength(1);
      const settled = await replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/cancel`),
      ).set('X-Qwen-Client-Id', taken.body.clientId as string);
      expect(settled.status).toBe(204);
    },
  );

  it('reports a parked execution passively and cancels the turn', async () => {
    await parkToolTurn();
    let stopConfirmed = false;
    const status = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'status')
      .mockImplementation(async () => ({
        state: stopConfirmed ? 'settled' : 'prepared',
      }));
    const cancel = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'cancel')
      .mockImplementation(async () => {
        stopConfirmed = true;
      });
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    // Passive takeover adopts the original Runtime without dispatching work.
    expect(acquireSpy).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    // The owner may lose its first load reply after Harness registered it.
    const reloaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(reloaded.status).toBe(200);
    expect(reloaded.body.clientId).toBe(loaded.body.clientId);
    expect(acquireSpy).toHaveBeenCalledTimes(2);
    expect(release).not.toHaveBeenCalled();
    const recovery = reloaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      phase: string;
      checkpointId: string;
      activationId: string;
      executions: Array<Record<string, unknown>>;
    };
    expect(recovery.phase).toBe('await_runtime');
    expect(recovery.executions).toEqual([
      expect.objectContaining({
        outcome: 'known',
        status: { state: 'prepared' },
      }),
    ]);
    expect(status).toHaveBeenCalled();
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.accepted).toBe(true);
    expect(cancel).toHaveBeenCalledWith('66666666-6666-4666-8666-666666666666');
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_complete',
          promptId: PROMPT_ID,
          data: expect.objectContaining({ stopReason: 'cancelled' }),
        }),
      ]),
    );
    // The cancelled round's assistant functionCall must meet a journaled
    // tool_result, or the next turn's history is malformed for providers.
    const toolResults = (
      transcript.body.events as Array<{
        type: string;
        data?: {
          record?: {
            type?: string;
            message?: { parts?: Array<{ functionResponse?: { id?: string } }> };
          };
        };
      }>
    ).filter(
      (event) =>
        event.type === 'managed_journal_event' &&
        event.data?.record?.type === 'tool_result',
    );
    expect(
      toolResults.flatMap(
        (event) =>
          event.data?.record?.message?.parts?.map(
            (part) => part.functionResponse?.id,
          ) ?? [],
      ),
    ).toEqual([CALL.callId]);
    // A cancelled recovery must not wedge the session: the next turn runs.
    const nextPromptId = '44444444-4444-4444-8444-444444444444';
    const nextPrompt = [{ type: 'text', text: 'after cancel' }];
    const next = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        prompt: nextPrompt,
        promptId: nextPromptId,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(nextPrompt)).digest('hex')}`,
      });
    expect(next.status).toBe(202);
    await vi.waitFor(
      async () => {
        const later = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
        expect(later.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_complete',
              promptId: nextPromptId,
              data: expect.objectContaining({ stopReason: 'end_turn' }),
            }),
          ]),
        );
      },
      { timeout: settleTimeoutMs() },
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    // Exactly once, across the whole lifecycle: the cancel route's own
    // release discharges the owed lease with its identity, so the teardown
    // skips what is now a redundant handback.
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('keeps the lease owed when the cancel route fails transiently and settles on retry', async () => {
    await parkToolTurn();
    let released = false;
    let stopConfirmed = false;
    let failNextStatus = false;
    // Model the real Broker: once released, the same identity can never be
    // re-acquired and its reads refuse — a stray release must not stay green.
    acquireSpy.mockImplementation(async () => {
      if (released)
        throw new HostedWorkspaceBrokerRejection(
          409,
          'runtime_session_not_acquirable',
        );
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
      async () => {
        if (released)
          throw new HostedWorkspaceBrokerRejection(
            404,
            'runtime_session_not_found',
          );
        if (failNextStatus) {
          failNextStatus = false;
          throw new Error('broker transport blip');
        }
        return { state: stopConfirmed ? 'settled' : 'prepared' };
      },
    );
    const cancel = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'cancel')
      .mockImplementation(async () => {
        stopConfirmed = true;
      });
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockImplementation(async () => {
        released = true;
      });
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      checkpointId: string;
      activationId: string;
    };
    const cancelTurn = () =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId as string)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    // One transient transport failure on the cancel route's first read.
    failNextStatus = true;
    const first = await cancelTurn();
    expect(first.status).toBe(503);
    expect(first.body.code).toBe('managed_runtime_cancel_failed');
    // The coordinator retries a failed cancel: the adopted lease must stay
    // owed, or the retried takeover can never be driven again.
    expect(release).not.toHaveBeenCalled();
    const retried = await cancelTurn();
    expect(retried.status).toBe(200);
    expect(retried.body.accepted).toBe(true);
    expect(cancel).toHaveBeenCalledWith('66666666-6666-4666-8666-666666666666');
    // The only handback is the successful retry's own.
    expect(release).toHaveBeenCalledTimes(1);
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_complete',
          promptId: PROMPT_ID,
          data: expect.objectContaining({ stopReason: 'cancelled' }),
        }),
      ]),
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('keeps the lease owed when the handback 404 carries a foreign code', async () => {
    await parkToolTurn();
    // The parked execution already settled before the owner died: the
    // cancel only has to confirm it, settle the Turn, and release.
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    });
    // A 404 whose code is not runtime_session_not_found — a gateway in
    // front of the Broker, or a Broker build without this route — says
    // nothing about the handback, so it must not certify one.
    let foreign404 = true;
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockImplementation(async () => {
        if (foreign404) {
          foreign404 = false;
          throw new HostedWorkspaceBrokerRejection(
            404,
            'runtime_broker_route_not_found',
          );
        }
      });
    const stderr = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => undefined);
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(cancelled.status).toBe(200);
    // The foreign-coded 404 was not a completed handback: the failure is
    // logged and the lease stays owed for a later terminal route.
    expect(release).toHaveBeenCalledTimes(1);
    expect(
      stderr.mock.calls
        .map(([line]) => line)
        .some((line) => line.includes('failed after the cancellation settled')),
    ).toBe(true);
    // Close is the terminal route with no later retry: it hands the owed
    // lease back itself instead of leaving the Workspace lease pinned.
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    ).expect(204);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('keeps the adoption owed through a failed terminal write and settles on the redriven cancel', async () => {
    await parkToolTurn();
    // The parked execution already settled before the owner died: the
    // cancel only has to confirm it, settle the Turn, and release.
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    });
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    let failTerminalWrite = false;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      function (this: ManagedSessionRecordSink, record) {
        if (failTerminalWrite && record.subtype === 'turn_result') {
          failTerminalWrite = false;
          throw new Error('store hiccup');
        }
        return originalWrite.call(this, record);
      },
    );
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      checkpointId: string;
      activationId: string;
    };
    const cancelTurn = () =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId as string)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    // A store hiccup on the terminal turn_result write only. Releasing the
    // adopted session before that write would leave the Turn unsettled with
    // its identity RELEASED — no retry could ever re-acquire it.
    failTerminalWrite = true;
    const first = await cancelTurn();
    expect(first.status).toBe(503);
    expect(first.body.code).toBe('managed_runtime_cancel_failed');
    expect(release).not.toHaveBeenCalled();
    // The first attempt advanced the checkpoint before the write failed, so
    // the redriven cancel still carries the load-time snapshot. The daemon
    // never re-loads an attached Session, so the route re-admits it against
    // the current checkpoint — the owed, still-READY lease stays acquirable
    // for exactly this retry.
    const retried = await cancelTurn();
    expect(retried.status).toBe(200);
    expect(retried.body.accepted).toBe(true);
    // The retry released once, after the terminal record landed.
    expect(release).toHaveBeenCalledTimes(1);
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_complete',
          promptId: PROMPT_ID,
          data: expect.objectContaining({ stopReason: 'cancelled' }),
        }),
      ]),
    );
    // A replayed cancel replays at the admission watermark it was admitted
    // under, same as before.
    const replayed = await cancelTurn();
    expect(replayed.status).toBe(200);
    expect(replayed.body.lastEventId).toBe(retried.body.lastEventId);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('keeps the lease owed when the takeover load cannot verify workspace writes', async () => {
    await parkToolTurn();
    let released = false;
    acquireSpy.mockImplementation(async () => {
      if (released)
        throw new HostedWorkspaceBrokerRejection(
          409,
          'runtime_session_not_acquirable',
        );
    });
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockImplementation(async () => {
        released = true;
      });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'prepared',
    });
    const stderr = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => undefined);
    // The restore-stage write probe passes, so the passive takeover adopts
    // first; the post-recovery probe then rejects once.
    state.assertWritable
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('writer lost'));
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(stderr.mock.calls.map(([line]) => line)).toContain(
      `qwen serve: Hosted Session ${SESSION_ID} load refused (workspace_writable): Error: writer lost`,
    );
    expect(acquireSpy).toHaveBeenCalled();
    // The refusal invited a retried takeover load: the adopted lease must
    // stay owed — but never silently, since a Session closed before
    // registration leaves no route to hand it back.
    expect(release).not.toHaveBeenCalled();
    const owedLines = () =>
      stderr.mock.calls.filter(
        ([line]) =>
          typeof line === 'string' &&
          line.includes('stays owed') &&
          line.includes(PROMPT_ID),
      );
    expect(owedLines()).toHaveLength(1);
    // The retried takeover on the same daemon re-acquires the READY
    // identity idempotently and reports.
    const reloaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(reloaded.status).toBe(200);
    expect(
      reloaded.body._meta?.['qwen.daemon.managedRuntimeRecovery'],
    ).toBeDefined();
    expect(owedLines()).toHaveLength(1);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('records the owed adoption when every takeover load refuses the workspace writes', async () => {
    await parkToolTurn();
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'prepared',
    });
    const stderr = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => undefined);
    const owedLines = () =>
      stderr.mock.calls.filter(
        ([line]) =>
          typeof line === 'string' &&
          line.includes('stays owed') &&
          line.includes(PROMPT_ID),
      );
    // The probe rejects after every adoption, on every attempt: the refusal
    // is persistent, so the same daemon keeps refusing.
    let probeCalls = 0;
    state.assertWritable.mockImplementation(async () => {
      probeCalls += 1;
      if (probeCalls % 2 === 0) throw new Error('writer lost');
    });
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(409);
    expect(stderr.mock.calls.map(([line]) => line)).toContain(
      `qwen serve: Hosted Session ${SESSION_ID} load refused (workspace_writable): Error: writer lost`,
    );
    const second = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(second.status).toBe(409);
    // Every refused attempt re-adopts the same READY identity — never
    // releasing it, or the wedge this PR removes would reopen — while the
    // stranded adoption is reported exactly once per identity, by name.
    expect(acquireSpy).toHaveBeenCalledTimes(2);
    expect(release).not.toHaveBeenCalled();
    expect(owedLines()).toHaveLength(1);
    // The next successful load drains the record, so a later refusal must
    // report again rather than stay silent on a stale one.
    state.assertWritable.mockImplementation(async () => undefined);
    probeCalls = 0;
    const third = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(third.status).toBe(200);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    state.assertWritable.mockImplementation(async () => {
      probeCalls += 1;
      if (probeCalls % 2 === 0) throw new Error('writer lost');
    });
    probeCalls = 0;
    const fourth = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(fourth.status).toBe(409);
    expect(owedLines()).toHaveLength(2);
    // Only the successful Session's own teardown released anything.
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('keeps the lease held when the cancel meets a blocked session', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      checkpointId: string;
      activationId: string;
    };
    // Drive the recovered turn, then flip the session blocked with an
    // unrecoverable write — same mechanism the continuation fixture uses.
    state.model.mockRejectedValueOnce(
      new HostedToolRecoveryRequiredError(new Error('store gone')),
    );
    const continued = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
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
        ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
        expect(status.body.recoveryBlocked).toBe(true);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    // The recovery-blocked exit keeps the adopted lease held: no handback is
    // attempted there, since a successful release would persist RELEASED and
    // the next takeover's same-identity re-acquire would conflict forever.
    expect(release).not.toHaveBeenCalled();
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(cancelled.status).toBe(409);
    expect(cancelled.body.code).toBe('hosted_turn_recovery_required');
    expect(cancelled.body.reason).toBe('turn_blocked');
    // The blocked refusal must not hand back an owed lease: the workspace
    // outlives this refusal, and a RELEASED identity can never be
    // re-acquired by the retirement-time retry.
    expect(release).not.toHaveBeenCalled();
    // The close owns the adopted lease's single handback.
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    ).expect(204);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'claims recovery cancellation once after concurrent child fences (first completed: %s)',
    async (firstCompleted) => {
      await parkToolTurn();
      let stopped = false;
      vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
        async () => ({
          state: stopped ? 'settled' : 'prepared',
        }),
      );
      const { server, loaded } = await loadReplacement(true);
      expect(loaded.status).toBe(200);
      const resident = (
        wakeDeps.last as {
          session: {
            managed: Awaited<ReturnType<typeof openManagedSession>>;
            publicChildAgentsVersion?: 1;
            childAgents?: HostedChildAgentSession;
          };
        }
      ).session;
      resident.publicChildAgentsVersion = 1;
      resident.childAgents = new HostedChildAgentSession(
        {
          authority: resident.managed.authority,
          resources: resident.managed.resources,
        },
        resident.managed.authority.sessionHeader.sessionKey,
      );
      let releaseFirst!: () => void;
      let releaseSecond!: () => void;
      let releaseBroker!: () => void;
      const gates = [
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
        new Promise<void>((resolve) => {
          releaseSecond = resolve;
        }),
      ];
      const brokerGate = new Promise<void>((resolve) => {
        releaseBroker = resolve;
      });
      const original = HostedChildAgentSession.prototype.cancelSourcePrompt;
      let fenceCount = 0;
      const fence = vi
        .spyOn(HostedChildAgentSession.prototype, 'cancelSourcePrompt')
        .mockImplementation(async function (
          this: HostedChildAgentSession,
          promptId,
          commit,
        ) {
          await gates[fenceCount++];
          await original.call(this, promptId, commit);
        });
      const cancel = vi
        .mocked(HostedWorkspaceBroker.prototype.cancel)
        .mockImplementation(async () => {
          await brokerGate;
          stopped = true;
        });
      cancel.mockClear();
      const recovery = loaded.body._meta?.[
        'qwen.daemon.managedRuntimeRecovery'
      ] as {
        checkpointId: string;
        activationId: string;
      };
      const send = () =>
        replacementHeaders(
          supertest(server).post(
            `/session/${SESSION_ID}/managed-runtime/cancel`,
          ),
        )
          .set('X-Qwen-Client-Id', loaded.body.clientId as string)
          .send({
            promptId: PROMPT_ID,
            checkpointId: recovery.checkpointId,
            activationId: recovery.activationId,
          });
      const completed: supertest.Response[] = [];
      const record = (response: supertest.Response) => {
        completed.push(response);
        return response;
      };
      const first = send().then(record);
      const second = send().then(record);
      try {
        await vi.waitFor(() => expect(fence).toHaveBeenCalledTimes(2), {
          timeout: settleTimeoutMs(),
        });
        releaseFirst();
        await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1), {
          timeout: settleTimeoutMs(),
        });
        if (firstCompleted) {
          releaseBroker();
          await vi.waitFor(() => expect(completed).toHaveLength(1), {
            timeout: settleTimeoutMs(),
          });
          expect(completed[0].status).toBe(200);
        }
        releaseSecond();
        await vi.waitFor(
          () =>
            expect(
              completed.length > (firstCompleted ? 1 : 0) ||
                cancel.mock.calls.length > 1,
            ).toBe(true),
          {
            timeout: settleTimeoutMs(),
          },
        );
        expect(cancel).toHaveBeenCalledTimes(1);
        releaseBroker();
        const responses = await Promise.all([first, second]);
        expect(responses.map((response) => response.status)).toEqual([
          200, 200,
        ]);
        expect(responses[1].body.lastEventId).toBe(
          responses[0].body.lastEventId,
        );
        const events = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
        expect(
          events.body.events.filter(
            (event: { type: string; promptId?: string }) =>
              event.type === 'turn_complete' && event.promptId === PROMPT_ID,
          ),
        ).toHaveLength(1);
      } finally {
        releaseFirst();
        releaseSecond();
        releaseBroker();
        await Promise.allSettled([first, second]);
        await replacementHeaders(
          supertest(server).delete(`/session/${SESSION_ID}`),
        );
      }
    },
  );

  it('answers a settled cancellation even when the final handback fails', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    });
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockRejectedValueOnce(new Error('broker unreachable'))
      .mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      checkpointId: string;
      activationId: string;
    };
    const cancelTurn = () =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId as string)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    // The terminal record is durable before the handback runs, so a release
    // failure must not refuse an already-settled cancellation.
    const cancelled = await cancelTurn();
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.accepted).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_complete',
          promptId: PROMPT_ID,
          data: expect.objectContaining({ stopReason: 'cancelled' }),
        }),
      ]),
    );
    // The admission survives the failed handback: a replay still replays at
    // its watermark, and the replay discharges the owed lease — the failed
    // handback (call 1) plus the replay's own (call 2).
    const replayed = await cancelTurn();
    expect(replayed.status).toBe(200);
    expect(replayed.body.lastEventId).toBe(cancelled.body.lastEventId);
    expect(release).toHaveBeenCalledTimes(2);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    // The teardown must not re-release an already-discharged lease.
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('refuses to settle a cancellation the Broker never confirmed', async () => {
    await parkToolTurn();
    // The cancel is accepted but the stop can never be observed: the
    // execution state becomes unreadable right after it.
    const status = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'status')
      .mockResolvedValueOnce({ state: 'prepared' })
      .mockResolvedValueOnce({ state: 'executing' })
      .mockRejectedValue(new Error('broker gone'));
    const cancel = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'cancel')
      .mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const send = () =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    const cancelled = await send();
    expect(cancelled.status).toBe(503);
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    // No terminal record may land while the stop is unconfirmed, and the
    // owned Turn keeps the Session refused rather than reading as settled.
    expect(
      (
        transcript.body.events as Array<{ type: string; promptId?: string }>
      ).filter(
        (event) =>
          event.type === 'turn_complete' && event.promptId === PROMPT_ID,
      ),
    ).toHaveLength(0);
    const between = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(between.body.hasActivePrompt).toBe(true);
    // The coordinator's retry re-drives the same cancellation to settlement.
    let stopConfirmed = false;
    status.mockImplementation(async () => ({
      state: stopConfirmed ? 'settled' : 'prepared',
    }));
    cancel.mockImplementation(async () => {
      stopConfirmed = true;
    });
    const retried = await send();
    expect(retried.status).toBe(200);
    await vi.waitFor(
      async () => {
        const later = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(later.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('keeps an unobserved execution honest when the retry re-reads it as stopped', async () => {
    await parkToolTurn([CALL, CALL_B]);
    const EXEC_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const EXEC_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    // Attempt 1: the first execution is read executing, cancelled, and then
    // its record vanishes — counted as unobserved — before the second
    // execution's still-reconcilable unknown throws the stop away,
    // discarding the counted set with the return value.
    let vanished = false;
    const status = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'status')
      .mockImplementation(async (id) => {
        if (id === EXEC_A) return vanished ? undefined : { state: 'executing' };
        return { state: 'unknown' };
      });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockImplementation(
      async (id) => {
        if (id === EXEC_A) vanished = true;
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const send = () =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    const first = await send();
    expect(first.status).toBe(503);
    expect(
      (
        (
          await replacementHeaders(
            supertest(server).get(`/session/${SESSION_ID}/transcript`),
          ).set('X-Qwen-Client-Id', clientId)
        ).body.events as Array<{ type: string }>
      ).filter((event) => event.type === 'turn_complete'),
    ).toHaveLength(0);
    // Attempt 2: the reclaimed record now reads as already-stopped to the
    // fresh stop, so only the carried set keeps the retry from certifying a
    // witnessed cancellation nobody observed.
    status.mockImplementation(async (id) =>
      id === EXEC_B ? { state: 'settled' } : undefined,
    );
    const retried = await send();
    expect(retried.status).toBe(200);
    expect(retried.body.accepted).toBe(true);
    const settled = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    const outcomes = new Map(
      (settled.body.events as Array<{ data?: { record?: ChatRecord } }>)
        .flatMap((event) =>
          event.data?.record?.type === 'tool_result' &&
          event.data.record.daemonPromptId === PROMPT_ID
            ? [event.data.record]
            : [],
        )
        .map((record) => {
          const response = record.message?.parts?.[0]?.functionResponse;
          return [
            response?.id,
            (response?.response as Record<string, unknown> | undefined)?.[
              'executionStatus'
            ],
          ] as const;
        }),
    );
    expect(outcomes.get('call-1')).toBe('unknown');
    expect(outcomes.get('call-2')).toBe('cancelled');
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('keeps the cancellation re-drivable when the settle cannot verify the park', async () => {
    await parkToolTurn();
    // The stop proves quickly (the execution is already settled), so only
    // the settle's own authorization read — tens of seconds after the
    // admission and stop reads — comes back non-runnable.
    const status = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'status')
      .mockResolvedValue({ state: 'settled' });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const original =
      LocalManagedSessionAuthority.prototype.harnessRunAuthorization;
    let authorizationReads = 0;
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockImplementation(async function (this: LocalManagedSessionAuthority) {
      authorizationReads += 1;
      if (authorizationReads === 3)
        return { status: 'blocked', reason: 'missing_state' } as never;
      return original.call(this);
    });
    const send = () =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    const cancelled = await send();
    // A settle that could not verify the park journaled nothing, so the
    // route must answer the retry-inviting refusal — never a 200 over a
    // terminal record the parked executions did not earn.
    expect(cancelled.status).toBe(503);
    expect(cancelled.body.code).toBe('managed_runtime_cancel_failed');
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(
      (
        transcript.body.events as Array<{ type: string; promptId?: string }>
      ).filter(
        (event) =>
          event.type === 'turn_complete' && event.promptId === PROMPT_ID,
      ),
    ).toHaveLength(0);
    const between = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(between.body.hasActivePrompt).toBe(true);
    // The admission was dropped with the failure, so the coordinator's
    // retry re-drives the stop instead of replaying a watermark — the
    // broker read proves the drive re-ran.
    status.mockClear();
    const retried = await send();
    expect(retried.status).toBe(200);
    expect(retried.body.accepted).toBe(true);
    expect(status).toHaveBeenCalled();
    const settled = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(
      (
        settled.body.events as Array<{ type: string; promptId?: string }>
      ).filter(
        (event) =>
          event.type === 'turn_complete' && event.promptId === PROMPT_ID,
      ),
    ).toHaveLength(1);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('refuses cancel with a mismatched recovery identity', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'prepared',
    });
    const cancel = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'cancel')
      .mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: 'ckpt-from-another-epoch',
        activationId: 'activation-from-another-epoch',
      });
    expect(cancelled.status).toBe(409);
    expect(cancelled.body.code).toBe('hosted_recovery_identity_mismatch');
    expect(cancel).not.toHaveBeenCalled();
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(
      (transcript.body.events as Array<{ type: string }>).filter(
        (event) => event.type === 'turn_complete',
      ),
    ).toHaveLength(0);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('replays a lost cancel admission at its watermark while it runs', async () => {
    await parkToolTurn();
    let stopConfirmed = false;
    const status = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'status')
      .mockImplementation(async () => ({
        state: stopConfirmed ? 'settled' : 'prepared',
      }));
    // Hold the cancel's confirmation open so the replay meets it in flight.
    let releaseCancel!: () => void;
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockImplementation(
      () => cancelGate,
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const send = () =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    // The stop step's first status read proves the first cancel was admitted
    // (the route registers the admission before the body runs), so the replay
    // deterministically meets the in-flight admission — polling /status
    // cannot prove this once a takeover also reports the Session in flight.
    let stopStarted!: () => void;
    const stopStartedGate = new Promise<void>((resolve) => {
      stopStarted = resolve;
    });
    status.mockImplementation(async () => {
      stopStarted();
      return { state: stopConfirmed ? 'settled' : 'prepared' };
    });
    // supertest Test objects are lazy: only a continuation sends the request.
    // Arm the first cancel without awaiting it — its reply lands only after
    // the cancelGate below is released.
    const first = send();
    void first.then(
      () => undefined,
      () => undefined,
    );
    await stopStartedGate;
    const replayed = await send();
    expect(replayed.status).toBe(200);
    expect(replayed.body.accepted).toBe(true);
    stopConfirmed = true;
    releaseCancel();
    const answered = await first;
    expect(answered.status).toBe(200);
    expect(replayed.body.lastEventId).toBe(answered.body.lastEventId);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('drives a takeover cancellation over a terminally abandoned execution', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'abandoned',
    });
    const cancel = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'cancel')
      .mockResolvedValue();
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      phase: string;
      checkpointId: string;
      activationId: string;
      executions: Array<Record<string, unknown>>;
    };
    // A terminally fenced record keeps its distinction — it is reported to
    // the coordinator, not folded away — and stays drivable, because the
    // stop step already accepts it as cancellation-complete.
    expect(recovery.executions).toEqual([
      expect.objectContaining({
        outcome: 'known',
        status: { state: 'abandoned' },
      }),
    ]);
    const armed = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(armed.body.hasActivePrompt).toBe(true);
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(cancelled.status).toBe(200);
    expect(cancel).not.toHaveBeenCalled();
    await vi.waitFor(
      async () => {
        const transcript = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_complete',
              promptId: PROMPT_ID,
              data: expect.objectContaining({ stopReason: 'cancelled' }),
            }),
          ]),
        );
      },
      { timeout: settleTimeoutMs() },
    );
    expect(release).toHaveBeenCalledTimes(1);
    // The execution's stop was never observed — the durable record must say
    // so instead of certifying a cancellation nobody witnessed.
    const settledTranscript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    const toolResults = (
      settledTranscript.body.events as Array<{
        data?: { record?: ChatRecord };
      }>
    ).flatMap((event) =>
      event.data?.record?.type === 'tool_result' &&
      event.data.record.daemonPromptId === PROMPT_ID
        ? [event.data.record]
        : [],
    );
    expect(toolResults).toHaveLength(1);
    const outcome = toolResults[0]?.message?.parts?.[0]?.functionResponse
      ?.response as Record<string, unknown> | undefined;
    expect(outcome?.['executionStatus']).toBe('unknown');
    expect(String(outcome?.['error'])).toContain('could not be observed');
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('keeps the failed stop re-drivable after a replay certified the cancel', async () => {
    await parkToolTurn();
    const status = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'status')
      .mockImplementation(async () => ({ state: 'prepared' }));
    let releaseCancel!: () => void;
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    const cancel = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'cancel')
      .mockImplementation(() => cancelGate);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const send = () =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    let stopStarted!: () => void;
    const stopStartedGate = new Promise<void>((resolve) => {
      stopStarted = resolve;
    });
    status.mockImplementation(async () => {
      stopStarted();
      return { state: 'prepared' };
    });
    // supertest requests are lazy until a continuation is attached.
    const first = send();
    void first.then(
      () => undefined,
      () => undefined,
    );
    await stopStartedGate;
    const replayed = await send();
    expect(replayed.status).toBe(200);
    expect(replayed.body.accepted).toBe(true);
    // The replay answered 200 while the first drive still ran, but the
    // first request's 503 is retry-inviting: a failure before anything
    // durable moved must stay re-drivable, never latched into a permanent
    // block the retry would meet.
    status.mockRejectedValue(new Error('broker gone'));
    releaseCancel();
    const answered = await first;
    expect(answered.status).toBe(503);
    const later = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(later.body.hasActivePrompt).toBe(true);
    expect(later.body.recoveryBlocked).toBe(false);
    // The armed recovery marker is the loud signal: a user cancel and a
    // fresh prompt keep refusing while the Turn stays undriven.
    const userCancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/cancel`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(userCancelled.status).toBe(409);
    expect(userCancelled.body.code).toBe('hosted_turn_recovery_required');
    const freshPrompt = [{ type: 'text', text: 'next turn' }];
    const prompted = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: freshPrompt,
        promptId: '88888888-8888-4888-8888-888888888888',
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(freshPrompt)).digest('hex')}`,
      });
    expect(prompted.status).toBe(409);
    expect(prompted.body.code).toBe('hosted_turn_active');
    // The coordinator's retry falls through the replay branch to the
    // attached-to-unsettled drive and settles the Turn.
    let stopConfirmed = false;
    status.mockImplementation(async () => ({
      state: stopConfirmed ? 'settled' : 'prepared',
    }));
    cancel.mockImplementation(async () => {
      stopConfirmed = true;
    });
    const retried = await send();
    expect(retried.status).toBe(200);
    expect(retried.body.accepted).toBe(true);
    await vi.waitFor(
      async () => {
        const transcript = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_complete',
              promptId: PROMPT_ID,
              data: expect.objectContaining({ stopReason: 'cancelled' }),
            }),
          ]),
        );
      },
      { timeout: settleTimeoutMs() },
    );
    const settled = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(settled.body.hasActivePrompt).toBe(false);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('admits the post-settle failure loudly once the checkpoint has moved', async () => {
    await parkToolTurn();
    let stopConfirmed = false;
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
      async () => ({ state: stopConfirmed ? 'settled' : 'prepared' }),
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockImplementation(
      async () => {
        stopConfirmed = true;
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    // The stop already confirmed and the cancelled journal entries landed,
    // so the checkpoint has moved — and a failure from here can never be
    // re-driven against the same recovery identity again.
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'commitDomainRecord',
    ).mockRejectedValueOnce(new Error('history write rejected'));
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(cancelled.status).toBe(503);
    // The checkpoint already moved, so the idempotent second settle inside
    // the branch acts the same retry-any-way guarantee: the cancelled
    // outcome is durable, and the Session is usable rather than armed.
    const later = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(later.body.hasActivePrompt).toBe(false);
    expect(later.body.recoveryBlocked).toBe(false);
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_complete',
          promptId: PROMPT_ID,
          data: expect.objectContaining({ stopReason: 'cancelled' }),
        }),
      ]),
    );
    const freshPrompt = [{ type: 'text', text: 'next turn' }];
    const prompted = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: freshPrompt,
        promptId: '88888888-8888-4888-8888-888888888888',
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(freshPrompt)).digest('hex')}`,
      });
    expect(prompted.status).toBe(202);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    // …and the retirement it skipped stays owed: the admitted prompt's
    // admission drive retires the durable marker ahead of the new Turn (the
    // close-path discharger is the sibling test's witness), so the cold
    // load is still admitted instead of refusing every later restore
    // forever.
    await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/detach`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .expect(204);
    const reloaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
    });
    expect(reloaded.status).toBe(200);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('disarms the marker when the terminal record committed but its acknowledgement was lost', async () => {
    await parkToolTurn();
    let stopConfirmed = false;
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
      async () => ({ state: stopConfirmed ? 'settled' : 'prepared' }),
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockImplementation(
      async () => {
        stopConfirmed = true;
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const send = () =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    // The terminal write commits durably and only its acknowledgement is
    // lost: the Turn IS settled, so no attached-to-unsettled retry could
    // ever re-drive — the armed marker would wedge the Session forever.
    // The fault is gated so only the recovered Turn's record loses its
    // acknowledgement; the fresh prompt below must settle cleanly.
    let failFinalSettlement = true;
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      async function (this: ManagedSessionRecordSink, recordToWrite) {
        if (recordToWrite.subtype === 'turn_result' && failFinalSettlement) {
          await originalWrite.call(this, recordToWrite);
          throw new Error('acknowledgement lost');
        }
        return originalWrite.call(this, recordToWrite);
      },
    );
    const cancelled = await send();
    expect(cancelled.status).toBe(503);
    expect(cancelled.body.code).toBe('managed_runtime_cancel_failed');
    // The record landed durably, so the retried cancel is answered from the
    // committed watermark by the settled replay — and the marker is
    // disarmed rather than left armed on a Session nothing could clear.
    const retried = await send();
    expect(retried.status).toBe(200);
    expect(retried.body.accepted).toBe(true);
    const status = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(status.body.hasActivePrompt).toBe(false);
    expect(status.body.recoveryBlocked).toBe(false);
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_complete',
          promptId: PROMPT_ID,
          data: expect.objectContaining({ stopReason: 'cancelled' }),
        }),
      ]),
    );
    // A fresh prompt is admitted over the cleanly cancelled Turn, with the
    // acknowledgement fault disarmed so the phase witnesses a clean settle.
    failFinalSettlement = false;
    const freshPrompt = [{ type: 'text', text: 'next turn' }];
    const prompted = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: freshPrompt,
        promptId: '88888888-8888-4888-8888-888888888888',
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(freshPrompt)).digest('hex')}`,
      });
    expect(prompted.status).toBe(202);
    // Let the admitted Turn finish before the teardown removes its root.
    // hasActivePrompt cannot see a refused settle, so the clean-settle
    // claim is witnessed on the recoveryBlocked latch it would set.
    await vi.waitFor(
      async () => {
        const settled = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(settled.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    const settled = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(settled.body.recoveryBlocked).toBe(false);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('disarms the marker when a re-driven settle noops over a record its write already committed', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const send = () =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    // Attempt 1's terminal writes are refused without committing, so its
    // failure is genuinely re-drivable. Attempt 2's settle noops over the
    // already-resolved executions, so the drive reaches the terminal write
    // with nothing durable moved — and that write commits while losing its
    // acknowledgement. The branch that treats the failure as fully
    // re-drivable must still read the committed turn.settled and disarm,
    // or the Session wedges on a record that exists.
    let phase: 'reject' | 'commit-then-reject' | 'clean' = 'reject';
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      async function (this: ManagedSessionRecordSink, recordToWrite) {
        if (recordToWrite.subtype === 'turn_result') {
          if (phase === 'reject')
            throw new Error('terminal record write rejected');
          if (phase === 'commit-then-reject') {
            phase = 'clean';
            await originalWrite.call(this, recordToWrite);
            throw new Error('terminal record acknowledgement lost');
          }
        }
        return originalWrite.call(this, recordToWrite);
      },
    );
    const first = await send();
    expect(first.status).toBe(503);
    expect(first.body.code).toBe('managed_runtime_cancel_failed');
    const armed = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(armed.body.hasActivePrompt).toBe(true);
    phase = 'commit-then-reject';
    const second = await send();
    expect(second.status).toBe(503);
    // The record committed, so the Session is not wedged: the marker is
    // disarmed and a fresh prompt is admitted.
    const disarmed = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(disarmed.body.hasActivePrompt).toBe(false);
    expect(disarmed.body.recoveryBlocked).toBe(false);
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(
      (
        transcript.body.events as Array<{ type: string; promptId?: string }>
      ).filter(
        (event) =>
          event.type === 'turn_complete' && event.promptId === PROMPT_ID,
      ),
    ).toHaveLength(1);
    const freshPrompt = [{ type: 'text', text: 'next turn' }];
    const prompted = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: freshPrompt,
        promptId: '88888888-8888-4888-8888-888888888888',
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(freshPrompt)).digest('hex')}`,
      });
    expect(prompted.status).toBe(202);
    // Let the admitted Turn finish before the teardown removes its root.
    await vi.waitFor(
      async () => {
        const settled = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(settled.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('writes the terminal record when a certified replay meets a post-settle failure', async () => {
    await parkToolTurn();
    let stopConfirmed = false;
    const status = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'status')
      .mockImplementation(async () => ({
        state: stopConfirmed ? 'settled' : 'prepared',
      }));
    let releaseCancel!: () => void;
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockImplementation(
      () => cancelGate,
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const send = () =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    let stopStarted!: () => void;
    const stopStartedGate = new Promise<void>((resolve) => {
      stopStarted = resolve;
    });
    status.mockImplementation(async () => {
      stopStarted();
      return { state: stopConfirmed ? 'settled' : 'prepared' };
    });
    // supertest requests are lazy until a continuation is attached.
    const first = send();
    void first.then(
      () => undefined,
      () => undefined,
    );
    await stopStartedGate;
    const replayed = await send();
    expect(replayed.status).toBe(200);
    expect(replayed.body.accepted).toBe(true);
    // The replay certified this cancellation while in flight, so when a
    // post-settle step then fails, the branch that has the cancellable
    // checkpoint must still land the terminal record the coordinator is
    // streaming for at the watermark.
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'commitDomainRecord',
    ).mockRejectedValueOnce(new Error('history write rejected'));
    stopConfirmed = true;
    releaseCancel();
    const answered = await first;
    expect(answered.status).toBe(503);
    await vi.waitFor(
      async () => {
        const transcript = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_complete',
              promptId: PROMPT_ID,
              data: expect.objectContaining({ stopReason: 'cancelled' }),
            }),
          ]),
        );
      },
      { timeout: settleTimeoutMs() },
    );
    const later = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(later.body.hasActivePrompt).toBe(false);
    expect(later.body.recoveryBlocked).toBe(false);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('admits a partially applied settle loudly once its identity already moved', async () => {
    await parkToolTurn([CALL, CALL_B]);
    let stopConfirmed = false;
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
      async () => ({ state: stopConfirmed ? 'settled' : 'prepared' }),
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockImplementation(
      async () => {
        stopConfirmed = true;
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const send = () =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    // The settle moves the checkpoint one resolveAwaitRuntime at a time, so
    // failing the SECOND execution's journal write has already outgrown the
    // identity its retry would have to match — no re-drive can ever land.
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    let toolResultWrites = 0;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      function (this: ManagedSessionRecordSink, recordToWrite) {
        if (
          recordToWrite.type === 'tool_result' &&
          recordToWrite.daemonPromptId === PROMPT_ID &&
          ++toolResultWrites === 2
        )
          throw new Error('history write rejected');
        return originalWrite.call(this, recordToWrite);
      },
    );
    const cancelled = await send();
    expect(cancelled.status).toBe(503);
    let transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    // The partially settled identity still settles loudly: the second,
    // idempotent settle completes inside the failure branch, and the
    // cancelled terminal record lands.
    await vi.waitFor(
      async () => {
        transcript = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_complete',
              promptId: PROMPT_ID,
              data: expect.objectContaining({ stopReason: 'cancelled' }),
            }),
          ]),
        );
      },
      { timeout: settleTimeoutMs() },
    );
    const later = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(later.body.hasActivePrompt).toBe(false);
    expect(later.body.recoveryBlocked).toBe(false);
    // The admission stays certified, so replaying the same cancel answers
    // its recorded watermark, and the settled outcome is observable from
    // there — nothing stays armed.
    const replayed = await send();
    expect(replayed.status).toBe(200);
    expect(replayed.body.accepted).toBe(true);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('re-drives a partially applied settle that could not finish once the store heals', async () => {
    await parkToolTurn([CALL, CALL_B]);
    let stopConfirmed = false;
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
      async () => ({ state: stopConfirmed ? 'settled' : 'prepared' }),
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockImplementation(
      async () => {
        stopConfirmed = true;
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    // The second execution's journal write refuses while the store is sick:
    // the first execution's write lands so the settle partially applies and
    // moves the checkpoint, and the idempotent second settle inside the
    // failure branch cannot finish either.
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    let failSettleWrites = false;
    let toolResultWrites = 0;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      function (this: ManagedSessionRecordSink, recordToWrite) {
        if (
          failSettleWrites &&
          recordToWrite.type === 'tool_result' &&
          recordToWrite.daemonPromptId === PROMPT_ID &&
          ++toolResultWrites >= 2
        )
          throw new Error('history write rejected');
        return originalWrite.call(this, recordToWrite);
      },
    );
    const send = (snapshot: { checkpointId: string; activationId: string }) =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: snapshot.checkpointId,
          activationId: snapshot.activationId,
        });
    failSettleWrites = true;
    const cancelled = await send(recovery);
    expect(cancelled.status).toBe(503);
    expect(cancelled.body.code).toBe('managed_runtime_cancel_failed');
    // A settle that could not finish is still re-drivable: the admission is
    // dropped so the coordinator's retry re-runs the idempotent settle, and
    // the armed marker — not a permanent block — keeps the failure visible.
    const later = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(later.body.hasActivePrompt).toBe(true);
    expect(later.body.recoveryBlocked).toBe(false);
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(
      (
        transcript.body.events as Array<{ type: string; promptId?: string }>
      ).filter(
        (event) =>
          event.type === 'turn_complete' && event.promptId === PROMPT_ID,
      ),
    ).toHaveLength(0);
    // The still-sick retry is admitted and re-drives into the same 503
    // rather than meeting a permanent refusal.
    const sickRetry = await send(recovery);
    expect(sickRetry.status).toBe(503);
    expect(sickRetry.body.code).toBe('managed_runtime_cancel_failed');
    // The Turn never settled, so its file-history marker was never owed to
    // an in-memory retry: close must not retire it — a later takeover still
    // needs the marker to reconcile the resume.
    const before = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/files/history`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(before.body.history.pendingTurn).toBe(PROMPT_ID);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    ).expect(204);
    // …and a fresh incarnation over the same store still finds it — and
    // once the store heals, its re-driven cancel finishes the settle and
    // lands the terminal record.
    failSettleWrites = false;
    const restarted = await replacementApp();
    const reloaded = await replacementHeaders(
      supertest(restarted).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(reloaded.status).toBe(200);
    const history = await replacementHeaders(
      supertest(restarted).get(`/session/${SESSION_ID}/files/history`),
    ).set('X-Qwen-Client-Id', reloaded.body.clientId as string);
    expect(history.body.history.pendingTurn).toBe(PROMPT_ID);
    const healedRecovery = reloaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const healedClientId = reloaded.body.clientId as string;
    const healed = await replacementHeaders(
      supertest(restarted).post(
        `/session/${SESSION_ID}/managed-runtime/cancel`,
      ),
    )
      .set('X-Qwen-Client-Id', healedClientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: healedRecovery.checkpointId,
        activationId: healedRecovery.activationId,
      });
    expect(healed.status).toBe(200);
    expect(healed.body.accepted).toBe(true);
    const healedTranscript = await replacementHeaders(
      supertest(restarted).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', healedClientId);
    expect(healedTranscript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_complete',
          promptId: PROMPT_ID,
          data: expect.objectContaining({ stopReason: 'cancelled' }),
        }),
      ]),
    );
    const healedStatus = await replacementHeaders(
      supertest(restarted).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', healedClientId);
    expect(healedStatus.body.hasActivePrompt).toBe(false);
    expect(healedStatus.body.recoveryBlocked).toBe(false);
    await replacementHeaders(
      supertest(restarted).delete(`/session/${SESSION_ID}`),
    );
  });

  it('re-drives a cancel that moved nothing, even with a stale recovery checkpoint', async () => {
    await parkToolTurn();
    let stopConfirmed = false;
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
      async () => ({ state: stopConfirmed ? 'settled' : 'prepared' }),
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockImplementation(
      async () => {
        stopConfirmed = true;
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    // The admission fence keys on the activation plus the unsettled Turn
    // precisely because the checkpoint may legitimately have advanced
    // underneath, so the request's load-time checkpointId may already be
    // stale here — the failure classification must key on what this drive
    // moved, never on that stale identity.
    const cancelTurn = () =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: 'stale-checkpoint-id',
          activationId: recovery.activationId,
        });
    // The settle's first journal write refuses: nothing durable moved, so
    // the failure must stay re-drivable however stale the checkpointId is.
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    let failSettleWrites = false;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      function (this: ManagedSessionRecordSink, recordToWrite) {
        if (
          failSettleWrites &&
          recordToWrite.type === 'tool_result' &&
          recordToWrite.daemonPromptId === PROMPT_ID
        )
          throw new Error('history write rejected');
        return originalWrite.call(this, recordToWrite);
      },
    );
    failSettleWrites = true;
    const first = await cancelTurn();
    expect(first.status).toBe(503);
    expect(first.body.code).toBe('managed_runtime_cancel_failed');
    const retried = await cancelTurn();
    expect(retried.status).toBe(503);
    expect(retried.body.code).toBe('managed_runtime_cancel_failed');
    const later = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(later.body.recoveryBlocked).toBe(false);
    // Once the store heals, the same cancel re-drives to a clean settlement.
    failSettleWrites = false;
    const healed = await cancelTurn();
    expect(healed.status).toBe(200);
    expect(healed.body.accepted).toBe(true);
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_complete',
          promptId: PROMPT_ID,
          data: expect.objectContaining({ stopReason: 'cancelled' }),
        }),
      ]),
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('re-drives a cancel whose terminal record keeps failing instead of replaying a false success', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    });
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    let failTerminalWrites = false;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      function (this: ManagedSessionRecordSink, recordToWrite) {
        if (failTerminalWrites && recordToWrite.subtype === 'turn_result')
          return Promise.reject(new Error('terminal record write rejected'));
        return originalWrite.call(this, recordToWrite);
      },
    );
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const cancelTurn = () =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    // The settle lands but every terminal turn_result write is refused: the
    // admission must not stay to replay a watermark no turn_complete can
    // ever appear at — the failure stays re-drivable instead.
    failTerminalWrites = true;
    const first = await cancelTurn();
    expect(first.status).toBe(503);
    expect(first.body.code).toBe('managed_runtime_cancel_failed');
    const retried = await cancelTurn();
    expect(retried.status).toBe(503);
    expect(retried.body.code).toBe('managed_runtime_cancel_failed');
    expect(release).not.toHaveBeenCalled();
    const later = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(later.body.recoveryBlocked).toBe(false);
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(
      (
        transcript.body.events as Array<{ type: string; promptId?: string }>
      ).filter(
        (event) =>
          event.type === 'turn_complete' && event.promptId === PROMPT_ID,
      ),
    ).toHaveLength(0);
    // The retry path is intact: once the store heals, the same cancel
    // re-drives the idempotent settle and lands the terminal record.
    failTerminalWrites = false;
    const healed = await cancelTurn();
    expect(healed.status).toBe(200);
    expect(healed.body.accepted).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    const settled = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(settled.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_complete',
          promptId: PROMPT_ID,
          data: expect.objectContaining({ stopReason: 'cancelled' }),
        }),
      ]),
    );
    // With the fault disarmed before any fresh admission, the Session is
    // fully usable again: a new prompt writes its own terminal record and
    // nothing stays blocked.
    const freshPrompt = [{ type: 'text', text: 'after the healed cancel' }];
    const freshPromptId = '66666666-6666-4666-8666-666666666666';
    const admitted = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: freshPrompt,
        promptId: freshPromptId,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(freshPrompt)).digest('hex')}`,
      });
    expect(admitted.status).toBe(202);
    await vi.waitFor(
      async () => {
        const transcript = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_complete',
              promptId: freshPromptId,
            }),
          ]),
        );
      },
      { timeout: settleTimeoutMs() },
    );
    const idle = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(idle.body.hasActivePrompt).toBe(false);
    expect(idle.body.recoveryBlocked).toBe(false);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('keeps the pending marker and refuses a fresh prompt while the cancelled Turn lacks its terminal record', async () => {
    const dropSpy = vi.spyOn(hostedHistory, 'dropPendingHostedFileHistoryTurn');
    await parkToolTurn([CALL, CALL_B]);
    let stopConfirmed = false;
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
      async () => ({ state: stopConfirmed ? 'settled' : 'prepared' }),
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockImplementation(
      async () => {
        stopConfirmed = true;
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    // The first settle partially applies (its second journal write refuses
    // once) so the compensating settle completes it, but every terminal
    // turn_result write stays refused: the Turn is durably settled with no
    // terminal record.
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    let toolResultWrites = 0;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      function (this: ManagedSessionRecordSink, recordToWrite) {
        if (
          recordToWrite.type === 'tool_result' &&
          recordToWrite.daemonPromptId === PROMPT_ID &&
          ++toolResultWrites === 2
        )
          throw new Error('history write rejected');
        if (recordToWrite.subtype === 'turn_result')
          return Promise.reject(new Error('terminal record write rejected'));
        return originalWrite.call(this, recordToWrite);
      },
    );
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(cancelled.status).toBe(503);
    const later = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(later.body.recoveryBlocked).toBe(false);
    // Without the terminal record the Turn is still owed its drive, so a
    // fresh prompt keeps refusing — and no retirement site may drop the
    // pending marker a later takeover still needs to reconcile the resume.
    const freshPrompt = [{ type: 'text', text: 'next turn' }];
    const prompted = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: freshPrompt,
        promptId: '88888888-8888-4888-8888-888888888888',
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(freshPrompt)).digest('hex')}`,
      });
    expect(prompted.status).toBe(409);
    expect(prompted.body.code).toBe('hosted_turn_active');
    expect(dropSpy).not.toHaveBeenCalled();
    // Close owes no retirement for a Turn whose record never landed, so the
    // durable marker survives the incarnation boundary.
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    ).expect(204);
    expect(dropSpy).not.toHaveBeenCalled();
    const restarted = await replacementApp();
    const reloaded = await replacementHeaders(
      supertest(restarted).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(reloaded.status).toBe(200);
    const history = await replacementHeaders(
      supertest(restarted).get(`/session/${SESSION_ID}/files/history`),
    ).set('X-Qwen-Client-Id', reloaded.body.clientId as string);
    expect(history.body.history.pendingTurn).toBe(PROMPT_ID);
    await replacementHeaders(
      supertest(restarted).delete(`/session/${SESSION_ID}`),
    );
  });

  it('keeps a re-adopted lease when an earlier handback resolves late', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'executing',
    });
    let answerFirstRelease!: () => void;
    const firstRelease = new Promise<void>((resolve) => {
      answerFirstRelease = resolve;
    });
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockImplementationOnce(() => firstRelease)
      .mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    // A continue naming a stale recovery identity is refused and hands the
    // adopted lease back — that handback is still in flight…
    const mismatched = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: 'checkpoint-stale',
        activationId: 'activation-stale',
      });
    expect(mismatched.status).toBe(409);
    expect(mismatched.body.code).toBe('hosted_recovery_identity_mismatch');
    expect(release).toHaveBeenCalledTimes(1);
    // …when the redriven load re-answers the recovery and re-adopts the same
    // Runtime identity. The late success from the stale handback must not
    // clear the fresh adoption's record…
    const redriven = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(redriven.status).toBe(200);
    answerFirstRelease();
    // Flush the resolved continuation before the close reads the flags.
    await new Promise((resolve) => setImmediate(resolve));
    // …or the Session's close would skip the handback the Broker still
    // needs, leaking the Workspace lease the fresh adoption holds.
    const closed = await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(closed.status).toBe(204);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('keeps a re-adopted lease when an earlier handback rejects late', async () => {
    await parkToolTurn();
    let stopConfirmed = false;
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
      async () => ({ state: stopConfirmed ? 'settled' : 'prepared' }),
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockImplementation(
      async () => {
        stopConfirmed = true;
      },
    );
    let rejectFirstRelease!: (cause: unknown) => void;
    const firstRelease = new Promise<void>((_resolve, reject) => {
      rejectFirstRelease = reject;
    });
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockImplementationOnce(() => firstRelease)
      .mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    // A continue naming a stale recovery identity is refused and hands the
    // adopted lease back — that handback is still in flight…
    const mismatched = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: 'checkpoint-stale',
        activationId: 'activation-stale',
      });
    expect(mismatched.status).toBe(409);
    expect(mismatched.body.code).toBe('hosted_recovery_identity_mismatch');
    expect(release).toHaveBeenCalledTimes(1);
    // …when the redriven load re-answers the recovery and re-adopts the same
    // Runtime identity, bumping the lease epoch…
    const redriven = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(redriven.status).toBe(200);
    // …and only then does the stale handback reject. Its failure must NOT
    // arm the owed flag against the fresh adoption, or the next settled
    // prompt would hand back a lease the fresh adoption still holds.
    rejectFirstRelease(
      new HostedWorkspaceBrokerRejection(
        503,
        'runtime_reconciliation_required',
      ),
    );
    // Flush the rejected continuation before the cancel reads the flags.
    await new Promise((resolve) => setImmediate(resolve));
    // The cancellation settles the Turn durably, but its marker retirement
    // fails once: the post-settle failure path answers 503 and hands
    // nothing back, so the fresh adoption's lease is still held when the
    // next prompt runs.
    let failHistoryCommit = true;
    const originalCommit =
      LocalManagedSessionAuthority.prototype.commitDomainRecord;
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'commitDomainRecord',
    ).mockImplementation(async function (
      this: LocalManagedSessionAuthority,
      record,
      ...rest
    ) {
      if (failHistoryCommit && record.operation === 'commitFileHistory') {
        failHistoryCommit = false;
        throw new Error('history write rejected');
      }
      return originalCommit.call(this, record, ...rest);
    });
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(cancelled.status).toBe(503);
    expect(cancelled.body.code).toBe('managed_runtime_cancel_failed');
    const freshPrompt = [{ type: 'text', text: 'next turn' }];
    const prompted = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: freshPrompt,
        promptId: '88888888-8888-4888-8888-888888888888',
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(freshPrompt)).digest('hex')}`,
      });
    expect(prompted.status).toBe(202);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    // The settled prompt is a terminal route: it must NOT have handed the
    // fresh adoption's lease back — the stale failure armed nothing.
    expect(release).toHaveBeenCalledTimes(1);
    // The close owns the fresh adoption's one handback…
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    ).expect(204);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('settles the cancellation and owes the lease when its release is refused', async () => {
    await parkToolTurn();
    let stopConfirmed = false;
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
      async () => ({ state: stopConfirmed ? 'settled' : 'prepared' }),
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockImplementation(
      async () => {
        stopConfirmed = true;
      },
    );
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const releaseOwners: string[] = [];
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockImplementation(async function (this: HostedWorkspaceBroker) {
        releaseOwners.push(this.runtimeSessionId);
        if (release.mock.calls.length < 4)
          throw new HostedWorkspaceBrokerRejection(
            503,
            'runtime_reconciliation_required',
          );
        throw new HostedWorkspaceBrokerRejection(
          404,
          'runtime_session_not_found',
        );
      });
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const send = () =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    const cancelled = await send();
    // The executions were confirmed stopped, so the route settles the Turn
    // and owes the refused release instead of answering 503 for a lease the
    // Broker already fenced — and the settled-route finally leaves the owed
    // record for the later retry sites instead of racing it back-to-back.
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.accepted).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('failed after the cancellation settled'),
    );
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_complete',
          promptId: PROMPT_ID,
          data: expect.objectContaining({ stopReason: 'cancelled' }),
        }),
      ]),
    );
    // A settled prompt Turn is a retry pacing for the owed handback…
    const nextPrompt = [{ type: 'text', text: 'after the owed cancel' }];
    const admitted = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: nextPrompt,
        promptId: '55555555-5555-4555-8555-555555555555',
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(nextPrompt)).digest('hex')}`,
      });
    expect(admitted.status).toBe(202);
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2), {
      timeout: settleTimeoutMs(),
    });
    // …and a cancel replay is one more terminal route retrying it — the
    // flag clears only on a confirmed handback, so the refusal above keeps
    // it owed throughout.
    const replayed = await send();
    expect(replayed.status).toBe(200);
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(3), {
      timeout: settleTimeoutMs(),
    });
    // The Broker then definitively forgot the session: its 404 satisfies
    // the handback instead of being retried with log noise forever.
    const nextPrompt2 = [{ type: 'text', text: 'after the broker forgot' }];
    const admitted2 = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: nextPrompt2,
        promptId: '44444444-4444-4444-8444-444444444444',
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(nextPrompt2)).digest('hex')}`,
      });
    expect(admitted2.status).toBe(202);
    await vi.waitFor(
      async () => {
        const transcript2 = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(transcript2.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_complete',
              promptId: '44444444-4444-4444-8444-444444444444',
            }),
          ]),
        );
      },
      { timeout: settleTimeoutMs() },
    );
    expect(release).toHaveBeenCalledTimes(4);
    expect(new Set(releaseOwners).size).toBe(1);
    // The 404-satisfied handback already discharged the lease, so the close
    // is one more terminal route that must NOT release again.
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    ).expect(204);
    expect(release).toHaveBeenCalledTimes(4);
  });
});
