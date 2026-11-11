/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The TUI's permission channel.
 *
 * Two jobs meet here. `askHandler` is what the permission module calls, and it
 * blocks until the prompt is settled; the store is what React reads, and it has
 * to hand out a fresh array reference on every change for `useSyncExternalStore`
 * to notice.
 *
 * Racing, rechecks and teardown all live in `createAskHandler`. What is left here
 * is the queue itself and the three things a user can do to a prompt.
 */

import type { PermissionMode } from '@qwen-code/core';
import {
  createAskHandler,
  withPermissionRequestHook,
  REPEATED_TOOL_CALL_PERMISSION_KIND,
  type AskMetricsStore,
  type AskPresenter,
  type AskPrompt,
  type AskSettlement,
  type ConfirmContinuation,
  type ContinuationDecision,
  type ContinuationRequest,
  type HostAskHandler,
  type PermissionRequestHookBridge,
  type PermissionUpdate,
  type SerializableConfirmationDetails,
} from '@qwen-code/core';
import { randomUUID } from 'node:crypto';

/** Listener callback for queue changes. */
export type QueueChangeListener = () => void;

/**
 * MCP prompts carry a tool rule and a server wildcard. The TUI's "always
 * allow" option is labelled for the tool, so remembering it must not silently
 * grant the whole server.
 */
function suggestionsToRemember(prompt: AskPrompt): PermissionUpdate[] {
  const inputToolName = prompt.input['toolName'];
  const target = prompt.toolName.startsWith('mcp__')
    ? prompt.toolName
    : typeof inputToolName === 'string' && inputToolName.startsWith('mcp__')
      ? inputToolName
      : undefined;
  const suggestions = prompt.suggestions ?? [];
  if (!target) {
    return suggestions.length > 0
      ? suggestions
      : [
          {
            type: 'addRules',
            destination: 'session',
            rules: [{ toolName: prompt.toolName }],
            behavior: 'allow',
          },
        ];
  }

  const exact = suggestions.filter(
    (suggestion) =>
      suggestion.type === 'addRules' &&
      suggestion.rules.length === 1 &&
      suggestion.rules[0]?.toolName === target,
  );
  if (exact.length > 0) return exact;

  const destination =
    suggestions.find((suggestion) => suggestion.type === 'addRules')
      ?.destination ?? 'localSettings';
  return [
    {
      type: 'addRules',
      destination,
      rules: [{ toolName: target }],
      behavior: 'allow',
    },
  ];
}

/**
 * A prompt on screen, and the three ways it can end.
 *
 * `input` is the projection the check supplied when it supplied one, so it is the
 * only thing the UI may render. Rendering the raw tool input would show a
 * model-authored answer as though it were the user's own.
 */
export interface QueuedPermissionPrompt extends AskPrompt {
  /**
   * A render payload built elsewhere, when the queue cannot build one itself.
   *
   * Proxied prompts — the remote controller asking on the worker's behalf —
   * carry it from the wire. The worker's tools need not exist in the local
   * registry (an MCP server only the worker talks to, a host-only tool), so
   * rebuilding the details locally would mis-render or fail outright; the
   * details the other side supplied are the ones to show. Absent for prompts
   * the local module raised — the renderer builds those from its own registry.
   */
  readonly confirmationDetails?: SerializableConfirmationDetails;

  /**
   * The user allowed it. `scope` says how long they mean it for when they picked
   * an "always allow" option — the store reports it together with the prompt's
   * full suggestion list, and the host maps the scope onto every suggestion (the
   * mode change appended at the end included); both halves of that write — the
   * settings file and the module's rules — are the host's business, which is why
   * the store only reports it.
   *
   * `input` is the call as the approver wants it to run. AskUserQuestion needs it:
   * the answer the dialog collected *is* the amendment. The module re-runs the tool
   * check against it before the approval stands, so amending on approval is not a
   * way around the rules that produced the prompt.
   */
  approve(options?: {
    scope?: 'session' | 'persist';
    input?: Record<string, unknown>;
  }): void;

  /**
   * The user refused. `reason` is what they typed when they refused with a
   * message, and it reaches the model as the denial message; absent, the
   * refusal is bare.
   */
  reject(reason?: string): void;

  /** Nobody answered — escape, or the turn was interrupted. Not a refusal. */
  abort(): void;
}

export interface PermissionQueueStore {
  /** The handler to install on the permission module. */
  readonly askHandler: HostAskHandler;

  /**
   * Show a prompt whose judgement happened elsewhere (remote worker), returning
   * a disposer that removes it. A proxied prompt carries a correlation id and
   * cannot be re-judged locally; everything raised locally goes through
   * `askHandler`.
   */
  presentProxied(
    prompt: AskPrompt,
    settlements: {
      approve(input?: Record<string, unknown>, scope?: 'session' | 'persist'): void;
      reject(): void;
      abort(): void;
    },
    confirmationDetails?: SerializableConfirmationDetails,
  ): () => void;

  /** Current queue. Stable reference until something changes. */
  getSnapshot(): readonly QueuedPermissionPrompt[];

  /** One prompt, by tool-use id. */
  getById(toolUseId: string): QueuedPermissionPrompt | undefined;

  /** Subscribe to queue changes. Returns an unsubscribe function. */
  subscribe(listener: QueueChangeListener): () => void;

  readonly size: number;
}

export interface PermissionQueueStoreOptions {
  /**
   * Called when the user asks to remember a choice, just before the prompt
   * settles. Receives the approval scope and the prompt's full suggestion list:
   * every suggestion the scope implies has to be remembered — the path rule is
   * not the whole of it (a write-tool prompt appends its mode change at the end,
   * an MCP prompt carries the server wildcard second).
   *
   * The store does not write settings itself: persisting has to happen in the
   * same place that updates the module's rules, or the two drift. Left out,
   * "always allow" behaves as a one-off approval.
   */
  onRemember?: (
    scope: 'session' | 'persist',
    suggestions: PermissionUpdate[] | undefined,
  ) => void;

  /**
   * Lets a PermissionRequest hook answer a prompt before the dialog is shown.
   * Absent (the default) the dialog is always presented. The TUI installs this
   * from the live Config so automation can allow or deny — and write rule changes
   * — without a human ever seeing the prompt.
   */
  hookBridge?: PermissionRequestHookBridge;

  /**
   * Runs when a prompt is actually shown; notifies the
   * `Notification/permission_prompt` event.
   */
  onPromptShown?: (prompt: AskPrompt) => void;

  /**
   * The permission mode right now, live. A recheck's deny settles a dialog
   * only in modes that never prompt; anywhere else the dialog stands.
   */
  getCurrentMode?: () => PermissionMode | undefined;

  /**
   * The session's ask-facts store, where a settlement's winner is recorded for
   * the execution gate to read. Absent (tests, hosts with no config) nothing is
   * recorded and the prompt still works.
   */
  askMetrics?: AskMetricsStore;
}

export function createPermissionQueueStore(
  options: PermissionQueueStoreOptions = {},
): PermissionQueueStore {
  const items: QueuedPermissionPrompt[] = [];
  let snapshot: readonly QueuedPermissionPrompt[] = [];
  const listeners = new Set<QueueChangeListener>();

  /**
   * Fold the settlement into the ask-metrics side channel, keyed by tool-use id,
   * the instant the human answers — before `settle` resolves the check, so the
   * value is present when the gate reads it. Recheck-won prompts never reach
   * here (their teardown runs instead), which is correct: that decision is
   * `toolCheck`, not `ask`, and consumes nothing.
   */
  function recordSettlement(toolUseId: string): void {
    options.askMetrics?.record(toolUseId, { winnerParty: 'prompt' });
  }

  function notify(): void {
    // New array reference, or React sees nothing.
    snapshot = [...items];
    for (const listener of listeners) {
      listener();
    }
  }

  function removeById(toolUseId: string): void {
    const index = items.findIndex((item) => item.toolUseId === toolUseId);
    if (index !== -1) {
      items.splice(index, 1);
      notify();
    }
  }

  function enqueue(
    prompt: AskPrompt,
    settle: (result: AskSettlement) => void,
  ): void {
    items.push({
      ...prompt,
      approve(options_) {
        // A prompt that must not be remembered (a catastrophic-removal finding)
        // is approved once whatever scope the dialog reported.
        if (options_?.scope && prompt.persistable !== false) {
          options.onRemember?.(
            options_.scope,
            suggestionsToRemember(prompt),
          );
        }
        recordSettlement(prompt.toolUseId);
        settle({
          kind: 'approved',
          ...(options_?.input ? { input: options_.input } : {}),
        });
      },
      reject(reason_) {
        recordSettlement(prompt.toolUseId);
        settle({ kind: 'rejected', ...(reason_ ? { reason: reason_ } : {}) });
      },
      abort() {
        recordSettlement(prompt.toolUseId);
        settle({ kind: 'aborted' });
      },
    });
    notify();
  }

  const presenter: AskPresenter = {
    present(prompt, settle) {
      enqueue(prompt, settle);
      // Teardown runs however the judgement ended, including when a recheck
      // settled it — which is the case that has to take a prompt off screen that
      // the user never answered.
      return () => removeById(prompt.toolUseId);
    },

    refresh(prompt) {
      const index = items.findIndex(
        (item) => item.toolUseId === prompt.toolUseId,
      );
      if (index === -1) {
        return;
      }
      // Replaced in place, keeping the callbacks: they close over this
      // judgement's one settle function, and the queue position must not jump
      // while the user is looking at it. Suggestions follow the fresh check
      // wholesale: one that no longer offers them must not leave stale
      // "always allow" options the new check no longer stands behind.
      items[index] = {
        ...items[index],
        reason: prompt.reason,
        input: prompt.input,
        skippable: prompt.skippable,
        persistable: prompt.persistable,
        suggestions: prompt.suggestions,
      };
      notify();
    },
  };

  // A PermissionRequest hook, when wired, races the dialog: the prompt shows
  // immediately and whichever settles first wins. With no bridge the presenter
  // is used as-is.
  const askHandler = createAskHandler(
    options.hookBridge
      ? withPermissionRequestHook(presenter, options.hookBridge)
      : presenter,
    {
      onPromptShown: options.onPromptShown,
      getCurrentMode: options.getCurrentMode,
      getAskMetrics: () => options.askMetrics,
    },
  );

  return {
    askHandler,

    presentProxied(prompt, settlements, confirmationDetails) {
      items.push({
        ...prompt,
        ...(confirmationDetails ? { confirmationDetails } : {}),
        approve(options_) {
          // A remembered choice travels to the worker inside the outcome, so
          // there is nothing to write locally — the rules live over there.
          settlements.approve(options_?.input, options_?.scope);
        },
        reject: settlements.reject,
        abort: settlements.abort,
      });
      notify();
      return () => removeById(prompt.toolUseId);
    },

    getSnapshot(): readonly QueuedPermissionPrompt[] {
      return snapshot;
    },

    getById(toolUseId: string): QueuedPermissionPrompt | undefined {
      return items.find((item) => item.toolUseId === toolUseId);
    },

    subscribe(listener: QueueChangeListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    get size(): number {
      return items.length;
    },
  };
}

/**
 * The TUI's half of the continuation-confirmation seam.
 *
 * The doom-loop guard calls this instead of raising a permission check: the
 * question it asks ("keep going?") is not a rule's finding, so no checker owns
 * it. The prompt rides the same queue and dialog as an ordinary permission
 * prompt — the body, options and focus handling all key off the
 * `repeated_tool_call` details — and the answer maps back onto the guard's
 * three outcomes.
 */
export function createContinuationPresenter(
  store: PermissionQueueStore,
): ConfirmContinuation {
  return (request: ContinuationRequest): Promise<ContinuationDecision> => {
    const toolUseId = randomUUID();
    return new Promise<ContinuationDecision>((resolve) => {
      let settled = false;

      const teardown = store.presentProxied(
        {
          toolUseId,
          toolName: request.toolName,
          input: {},
          reason: {
            message: request.title,
            attribution: { type: 'mode', mode: 'default' },
          },
          skippable: true,
        },
        {
          approve(_input, scope) {
            if (settled) {
              return;
            }
            settled = true;
            teardown();
            resolve(
              scope === 'session'
                ? { outcome: 'session' }
                : { outcome: 'once' },
            );
          },
          reject() {
            if (settled) {
              return;
            }
            settled = true;
            teardown();
            resolve({ outcome: 'deny' });
          },
          abort() {
            if (settled) {
              return;
            }
            settled = true;
            teardown();
            resolve({ outcome: 'deny', reason: 'aborted' });
          },
        },
        {
          type: REPEATED_TOOL_CALL_PERMISSION_KIND,
          title: request.title,
          toolName: request.toolName,
          repeatCount: request.repeatCount,
          threshold: request.threshold,
          inputPreview: request.inputPreview ?? '',
        },
      );

      // The turn going away must take the prompt with it.
      const onAbort = () => {
        if (settled) {
          return;
        }
        settled = true;
        teardown();
        resolve({ outcome: 'deny', reason: 'aborted' });
      };
      if (request.signal) {
        if (request.signal.aborted) {
          onAbort();
          return;
        }
        request.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  };
}
