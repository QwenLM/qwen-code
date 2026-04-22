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
  SessionStartSource,
  type PermissionMode,
} from '@qwen-code/qwen-code-core';
import { buildResumedHistoryItems } from '../utils/resumeHistoryUtils.js';
import type { UseHistoryManagerReturn } from './useHistoryManager.js';
import { t } from '../../i18n/index.js';

/**
 * Cap for the `(Branch N)` collision scan. Each probe is a project-wide
 * scan via `findSessionsByTitle`; 99 is generous for realistic use and
 * bounds the worst case.
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
 */
async function computeUniqueBranchTitle(
  baseName: string,
  sessionService: SessionService,
): Promise<string> {
  const trimmed = baseName.trim();
  const first = `${trimmed} (Branch)`;
  if ((await sessionService.findSessionsByTitle(first)).length === 0) {
    return first;
  }
  for (let n = 2; n <= MAX_BRANCH_COLLISION_SCAN; n++) {
    const candidate = `${trimmed} (Branch ${n})`;
    if ((await sessionService.findSessionsByTitle(candidate)).length === 0) {
      return candidate;
    }
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

      try {
        // 1. Flush outgoing recorder.
        try {
          config.getChatRecordingService()?.finalize();
        } catch {
          // best-effort
        }

        // 2. Fork the JSONL on disk.
        await sessionService.forkSession(oldSessionId, newSessionId);

        // 3. Load the new file.
        const resumed = await sessionService.loadSession(newSessionId);
        if (!resumed) {
          throw new Error('Failed to load newly forked session');
        }

        // 4. Swap core first. Anything that can still fail (startNewSession,
        //    client init) runs while the UI is still showing the parent
        //    session, so a throw leaves the user safely on the parent
        //    instead of stranded with a cleared history and a half-live
        //    client.
        config.startNewSession(newSessionId, resumed);
        await config.getGeminiClient()?.initialize?.();

        // 5. Swap UI.
        const uiHistoryItems = buildResumedHistoryItems(resumed, config);
        startNewSession(newSessionId);
        historyManager.clearItems();
        historyManager.loadHistory(uiHistoryItems);

        // 6. Compute and apply the branch customTitle.
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

        // 7. Fire SessionStart for the new session. A fork is semantically
        //    distinct from a resume — the sessionId is new and the transcript
        //    is a derivative — so we use the dedicated `Branch` source value
        //    to let hook consumers distinguish the two.
        try {
          await config
            .getHookSystem()
            ?.fireSessionStartEvent(
              SessionStartSource.Branch,
              config.getModel() ?? '',
              String(config.getApprovalMode()) as PermissionMode,
            );
        } catch (err) {
          config.getDebugLogger().warn(`SessionStart hook failed: ${err}`);
        }

        // 8. Refresh terminal UI.
        remount?.();

        // 9. Announce. Two history items mirror Claude's success message
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
