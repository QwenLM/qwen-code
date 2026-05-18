/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback } from 'react';
import { randomUUID } from 'node:crypto';
import {
  type Config,
  type SessionService,
  type ChatRecord,
  type ResumedSessionData,
  SessionStartSource,
} from '@qwen-code/qwen-code-core';
import { buildResumedHistoryItems } from '../utils/resumeHistoryUtils.js';
import { restoreGoalFromHistory } from '../utils/restoreGoal.js';
import type { UseHistoryManagerReturn } from './useHistoryManager.js';
import { t } from '../../i18n/index.js';

/**
 * Cap for the `(Branch N)` collision suffix. We scan all matching titles
 * once via `findSessionTitlesByPrefix` and then pick the first free slot
 * in memory; 99 is generous for realistic use and bounds the timestamp-
 * fallback path on pathologically dense title spaces.
 */
const MAX_BRANCH_COLLISION_SCAN = 99;

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

/**
 * Appends ` (Branch)` to `baseName`, bumping to ` (Branch 2)`, ` (Branch 3)`,
 * ... when the exact name is already taken by another session's customTitle
 * in the current project. Mirrors Claude's `getUniqueForkName`.
 *
 * Does ONE prefix scan instead of probing each candidate via
 * `findSessionsByTitle`: in dense title spaces the per-probe scanner could
 * walk the project's chat directory up to {@link MAX_BRANCH_COLLISION_SCAN}
 * times, and `/branch` would visibly stall. We collect every existing
 * `${trimmed} (Branch...` title once, then pick the first free slot in memory.
 */
async function computeUniqueBranchTitle(
  baseName: string,
  sessionService: SessionService,
): Promise<string> {
  const trimmed = baseName.trim();
  const taken = new Set(
    (await sessionService.findSessionTitlesByPrefix(`${trimmed} (Branch`)).map(
      (t) => t.toLowerCase().trim(),
    ),
  );
  const first = `${trimmed} (Branch)`;
  if (!taken.has(first.toLowerCase())) return first;
  for (let n = 2; n <= MAX_BRANCH_COLLISION_SCAN; n++) {
    const candidate = `${trimmed} (Branch ${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  // Pathological density — timestamp fallback keeps the fork unique.
  return `${trimmed} (Branch ${Date.now()})`;
}

export interface UseBranchCommandOptions {
  config: Config | null;
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
 *   2. Finalize the outgoing ChatRecordingService so the last metadata is on disk.
 *   3. Call `SessionService.forkSession` to write a new JSONL under a new id.
 *   4. Load the fork back via `loadSession` and switch the UI + core config.
 *   5. Compute the customTitle — user-provided name OR `deriveFirstPrompt` —
 *      always suffixed with ` (Branch)` (bumping to `(Branch N)` on collision).
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

      const oldSessionId = config.getSessionId();
      const newSessionId = randomUUID();
      const sessionService = config.getSessionService();

      let coreSwapped = false;
      let uiSwapped = false;
      let prevSessionData: ResumedSessionData | undefined;

      try {
        // 1. Flush outgoing recorder. Must happen BEFORE the parent snapshot
        //    so the snapshot captures `finalize()`'s trailing custom_title
        //    record — without that, a rollback restores the recorder with
        //    a stale `lastCompletedUuid` and the next user message attaches
        //    its parentUuid to a record that's no longer the JSONL tail.
        try {
          config.getChatRecordingService()?.finalize();
        } catch {
          // best-effort
        }

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

        // 4. Load the new file.
        const resumed = await sessionService.loadSession(newSessionId);
        if (!resumed) {
          throw new Error('Failed to load newly forked session');
        }

        // 5. Swap core first. Anything that can still fail (startNewSession,
        //    client init) runs while the UI is still showing the parent
        //    session, so a throw leaves the user safely on the parent
        //    instead of stranded with a cleared history and a half-live
        //    client. `coreSwapped` gates the rollback path in the catch
        //    block below — without it, a failure between swap and UI
        //    update would leave core on the fork while UI still shows
        //    the parent, silently recording user input into an orphan.
        config.startNewSession(newSessionId, resumed);
        coreSwapped = true;
        await config.getGeminiClient()?.initialize?.(SessionStartSource.Branch);

        // 6. Swap UI. Once this commits, rolling core back is unsafe —
        //    it would leave UI on the branch but recorder writing into
        //    the parent JSONL (the inverse split-brain). `uiSwapped` is
        //    set immediately after the UI commits so any subsequent
        //    failure (title, hook, remount, announce) skips the catch
        //    block's core rollback.
        const uiHistoryItems = buildResumedHistoryItems(resumed, config);
        startNewSession(newSessionId);
        historyManager.clearItems();
        historyManager.loadHistory(uiHistoryItems);
        uiSwapped = true;

        // Re-arm /goal under the fork's new sessionId. The branched JSONL
        // is a verbatim copy of the parent's, so an active goal sentinel
        // carries over — but `config.startNewSession` rebuilt the hook
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

        // 7. Compute and apply the branch customTitle.
        //    The forked transcript is identical to the parent's, so reading
        //    the first real user message from `resumed.conversation.messages`
        //    mirrors Claude's "use the first parent message" behavior.
        const baseName =
          name ?? deriveFirstPrompt(resumed.conversation.messages);
        const effectiveTitle = await computeUniqueBranchTitle(
          baseName,
          sessionService,
        );
        config.getChatRecordingService()?.recordCustomTitle(effectiveTitle);
        setSessionName?.(effectiveTitle);

        // 8. Refresh terminal UI.
        remount?.();

        // 10. Announce. Two history items mirror Claude's success message
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
          // failures (title, hook, remount, announce) are non-fatal and
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
    [config, historyManager, startNewSession, setSessionName, remount],
  );

  return { handleBranch };
}
