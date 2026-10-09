/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { FunctionDeclaration, Part } from '@google/genai';
import type { ToolCallRequestInfo } from '@qwen-code/qwen-code-core/core/turn.js';
import type { ManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import { convertManagedRuntimeToolResult } from '@qwen-code/qwen-code-core/managed-runtime/managed-runtime-tool-response.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import { CSI_FILES_RETIREMENT_CAPABILITY_DIGEST } from './managed-csi-file-profile.js';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { normalizeWorkspaceRelativePath } from '@qwen-code/qwen-code-core/managed-runtime/managed-workspace-relative-path.js';
import { HTTP_MANAGED_SESSION_STORE_CONTRACT } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import type {
  HostedToolTurn,
  HostedTurnCommit,
} from './hosted-harness-turn.js';
import type { HostedWorkspaceBrokerOptions } from './hosted-workspace-broker.js';
import { resolveManagedRuntimeBrokerBaseUrl } from './managed-runtime-broker-url.js';
import {
  HOSTED_WORKSPACE_FILE_TOOLS,
  HostedToolRecoveryRequiredError,
  hostedWorkspaceDeclarations,
} from './hosted-workspace-tool-turn.js';
import {
  commitHostedCsiHistory,
  requestHostedCsiHistory,
} from './hosted-csi-file-history.js';
import type {
  CsiHistoryInvocation,
  CsiHistoryPreparation,
} from './managed-csi-file-history-protocol.js';
import type { ManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Original CSI batch is unavailable.');
  return value as Record<string, unknown>;
}

function acceptedInput(call: ToolCallRequestInfo): Record<string, unknown> {
  const input = object(structuredClone(call.args));
  for (const value of Object.values(input)) {
    if (typeof value === 'string') encodeURIComponent(value);
  }
  const required =
    call.name === 'read_file'
      ? ['file_path']
      : call.name === 'write_file'
        ? ['file_path', 'content']
        : call.name === 'edit'
          ? ['file_path', 'old_string', 'new_string']
          : [];
  const optional =
    call.name === 'read_file'
      ? ['offset', 'limit']
      : call.name === 'edit'
        ? ['replace_all']
        : [];
  if (
    required.length === 0 ||
    required.some((key) => typeof input[key] !== 'string') ||
    Object.keys(input).some(
      (key) => ![...required, ...optional].includes(key),
    ) ||
    ['offset', 'limit'].some(
      (key) =>
        Object.hasOwn(input, key) &&
        (!Number.isSafeInteger(input[key]) ||
          (input[key] as number) > Number.MAX_SAFE_INTEGER - 1 ||
          (input[key] as number) < (key === 'limit' ? 1 : 0)),
    ) ||
    (Object.hasOwn(input, 'replace_all') &&
      typeof input['replace_all'] !== 'boolean')
  )
    throw new Error('CSI file input is invalid.');
  input['file_path'] = normalizeWorkspaceRelativePath(
    (input['file_path'] as string).trim(),
  );
  return input;
}

export class HostedCsiToolTurn implements HostedToolTurn {
  private readonly advertised = new Map<string, Buffer>();

  constructor(
    private readonly session: ManagedSession,
    private readonly broker: HostedWorkspaceBrokerOptions,
    private readonly runtime: { bindingId: string; generation: string },
    private readonly promptId: string,
    private readonly commit: HostedTurnCommit,
    private readonly harness: ManagedHarnessHandle,
    private readonly messageFitsInline: (
      type: 'assistant' | 'tool_result',
      parts: Part[],
      model: string,
    ) => boolean,
  ) {}

  async declarations(signal: AbortSignal): Promise<FunctionDeclaration[]> {
    signal.throwIfAborted();
    const declarations = structuredClone(
      hostedWorkspaceDeclarations(HOSTED_WORKSPACE_FILE_TOOLS, false),
    );
    this.advertised.clear();
    for (const declaration of declarations) {
      this.advertised.set(
        declaration.name!,
        Buffer.from(JSON.stringify(declaration)),
      );
    }
    return declarations;
  }

  async execute(
    calls: ToolCallRequestInfo[],
    parts: Part[],
    model: string,
    signal: AbortSignal,
  ): Promise<Part[]> {
    try {
      signal.throwIfAborted();
      const batchId = await this.commit('assistant', parts, model);
      const functions = parts.flatMap((part, partIndex) =>
        part.functionCall ? [{ call: part.functionCall, partIndex }] : [],
      );
      if (
        functions.length !== calls.length ||
        new Set(calls.map((call) => call.callId)).size !== calls.length
      )
        throw new Error('Original CSI functions differ.');
      const sessionId =
        this.session.authority.sessionHeader.sessionKey.sessionId;
      const reservations: Array<Record<string, unknown>> = [];
      for (const [ordinal, call] of calls.entries()) {
        const original = functions[ordinal];
        if (
          original.call.id !== call.callId ||
          original.call.name !== call.name ||
          !isDeepStrictEqual(original.call.args, call.args)
        )
          throw new Error('Original CSI function identity differs.');
        let input: Record<string, unknown>;
        try {
          input = acceptedInput(call);
        } catch {
          continue;
        }
        const definitionBytes = this.advertised.get(call.name);
        if (!definitionBytes)
          throw new Error('Original CSI declaration is missing.');
        const payloadJson = JSON.stringify({ toolName: call.name, input });
        const inputBytes = Buffer.from(
          JSON.stringify({
            harnessSessionId: sessionId,
            runtimeSessionId: sessionId,
            payloadJson,
          }),
        );
        if (
          inputBytes.length >
          HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes
        )
          continue;
        const callId = randomUUID();
        const argsDigest = `sha256:${createHash('sha256').update(payloadJson).digest('hex')}`;
        const inputRef = await this.session.resources.publish(
          'managed-tool-input',
          inputBytes,
        );
        const toolDefinitionRef = await this.session.resources.publish(
          'managed-tool-definition',
          definitionBytes,
        );
        reservations.push({
          idempotencyKey: `${sessionId}:${callId}`,
          turnId: this.promptId,
          toolCallId: callId,
          requestDigest: argsDigest,
          reference: {
            sessionId,
            promptId: this.promptId,
            callId,
            argsDigest,
            batchId,
            functionCallId: call.callId,
            partIndex: original.partIndex,
            ordinal,
            inputRef,
            toolDefinitionRef,
          },
          inputBytesBase64: inputBytes.toString('base64'),
          toolDefinitionBytesBase64: definitionBytes.toString('base64'),
        });
      }
      for (const reservation of reservations) {
        signal.throwIfAborted();
        try {
          await this.request('/executions:prepare', reservation);
        } catch (cause) {
          // A lost answer cannot establish absence or justify new identities.
          const batch = await this.request('/executions:read-batch', {
            promptId: this.promptId,
            batchId,
          });
          this.verifyBatch(batch, batchId, reservations);
          throw cause;
        }
      }
      const batch = await this.request('/executions:read-batch', {
        promptId: this.promptId,
        batchId,
      });
      this.verifyBatch(batch, batchId, reservations);
      if ((batch['members'] as unknown[]).length !== reservations.length)
        throw new Error('Original CSI batch is incomplete.');
      const members = batch['members'] as Array<Record<string, unknown>>;
      if (members.some((member) => member['state'] !== 'prepared'))
        throw new Error('Original CSI batch is not prepared.');
      const paths = new Set<string>();
      const invocations: CsiHistoryInvocation[] = members
        .map((member) => {
          const reference = object(member['reference']);
          const reservation = reservations.find(
            (item) =>
              object(item['reference'])['callId'] === reference['callId'],
          )!;
          const wrapper = object(
            JSON.parse(
              Buffer.from(
                reservation['inputBytesBase64'] as string,
                'base64',
              ).toString('utf8'),
            ),
          );
          const payload = object(JSON.parse(wrapper['payloadJson'] as string));
          const toolName = payload['toolName'] as string;
          if (toolName !== 'read_file')
            paths.add(object(payload['input'])['file_path'] as string);
          return {
            executionCallId: member['executionCallId'] as string,
            callId: reference['callId'] as string,
            functionCallId: reference['functionCallId'] as string,
            toolName,
            partIndex: reference['partIndex'] as number,
            ordinal: reference['ordinal'] as number,
            requestDigest: reference['argsDigest'] as string,
            inputRef: reference['inputRef'] as ManagedSessionDurableRef,
            toolDefinitionRef: reference[
              'toolDefinitionRef'
            ] as ManagedSessionDurableRef,
          };
        })
        .sort((a, b) => a.ordinal - b.ordinal);
      if (paths.size > 0) {
        signal.throwIfAborted();
        const key = this.session.authority.sessionHeader.sessionKey;
        const observation = await requestHostedCsiHistory(this.broker, key, {
          kind: 'csi-file-history',
          version: 1,
          action: 'snapshot',
        });
        const preparation: CsiHistoryPreparation = {
          stage: 'intent',
          turnId: this.promptId,
          promptId: this.promptId,
          batchId,
          invocations,
          paths: [...paths].sort(),
        };
        signal.throwIfAborted();
        const intent = await commitHostedCsiHistory(
          this.session,
          observation,
          preparation,
          batchId,
          `csi-file-history:intent:${batchId}`,
        );
        signal.throwIfAborted();
        const prepared = await requestHostedCsiHistory(this.broker, key, {
          kind: 'csi-file-history',
          version: 1,
          action: 'prepare',
          preparationRef: intent.recordRef,
        });
        signal.throwIfAborted();
        await commitHostedCsiHistory(
          this.session,
          prepared,
          {
            ...preparation,
            stage: 'prepared',
            intentRef: intent.recordRef,
          },
          batchId,
          `csi-file-history:prepared:${batchId}`,
        );
      }
      if (invocations.length === 0)
        throw new Error('Original CSI batch has no accepted members.');
      const authority = this.session.authority;
      const activation = this.session.activation;
      for (const invocation of invocations) {
        signal.throwIfAborted();
        await authority.appendExecutionEvent(
          {
            operation: 'toolIntent',
            commandId: `tool-intent:${invocation.executionCallId}`,
            sessionKey: authority.sessionHeader.sessionKey,
            contentDigest: invocation.inputRef.digest,
          },
          (sequence) => ({
            v: 1,
            sequence,
            eventId: `tool-intent:${invocation.executionCallId}`,
            sessionKey: authority.sessionHeader.sessionKey,
            kind: 'tool.intent',
            occurredAt: Date.now(),
            subject: {
              type: 'activation',
              scopeId: activation.activationId,
              ...activation,
            },
            payload: {
              executionCallId: invocation.executionCallId,
              batchId,
              ordinal: invocation.ordinal,
              toolDefinitionRef: invocation.toolDefinitionRef,
              argsRef: invocation.inputRef,
              outcomeSource: 'runtime',
            },
          }),
          { class: 'harness', activation },
        );
      }
      signal.throwIfAborted();
      await this.harness.commitAwaitRuntimeBatch(
        invocations.map((invocation) => ({
          functionCallId: invocation.functionCallId,
          toolName: invocation.toolName,
          executionCallId: invocation.executionCallId,
          invocationBindingId: invocation.executionCallId,
          capabilityVersion: CSI_FILES_RETIREMENT_CAPABILITY_DIGEST,
          policyVersion: 'csi-files-retirement-policy/1',
          mediaVersion: null,
          modelMessageId: batchId,
          partIndex: invocation.partIndex,
          ordinal: invocation.ordinal,
          inputDigest: invocation.requestDigest.slice(7),
          progressCursor: null,
          attemptId: batchId,
          routeRef: invocation.inputRef,
        })),
        { turnId: this.promptId, promptId: this.promptId },
      );
      const executor = new HostedWorkspaceBroker(
        this.broker,
        authority.sessionHeader.sessionKey,
        sessionId,
      );
      const responses: Part[] = [];
      let lastResultMessageId: string | null = null;
      for (const invocation of invocations) {
        signal.throwIfAborted();
        const reservation = reservations.find(
          (item) => object(item['reference'])['callId'] === invocation.callId,
        )!;
        const wrapper = object(
          JSON.parse(
            Buffer.from(
              reservation['inputBytesBase64'] as string,
              'base64',
            ).toString('utf8'),
          ),
        );
        const result = await executor.execute(
          invocation.executionCallId,
          wrapper['payloadJson'] as string,
          signal,
        );
        if (
          result.executionStatus !== 'success' &&
          result.executionStatus !== 'error'
        )
          throw new Error('CSI execution did not provide a complete result.');
        const converted = convertManagedRuntimeToolResult(
          invocation.toolName,
          invocation.functionCallId,
          result,
          undefined,
        );
        const identity = {
          uuid: randomUUID(),
          timestamp: new Date().toISOString(),
        };
        const outcome = Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            executionCallId: invocation.executionCallId,
            envelope: result,
            history: {
              messageId: identity.uuid,
              timestamp: identity.timestamp,
              model,
              parts: converted,
            },
          }),
        );
        if (
          outcome.length >
            HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes ||
          !this.messageFitsInline('tool_result', converted, model)
        )
          throw new Error(
            'Complete CSI result exceeds the durable Session limit.',
          );
        const outcomeRef = await this.session.resources.publish(
          'managed-tool-outcome',
          outcome,
        );
        await authority.appendExecutionEvent(
          {
            operation: 'recordToolResult',
            commandId: invocation.executionCallId,
            sessionKey: authority.sessionHeader.sessionKey,
            contentDigest: outcomeRef.digest,
          },
          (sequence) => ({
            v: 1,
            sequence,
            eventId: `tool-receipt:${invocation.executionCallId}`,
            sessionKey: authority.sessionHeader.sessionKey,
            kind: 'tool.receipt',
            occurredAt: Date.now(),
            payload: {
              executionCallId: invocation.executionCallId,
              toolOutcomeRef: outcomeRef,
              resultRef: null,
              resources: [],
              historyRevision: sequence,
            },
          }),
          { class: 'trusted_entry' },
        );
        await this.commit('tool_result', converted, model, identity);
        lastResultMessageId = identity.uuid;
        await this.harness.resolveAwaitRuntime(
          invocation.executionCallId,
          outcomeRef,
        );
        responses.push(...converted);
      }
      if (paths.size > 0) {
        signal.throwIfAborted();
        const observed = await requestHostedCsiHistory(
          this.broker,
          authority.sessionHeader.sessionKey,
          { kind: 'csi-file-history', version: 1, action: 'snapshot' },
        );
        signal.throwIfAborted();
        await commitHostedCsiHistory(
          this.session,
          observed,
          null,
          lastResultMessageId,
          `csi-file-history:result:${batchId}`,
        );
      }
      return responses;
    } catch (cause) {
      throw new HostedToolRecoveryRequiredError(cause);
    }
  }

  private verifyBatch(
    batch: Record<string, unknown>,
    batchId: string,
    reservations: Array<Record<string, unknown>>,
  ): void {
    if (
      batch['promptId'] !== this.promptId ||
      batch['batchId'] !== batchId ||
      batch['runtimeBindingId'] !== this.runtime.bindingId ||
      batch['bindingGeneration'] !== this.runtime.generation ||
      !Array.isArray(batch['members'])
    )
      throw new Error('Original CSI batch read differs.');
    const ids = new Set<string>();
    const calls = new Set<string>();
    for (const item of batch['members']) {
      const member = object(item);
      const ref = object(member['reference']);
      const id = member['executionCallId'];
      const callId = ref['callId'];
      const expected = reservations.find(
        (reservation) => object(reservation['reference'])['callId'] === callId,
      );
      if (
        typeof id !== 'string' ||
        ids.has(id) ||
        typeof callId !== 'string' ||
        calls.has(callId) ||
        !expected ||
        ![
          'prepared',
          'dispatching',
          'executing',
          'cancel_requested',
          'settled',
          'unknown',
          'abandoned',
        ].includes(String(member['state'])) ||
        !isDeepStrictEqual(ref, {
          ...object(expected['reference']),
          dispatchMode: 'deferred',
        }) ||
        member['inputBytesBase64'] !== expected['inputBytesBase64'] ||
        member['toolDefinitionBytesBase64'] !==
          expected['toolDefinitionBytesBase64']
      )
        throw new Error('Original CSI member read differs.');
      ids.add(id);
      calls.add(callId);
    }
  }

  private async request(
    route: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const sessionId = this.session.authority.sessionHeader.sessionKey.sessionId;
    const response = await fetch(
      new URL(
        `/internal/runtime-broker/v1${route}`,
        resolveManagedRuntimeBrokerBaseUrl(this.broker.baseUrl),
      ),
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${this.broker.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          protocolVersion: 1,
          requestId: randomUUID(),
          harnessSessionId: sessionId,
          runtimeSessionId: sessionId,
          ...body,
        }),
      },
    );
    if (!response.ok)
      throw new Error(`CSI reservation returned HTTP ${response.status}.`);
    const result = object(await response.json());
    if (
      result['protocolVersion'] !== 1 ||
      result['harnessSessionId'] !== sessionId ||
      result['runtimeSessionId'] !== sessionId
    )
      throw new Error('Original CSI Broker response differs.');
    return result;
  }

  async consumeResults(): Promise<void> {
    try {
      await this.harness.consumeRuntimeResults();
    } catch (cause) {
      throw new HostedToolRecoveryRequiredError(cause);
    }
  }

  async finish(): Promise<void> {
    await this.harness.settleConsumedRuntimeContinuation();
  }

  async close(): Promise<void> {}
}
