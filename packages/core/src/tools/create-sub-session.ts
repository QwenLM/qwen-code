/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `create_sub_session` tool — spawns a FRESH top-level sub-session (a sibling
 * of the current session, its own transcript) and runs a prompt in it.
 *
 * Daemon-only: it works only when running under `qwen serve`, where the ACP
 * session wires a {@link SubSessionSpawner} that routes the request to the
 * daemon bridge (`spawnOrAttach` + `sendPrompt`). In interactive TUI / headless
 * there is no bridge, so no spawner is wired and the tool reports itself
 * unavailable.
 *
 * Two completion modes:
 *  - `'sent'`      — resolve as soon as the prompt is dispatched (fire-and-
 *                    forget); the sub-session keeps running independently.
 *  - `'first-turn'`— wait for the sub-session's first turn to finish and return
 *                    its result to the caller (default).
 */

import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { Config } from '../config/config.js';
import type { PermissionDecision } from '../permissions/types.js';

export interface CreateSubSessionParams {
  prompt: string;
  completion?: 'sent' | 'first-turn';
  model?: string;
  name?: string;
}

const DAEMON_ONLY_MESSAGE =
  'create_sub_session is only available when running under `qwen serve` ' +
  '(daemon mode). There is no session bridge in this environment, so a ' +
  'sub-session cannot be spawned.';

/** Ceiling on the delegated prompt. Mirrors the scheduled-task REST route's
 * `MAX_PROMPT_LENGTH`: both hand a model-authored prompt to a fresh session, so
 * they cap it the same way. Rejected here (a clear tool error the model can act
 * on) as well as at the bridge boundary, which cannot trust this side. */
export const MAX_SUB_SESSION_PROMPT_CHARS = 100_000;

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
    return `[${mode}] ${label}`;
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
  override async getDefaultPermission(): Promise<PermissionDecision> {
    return 'ask';
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

    // Set only once the spawn actually starts, which tells the two cancellation
    // outcomes apart: a turn cancelled before `execute` ran leaves nothing
    // behind, while one cancelled mid-flight may have created a sub-session.
    let spawnStarted = false;

    try {
      const res = await raceCancellation(() => {
        spawnStarted = true;
        return spawner({
          prompt,
          completion,
          ...(this.params.model ? { model: this.params.model } : {}),
          ...(this.params.name ? { name: this.params.name } : {}),
        });
      }, signal);

      if (res === CANCELLED) {
        // Return the caller's turn to it immediately. A sub-session that DID
        // start is NOT cancelled — `sendPrompt` has no abort seam — so it keeps
        // running and keeps its concurrency slot until its own turn drains.
        // Freeing the slot here would let the caller over-admit against a
        // sub-session that is still consuming a bridge session and model quota.
        const message = spawnStarted
          ? 'create_sub_session was cancelled. A sub-session may already have ' +
            'been created; it runs independently and is not cancelled.'
          : 'create_sub_session was cancelled before it started. No ' +
            'sub-session was created.';
        return { llmContent: message, returnDisplay: 'Cancelled' };
      }

      // Embed a clickable session link in the display output so the web shell
      // can render a "jump to session" button. The `qwen-session://` scheme is
      // intercepted by the markdown renderer and dispatched as a DOM event.
      const sessionLink = `[🧵 ${res.sessionId.slice(0, 8)}](qwen-session://${res.sessionId})`;

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
            `Sub-session ${sessionLink} created and the prompt was ` +
            'dispatched. It runs independently — this call did not wait for a ' +
            `result.${parentWarning}`,
          returnDisplay: `${sessionLink} started`,
        };
      }

      // first-turn: return the sub-session's first-turn output to the caller.
      const stop = res.stopReason ? ` (stopReason: ${res.stopReason})` : '';
      const body =
        res.result && res.result.length > 0
          ? res.result
          : `Sub-session ${sessionLink} completed its first turn but ` +
            'produced no text output.';
      return {
        llmContent: `Sub-session ${sessionLink} first-turn result${stop}:\n\n${body}${parentWarning}`,
        returnDisplay: `${sessionLink} completed${stop}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Error creating sub-session: ${message}`,
        returnDisplay: message,
        error: { message },
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
      'Spawn a fresh, independent sub-session (its own clean context and ' +
        'transcript) and run a prompt in it. Use to fan work out into a ' +
        'separate session — e.g. a self-contained sub-task you want isolated ' +
        'from this conversation.\n\n' +
        'ONLY available when running under `qwen serve` (daemon mode); it is ' +
        'inert in a plain interactive session.\n\n' +
        '## Completion modes\n' +
        "- `first-turn` (default): waits for the sub-session's first turn to " +
        'finish and returns its result to you. Use when you need the answer ' +
        'back.\n' +
        '- `sent`: returns immediately after dispatching the prompt, without ' +
        'waiting. Use for fire-and-forget launches whose output you do not ' +
        'need inline.\n\n' +
        'The sub-session runs the prompt with full tool access, starting from ' +
        'zero context — brief it completely in `prompt` (it cannot see this ' +
        'conversation).',
      Kind.Other,
      {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              'The full, self-contained prompt to run in the new sub-session. ' +
              'It starts with no context from this conversation, so include ' +
              'everything it needs.',
          },
          completion: {
            type: 'string',
            enum: ['sent', 'first-turn'],
            description:
              "'first-turn' (default) waits for the sub-session's first turn " +
              "and returns its result. 'sent' returns immediately after the " +
              'prompt is dispatched (fire-and-forget).',
          },
          model: {
            type: 'string',
            description:
              'Optional model service id for the sub-session. Omit to use the ' +
              'default model.',
          },
          name: {
            type: 'string',
            description:
              'Optional display name for the sub-session in the session list.',
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
    };
  }
}
