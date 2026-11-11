/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Plan mode attachment generators.
 *
 * Four generators, each with a distinct responsibility:
 *
 *   getPlanModeAttachments()          — periodic throttled reminder (plan_mode full/sparse)
 *   getPlanModeReentryAttachment()    — one-shot reentry notification (plan_mode_reentry)
 *   getPlanModeExitAttachment()       — one-shot exit notification (plan_mode_exit)
 *   getPlanModeInterTurnAttachment()  — lightweight sparse reminder between tool rounds
 *
 * Throttle / cycling rules (spec: plan-attachment-analysis.md §4.1):
 *   TURNS_BETWEEN_ATTACHMENTS     = 5   (human turns between injections)
 *   FULL_REMINDER_EVERY_N         = 5   (every 5th attachment is 'full', rest 'sparse')
 *
 * State ownership:
 *   - Turn counting / increment lives in getAttachments() (human-turn boundary),
 *     not inside generators, to keep generator side-effects minimal.
 *   - Mode lifecycle flags (exit, reentry) live in PlanStateManager (per-session).
 *   - Plan active state is read from PlanStateManager (the single source of
 *     truth); permission mode is not consulted, since plan is not a permission
 *     mode value.
 */

import { fileExistsSync } from '../../utils/fsOperations.js';
import {
  type AttachmentToolUseContext,
  type AttachmentExternalContext,
  PlanModeAttachment,
  PlanModeReentryAttachment,
  PlanModeExitAttachment,
  VerifyPlanReminderAttachment,
} from '../types.js';
import type { PlanStateManager } from '../../plan/planStateManager.js';
import type { Message } from '../../protocol/transcript/message.js';
import { getAvailableAgentTypeNames } from './agent-generators.js';

// ── Constants ─────────────────────────────────────────────────────────────────

export const PLAN_MODE_ATTACHMENT_CONFIG = {
  /** Minimum human turns between plan_mode attachment injections. */
  TURNS_BETWEEN_ATTACHMENTS: 5,
  /** Emit a 'full' reminder once every N attachments; all others are 'sparse'. */
  FULL_REMINDER_EVERY_N_ATTACHMENTS: 5,
} as const;

// ── getPlanModeAttachments ────────────────────────────────────────────────────

/**
 * Emit a periodic plan_mode attachment when plan mode is active.
 *
 * The plan attachment count (for full/sparse cycling) and the turn distance
 * since the last attachment (for throttling) are both derived from messages[],
 * so they survive resume without any persistent counter state.
 *
 * Injection is throttled to once every TURNS_BETWEEN_ATTACHMENTS human turns
 * (or on the very first turn after entering plan mode).
 *
 * The reminderType cycles: 'full' on count 1, 6, 11, … ('sparse' otherwise).
 *
 * @param ctx              Per-agent mutable attachment context.
 * @param externalCtx      Read-only runtime snapshot (permissionMode, sessionId, etc.).
 * @param planStateManager Session-scoped plan lifecycle state.
 * @param messages         Current conversation history (used to derive counts).
 */
export function getPlanModeAttachments(
  ctx: AttachmentToolUseContext,
  externalCtx: AttachmentExternalContext | undefined,
  planStateManager: PlanStateManager,
  messages?: readonly Message[],
): PlanModeAttachment[] {
  if (!externalCtx) return [];
  // Plan is an independent state; check planStateManager instead of permissionMode.
  if (!planStateManager.isActive) return [];

  const plansDir = externalCtx.plansDir;
  const sessionId = externalCtx.sessionId;
  if (!plansDir || !sessionId) return [];

  // ── Throttle: count human turns since last plan_mode or plan_mode_reentry ──
  const { turnCount, foundPlanAttachment } =
    countTurnsSinceLastPlanAttachment(messages);
  if (
    foundPlanAttachment &&
    turnCount < PLAN_MODE_ATTACHMENT_CONFIG.TURNS_BETWEEN_ATTACHMENTS
  ) {
    return [];
  }

  // ── Full/sparse cycling: count plan_mode attachments since last exit ──
  // When no prior plan attachment exists this is unambiguously attachment #1;
  // skip the second scan entirely.
  const attachmentCount = foundPlanAttachment
    ? countPlanAttachmentsSinceLastExit(messages) + 1
    : 1;
  const reminderType: 'full' | 'sparse' =
    attachmentCount %
      PLAN_MODE_ATTACHMENT_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS ===
    1
      ? 'full'
      : 'sparse';

  const planFilePath = planStateManager.getPlanFilePath(
    plansDir,
    sessionId,
    planScopedAgentId(ctx),
  );
  const planExists = fileExistsSync(planFilePath);
  const availableAgentTypes = getAvailableAgentTypeNames(externalCtx);

  return [
    new PlanModeAttachment({
      type: 'plan_mode' as const,
      reminderType,
      isActive: true,
      isSubAgent: !ctx.isMainAgent,
      planFilePath,
      planExists,
      interviewPhase: planStateManager.interviewPhaseEnabled,
      phase4Variant: planStateManager.phase4Variant,
      ...(availableAgentTypes ? { availableAgentTypes } : {}),
    }),
  ];
}

// ── getPlanModeReentryAttachment ──────────────────────────────────────────────

/**
 * Emit a one-shot plan_mode_reentry attachment when the user re-enters plan
 * mode after having previously exited it.
 *
 * Consumes the reentryPending flag from PlanStateManager (one-shot: returns
 * [] on all subsequent calls until enter() fires again after a new exit).
 */
export function getPlanModeReentryAttachment(
  ctx: AttachmentToolUseContext,
  externalCtx: AttachmentExternalContext | undefined,
  planStateManager: PlanStateManager,
): PlanModeReentryAttachment[] {
  // Bail out WITHOUT consuming the flag so it can be retried on the next turn.
  const plansDir = externalCtx?.plansDir;
  const sessionId = externalCtx?.sessionId;
  if (!plansDir || !sessionId) return [];

  if (!planStateManager.consumeReentryFlag()) return [];

  const planFilePath = planStateManager.getPlanFilePath(
    plansDir,
    sessionId,
    planScopedAgentId(ctx),
  );

  return [
    new PlanModeReentryAttachment({
      type: 'plan_mode_reentry' as const,
      planFilePath,
    }),
  ];
}

// ── getPlanModeExitAttachment ─────────────────────────────────────────────────

/**
 * Emit a one-shot plan_mode_exit attachment on the turn after plan mode exits.
 *
 * Consumes the exitAttachmentFlag from PlanStateManager.
 *
 * Race-condition guard: if the user re-entered plan mode before this turn ran
 * (permissionMode === 'plan'), we discard the flag and return [] to avoid
 * sending a misleading "you have exited plan mode" message while still in it.
 */
export function getPlanModeExitAttachment(
  ctx: AttachmentToolUseContext,
  externalCtx: AttachmentExternalContext | undefined,
  planStateManager: PlanStateManager,
): PlanModeExitAttachment[] {
  if (!planStateManager.consumeExitAttachmentFlag()) return [];

  // Plan state is managed by planStateManager, not by permissionMode value.
  if (planStateManager.isActive) return [];

  const plansDir = externalCtx?.plansDir;
  const sessionId = externalCtx?.sessionId;

  let planFilePath = '';
  let planExists = false;

  if (plansDir && sessionId) {
    planFilePath = planStateManager.getPlanFilePath(
      plansDir,
      sessionId,
      planScopedAgentId(ctx),
    );
    planExists = fileExistsSync(planFilePath);
  }

  return [
    new PlanModeExitAttachment({
      type: 'plan_mode_exit' as const,
      planFilePath,
      planExists,
    }),
  ];
}

// ── getPlanModeInterTurnAttachment ────────────────────────────────────────────

/**
 * Emit a plan_mode reminder between tool rounds (inter-turn).
 *
 * This is called by agent-loop after each tool-execution cycle to keep the model
 * aware it is still in plan mode, even deep into a long tool chain.
 *
 * Design constraints:
 *   - Does NOT touch throttle counters (those are human-turn only).
 *   - Reads the current plan-active state from getAttachments(), plus
 *     currentPlanFilePath and planModeJustEntered from ctx.
 *
 * Reminder type:
 *   - 'full'   when planModeJustEntered=true (first inter-turn after entering
 *              plan mode mid-turn via enter_plan_mode tool — model needs the
 *              complete 5-phase workflow instructions in the same turn)
 *   - 'sparse' for all subsequent inter-turn calls
 *
 * Returns [] when plan mode is not active.
 */
export function getPlanModeInterTurnAttachment(
  isPlanActive: boolean,
  isMainAgent?: boolean,
  planFilePath?: string,
  justEntered?: boolean,
  availableAgentTypes?: string[],
): PlanModeAttachment[] {
  if (!isPlanActive) return [];

  return [
    new PlanModeAttachment({
      type: 'plan_mode' as const,
      reminderType: justEntered ? 'full' : 'sparse',
      isActive: true,
      isSubAgent: !isMainAgent,
      planFilePath: planFilePath ?? '',
      planExists: false,
      ...(availableAgentTypes ? { availableAgentTypes } : {}),
    }),
  ];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns the agent ID to scope the plan file path to.
 * Main agent uses undefined (the root plan file); sub-agents use their own ID.
 */
function planScopedAgentId(ctx: AttachmentToolUseContext): string | undefined {
  return ctx.isMainAgent ? undefined : ctx.agentId;
}

/**
 * Count human turns since the last plan_mode or plan_mode_reentry attachment.
 *
 * Iterates backwards from the end of messages[]. Counts non-tool-result user
 * messages as "human turns". Stops when it hits a plan_mode, plan_mode_reentry,
 * or plan_mode_exit attachment (the exit boundary prevents scanning the entire
 * history in sessions that left plan mode long ago).
 */
function countTurnsSinceLastPlanAttachment(
  messages: readonly Message[] | undefined,
): {
  turnCount: number;
  foundPlanAttachment: boolean;
} {
  if (!messages || messages.length === 0) {
    return { turnCount: 0, foundPlanAttachment: false };
  }

  let turnCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];

    if (msg.type === 'attachment') {
      const { type } = msg.attachment;
      if (type === 'plan_mode' || type === 'plan_mode_reentry') {
        return { turnCount, foundPlanAttachment: true };
      }
      if (type === 'plan_mode_exit') break;
    } else if (
      msg.type === 'user' &&
      !msg.sourceToolAssistantUUID // skip tool-result user messages
    ) {
      turnCount++;
    }
  }

  return { turnCount, foundPlanAttachment: false };
}

/**
 * Count plan_mode attachments since the last plan_mode_exit (or from session
 * start if no exit has occurred).
 *
 * Drives the full/sparse cycling: count % N === 1 → full.
 * The cycle resets each time the user exits and re-enters plan mode.
 */
function countPlanAttachmentsSinceLastExit(
  messages: readonly Message[] | undefined,
): number {
  if (!messages || messages.length === 0) return 0;

  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];

    if (msg.type === 'attachment') {
      const { type } = msg.attachment;
      if (type === 'plan_mode_exit') break;
      if (type === 'plan_mode') count++;
    }
  }

  return count;
}

// ── getVerifyPlanReminderAttachment ───────────────────────────────────────────

/**
 * Emit a verify_plan_reminder attachment every 10 human turns after plan mode exit.
 *
 * Increments the turn counter and returns the attachment when the counter
 * hits a multiple of 10. Returns [] for all other turns and when still in
 * plan mode.
 *
 * @param planStateManager Session-scoped plan lifecycle state.
 */
export function getVerifyPlanReminderAttachment(
  planStateManager: PlanStateManager,
): VerifyPlanReminderAttachment[] {
  // Do not emit while still in plan mode.
  if (planStateManager.isActive) return [];

  planStateManager.incrementTurnsSincePlanExit();
  if (!planStateManager.shouldSendVerifyReminder()) return [];

  return [
    new VerifyPlanReminderAttachment({ type: 'verify_plan_reminder' as const }),
  ];
}
