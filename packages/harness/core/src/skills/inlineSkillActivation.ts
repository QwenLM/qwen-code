/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Shared inline skill activation logic — extracted from
 * `ActivateSkillToolInvocation.execute()` so both the slash-command path
 * (`SkillCommandLoader`) and the model-invoked path (`activate-skill.ts`)
 * share the same deterministic processing.
 *
 * Arguments are always passed as function parameters, never through model
 * inference.
 */

import { substituteSkillBody } from '../utils/argumentSubstitution.js';
import { getCwd } from '../utils/Shell.js';
import {
  executeShellCommandsInPrompt,
  SHELL_BLOCK_PATTERN,
  SHELL_INLINE_PATTERN,
} from '../utils/promptShellExecution.js';
import { ShellExecutionService } from '../services/shellExecutionService.js';
import {
  DEFAULT_SHELL_TYPE,
  type ShellType,
} from '../utils/shell/shellProvider.js';
import {
  clearFrontmatterHooks,
  registerFrontmatterHooks,
} from '../hooks/sessionHooks.js';
import {
  COMMAND_NAME_TAG,
  COMMAND_MESSAGE_TAG,
  SKILL_FORMAT_TAG,
  buildSlashCommandMetadata,
} from '../constants/xmlTags.js';
import { ToolErrorType } from '../tools/tool-error.js';
import type { Config } from '../config/config.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import type { Message } from '../protocol/transcript/message.js';
import { findSkillBodyInHistory } from './skillBodyInHistory.js';
import type { SkillDefinition } from '@qwen-code/resource';
import { isWorkflowSkill } from '../workflows/workflow-skills.js';
import { POWERSHELL_TOOL_NAME, SHELL_TOOL_NAME } from '../tools/tool-names.js';
import { AGENT_TOOL_NAME } from '../tools/definitions/base-declarations.js';
import { canSpawnSubagentAtDepth } from '../agents/subagent-limits.js';

// ============================================================================
// Public types
// ============================================================================

export interface InlineSkillActivationResult {
  /** Safe counters forwarded to the existing Skill activation event. */
  dedupTelemetry?: Record<string, unknown>;
  /** Invocation metadata kept separate from the hidden Skill instructions. */
  metadataContent: string;
  /** The skill content to inject as a user message (includes metadata + body + resources). */
  userMessageContent: string;
  /** Instructions or a re-invocation reminder, without invocation metadata. */
  skillBodyContent: string;
  /** Short success text the LLM sees as the tool result. */
  llmContent: string;
  /** Detailed display text shown in the UI. */
  returnDisplay: string;
  /** Skill-defined model/effort overrides (for contextModifier in tool path). */
  skillOverrides?: { model?: string; effort?: string };
  /** Mark the injected user message as meta (model-visible, UI-hidden). */
  isMeta?: boolean;
}

export interface InlineSkillActivationError {
  errorMessage: string;
  errorType: ToolErrorType;
}

export type InlineSkillActivationOutcome =
  | { ok: true; result: InlineSkillActivationResult }
  | { ok: false; error: InlineSkillActivationError };

export interface InlineSkillActivationOptions {
  /** History owned by the caller; defaults to the main session. */
  context?: Pick<AgentLoopContext, 'agentId' | 'getConversationMessages'>;
  toolNames?: readonly string[];
  /** Current caller depth; exact forks may retain Agent schemas at the cap. */
  agentDepth?: number;
  shellPermissionCheck?: ShellPermissionCheck;
  /** Skip the `disableModelInvocation` check (slash-command path). */
  skipDisableModelInvocationCheck?: boolean;
  /** Mark this activation as originating from a slash command (affects XML tag format). */
  isSlashCommand?: boolean;
}

/**
 * Optional callback to check whether a shell command is permitted before
 * execution. Returns `true` if allowed, `false` to block.
 */
export type ShellPermissionCheck = (
  command: string,
  shellType?: ShellType,
) => Promise<boolean>;

/** Skill grants can allow preprocessing, but cannot remove a parent's denies/clamp. */
export function createSkillShellPermissionCheck(
  config: Config,
  skill: SkillDefinition,
  context?: AgentLoopContext,
): ShellPermissionCheck | undefined {
  const permission = context ? context.permission : config.permission;
  return async (command, executionShell) => {
    if (!permission) return false;
    const declared = context?.permissionContext?.();
    const toolName =
      (executionShell ?? skill.shell ?? DEFAULT_SHELL_TYPE) === 'powershell'
        ? POWERSHELL_TOOL_NAME
        : SHELL_TOOL_NAME;
    const decision = await permission.check(
      {
        toolName,
        input: { command },
        toolUseId: `skill:${skill.name}:shell`,
      },
      {
        ...declared,
        ...(skill.allowedTools?.length
          ? {
              skillRules: {
                ...declared?.skillRules,
                grants: skill.allowedTools,
              },
            }
          : undefined),
      },
    );
    // This preprocessor executes the original text, not approval-time rewrites.
    return decision.kind === 'allow' && decision.input['command'] === command;
  };
}

// ============================================================================
// Shared metadata helpers
// ============================================================================

/**
 * Build the XML metadata tags prepended to skill content.
 * Used by both inline activation and subagent skill injection.
 *
 * Model-invoked / subagent: `<command-message>` + `<command-name>` + `<skill-format>true`
 * Slash-command:            `<command-message>` + `<command-name>/name` + optional `<command-args>`
 */
export function buildSkillMetadataTags(
  skillName: string,
  options?: { isSlashCommand?: boolean; args?: string },
): string {
  const isSlash = options?.isSlashCommand ?? false;
  if (isSlash) {
    return buildSlashCommandMetadata(skillName, options?.args);
  }
  const parts = [
    `<${COMMAND_MESSAGE_TAG}>${skillName}</${COMMAND_MESSAGE_TAG}>`,
    `<${COMMAND_NAME_TAG}>${skillName}</${COMMAND_NAME_TAG}>`,
  ];
  parts.push(`<${SKILL_FORMAT_TAG}>true</${SKILL_FORMAT_TAG}>`);
  return parts.join('\n');
}

// ============================================================================
// Module-level helper functions (extracted from ActivateSkillToolInvocation)
// ============================================================================

/**
 * Exported so `subagent-tool.ts` can reuse it for skill loading (Step 5).
 */
export async function prepareSkillBody(
  config: Config,
  skill: SkillDefinition,
  skillName: string,
  skillDir: string,
  args?: string,
  shellPermissionCheck?: ShellPermissionCheck,
  options?: InlineSkillActivationOptions,
): Promise<string> {
  // Dynamic body generator (bundled skills) — bypasses static template pipeline.
  if (skill.getBody) {
    const toolNames =
      options?.toolNames ??
      config
        .getToolRegistry()
        .getFunctionDeclarations(config.getModel())
        .flatMap((tool) => (tool.name ? [tool.name] : []));
    const context = {
      skillDir,
      sessionId: config.getSessionId?.() ?? '',
      toolNames: canSpawnSubagentAtDepth(options?.agentDepth ?? 0)
        ? toolNames
        : toolNames.filter((name) => name !== AGENT_TOOL_NAME),
    };
    return skill.getBody(args, context);
  }

  const rawSkillBody = substituteSkillBody(skill, {
    args,
    skillDir,
    sessionId: config.getSessionId?.() ?? '',
    pluginPath: skill.pluginPath,
    pluginId: skill.pluginId,
  });

  // SK54: If disableSkillShellExecution is set, replace shell commands with
  // a placeholder instead of executing them. Built-in skills are exempt.
  if (config.isSkillShellExecutionDisabled() && !skill.isBuiltin) {
    return replaceShellCommandsWithPlaceholder(rawSkillBody);
  }

  return executeShellInjection(
    config,
    rawSkillBody,
    skillName,
    skill.shell,
    shellPermissionCheck,
  );
}

/**
 * Builds the model-visible prompt for a skill. A filesystem-backed skill's
 * base directory is resource-location metadata, not a filesystem permission
 * grant. Built-in skills are programmatic and have no resource root to expose.
 */
export function buildSkillPromptContent(
  skill: SkillDefinition,
  skillBody: string,
): string {
  if (skill.isBuiltin || isWorkflowSkill(skill)) {
    return skillBody;
  }

  return `Base directory for this skill: ${skill.skillRoot}\n\n${skillBody}`;
}

/** Elide only a complete, byte-identical copy still in the caller's context. */
function elideUnchangedSkillBody(
  skillName: string,
  content: string,
  args: string | undefined,
  messages: readonly Message[],
  previousContent: string | undefined,
): string {
  if (!content || previousContent !== content) {
    return content;
  }

  const copy = findSkillBodyInHistory(messages, content);
  if (copy === 'body') {
    return `Skill /${skillName} is already loaded above; instructions unchanged. Follow those instructions for this invocation.${args ? ` Arguments: ${args}` : ''}`;
  }
  if (copy === 'attachment') {
    // Compact reminders describe historical invocations and explicitly forbid
    // repeating setup. Make the new invocation unambiguous when reusing one.
    return `Skill /${skillName} was loaded earlier (see the invoked-skills reminder above); this is a new invocation. Follow those instructions now, including any setup steps.${args ? ` Arguments: ${args}` : ''}`;
  }
  return content;
}

/**
 * Execute embedded shell commands in a skill body text.
 */
async function executeShellInjection(
  config: Config,
  body: string,
  skillName: string,
  shellType?: ShellType,
  shellPermissionCheck?: ShellPermissionCheck,
): Promise<string> {
  return executeShellCommandsInPrompt(
    body,
    async (command: string) => {
      const executionShell = shellType ?? DEFAULT_SHELL_TYPE;
      // Check permission before execution
      if (shellPermissionCheck) {
        const allowed = await shellPermissionCheck(command, executionShell);
        if (!allowed) {
          throw new Error(
            `Shell command permission denied for skill "${skillName}": ${command}`,
          );
        }
      }

      const shellConfig = config.getShellExecutionConfig();
      const { result: resultPromise } = await ShellExecutionService.execute(
        command,
        getCwd(),
        () => {}, // no streaming output needed
        AbortSignal.timeout(30_000), // 30s timeout per command
        {
          ...shellConfig,
          shellType: executionShell,
          sessionId: config.getSessionId?.() ?? 'default',
          pager: 'cat',
          preventCwdChanges: true,
          foregroundOnly: true,
        },
      );
      const result = await resultPromise;
      if (result.error) {
        throw new Error(
          `Command failed (exit ${result.exitCode}): ${result.output || result.error.message}`,
        );
      }
      return result.output?.trim() ?? '';
    },
    skillName,
  );
}

/**
 * SK54: Replace shell injection markers with a policy-disabled placeholder.
 */
function replaceShellCommandsWithPlaceholder(body: string): string {
  const DISABLED_MSG = '[shell command execution disabled by policy]';
  let result = body.replace(SHELL_BLOCK_PATTERN, DISABLED_MSG);
  if (result.includes('!`')) {
    result = result.replace(SHELL_INLINE_PATTERN, DISABLED_MSG);
  }
  return result;
}

// ============================================================================
// Main shared function
// ============================================================================

/**
 * Execute inline skill activation logic shared by both paths:
 * - Slash command path (`SkillCommandLoader`)
 * - Model invocation path (`ActivateSkillToolInvocation`)
 *
 * Performs all side effects: activateSkill, registerPolicies and registerHooks.
 * Returns the fully rendered skill content and display strings.
 */
export async function activateInlineSkill(
  config: Config,
  skillName: string,
  args?: string,
  options?: InlineSkillActivationOptions,
): Promise<InlineSkillActivationOutcome> {
  const skillManager = config.getSkillManager();
  const skill = skillManager.getSkill(skillName);

  // ── Validation ──────────────────────────────────────────────────────────
  if (!skill) {
    // Scope suggestions to what this caller may actually activate, so a retry
    // cannot land on a guaranteed rejection. A user may invoke skills the
    // model may not, hence the two different sets.
    const skills = options?.isSlashCommand
      ? skillManager.getDisplayableSkills()
      : skillManager.getModelVisibleSkills();
    const availableSkills = skills.map((s) => s.name).join(', ');
    const errorMessage = availableSkills
      ? `Skill "${skillName}" not found. Available skills are: ${availableSkills}`
      : `Skill "${skillName}" not found. No skills are available to activate.`;
    return {
      ok: false,
      error: { errorMessage, errorType: ToolErrorType.INVALID_TOOL_PARAMS },
    };
  }

  if (skill.disabled) {
    const errorMessage = `Skill "${skillName}" is unavailable.`;
    return {
      ok: false,
      error: { errorMessage, errorType: ToolErrorType.POLICY_VIOLATION },
    };
  }

  if (
    !options?.skipDisableModelInvocationCheck &&
    skill.disableModelInvocation
  ) {
    const errorMessage = `Skill "${skillName}" cannot be activated via the Skill tool due to disable-model-invocation`;
    return {
      ok: false,
      error: { errorMessage, errorType: ToolErrorType.POLICY_VIOLATION },
    };
  }

  const skillDir = skill.skillRoot;

  // ── Content building ────────────────────────────────────────────────────

  const skillBody = await prepareSkillBody(
    config,
    skill,
    skillName,
    skillDir,
    args,
    options?.shellPermissionCheck ??
      createSkillShellPermissionCheck(config, skill),
    options,
  );

  const skillBodyContent = buildSkillPromptContent(skill, skillBody);

  // Runtime state changes only after the Skill body has expanded successfully.
  // Slash commands, model tool calls, and structured user selection therefore
  // share the same activation boundary.
  await skillManager.recordUsage(skill.name);

  // Skill allowedTools are propagated through the current query's context
  // modifier rather than mutating session-wide tool policy.
  const hookSystem = config.getHookSystem?.();
  if (hookSystem) {
    const hookAgentId = `skill:${skillName}`;
    // Re-invocation replaces the Skill's hooks rather than appending duplicate
    // session registrations.
    clearFrontmatterHooks(hookSystem, hookAgentId);
    if (skill.hooks && Object.keys(skill.hooks).length > 0) {
      registerFrontmatterHooks(
        hookSystem,
        hookAgentId,
        skill.hooks,
        false,
        true,
      );
    }
  }

  // Cache the full model-visible prompt so post-compact recovery preserves
  // the resource-location metadata together with the rendered instructions.
  const agentId = options?.context?.agentId ?? 'main';
  const previousContent = skillManager.getRenderedBody?.(skill.name, agentId);
  skillManager.activateSkill(skill.name, skillBodyContent, agentId);

  // Build skill overrides for contextModifier (model-invoked path)
  const skillModel = skill.model;
  const skillEffort = skill.effort;
  const hasOverrides = skillModel || skillEffort !== undefined;
  const skillOverrides = hasOverrides
    ? {
        ...(skillModel ? { model: skillModel } : {}),
        ...(skillEffort !== undefined ? { effort: String(skillEffort) } : {}),
      }
    : undefined;

  // For built-in skills, hide internal file system paths from users and LLM
  const returnDisplayParts = [
    `Skill **${skillName}** activated.`,
    skill.model ? ` (preferred model: **${skill.model}**)` : '',
    skill.effort !== undefined ? ` (effort: **${skill.effort}**)` : '',
  ];

  // Build metadata tags.
  const isSlashCommand = options?.isSlashCommand ?? false;
  const metadataContent = buildSkillMetadataTags(skillName, {
    isSlashCommand,
    args,
  });

  // Compare after argument substitution and dynamic expansion. The activation
  // cache above must retain the full prompt for later compaction recovery.
  const context = options?.context ?? config;
  const injectedContent = elideUnchangedSkillBody(
    skill.name,
    skillBodyContent,
    args,
    context.getConversationMessages?.() ?? [],
    previousContent,
  );
  const dedupHit = injectedContent !== skillBodyContent;
  const userMessageContent = `${metadataContent}\n\n${injectedContent}`;
  const savedChars = dedupHit
    ? Array.from(skillBodyContent).length - Array.from(injectedContent).length
    : 0;

  return {
    ok: true,
    result: {
      dedupTelemetry: {
        skill_body_dedup_hit: dedupHit,
        skill_body_dedup_saved_chars: savedChars,
      },
      metadataContent,
      userMessageContent,
      skillBodyContent: injectedContent,
      llmContent: `Launching skill: ${skillName}`,
      returnDisplay: returnDisplayParts.join(''),
      skillOverrides,
      isMeta: true,
    },
  };
}
