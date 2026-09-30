/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
import type { ManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
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
import type { HostedMcpSession } from './hosted-mcp-session.js';
import { waitForTurn } from './hosted-turn-wait.js';
import {
  endHostedAction,
  HOSTED_APPROVAL_OPTIONS,
  HOSTED_TOOL_APPROVAL_POLICY,
  hostedActionAllowed,
  hostedApprovalAsks,
  type HostedActionOptions,
  type HostedApprovalSettings,
  type HostedApprovalWaiters,
} from './hosted-tool-approval.js';

export const HOSTED_WORKSPACE_FILE_PROFILE = 'hosted-workspace-files/1';
export const HOSTED_WORKSPACE_SHELL_PROFILE = 'hosted-workspace-shell/1';
export type HostedWorkspaceToolProfile =
  | typeof HOSTED_WORKSPACE_FILE_PROFILE
  | typeof HOSTED_WORKSPACE_SHELL_PROFILE;

export interface HostedShellTurnOptions {
  resources: DurableToolResultResourceStore;
  assertWritable(): Promise<void>;
}

export interface HostedApprovalTurnOptions {
  settings: HostedApprovalSettings;
  waiters: HostedApprovalWaiters;
}

const APPROVAL_REFUSALS = {
  denied: 'The Session owner denied this tool call, so it was not run.',
  expired:
    'Nobody answered the approval request before it expired, so this tool call was not run.',
  cancelled: 'The turn was cancelled before this tool call ran.',
  unanswered:
    'An earlier approval request in this turn expired unanswered, so this tool call was not asked about or run.',
} as const;

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
  private advertised?: FunctionDeclaration[];
  // Once an approval expires nobody is answering, so the Turn asks no more.
  private unanswered = false;

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
    private readonly approval?: HostedApprovalTurnOptions,
    private readonly mcp?: HostedMcpSession,
  ) {
    this.broker =
      mcp?.broker ??
      new HostedWorkspaceBroker(
        options,
        session.authority.sessionHeader.sessionKey,
        promptId,
      );
    this.warmed = mcp ? mcp.ensureReady() : this.broker.warm();
    // Warmup runs alongside inference; a text-only answer need not wait for it.
    void this.warmed.catch(() => undefined);
  }

  async declarations(signal: AbortSignal): Promise<FunctionDeclaration[]> {
    signal.throwIfAborted();
    if (this.mcp) await waitForTurn(this.mcp.refresh(signal), signal);
    this.advertised = [
      ...(this.shell
        ? HOSTED_WORKSPACE_SHELL_TOOLS
        : HOSTED_WORKSPACE_FILE_TOOLS),
      ...(this.mcp?.tools() ?? []),
    ];
    return this.advertised;
  }

  async execute(
    calls: ToolCallRequestInfo[],
    parts: Part[],
    model: string,
    signal: AbortSignal,
  ): Promise<Part[]> {
    signal.throwIfAborted();
    if (this.mcp) await waitForTurn(this.warmed, signal);
    const declarations = this.advertised ?? (await this.declarations(signal));
    const ids = new Set<string>();
    const requests = calls.map((call) => {
      const runtimeCallId = randomUUID();
      const mcpInput = this.mcp?.toolInput(call.name, call.args, runtimeCallId);
      if (
        !declarations.some((tool) => tool.name === call.name) ||
        ids.has(call.callId) ||
        call.wasOutputTruncated === true
      )
        throw new Error('Hosted Workspace profile refused a tool call.');
      ids.add(call.callId);
      const isShell = call.name === 'run_shell_command';
      let validationError: string | undefined;
      let input: Record<string, unknown>;
      if (mcpInput) {
        input = { ...mcpInput.input };
      } else if (isShell) {
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
      const encoded = this.encodeToolInput(
        mcpInput ?? { toolName: call.name, input },
      );
      return {
        call,
        validationError,
        runtimeCallId,
        input,
        isShell,
        inputDigest: isShell ? managedToolDigest(input) : undefined,
        mcp: mcpInput !== undefined,
        ...encoded,
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
    await waitForTurn(this.warmed, signal);
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
    let messageId: string;
    let refusals: Array<string | undefined>;
    const inputRefs = new Map<number, ManagedSessionDurableRef>();
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
      messageId = await this.commit('assistant', parts, model);
      refusals = await this.approve(requests, messageId, inputRefs, signal);
    } catch (cause) {
      throw new HostedToolRecoveryRequiredError(cause);
    }
    const refusal = (index: number): Part[] | undefined => {
      const reason = refusals[index];
      return reason === undefined
        ? undefined
        : convertToFunctionErrorResponse(
            requests[index].call.name,
            requests[index].call.callId,
            [],
            reason,
          );
    };
    if (refusals.every((reason) => reason !== undefined)) {
      const responses = requests.flatMap((_, index) => refusal(index)!);
      try {
        if (!this.messageFitsInline('tool_result', responses, model))
          throw new Error(
            'Hosted tool refusal exceeds the inline Session Store limit.',
          );
        await this.commit('tool_result', responses, model);
      } catch (cause) {
        throw new HostedToolRecoveryRequiredError(cause);
      }
      this.uncertain = false;
      signal.throwIfAborted();
      return responses;
    }
    const reserved = new Map<number, string>();
    try {
      const bindings = [];
      for (const [ordinal, request] of requests.entries()) {
        if (refusals[ordinal] !== undefined) continue;
        if (request.mcp) {
          const renewed = this.mcp!.toolInput(
            request.call.name,
            request.call.args,
            request.runtimeCallId,
          )!;
          const payload = JSON.parse(request.payloadJson) as typeof renewed;
          Object.assign(
            request,
            this.encodeToolInput({
              ...payload,
              input: { ...payload.input, grant: renewed.input.grant },
            }),
          );
          inputRefs.delete(ordinal);
        }
        const routeRef =
          inputRefs.get(ordinal) ??
          (await this.session.resources.publish(
            'managed-tool-input',
            request.inputBytes,
          ));
        const runtimeCallId = request.runtimeCallId;
        const executionCallId = await this.broker.prepare(
          runtimeCallId,
          request.digest,
          request.inputDigest,
          this.promptId,
        );
        reserved.set(ordinal, executionCallId);
        const toolDefinitionRef = await this.session.resources.publish(
          'managed-tool-definition',
          Buffer.from(
            JSON.stringify(
              declarations.find((tool) => tool.name === request.call.name),
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
        const refused = refusal(index);
        if (refused) {
          await this.commit('tool_result', refused, model);
          responses.push(...refused);
          continue;
        }
        const executionCallId = reserved.get(index)!;
        const result = await this.broker.execute(
          executionCallId,
          request.payloadJson,
          signal,
          request.isShell
            ? Number(request.input['timeout'] ?? 120000) + 60000
            : this.mcp
              ? 630_000
              : undefined,
          this.mcp !== undefined,
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
      await Promise.allSettled(
        [...reserved.values()].map((id) => this.broker.cancel(id)),
      );
      throw new HostedToolRecoveryRequiredError(cause);
    }
  }

  private encodeToolInput(payload: { toolName: string; input: unknown }) {
    const payloadJson = JSON.stringify(payload);
    const inputBytes = Buffer.from(
      JSON.stringify({
        harnessSessionId:
          this.session.authority.sessionHeader.sessionKey.sessionId,
        runtimeSessionId: this.broker.runtimeSessionId,
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
      payloadJson,
      inputBytes,
      digest: `sha256:${createHash('sha256').update(payloadJson).digest('hex')}`,
    };
  }

  /**
   * Asks before each call that the approval mode does not pre-approve, one at
   * a time in the model's order, and returns the refusal for each call that
   * will not run. Nothing runs once the turn is cancelled.
   */
  private async approve(
    requests: ReadonlyArray<{ call: ToolCallRequestInfo; inputBytes: Buffer }>,
    messageId: string,
    inputRefs: Map<number, ManagedSessionDurableRef>,
    signal: AbortSignal,
  ): Promise<Array<string | undefined>> {
    const refusals: Array<string | undefined> = requests.map(() => undefined);
    const approval = this.approval;
    if (!approval) return refusals;
    let asked = false;
    for (const [index, request] of requests.entries()) {
      if (!hostedApprovalAsks(approval.settings, request.call.name)) continue;
      asked = true;
      if (signal.aborted) break;
      if (this.unanswered) {
        refusals[index] = APPROVAL_REFUSALS.unanswered;
        continue;
      }
      const inputRef = await this.session.resources.publish(
        'managed-tool-input',
        request.inputBytes,
      );
      inputRefs.set(index, inputRef);
      refusals[index] = await this.ask(
        approval,
        request.call,
        inputRef,
        messageId,
        signal,
      );
    }
    return asked && signal.aborted
      ? refusals.map((reason) => reason ?? APPROVAL_REFUSALS.cancelled)
      : refusals;
  }

  private async ask(
    approval: HostedApprovalTurnOptions,
    call: ToolCallRequestInfo,
    inputRef: ManagedSessionDurableRef,
    messageId: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const authority = this.session.authority;
    const requestId = `tool_approval_${randomBytes(16).toString('hex')}`;
    const createdAt = Date.now();
    const options: HostedActionOptions = {
      v: 1,
      requestId,
      turnId: this.promptId,
      functionCallId: call.callId,
      toolName: call.name,
      policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
      inputRevision: 1,
      createdAt,
      expiresAt: createdAt + approval.settings.timeoutMs,
      options: HOSTED_APPROVAL_OPTIONS,
    };
    const optionsRef = await this.session.resources.publish(
      'managed-action-options',
      Buffer.from(JSON.stringify(options)),
    );
    if (signal.aborted) return APPROVAL_REFUSALS.cancelled;
    await this.harness.commitDurableWait(
      {
        requestId,
        kind: 'permission',
        source: 'tool_call',
        optionsRef,
        inputRevision: '1',
        invocationRef: inputRef,
        attemptId: messageId,
        routeRef: inputRef,
      },
      { turnId: this.promptId, promptId: this.promptId },
    );
    await approval.waiters.wait(
      requestId,
      options.expiresAt,
      signal,
      () =>
        authority.action(requestId)?.state !== 'requested' ||
        authority.writesStopped,
    );
    if (authority.action(requestId)?.state === 'requested')
      await endHostedAction(
        this.session,
        requestId,
        signal.aborted ? 'cancelled' : 'expired',
      );
    await this.harness.resolveDurableWait();
    const action = authority.action(requestId)!;
    if (action.state === 'decided')
      return hostedActionAllowed(action, options.policyRevision)
        ? undefined
        : APPROVAL_REFUSALS.denied;
    if (action.state !== 'expired') return APPROVAL_REFUSALS.cancelled;
    this.unanswered = true;
    return APPROVAL_REFUSALS.expired;
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
      if (!this.mcp) await this.broker.release();
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
