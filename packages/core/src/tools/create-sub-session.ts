/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `create_sub_session` tool — spawns a FRESH top-level sub-session (a sibling
 * of the current session, its own transcript) and runs a prompt in it.
 *
 * Daemon-only: it only ever exists under `qwen serve`, where the ACP session
 * both wires a {@link SubSessionSpawner} (routing the request to the daemon
 * bridge via `spawnOrAttach` + `sendPrompt`) and registers this tool. In
 * interactive TUI / headless there is no bridge, so the tool is never
 * registered and never pollutes the model's action space. The
 * spawner-missing check in `execute()` stays as a defensive guard for the
 * one path that can still reach it — a daemon session whose spawner was
 * cleared mid-flight (yielding `DAEMON_ONLY_MESSAGE`). In non-daemon
 * sessions the tool is absent from the registry entirely, so a stale
 * direct call is rejected by the registry-miss error before `execute()`
 * is ever reached.
 *
 * Two completion modes:
 *  - `'sent'`      — resolve as soon as the prompt is dispatched (fire-and-
 *                    forget); the sub-session keeps running independently.
 *  - `'first-turn'`— wait for the sub-session's first turn to finish and return
 *                    its result to the caller (default).
 */

import type {
  ToolCallConfirmationDetails,
  ToolInvocation,
  ToolResult,
} from './tools.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  ToolConfirmationOutcome,
} from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import { StructuredToolError, ToolErrorType } from './tool-error.js';
import { buildPermissionCheckContext } from '../core/permission-helpers.js';
import { ApprovalMode } from '../config/approval-mode.js';
import type { Config, SubSessionWorkspaceBinding } from '../config/config.js';
import type { PermissionDecision } from '../permissions/types.js';
import {
  MAX_SUB_SESSION_PROMPT_CHARS,
  MAX_SUB_SESSION_WORKSPACE_CHARS,
} from './sub-session-constants.js';
import {
  isValidCronTaskRoutingId,
  MAX_CRON_TASK_ROUTING_ID_LENGTH,
} from '../services/cronTasksFile.js';

export { MAX_SUB_SESSION_PROMPT_CHARS } from './sub-session-constants.js';

export interface CreateSubSessionParams {
  prompt: string;
  completion?: 'sent' | 'first-turn';
  model?: string;
  name?: string;
  workspace?: string;
  sessionId?: string;
}

const DAEMON_ONLY_MESSAGE =
  'create_sub_session is only available when running under `qwen serve` ' +
  '(daemon mode). There is no session bridge in this environment, so a ' +
  'sub-session cannot be spawned.';

/** Sentinel for "the caller's turn was cancelled while the spawn was in
 * flight". A symbol, so it can never collide with a spawner result. */
const CANCELLED = Symbol('create_sub_session:cancelled');

/**
 * Resolve as soon as EITHER the spawn settles or `signal` aborts.
 *
 * `Session.ts` awaits `invocation.execute(signal)` without racing the abort
 * itself, so a tool that ignores its signal pins the caller's tool loop for as
 * long as it runs — here, up to the daemon's 5-minute `first-turn` ceiling.
 *
 * Takes a thunk, not a promise: an already-aborted turn must not create daemon
 * work at all. Passing `spawner(…)` directly would evaluate it as an argument,
 * spawning a sub-session before the abort was ever checked.
 */
async function raceCancellation<T>(
  start: () => Promise<T>,
  signal: AbortSignal,
): Promise<T | typeof CANCELLED> {
  if (signal.aborted) return CANCELLED;
  const spawn = start();
  // The losing branch's rejection still needs a handler, or Node reports an
  // unhandled rejection once the cancel branch wins.
  void spawn.catch(() => {});
  return new Promise<T | typeof CANCELLED>((resolve, reject) => {
    const onAbort = (): void => resolve(CANCELLED);
    signal.addEventListener('abort', onAbort, { once: true });
    spawn.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

class CreateSubSessionInvocation extends BaseToolInvocation<
  CreateSubSessionParams,
  ToolResult
> {
  private destination?: SubSessionWorkspaceBinding;
  private approvedDestination?: SubSessionWorkspaceBinding;
  private automaticApprovalMode?: ApprovalMode;
  private permissionApprovalMode?: ApprovalMode;
  private requestedWorkspaceAsk = false;

  constructor(
    private config: Config,
    params: CreateSubSessionParams,
  ) {
    super(params);
  }

  getDescription(): string {
    const mode = this.params.completion ?? 'first-turn';
    // Sanitize: strip control chars / markdown-injection from user-controlled
    // label so the description can't break tool-call UI or prompt injection.
    const raw = this.params.name ?? this.params.prompt;
    // eslint-disable-next-line no-control-regex -- stripping C0 control chars
    const cleaned = raw.replace(/[\r\n\t\x00-\x1f]/g, ' ').trim();
    const label = cleaned.length > 80 ? cleaned.slice(0, 77) + '…' : cleaned;
    const workspace = this.destination?.workspaceCwd ?? this.params.workspace;
    const target = [
      this.params.sessionId
        ? `to ${JSON.stringify(this.params.sessionId)}`
        : undefined,
      workspace ? `in ${JSON.stringify(workspace)}` : undefined,
    ]
      .filter((part) => part !== undefined)
      .join(' ');
    return target ? `[${mode}] ${target}: ${label}` : `[${mode}] ${label}`;
  }

  /**
   * `create_sub_session` runs a model-authored prompt with full tool access in
   * a fresh session — the same privileged-sink shape as `cron_create`,
   * `send_message` and `task_create`, which all return `'ask'`. The L3 default
   * must NOT be `'allow'`: AUTO mode short-circuits before the L5 classifier
   * when `finalPermission === 'allow'`, and DEFAULT mode skips confirmation,
   * so the delegated prompt would never be reviewed. `'ask'` lets AUTO route
   * the call through the classifier, which resolves it without a human.
   */
  override async getDefaultPermission(
    abortSignal?: AbortSignal,
  ): Promise<PermissionDecision> {
    abortSignal?.throwIfAborted();
    if (this.params.workspace !== undefined) {
      const permissions = this.config.getPermissionManager?.();
      if (permissions) {
        const context = buildPermissionCheckContext(
          ToolNames.CREATE_SUB_SESSION,
          { ...this.params },
          this.config.getTargetDir?.() ?? '',
        );
        this.requestedWorkspaceAsk = permissions.hasMatchingAskRule(context);
        if (permissions.findMatchingDenyRule(context)) return 'ask';
      }
      await this.resolveDestination(abortSignal);
      this.permissionApprovalMode = this.config.getApprovalMode();
    }
    return 'ask';
  }

  override requiresAutoReviewOnAllow(): boolean {
    return (
      this.params.workspace !== undefined &&
      this.destination?.sameWorkspace !== true
    );
  }

  override requiresUserInteraction(): boolean {
    if (this.params.workspace === undefined) return false;
    const approvalMode = this.config.getApprovalMode();
    if (approvalMode === ApprovalMode.PLAN || this.requestedWorkspaceAsk) {
      return true;
    }
    if (this.destination?.sameWorkspace === true) return false;
    return !this.isYolo() && approvalMode !== ApprovalMode.AUTO;
  }

  private isYolo(): boolean {
    return this.config.getApprovalMode() === ApprovalMode.YOLO;
  }

  override async getConfirmationDetails(
    abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails> {
    if (this.params.workspace === undefined) {
      return super.getConfirmationDetails(abortSignal);
    }
    const destination = await this.resolveDestination(abortSignal);
    if (
      destination.sameWorkspace &&
      this.config.getApprovalMode() !== ApprovalMode.PLAN
    ) {
      const confirmation = await super.getConfirmationDetails(abortSignal);
      return {
        ...confirmation,
        onConfirm: async (outcome, payload) => {
          this.automaticApprovalMode = undefined;
          this.approvedDestination =
            outcome === ToolConfirmationOutcome.ProceedOnce ||
            outcome === ToolConfirmationOutcome.ProceedOnceAndSwitchToDefault
              ? destination
              : undefined;
          await confirmation.onConfirm(outcome, payload);
        },
      };
    }
    return {
      type: 'exec',
      title: this.getDescription(),
      command: this.params.prompt.trim(),
      approvalText:
        `Workspace: ${JSON.stringify(destination.workspaceCwd)}\n` +
        (this.params.sessionId
          ? `Session: ${JSON.stringify(this.params.sessionId)}\n`
          : '') +
        `\n${this.params.prompt.trim()}`,
      rootCommand: ToolNames.CREATE_SUB_SESSION,
      // A tool-wide rule cannot record which workspace the user approved.
      hideAlwaysAllow: true,
      permissionRules: [],
      onAutoConfirm: async (approvalMode) => {
        this.approvedDestination = destination;
        this.automaticApprovalMode = approvalMode;
      },
      onConfirm: async (outcome) => {
        this.automaticApprovalMode = undefined;
        this.approvedDestination =
          outcome === ToolConfirmationOutcome.ProceedOnce ||
          outcome === ToolConfirmationOutcome.ProceedOnceAndSwitchToDefault
            ? destination
            : undefined;
      },
    };
  }

  private async resolveDestination(
    abortSignal?: AbortSignal,
  ): Promise<SubSessionWorkspaceBinding> {
    abortSignal?.throwIfAborted();
    if (this.destination) {
      this.assertWorkspaceAllowed(this.destination);
      this.updateRequestedWorkspaceAsk(this.destination);
      return this.destination;
    }
    const resolveWorkspace = this.config.getSubSessionWorkspaceResolver();
    if (!resolveWorkspace) throw new Error(DAEMON_ONLY_MESSAGE);
    const destination = await resolveWorkspace(this.params.workspace!);
    abortSignal?.throwIfAborted();
    this.assertWorkspaceAllowed(destination);
    this.updateRequestedWorkspaceAsk(destination);
    this.destination = destination;
    return destination;
  }

  private updateRequestedWorkspaceAsk(
    destination: SubSessionWorkspaceBinding,
  ): void {
    const permissions = this.config.getPermissionManager?.();
    if (!permissions) {
      this.requestedWorkspaceAsk = false;
      return;
    }
    const selectors = new Set([
      this.params.workspace,
      destination.workspaceCwd,
      destination.workspaceId,
    ]);
    this.requestedWorkspaceAsk = [...selectors].some((workspace) => {
      if (workspace === undefined) return false;
      const context = buildPermissionCheckContext(
        ToolNames.CREATE_SUB_SESSION,
        { ...this.params, workspace },
        this.config.getTargetDir?.() ?? '',
      );
      return permissions.hasMatchingAskRule(context);
    });
  }

  private assertWorkspaceAllowed(
    destination: SubSessionWorkspaceBinding,
  ): void {
    const permissions = this.config.getPermissionManager?.();
    if (!permissions) return;

    // Rules apply to both the requested selector and the registered identity.
    const selectors = new Set([
      this.params.workspace,
      destination.workspaceCwd,
      destination.workspaceId,
    ]);
    for (const workspace of selectors) {
      const context = buildPermissionCheckContext(
        ToolNames.CREATE_SUB_SESSION,
        { ...this.params, workspace },
        this.config.getTargetDir?.() ?? '',
      );
      if (permissions.findMatchingDenyRule(context)) {
        throw new StructuredToolError(
          'This create_sub_session destination was denied by permission rules.',
          ToolErrorType.EXECUTION_DENIED,
        );
      }
    }
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const spawner = this.config.getSubSessionSpawner();
    if (!spawner) {
      return {
        llmContent: DAEMON_ONLY_MESSAGE,
        returnDisplay: 'Unavailable (daemon-only)',
        error: { message: DAEMON_ONLY_MESSAGE },
      };
    }

    const completion = this.params.completion ?? 'first-turn';
    const prompt = this.params.prompt.trim();
    const followUp = this.params.sessionId !== undefined;

    let requestStarted = false;

    try {
      if (this.params.workspace !== undefined && !this.destination) {
        await this.resolveDestination(signal);
      }
      const res = await raceCancellation(async () => {
        const approvedDestination = this.approvedDestination;
        this.approvedDestination = undefined;
        const approvalMode = this.config.getApprovalMode();
        this.permissionApprovalMode ??= approvalMode;
        const autoApproved =
          (approvalMode === ApprovalMode.AUTO &&
            this.permissionApprovalMode === ApprovalMode.AUTO) ||
          (approvalMode === ApprovalMode.YOLO &&
            (this.permissionApprovalMode === ApprovalMode.AUTO ||
              this.permissionApprovalMode === ApprovalMode.YOLO));
        const destination =
          approvalMode === ApprovalMode.PLAN
            ? undefined
            : (approvedDestination ??
              (this.destination?.sameWorkspace === true || autoApproved
                ? this.destination
                : undefined));
        const requiresYolo =
          approvalMode === ApprovalMode.YOLO &&
          autoApproved &&
          (approvedDestination === undefined ||
            this.automaticApprovalMode === ApprovalMode.YOLO);
        const requiresAutoMode =
          this.params.workspace !== undefined &&
          this.destination?.sameWorkspace !== true &&
          !requiresYolo &&
          (this.automaticApprovalMode === ApprovalMode.AUTO ||
            (approvedDestination === undefined &&
              autoApproved &&
              approvalMode === ApprovalMode.AUTO));
        const automaticApprovalMode = this.automaticApprovalMode;
        if (
          automaticApprovalMode !== undefined &&
          automaticApprovalMode !== approvalMode
        ) {
          this.approvedDestination = undefined;
          this.automaticApprovalMode = undefined;
          throw new StructuredToolError(
            'Approval mode changed before execution. Please retry.',
            ToolErrorType.EXECUTION_DENIED,
          );
        }
        this.automaticApprovalMode = undefined;
        if (this.params.workspace !== undefined && !destination) {
          throw new Error('A named workspace requires one-time approval.');
        }
        if (destination) this.assertWorkspaceAllowed(destination);
        requestStarted = true;
        return spawner({
          prompt,
          completion,
          ...(this.params.model ? { model: this.params.model } : {}),
          ...(this.params.name ? { name: this.params.name } : {}),
          ...(this.params.workspace !== undefined
            ? {
                workspace: this.params.workspace,
                workspaceGeneration: destination?.workspaceGeneration,
                ...(requiresYolo ? { requiresYolo: true } : {}),
                ...(requiresAutoMode ? { requiresAutoMode: true } : {}),
              }
            : {}),
          ...(this.params.sessionId
            ? { sessionId: this.params.sessionId }
            : {}),
        });
      }, signal);

      if (res === CANCELLED) {
        // Cancellation here stops the caller's wait. The daemon owns any
        // admitted prompt and its concurrency slot.
        const message = followUp
          ? requestStarted
            ? 'create_sub_session was cancelled. The follow-up prompt may already be queued and can still run.'
            : 'create_sub_session was cancelled before sending the follow-up.'
          : requestStarted
            ? 'create_sub_session was cancelled. A sub-session may already have ' +
              'been created; it runs independently and is not cancelled.'
            : 'create_sub_session was cancelled before it started. No ' +
              'sub-session was created.';
        return {
          llmContent: message,
          returnDisplay: 'Cancelled',
          // The turn was cancelled mid-flight, so the call never reported a
          // spawn result; the scheduler must not call it completed.
          interruptedBeforeCompletion: true,
        };
      }

      // Embed a clickable session link in the display output so the web shell
      // can render a "jump to session" button. The `qwen-session://` scheme is
      // intercepted by the markdown renderer and dispatched as a DOM event.
      const workspaceQuery = res.workspaceCwd
        ? `?${new URLSearchParams({ workspace: res.workspaceCwd })}`
        : '';
      const sessionLink = `[${res.sessionId.slice(0, 8)}](qwen-session://${res.sessionId}${workspaceQuery})`;

      // The sub-session exists and is linked in memory, but the daemon reported
      // that the parent lineage was NOT durably written to its transcript — so
      // the parent→child relationship will disappear from the persisted session
      // list after a daemon restart. Surface it (rather than reporting an
      // indistinguishable success) so the caller knows the link is degraded.
      const parentWarning =
        res.parentSessionPersisted === false
          ? ' Note: the parent-session link could not be persisted and is ' +
            'live-only — it will not survive a daemon restart.'
          : '';

      if (completion === 'sent') {
        // Fire-and-forget: report the id; the caller did not wait for a result.
        return {
          llmContent:
            `Sub-session ${sessionLink} ` +
            (followUp
              ? 'accepted the prompt into its queue. '
              : 'created and the prompt was dispatched. ') +
            'It runs independently — this call did not wait for a ' +
            `result.${parentWarning}`,
          returnDisplay: `${sessionLink} ${followUp ? 'queued' : 'started'}`,
        };
      }

      if (followUp && res.stopReason === 'timeout') {
        return {
          llmContent:
            `Timed out waiting for ${sessionLink}. The original prompt may still be queued or running.` +
            (res.result ? `\n\nPartial output:\n\n${res.result}` : '') +
            parentWarning,
          returnDisplay: `${sessionLink} timed out`,
        };
      }

      // first-turn: return the output of the turn this prompt started.
      const stop = res.stopReason ? ` (stopReason: ${res.stopReason})` : '';
      const body =
        res.result && res.result.length > 0
          ? res.result
          : `Sub-session ${sessionLink} completed its ` +
            `${followUp ? 'turn' : 'first turn'} but produced no text output.`;
      return {
        llmContent: `Sub-session ${sessionLink} ${followUp ? 'result' : 'first-turn result'}${stop}:\n\n${body}${parentWarning}`,
        returnDisplay: `${sessionLink} completed${stop}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        llmContent:
          this.params.sessionId !== undefined
            ? `Error sending to sub-session ${this.params.sessionId}: ${message}`
            : `Error creating sub-session: ${message}`,
        returnDisplay: message,
        error: {
          message,
          ...(error instanceof StructuredToolError
            ? { type: error.errorType }
            : {}),
        },
      };
    }
  }
}

export class CreateSubSessionTool extends BaseDeclarativeTool<
  CreateSubSessionParams,
  ToolResult
> {
  static readonly Name = ToolNames.CREATE_SUB_SESSION;

  constructor(private config: Config) {
    super(
      CreateSubSessionTool.Name,
      ToolDisplayNames.CREATE_SUB_SESSION,
      'Run a prompt in a separate sub-session. Omit `sessionId` to create ' +
        'a fresh session with its own context and transcript. Give a new ' +
        'sub-session a self-contained prompt.\n\n' +
        'ONLY available when running under `qwen serve` (daemon mode); it is ' +
        'not declared at all in plain interactive or headless sessions.\n\n' +
        '## Completion modes\n' +
        '- `first-turn` (default): waits for the turn started by this prompt ' +
        'and returns its result.\n' +
        '- `sent`: returns without waiting for the result. A follow-up ' +
        'returns once queued. When the sub-session runs in another workspace, or ' +
        'when you follow one up, you are told when it finishes, with its ' +
        'result. That result comes back on its own, so do not ask the ' +
        'sub-session to report back (for example with send_message).\n\n' +
        '## Another workspace\n' +
        'Set `workspace` to run the sub-session in another workspace ' +
        "registered with this daemon, with that workspace's own instructions, " +
        'skills and settings. A selector for the current workspace follows ' +
        'the ordinary permission flow; explicitly named workspaces stay ' +
        'blocked in Plan mode. Cross-workspace calls need one-time ' +
        'approval in default/auto-edit, use the classifier in auto, and are ' +
        'auto-approved in yolo; deny and explicit ask rules still apply. ' +
        'Both workspaces must be trusted; an unknown name is refused with ' +
        'the list of workspaces you can use.' +
        '\n\n' +
        '## Following up\n' +
        'Set `sessionId` to send the prompt to an existing session instead ' +
        "of creating a new one; it keeps that session's context. Any session " +
        'but this one can be named. The destination must support follow-ups ' +
        'and have a compatible approval mode. Also set `workspace` if it is ' +
        'in another workspace.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              'The prompt to run. Give a new sub-session all the context ' +
              "it needs. A follow-up can use the target session's prior turns.",
          },
          completion: {
            type: 'string',
            enum: ['sent', 'first-turn'],
            description:
              "'first-turn' (default) waits for this prompt's turn and " +
              "returns its result. 'sent' submits the prompt and returns " +
              'without waiting for the result.',
          },
          model: {
            type: 'string',
            description:
              'Optional model service id for the sub-session. Omit to use the ' +
              'default model. Must be a non-empty string of at most ' +
              `${MAX_CRON_TASK_ROUTING_ID_LENGTH} characters without control ` +
              'characters; the daemon rejects the call otherwise.',
          },
          name: {
            type: 'string',
            description:
              'Optional display name for the sub-session in the session list.',
          },
          workspace: {
            type: 'string',
            description:
              'Optional absolute path or id of another workspace registered ' +
              'with this daemon to run the sub-session in. Omit to use the ' +
              'current workspace.',
          },
          sessionId: {
            type: 'string',
            description:
              'Optional id of an existing session to send this prompt to ' +
              'instead of creating a new one. Cannot be combined ' +
              'with `model` or `name`.',
          },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
      true, // isOutputMarkdown
      false, // canUpdateOutput
      true, // shouldDefer — spawning is infrequent
      false, // alwaysLoad
      'sub-session spawn delegate fan-out isolated session',
    );
  }

  protected createInvocation(
    params: CreateSubSessionParams,
  ): ToolInvocation<CreateSubSessionParams, ToolResult> {
    return new CreateSubSessionInvocation(this.config, params);
  }

  protected override validateToolParamValues(
    params: CreateSubSessionParams,
  ): string | null {
    if (!params.prompt || params.prompt.trim() === '') {
      return 'Parameter "prompt" must be a non-empty string.';
    }
    if (params.prompt.length > MAX_SUB_SESSION_PROMPT_CHARS) {
      return `Parameter "prompt" exceeds the ${MAX_SUB_SESSION_PROMPT_CHARS}-character limit.`;
    }
    if (
      params.completion !== undefined &&
      params.completion !== 'sent' &&
      params.completion !== 'first-turn'
    ) {
      return 'Parameter "completion" must be "sent" or "first-turn".';
    }
    // Mirror the daemon's boundary check so the model gets the rejection
    // here, with the limit, instead of as an opaque spawn failure.
    if (params.model !== undefined && !isValidCronTaskRoutingId(params.model)) {
      return `Parameter "model" must be a non-empty string of at most ${MAX_CRON_TASK_ROUTING_ID_LENGTH} characters without control characters.`;
    }
    if (
      params.workspace !== undefined &&
      !isValidWorkspaceSelector(params.workspace)
    ) {
      return `Parameter "workspace" must be a non-empty string of at most ${MAX_SUB_SESSION_WORKSPACE_CHARS} characters without control characters.`;
    }
    if (
      params.sessionId !== undefined &&
      !isValidCronTaskRoutingId(params.sessionId)
    ) {
      return `Parameter "sessionId" must be a non-empty string of at most ${MAX_CRON_TASK_ROUTING_ID_LENGTH} characters without control characters.`;
    }
    if (
      params.sessionId !== undefined &&
      (params.model !== undefined || params.name !== undefined)
    ) {
      return 'Parameters "model" and "name" apply to a new sub-session and cannot be combined with "sessionId".';
    }
    return null;
  }

  /**
   * Surface the delegated prompt + mode to the AUTO classifier. The sub-session
   * executes this prompt with tool access, so it must face the same scrutiny as
   * a direct command — without this the classifier sees `create_sub_session({})`
   * and is blind to what the sub-session will be asked to do.
   */
  override toAutoClassifierInput(
    params: CreateSubSessionParams,
  ): Record<string, unknown> {
    return {
      prompt: params.prompt,
      completion: params.completion ?? 'first-turn',
      ...(params.model ? { model: params.model } : {}),
      ...(params.workspace ? { workspace: params.workspace } : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    };
  }
}

function isValidWorkspaceSelector(value: string): boolean {
  return (
    value.trim().length > 0 &&
    value.length <= MAX_SUB_SESSION_WORKSPACE_CHARS &&
    // eslint-disable-next-line no-control-regex -- rejecting C0 control chars
    !/[\x00-\x1f\x7f]/.test(value)
  );
}
