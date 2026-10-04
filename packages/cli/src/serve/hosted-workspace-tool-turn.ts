/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  readHostedFileHistory,
  commitHostedFileHistory,
  assertHostedFileHistoryCapacity,
  HostedFileHistoryRefusedError,
  canSettleHostedFileHistory,
} from './hosted-file-history.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
  assertManagedSessionStableId,
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
  isHostedFileHistoryRefusal,
  type HostedWorkspaceBrokerOptions,
} from './hosted-workspace-broker.js';
import { HostedShellPublisher } from './hosted-shell-publisher.js';
import type { HostedMcpSession } from './hosted-mcp-session.js';
import type {
  HostedHookSession,
  HostedPromptHookRunner,
} from './hosted-hook-session.js';
import {
  HookEventName,
  PreToolUseHookOutput,
  createHookOutput,
  type HookOutput,
} from '@qwen-code/qwen-code-core/hooks/types.js';
import { hostedHookOccurrenceId } from './hosted-hook-session.js';
import { parseHookExecution } from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-record.js';
import { waitForTurn } from './hosted-turn-wait.js';
import { boundedShellPreview } from './managed-shell-publisher.js';
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
const ACQUIRE_BUSY_POLL_MS = 250;
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
function isBusyWorkspaceAcquisition(cause: unknown): boolean {
  return (
    isRetryableWorkspaceAcquisition(cause) && cause.code === 'workspace_busy'
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
      'Write a file in the remote Workspace. Read before overwriting an existing file.',
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
      'Replace exact text in a remote Workspace file that you have read.',
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
      'Run a foreground command in the saved Workspace working directory. Complete stdout and stderr are retained; the model receives a bounded preview. Background jobs are unavailable. Shell file mutations are not backed up. Changing tracked file content or permissions can cause subsequent Write/Edit and undo conflicts.',
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

function physicalToolStatus(
  response: Record<string, unknown> | undefined,
): 'success' | 'error' | 'cancelled' {
  if (response?.['executionStatus'] !== undefined)
    return response['executionStatus'] === 'success'
      ? 'success'
      : response['executionStatus'] === 'cancelled'
        ? 'cancelled'
        : 'error';
  return response?.['error'] ? 'error' : 'success';
}

export class HostedToolRecoveryRequiredError extends Error {
  constructor(cause: unknown) {
    super(
      'Hosted tool turn requires recovery; its original work was not released.',
      { cause },
    );
  }
}

export class HostedWorkspaceToolTurn {
  hookStopReason?: string;
  private readonly broker: HostedWorkspaceBroker;
  private readonly warmed: Promise<void>;
  private acquired = false;
  private uncertain = false;
  private publisher?: HostedShellPublisher;
  private bindingGeneration?: string;
  private advertised?: FunctionDeclaration[];
  private readonly publication?: {
    owner: HttpToolPublicationOwner;
    captureBytes: number;
  };
  private readonly shell?: HostedShellTurnOptions;
  // Once an approval expires nobody is answering, so the Turn asks no more.
  private unanswered = false;
  private promptHookRunner?: HostedPromptHookRunner;
  private readonly hookPermission = new Map<string, 'allow' | 'deny'>();

  constructor(
    private readonly options: HostedWorkspaceBrokerOptions,
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
    private readonly approval?: HostedApprovalTurnOptions,
    private readonly mcp?: HostedMcpSession,
    private readonly hooks?: HostedHookSession,
  ) {
    this.publication =
      publicationOrShell && 'owner' in publicationOrShell
        ? publicationOrShell
        : undefined;
    this.shell =
      publicationOrShell && 'resources' in publicationOrShell
        ? publicationOrShell
        : shell;
    this.broker =
      mcp?.broker ??
      hooks?.broker ??
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
      ...(this.publication || this.shell
        ? HOSTED_WORKSPACE_SHELL_TOOLS
        : HOSTED_WORKSPACE_FILE_TOOLS
      ).map((tool) =>
        ['write_file', 'edit'].includes(tool.name ?? '')
          ? {
              ...tool,
              description:
                tool.description +
                (this.mcp
                  ? ' This MCP profile provides no file backups or undo for Write/Edit.'
                  : ' Write/Edit preimages are backed up. External or Shell changes to tracked content or permissions block further Write/Edit in the same prompt and block undo. A new Write/Edit prompt must validate a fresh backup before accepting those changes.'),
            }
          : tool,
      ),
      ...(this.mcp?.tools() ?? []),
    ];
    return this.advertised;
  }

  async resumeCommittedResults(): Promise<void> {
    if (this.acquired) return;
    await this.warmed;
    const saved = await readHostedFileHistory(this.session);
    if (saved?.pendingTurn) {
      this.uncertain = true;
      try {
        if (
          saved.pendingTurn !== this.promptId ||
          !(await canSettleHostedFileHistory(this.session, saved))
        )
          throw new Error('Hosted file history requires recovery.');
        const authorization =
          await this.session.authority.harnessRunAuthorization();
        if (authorization.status !== 'runnable')
          throw new Error('Hosted file history requires recovery.');
        const owners = new Set<string>();
        for (const item of authorization.checkpoint.tools?.items ?? []) {
          if (
            item.modelMessageId !== saved.pendingMessageId ||
            !['write_file', 'edit'].includes(item.toolName)
          )
            continue;
          const intent = this.session.authority
            .eventsInSequenceRange(1, this.session.authority.committedSequence)
            .findLast(
              (event) =>
                event.kind === 'tool.intent' &&
                event.payload['executionCallId'] === item.executionCallId &&
                event.payload['batchId'] === saved.pendingMessageId,
            );
          const inputRef = assertManagedSessionDurableRef(
            intent?.payload['argsRef'],
            'file history tool input',
          );
          if (inputRef.kind !== 'managed-tool-input')
            throw new Error('Hosted file history owner conflicts.');
          const input = JSON.parse(
            (await this.session.resources.read(inputRef)).toString(),
          ) as { harnessSessionId: unknown; runtimeSessionId: unknown };
          if (
            input.harnessSessionId !==
              this.session.authority.sessionHeader.sessionKey.sessionId ||
            typeof input.runtimeSessionId !== 'string'
          )
            throw new Error('Hosted file history owner conflicts.');
          owners.add(
            assertManagedSessionStableId(
              input.runtimeSessionId,
              'file history Runtime owner',
            ),
          );
        }
        if (owners.size !== 1)
          throw new Error('Hosted file history owner conflicts.');
        const originalId = [...owners][0];
        const original =
          originalId === this.broker.runtimeSessionId
            ? this.broker
            : new HostedWorkspaceBroker(
                this.options,
                this.session.authority.sessionHeader.sessionKey,
                originalId,
              );
        await original.warm();
        await original.acquire();
        const state = await original.fileHistory({
          kind: 'raw-file-history',
          action: 'snapshot',
        });
        if (!isDeepStrictEqual(state.snapshots, saved.state.snapshots))
          throw new Error('Original file history snapshots changed.');
        await commitHostedFileHistory(this.session, {
          schemaVersion: 1,
          state,
          pendingTurn: null,
          pendingUndo: null,
        });
        if (original === this.broker) {
          this.acquired = true;
          this.uncertain = false;
          return;
        }
      } catch (cause) {
        throw new HostedToolRecoveryRequiredError(cause);
      }
    }
    await this.acquire(true);
    this.uncertain = false;
  }

  private async acquire(
    recovering = false,
    signal?: AbortSignal,
  ): Promise<void> {
    this.uncertain = true;
    let waitAborted = false;
    try {
      let queued = false;
      for (;;) {
        try {
          if (this.hooks && !this.mcp) await this.hooks.acquire();
          else await this.broker.acquire();
          break;
        } catch (cause) {
          // A definite busy refusal before claiming storage means another
          // Session's tool turn holds the mount: the turn waits for that
          // holder to release instead of failing terminally. Only the
          // turn-execution path queues (it passes the turn's AbortSignal, so
          // cancellation and the prompt deadline still apply); recovery
          // acquisitions and the workspace_unavailable refusal keep the
          // fast, classified refusal.
          if (signal === undefined || !isBusyWorkspaceAcquisition(cause))
            throw cause;
          if (!queued) {
            queued = true;
            writeStderrLineSafe(
              `qwen serve: Hosted Harness turn ${this.promptId} waits for the Workspace mount held by another Session.`,
            );
          }
          try {
            await waitForTurn(
              new Promise((resolve) =>
                setTimeout(resolve, ACQUIRE_BUSY_POLL_MS),
              ),
              signal,
            );
          } catch (waitCause) {
            // Every response so far was a definite refusal, so a cancelled
            // queue wait provably leaves nothing held or unknown — unlike an
            // ambiguous acquire failure, which keeps recovery blocking even
            // when the turn itself is being cancelled.
            waitAborted = true;
            throw waitCause;
          }
        }
      }
      this.acquired = true;
      if (!this.mcp) {
        const saved = await readHostedFileHistory(this.session);
        if (saved?.pendingUndo)
          throw new Error('Hosted file history requires recovery.');
        if (saved?.pendingTurn)
          throw new Error('Hosted file history requires recovery.');
        try {
          await this.broker.fileHistory({
            kind: 'raw-file-history',
            action: 'bind',
            state: saved?.state ?? null,
          });
        } catch (cause) {
          // A saved continuation still needs this original runtime ID.
          if (recovering || !isHostedFileHistoryRefusal(cause)) throw cause;
          if (!this.hooks) await this.broker.release();
          this.acquired = false;
          throw new HostedFileHistoryRefusedError(
            cause.reason ?? cause.message,
          );
        }
      }
    } catch (cause) {
      if (
        (!this.acquired &&
          (isRetryableWorkspaceAcquisition(cause) || waitAborted)) ||
        cause instanceof HostedFileHistoryRefusedError
      ) {
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
    if (!this.hooks) return this.executeNative(calls, parts, model, signal);
    const responses = await this.executeNative(calls, parts, model, signal);
    return this.completeHookResults(calls, responses, model, signal);
  }

  private async completeHookResults(
    calls: ToolCallRequestInfo[],
    responses: Part[],
    model: string,
    signal: AbortSignal,
  ): Promise<Part[]> {
    if (!this.hooks) return responses;
    const contextParts: Part[] = [];
    const history = await this.session.sink.project();
    const assistant = history.findLast(
      (entry) =>
        entry.type === 'assistant' &&
        entry.daemonPromptId === this.promptId &&
        entry.message?.parts?.some(
          (part) => part.functionCall?.id === calls[0]?.callId,
        ),
    );
    const intents = this.session.authority
      .eventsInSequenceRange(1, this.session.authority.committedSequence)
      .filter(
        (entry) =>
          entry.kind === 'tool.intent' &&
          entry.payload['batchId'] === assistant?.uuid,
      );
    const preToolOutputs = new Map<string, PreToolUseHookOutput>();
    const effective = await Promise.all(
      calls.map(async (call) => {
        const marker = this.session.authority.extensionRecord(
          'hook_execution',
          hostedHookOccurrenceId(
            HookEventName.PreToolUse,
            `${this.promptId}:${call.callId}`,
          ),
        );
        if (!marker) return call;
        const record = parseHookExecution(marker.record);
        const original = JSON.parse(
          (await this.session.resources.read(record.inputRef)).toString(),
        ) as { tool_input?: Record<string, unknown> };
        const saved = record.resultRef
          ? (JSON.parse(
              (await this.session.resources.read(record.resultRef)).toString(),
            ) as { output?: HookOutput })
          : undefined;
        if (saved?.output)
          preToolOutputs.set(
            call.callId,
            new PreToolUseHookOutput(saved.output),
          );
        return {
          ...call,
          args:
            (saved?.output?.hookSpecificOutput?.['updatedInput'] as
              | Record<string, unknown>
              | undefined) ??
            original.tool_input ??
            call.args,
        };
      }),
    );
    for (const [ordinal, call] of effective.entries()) {
      const dispatched = intents.some(
        (entry) => entry.payload['ordinal'] === ordinal,
      );
      const response = responses.find(
        (part) => part.functionResponse?.id === call.callId,
      )?.functionResponse?.response;
      const preToolOutput = preToolOutputs.get(call.callId);
      const beforeContext = preToolOutput?.getAdditionalContext();
      if (
        beforeContext &&
        response?.['executionStatus'] !== 'cancelled' &&
        (!preToolOutput?.isAsk() || dispatched)
      )
        contextParts.push({ text: beforeContext });
      if (!dispatched) continue;
      if (response?.['executionStatus'] === 'not_started') continue;
      const failed = physicalToolStatus(response) !== 'success';
      const result = await this.hooks.fire(
        failed ? HookEventName.PostToolUseFailure : HookEventName.PostToolUse,
        `${this.promptId}:${call.callId}`,
        {
          tool_name: call.name,
          tool_input: call.args,
          tool_use_id: call.callId,
          ...(failed
            ? {
                error: String(
                  response?.['error'] ??
                    response?.['executionStatus'] ??
                    'Tool failed',
                ),
                is_interrupt: response?.['executionStatus'] === 'cancelled',
              }
            : { tool_response: response }),
          permission_mode: this.approval?.settings.mode ?? 'yolo',
          prompt_id: this.promptId,
        },
        signal,
        this.promptHookRunner,
      );
      const output =
        result &&
        createHookOutput(
          failed ? HookEventName.PostToolUseFailure : HookEventName.PostToolUse,
          result,
        );
      if (output?.shouldStopExecution())
        this.hookStopReason ??=
          output.getEffectiveReason() || 'Stopped by Hook.';
      const context = output?.getAdditionalContext();
      if (context) contextParts.push({ text: context });
    }
    const batch = await this.hooks.fire(
      HookEventName.PostToolBatch,
      `${this.promptId}:${calls.map((call) => call.callId).join(':')}`,
      {
        tool_calls: effective.map((call) => {
          const response = responses.find(
            (part) => part.functionResponse?.id === call.callId,
          )?.functionResponse?.response;
          return {
            tool_name: call.name,
            tool_input: call.args,
            tool_use_id: call.callId,
            status: physicalToolStatus(response),
            tool_response: response,
          };
        }),
        permission_mode: this.approval?.settings.mode ?? 'yolo',
        prompt_id: this.promptId,
      },
      signal,
      this.promptHookRunner,
    );
    const output =
      batch && createHookOutput(HookEventName.PostToolBatch, batch);
    if (output?.shouldStopExecution())
      this.hookStopReason ??= output.getEffectiveReason() || 'Stopped by Hook.';
    const context = output?.getAdditionalContext();
    if (context) contextParts.push({ text: context });
    if (contextParts.length) {
      if (!this.messageFitsInline('tool_result', contextParts, model)) {
        this.hookStopReason ??=
          'Hook context exceeds the inline Session Store limit.';
        return [...responses];
      }
      const batchId = `${this.promptId}:${calls.map((call) => call.callId).join(':')}`;
      const uuid = shellHistoryId(`${batchId}:hook-context`);
      if (!history.some((entry) => entry.uuid === uuid))
        await this.commit('tool_result', contextParts, model, {
          uuid,
          timestamp: assistant?.timestamp ?? new Date(0).toISOString(),
        });
    }
    return [...responses, ...contextParts];
  }

  async resumeHookResults(
    responses: readonly Part[],
    model: string,
    signal: AbortSignal,
  ): Promise<Part[]> {
    if (!this.hooks) return [...responses];
    const history = await this.session.sink.project();
    const assistant = history.findLast(
      (entry) =>
        entry.type === 'assistant' &&
        entry.daemonPromptId === this.promptId &&
        entry.message?.parts?.some((part) => part.functionCall),
    );
    if (!assistant?.message?.parts)
      throw new HostedToolRecoveryRequiredError(
        'Original Hook batch is unavailable.',
      );
    const calls = assistant.message.parts.flatMap((part) =>
      part.functionCall
        ? [
            {
              name: part.functionCall.name!,
              callId: part.functionCall.id!,
              args: part.functionCall.args ?? {},
              isClientInitiated: false,
              prompt_id: this.promptId,
            },
          ]
        : [],
    );
    const contextId = shellHistoryId(
      `${this.promptId}:${calls.map((call) => call.callId).join(':')}:hook-context`,
    );
    const savedContext =
      history.find((entry) => entry.uuid === contextId)?.message?.parts ?? [];
    const original = savedContext.length
      ? responses.slice(0, -savedContext.length)
      : [...responses];
    return this.completeHookResults(
      calls,
      original,
      assistant.model ?? model,
      signal,
    );
  }

  setPromptHookRunner(runner: HostedPromptHookRunner): void {
    this.promptHookRunner = runner;
  }

  private async executeNative(
    calls: ToolCallRequestInfo[],
    parts: Part[],
    model: string,
    signal: AbortSignal,
  ): Promise<Part[]> {
    signal.throwIfAborted();
    if (this.mcp) await waitForTurn(this.warmed, signal);
    const declarations = this.advertised ?? (await this.declarations(signal));
    this.hookPermission.clear();
    if (this.hooks && this.approval) {
      calls = await Promise.all(
        calls.map(async (call) => {
          if (!hostedApprovalAsks(this.approval!.settings, call.name))
            return call;
          const output = await this.hooks!.fire(
            HookEventName.PermissionRequest,
            `${this.promptId}:${call.callId}`,
            {
              tool_name: call.name,
              tool_input: call.args,
              tool_use_id: call.callId,
              prompt_id: this.promptId,
            },
            signal,
            this.promptHookRunner,
          );
          const decision = output?.hookSpecificOutput?.['decision'] as
            | {
                behavior?: 'allow' | 'deny';
                updatedInput?: Record<string, unknown>;
              }
            | undefined;
          if (decision?.behavior)
            this.hookPermission.set(call.callId, decision.behavior);
          if (
            output?.continue === false ||
            output?.decision === 'block' ||
            output?.decision === 'deny'
          )
            this.hookPermission.set(call.callId, 'deny');
          return decision?.updatedInput
            ? { ...call, args: decision.updatedInput }
            : call;
        }),
      );
    }
    const prepareRequests = (source: ToolCallRequestInfo[]) => {
      const ids = new Set<string>();
      return source.map((call) => {
        const runtimeCallId = randomUUID();
        const mcpInput = this.mcp?.toolInput(
          call.name,
          call.args,
          runtimeCallId,
        );
        const isShell = call.name === 'run_shell_command';
        if (
          !declarations.some((tool) => tool.name === call.name) ||
          ids.has(call.callId) ||
          // Refuse a call whose arguments arrived unterminated even when the
          // output token limit was not what cut them: this profile commits to a
          // remote Workspace with no undo backup, so a repaired partial
          // `content` or half-streamed command line is unrecoverable.
          call.wasOutputTruncated === true ||
          call.hadIncompleteArguments === true
        )
          throw new Error('Hosted Workspace profile refused a tool call.');
        ids.add(call.callId);
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
        const encoded = this.encodeToolInput(
          mcpInput ?? { toolName: call.name, input },
        );
        return {
          call,
          validationError,
          input,
          isShell,
          inputDigest: isShell ? managedToolDigest(input) : undefined,
          mcp: mcpInput !== undefined,
          ...encoded,
          argsDigest: `sha256:${managedToolDigest(input)}`,
          publicationId: isShell && this.publication ? randomUUID() : null,
          runtimeCallId,
        };
      });
    };
    let requests = prepareRequests(calls);
    if (!this.messageFitsInline('assistant', parts, model))
      throw new Error(
        'Hosted assistant record exceeds the inline Session Store limit.',
      );
    if (
      calls.some(
        (call) =>
          !this.messageFitsInline(
            'tool_result',
            convertToFunctionErrorResponse(
              call.name,
              call.callId,
              [],
              'The turn was cancelled before this tool call ran.',
            ),
            model,
          ),
      )
    )
      throw new Error(
        'Hosted tool cancellation exceeds the inline Session Store limit.',
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
      await this.acquire(false, signal);
    }
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
    let messageId: string;
    let refusals: Array<string | undefined>;
    const inputRefs = new Map<number, ManagedSessionDurableRef>();
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
      messageId = await this.commit('assistant', parts, model);
      refusals = await this.approve(requests, messageId, inputRefs, signal);
      if (this.hooks) {
        const updated = requests.map((request) => request.call);
        const askAgain = new Set<number>();
        for (const [index, request] of requests.entries()) {
          if (refusals[index]) continue;
          const output = await this.hooks.fire(
            HookEventName.PreToolUse,
            `${this.promptId}:${request.call.callId}`,
            {
              tool_name: request.call.name,
              tool_input: request.call.args,
              tool_use_id: request.call.callId,
              permission_mode: this.approval?.settings.mode ?? 'yolo',
              prompt_id: this.promptId,
            },
            signal,
            this.promptHookRunner,
          );
          const parsed = output && new PreToolUseHookOutput(output);
          const permission = parsed?.getPermissionDecision();
          if (
            parsed?.shouldStopExecution() ||
            parsed?.isBlockingDecision() ||
            permission === 'deny'
          ) {
            refusals[index] =
              (permission === 'deny' &&
                parsed?.getPermissionDecisionReason()) ||
              parsed?.getEffectiveReason() ||
              'PreToolUse Hook denied the call.';
            continue;
          }
          const input = output?.hookSpecificOutput?.['updatedInput'];
          if (
            input &&
            typeof input === 'object' &&
            !Array.isArray(input) &&
            !isDeepStrictEqual(input, request.call.args)
          ) {
            updated[index] = {
              ...request.call,
              args: input as Record<string, unknown>,
            };
            inputRefs.delete(index);
            if (
              this.approval &&
              hostedApprovalAsks(this.approval.settings, request.call.name)
            )
              askAgain.add(index);
          }
          if (permission === 'ask') askAgain.add(index);
        }
        const revised = prepareRequests(updated);
        requests = requests.map((request, index) =>
          updated[index] === request.call ? request : revised[index],
        );
        for (const [index, request] of requests.entries()) {
          if (refusals[index]) continue;
          if (request.validationError) {
            refusals[index] = request.validationError;
            continue;
          }
          if (askAgain.has(index)) {
            if (!this.approval) {
              refusals[index] =
                'Hook requires approval, but no approval policy is available.';
              continue;
            }
            const inputRef = await this.session.resources.publish(
              'managed-tool-input',
              request.inputBytes,
            );
            inputRefs.set(index, inputRef);
            refusals[index] = await this.ask(
              this.approval,
              request.call,
              inputRef,
              messageId,
              signal,
            );
          }
        }
      }
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
    const paths = requests.flatMap((request, index) =>
      !this.mcp &&
      refusals[index] === undefined &&
      ['write_file', 'edit'].includes(request.call.name)
        ? [request.input['file_path'] as string]
        : [],
    );
    if (paths.length) {
      try {
        const state = await this.broker.fileHistory({
          kind: 'raw-file-history',
          action: 'prepare',
          promptId: this.promptId,
          paths: [...new Set(paths)],
        });
        const prepared = {
          schemaVersion: 1 as const,
          state,
          pendingTurn: this.promptId,
          pendingMessageId: messageId,
          pendingUndo: null,
        };
        await assertHostedFileHistoryCapacity(this.session, prepared);
        await commitHostedFileHistory(this.session, prepared);
      } catch (cause) {
        if (
          !isHostedFileHistoryRefusal(cause) &&
          !(cause instanceof HostedFileHistoryRefusedError)
        )
          throw new HostedToolRecoveryRequiredError(cause);
        const reason =
          cause instanceof HostedWorkspaceBrokerRejection
            ? (cause.reason ?? cause.message)
            : cause.message;
        for (const [index, request] of requests.entries())
          if (
            refusals[index] === undefined &&
            ['write_file', 'edit'].includes(request.call.name)
          )
            refusals[index] =
              `Hosted file history refused this batch's Write/Edit before execution: ${reason.slice(0, 512)}`;
        paths.length = 0;
      }
    }
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
        let prepared;
        let executionCallId: string;
        try {
          prepared =
            request.isShell && this.publication
              ? await this.broker.prepareV3(
                  request.runtimeCallId,
                  request.argsDigest,
                  request.digest,
                  request.publicationId!,
                )
              : null;
          executionCallId =
            prepared?.executionCallId ??
            (await this.broker.prepare(
              request.runtimeCallId,
              request.digest,
              request.inputDigest,
              this.promptId,
            ));
        } catch (cause) {
          if (
            !(cause instanceof HostedWorkspaceBrokerRejection) ||
            cause.status !== 409 ||
            cause.code !== 'runtime_execution_conflict'
          )
            throw cause;
          refusals[ordinal] =
            'Runtime refused this execution reservation before dispatch: ' +
            (cause.reason ?? cause.message).slice(0, 512);
          continue;
        }
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
      if (bindings.length)
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
        const refused = refusal(index);
        if (refused) {
          await this.commit('tool_result', refused, model);
          responses.push(...refused);
          continue;
        }
        const executionCallId = reserved.get(index)!;
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
      if (paths.length) {
        const state = await this.broker.fileHistory({
          kind: 'raw-file-history',
          action: 'snapshot',
        });
        await commitHostedFileHistory(this.session, {
          schemaVersion: 1,
          state,
          pendingTurn: null,
          pendingUndo: null,
        });
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
      await Promise.allSettled(
        [...reserved.values()].map((id) => this.broker.cancel(id)),
      );
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
          executionStatus: envelope.executionStatus,
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
    const refusals: Array<string | undefined> = requests.map((request) =>
      this.hookPermission.get(request.call.callId) === 'deny'
        ? 'PermissionRequest Hook denied the call.'
        : undefined,
    );
    const approval = this.approval;
    if (!approval) return refusals;
    let asked = false;
    for (const [index, request] of requests.entries()) {
      if (
        refusals[index] ||
        this.hookPermission.get(request.call.callId) === 'allow' ||
        !hostedApprovalAsks(approval.settings, request.call.name)
      )
        continue;
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
      if (this.hookStopReason)
        await this.harness.settleHookStoppedRuntimeContinuation();
      else await this.harness.settleConsumedRuntimeContinuation();
      if (!this.mcp && !this.hooks) await this.broker.release();
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
