/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import type { FunctionDeclaration, Part } from '@google/genai';
import type { ToolCallRequestInfo } from '@qwen-code/qwen-code-core/core/turn.js';
import { managedToolDigest } from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import { parseToolResultEnvelope } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import type { DurableToolResultResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/resource-tool-result-store.js';
import {
  convertToFunctionResponse,
  convertToFunctionErrorResponse,
} from '@qwen-code/qwen-code-core/core/coreToolScheduler.js';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import type { ManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import { HTTP_MANAGED_SESSION_STORE_CONTRACT } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import {
  InvalidWorkspaceRelativePathError,
  normalizeWorkspaceRelativePath,
} from './managed-workspace-binding.js';
import { WORKSPACE_CAPABILITY_DIGEST } from './managed-workspace-activation.js';
import {
  HostedWorkspaceBroker,
  HostedWorkspaceBrokerRejection,
  type HostedWorkspaceBrokerOptions,
} from './hosted-workspace-broker.js';
import { HostedShellPublisher } from './hosted-shell-publisher.js';

export const HOSTED_WORKSPACE_FILE_PROFILE = 'hosted-workspace-files/1';
export const HOSTED_WORKSPACE_SHELL_PROFILE = 'hosted-workspace-shell/1';
export type HostedWorkspaceToolProfile =
  | typeof HOSTED_WORKSPACE_FILE_PROFILE
  | typeof HOSTED_WORKSPACE_SHELL_PROFILE;

export interface HostedShellTurnOptions {
  resources: DurableToolResultResourceStore;
  assertWritable(): Promise<void>;
}

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

export const HOSTED_WORKSPACE_SHELL_TOOLS: FunctionDeclaration[] = [
  ...HOSTED_WORKSPACE_FILE_TOOLS,
  {
    name: 'run_shell_command',
    description:
      'Run a foreground command in the saved Workspace working directory. Complete stdout and stderr are retained; the model receives a bounded preview. Background jobs are unavailable.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout: { type: 'integer', minimum: 1, maximum: 600000 },
        description: { type: 'string' },
      },
      required: ['command'],
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
  private publisher?: HostedShellPublisher;
  private bindingGeneration?: string;
  readonly declarations: FunctionDeclaration[];

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
    private readonly messageFitsInline: (
      type: 'assistant' | 'tool_result',
      parts: Part[],
      model: string,
    ) => boolean,
    private readonly shell?: HostedShellTurnOptions,
  ) {
    this.declarations = shell
      ? HOSTED_WORKSPACE_SHELL_TOOLS
      : HOSTED_WORKSPACE_FILE_TOOLS;
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
        !this.declarations.some((tool) => tool.name === call.name) ||
        ids.has(call.callId) ||
        call.wasOutputTruncated === true
      )
        throw new Error('Hosted Workspace profile refused a tool call.');
      ids.add(call.callId);
      const isShell = call.name === 'run_shell_command';
      let validationError: string | undefined;
      let input: Record<string, unknown>;
      if (isShell) {
        const args = call.args;
        const unsupportedKey = Object.keys(args).find(
          (key) =>
            !['command', 'timeout', 'description', 'is_background'].includes(
              key,
            ),
        );
        if (typeof args['command'] !== 'string' || !args['command'].trim()) {
          validationError = 'Hosted Shell requires a nonempty command.';
        } else if (unsupportedKey !== undefined) {
          validationError = `Hosted Shell received unsupported argument ${JSON.stringify(unsupportedKey)}.`;
        } else if (
          args['is_background'] !== undefined &&
          args['is_background'] !== false &&
          !(
            typeof args['is_background'] === 'string' &&
            args['is_background'].toLowerCase() === 'false'
          )
        ) {
          validationError =
            'Hosted Shell requires a foreground command in the saved directory. Background jobs and Monitor are unavailable; correct the arguments before retrying.';
        } else if (
          args['description'] !== undefined &&
          typeof args['description'] !== 'string'
        ) {
          validationError = 'Hosted Shell description must be a string.';
        } else if (
          args['timeout'] !== undefined &&
          (!Number.isSafeInteger(args['timeout']) ||
            (args['timeout'] as number) < 1 ||
            (args['timeout'] as number) > 600000)
        ) {
          validationError =
            'Hosted Shell timeout must be an integer from 1 to 600000 ms.';
        }
        input = { ...args, is_background: false };
      } else {
        const file = call.args['file_path'];
        input = { ...call.args };
        const filePathError =
          'Hosted file tools require file_path relative to the saved Session working directory. Absolute paths and ".." traversal are not allowed. Correct file_path and retry.';
        if (typeof file !== 'string') {
          validationError = filePathError;
        } else {
          try {
            input['file_path'] = normalizeWorkspaceRelativePath(file.trim());
          } catch (cause) {
            if (!(cause instanceof InvalidWorkspaceRelativePathError))
              throw cause;
            validationError = filePathError;
          }
        }
      }
      const payloadJson = JSON.stringify({
        toolName: call.name,
        input,
      });
      const runtimeCallId = randomUUID();
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
        validationError,
        runtimeCallId,
        input,
        isShell,
        inputDigest: isShell ? managedToolDigest(input) : undefined,
        payloadJson,
        inputBytes,
        digest: `sha256:${createHash('sha256').update(payloadJson).digest('hex')}`,
      };
    });
    if (!this.messageFitsInline('assistant', parts, model))
      throw new Error(
        'Hosted assistant record exceeds the inline Session Store limit.',
      );
    signal.throwIfAborted();
    if (requests.some((request) => request.validationError)) {
      const responses = requests.flatMap((request) =>
        convertToFunctionErrorResponse(
          request.call.name,
          request.call.callId,
          [],
          request.validationError ??
            'This tool was not executed because another call in the batch has invalid arguments. Retry the batch with corrected arguments.',
        ),
      );
      if (!this.messageFitsInline('tool_result', responses, model))
        throw new Error(
          'Hosted tool refusal exceeds the inline Session Store limit.',
        );
      this.uncertain = true;
      try {
        await this.commit('assistant', parts, model);
        await this.commit('tool_result', responses, model);
        this.uncertain = false;
        return responses;
      } catch (cause) {
        throw new HostedToolRecoveryRequiredError(cause);
      }
    }
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
      if (requests.some((request) => request.isShell) && !this.publisher) {
        this.publisher = new HostedShellPublisher(
          this.session,
          this.shell!.resources,
          this.shell!.assertWritable,
          this.promptId,
        );
        this.bindingGeneration = await this.broker.registerPublisher(
          await this.publisher.start(),
        );
      }
      const messageId = await this.commit('assistant', parts, model);
      const bindings = [];
      for (const [ordinal, request] of requests.entries()) {
        const routeRef = await this.session.resources.publish(
          'managed-tool-input',
          request.inputBytes,
        );
        const runtimeCallId = request.runtimeCallId;
        const executionCallId = await this.broker.prepare(
          runtimeCallId,
          request.digest,
          request.inputDigest,
        );
        reserved.push(executionCallId);
        const toolDefinitionRef = await this.session.resources.publish(
          'managed-tool-definition',
          Buffer.from(
            JSON.stringify(
              this.declarations.find((tool) => tool.name === request.call.name),
            ),
          ),
        );
        const authority = this.session.authority;
        const activation = this.session.activation;
        const argsRef = request.isShell
          ? await this.session.resources.publish(
              'managed-tool-args',
              Buffer.from(JSON.stringify(request.input)),
            )
          : routeRef;
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
              argsRef,
              outcomeSource: 'runtime',
            },
          }),
          { class: 'harness', activation },
        );
        bindings.push({
          functionCallId: request.call.callId,
          toolName: request.call.name,
          executionCallId,
          invocationBindingId: request.isShell
            ? runtimeCallId
            : executionCallId,
          capabilityVersion: WORKSPACE_CAPABILITY_DIGEST,
          policyVersion: 'preapproved-workspace-tools/1',
          mediaVersion: null,
          modelMessageId: messageId,
          partIndex: parts.findIndex(
            (part) => part.functionCall?.id === request.call.callId,
          ),
          ordinal,
          inputDigest: request.inputDigest ?? request.digest.slice(7),
          progressCursor: null,
          attemptId: messageId,
          routeRef,
        });
        if (request.isShell) {
          this.publisher!.register(
            {
              reference: {
                sessionId: this.promptId,
                promptId: this.promptId,
                callId: runtimeCallId,
                argsDigest: request.inputDigest!,
              },
              capture: {
                tenantId: authority.sessionHeader.sessionKey.tenantId,
                sessionId: authority.sessionHeader.sessionKey.sessionId,
                turnId: this.promptId,
                executionCallId,
                bindingGeneration: this.bindingGeneration!,
                capturePolicy: 'complete_required',
              },
            },
            request.call.callId,
          );
        }
      }
      await this.harness.commitAwaitRuntimeBatch(bindings, {
        turnId: this.promptId,
        promptId: this.promptId,
      });
      const responses: Part[] = [];
      for (const [index, request] of requests.entries()) {
        const executionCallId = reserved[index];
        const result = await this.broker.execute(
          executionCallId,
          request.payloadJson,
          signal,
          request.isShell
            ? Number(request.input['timeout'] ?? 120000) + 60000
            : undefined,
        );
        const shellResult = request.isShell
          ? parseToolResultEnvelope(result)
          : undefined;
        const receipt = shellResult?.capture
          ? await this.publisher!.receipt(executionCallId, shellResult)
          : undefined;
        if (receipt?.deliveryStatus === 'blocked') {
          await this.broker.acknowledge(executionCallId, receipt);
          throw new Error('Complete Shell output was not admitted.');
        }
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
        const modelParts = shellResult?.capture?.previewTruncated
          ? [
              {
                text: `Shell execution: ${shellResult.executionStatus}. Output preview is truncated. Complete stdout and stderr are retained in the Session result.`,
              },
              ...responseParts,
            ]
          : responseParts;
        let converted =
          result.executionStatus === 'success'
            ? convertToFunctionResponse(
                request.call.name,
                request.call.callId,
                modelParts,
              )
            : convertToFunctionErrorResponse(
                request.call.name,
                request.call.callId,
                modelParts,
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
          ...(shellResult ? { capture: shellResult.capture } : {}),
        };
        let outcome = Buffer.from(
          JSON.stringify({ executionCallId, ...converted[0] }),
        );
        if (
          outcome.byteLength >
            HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes ||
          !this.messageFitsInline('tool_result', converted, model)
        ) {
          if (receipt)
            throw new Error(
              'Admitted Shell result exceeds the inline Session Store limit.',
            );
          converted = [
            {
              functionResponse: {
                id: request.call.callId,
                name: request.call.name,
                response: {
                  error:
                    `Tool execution settled as ${result.executionStatus}, but its output exceeds the ${HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes}-byte durable Session limit and was omitted.` +
                    (request.call.name === 'read_file'
                      ? ' Request a smaller offset/limit range.'
                      : ''),
                  executionStatus: result.executionStatus,
                  outputOmitted: true,
                },
              },
            },
          ];
          outcome = Buffer.from(
            JSON.stringify({ executionCallId, ...converted[0] }),
          );
        }
        const outcomeRef =
          receipt?.outcomeRef ??
          (await this.session.resources.publish(
            'managed-tool-outcome',
            outcome,
          ));
        await this.commit('tool_result', converted, model);
        await this.harness.resolveAwaitRuntime(executionCallId, outcomeRef);
        if (receipt) await this.broker.acknowledge(executionCallId, receipt);
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

  async close(): Promise<void> {
    await this.publisher?.close();
  }
}
