/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import type { FunctionDeclaration, Part } from '@google/genai';
import type { ToolCallRequestInfo } from '@qwen-code/qwen-code-core/core/turn.js';
import {
  convertToFunctionResponse,
  convertToFunctionErrorResponse,
} from '@qwen-code/qwen-code-core/core/coreToolScheduler.js';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import type { ManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import { HTTP_MANAGED_SESSION_STORE_CONTRACT } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { normalizeWorkspaceRelativePath } from './managed-workspace-binding.js';
import { WORKSPACE_CAPABILITY_DIGEST } from './managed-workspace-activation.js';
import {
  HostedWorkspaceBroker,
  HostedWorkspaceBrokerRejection,
  type HostedWorkspaceBrokerOptions,
} from './hosted-workspace-broker.js';

export const HOSTED_WORKSPACE_FILE_PROFILE = 'hosted-workspace-files/1';

const pathProperty = {
  type: 'string',
  description:
    'Path relative to the saved Session working directory in its remote Workspace. Never use the Harness host path.',
};
export const HOSTED_WORKSPACE_FILE_TOOLS: FunctionDeclaration[] = [
  {
    name: 'read_file',
    description:
      'Read a file in the remote Workspace. Read before editing an existing file.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        file_path: pathProperty,
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1 },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    description:
      'Write a file in the remote Workspace. Read before overwriting an existing file. No undo backup is provided by this private profile.',
    parametersJsonSchema: {
      type: 'object',
      properties: { file_path: pathProperty, content: { type: 'string' } },
      required: ['file_path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit',
    description:
      'Replace exact text in a remote Workspace file that you have read. No undo backup is provided by this private profile.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        file_path: pathProperty,
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['file_path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
];

export class HostedToolRecoveryRequiredError extends Error {
  constructor(cause: unknown) {
    super(
      'Hosted tool turn requires recovery; its original work was not released.',
      { cause },
    );
  }
}

export class HostedWorkspaceToolTurn {
  private readonly broker: HostedWorkspaceBroker;
  private readonly warmed: Promise<void>;
  private acquired = false;
  private uncertain = false;

  constructor(
    options: HostedWorkspaceBrokerOptions,
    private readonly session: ManagedSession,
    private readonly harness: ManagedHarnessHandle,
    private readonly promptId: string,
    private readonly commit: (
      type: 'assistant' | 'tool_result',
      parts: Part[],
      model: string,
    ) => Promise<string>,
    private readonly validateAssistant: (parts: Part[], model: string) => void,
  ) {
    this.broker = new HostedWorkspaceBroker(
      options,
      session.authority.sessionHeader.sessionKey,
      promptId,
    );
    this.warmed = this.broker.warm();
    // Warmup runs alongside inference; a text-only answer need not wait for it.
    void this.warmed.catch(() => undefined);
  }

  async execute(
    calls: ToolCallRequestInfo[],
    parts: Part[],
    model: string,
    signal: AbortSignal,
  ): Promise<Part[]> {
    const ids = new Set<string>();
    const requests = calls.map((call) => {
      if (
        !HOSTED_WORKSPACE_FILE_TOOLS.some((tool) => tool.name === call.name) ||
        ids.has(call.callId) ||
        call.wasOutputTruncated === true
      )
        throw new Error('Hosted Workspace profile refused a tool call.');
      ids.add(call.callId);
      const file = call.args['file_path'];
      if (typeof file !== 'string')
        throw new Error('Hosted file tools require a relative file_path.');
      const relativeFile = normalizeWorkspaceRelativePath(file.trim());
      const payloadJson = JSON.stringify({
        toolName: call.name,
        input: { ...call.args, file_path: relativeFile },
      });
      const inputBytes = Buffer.from(
        JSON.stringify({
          harnessSessionId:
            this.session.authority.sessionHeader.sessionKey.sessionId,
          runtimeSessionId: this.promptId,
          payloadJson,
        }),
      );
      if (
        inputBytes.length >
        HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes
      )
        throw new Error(
          'Hosted tool input exceeds the inline Session Store limit.',
        );
      return {
        call,
        payloadJson,
        inputBytes,
        digest: `sha256:${createHash('sha256').update(payloadJson).digest('hex')}`,
      };
    });
    this.validateAssistant(parts, model);
    signal.throwIfAborted();
    let onAbort: () => void = () => undefined;
    try {
      await Promise.race([
        this.warmed,
        new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    signal.throwIfAborted();
    if (!this.acquired) {
      // Acquisition may have taken effect even when its reply is lost.
      this.uncertain = true;
      try {
        await this.broker.acquire();
        this.acquired = true;
      } catch (cause) {
        if (
          cause instanceof HostedWorkspaceBrokerRejection &&
          cause.status === 409 &&
          (cause.code === 'workspace_busy' ||
            cause.code === 'workspace_unavailable')
        ) {
          this.uncertain = false;
          throw cause;
        }
        throw new HostedToolRecoveryRequiredError(cause);
      }
    }
    const reserved: string[] = [];
    try {
      this.uncertain = true;
      const messageId = await this.commit('assistant', parts, model);
      const bindings = [];
      for (const [ordinal, request] of requests.entries()) {
        const routeRef = await this.session.resources.publish(
          'managed-tool-input',
          request.inputBytes,
        );
        const executionCallId = await this.broker.prepare(
          randomUUID(),
          request.digest,
        );
        reserved.push(executionCallId);
        const toolDefinitionRef = await this.session.resources.publish(
          'managed-tool-definition',
          Buffer.from(
            JSON.stringify(
              HOSTED_WORKSPACE_FILE_TOOLS.find(
                (tool) => tool.name === request.call.name,
              ),
            ),
          ),
        );
        const authority = this.session.authority;
        const activation = this.session.activation;
        await authority.appendExecutionEvent(
          {
            operation: 'toolIntent',
            commandId: `tool-intent:${executionCallId}`,
            sessionKey: authority.sessionHeader.sessionKey,
            contentDigest: routeRef.digest,
          },
          (sequence) => ({
            v: 1,
            sequence,
            eventId: `tool-intent:${executionCallId}`,
            sessionKey: authority.sessionHeader.sessionKey,
            kind: 'tool.intent',
            occurredAt: Date.now(),
            subject: {
              type: 'activation',
              scopeId: activation.activationId,
              ...activation,
            },
            payload: {
              executionCallId,
              batchId: messageId,
              ordinal,
              toolDefinitionRef,
              argsRef: routeRef,
              outcomeSource: 'runtime',
            },
          }),
          { class: 'harness', activation },
        );
        bindings.push({
          functionCallId: request.call.callId,
          toolName: request.call.name,
          executionCallId,
          invocationBindingId: executionCallId,
          capabilityVersion: WORKSPACE_CAPABILITY_DIGEST,
          policyVersion: 'preapproved-workspace-tools/1',
          mediaVersion: null,
          modelMessageId: messageId,
          partIndex: parts.findIndex(
            (part) => part.functionCall?.id === request.call.callId,
          ),
          ordinal,
          inputDigest: request.digest.slice(7),
          progressCursor: null,
          attemptId: messageId,
          routeRef,
        });
      }
      await this.harness.commitAwaitRuntimeBatch(bindings);
      const responses: Part[] = [];
      for (const [index, request] of requests.entries()) {
        const executionCallId = reserved[index];
        const result = await this.broker.execute(
          executionCallId,
          request.payloadJson,
          signal,
        );
        const responseParts = result.responseParts as Part[];
        if (
          responseParts.some(
            (part) =>
              !part ||
              typeof part !== 'object' ||
              (typeof part.text !== 'string' &&
                !part.inlineData &&
                !part.fileData),
          )
        )
          throw new Error('Runtime returned an unsupported tool result.');
        const converted =
          result.executionStatus === 'success'
            ? convertToFunctionResponse(
                request.call.name,
                request.call.callId,
                responseParts,
              )
            : convertToFunctionErrorResponse(
                request.call.name,
                request.call.callId,
                responseParts,
                result.error?.message ??
                  `Runtime tool ${result.executionStatus}.`,
              );
        const response = converted[0]?.functionResponse;
        if (!response || converted.length !== 1)
          throw new Error('Runtime result cannot be represented durably.');
        response.response = {
          ...response.response,
          executionStatus: result.executionStatus,
          ...(result.error ? { runtimeError: result.error } : {}),
        };
        const outcomeRef = await this.session.resources.publish(
          'managed-tool-outcome',
          Buffer.from(
            JSON.stringify({
              executionCallId,
              ...converted[0],
            }),
          ),
        );
        await this.commit('tool_result', converted, model);
        await this.harness.resolveAwaitRuntime(executionCallId, outcomeRef);
        responses.push(...converted);
      }
      this.uncertain = false;
      return responses;
    } catch (cause) {
      // Best-effort stop requests do not settle or release unknown effects.
      await Promise.allSettled(reserved.map((id) => this.broker.cancel(id)));
      throw new HostedToolRecoveryRequiredError(cause);
    }
  }

  async consumeResults(): Promise<void> {
    try {
      await this.harness.consumeRuntimeResults();
    } catch (cause) {
      this.uncertain = true;
      throw new HostedToolRecoveryRequiredError(cause);
    }
  }

  async finish(): Promise<void> {
    if (this.uncertain)
      throw new HostedToolRecoveryRequiredError('Tool outcome is unknown.');
    if (!this.acquired) return;
    try {
      await this.harness.settleConsumedRuntimeContinuation();
      await this.broker.release();
      this.acquired = false;
    } catch (cause) {
      this.uncertain = true;
      throw new HostedToolRecoveryRequiredError(cause);
    }
  }
}
