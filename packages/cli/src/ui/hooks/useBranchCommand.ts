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
  SessionStartSource,
  computeUniqueBranchTitle,
} from '@qwen-code/qwen-code-core';
import {
  buildResumedHistoryItems,
  applyCollapsePolicyAndSummary,
} from '../utils/resumeHistoryUtils.js';
import { restoreGoalFromHistory } from '../utils/restoreGoal.js';
import type { UseHistoryManagerReturn } from './useHistoryManager.js';
import type { LoadedSettings } from '../../config/settings.js';
import { t } from '../../i18n/index.js';
import {
  hasBlockingBackgroundWork,
  resetBackgroundStateForSessionSwitch,
} from '../utils/backgroundWorkUtils.js';

export const BACKGROUND_WORK_BRANCH_BLOCKED_MESSAGE =
  "Stop the current session's running background tasks before branching.";

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
  const { config, historyManager, startNewSession, setSessionName, remount } =
    options;

  const handleBranch = useCallback(
    async (name?: string) => {
      if (!config) return;

      if (hasBlockingBackgroundWork(config)) {
        historyManager.addItem(
          {
            type: 'error',
            text: BACKGROUND_WORK_BRANCH_BLOCKED_MESSAGE,
          },
          Date.now(),
        );
        return;
      }

      const oldSessionId = config.getSessionId();
      const newSessionId = randomUUID();
      const sessionService = config.getSessionService();

      let uiSwapped = false;
      let forkCreated = false;
      let sourcePaused = false;

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
        await outgoingRecording?.pause({ requireHealthy: true });
        sourcePaused = true;
        const sourceSnapshot =
          await outgoingRecording?.readStableTranscriptSnapshot();
        if (!sourceSnapshot) throw new Error('Session recording is disabled');

        // 3. Fork the JSONL on disk.
        await sessionService.forkSessionFromSnapshot(
          oldSessionId,
          newSessionId,
          sourceSnapshot,
        );
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
        //    client.
        const transition = await config.prepareSessionTransition(
          newSessionId,
          resumed,
          {
            sessionStartSource: SessionStartSource.Branch,
            requireHealthySource: true,
          },
        );
        let uiHistoryItems: ReturnType<typeof applyCollapsePolicyAndSummary>;
        try {
          const authoritativeSessionData = transition.sessionData;
          if (!authoritativeSessionData) {
            throw new Error('Failed to load branch under write ownership');
          }
          const rawItems = buildResumedHistoryItems(
            authoritativeSessionData,
            config,
          );
          const collapseOnResume =
            options.settings.merged.ui?.history?.collapseOnResume ?? false;
          const collapsePreviewCount =
            options.settings.merged.ui?.history?.collapsePreviewCount ?? 0;
          uiHistoryItems = applyCollapsePolicyAndSummary(
            rawItems,
            collapseOnResume,
            collapsePreviewCount,
          );
        } catch (error) {
          await transition.rollback();
          throw error;
        }
        try {
          await transition.commit(() => {
            startNewSession(newSessionId);
            historyManager.clearItems();
            historyManager.loadHistory(uiHistoryItems);
            setSessionName?.(effectiveTitle);
            uiSwapped = true;
          });
        } catch (error) {
          await transition.rollback();
          throw error;
        }
        sourcePaused = false;

        try {
          resetBackgroundStateForSessionSwitch(config);
        } catch (error) {
          config
            .getDebugLogger()
            .warn(
              `Failed to reset background state after session branch: ${error}`,
            );
        }

        // 9. Re-arm /goal under the fork's new sessionId. The branched JSONL
        // is a verbatim copy of the parent's, so an active goal sentinel
        // carries over — but the Config session transition rebuilt the hook
        // system under `newSessionId`, leaving the parent's `activeGoal`
        // store entry stale and the Stop hook unregistered. Same rationale
        // as the /resume path; see [[useResumeCommand]] for details.
        try {
          restoreGoalFromHistory(
            uiHistoryItems,
            config,
            historyManager.addItem,
          );
        } catch {
          // Best-effort — branch must not fail on goal restoration.
        }

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
        if (sourcePaused && config.getSessionId() === oldSessionId) {
          try {
            config.getChatRecordingService()?.resume();
          } catch (resumeError) {
            config
              .getDebugLogger()
              .warn(`Failed to resume source recorder: ${resumeError}`);
          }
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
      setSessionName,
      remount,
      options.settings.merged.ui?.history?.collapseOnResume,
      options.settings.merged.ui?.history?.collapsePreviewCount,
    ],
  );

  return { handleBranch };
}
