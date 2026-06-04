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

import fs from 'node:fs';
import path from 'node:path';
import type { Content } from '@google/genai';
import { ApprovalMode, type Config } from '../config/config.js';
import {
  getAllGeminiMdFilenames,
  LOCAL_CONTEXT_FILENAME,
} from '../memory/const.js';
import type { PermissionDeniedReason } from '../hooks/types.js';
export type { PermissionDeniedReason } from '../hooks/types.js';
import { ToolNames } from '../tools/tool-names.js';
import { normalizeMonitorCommand } from '../utils/shell-utils.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { classifyAction, type ClassifierResult } from './classifier.js';
import { extractShellOperationsAcrossCommand } from './shell-semantics.js';
import {
  recordAllow,
  recordBlock,
  recordUnavailable,
  type AutoModeDenialState,
  type DenialFallbackReason,
} from './denialTracking.js';
import type { PermissionCheckContext } from './types.js';

const autoModeDebugLogger = createDebugLogger('AUTO_MODE');

const RAW_PROTECTED_WRITE_COMMANDS =
  /\b(?:cp|mv|install|rsync|patch|perl|sed|sort)\b/;

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

const PROTECTED_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  ToolNames.EDIT,
  ToolNames.WRITE_FILE,
  ToolNames.NOTEBOOK_EDIT,
]);

const SHELL_LIKE_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  ToolNames.SHELL,
  ToolNames.MONITOR,
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
 * Workspace paths that can affect later execution and must not take the
 * acceptEdits fast-path. Specific edits can still pass through the AUTO
 * classifier or an explicit `permissions.allow` rule.
 */
const PERSISTENCE_PATH_PATTERNS: readonly RegExp[] = Object.freeze([
  /(^|\/)\.git(?:\/|$)/, // git config, hooks, alias, and worktree .git files
  /(^|\/)\.husky\//, // git hooks via husky
  /(^|\/)package\.json$/, // npm scripts (root + nested workspaces)
  /(^|\/)\.npmrc$/, // registry override → malicious package fetch on next install
  /(^|\/)(makefile|gnumakefile)$/, // make targets
  /(^|\/)\.?justfile$/, // just task runner
  /(^|\/)taskfile\.ya?ml$/, // go-task
  /(^|\/)\.github\/workflows\//, // CI workflow definitions
]);

const SELF_MODIFICATION_PATH_PATTERNS: readonly RegExp[] = Object.freeze([
  /(^|\/)\.qwen\/settings(?:\.[^/]*)?\.json$/,
  /(^|\/)(qwen|agents)\.md$/,
  /(^|\/)\.qwen\/qwen\.local\.md$/,
  /(^|\/)\.qwen\/rules(?:\/|$)/,
  /(^|\/)\.qwen\/commands(?:\/|$)/,
  /(^|\/)\.qwen\/agents(?:\/|$)/,
  /(^|\/)\.qwen\/skills(?:\/|$)/,
  /(^|\/)\.qwen\/hooks(?:\/|$)/,
  /(^|\/)\.mcp\.json$/,
]);

function normalizePathForAutoModePattern(filePath: string): string {
  return filePath.replace(/\\/g, '/').toLowerCase();
}

function trimPathSlashes(filePath: string): string {
  let start = 0;
  let end = filePath.length;
  while (start < end && filePath[start] === '/') start++;
  while (end > start && filePath[end - 1] === '/') end--;
  return filePath.slice(start, end);
}

function matchesConfiguredContextFile(normalizedPath: string): boolean {
  return [...getAllGeminiMdFilenames(), LOCAL_CONTEXT_FILENAME].some(
    (filename) => {
      const normalizedFilename = trimPathSlashes(
        normalizePathForAutoModePattern(filename),
      );
      if (!normalizedFilename) return false;
      return (
        normalizedPath === normalizedFilename ||
        normalizedPath.endsWith(`/${normalizedFilename}`)
      );
    },
  );
}

let qwenHomePrefixesCacheKey: string | undefined;
let qwenHomePrefixesCache: string[] | undefined;

function getNormalizedQwenHomePrefixes(): string[] {
  const qwenHome = process.env['QWEN_HOME'];
  if (!qwenHome) return [];
  if (
    qwenHomePrefixesCacheKey === qwenHome &&
    qwenHomePrefixesCache !== undefined
  ) {
    return qwenHomePrefixesCache;
  }

  const candidates = new Set<string>([path.resolve(qwenHome)]);
  if (qwenHome.startsWith('/') || /^[A-Za-z]:[\\/]/.test(qwenHome)) {
    candidates.add(qwenHome);
  }
  try {
    candidates.add(fs.realpathSync.native(qwenHome));
  } catch {
    // QWEN_HOME may not exist yet; the configured path still matters.
  }

  const prefixes = [...candidates].map((candidate) =>
    normalizePathForAutoModePattern(candidate).replace(/\/+$/, ''),
  );
  qwenHomePrefixesCacheKey = qwenHome;
  qwenHomePrefixesCache = prefixes;
  return prefixes;
}

function matchesQwenHomeSurface(normalizedPath: string): boolean {
  for (const normalizedQwenHome of getNormalizedQwenHomePrefixes()) {
    const qwenHomePrefix = `${normalizedQwenHome}/`;
    if (!normalizedPath.startsWith(qwenHomePrefix)) continue;

    const relativePath = normalizedPath.slice(qwenHomePrefix.length);
    if (
      /^settings(?:\.[^/]*)?\.json$/.test(relativePath) ||
      /^qwen\.local\.md$/.test(relativePath) ||
      /^\.mcp\.json$/.test(relativePath) ||
      /^(rules|commands|agents|skills|hooks)(?:\/|$)/.test(relativePath)
    ) {
      return true;
    }
  }

  return false;
}

function getAutoModeWritePathCandidates(filePath: string): string[] {
  const candidates = new Set<string>([filePath]);

  try {
    candidates.add(fs.realpathSync.native(filePath));
  } catch {
    const parentDir = path.dirname(filePath);
    try {
      candidates.add(
        path.join(fs.realpathSync.native(parentDir), path.basename(filePath)),
      );
    } catch {
      // Best-effort only: new files often do not exist yet, and the raw path
      // still catches direct protected-path writes.
    }
  }

  return [...candidates];
}

export function isAutoModeProtectedWritePath(filePath: string): boolean {
  return getAutoModeWritePathCandidates(filePath).some((candidate) => {
    const normalized = normalizePathForAutoModePattern(candidate);
    return (
      matchesConfiguredContextFile(normalized) ||
      matchesQwenHomeSurface(normalized) ||
      PERSISTENCE_PATH_PATTERNS.some((pattern) => pattern.test(normalized)) ||
      SELF_MODIFICATION_PATH_PATTERNS.some((pattern) =>
        pattern.test(normalized),
      )
    );
  });
}

/**
 * Returns true when an L4 `allow` verdict must still pass through the AUTO
 * classifier because it writes protected configuration or instruction paths.
 */
export function shouldForceAutoModeReviewForAllow(
  ctx: PermissionCheckContext,
  cwdFallback = process.cwd(),
): boolean {
  if (
    PROTECTED_WRITE_TOOL_NAMES.has(ctx.toolName) &&
    ctx.filePath &&
    isAutoModeProtectedWritePath(ctx.filePath)
  ) {
    return true;
  }

  if (!SHELL_LIKE_TOOL_NAMES.has(ctx.toolName) || !ctx.command) return false;

  // Monitor wraps the user command; analyze the same payload used by
  // PermissionManager.
  const command =
    ctx.toolName === ToolNames.MONITOR
      ? normalizeMonitorCommand(ctx.command).safetyCommand
      : ctx.command;
  const cwd = ctx.cwd ?? cwdFallback;

  if (hasRawProtectedRedirect(command, cwd)) return true;
  if (hasRawProtectedWriteCommand(command, cwd)) return true;

  return extractShellOperationsAcrossCommand(command, cwd).some((op) => {
    if (
      op.virtualTool !== ToolNames.EDIT &&
      op.virtualTool !== ToolNames.WRITE_FILE
    ) {
      return false;
    }
    if (op.cwdUnknown && op.pathMayDependOnCwd) {
      return true;
    }
    return Boolean(op.filePath && isAutoModeProtectedWritePath(op.filePath));
  });
}

function hasRawProtectedRedirect(command: string, cwd: string): boolean {
  for (let i = 0; i < command.length; i++) {
    if (command[i] !== '>') continue;
    if (command[i - 1] === '<') continue;
    while (command[i] === '>' || command[i] === '|' || command[i] === '&') {
      i++;
    }
    while (command[i] === ' ' || command[i] === '\t') i++;

    let token = '';
    while (i < command.length) {
      const ch = command[i]!;
      if (/\s|[;&|]/.test(ch)) break;
      token += ch;
      i++;
    }

    const target = stripRawRedirectTargetToken(token);
    if (!target || target.startsWith('&')) continue;
    const resolved = path.isAbsolute(target) ? target : path.join(cwd, target);
    if (isAutoModeProtectedWritePath(resolved)) return true;
  }
  return false;
}

function hasRawProtectedWriteCommand(command: string, cwd: string): boolean {
  for (const line of command.split('\n')) {
    if (!RAW_PROTECTED_WRITE_COMMANDS.test(line)) continue;
    for (const rawToken of line.split(/\s+/)) {
      const target = stripRawRedirectTargetToken(rawToken).replace(
        /^[({]+|[),;]+$/g,
        '',
      );
      if (!target || target.startsWith('-')) continue;
      const resolved = path.isAbsolute(target)
        ? target
        : path.join(cwd, target);
      if (isAutoModeProtectedWritePath(resolved)) return true;
    }
  }
  return false;
}

function stripRawRedirectTargetToken(token: string): string {
  let start = 0;
  let end = token.length;

  while (
    start < end &&
    (token[start] === "'" || token[start] === '"' || token[start] === '$')
  ) {
    if (token[start] === '$' && token[start + 1] !== "'") break;
    start++;
  }

  while (end > start) {
    const ch = token[end - 1];
    if (ch !== "'" && ch !== '"' && ch !== ')' && ch !== '&') break;
    end--;
  }

  return token.slice(start, end);
}

/**
 * Returns true when the pending action is a file edit / write targeting a
 * path that lies within the current workspace (cwd + additional directories)
 * AND is not rejected by {@link isAutoModeProtectedWritePath} (covers
 * persistence paths and Qwen self-modification surfaces, including symlinks
 * whose realpath resolves to a protected target).
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
  // Persistence paths (hooks, package.json scripts, CI definitions) and
  // Qwen self-modification surfaces (.qwen/settings*.json, configured context
  // files, .qwen/rules|commands|agents|skills|hooks/, .mcp.json) must never
  // auto-approve via fast-path — the former execute code on subsequent tooling
  // operations, the latter let an agent rewrite its own permissions or
  // instructions.
  if (isAutoModeProtectedWritePath(ctx.filePath)) {
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
  | { via: 'fallback'; reason: FallbackToAskReason };

/**
 * Reasons AUTO mode itself is unavailable before a per-call decision can run.
 * Kept distinct from per-call fallback and classifier-denial reasons.
 */
export type AutoModeUnavailableReason =
  | 'circuit-breaker'
  | 'disabled'
  | 'policy';

/**
 * Reasons a call falls through to manual approval even though AUTO mode is on.
 * This is not a denial: the user may still approve the pending request.
 */
export type FallbackToAskReason =
  | 'safety_check'
  | 'ask_rule'
  | 'plan_mode_floor'
  | 'org_ask_ceiling'
  | DenialFallbackReason;

/** Outcome of {@link applyAutoModeDecision}. */
export type AutoModeOutcome =
  | { kind: 'approved' }
  | {
      kind: 'blocked';
      errorMessage: string;
      reason: PermissionDeniedReason;
    }
  | { kind: 'fallback'; reason: FallbackToAskReason };

/**
 * Apply an AUTO decision and denial-tracking update. Shared by the scheduler
 * and ACP paths; callers still handle their integration-specific responses.
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
          reason: decision.unavailable
            ? 'classifier_unavailable'
            : 'classifier_blocked',
        };
      }
      config.setAutoModeDenialState(recordAllow(denialState));
      return { kind: 'approved' };
    case 'fallback':
      return { kind: 'fallback', reason: decision.reason };
    default: {
      const _exhaustive: never = decision;
      // Make unexpected JS/interop values visible at runtime.
      autoModeDebugLogger.error(
        `Auto mode: unrecognised decision.via "${(decision as { via: string }).via}" — falling through to manual approval`,
      );
      void _exhaustive;
      return { kind: 'fallback', reason: 'safety_check' };
    }
  }
}

export function shouldFirePermissionDeniedForAutoMode(
  decision: AutoModeDecision,
  outcome: AutoModeOutcome,
): decision is Extract<AutoModeDecision, { via: 'classifier' }> {
  // The type predicate narrows callers to classifier decisions so reason
  // mapping can safely read classifier-only fields such as `unavailable`.
  return (
    decision.via === 'classifier' &&
    decision.shouldBlock &&
    outcome.kind === 'blocked'
  );
}

export function getAutoModePermissionDeniedReason(
  decision: Extract<AutoModeDecision, { via: 'classifier' }>,
): PermissionDeniedReason {
  return decision.unavailable ? 'classifier_unavailable' : 'classifier_blocked';
}

/**
 * Trailing guidance appended to every classifier-denial tool-result message.
 * Centralised so the policy boundary (no silent retries, no equivalent-path
 * workarounds, stop and ask the user) is identical for "blocked" and
 * "unavailable" verdicts and stays in sync with the main system prompt's
 * Denied Tool Calls rule.
 */
export const AUTO_MODE_DENIAL_GUIDANCE =
  'Do not try to complete the denied action through another tool, shell indirection, generated script, alias, symlink, config change, hook, command file, MCP configuration, encoded payload, or equivalent path. If that action is required, stop and ask the user for explicit approval. You may continue with unrelated safe work or a genuinely safer alternative that does not accomplish the denied action.';

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
    const message = decision.reason
      ? `Auto mode classifier unavailable (${decision.reason}); action blocked for safety`
      : `Auto mode classifier unavailable; action blocked for safety`;
    return `${message}\n${AUTO_MODE_DENIAL_GUIDANCE}`;
  }
  return `Permission for this action has been denied. Reason: ${decision.reason}\n${AUTO_MODE_DENIAL_GUIDANCE}`;
}

export interface EvaluateAutoModeInput {
  ctx: PermissionCheckContext;
  /** True when a user-provided `permissions.ask` rule matched this call. */
  pmForcedAsk: boolean;
  /** Raw tool params (forwarded to the classifier). */
  toolParams: Record<string, unknown>;
  /** Main session message history. */
  messages: readonly Content[];
  config: Config;
  signal: AbortSignal;
  /**
   * When present, the L5.3 classifier is skipped and an unmatched call
   * resolves to `{ via: 'fallback', reason: skipClassifierReason }`.
   * Used by the scheduler to short-circuit classifier dispatch when
   * denialTracking has already armed a fallback to manual approval —
   * while still letting safe tools take the L5.1 / L5.2 fast-paths.
   */
  skipClassifierReason?: DenialFallbackReason;
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

  // User `ask` rules require manual confirmation.
  if (input.pmForcedAsk) {
    return { via: 'fallback', reason: 'ask_rule' };
  }

  // Caller (scheduler) has detected an armed fallback state; surface that
  // so the call drops to manual approval instead of burning a classifier
  // request that would deepen the denial streak.
  if (input.skipClassifierReason) {
    return { via: 'fallback', reason: input.skipClassifierReason };
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
