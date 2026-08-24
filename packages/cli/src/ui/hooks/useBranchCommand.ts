/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback } from 'react';
import { randomUUID } from 'node:crypto';
import {
  type Config,
  type ChatRecord,
  type ResumedSessionData,
  SessionStartSource,
  computeUniqueBranchTitle,
} from '@qwen-code/qwen-code-core';
import {
  buildResumedHistoryItems,
  applyCollapsePolicyAndSummary,
} from '../utils/resumeHistoryUtils.js';
import type { UseHistoryManagerReturn } from './useHistoryManager.js';
import type { LoadedSettings } from '../../config/settings.js';
import { t } from '../../i18n/index.js';
import {
  hasBlockingBackgroundWork,
  buildBackgroundWorkBlockedMessage,
  resetBackgroundStateForSessionSwitch,
} from '../utils/backgroundWorkUtils.js';
import { waitForGoalRuntime } from '../utils/goal-runtime.js';

const BACKGROUND_WORK_BRANCH_BLOCKED_MESSAGE =
  "Stop the current session's running background tasks before branching the conversation.";

/**
 * Derives a short one-line title from the first *real* user message in the
 * transcript. Mirrors Claude Code's `deriveFirstPrompt` (see
 * claude-code/src/commands/branch/branch.ts): collapse whitespace, truncate
 * to 100 chars, fall back to "Branched conversation" when the transcript
 * has no user text.
 *
 * Reads ChatRecord[] — the JSONL-level transcript — NOT the Gemini API
 * `Content[]` history. The latter is prepended with environment / CLAUDE.md /
 * context injections by the runtime; its first role=user entry is a
 * synthetic bootstrap message, not anything the user typed.
 *
 * Records with a `subtype` are skipped — those are cron-fired prompts,
 * notifications, slash-command echoes, etc., not genuine user input.
 */
function deriveFirstPrompt(messages: ChatRecord[]): string {
  for (const record of messages) {
    if (record.type !== 'user') continue;
    if (record.subtype) continue;
    const parts = record.message?.parts;
    if (!parts) continue;
    for (const part of parts) {
      if ('text' in part && typeof part.text === 'string' && part.text) {
        const collapsed = part.text.replace(/\s+/g, ' ').trim().slice(0, 100);
        if (collapsed) return collapsed;
      }
    }
  }
  return 'Branched conversation';
}

export interface UseBranchCommandOptions {
  config: Config | null;
  settings: LoadedSettings;
  historyManager: Pick<
    UseHistoryManagerReturn,
    'clearItems' | 'loadHistory' | 'addItem'
  >;
  startNewSession: (sessionId: string) => void;
  clearPendingState?: () => void;
  setSessionName?: (name: string | null) => void;
  remount?: () => void;
}

export interface UseBranchCommandResult {
  handleBranch: (name?: string) => Promise<void>;
}

/**
 * Orchestrates `/branch`:
 *   1. Capture the current (soon-to-be-parent) sessionId for the resume hint.
 *   2. Finalize and flush the outgoing recorder so the source tail is on disk.
 *   3. Call `SessionService.forkSession` to write a new JSONL under a new id.
 *   4. Load the fork, compute and persist its unique branch title, then reload.
 *   5. Switch the core config and UI to the fully persisted fork.
 *   6. Fire the SessionStart hook.
 *   7. Announce the fork with Claude-style two-line info item:
 *        `Branched conversation "foo". You are now in the branch.`
 *        `To resume the original: /resume <oldSessionId>`
 *
 * Mirrors claude-code/src/commands/branch/branch.ts.
 */
export function useBranchCommand(
  options: UseBranchCommandOptions,
): UseBranchCommandResult {
  const {
    config,
    historyManager,
    startNewSession,
    clearPendingState,
    setSessionName,
    remount,
  } = options;

  const handleBranch = useCallback(
    async (name?: string) => {
      if (!config) return;

      if (hasBlockingBackgroundWork(config)) {
        historyManager.addItem(
          {
            type: 'error',
            text: buildBackgroundWorkBlockedMessage(
              config,
              t(BACKGROUND_WORK_BRANCH_BLOCKED_MESSAGE),
            ),
          },
          Date.now(),
        );
        return;
      }

      const oldSessionId = config.getSessionId();
      const newSessionId = randomUUID();
      const sessionService = config.getSessionService();

      let coreSwapped = false;
      let uiSwapped = false;
      let forkCreated = false;
      // Rejected by the telemetry-swap latch: the catch block must neither
      // roll back (nothing was swapped) nor settle the slot (it belongs to
      // the in-flight swap that rejected this one) (#9844).
      let swapRejected = false;
      let prevSessionData: ResumedSessionData | undefined;

      try {
        // 1. Flush outgoing recorder. A degraded source must not fork because
        //    the visible, unpersisted tail would be silently missing.
        //    It must happen BEFORE the parent snapshot
        //    so the snapshot captures `finalize()`'s trailing custom_title
        //    record — without that, a rollback restores the recorder with
        //    a stale `lastCompletedUuid` and the next user message attaches
        //    its parentUuid to a record that's no longer the JSONL tail.
        const outgoingRecording = config.getChatRecordingService();
        outgoingRecording?.finalize();
        await outgoingRecording?.flush();

        // 2. Snapshot the parent JSONL state for rollback. `/branch` is
        //    guarded on `isIdleRef`, so the file isn't being mutated
        //    concurrently between this load and the swap below.
        try {
          prevSessionData = await sessionService.loadSession(oldSessionId);
        } catch {
          // Best-effort snapshot. Falling back to undefined still rolls
          // back sessionId + recorder, which is the load-bearing invariant;
          // we just lose the parentUuid chain on the restored recorder.
        }

        // 3. Fork the JSONL on disk.
        await sessionService.forkSession(oldSessionId, newSessionId);
        forkCreated = true;

        // 4. Load the fork to derive its title before it becomes live.
        const provisional = await sessionService.loadSession(newSessionId);
        if (!provisional) {
          throw new Error('Failed to load newly forked session');
        }

        // 5. Persist the branch title before switching core or UI. A failed
        //    title write leaves the parent active and the catch path removes
        //    the incomplete fork.
        const baseName =
          name ?? deriveFirstPrompt(provisional.conversation.messages);
        const effectiveTitle = await computeUniqueBranchTitle(
          baseName,
          sessionService,
        );
        const titlePersisted = await sessionService.renameSession(
          newSessionId,
          effectiveTitle,
          name ? 'manual' : 'auto',
        );
        if (!titlePersisted) {
          throw new Error('Failed to persist branch title');
        }

        // 6. Reload after the title append so the new recorder starts from
        //    the actual JSONL tail and hydrates the persisted title/source.
        const resumed = await sessionService.loadSession(newSessionId);
        if (!resumed) {
          throw new Error('Failed to reload titled branch session');
        }

        // 7. Swap core first. Anything that can still fail (startNewSession,
        //    client init) runs while the UI is still showing the parent
        //    session, so a throw leaves the user safely on the parent
        //    instead of stranded with a cleared history and a half-live
        //    client. `coreSwapped` gates the rollback path in the catch
        //    block below — without it, a failure between swap and UI
        //    update would leave core on the fork while UI still shows
        //    the parent, silently recording user input into an orphan.
        //
        // Open the telemetry swap transaction BEFORE the core swap: the
        // initialize() below replays the fork's stored usage (the parent's
        // whole history) straight into the process-wide aggregate, and the
        // catch path must be able to put it back (#9833). The transaction
        // arms its own snapshot inside the client's replay decision, so
        // opening it early costs nothing when no replay happens.
        //
        // Opening also doubles as the session-switch latch (#9844): a false
        // return means another /resume or /branch already holds the single
        // swap slot. Throw (rather than early-return) so the catch block
        // still deletes the fork we just created; `swapRejected` keeps the
        // catch from settling the slot, which belongs to the in-flight swap.
        const telemetrySwapOpened =
          config.getGeminiClient()?.beginTelemetrySwap?.() ?? true;
        if (!telemetrySwapOpened) {
          swapRejected = true;
          throw new Error(
            'A session switch is already in progress. Try again in a moment.',
          );
        }
        config.startNewSession(newSessionId, resumed);
        coreSwapped = true;
        await waitForGoalRuntime(config);
        await config.getGeminiClient()?.initialize?.(SessionStartSource.Branch);

        // 8. Swap UI. Once this commits, rolling core back is unsafe —
        //    it would leave UI on the branch but recorder writing into
        //    the parent JSONL (the inverse split-brain). The commit point
        //    is the stats-provider re-key itself: from here on a failure
        //    must not roll core back OR undo the telemetry replay — the
        //    re-keyed display would read the fork's dropped bucket as
        //    zeros. `uiSwapped` gates the catch block's core rollback;
        //    post-commit failures (history items, remount, announce) are
        //    non-fatal and surfaced as an error item.
        const rawItems = buildResumedHistoryItems(resumed, config);
        const collapseOnResume =
          options.settings.merged.ui?.history?.collapseOnResume ?? false;
        const collapsePreviewCount =
          options.settings.merged.ui?.history?.collapsePreviewCount ?? 0;
        const uiHistoryItems = applyCollapsePolicyAndSummary(
          rawItems,
          collapseOnResume,
          collapsePreviewCount,
        );
        startNewSession(newSessionId);
        uiSwapped = true;
        config.getGeminiClient()?.commitTelemetrySwap?.();
        clearPendingState?.();
        historyManager.clearItems();
        historyManager.loadHistory(uiHistoryItems);
        resetBackgroundStateForSessionSwitch(config);

        // 9. Apply the already-persisted title to the prompt bar.
        setSessionName?.(effectiveTitle);

        // Refresh terminal UI.
        remount?.();

        // 11. Announce. Two history items mirror Claude's success message
        //    (branched line + resume hint). The quoted name is the raw
        //    user-provided `name`; no `(Branch)` suffix — that decoration
        //    belongs in the picker/prompt bar, not in the user-facing
        //    announcement.
        const titleInfo = name ? ` "${name}"` : '';
        historyManager.addItem(
          {
            type: 'info',
            text: t(
              'Branched conversation{{titleInfo}}. You are now in the branch.',
              { titleInfo },
            ),
          },
          Date.now(),
        );
        historyManager.addItem(
          {
            type: 'info',
            text: t('To resume the original: /resume {{sessionId}}', {
              sessionId: oldSessionId,
            }),
          },
          Date.now(),
        );
      } catch (err) {
        if (coreSwapped && !uiSwapped) {
          // Core switched to the fork but UI hasn't swapped yet — put core
          // back on the parent, otherwise the recorder would keep writing
          // new user messages into the orphan fork JSONL while UI still
          // shows the parent.
          //
          // Skipped once `uiSwapped` is true: at that point UI is already
          // on the branch, so reverting core would create the inverse
          // split-brain (UI on branch, recorder on parent). Post-UI-swap
          // failures (hook, remount, announce) are non-fatal and
          // surfaced as an error item without unwinding the swap.
          try {
            config.startNewSession(oldSessionId, prevSessionData);
            // Re-hydrate chat history against the restored session. Best-
            // effort: if this throws too, sessionId + recorder are still
            // back on the parent, which is the load-bearing invariant.
            await config.getGeminiClient()?.initialize?.();
          } catch (rollbackErr) {
            config
              .getDebugLogger()
              .warn(
                `Rollback after failed /branch init failed: ${rollbackErr}`,
              );
          }
          // Core is back on the parent: put the usage aggregate (and the
          // two affected session buckets) back to pre-swap state. Must run
          // AFTER the rollback's re-initialize above — that re-initialize
          // replays the parent's history on top of the fork's already-
          // committed replay, and restore overwrites rather than subtracts,
          // so the final state is exactly pre-swap (#9833).
          config.getGeminiClient()?.abortTelemetrySwap?.();
        } else if (!swapRejected) {
          // Either the core swap never happened (nothing was replayed —
          // the transaction is unarmed) or the UI already committed (the
          // replay belongs to the session the user is on). Both close the
          // transaction without restoring. A latch-rejected attempt owns no
          // transaction — settling here would close the in-flight swap that
          // rejected it (#9844).
          config.getGeminiClient()?.commitTelemetrySwap?.();
        }
        if (forkCreated && !uiSwapped) {
          try {
            await sessionService.removeSession(newSessionId);
          } catch (cleanupErr) {
            config
              .getDebugLogger()
              .warn(`Failed to clean up failed branch session: ${cleanupErr}`);
          }
        }
        historyManager.addItem(
          {
            type: 'error',
            text: t('Failed to branch conversation: {{message}}', {
              message: err instanceof Error ? err.message : String(err),
            }),
          },
          Date.now(),
        );
      }
    },
    [
      config,
      historyManager,
      startNewSession,
      clearPendingState,
      setSessionName,
      remount,
      options.settings.merged.ui?.history?.collapseOnResume,
      options.settings.merged.ui?.history?.collapsePreviewCount,
    ],
  );

  return { handleBranch };
}
