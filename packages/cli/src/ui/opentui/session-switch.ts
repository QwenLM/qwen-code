/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Real session switch operations for the OpenTUI backend (audit 01 G-5,
 * 05 G-04/G-10): `/resume <id|title>` and `/branch`. These reproduce the ink
 * hooks (`useResumeCommand` / `useBranchCommand`) against the OpenTUI host:
 * the SAME core-before-UI swap order, the SAME rollback semantics (a failure
 * between the core swap and the UI swap puts the core back on the previous
 * session), and the SAME persisted-state steps (turn-boundary rebuild,
 * branch-title computation, background-agent recovery).
 *
 * The one renderer-specific seam: ink replays the resumed transcript through
 * `buildResumedHistoryItems` into its own history; the OpenTUI transcript is
 * the neutral streaming model, so the visible replay additionally flows
 * through `resumeEventsFromSession` (the `--resume` replay path) as a single
 * commit, while the ink items still load into the host history for the
 * command context's consumption.
 */

import { randomUUID } from 'node:crypto';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { buildSessionRecoveryPlan } from '@qwen-code/qwen-code-core/core/session-recovery.js';
import { SessionStartSource } from '@qwen-code/qwen-code-core/hooks/types.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import { SessionService, computeUniqueBranchTitle } from '@qwen-code/qwen-code-core/services/sessionService.js';
import type { ResumedSessionData } from '@qwen-code/qwen-code-core/services/sessionService.js';
import type { HistoryItem, HistoryItemWithoutId } from '../types.js';
import { MessageType } from '../types.js';
import type { LoadedSettings } from '../../config/settings.js';
import {
  applyCollapsePolicyAndSummary,
  buildResumedHistoryItems,
} from '../utils/resumeHistoryUtils.js';
import {
  buildBackgroundWorkBlockedMessage,
  hasBlockingBackgroundWork,
  resetBackgroundStateForSessionSwitch,
} from '../utils/backgroundWorkUtils.js';
import { waitForGoalRuntime } from '../utils/goal-runtime.js';
import { resumeEventsFromSession } from './resume-session.js';
import type { OpenTuiStreamEvent } from './event-adapter.js';

/** The UI surfaces a session switch touches (backend-provided). */
export interface SessionSwitchHost {
  config: Config;
  settings: LoadedSettings;
  addItem(item: HistoryItemWithoutId, timestamp: number): number;
  /** Clears the command history AND the visible transcript. */
  clearItems(): void;
  /** Replaces the command (ink-shaped) history. */
  loadHistory(items: HistoryItem[]): void;
  /** UI-side session reset (SessionStats/session id refresh). */
  startNewSession(sessionId: string): void;
  setSessionName(name: string | null): void;
  clearPendingState(): void;
  /** Replays the resumed transcript (single commit, ends with `done`). */
  resetTranscript(events: OpenTuiStreamEvent[]): void;
}

const BACKGROUND_WORK_SWITCH_BLOCKED_MESSAGE =
  "Stop the current session's running background tasks before resuming another session.";

const BACKGROUND_WORK_BRANCH_BLOCKED_MESSAGE =
  "Stop the current session's running background tasks before branching the conversation.";

/** Collapse-policy application shared by resume and branch (ink parity). */
function buildUiHistoryItems(
  sessionData: ResumedSessionData,
  host: SessionSwitchHost,
): HistoryItem[] {
  const rawItems = buildResumedHistoryItems(sessionData, host.config);
  const collapseOnResume =
    host.settings.merged.ui?.history?.collapseOnResume ?? false;
  const collapsePreviewCount =
    host.settings.merged.ui?.history?.collapsePreviewCount ?? 0;
  return applyCollapsePolicyAndSummary(
    rawItems,
    collapseOnResume,
    collapsePreviewCount,
  );
}

/**
 * Parity of `useResumeCommand.handleResume`: loads the session, swaps core
 * first (rolling back on failure), then swaps the UI and replays the
 * transcript.
 */
export async function handleResumeSession(
  host: SessionSwitchHost,
  sessionId: string,
): Promise<void> {
  const { config } = host;

  if (hasBlockingBackgroundWork(config)) {
    host.addItem(
      {
        type: MessageType.ERROR,
        text: buildBackgroundWorkBlockedMessage(
          config,
          BACKGROUND_WORK_SWITCH_BLOCKED_MESSAGE,
        ),
      },
      Date.now(),
    );
    return;
  }

  // Open the telemetry swap transaction BEFORE touching the outgoing
  // session (ink useResumeCommand parity): the slot is the only
  // serialization for session switches, and a failed swap must restore
  // the usage aggregate. A false return means another /resume or /branch
  // already holds the single swap slot — reject instead of entangling.
  const telemetrySwapOpened =
    config.getLlmClient()?.beginTelemetrySwap?.() ?? true;
  if (!telemetrySwapOpened) {
    host.addItem(
      {
        type: MessageType.ERROR,
        text: 'A session switch is already in progress. Try again in a moment.',
      },
      Date.now(),
    );
    return;
  }

  const oldSessionId = config.getSessionId();
  let coreSwapped = false;
  let uiSwapped = false;

  try {
    const cwd = config.getTargetDir();
    const sessionService = new SessionService(cwd);
    const sessionData = await sessionService.loadSession(sessionId);
    if (!sessionData) {
      // Nothing was replayed — close this attempt's unarmed transaction.
      config.getLlmClient()?.commitTelemetrySwap?.();
      return;
    }
    const customTitle = sessionService.getSessionTitle(sessionId);

    const recoveryPlan = buildSessionRecoveryPlan({
      sessionId,
      conversation: sessionData.conversation,
      historyGaps: sessionData.historyGaps,
    });
    const uiHistoryItems = buildUiHistoryItems(sessionData, host);
    if (
      recoveryPlan.kind !== 'clean' &&
      recoveryPlan.kind !== 'degraded_history' &&
      recoveryPlan.visibleNotice
    ) {
      const nextId = (uiHistoryItems.at(-1)?.id ?? 0) + 1;
      uiHistoryItems.push({
        id: nextId,
        type: MessageType.INFO,
        text: recoveryPlan.visibleNotice,
      } as HistoryItem);
    }

    // 1. Core swap first (ink order): any failure before the UI commits
    //    rolls the core back to the previous session below.
    resetBackgroundStateForSessionSwitch(config);
    config.startNewSession(sessionId, sessionData);
    coreSwapped = true;
    await waitForGoalRuntime(config);
    // Rebuild turn boundary tracking so rewind works within resumed sessions.
    config
      .getChatRecordingService()
      ?.rebuildTurnBoundaries(sessionData.conversation.messages);
    await config.getGeminiClient()?.initialize?.();

    const recovered = await config.loadPausedBackgroundAgents(sessionId);
    const recoveredNotice =
      recovered.length > 0
        ? config
            .getBackgroundAgentResumeService()
            .buildRecoveredBackgroundAgentsNotice(recovered.length)
        : null;

    // 2. UI swap. The commit point is the UI-side session re-key: from here
    //    on a failure must not roll core back OR undo the telemetry replay.
    host.startNewSession(sessionId);
    host.setSessionName(customTitle ?? null);
    host.clearPendingState();
    host.clearItems();
    host.loadHistory(uiHistoryItems);
    host.resetTranscript(resumeEventsFromSession(sessionData, config));
    if (recoveredNotice) {
      host.addItem(
        { type: MessageType.INFO, text: recoveredNotice },
        Date.now(),
      );
    }
    uiSwapped = true;
    config.getLlmClient()?.commitTelemetrySwap?.();
  } catch (error) {
    if (coreSwapped && !uiSwapped) {
      try {
        resetBackgroundStateForSessionSwitch(config);
        config.startNewSession(oldSessionId, undefined);
        await config.loadPausedBackgroundAgents(oldSessionId).catch(() => {});
      } catch (rollbackErr) {
        config
          .getDebugLogger()
          .warn(`Rollback after failed /resume init failed: ${rollbackErr}`);
      }
      // Core is back on the old session: restore the usage aggregate to
      // pre-swap state, dropping the abandoned session's replayed history.
      config.getLlmClient()?.abortTelemetrySwap?.();
    } else {
      // Either the core swap never happened (nothing was replayed — the
      // transaction is unarmed) or the UI already committed (the replay
      // belongs to the session the user is on): close this attempt's
      // transaction without restoring.
      config.getLlmClient()?.commitTelemetrySwap?.();
    }
    host.addItem(
      {
        type: MessageType.ERROR,
        text: `Failed to resume session: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
      Date.now(),
    );
  }
}

/**
 * Derives a short one-line title from the first real user message in the
 * transcript (parity of useBranchCommand.deriveFirstPrompt).
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
 * Parity of `useBranchCommand.handleBranch`: flush + snapshot the outgoing
 * recorder, fork the JSONL, persist a unique branch title, swap core then UI,
 * and announce the fork with the two-line info pair.
 */
export async function handleBranchSession(
  host: SessionSwitchHost,
  name?: string,
): Promise<void> {
  const { config } = host;

  if (hasBlockingBackgroundWork(config)) {
    host.addItem(
      {
        type: MessageType.ERROR,
        text: buildBackgroundWorkBlockedMessage(
          config,
          BACKGROUND_WORK_BRANCH_BLOCKED_MESSAGE,
        ),
      },
      Date.now(),
    );
    return;
  }

  // Telemetry swap transaction (ink useBranchCommand parity): the slot is
  // the only serialization for session switches; see the resume handler.
  const telemetrySwapOpened =
    config.getLlmClient()?.beginTelemetrySwap?.() ?? true;
  if (!telemetrySwapOpened) {
    host.addItem(
      {
        type: MessageType.ERROR,
        text: 'A session switch is already in progress. Try again in a moment.',
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
  let prevSessionData: ResumedSessionData | undefined;

  try {
    // 1. Flush the outgoing recorder so the source tail is on disk before
    //    the fork (a degraded source must not fork).
    const outgoingRecording = config.getChatRecordingService();
    outgoingRecording?.finalize();
    await outgoingRecording?.flush();

    // 2. Snapshot the parent JSONL for rollback (best-effort).
    try {
      prevSessionData = await sessionService.loadSession(oldSessionId);
    } catch {
      // sessionId + recorder still roll back without the snapshot.
    }

    // 3. Fork the JSONL on disk.
    await sessionService.forkSession(oldSessionId, newSessionId);
    forkCreated = true;

    // 4. Load the fork to derive its title before it becomes live.
    const provisional = await sessionService.loadSession(newSessionId);
    if (!provisional) {
      throw new Error('Failed to load newly forked session');
    }

    // 5. Persist the branch title before switching core or UI.
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

    // 6. Reload after the title append so the new recorder starts from the
    //    actual JSONL tail.
    const resumed = await sessionService.loadSession(newSessionId);
    if (!resumed) {
      throw new Error('Failed to reload titled branch session');
    }

    // 7. Core swap first.
    config.startNewSession(newSessionId, resumed);
    coreSwapped = true;
    await waitForGoalRuntime(config);
    await config.getGeminiClient()?.initialize?.(SessionStartSource.Branch);

    // 8. UI swap.
    const uiHistoryItems = buildUiHistoryItems(resumed, host);
    host.startNewSession(newSessionId);
    host.clearPendingState();
    host.clearItems();
    host.loadHistory(uiHistoryItems);
    host.resetTranscript(resumeEventsFromSession(resumed, config));
    uiSwapped = true;
    resetBackgroundStateForSessionSwitch(config);
    // The UI re-key commits the swap: from here on a failure keeps the
    // replay — it belongs to the session the user is on.
    config.getLlmClient()?.commitTelemetrySwap?.();

    // 9. Apply the persisted title to the session-name surface.
    host.setSessionName(effectiveTitle);

    // 10. Announce (two info items, Claude-style).
    const titleInfo = name ? ` "${name}"` : '';
    host.addItem(
      {
        type: MessageType.INFO,
        text: `Branched conversation${titleInfo}. You are now in the branch.`,
      },
      Date.now(),
    );
    host.addItem(
      {
        type: MessageType.INFO,
        text: `To resume the original: /resume ${oldSessionId}`,
      },
      Date.now(),
    );
  } catch (err) {
    if (coreSwapped && !uiSwapped) {
      try {
        config.startNewSession(oldSessionId, prevSessionData);
        await config.getGeminiClient()?.initialize?.();
      } catch (rollbackErr) {
        config
          .getDebugLogger()
          .warn(`Rollback after failed /branch init failed: ${rollbackErr}`);
      }
      // Core is back on the old session: restore the usage aggregate.
      config.getLlmClient()?.abortTelemetrySwap?.();
    } else {
      // Unarmed (core never swapped) or already committed (UI re-keyed):
      // close this attempt's transaction without restoring.
      config.getLlmClient()?.commitTelemetrySwap?.();
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
    host.addItem(
      {
        type: MessageType.ERROR,
        text: `Failed to branch conversation: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
      Date.now(),
    );
  }
}
