/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Turns a channel's prompt into an ask handler.
 *
 * Five channels share four requirements: settle exactly once across user,
 * recheck and cancellation; consume rechecks without re-prompting; render the
 * projected input rather than the raw input; and always clean up the listener,
 * abort hook and dialog. Channels only supply prompt presentation.
 */

import type { AskHandleResult } from '../manager/decision/index.js';
import { PermissionModes, type PermissionMode } from '../manager/decision/index.js';
import { runLogger } from '../../utils/runLogger.js';
import type { SessionPermissionManager } from '../manager/session-permission-manager.js';
import {
  applyUpdatesToRules,
  persistPermissionUpdates,
  updatesForApprovalScope,
} from '../settings/persist-permission-update.js';
import type { SettingsWriter } from '../settings/permissionsLoader.js';
import type {
  HostAskHandler,
  PermissionUpdate,
  ToolPermissionExtra,
  ToolPermissionReason,
} from '../../tools/tool-checkers/checker-reasons.js';
import { isUnskippable } from '../../tools/tool-checkers/mode-layer.js';
import {
  isBypassImmune,
  isManagedAsk,
} from '../../tools/tool-checkers/rule-precedence.js';
import type { ToolCheckResult } from '../manager/decision/index.js';
import type { AskMetricsStore } from './ask-facts.js';

type HostCheckResult = ToolCheckResult<
  ToolPermissionReason,
  ToolPermissionExtra,
  PermissionUpdate
>;

/** How the user answered. `aborted` is not a refusal — nobody answered. */
export type AskSettlement = AskHandleResult;

/** What a channel needs in order to draw a prompt. */
export interface AskPrompt {
  /** Identifies the call, and therefore the prompt, across recheck refreshes. */
  readonly toolUseId: string;
  readonly agentId?: string;
  readonly toolName: string;
  /**
   * What the prompt may display. Already projected — see `promptForCheck`.
   */
  readonly input: Record<string, unknown>;
  /** Prompt copy and attribution. */
  readonly reason: ToolPermissionReason;
  /** "Always allow" candidates the prompt can offer, if the check had any. */
  readonly suggestions?: PermissionUpdate[];
  /**
   * Whether a mode change may settle this prompt on the user's behalf.
   *
   * False for the asks whose whole purpose is the prompt: what the dialog
   * collects has no other source, so approving it automatically would invent an
   * answer the user never gave.
   */
  readonly skippable: boolean;
  /**
   * Whether an "always allow" option makes sense for this prompt.
   *
   * False for a catastrophic finding: no rule should cover `rm -rf ~`, so the
   * channels hide the persist option and remember nothing if one is chosen
   * anyway. Absent means yes.
   */
  readonly persistable?: boolean;
}

/** A channel's way of showing a prompt and hearing back. */
export interface AskPresenter {
  /**
   * Show the prompt. Call `settle` when the user answers.
   *
   * Returns a teardown function, called exactly once however the judgement ends —
   * including when something other than the user settled it, which is the case
   * that has to remove a prompt the user never answered.
   */
  present(
    prompt: AskPrompt,
    settle: (result: AskSettlement) => void,
  ): () => void;

  /**
   * A fresh check result arrived and it still says ask. The options may have
   * changed, so the prompt should be redrawn. Optional: a channel with no
   * options to redraw can ignore it.
   */
  refresh?(prompt: AskPrompt): void;
}

/**
 * Channel-level side wiring for the ask handler.
 *
 * `onPromptShown` runs at the moment the prompt is actually shown — the place
 * the old pipeline fired `Notification/permission_prompt` from. A hook that
 * settles the ask first means no prompt is shown, so this does not fire then.
 */
export interface AskHandlerOptions {
  onPromptShown?: (prompt: AskPrompt) => void;
  /**
   * The mode right now, live. A recheck's deny settles the prompt only in
   * modes that never prompt (auto, dontAsk); anywhere else the prompt stands,
   * so a rule written while the user is deciding cannot dismiss the dialog.
   */
  getCurrentMode?: () => PermissionMode | undefined;
  /**
   * The session's ask-facts store, live. A getter rather than the store itself
   * because one install site builds its handler in a class field initializer,
   * before the config it would read the store from exists.
   */
  getAskMetrics?: () => AskMetricsStore | undefined;
}

/**
 * Build the prompt a check result deserves.
 *
 * `extra.promptInput` wins over the real input when it is present, and that is a
 * safety rule rather than a preference. A tool whose input the model can
 * pre-fill — the question tool, which carries the answers themselves — must not
 * have that input displayed as though the user had chosen it. The check supplies
 * the projection precisely because the handler cannot tell the difference by
 * looking.
 */
export function promptForCheck(
  result: Extract<HostCheckResult, { kind: 'ask' }>,
  call: {
    toolUseId: string;
    agentId?: string;
    toolName: string;
    input: Record<string, unknown>;
  },
): AskPrompt {
  const prompt: AskPrompt = {
    toolUseId: call.toolUseId,
    agentId: call.agentId,
    toolName: call.toolName,
    input: result.extra?.promptInput ?? call.input,
    reason: result.reason,
    ...(result.suggestions ? { suggestions: result.suggestions } : {}),
    skippable: !isUnskippable(result) && !isBypassImmune(result),
    persistable: !isBypassImmune(result) && !isManagedAsk(result),
  };
  runLogger.log(
    `[permission-ask] prompt tool=${prompt.toolName} id=${prompt.toolUseId} ` +
      `message="${prompt.reason.message}" attribution=${prompt.reason.attribution.type} ` +
      `skippable=${prompt.skippable} persistable=${prompt.persistable} inputKeys=[${Object.keys(prompt.input).join(',')}] ` +
      `options=[${(prompt.suggestions ?? [])
        .map((s) => `${s.type}:${s.destination ?? ''}`)
        .join(',')}]`,
  );
  return prompt;
}

/**
 * An ask handler for one channel.
 *
 * The returned handler resolves when the judgement is settled and never throws:
 * a presenter that throws is treated as "nobody answered", because a channel
 * failing is not the user refusing.
 */
export function createAskHandler(
  presenter: AskPresenter,
  options?: AskHandlerOptions,
): HostAskHandler {
  return async (ctx) => {
    const first = ctx.toolCheckResult;
    if (first.kind !== 'ask') {
      // The module only calls a handler for an ask; anything else is a bug
      // upstream, and approving on a result we did not read would be worse.
      return { kind: 'rejected' };
    }

    const call = {
      toolUseId: ctx.toolUseId,
      agentId: ctx.agentId,
      toolName: ctx.toolName,
      input: ctx.input,
    };

    let settled = false;
    let teardown: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    let onAbort: (() => void) | undefined;

    return await new Promise<AskSettlement>((resolve) => {
      const settle = (result: AskSettlement): void => {
        if (settled) {
          return;
        }
        settled = true;

        runLogger.log(
          `[permission-ask] settle tool=${call.toolName} id=${call.toolUseId} ` +
            `result=${result.kind}` +
            (result.kind === 'approved' && result.input
              ? ` amendedInputKeys=[${Object.keys(result.input).join(',')}]`
              : '') +
            (result.kind === 'rejected' && result.reason
              ? ` reason="${result.reason}"`
              : ''),
        );

        // Unhook before resolving: a listener that fires during teardown must
        // not reach a settled promise.
        unsubscribe?.();
        if (onAbort) {
          ctx.signal?.removeEventListener('abort', onAbort);
        }
        try {
          teardown?.();
        } catch {
          // A channel failing to take its prompt down cannot change the answer.
        }

        resolve(result);
      };

      if (ctx.signal?.aborted) {
        settle({ kind: 'aborted' });
        return;
      }

      if (ctx.signal) {
        onAbort = () => settle({ kind: 'aborted' });
        ctx.signal.addEventListener('abort', onAbort, { once: true });
      }

      unsubscribe = ctx.onToolCheckResult((result) => {
        const fresh = result as HostCheckResult;
        if (fresh.kind === 'allow') {
          // A recheck settling the prompt is its own winner party: without
          // this the execution gate cannot tell a recheck's allow from an
          // ask nobody answered.
          options?.getAskMetrics?.()?.record(call.toolUseId, {
            winnerParty: 'recheck',
          });
          settle({ kind: 'approved' });
          return;
        }
        if (fresh.kind === 'deny') {
          // A recheck's deny settles the prompt only in non-prompting modes
          // (auto, dontAsk); elsewhere the prompt stands so a rule written
          // mid-decision cannot dismiss the dialog.
          const mode = options?.getCurrentMode?.();
          if (
            mode !== undefined &&
            mode !== PermissionModes.Auto &&
            mode !== PermissionModes.DontAsk
          ) {
            return;
          }
          // The recheck's own denial wording (a mode switch refusing a pending
          // prompt, a rule written elsewhere) is the true account of why the
          // call did not run — carry it so it lands as the denialMessage
          // instead of being lost to the original ask wording downstream.
          const recheckReason = fresh.extra?.denialReason?.message;
          options?.getAskMetrics?.()?.record(call.toolUseId, {
            winnerParty: 'recheck',
          });
          settle({
            kind: 'rejected',
            ...(recheckReason ? { reason: recheckReason } : {}),
          });
          return;
        }
        presenter.refresh?.(promptForCheck(fresh, call));
      });

      const prompt = promptForCheck(first, call);
      try {
        options?.onPromptShown?.(prompt);
      } catch {
        // A notification failing cannot change the answer the user gives.
      }
      try {
        teardown = presenter.present(prompt, settle);
      } catch {
        settle({ kind: 'aborted' });
      }
    });
  };
}

/**
 * Remember an approval, in both the places it has to be remembered.
 *
 * "Always allow" means two writes that must not drift: the settings file, so it
 * survives a restart, and the module's live rules, so the very next call in this
 * turn already sees it. The module deliberately does not write settings and the
 * settings layer deliberately does not judge, so something has to do both — and
 * it should be one function rather than five channels each doing it slightly
 * differently.
 *
 * Mode and directory changes ride along because a prompt option can carry them
 * ("accept edits from now on", "trust this folder").
 */
export function rememberApproval(params: {
  permission: SessionPermissionManager;
  scope: 'once' | 'session' | 'persist' | 'cancel';
  suggestions: PermissionUpdate[] | undefined;
  /** Absent in tests and in hosts with nowhere to write. */
  settingsWriter?: SettingsWriter;
  /** Mode changes go through the host, which owns their side effects. */
  onModeChange?: (mode: PermissionMode) => void;
}): void {
  const updates = updatesForApprovalScope(params.scope, params.suggestions);
  if (!updates || updates.length === 0) {
    runLogger.log(
      `[permission-ask] remember scope=${params.scope} → no updates to apply`,
    );
    return;
  }

  runLogger.log(
    `[permission-ask] remember scope=${params.scope} updates=[${updates
      .map((u) => {
        if (u.type === 'addRules') {
          return `addRules(${u.behavior}:${u.rules
            .map((r) => r.toolName)
            .join('|')}→${u.destination})`;
        }
        if (u.type === 'setMode') {
          return `setMode(${u.mode}→${u.destination})`;
        }
        return `${u.type}(→${u.destination})`;
      })
      .join(', ')}] persist=${params.settingsWriter ? 'yes' : 'no'}`,
  );

  if (params.settingsWriter) {
    persistPermissionUpdates(updates, params.settingsWriter);
  }

  const applied = applyUpdatesToRules(params.permission.getRules(), updates);
  params.permission.setRules(applied.rules);

  if (applied.mode) {
    // Through the host: a mode switch rebuilds the tool set, and
    // the module knows nothing about either.
    runLogger.log(`[permission-ask] remember → mode change to ${applied.mode}`);
    params.onModeChange?.(applied.mode);
  }

  if (
    applied.addedDirectories.length > 0 ||
    applied.removedDirectories.length > 0
  ) {
    runLogger.log(
      `[permission-ask] remember → dirs +[${applied.addedDirectories.join(',')}] ` +
        `-[${applied.removedDirectories.join(',')}]`,
    );
    const removed = new Set(applied.removedDirectories);
    params.permission.setAdditionalDirectories([
      ...params.permission
        .getAdditionalDirectories()
        .filter((dir) => !removed.has(dir)),
      ...applied.addedDirectories,
    ]);
  }
}

// ---------------------------------------------------------------------------
// PermissionRequest hook integration
// ---------------------------------------------------------------------------

/**
 * A PermissionRequest hook's verdict. Structurally identical to the host hook
 * system's `HookPermissionDecision`, but kept as a local shape so this file does
 * not depend on the hooks module (which would invert the layering).
 */
export interface PermissionRequestHookVerdict {
  behavior: 'allow' | 'deny';
  /** The call as the hook wants it to run, when it amended the arguments. */
  updatedInput?: Record<string, unknown>;
  /** Rule changes the hook wants applied and remembered. */
  updatedPermissions?: PermissionUpdate[];
  message?: string;
  /** On a deny, stop the current turn. */
  interrupt?: boolean;
}

/**
 * What a host supplies so a PermissionRequest hook can answer a prompt before any
 * human or channel is asked.
 *
 * Automation uses this to allow or deny programmatically and, on allow, to write
 * rule changes at the same time — the `updatedPermissions` half that this task
 * restores. A verdict of `undefined` means "no opinion": no hook system, the hook
 * produced nothing, or it declined to decide, and the prompt is shown as usual.
 */
export interface PermissionRequestHookBridge {
  getVerdict(params: {
    toolName: string;
    input: Record<string, unknown>;
    suggestions: PermissionUpdate[] | undefined;
    /** Aborted once the hook's answer is no longer wanted; stops a running hook. */
    signal?: AbortSignal;
  }): Promise<PermissionRequestHookVerdict | undefined>;

  /** The module an allow's rule updates land on. */
  permission: SessionPermissionManager;
  /**
   * The session's ask-facts store, where a hook win is recorded. Required, like
   * `permission`: every bridge is built from a config that has one.
   */
  askMetrics: AskMetricsStore;
  /** Where persistent rule writes go. Absent in tests and hosts with no disk. */
  settingsWriter?: SettingsWriter;
  /** Mode changes go through the host, which owns their side effects. */
  onModeChange?: (mode: PermissionMode) => void;
  /**
   * Called when a deny verdict asks to stop the turn.
   *
   * `createPermissionRequestHookBridge` defaults this to the session's Config
   * slot; a channel that already holds the turn's AbortController overrides it.
   */
  onInterrupt?: () => void;
}

/**
 * Apply a hook's rule updates the same way a remembered approval is applied: to the
 * live module and to disk. Hook updates already carry their destination, so they go
 * straight through `applyUpdatesToRules` rather than the approval-scope mapping.
 */
function applyHookPermissionUpdates(
  bridge: PermissionRequestHookBridge,
  updates: PermissionUpdate[],
): void {
  if (bridge.settingsWriter) {
    persistPermissionUpdates(updates, bridge.settingsWriter);
  }

  const applied = applyUpdatesToRules(bridge.permission.getRules(), updates);
  bridge.permission.setRules(applied.rules);

  if (applied.mode) {
    bridge.onModeChange?.(applied.mode);
  }

  if (
    applied.addedDirectories.length > 0 ||
    applied.removedDirectories.length > 0
  ) {
    const removed = new Set(applied.removedDirectories);
    bridge.permission.setAdditionalDirectories([
      ...bridge.permission
        .getAdditionalDirectories()
        .filter((dir) => !removed.has(dir)),
      ...applied.addedDirectories,
    ]);
  }
}

/**
 * Consult a PermissionRequest hook and, when it decides, produce the settlement.
 *
 * Returns an approval (carrying any amended input, and applying the hook's rule
 * updates) or a refusal (honouring an interrupt) when the hook takes a position,
 * and `undefined` when it has none — the caller then shows the prompt as usual.
 * A hook that throws counts as no opinion.
 *
 * Extracted so channels whose presenter cannot simply be gated ahead of the hook
 * — the remote worker registers and "shows" synchronously and races rechecks —
 * can consult the hook the same way the presenter/handler decorators do, without
 * duplicating the verdict mapping.
 */
export async function consultPermissionRequestHook(
  bridge: PermissionRequestHookBridge,
  params: {
    toolName: string;
    input: Record<string, unknown>;
    suggestions: PermissionUpdate[] | undefined;
    signal?: AbortSignal;
  },
): Promise<AskSettlement | undefined> {
  let verdict: PermissionRequestHookVerdict | undefined;
  try {
    verdict = await bridge.getVerdict(params);
  } catch {
    verdict = undefined;
  }

  if (verdict?.behavior === 'allow') {
    if (verdict.updatedPermissions?.length) {
      applyHookPermissionUpdates(bridge, verdict.updatedPermissions);
    }
    return verdict.updatedInput
      ? { kind: 'approved', input: verdict.updatedInput }
      : { kind: 'approved' };
  }

  if (verdict?.behavior === 'deny') {
    if (verdict.interrupt) {
      bridge.onInterrupt?.();
    }
    // The hook's message is the denial reason: without it the model only sees
    // a generic refusal and cannot tell what the hook objected to.
    return {
      kind: 'rejected',
      reason: verdict.message ?? 'Permission denied by hook.',
    };
  }

  return undefined;
}

/**
 * Race a channel's presenter against a PermissionRequest hook.
 *
 * The prompt is shown immediately and the hook runs in parallel; whichever
 * settles first wins (`settle` is the settle-once guard). A hook with no
 * opinion, or one that throws, concedes to the channel; a late verdict after
 * settlement is dropped.
 */
export function withPermissionRequestHook(
  presenter: AskPresenter,
  bridge: PermissionRequestHookBridge,
): AskPresenter {
  return {
    ...presenter,
    present(prompt, settle) {
      let disposed = false;
      let innerTeardown: (() => void) | undefined;
      // Stops the hook once the race is decided. A hook still waiting when
      // the channel wins (a terminal answer or cancel) gets SIGTERM, so it
      // can tell whoever it is waiting on that the prompt is gone.
      const hookAbort = new AbortController();

      if (prompt.reason.attribution.type === 'managedRule') {
        return presenter.present(prompt, settle);
      }
      try {
        innerTeardown = presenter.present(prompt, settle);
      } catch {
        settle({ kind: 'aborted' });
        return () => {};
      }

      void (async () => {
        let settlement: AskSettlement | undefined;
        try {
          settlement = await consultPermissionRequestHook(bridge, {
            toolName: prompt.toolName,
            input: prompt.input,
            suggestions: prompt.suggestions,
            signal: hookAbort.signal,
          });
        } catch {
          // Hook errors concede the race — the user keeps the prompt.
          settlement = undefined;
        }
        if (disposed || !settlement) {
          return;
        }
        // The hook beat the channel: record the win before settling so the
        // gate sees it, then settle (no-op if the channel won first) and
        // take the prompt down.
        bridge.askMetrics.record(prompt.toolUseId, { winnerParty: 'hook' });
        settle(settlement);
        innerTeardown?.();
      })();

      return () => {
        disposed = true;
        hookAbort.abort();
        innerTeardown?.();
      };
    },
  };
}

/**
 * Wrap a finished ask handler so a PermissionRequest hook gets first say.
 *
 * Channel-agnostic twin of `withPermissionRequestHook`: use this where the
 * presenter is built inside a channel factory (headless, ACP, remote worker).
 * Without a handler the hook runs serially and fails closed; with a handler it
 * races the channel and the first settlement wins.
 */
export function withPermissionRequestHookHandler(
  handler: HostAskHandler | undefined,
  bridge: PermissionRequestHookBridge,
): HostAskHandler {
  return async (ctx) => {
    const first = ctx.toolCheckResult;
    if (first.kind !== 'ask') {
      return handler ? handler(ctx) : { kind: 'rejected' };
    }

    if (isManagedAsk(first)) {
      return handler ? handler(ctx) : { kind: 'rejected' };
    }

    // A prompt whose whole purpose is collecting user input (AskUser's
    // answers, the plan dialogs) is not an authorization prompt: a hook
    // allow/deny winning a race would close the dialog before that input
    // exists and run the tool on an incomplete input object. With a channel
    // attached, only the channel may settle it. Bare headless below keeps the
    // serial hook — there the hook is the only voice, so there is no race to
    // lose and nothing for a dialog to collect.
    if (handler && (isUnskippable(first) || isBypassImmune(first))) {
      // A catastrophic finding is the person's call too: a hook allow racing
      // the dialog would run the removal before anyone looked at it.
      return handler(ctx);
    }

    // Bare headless: no channel to race — the hook is the only voice.
    if (!handler) {
      const settlement = await consultPermissionRequestHook(bridge, {
        toolName: ctx.toolName,
        input: ctx.input,
        suggestions: first.suggestions,
        signal: ctx.signal,
      });
      if (settlement) {
        bridge.askMetrics.record(ctx.toolUseId, { winnerParty: 'hook' });
        return settlement;
      }
      return { kind: 'rejected' };
    }

    // Race the hook against the channel prompt; first settlement wins. The
    // hook is stopped once either side settles, or when the turn is aborted.
    const hookAbort = new AbortController();
    const hookSignal = ctx.signal
      ? AbortSignal.any([ctx.signal, hookAbort.signal])
      : hookAbort.signal;
    const hookSettlement = (async () => {
      try {
        return await consultPermissionRequestHook(bridge, {
          toolName: ctx.toolName,
          input: ctx.input,
          suggestions: first.suggestions,
          signal: hookSignal,
        });
      } catch {
        // Hook errors concede the race — the channel keeps the ask.
        return undefined;
      }
    })();
    const channelSettlement = Promise.resolve(handler(ctx));

    return new Promise<AskSettlement>((resolve) => {
      let done = false;
      const finish = (settlement: AskSettlement): void => {
        if (!done) {
          done = true;
          hookAbort.abort();
          resolve(settlement);
        }
      };
      void hookSettlement.then((settlement) => {
        if (!settlement) {
          return;
        }
        // The hook beat the channel: record the win so the gate can
        // attribute the settlement, then settle (ignored if the channel won
        // first).
        bridge.askMetrics.record(ctx.toolUseId, { winnerParty: 'hook' });
        finish(settlement);
      });
      void channelSettlement.then(finish);
    });
  };
}
