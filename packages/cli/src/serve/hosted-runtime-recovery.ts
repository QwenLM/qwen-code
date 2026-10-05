/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { Part } from '@google/genai';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import type { HarnessToolItem } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-checkpoint.js';
import {
  assertManagedSessionStableId,
  type ManagedSessionDurableRef,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import {
  convertToFunctionErrorResponse,
  convertToFunctionResponse,
} from '@qwen-code/qwen-code-core/core/coreToolScheduler.js';
import { HTTP_MANAGED_SESSION_STORE_CONTRACT } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import type { ManagedToolResultPayload } from './managed-runtime-tool-executor.js';
import { writeStderrLineSafe } from '../utils/stdioHelpers.js';
import {
  HostedWorkspaceBroker,
  type HostedWorkspaceBrokerOptions,
} from './hosted-workspace-broker.js';

/** The parked turn is not one this recovery can drive; the caller 409s. */
class RecoveryDeclined extends Error {}

export interface HostedRuntimeRecoveryExecution {
  functionCallId: string;
  toolName: string;
  executionCallId: string;
  runtimeSessionId: string;
  outcome: 'known' | 'unknown';
  status?: { state: string };
}

export interface HostedRuntimeRecoveryReport {
  phase: 'await_runtime' | 'results_ready';
  checkpointId: string;
  activationId: string;
  executions: HostedRuntimeRecoveryExecution[];
}

export interface HostedRecoveryTurn {
  promptId: string;
  report: HostedRuntimeRecoveryReport;
  /** Whether the recovery acquired the Runtime Session, which a later
   * continue/cancel must release. */
  acquiredRuntime: boolean;
}

async function originalRuntimeBroker(
  session: ManagedSession,
  promptId: string,
  items: readonly HarnessToolItem[],
  options: HostedWorkspaceBrokerOptions,
): Promise<HostedWorkspaceBroker> {
  const owners = new Set<string>();
  const intents = new Map(
    session.authority
      .eventsInSequenceRange(1, session.authority.committedSequence)
      .filter((event) => event.kind === 'tool.intent')
      .map((event) => [
        event.payload['executionCallId'],
        event.payload['argsRef'],
      ]),
  );
  for (const item of items) {
    if (item.outcomeSource !== 'runtime') continue;
    const ref = intents.get(item.executionCallId) as
      | ManagedSessionDurableRef
      | undefined;
    if (!ref) throw new RecoveryDeclined();
    if (
      ref.kind === 'managed-tool-args' &&
      item.toolName === 'run_shell_command'
    ) {
      const definition = JSON.parse(
        (
          await session.resources.read(
            session.authority.sessionHeader.definitionRef,
          )
        ).toString('utf8'),
      ) as { hookCatalog?: unknown; mcpServers?: unknown };
      if (definition.hookCatalog || definition.mcpServers)
        throw new RecoveryDeclined();
      owners.add(promptId);
      continue;
    }
    if (ref.kind !== 'managed-tool-input') throw new RecoveryDeclined();
    const route = JSON.parse(
      (await session.resources.read(ref)).toString('utf8'),
    ) as { harnessSessionId?: unknown; runtimeSessionId?: unknown };
    if (
      route.harnessSessionId !==
        session.authority.sessionHeader.sessionKey.sessionId ||
      typeof route.runtimeSessionId !== 'string'
    )
      throw new RecoveryDeclined();
    owners.add(
      assertManagedSessionStableId(
        route.runtimeSessionId,
        'recovered Runtime owner',
      ),
    );
  }
  const [runtimeSessionId] = owners;
  if (owners.size !== 1 || !runtimeSessionId) throw new RecoveryDeclined();
  return new HostedWorkspaceBroker(
    options,
    session.authority.sessionHeader.sessionKey,
    runtimeSessionId,
  );
}

function toolResultParts(
  item: HarnessToolItem,
  result: ManagedToolResultPayload,
): Part[] {
  const responseParts = result.responseParts as Part[];
  if (
    responseParts.some(
      (part) =>
        !part ||
        typeof part !== 'object' ||
        (typeof part.text !== 'string' && !part.inlineData && !part.fileData),
    )
  )
    throw new Error('Runtime returned an unsupported tool result.');
  const converted =
    result.executionStatus === 'success'
      ? convertToFunctionResponse(item.toolName, item.functionCallId, [
          ...responseParts,
        ])
      : convertToFunctionErrorResponse(
          item.toolName,
          item.functionCallId,
          [...responseParts],
          result.error?.message ?? `Runtime tool ${result.executionStatus}.`,
        );
  const response = converted[0]?.functionResponse;
  if (!response || converted.length !== 1)
    throw new Error('Runtime result cannot be represented durably.');
  response.response = {
    ...response.response,
    executionStatus: result.executionStatus,
    ...(result.error ? { runtimeError: result.error } : {}),
  };
  return converted;
}

function outcomeBytes(item: HarnessToolItem, parts: Part[]): Buffer {
  return Buffer.from(
    JSON.stringify({ executionCallId: item.executionCallId, ...parts[0] }),
  );
}

/**
 * Settles every parked Runtime execution of a cancelled turn with a cancelled
 * outcome, so the checkpoint can leave `await_runtime` and the following
 * terminal record can advance the session to a model-start phase.
 */
export async function settleParkedTurnCancelled(input: {
  session: ManagedSession;
  sessionId: string;
  cwd: string;
  promptId: string;
}): Promise<void> {
  const authorization = await input.session.authority.harnessRunAuthorization();
  if (authorization.status !== 'runnable') return;
  const checkpoint = authorization.checkpoint;
  if (checkpoint.identity.turnId !== input.promptId) return;
  const pending = (checkpoint.tools?.items ?? []).filter(
    (item) => item.state === 'in_progress' && item.outcomeSource === 'runtime',
  );
  if (pending.length === 0) return;
  const harness = createManagedHarnessHandle(input.session);
  // A write-then-resolve crash window must not journal a tool_result twice
  // when the cancel retries: collect what is already durable.
  const journaled = new Set(
    (await input.session.sink.project())
      .filter(
        (entry) =>
          entry.daemonPromptId === input.promptId &&
          entry.type === 'tool_result',
      )
      .flatMap((entry) => entry.message?.parts ?? [])
      .map((part) => part.functionResponse?.id)
      .filter((id): id is string => typeof id === 'string'),
  );
  for (const item of pending) {
    const parts = convertToFunctionErrorResponse(
      item.toolName,
      item.functionCallId,
      [],
      'The Runtime execution was cancelled with its owner.',
    );
    const response = parts[0]?.functionResponse;
    if (!response || parts.length !== 1) {
      throw new Error('Runtime result cannot be represented durably.');
    }
    response.response = {
      ...response.response,
      executionStatus: 'cancelled',
    };
    const outcomeRef = await input.session.resources.publish(
      'managed-tool-outcome',
      outcomeBytes(item, parts),
    );
    // The assistant's functionCall must meet its functionResponse in the next
    // turn's history, or providers reject the request as malformed.
    if (!journaled.has(item.functionCallId)) {
      await input.session.sink.write({
        uuid: randomUUID(),
        parentUuid: item.modelMessageId,
        sessionId: input.sessionId,
        timestamp: new Date().toISOString(),
        type: 'tool_result',
        cwd: input.cwd,
        version: 'hosted-harness/1',
        daemonPromptId: input.promptId,
        message: { role: 'user', parts },
      });
    }
    await harness.resolveAwaitRuntime(item.executionCallId, outcomeRef);
  }
}

/**
 * Best-effort stop for the parked executions of a recovered cancellation.
 * A cancellation only becomes durable evidence after the execution reaches a
 * terminal state — issuing cancel is not proof, since the Broker accepts a
 * cancel without having stopped anything yet. An execution the Broker never
 * knew (definitive not-found) is already stopped.
 */
export async function stopParkedRuntimeExecutions(input: {
  session: ManagedSession;
  promptId: string;
  brokerOptions: HostedWorkspaceBrokerOptions;
}): Promise<HostedWorkspaceBroker> {
  const authorization = await input.session.authority.harnessRunAuthorization();
  if (
    authorization.status !== 'runnable' ||
    authorization.checkpoint.identity.turnId !== input.promptId
  )
    throw new RecoveryDeclined();
  const broker = await originalRuntimeBroker(
    input.session,
    input.promptId,
    authorization.checkpoint.tools?.items ?? [],
    input.brokerOptions,
  );
  for (const item of authorization.checkpoint.tools?.items ?? []) {
    if (item.state !== 'in_progress' || item.outcomeSource !== 'runtime')
      continue;
    const before = await broker.status(item.executionCallId);
    if (before?.state === 'unknown')
      throw new Error('Runtime execution outcome is unknown.');
    if (before === undefined || before.state === 'settled') continue;
    await broker.cancel(item.executionCallId).catch(() => undefined);
    const deadline = Date.now() + 30_000;
    for (;;) {
      const status = await broker.status(item.executionCallId);
      if (status?.state === 'unknown')
        throw new Error('Runtime execution outcome is unknown.');
      if (status === undefined || status.state === 'settled') break;
      if (Date.now() >= deadline) {
        throw new Error(
          'Runtime execution did not reach a terminal state after cancellation.',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return broker;
}

/**
 * Reconciles a parked Runtime turn on a replacement Harness. A continuation
 * load (`passive: false`) re-dispatches every in-progress execution under its
 * original `executionCallId` — the Broker's durable record keeps that
 * exactly-once — commits the tool results and lets the checkpoint reach
 * `results_ready` before the caller answers. A passive load adopts the
 * dead owner's Runtime Session and reads execution states for the
 * cancellation path; it never dispatches.
 *
 * Returns undefined when this is not a Runtime wait the session can take over;
 * the caller then keeps its plain refusal.
 */
export async function recoverHostedRuntimeTurn(input: {
  session: ManagedSession;
  sessionId: string;
  cwd: string;
  promptId: string;
  brokerOptions: HostedWorkspaceBrokerOptions;
  passive: boolean;
  /** Set when the calling Session already holds the Runtime lease from an
   * earlier recovery of the same parked Turn (a re-answered load whose first
   * reply was lost): a failed re-acquire then says nothing about the held
   * lease, so the failure exits below must not release it — a release
   * persists RELEASED and wedges every later redrive on
   * runtime_session_not_acquirable. */
  leaseAlreadyHeld?: boolean;
}): Promise<HostedRecoveryTurn | undefined> {
  const { session, promptId, passive } = input;
  const authorization = await session.authority.harnessRunAuthorization();
  if (authorization.status !== 'runnable') return undefined;
  const checkpoint = authorization.checkpoint;
  if (
    checkpoint.identity.turnId !== promptId ||
    (checkpoint.continuation.phase !== 'await_runtime' &&
      checkpoint.continuation.phase !== 'results_ready')
  ) {
    return undefined;
  }
  const items = (checkpoint.tools?.items ?? []).filter(
    (item) => item.outcomeSource === 'runtime',
  );
  let broker: HostedWorkspaceBroker;
  try {
    broker = await originalRuntimeBroker(
      session,
      promptId,
      items,
      input.brokerOptions,
    );
  } catch (cause) {
    if (cause instanceof RecoveryDeclined) return undefined;
    throw cause;
  }
  const pending = items.filter((item) => item.state === 'in_progress');
  const states = new Map<string, { state: string } | undefined>();
  let acquiredRuntime = false;
  if (passive && items.length > 0) {
    // A replacement Broker answers status, cancel and release only for a
    // Runtime Session it has adopted, so the cancellation path re-attaches
    // to the dead owner's one first. Acquiring dispatches nothing.
    //
    // The passive path never compensation-releases: a release persists the
    // record as RELEASED, every retried acquire of the same identity then
    // conflicts with 409 runtime_session_not_acquirable, and a load that
    // throws leaves no harness-side record a route could hand back. The
    // adoption instead stays owed to the retried takeover, which re-acquires
    // a READY session under the same identity idempotently server-side; a
    // load that reports successfully hands the lease to the cancel route.
    // The continuation takeover keeps its #13083 handback discipline for
    // now — whether the same wedge reasoning applies there is a recorded
    // follow-up, not settled by this change.
    await broker.acquire();
    acquiredRuntime = true;
  }
  if (pending.length > 0) {
    if (passive) {
      for (const item of pending) {
        const status = await broker.status(item.executionCallId);
        states.set(
          item.executionCallId,
          status?.state === 'unknown' ? undefined : status,
        );
      }
    } else {
      // The Shell profile's drives need the original publisher, which a
      // replacement cannot rebuild; refuse rather than risk a replay.
      if (pending.some((item) => item.toolName === 'run_shell_command')) {
        return undefined;
      }
      try {
        await broker.acquire();
        acquiredRuntime = true;
        const harness = createManagedHarnessHandle(session);
        // A write-then-resolve crash window must not journal a tool_result
        // twice when the recovery retries: collect what is already durable.
        const journaled = new Set(
          (await session.sink.project())
            .filter(
              (entry) =>
                entry.daemonPromptId === promptId &&
                entry.type === 'tool_result',
            )
            .flatMap((entry) => entry.message?.parts ?? [])
            .map((part) => part.functionResponse?.id)
            .filter((id): id is string => typeof id === 'string'),
        );
        const intents = new Map(
          session.authority
            .eventsInSequenceRange(1, session.authority.committedSequence)
            .filter((event) => event.kind === 'tool.intent')
            .map((event) => [
              event.payload['executionCallId'] as string,
              event,
            ]),
        );
        for (const item of pending) {
          const argsRef = intents.get(item.executionCallId)?.payload[
            'argsRef'
          ] as ManagedSessionDurableRef | undefined;
          if (argsRef === undefined) throw new RecoveryDeclined();
          const stored = JSON.parse(
            (await session.resources.read(argsRef)).toString('utf8'),
          ) as { payloadJson?: unknown };
          if (typeof stored.payloadJson !== 'string')
            throw new RecoveryDeclined();
          const result = await broker.execute(
            item.executionCallId,
            stored.payloadJson,
            new AbortController().signal,
          );
          const parts = toolResultParts(item, result);
          let outcome = outcomeBytes(item, parts);
          let record: ChatRecord = {
            uuid: randomUUID(),
            parentUuid: item.modelMessageId,
            sessionId: input.sessionId,
            timestamp: new Date().toISOString(),
            type: 'tool_result',
            cwd: input.cwd,
            version: 'hosted-harness/1',
            daemonPromptId: promptId,
            message: { role: 'user', parts },
          };
          if (
            outcome.byteLength >
              HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes ||
            Buffer.byteLength(JSON.stringify(record)) >
              HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes
          ) {
            // Mirror the live turn's durable ceiling: keep the settled outcome
            // but omit an oversized body rather than replaying the execution.
            const omitted = convertToFunctionErrorResponse(
              item.toolName,
              item.functionCallId,
              [],
              `Tool execution settled as ${result.executionStatus}, but its output exceeds the ${HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes}-byte durable Session limit and was omitted.` +
                (item.toolName === 'read_file'
                  ? ' Request a smaller offset/limit range.'
                  : ''),
            );
            const omittedResponse = omitted[0]?.functionResponse;
            if (!omittedResponse || omitted.length !== 1)
              throw new Error('Runtime result cannot be represented durably.');
            omittedResponse.response = {
              ...omittedResponse.response,
              executionStatus: result.executionStatus,
              outputOmitted: true,
            };
            parts.length = 0;
            parts.push(...omitted);
            outcome = outcomeBytes(item, parts);
            record = {
              ...record,
              message: { role: 'user', parts },
            };
          }
          const outcomeRef = await session.resources.publish(
            'managed-tool-outcome',
            outcome,
          );
          if (!journaled.has(item.functionCallId)) {
            await session.sink.write(record);
          }
          await harness.resolveAwaitRuntime(item.executionCallId, outcomeRef);
          states.set(item.executionCallId, { state: 'settled' });
        }
      } catch (cause) {
        // The caller only learns about the lease from a returned report, so
        // every failure exit here must give it back first — unless the
        // Session already held it before this call (see leaseAlreadyHeld).
        if (!input.leaseAlreadyHeld) {
          await broker.release().catch((releaseCause) => {
            writeStderrLineSafe(
              `qwen serve: Hosted Harness recovery could not release the Runtime Session: ${String(releaseCause)}`,
            );
          });
          acquiredRuntime = false;
        }
        if (cause instanceof RecoveryDeclined) return undefined;
        throw cause;
      }
    }
  } else if (!passive && items.length > 0) {
    // Nothing is left to drive, but the dead owner still holds the Runtime
    // Session it prepared these executions in. Re-attach to it so the
    // terminal route can release the Workspace for other Sessions.
    try {
      await broker.acquire();
      acquiredRuntime = true;
    } catch (cause) {
      // A lost acquire reply leaves the lease uncertain: hand back whatever
      // may exist rather than stranding it — unless the Session already holds
      // the lease (leaseAlreadyHeld), where nothing is uncertain and the
      // release would only persist RELEASED against every later redrive.
      if (!input.leaseAlreadyHeld)
        await broker.release().catch((releaseCause) => {
          writeStderrLineSafe(
            `qwen serve: Hosted Harness recovery could not release the Runtime Session: ${String(releaseCause)}`,
          );
        });
      throw cause;
    }
  }
  let finalAuthorization;
  try {
    finalAuthorization = await session.authority.harnessRunAuthorization();
  } catch (cause) {
    // A failed continuation hands the lease back — but a passive load must
    // not (see the adoption comment above): its retried takeover re-acquires
    // the READY identity idempotently, while a release would wedge it. A
    // lease the Session already held before this call stays held for the
    // same reason (leaseAlreadyHeld).
    if (acquiredRuntime && !passive && !input.leaseAlreadyHeld) {
      await broker.release().catch((releaseCause) => {
        writeStderrLineSafe(
          `qwen serve: Hosted Harness recovery could not release the Runtime Session: ${String(releaseCause)}`,
        );
      });
      acquiredRuntime = false;
    }
    throw cause;
  }
  if (finalAuthorization.status !== 'runnable') {
    // Same split as the catch above: only the continuation path hands its
    // lease back here; a passive load leaves the adoption owed.
    if (acquiredRuntime && !passive && !input.leaseAlreadyHeld) {
      await broker.release().catch((releaseCause) => {
        writeStderrLineSafe(
          `qwen serve: Hosted Harness recovery could not release the Runtime Session: ${String(releaseCause)}`,
        );
      });
    }
    return undefined;
  }
  const finalCheckpoint = finalAuthorization.checkpoint;
  const executions: HostedRuntimeRecoveryExecution[] = items.map((item) => {
    const state = states.get(item.executionCallId);
    return {
      functionCallId: item.functionCallId,
      toolName: item.toolName,
      executionCallId: item.executionCallId,
      runtimeSessionId: broker.runtimeSessionId,
      outcome:
        item.state === 'settled' || state !== undefined ? 'known' : 'unknown',
      ...(item.state === 'settled'
        ? { status: { state: 'settled' } }
        : state === undefined
          ? {}
          : { status: state }),
    };
  });
  return {
    promptId,
    acquiredRuntime,
    report: {
      phase:
        finalCheckpoint.continuation.phase === 'results_ready'
          ? 'results_ready'
          : 'await_runtime',
      checkpointId: finalCheckpoint.identity.checkpointId,
      activationId: session.activation.activationId,
      executions,
    },
  };
}
