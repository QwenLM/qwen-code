/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUTO approval mode three-layer filter.
 *
 * Layer 1 (L5.1): acceptEdits fast-path — Edit/Write targeting a path inside
 *   the workspace are auto-allowed without invoking the classifier.
 * Layer 2 (L5.2): safe-tool allowlist — built-in read-only / metadata tools
 *   are auto-allowed without invoking the classifier.
 * Layer 3 (L5.3): LLM classifier — see `classifier.ts` (wired in by the
 *   top-level `evaluateAutoMode` orchestrator).
 *
 * All three layers only fire when L4 PermissionManager returned `'default'`
 * (no rule matched). When L4 returns `'ask'` (user wrote an explicit ask
 * rule) the fast-paths are skipped — user intent takes precedence.
 */

import type { Content } from '@google/genai';
import { ApprovalMode, type Config } from '../config/config.js';
import { ToolNames } from '../tools/tool-names.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { classifyAction, type ClassifierResult } from './classifier.js';
import {
  recordAllow,
  recordBlock,
  recordUnavailable,
  type AutoModeDenialState,
} from './denialTracking.js';
import type { PermissionCheckContext } from './types.js';

const autoModeDebugLogger = createDebugLogger('AUTO_MODE');

/**
 * Built-in tools whose any-parameter behavior is safe under the AUTO mode
 * classifier's threat model — they never write files, never perform network
 * calls, and never execute arbitrary code.
 *
 * MCP tools are intentionally excluded (third-party code, cannot be statically
 * trusted regardless of name).
 */
export const SAFE_TOOL_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  // Read-only file / search
  ToolNames.READ_FILE,
  ToolNames.GREP,
  ToolNames.GLOB,
  ToolNames.LS,
  ToolNames.LSP,
  // Tool introspection
  ToolNames.TOOL_SEARCH,
  // Output / session metadata
  ToolNames.TODO_WRITE,
  ToolNames.STRUCTURED_OUTPUT,
  // Inverse tools — hand control back to the user
  ToolNames.ASK_USER_QUESTION,
  ToolNames.EXIT_PLAN_MODE,
  // Background task coordination (peers' permission checks still apply)
  ToolNames.CRON_LIST,
  ToolNames.TASK_STOP,
  // `send_message` is intentionally NOT in the allowlist: it injects
  // arbitrary text into another running agent as a new instruction. The
  // classifier MUST see the destination + message content so it can
  // judge whether the inter-agent message is steering a peer toward
  // destructive or exfiltrating actions.
]);

/**
 * Returns true when `toolName` is a built-in tool whose every legal parameter
 * combination is safe enough to skip the classifier. Caller should only
 * consult this when L4 evaluation returned `'default'` — explicit user rules
 * still take precedence.
 */
export function isInSafeToolAllowlist(toolName: string): boolean {
  return SAFE_TOOL_ALLOWLIST.has(toolName);
}

/** Edit / Write tool names eligible for the acceptEdits fast-path. */
const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  ToolNames.EDIT,
  ToolNames.WRITE_FILE,
]);

/**
 * Predicate for whether the AUTO mode L5 branch should run for a given call.
 * Centralizes the rule "only when the session is in AUTO and the tool isn't
 * one that always needs direct user attention". Used by both the CLI
 * scheduler and the ACP Session path so they stay in sync.
 */
export function shouldRunAutoModeForCall(
  approvalMode: ApprovalMode,
  toolName: string,
): boolean {
  if (approvalMode !== ApprovalMode.AUTO) return false;
  if (toolName === ToolNames.ASK_USER_QUESTION) return false;
  if (toolName === ToolNames.EXIT_PLAN_MODE) return false;
  return true;
}

/**
 * Paths inside the workspace that nevertheless execute code on subsequent
 * tooling operations (git commit, npm install, CI runs, …) and must NOT
 * take the acceptEdits fast-path. Without this list, a hostile AGENTS.md
 * could instruct the agent to write `.git/hooks/pre-commit` → fast-path
 * approves (it's in workspace) → next `git commit` runs arbitrary code
 * without classifier review.
 *
 * Edits to these paths still pass through the AUTO classifier; users
 * who want to allow specific hook/script edits can add an explicit
 * `permissions.allow` rule.
 */
const PERSISTENCE_PATH_PATTERNS: readonly RegExp[] = Object.freeze([
  /(^|\/)\.git\//, // git config, hooks, alias — covers .git/hooks/* and .git/config
  /(^|\/)\.husky\//, // git hooks via husky
  /(^|\/)package\.json$/, // npm scripts (root + nested workspaces)
  /(^|\/)\.npmrc$/, // registry override → malicious package fetch on next install
  /(^|\/)(Makefile|makefile|GNUmakefile)$/, // make targets
  /(^|\/)\.?[Jj]ustfile$/, // just task runner
  /(^|\/)Taskfile\.ya?ml$/, // go-task
  /(^|\/)\.github\/workflows\//, // CI workflow definitions
]);

/**
 * Returns true when the pending action is a file edit / write targeting a
 * path that lies within the current workspace (cwd + additional directories)
 * AND is NOT in {@link PERSISTENCE_PATH_PATTERNS}.
 *
 * Symlinks ARE resolved via `WorkspaceContext.isPathWithinWorkspace`, which
 * internally calls `fs.realpathSync`. A symlink whose target is outside the
 * workspace correctly fails this check and falls through to the classifier
 * — fail-safe by implementation.
 *
 * Caller should only consult this when L4 evaluation returned `'default'`.
 */
export function passesAcceptEditsFastPath(
  ctx: PermissionCheckContext,
  config: Config,
): boolean {
  if (!EDIT_TOOL_NAMES.has(ctx.toolName)) return false;
  if (!ctx.filePath) return false;
  // Persistence paths (hooks, package.json scripts, CI definitions) must
  // never auto-approve via fast-path — they execute code on subsequent
  // tooling operations.
  if (PERSISTENCE_PATH_PATTERNS.some((p) => p.test(ctx.filePath!))) {
    return false;
  }
  return config.getWorkspaceContext().isPathWithinWorkspace(ctx.filePath);
}

// ─── Top-level orchestrator ───────────────────────────────────────────────

/**
 * Unified decision returned by {@link evaluateAutoMode}.
 *
 * `via` records which layer produced the verdict; for `'classifier'` calls
 * the additional `shouldBlock`, `reason`, and `unavailable` fields surface
 * the classifier's verdict to the scheduler / UI / denialTracking.
 */
export type AutoModeDecision =
  | { via: 'fast-path:accept-edits' }
  | { via: 'fast-path:allowlist' }
  | {
      via: 'classifier';
      shouldBlock: boolean;
      reason: string;
      unavailable: boolean;
      stage: 'fast' | 'thinking';
      durationMs: number;
    }
  | { via: 'fallback' };

/**
 * Outcome of {@link applyAutoModeDecision}. Boils the union of
 * `AutoModeDecision` plus denial-tracking state updates down to a
 * three-way "what should the caller do" instruction so the scheduler /
 * ACP paths share one decision handler instead of duplicating the
 * switch + state-update boilerplate.
 */
export type AutoModeOutcome =
  | { kind: 'approved' }
  | { kind: 'blocked'; errorMessage: string }
  | { kind: 'fallback' };

/**
 * Apply an {@link AutoModeDecision} to denial-tracking state and return
 * an outcome the caller can act on. Shared between
 * `coreToolScheduler.ts` and `acp-integration/session/Session.ts` — the
 * switch on `decision.via`, the `recordAllow / recordBlock /
 * recordUnavailable` updates, and the formatted block message used to
 * all be duplicated line-for-line across the two files. Drift between
 * those copies was a recurring class of bug across PR #4151 review
 * rounds; this helper makes the two paths share one source of truth.
 *
 * Callers retain responsibility for the surrounding integration
 * (marking the tool call scheduled vs writing an error response,
 * logging the fallback reason with denial-state context, etc.) — those
 * pieces differ between scheduler and Session.
 */
export function applyAutoModeDecision(
  decision: AutoModeDecision,
  config: Config,
  denialState: AutoModeDenialState,
): AutoModeOutcome {
  switch (decision.via) {
    case 'fast-path:accept-edits':
    case 'fast-path:allowlist':
      config.setAutoModeDenialState(recordAllow(denialState));
      return { kind: 'approved' };
    case 'classifier':
      if (decision.shouldBlock) {
        config.setAutoModeDenialState(
          decision.unavailable
            ? recordUnavailable(denialState)
            : recordBlock(denialState),
        );
        return {
          kind: 'blocked',
          errorMessage: formatClassifierBlockMessage(decision),
        };
      }
      config.setAutoModeDenialState(recordAllow(denialState));
      return { kind: 'approved' };
    case 'fallback':
      return { kind: 'fallback' };
    default: {
      const _exhaustive: never = decision;
      // Surface drift at runtime — TS exhaustiveness can be bypassed
      // via `as` cast / JS interop / partial build. Without this log
      // every tool call would silently degrade to manual approval with
      // zero operator-visible signal.
      autoModeDebugLogger.error(
        `Auto mode: unrecognised decision.via "${(decision as { via: string }).via}" — falling through to manual approval`,
      );
      void _exhaustive;
      return { kind: 'fallback' };
    }
  }
}

/**
 * Build the tool-error message the scheduler / ACP session returns when
 * the classifier blocks or is unavailable. Shared between
 * `coreToolScheduler.ts` and `acp-integration/session/Session.ts` so the
 * CLI and ACP paths surface identical diagnostic signal to operators
 * (context overflow vs API timeout vs construction failure).
 *
 * Callers are responsible for only invoking this on classifier verdicts —
 * `decision.via === 'classifier'` with `decision.shouldBlock === true`.
 */
export function formatClassifierBlockMessage(
  decision: Extract<AutoModeDecision, { via: 'classifier' }>,
): string {
  if (decision.unavailable) {
    return decision.reason
      ? `Auto mode classifier unavailable (${decision.reason}); action blocked for safety`
      : `Auto mode classifier unavailable; action blocked for safety`;
  }
  return `Blocked by auto mode policy: ${decision.reason}`;
}

export interface EvaluateAutoModeInput {
  ctx: PermissionCheckContext;
  /**
   * True when L4 PermissionManager forced `'ask'` because the user wrote
   * an explicit ask rule that matched this call. When `true`, fast-paths
   * must be skipped so the user's explicit intent is honored.
   *
   * Comes from `PermissionFlowResult.pmForcedAsk` (set by L4 in
   * `evaluatePermissionRules` when a user-provided ask rule matched).
   *
   * False here covers both "no user rule matched at all" (L4 returned
   * `'default'`) AND "tool's intrinsic L3 default was `'ask'` and the
   * user has no rule" — both cases should still hit the fast-paths
   * because the user hasn't expressed a contrary intent.
   */
  pmForcedAsk: boolean;
  /** Raw tool params (forwarded to the classifier). */
  toolParams: Record<string, unknown>;
  /** Main session message history. */
  messages: readonly Content[];
  config: Config;
  signal: AbortSignal;
  /**
   * When true, the L5.3 classifier is skipped and an unmatched call
   * resolves to `{ via: 'fallback' }`. Used by the scheduler to short-
   * circuit classifier dispatch when denialTracking has already armed a
   * fallback to manual approval — while still letting safe tools take
   * the L5.1 / L5.2 fast-paths.
   */
  skipClassifier?: boolean;
}

/**
 * Resolve a pending tool call under AUTO mode by walking the three-layer
 * filter in order. Caller must have already determined that L4 did not
 * resolve the call to `allow` or `deny` — `evaluateAutoMode` only runs
 * when L4 produced `'ask'` (tool's intrinsic default OR user-forced) or
 * `'default'`.
 */
export async function evaluateAutoMode(
  input: EvaluateAutoModeInput,
): Promise<AutoModeDecision> {
  // L5.1: edits within the workspace skip the classifier. We only short-
  // circuit when the user has NOT explicitly forced an ask rule; an
  // intrinsic L3 'ask' (e.g. EditTool's default) does not block the
  // fast-path, otherwise the fast-path would be dead code for the very
  // tools it's designed to cover.
  if (
    !input.pmForcedAsk &&
    passesAcceptEditsFastPath(input.ctx, input.config)
  ) {
    return { via: 'fast-path:accept-edits' };
  }

  // L5.2: hardcoded safe-tool allowlist. Same gate as L5.1.
  if (!input.pmForcedAsk && isInSafeToolAllowlist(input.ctx.toolName)) {
    return { via: 'fast-path:allowlist' };
  }

  // User wrote an explicit `permissions.ask` rule matching this call —
  // honor that intent and route to manual confirmation instead of letting
  // the classifier auto-approve. The fast-paths above already opt out for
  // the same reason; the classifier path was the missing leg.
  // (auto-mode.md documents this as "ask rules force manual confirmation".)
  if (input.pmForcedAsk) {
    return { via: 'fallback' };
  }

  // Caller (scheduler) has detected an armed fallback state; surface that
  // so the call drops to manual approval instead of burning a classifier
  // request that would deepen the denial streak.
  if (input.skipClassifier) {
    return { via: 'fallback' };
  }

  // L5.3: two-stage LLM classifier.
  // Forward the messages array by reference — buildClassifierContents only
  // reads it. The previous spread `[...input.messages]` was a redundant
  // allocation on every classifier call.
  const result: ClassifierResult = await classifyAction({
    toolName: input.ctx.toolName,
    toolParams: input.toolParams,
    messages: input.messages,
    config: input.config,
    signal: input.signal,
  });

  return {
    via: 'classifier',
    shouldBlock: result.shouldBlock,
    reason: result.reason,
    unavailable: result.unavailable === true,
    stage: result.stage,
    durationMs: result.durationMs,
  };
}
