/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { FunctionDeclaration, Part } from '@google/genai';
import type { ToolCallRequestInfo } from '@qwen-code/qwen-code-core/core/turn.js';
import type { DurableToolResultResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/resource-tool-result-store.js';
import {
  convertToFunctionResponse,
  convertToFunctionErrorResponse,
} from '@qwen-code/qwen-code-core/core/coreToolScheduler.js';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { managedToolDigest } from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import {
  createToolPublicationToken,
  parseToolPublicationBinding,
  type ToolPublicationBinding,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-publication.js';
import type { HttpToolPublicationOwner } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import {
  parseToolResultEnvelope,
  type ToolResultEnvelope,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import {
  assertManagedSessionDurableRef,
  type ManagedSessionDurableRef,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { ManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import {
  HTTP_MANAGED_SESSION_STORE_CONTRACT,
  ManagedSessionStoreHttpError,
} from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { writeStderrLineSafe } from '../utils/stdioHelpers.js';
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
import { boundedShellPreview } from './managed-shell-publisher.js';

export const HOSTED_WORKSPACE_FILE_PROFILE = 'hosted-workspace-files/1';
export const HOSTED_WORKSPACE_SHELL_PROFILE = 'hosted-workspace-shell/1';
export function isRetryableWorkspaceAcquisition(
  cause: unknown,
): cause is HostedWorkspaceBrokerRejection & {
  code: 'workspace_busy' | 'workspace_unavailable';
} {
  return (
    cause instanceof HostedWorkspaceBrokerRejection &&
    cause.status === 409 &&
    (cause.code === 'workspace_busy' || cause.code === 'workspace_unavailable')
  );
}
export type HostedWorkspaceToolProfile =
  | typeof HOSTED_WORKSPACE_FILE_PROFILE
  | typeof HOSTED_WORKSPACE_SHELL_PROFILE;

export interface HostedShellTurnOptions {
  resources: DurableToolResultResourceStore;
  assertWritable(): Promise<void>;
}

function shellHistoryId(executionCallId: string): string {
  const bytes = createHash('sha1')
    .update('qwen-hosted-shell-history/1:')
    .update(executionCallId)
    .digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
  private readonly publication?: {
    owner: HttpToolPublicationOwner;
    captureBytes: number;
  };
  private readonly shell?: HostedShellTurnOptions;
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
      identity?: { uuid: string; timestamp: string },
    ) => Promise<string>,
    private readonly messageFitsInline: (
      type: 'assistant' | 'tool_result',
      parts: Part[],
      model: string,
    ) => boolean,
    publicationOrShell?:
      | { owner: HttpToolPublicationOwner; captureBytes: number }
      | HostedShellTurnOptions,
    shell?: HostedShellTurnOptions,
  ) {
    this.publication =
      publicationOrShell && 'owner' in publicationOrShell
        ? publicationOrShell
        : undefined;
    this.shell =
      publicationOrShell && 'resources' in publicationOrShell
        ? publicationOrShell
        : shell;
    this.declarations =
      this.publication || this.shell
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

  async resumeCommittedResults(): Promise<void> {
    if (this.acquired) return;
    await this.warmed;
    await this.acquire();
    this.uncertain = false;
  }

  private async acquire(): Promise<void> {
    this.uncertain = true;
    try {
      await this.broker.acquire();
      this.acquired = true;
    } catch (cause) {
      if (isRetryableWorkspaceAcquisition(cause)) {
        this.uncertain = false;
        throw cause;
      }
      throw new HostedToolRecoveryRequiredError(cause);
    }
  }

  async execute(
    calls: ToolCallRequestInfo[],
    parts: Part[],
    model: string,
    signal: AbortSignal,
  ): Promise<Part[]> {
    const ids = new Set<string>();
    const requests = calls.map((call) => {
      const isShell = call.name === 'run_shell_command';
      if (
        !this.declarations.some((tool) => tool.name === call.name) ||
        ids.has(call.callId) ||
        call.wasOutputTruncated === true
      )
        throw new Error('Hosted Workspace profile refused a tool call.');
      ids.add(call.callId);
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
        if (this.publication && args['is_background'] !== undefined) {
          validationError = 'Hosted Shell requires one foreground command.';
        }
        input = this.publication
          ? { ...args }
          : { ...args, is_background: false };
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
        input,
        isShell,
        inputDigest: isShell ? managedToolDigest(input) : undefined,
        payloadJson,
        inputBytes,
        digest: `sha256:${createHash('sha256').update(payloadJson).digest('hex')}`,
        argsDigest: `sha256:${managedToolDigest(input)}`,
        publicationId: isShell && this.publication ? randomUUID() : null,
        runtimeCallId,
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
      await this.acquire();
    }
    const reserved: string[] = [];
    const shellBindings = new Map<
      string,
      {
        publicationId: string;
        publicationToken: string;
        runtimeBindingId: string;
        bindingGeneration: string;
        runtimeCallId: string;
        argsDigest: string;
        requestDigest: string;
        argsRef: ManagedSessionDurableRef;
        intentSequence: number;
        modelCallId: string;
        captureId: string;
        originalBinding?: ToolPublicationBinding;
      }
    >();
    let renewTimer: NodeJS.Timeout | undefined;
    let renewInFlight: Promise<void> | null = null;
    let renewGrants: (() => Promise<void>) | undefined;
    try {
      this.uncertain = true;
      if (
        this.shell &&
        requests.some((request) => request.isShell) &&
        !this.publisher
      ) {
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
        const prepared =
          request.isShell && this.publication
            ? await this.broker.prepareV3(
                request.runtimeCallId,
                request.argsDigest,
                request.digest,
                request.publicationId!,
              )
            : null;
        const executionCallId =
          prepared?.executionCallId ??
          (await this.broker.prepare(
            request.runtimeCallId,
            request.digest,
            request.inputDigest,
          ));
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
        const argsRef =
          request.isShell && !this.publication
            ? await this.session.resources.publish(
                'managed-tool-args',
                Buffer.from(JSON.stringify(request.input)),
              )
            : routeRef;
        const intent = await authority.appendExecutionEvent(
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
        if (prepared) {
          shellBindings.set(executionCallId, {
            publicationId: request.publicationId!,
            publicationToken: createToolPublicationToken(),
            runtimeBindingId: prepared.runtimeBindingId,
            bindingGeneration: prepared.bindingGeneration,
            runtimeCallId: request.runtimeCallId,
            argsDigest: request.argsDigest,
            requestDigest: request.digest,
            argsRef: routeRef,
            intentSequence: intent.lastSequence,
            modelCallId: request.call.callId,
            captureId: randomUUID(),
          });
        }
        bindings.push({
          functionCallId: request.call.callId,
          toolName: request.call.name,
          executionCallId,
          invocationBindingId: request.isShell
            ? request.runtimeCallId
            : executionCallId,
          capabilityVersion: WORKSPACE_CAPABILITY_DIGEST,
          policyVersion: 'preapproved-workspace-tools/1',
          mediaVersion: null,
          modelMessageId: messageId,
          partIndex: parts.findIndex(
            (part) => part.functionCall?.id === request.call.callId,
          ),
          ordinal,
          inputDigest:
            request.isShell && this.publication
              ? request.argsDigest.slice(7)
              : (request.inputDigest ?? request.digest.slice(7)),
          progressCursor: null,
          attemptId: messageId,
          routeRef,
        });
        if (request.isShell && this.publisher) {
          this.publisher!.register(
            {
              reference: {
                sessionId: this.promptId,
                promptId: this.promptId,
                callId: request.runtimeCallId,
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
      if (shellBindings.size > 0) {
        const owner = await this.publication!.owner.owner();
        const authority = this.session.authority;
        const key = authority.sessionHeader.sessionKey;
        const checkpointRef = authority.latestCheckpoint?.stateRef;
        if (!checkpointRef)
          throw new Error('Tool v3 await_runtime checkpoint is missing.');
        for (const [executionCallId, saved] of shellBindings) {
          const binding = {
            publication: 'managed-tool-publication/1',
            publicationId: saved.publicationId,
            sessionKey: key,
            turnId: this.promptId,
            executionCallId,
            modelCallId: saved.modelCallId,
            runtimeBindingId: saved.runtimeBindingId,
            reference: {
              sessionId: this.promptId,
              promptId: this.promptId,
              callId: saved.runtimeCallId,
              argsDigest: saved.argsDigest,
            },
            bindingGeneration: saved.bindingGeneration,
            captureId: saved.captureId,
            revision: 1,
            captureScope: 'process_pipes',
            capturePolicy: 'complete_required',
            argsRef: saved.argsRef,
            requestDigest: saved.requestDigest,
            writerId: owner.writerId,
            writerGeneration: owner.writerGeneration,
            activationId: this.session.activation.activationId,
            activationEpoch: this.session.activation.epoch,
            intentSequence: saved.intentSequence,
            checkpointRef,
          };
          const reservation = {
            publication: 'managed-tool-publication/1',
            operation: 'reserve',
            sessionKey: key,
            owner,
            binding,
            captureBytes: this.publication!.captureBytes,
          };
          let grant: unknown;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              grant = await this.publication!.owner.request(
                '/grants',
                reservation,
                saved.publicationToken,
              );
              break;
            } catch (cause) {
              const retryable =
                (cause instanceof ManagedSessionStoreHttpError &&
                  (cause.status === 429 || cause.status >= 500)) ||
                cause instanceof TypeError ||
                (cause instanceof DOMException &&
                  ['AbortError', 'TimeoutError'].includes(cause.name));
              if (!retryable || attempt === 2) throw cause;
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
          }
          if (
            typeof grant !== 'object' ||
            grant === null ||
            (grant as Record<string, unknown>)['state'] !== 'OPEN'
          )
            throw new Error('Tool publication reservation was not confirmed.');
          saved.originalBinding = parseToolPublicationBinding(binding);
        }
        renewGrants = () => {
          if (renewInFlight) return renewInFlight;
          const pending = (async () => {
            const writer = await this.publication!.owner.owner();
            for (const saved of shellBindings.values()) {
              await this.publication!.owner.request(
                '/grants',
                {
                  publication: 'managed-tool-publication/1',
                  operation: 'renew',
                  sessionKey: key,
                  owner: writer,
                  publicationId: saved.publicationId,
                },
                saved.publicationToken,
              );
            }
          })();
          renewInFlight = pending.finally(() => {
            renewInFlight = null;
          });
          return renewInFlight;
        };
        renewTimer = setInterval(() => {
          void renewGrants!().catch((cause: unknown) => {
            writeStderrLineSafe(
              'qwen serve: Tool publication renewal failed: ' + String(cause),
            );
          });
        }, 10_000);
        renewTimer.unref();
      }
      const responses: Part[] = [];
      for (const [index, request] of requests.entries()) {
        const executionCallId = reserved[index];
        if (request.isShell && this.publication) {
          const saved = shellBindings.get(executionCallId);
          if (!saved) throw new Error('Original Shell publication is missing.');
          await renewGrants!();
          let result: ToolResultEnvelope;
          try {
            result = await this.broker.executeV3(
              executionCallId,
              request.payloadJson,
              saved.publicationId,
              saved.publicationToken,
              signal,
            );
          } catch (failure) {
            if (
              !(failure instanceof HostedWorkspaceBrokerRejection) ||
              failure.status !== 409 ||
              failure.code !== 'runtime_broker_execution_unknown' ||
              !saved.originalBinding
            )
              throw failure;
            const finished = (await this.publication!.owner.request(
              `/publications/${saved.publicationId}/finished`,
              {},
            )) as Record<string, unknown>;
            if (
              !isDeepStrictEqual(
                parseToolPublicationBinding(finished['binding']),
                saved.originalBinding,
              )
            )
              throw new Error('Finished publication binding changed.');
            result = parseToolResultEnvelope(finished['result']);
          }
          responses.push(
            ...(await this.acceptShell(
              request.call,
              executionCallId,
              saved.publicationId,
              saved.publicationToken,
              result,
              model,
            )),
          );
          shellBindings.delete(executionCallId);
          continue;
        }
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
      if (renewTimer) {
        clearInterval(renewTimer);
        renewTimer = undefined;
      }
      const activeRenewal = renewInFlight as Promise<void> | null;
      await activeRenewal?.catch(() => undefined);
      await Promise.allSettled(reserved.map((id) => this.broker.cancel(id)));
      for (const executionCallId of shellBindings.keys()) {
        const saved = shellBindings.get(executionCallId);
        if (!saved) continue;
        try {
          const owner = this.publication!.owner;
          const closed = await owner.request(
            '/grants',
            {
              publication: 'managed-tool-publication/1',
              operation: 'close_not_started',
              sessionKey: this.session.authority.sessionHeader.sessionKey,
              owner: await owner.owner(),
              publicationId: saved.publicationId,
            },
            saved.publicationToken,
          );
          if (
            typeof closed !== 'object' ||
            closed === null ||
            (closed as Record<string, unknown>)['state'] !== 'NOT_STARTED'
          )
            throw new Error('Original execution was not proven unstarted.');
        } catch (closeCause) {
          writeStderrLineSafe(
            'qwen serve: Tool publication close was not confirmed: ' +
              String(closeCause),
          );
        }
      }
      throw new HostedToolRecoveryRequiredError(cause);
    } finally {
      if (renewTimer) clearInterval(renewTimer);
      const activeRenewal = renewInFlight as Promise<void> | null;
      await activeRenewal?.catch(() => undefined);
    }
  }

  private async acceptShell(
    call: ToolCallRequestInfo,
    executionCallId: string,
    publicationId: string,
    publicationToken: string,
    brokerResult: ToolResultEnvelope,
    model: string,
  ): Promise<Part[]> {
    if (
      brokerResult.executionStatus === 'not_started' &&
      brokerResult.capture === null
    ) {
      const owner = this.publication!.owner;
      const closed = (await owner.request(
        '/grants',
        {
          publication: 'managed-tool-publication/1',
          operation: 'close_not_started',
          sessionKey: this.session.authority.sessionHeader.sessionKey,
          owner: await owner.owner(),
          publicationId,
        },
        publicationToken,
      )) as Record<string, unknown>;
      if (closed['state'] !== 'NOT_STARTED')
        throw new Error('Original Shell was not proven unstarted.');
      const authority = this.session.authority;
      let receipt = authority
        .eventsInSequenceRange(1, authority.committedSequence)
        .find(
          (event) =>
            event.kind === 'tool.receipt' &&
            event.payload['executionCallId'] === executionCallId,
        );
      let ref: ManagedSessionDurableRef;
      let converted: Part[];
      let messageId: string;
      let timestamp: string;
      if (receipt) {
        ref = assertManagedSessionDurableRef(
          receipt.payload['toolOutcomeRef'],
          'original tool outcome',
        );
        const saved = JSON.parse(
          (await this.session.resources.read(ref)).toString('utf8'),
        ) as Record<string, unknown>;
        const history = saved['history'] as Record<string, unknown> | undefined;
        if (
          saved['schemaVersion'] !== 1 ||
          saved['decision'] !== 'blocked' ||
          !isDeepStrictEqual(saved['envelope'], brokerResult) ||
          saved['manifestRef'] !== null ||
          receipt.payload['resultRef'] !== null ||
          receipt.payload['historyRevision'] !== receipt.sequence ||
          typeof history?.['messageId'] !== 'string' ||
          typeof history['timestamp'] !== 'string' ||
          typeof history['model'] !== 'string' ||
          !Array.isArray(history['parts'])
        )
          throw new Error('Original unstarted Shell receipt conflicts.');
        converted = history['parts'] as Part[];
        messageId = history['messageId'];
        timestamp = history['timestamp'];
        model = history['model'];
      } else {
        const errorMessage = brokerResult.error?.message;
        const modelMessage =
          errorMessage && errorMessage.length > 4096
            ? `${errorMessage.slice(0, 2048)}\n[... error truncated ...]\n${errorMessage.slice(-2048)}`
            : (errorMessage ?? 'Runtime Shell did not start.');
        converted = convertToFunctionErrorResponse(
          call.name,
          call.callId,
          [],
          modelMessage,
        );
        const response = converted[0]?.functionResponse;
        if (!response || converted.length !== 1)
          throw new Error('Unstarted Shell result cannot be recorded.');
        response.response = {
          ...response.response,
          executionStatus: 'not_started',
        };
        if (!this.messageFitsInline('tool_result', converted, model))
          throw new Error('Unstarted Shell result cannot be recorded.');
        const originalIntent = authority
          .eventsInSequenceRange(1, authority.committedSequence)
          .find(
            (event) =>
              event.kind === 'tool.intent' &&
              event.payload['executionCallId'] === executionCallId,
          );
        if (!originalIntent)
          throw new Error('Original Shell intent is missing.');
        messageId = shellHistoryId(executionCallId);
        timestamp = new Date(originalIntent.occurredAt).toISOString();
        const outcome = Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            decision: 'blocked',
            envelope: brokerResult,
            manifestRef: null,
            history: { messageId, timestamp, model, parts: converted },
          }),
        );
        if (
          outcome.length >
          HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes
        )
          throw new Error('Unstarted Shell outcome exceeds its limit.');
        ref = await this.session.resources.publish(
          'managed-tool-outcome',
          outcome,
        );
        await authority.appendExecutionEvent(
          {
            operation: 'recordToolResult',
            commandId: executionCallId,
            sessionKey: authority.sessionHeader.sessionKey,
            contentDigest: ref.digest,
          },
          (sequence) => ({
            v: 1,
            sequence,
            eventId: `tool-receipt:${executionCallId}`,
            sessionKey: authority.sessionHeader.sessionKey,
            kind: 'tool.receipt',
            occurredAt: Date.now(),
            payload: {
              executionCallId,
              toolOutcomeRef: ref,
              resultRef: null,
              resources: [],
              historyRevision: sequence,
            },
          }),
          { class: 'trusted_entry' },
        );
        receipt = authority
          .eventsInSequenceRange(1, authority.committedSequence)
          .find(
            (event) =>
              event.kind === 'tool.receipt' &&
              event.payload['executionCallId'] === executionCallId,
          );
      }
      if (!receipt)
        throw new Error('Original unstarted Shell receipt disappeared.');
      await this.commit('tool_result', converted, model, {
        uuid: messageId,
        timestamp,
      });
      await this.harness.resolveAwaitRuntime(executionCallId, ref);
      return converted;
    }
    const owner = this.publication!.owner;
    const finished = await owner.request(
      `/publications/${publicationId}/finished`,
      {},
    );
    const source = finished as Record<string, unknown>;
    const envelope = parseToolResultEnvelope(source['result']);
    if (!isDeepStrictEqual(envelope, parseToolResultEnvelope(brokerResult)))
      throw new Error('Broker result differs from the finished publication.');
    const manifestRef = envelope.capture?.manifest ?? null;
    const decision =
      envelope.capture?.captureStatus === 'complete' ? 'committed' : 'blocked';
    const authority = this.session.authority;
    let receipt = authority
      .eventsInSequenceRange(1, authority.committedSequence)
      .find(
        (event) =>
          event.kind === 'tool.receipt' &&
          event.payload['executionCallId'] === executionCallId,
      );
    let ref!: ManagedSessionDurableRef;
    let converted: Part[];
    let messageId: string;
    let timestamp: string;
    if (receipt) {
      ref = assertManagedSessionDurableRef(
        receipt.payload['toolOutcomeRef'],
        'original tool outcome',
      );
      const saved = JSON.parse(
        (await this.session.resources.read(ref)).toString('utf8'),
      ) as Record<string, unknown>;
      const history = saved['history'] as Record<string, unknown> | undefined;
      if (
        saved['schemaVersion'] !== 1 ||
        saved['decision'] !== decision ||
        !isDeepStrictEqual(saved['envelope'], envelope) ||
        !isDeepStrictEqual(saved['manifestRef'], manifestRef) ||
        !isDeepStrictEqual(
          receipt.payload['resultRef'],
          decision === 'committed' ? manifestRef : null,
        ) ||
        typeof history?.['messageId'] !== 'string' ||
        typeof history['timestamp'] !== 'string' ||
        typeof history['model'] !== 'string' ||
        !Array.isArray(history['parts'])
      )
        throw new Error('Original Shell receipt conflicts with its result.');
      converted = history['parts'] as Part[];
      model = history['model'];
      messageId = history['messageId'];
      timestamp = history['timestamp'];
    } else {
      const responseParts = boundedShellPreview(
        envelope.responseParts,
      ) as Part[];
      converted =
        envelope.executionStatus === 'success'
          ? convertToFunctionResponse(call.name, call.callId, responseParts)
          : convertToFunctionErrorResponse(
              call.name,
              call.callId,
              responseParts,
              envelope.error?.message ??
                `Runtime tool ${envelope.executionStatus}.`,
            );
      if (converted.length === 1 && converted[0]?.functionResponse) {
        const response = converted[0].functionResponse;
        response.response = {
          ...response.response,
          manifestRef,
          captureStatus: envelope.capture?.captureStatus ?? 'unavailable',
          previewTruncated: envelope.capture?.previewTruncated ?? false,
        };
      }
      if (
        converted.length !== 1 ||
        !converted[0]?.functionResponse ||
        !this.messageFitsInline('tool_result', converted, model)
      ) {
        converted = [
          {
            functionResponse: {
              id: call.callId,
              name: call.name,
              response: {
                executionStatus: envelope.executionStatus,
                captureStatus: envelope.capture?.captureStatus ?? 'unavailable',
                manifestRef,
                previewTruncated: envelope.capture?.previewTruncated ?? false,
                outputOmitted: true,
                summary: 'The Shell result was saved in its immutable capture.',
              },
            },
          },
        ];
      }
      if (!this.messageFitsInline('tool_result', converted, model))
        throw new Error('Original Shell history exceeds the Session limit.');
      const originalIntent = authority
        .eventsInSequenceRange(1, authority.committedSequence)
        .find(
          (event) =>
            event.kind === 'tool.intent' &&
            event.payload['executionCallId'] === executionCallId,
        );
      if (!originalIntent) throw new Error('Original Shell intent is missing.');
      messageId = shellHistoryId(executionCallId);
      timestamp = new Date(originalIntent.occurredAt).toISOString();
      const outcome = {
        schemaVersion: 1,
        decision,
        envelope,
        manifestRef,
        history: { messageId, timestamp, model, parts: converted },
      };
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          ref = (await owner.request(
            `/publications/${publicationId}/admissions/prepare`,
            outcome,
          )) as ManagedSessionDurableRef;
          break;
        } catch (error) {
          const uncertain =
            (error instanceof ManagedSessionStoreHttpError &&
              (error.status === 429 || error.status >= 500)) ||
            error instanceof TypeError ||
            (error instanceof DOMException &&
              ['AbortError', 'TimeoutError'].includes(error.name));
          if (!uncertain || attempt === 2) throw error;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      owner.rememberAdmission(publicationId, ref);
      await authority.appendExecutionEvent(
        {
          operation: 'recordToolResult',
          commandId: executionCallId,
          sessionKey: authority.sessionHeader.sessionKey,
          contentDigest: ref.digest,
        },
        (sequence) => ({
          v: 1,
          sequence,
          eventId: `tool-receipt:${executionCallId}`,
          sessionKey: authority.sessionHeader.sessionKey,
          kind: 'tool.receipt',
          occurredAt: Date.now(),
          payload: {
            executionCallId,
            toolOutcomeRef: ref,
            resultRef: decision === 'committed' ? manifestRef : null,
            resources: manifestRef ? [manifestRef] : [],
            historyRevision: sequence,
          },
        }),
        { class: 'trusted_entry' },
      );
      receipt = authority
        .eventsInSequenceRange(1, authority.committedSequence)
        .find(
          (event) =>
            event.kind === 'tool.receipt' &&
            event.payload['executionCallId'] === executionCallId,
        );
    }
    if (!receipt) throw new Error('Original Shell receipt disappeared.');
    await this.commit('tool_result', converted, model, {
      uuid: messageId,
      timestamp,
    });
    if (decision === 'committed')
      await this.harness.resolveAwaitRuntime(executionCallId, ref);
    try {
      await this.broker.acknowledgeV3(executionCallId, {
        executionCallId,
        manifest: manifestRef,
        deliveryStatus: decision,
        historyRevision: decision === 'committed' ? receipt.sequence : null,
      });
    } catch (cause) {
      writeStderrLineSafe(
        'qwen serve: Tool v3 ACK can be retried after its Session receipt: ' +
          String(cause),
      );
    }
    if (decision !== 'committed')
      throw new Error('Incomplete Shell capture blocked the Hosted tool turn.');
    return converted;
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
