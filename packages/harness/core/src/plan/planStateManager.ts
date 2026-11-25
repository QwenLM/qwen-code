/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Session-scoped plan state manager.
 *
 * PlanStateManager is the single source of truth for all plan mode lifecycle
 * state within a session. It is instantiated by Config and lives as long as
 * the session.
 *
 * Responsibilities:
 *   1. Mode transition tracking  — enter / exit
 *   2. Attachment flag management — exit notification (one-shot), reentry detection
 *   3. Plan file slug management  — per-session wordSlug → file path resolution
 *
 * Design:
 *   - No global singleton. Config holds the instance; tests create their own.
 *   - All flag-consuming methods (consumeExitAttachmentFlag, consumeReentryFlag)
 *     are one-shot: they read the flag, reset it, and return the old value.
 *   - enter() clears the pending exit flag to guard against rapid toggle races:
 *       exit() sets flag → enter() before next turn → flag cleared → no stale notification.
 */

import {
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
} from '../tools/tool-names.js';

import * as path from 'node:path';
import * as fsPromises from 'node:fs/promises';
import type { Message } from '../protocol/transcript/message.js';
import { fileExistsSync } from '../utils/fsOperations.js';
import { isSubpath, resolveToRealPath } from '../utils/paths.js';
import { isPayloadResult } from '../tools/tools.js';
import { ADJECTIVES, NOUNS, ANIMALS } from './words.js';
import { runLogger } from '../utils/runLogger.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum attempts to find a non-colliding slug. */
const MAX_SLUG_RETRIES = 10;

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Controls how concise / structured the Phase 4 plan instructions are.
 *
 *   control  — full context section + approach + critical files + reused functions + verification (default)
 *   trim     — one-line context + file list + reusable functions + single verification command
 *   cut      — no context, one line per file change, single verification command, good plans < 40 lines
 *   cap      — no context/prose, one bullet per file (file:line), single verification command, hard 40-line limit
 */
export type PlanPhase4Variant = 'control' | 'trim' | 'cut' | 'cap';

// ─── PlanStateManager ─────────────────────────────────────────────────────────

export class PlanStateManager {
  // ── Mode transition state ──
  /**
   * Plan is an independent work state, not a permission mode value. Active
   * state is tracked here so callers probe planStateManager.isActive instead
   * of checking config.getPermissionMode() === 'plan'.
   *
   * Maintained in lockstep with enter()/exit(). Config.setPermissionMode
   * also drives enter()/exit() — both paths converge to the same flag.
   */
  private _isActive = false;

  // ── Attachment flag state ──
  /** True after the first exit; stays true for the session lifetime. */
  private _hasExitedPlanModeInSession = false;
  /** One-shot flag: triggers plan_mode_exit attachment on next turn. */
  private _needsPlanModeExitAttachment = false;
  /** One-shot flag: triggers plan_mode_reentry attachment on next turn. */
  private _reentryPending = false;

  // ── Interview Phase ──
  /**
   * When true, the plan_mode full reminder uses the iterative interview-phase
   * workflow (explore → update plan → ask user → repeat) instead of the 5-phase
   * workflow. Enabled via ENV_PLAN_MODE_INTERVIEW_PHASE=true env var.
   */
  private _interviewPhaseEnabled = false;

  // ── Phase 4 Variant ──
  /**
   * Controls which Phase 4 (Final Plan) instruction variant is emitted.
   * Defaults to 'control' (full instructions). Configurable via
   * ENV_PLAN_PHASE4_VARIANT env var.
   */
  private _phase4Variant: PlanPhase4Variant = 'control';

  // ── Verify Plan Reminder ──
  /**
   * Number of human turns elapsed since the last plan mode exit.
   * Used to fire a verify_plan_reminder every 10 human turns post-exit.
   */
  private _turnsSincePlanExit = 0;

  // ── Slug management ──
  /** Maps sessionId → wordSlug. */
  private readonly slugCache = new Map<string, string>();

  // ─── Mode Transition API ────────────────────────────────────────────────────

  /**
   * Call when entering plan mode.
   *
   * Clears the pending exit attachment flag to prevent a stale notification
   * if the user toggles enter→exit→enter without an intervening agent turn.
   * Sets the reentry flag if this session has previously exited plan mode.
   *
   */
  enter(): void {
    this._isActive = true;
    // Guard: if we were about to emit plan_mode_exit but re-entered before
    // the attachment turn ran, cancel the exit notification.
    this._needsPlanModeExitAttachment = false;
    // Reentry: only if this session has previously exited plan mode.
    if (this._hasExitedPlanModeInSession) {
      this._reentryPending = true;
    }
  }

  /**
   * Call when exiting plan mode.
   *
   * Marks that the session has exited plan mode and schedules a one-shot
   * plan_mode_exit attachment for the next agent turn.
   */
  exit(): void {
    this._isActive = false;
    this._needsPlanModeExitAttachment = true;
    this._hasExitedPlanModeInSession = true;
    // Reset so the verify_plan_reminder fires exactly 10 turns after this exit,
    // not 10 turns since some prior exit.
    this._turnsSincePlanExit = 0;
  }

  /**
   * Whether plan mode is currently active in this session.
   *
   * This is the canonical source of truth for "is plan running?".
   * Prefer it over checking Config.getPermissionMode() === 'plan'.
   */
  get isActive(): boolean {
    return this._isActive;
  }

  /** Whether plan mode has been exited at least once in this session. */
  get hasExitedPlanModeInSession(): boolean {
    return this._hasExitedPlanModeInSession;
  }

  /** Whether the iterative interview-phase workflow is enabled. */
  get interviewPhaseEnabled(): boolean {
    return this._interviewPhaseEnabled;
  }

  /**
   * Enable the iterative interview-phase planning workflow.
   * Called during Config construction when ENV_PLAN_MODE_INTERVIEW_PHASE=true.
   */
  enableInterviewPhase(): void {
    this._interviewPhaseEnabled = true;
  }

  /** The Phase 4 plan instruction variant to use in full reminders. */
  get phase4Variant(): PlanPhase4Variant {
    return this._phase4Variant;
  }

  /**
   * Set the Phase 4 plan instruction variant.
   * Called during Config construction when ENV_PLAN_PHASE4_VARIANT is set.
   */
  setPhase4Variant(variant: PlanPhase4Variant): void {
    this._phase4Variant = variant;
  }

  // ─── Verify Plan Reminder API ────────────────────────────────────────────────

  /**
   * Increment the turns-since-plan-exit counter.
   * Called once per human turn when plan mode is NOT active but has been
   * exited at least once in the session.
   */
  incrementTurnsSincePlanExit(): void {
    if (this._hasExitedPlanModeInSession) {
      this._turnsSincePlanExit++;
    }
  }

  /**
   * Returns true if a verify_plan_reminder should be emitted this turn.
   * Fires on every 10th human turn after plan mode exit.
   */
  shouldSendVerifyReminder(): boolean {
    return (
      this._hasExitedPlanModeInSession &&
      this._turnsSincePlanExit > 0 &&
      this._turnsSincePlanExit % 10 === 0
    );
  }

  // ─── Attachment Flag API ────────────────────────────────────────────────────

  /**
   * Consume the plan_mode_exit attachment flag.
   *
   * Returns true (and resets to false) if a plan_mode_exit attachment
   * should be emitted this turn. Subsequent calls return false until
   * exit() is called again.
   */
  consumeExitAttachmentFlag(): boolean {
    const val = this._needsPlanModeExitAttachment;
    this._needsPlanModeExitAttachment = false;
    return val;
  }

  /**
   * Consume the plan_mode_reentry flag.
   *
   * Returns true (and resets to false) if a plan_mode_reentry attachment
   * should be emitted this turn. Subsequent calls return false until
   * enter() is called again after a prior exit.
   */
  consumeReentryFlag(): boolean {
    const val = this._reentryPending;
    this._reentryPending = false;
    return val;
  }

  // ─── Slug Management API ────────────────────────────────────────────────────

  /**
   * Get (or lazily generate) the plan file slug for a session.
   *
   * The slug takes the form: {adjective}-{noun}-{animal}
   * e.g. "tender-juggling-karp"
   *
   * On first call, a random slug is generated; if the file already exists,
   * up to MAX_SLUG_RETRIES attempts are made to find a collision-free slug.
   * The result is cached for the lifetime of this manager.
   *
   * @param sessionId  The current session identifier.
   * @param plansDir   Absolute path to the plans directory (used for collision checks).
   */
  getPlanSlug(sessionId: string, plansDir: string): string {
    let slug = this.slugCache.get(sessionId);
    if (slug) return slug;

    slug = this.resolveUniqueSlug(plansDir, `session=${sessionId}`);
    this.slugCache.set(sessionId, slug);
    return slug;
  }

  /**
   * Return the absolute path to the plan file for a session.
   *
   * Main session: {plansDir}/{slug}.md
   * Sub-agent:    {plansDir}/{slug}-agent-{agentId}.md
   *
   * @param plansDir  Absolute path to the plans directory.
   * @param sessionId The current session identifier.
   * @param agentId   Optional sub-agent identifier.
   */
  getPlanFilePath(
    plansDir: string,
    sessionId: string,
    agentId?: string,
  ): string {
    const slug = this.getPlanSlug(sessionId, plansDir);
    const filename = agentId ? `${slug}-agent-${agentId}.md` : `${slug}.md`;
    return path.join(plansDir, filename);
  }

  /**
   * Restore a known slug for a session (used during /resume).
   *
   * @param sessionId The session to restore.
   * @param slug      The previously generated slug.
   */
  setPlanSlug(sessionId: string, slug: string): void {
    this.slugCache.set(sessionId, slug);
  }

  /**
   * Clear the cached slug for a session (called on /clear).
   * The next call to getPlanSlug() will generate a fresh slug.
   *
   * @param sessionId  Session to clear. If omitted, clears all sessions.
   */
  clearPlanSlug(sessionId?: string): void {
    if (sessionId !== undefined) {
      this.slugCache.delete(sessionId);
    } else {
      this.slugCache.clear();
    }
  }

  // ─── Session Continuity ─────────────────────────────────────────────────────

  /**
   * Copy the plan file from a resumed session into the target session's slug.
   *
   * Priority order (stops at the first successful source):
   *   1. Filesystem: read the source session's slug file directly from plansDir.
   *      The source slug is in-memory only, so it is first recovered from the
   *      EnterPlanMode tool result text (`**Plan file**: ...`) emitted by
   *      enter-plan-mode.ts. This restores continuity after a hard process kill.
   *   2. Transcript: find the most recent plan_file_reference attachment
   *   3. Transcript: find the exit_plan_mode tool input planContent field
   *
   * @param messages      Transcript messages from the resumed session.
   * @param sourceSessionId  Session ID of the session being resumed.
   * @param targetSessionId  Session ID of the new (current) session.
   * @param plansDir      Absolute path to the plans directory.
   */
  async copyPlanForResume(
    messages: readonly Message[],
    sourceSessionId: string,
    targetSessionId: string,
    plansDir: string,
  ): Promise<void> {
    // 0. Recover the source session's slug from the most recent successful
    //    EnterPlanMode tool_result's structured payload, if any. Without this,
    //    getPlanFilePath() below would mint a fresh random slug whose file
    //    never existed on disk, defeating the filesystem fallback.
    if (!this.slugCache.has(sourceSessionId)) {
      const recoveredSlug = extractPlanSlugFromMessages(messages, plansDir);
      if (recoveredSlug) {
        this.slugCache.set(sourceSessionId, recoveredSlug);
      }
    }

    // 1. Try to read from filesystem using the source session's slug.
    const sourcePlanPath = this.getPlanFilePath(plansDir, sourceSessionId);
    let planContent: string | undefined;
    try {
      planContent = await fsPromises.readFile(sourcePlanPath, 'utf-8');
    } catch {
      // File may not exist — continue to transcript fallback.
    }

    // 2. Search transcript for plan_file_reference attachment.
    if (!planContent) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.type === 'attachment') {
          const attachment = (
            msg as {
              type: 'attachment';
              attachment: {
                type: string;
                planContent?: string;
                planFilePath?: string;
              };
            }
          ).attachment;
          if (
            attachment.type === 'plan_file_reference' &&
            attachment.planContent
          ) {
            planContent = attachment.planContent;
            break;
          }
        }
      }
    }

    // 3. Search transcript for exit_plan_mode tool input.
    if (!planContent) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.type === 'assistant') {
          const assistantMsg = msg as {
            type: 'assistant';
            message?: {
              content?: Array<{
                type: string;
                name?: string;
                input?: { planContent?: string };
              }>;
            };
          };
          const content = assistantMsg.message?.content ?? [];
          for (const block of content) {
            if (
              block.type === 'tool_use' &&
              block.name === EXIT_PLAN_MODE_TOOL_NAME &&
              block.input?.planContent
            ) {
              planContent = block.input.planContent;
              break;
            }
          }
          if (planContent) break;
        }
      }
    }

    if (!planContent?.trim()) return;

    // Write to the target session's plan file.
    const targetPlanPath = this.getPlanFilePath(plansDir, targetSessionId);
    try {
      await fsPromises.mkdir(path.dirname(targetPlanPath), { recursive: true });
      await fsPromises.writeFile(targetPlanPath, planContent, 'utf-8');
    } catch {
      // Non-fatal: plan copy failure should not block resume.
    }
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────────

  /**
   * Generate a unique plan file slug, retrying up to MAX_SLUG_RETRIES times to
   * avoid collisions. Falls through on exhaustion and warns via runLogger.
   *
   * @param plansDir  Absolute path to the plans directory.
   * @param context   Diagnostic context string for the warning (e.g. "session=abc123").
   */
  private resolveUniqueSlug(plansDir: string, context: string): string {
    let slug = generateWordSlug();
    for (let i = 0; i < MAX_SLUG_RETRIES; i++) {
      if (!fileExistsSync(path.join(plansDir, `${slug}.md`))) {
        return slug;
      }
      slug = generateWordSlug();
    }
    // After MAX_SLUG_RETRIES collisions, fall through with the last generated
    // slug (unchecked). Warn so the potential overwrite is visible in debug logs.
    runLogger.warn(
      `[PlanStateManager] slug collision unresolved after ${MAX_SLUG_RETRIES} retries ` +
        `(${context}, slug=${slug}). Existing plan file may be overwritten.`,
    );
    return slug;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Recover the slug used by the source session by reading the structured
 * `toolUseResult.payload` (planFilePath) of the most recent successful
 * EnterPlanMode tool_result. Returns the slug (basename without `.md`),
 * otherwise undefined.
 *
 * Two safety checks:
 *   1. The `tool_result` must reference a `tool_use` whose `name` is
 *      EnterPlanMode — this rejects unrelated tool outputs that happen to
 *      carry a payload-shaped object.
 *   2. The payload path must resolve inside `plansDir` — this rejects
 *      attacker-controlled paths smuggled into a transcript.
 */
function extractPlanSlugFromMessages(
  messages: readonly Message[],
  plansDir: string,
): string | undefined {
  // Collect tool_use_ids belonging to EnterPlanMode. Forward order is
  // sufficient because tool_use always precedes its tool_result.
  const enterPlanModeToolUseIds = new Set<string>();
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue;
    for (const block of msg.message.content) {
      if (
        block.type === 'tool_use' &&
        block.name === ENTER_PLAN_MODE_TOOL_NAME
      ) {
        enterPlanModeToolUseIds.add(block.id);
      }
    }
  }
  if (enterPlanModeToolUseIds.size === 0) return undefined;

  const realPlansDir = resolveToRealPath(plansDir);

  // Walk backward to take the most recent EnterPlanMode tool_result.
  // createToolResultMessage stores `toolUseResult` as a single object when
  // the message has 1 tool_result block, or as an array indexed parallel to
  // the content blocks when it has many.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type !== 'user' || !Array.isArray(msg.message.content)) continue;

    const blocks = msg.message.content;
    for (let j = 0; j < blocks.length; j++) {
      const block = blocks[j];
      if (
        block.type !== 'tool_result' ||
        block.is_error ||
        !enterPlanModeToolUseIds.has(block.tool_use_id)
      ) {
        continue;
      }

      const stored = msg.toolUseResult;
      const entry = Array.isArray(stored) ? stored[j] : stored;
      if (!isPayloadResult(entry)) continue;

      const realCandidate = resolveToRealPath(entry.payload);
      if (!isSubpath(realPlansDir, realCandidate)) continue;

      const filename = path.basename(realCandidate);
      if (!filename.endsWith('.md')) continue;

      const slug = path.basename(realCandidate, '.md');
      if (!slug) continue;
      return slug;
    }
  }
  return undefined;
}

/**
 * Generate a random three-word slug from the word lists.
 * Format: {adjective}-{noun}-{animal}
 */
function generateWordSlug(): string {
  const adj = pick(ADJECTIVES);
  const noun = pick(NOUNS);
  const animal = pick(ANIMALS);
  return `${adj}-${noun}-${animal}`;
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
