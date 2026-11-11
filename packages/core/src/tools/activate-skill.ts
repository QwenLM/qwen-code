/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { MODEL_ONLY_HINTS } from '../codemode/types.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type SkillResult,
  type ToolResult,
  type ToolInvocation,
  type ToolLiveOutput,
} from './tools.js';
import type { Config } from '../config/config.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import type { ToolUseContext } from './tool-types.js';
import { SKILL_TOOL_NAME } from './tool-names.js';
import { ToolErrorType } from './tool-error.js';
import { createToolParameterDiagnosticData } from './tool-parameter-diagnostics.js';
import { getActivateSkillDeclaration } from './definitions/dynamic-declaration-helpers.js';
import {
  registerFrontmatterHooks,
  clearFrontmatterHooks,
} from '../hooks/sessionHooks.js';
import type { BusinessInfo } from '../qoder/business-info.js';
import type { QueryEvent } from '../core/query-event.js';
import {
  buildAutoApproveAgentContext,
  resolveSkillForkAgent,
} from '../agents/agent-context-factory.js';
import {
  buildSubagentRegistries,
  buildSubagentSystemPrompt,
  type SubagentRegistries,
} from '../agents/agent-setup.js';
import { runSubagent } from '../agents/run-subagent.js';
import { createAgentId } from '../utils/agentId.js';
import { getCustomContextFromContext } from '../utils/sessionIdContext.js';
import { ProgressTracker } from '../agents/progressTracker.js';
import type { SkillDefinition } from '@qwen-code/resource';
import type { LocalAgentDefinition } from '../agents/types.js';
import {
  buildSkillPromptContent,
  activateInlineSkill,
  prepareSkillBody,
  createSkillShellPermissionCheck,
} from '../skills/inlineSkillActivation.js';
import { COMPLETE_TASK_TOOL_NAME } from './definitions/base-declarations.js';
import { boundedProducerPayload } from './producer-result-bounds.js';
import { ROOT_TOOL_CALL_SCOPE_ID } from '../tool-executor/types.js';
import { resolveAgentReasoning } from '../utils/frontmatterParsers.js';

/**
 * Constructs a default LocalAgentDefinition for skill fork execution
 * when no agent definition is resolved from configuration.
 */
function buildDefaultSkillForkDefinition(): LocalAgentDefinition {
  return {
    kind: 'local',
    name: 'skill-fork',
    description: 'Forked skill execution',
    modelConfig: { model: 'inherit' },
    promptConfig: { systemPrompt: '', query: '${request}' },
    runConfig: { maxTurns: 10 },
  };
}

function buildInlineSkillResult(skill: SkillDefinition): SkillResult {
  return {
    success: true,
    commandName: skill.name,
    ...(skill.allowedTools?.length && { allowedTools: skill.allowedTools }),
    ...(skill.model && { model: skill.model }),
    status: 'inline',
  };
}

function buildForkedSkillPayloadResult(
  skillName: string,
  summary: string,
  result: string,
): SkillResult {
  const boundedResult = boundedProducerPayload(result);
  return {
    success: true,
    commandName: skillName,
    status: 'forked',
    result: boundedResult,
  };
}

function getSkillForkAllowedTools(
  skill: SkillDefinition,
  definition: LocalAgentDefinition,
): string[] | undefined {
  if (skill.allowedTools && skill.allowedTools.length > 0) {
    return skill.allowedTools;
  }

  const definitionTools = definition.toolConfig?.tools.filter(
    (tool): tool is string => typeof tool === 'string',
  );
  return definitionTools && definitionTools.length > 0
    ? definitionTools
    : undefined;
}

function applySkillAllowedToolOverride(
  definition: LocalAgentDefinition,
  allowedTools: readonly string[] | undefined,
  hasSkillAllowedTools: boolean,
): LocalAgentDefinition {
  if (!hasSkillAllowedTools || !allowedTools || allowedTools.length === 0) {
    return definition;
  }
  return {
    ...definition,
    toolConfig: {
      tools: [...allowedTools],
    },
  };
}

/**
 * Shared setup → execute → cleanup logic for forked skill execution.
 * Both the direct (slash command) and Tool-lifecycle paths delegate here.
 *
 * Uses the unified subagent pipeline: buildSubagentRegistries() → runSubagent(),
 * aligned with how named subagents are executed via runAgent().
 */
async function runForkedSkillCore(
  config: Config,
  skill: SkillDefinition,
  args: string | undefined,
  signal: AbortSignal,
  onEvent?: (event: QueryEvent) => void,
  parentRequestSetId?: string,
  parentBusinessInfo?: Readonly<BusinessInfo>,
  parentContext?: AgentLoopContext,
  customContext?: Readonly<Record<string, string>>,
): Promise<string> {
  const skillName = skill.name;
  const skillDir = skill.skillRoot;

  await config.getSkillManager().recordUsage(skillName);

  const skillBody = await prepareSkillBody(
    config,
    skill,
    skillName,
    skillDir,
    args,
    createSkillShellPermissionCheck(config, skill, parentContext),
  );
  const skillPrompt = buildSkillPromptContent(skill, skillBody);

  // Fallback chain: skill.agent → first local agent → default definition.
  const resolvedAgent = resolveSkillForkAgent(config, skill.agent);
  let effectiveDefinition: LocalAgentDefinition =
    resolvedAgent ?? buildDefaultSkillForkDefinition();

  const requestedReasoning = resolveAgentReasoning(skill.effort, undefined);

  const effectiveAllowedTools = getSkillForkAllowedTools(
    skill,
    effectiveDefinition,
  );
  effectiveDefinition = applySkillAllowedToolOverride(
    effectiveDefinition,
    effectiveAllowedTools,
    Boolean(skill.allowedTools?.length),
  );

  // Resolve the model before it reaches inference. The agent definition may
  // carry the 'inherit' sentinel (general-purpose agent / default fork
  // definition), which means "use the parent session's model". This sentinel
  // must never be passed to the inference layer: Provider selection treats
  // 'inherit' as an unknown model and rejects it. Resolve it to the parent
  // session's model here, mirroring how the agent registry resolves 'inherit'.
  const requestedModel =
    skill.model ?? effectiveDefinition.modelConfig?.model ?? 'default';
  const model =
    requestedModel === 'inherit' ? config.getModel() : requestedModel;

  const hookAgentId = `skill:${skillName}:fork`;
  const hookSystem = config.getHookSystem?.();
  let registries: SubagentRegistries | undefined;

  try {
    if (skill.hooks && Object.keys(skill.hooks).length > 0 && hookSystem) {
      registerFrontmatterHooks(
        hookSystem,
        hookAgentId,
        skill.hooks,
        true,
        true,
      );
    }

    // Skill grants are local to the fork. Inherit the caller's registry and
    // permission manager so a per-spawn deny/clamp survives this rules override.
    const promptId = `skill-${skillName}`;
    const permissionAllowedTools = effectiveAllowedTools
      ? [...effectiveAllowedTools, COMPLETE_TASK_TOOL_NAME]
      : undefined;
    const agentLoopContext = buildAutoApproveAgentContext(
      config,
      `skill-${skillName}`,
      permissionAllowedTools,
      parentContext,
    );
    const agentId = createAgentId();
    registries = await buildSubagentRegistries(
      effectiveDefinition,
      agentLoopContext,
      promptId,
      {
        agentId,
      },
    );
    const systemPrompt = await buildSubagentSystemPrompt(
      effectiveDefinition,
      registries.toolRegistry,
      agentLoopContext,
      model,
    );

    const result = await runSubagent({
      definition: effectiveDefinition,
      querySelection: requestedReasoning
        ? {
            config: {
              reasoning: { effort: requestedReasoning.reasoningEffort },
            },
          }
        : undefined,
      agentId,
      prompt: skillPrompt,
      systemPrompt,
      model,
      promptId,
      context: agentLoopContext,
      toolRegistry: registries.toolRegistry,
      toolExecutor: config.getToolExecutor(),
      schedulerContext: registries.schedulerContext,
      forkContext: registries.forkContext,
      maxTurns: effectiveDefinition.runConfig?.maxTurns ?? 10,
      signal,
      onEvent,
      sessionId: config.getSessionId(),
      parentRequestSetId,
      parentBusinessInfo,
      customContext: customContext ?? getCustomContextFromContext(),
    });

    return result.textContent?.trim() || 'Skill completed with no output.';
  } finally {
    if (hookSystem) {
      clearFrontmatterHooks(hookSystem, hookAgentId);
    }
    // Nothing to revoke: the fork's grants lived on its own override, which goes
    // away with the fork. Session rules were never touched.
    config.getSkillManager().clearInvokedSkillsForAgent(`skill:${skillName}`);
    registries?.toolRegistry.dispose();
  }
}

/**
 * Execute a fork skill directly without the Tool lifecycle.
 * Used by slash commands to return results without model inference.
 */
export async function executeForkedSkillDirect(
  config: Config,
  skill: SkillDefinition,
  args: string | undefined,
  signal: AbortSignal,
  parentRequestSetId?: string,
  parentBusinessInfo?: Readonly<BusinessInfo>,
): Promise<string> {
  return runForkedSkillCore(
    config,
    skill,
    args,
    signal,
    undefined,
    parentRequestSetId,
    parentBusinessInfo,
    config, // Slash commands run in the root session's AgentLoopContext.
  );
}

/**
 * Parameters for the ActivateSkill tool
 */
export interface ActivateSkillToolParams {
  /**
   * The name of the skill to activate
   */
  skill: string;
  /**
   * Optional arguments to pass to the skill
   */
  args?: string;
}

class ActivateSkillToolInvocation extends BaseToolInvocation<
  ActivateSkillToolParams,
  ToolResult
> {
  /** Parent lifecycle context captured from ToolUseContext in executeWithContext(). */
  private _parentRequestSetId?: string;
  private _parentBusinessInfo?: Readonly<BusinessInfo>;
  private _toolCallScopeId?: string;
  private _toolNames?: readonly string[];
  private _parentContext?: AgentLoopContext;
  private _customContext?: Readonly<Record<string, string>>;

  constructor(
    private config: Config,
    params: ActivateSkillToolParams,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(params, _toolName, _toolDisplayName);
  }

  /**
   * Override to capture parent lifecycle context from ToolUseContext
   * before delegating to execute().
   */
  override async executeWithContext(ctx: ToolUseContext): Promise<ToolResult> {
    this._parentRequestSetId = ctx.parentRequestSetId;
    this._parentBusinessInfo = ctx.parentBusinessInfo;
    this._toolCallScopeId = ctx.toolCallScopeId;
    this._parentContext = ctx.agentLoopContext;
    this._customContext = ctx.customContext;
    this._toolNames =
      ctx.agentLoopContext?.getParentToolSchemas?.().map((tool) => tool.name) ??
      [];
    return this.execute(ctx.signal, ctx.updateOutput);
  }

  getDescription(): string {
    const skillName = this.params.skill;
    const skill = this.config.getSkillManager().getSkill(skillName);
    if (skill) {
      return `"${skillName}": ${skill.description}`;
    }
    return `"${skillName}" (?) unknown skill`;
  }

  async execute(
    _signal: AbortSignal,
    updateOutput?: (output: ToolLiveOutput) => void,
  ): Promise<ToolResult> {
    return this.executeSkill(_signal, updateOutput);
  }

  private async executeSkill(
    _signal: AbortSignal,
    updateOutput?: (output: ToolLiveOutput) => void,
  ): Promise<ToolResult> {
    const requestedSkillName = this.params.skill;
    const skillManager = this.config.getSkillManager();
    const skill = skillManager.getSkill(requestedSkillName);

    if (!skill) {
      // Suggest only what this caller may actually activate: anything else
      // sends the retry straight into a guaranteed rejection here or in
      // checkPermissions (disable-model-invocation, visibility override,
      // unactivated conditional skill, or main-session allowlist). The
      // model-visible set already excludes all of these.
      const skills = skillManager.getModelVisibleSkills({
        isMainSession: this._toolCallScopeId === ROOT_TOOL_CALL_SCOPE_ID,
      });
      const availableSkills = skills.map((s) => s.name).join(', ');
      const errorMessage = availableSkills
        ? `Skill "${requestedSkillName}" not found. Available skills are: ${availableSkills}`
        : `Skill "${requestedSkillName}" not found. No skills are available to activate.`;
      return {
        llmContent: `Error: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: ToolErrorType.INVALID_TOOL_PARAMS,
        },
        data: createToolParameterDiagnosticData('missing_reference', {
          validation_source: 'tool_execution',
          parameter_path: 'params.skill',
          constraint_category: 'reference_not_found',
          quality: 'precise',
          validation_phase: 'execution',
        }),
      };
    }

    const skillName = skill.name;

    // The model may remember or guess a skill name after settings remove it
    // from the visible list. Enforce the setting again at execution time so a
    // direct Skill tool call cannot bypass the model-facing filter.
    if (skill.disabled) {
      const errorMessage = `Skill "${skillName}" is unavailable.`;
      return {
        llmContent: `Error: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: ToolErrorType.POLICY_VIOLATION,
        },
      };
    }

    // SK27: Block skills with disable-model-invocation
    if (skill.disableModelInvocation) {
      const errorMessage = `Skill "${skillName}" cannot be activated via the Skill tool due to disable-model-invocation`;
      return {
        llmContent: `Error: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: ToolErrorType.POLICY_VIOLATION,
        },
      };
    }

    // SK32/SK33: Fork execution — run skill in an isolated sub-agent
    if (skill.context === 'fork') {
      return this.executeForkedSkill(skill, _signal, updateOutput);
    }

    // Inline path — delegate to the shared function
    if (updateOutput) {
      updateOutput(`Launching skill: ${skillName}`);
    }
    const outcome = await activateInlineSkill(
      this.config,
      skillName,
      this.params.args,
      {
        toolNames: this._toolNames,
        agentDepth: this._parentContext?.agentDepth,
        shellPermissionCheck: createSkillShellPermissionCheck(
          this.config,
          skill,
          this._parentContext,
        ),
      },
    );

    if (!outcome.ok) {
      return {
        llmContent: `Error: ${outcome.error.errorMessage}`,
        returnDisplay: `Error: ${outcome.error.errorMessage}`,
        error: {
          message: outcome.error.errorMessage,
          type: outcome.error.errorType,
        },
      };
    }

    const { result } = outcome;

    // Build contextModifier to propagate skill overrides (model, effort)
    // and skill-level permission overlay (allowedTools) to subsequent
    // inference turns, scoped to the current query's ToolUseContext.
    const allowedTools = skill.allowedTools;
    const hasOverrides = result.skillOverrides || allowedTools?.length;
    const contextModifier = hasOverrides
      ? (ctx: ToolUseContext): ToolUseContext => ({
          ...ctx,
          ...(result.skillOverrides
            ? {
                skillOverrides: {
                  ...ctx.skillOverrides,
                  ...result.skillOverrides,
                },
              }
            : {}),
          ...(allowedTools?.length
            ? {
                skillPermissionOverlay: {
                  allowedToolPatterns: [
                    ...(ctx.skillPermissionOverlay?.allowedToolPatterns ?? []),
                    ...allowedTools,
                  ],
                },
              }
            : {}),
        })
      : undefined;

    return {
      llmContent: result.llmContent,
      returnDisplay: result.returnDisplay,
      toolUseResult: buildInlineSkillResult(skill),
      newMessages: [
        {
          role: 'user',
          // Model-invoked path: use skillBodyContent (without metadata tags,
          // metadata is filtered from model-visible content).
          content: result.skillBodyContent,
          isMeta: result.isMeta,
        },
      ],
      contextModifier,
    };
  }

  /**
   * Execute a skill in a forked sub-agent context with progress tracking.
   */
  private async executeForkedSkill(
    skill: SkillDefinition,
    signal: AbortSignal,
    updateOutput?: (output: ToolLiveOutput) => void,
  ): Promise<ToolResult> {
    const skillName = skill.name;

    const tracker = updateOutput
      ? new ProgressTracker({
          agentName: `skill:${skillName}`,
          updateOutput,
        })
      : undefined;

    if (tracker) {
      updateOutput!(tracker.makeProgress('running'));
    }

    try {
      const outputText = await runForkedSkillCore(
        this.config,
        skill,
        this.params.args,
        signal,
        tracker ? (event) => tracker.handleQueryEvent(event) : undefined,
        this._parentRequestSetId,
        this._parentBusinessInfo,
        this._parentContext,
        this._customContext,
      );

      const resultLabel =
        outputText === 'Skill completed with no output.'
          ? 'No output produced.'
          : outputText;

      const progress = tracker?.makeProgress('completed', {
        result: resultLabel,
      });
      if (tracker) updateOutput!(progress!);

      const isEmpty = outputText === 'Skill completed with no output.';
      const llmContent = isEmpty
        ? `Skill "${skillName}" completed (forked execution) but produced no output. This may indicate the skill's instructions lack a concrete task for the sub-agent to execute.`
        : `Skill "${skillName}" completed (forked execution).\n\nResult:\n${outputText}`;
      const fallbackDisplay = isEmpty
        ? `⚠️ Skill **${skillName}** completed (forked execution) with no output.`
        : `Skill **${skillName}** completed (forked execution).`;

      return {
        llmContent,
        returnDisplay: progress ?? fallbackDisplay,
        toolUseResult: buildForkedSkillPayloadResult(
          skillName,
          fallbackDisplay,
          resultLabel,
        ),
      };
    } catch (error) {
      const errorMessage = `Failed to execute forked skill "${skillName}": ${error instanceof Error ? error.message : String(error)}`;

      if (tracker) {
        tracker.markRunningAs('error');
        const progress = tracker.makeProgress('error');
        updateOutput!(progress);
      }

      return {
        llmContent: `Error: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }
  }
}

// ============================================================================
// SK48/SK49: Skill Permission Checking
// ============================================================================

/**
 * Properties of SkillDefinition that are considered safe and don't require
 * user permission confirmation. Skills that ONLY have these properties
 * (with no meaningful values for other properties) are auto-allowed.
 *
 * Any new property added to SkillDefinition will NOT be in this set,
 * ensuring it defaults to requiring permission until explicitly reviewed.
 */
const SAFE_SKILL_PROPERTIES = new Set([
  // Core identity
  'name',
  'displayName',
  'description',
  'location',
  'skillRoot',
  'body',
  'disabled',
  'isBuiltin',
  'extensionName',
  'hasUserSpecifiedDescription',
  // Model / effort overrides (don't affect security)
  'model',
  'effort',
  // Activation hints (informational only)
  'whenToUse',
  'argumentHint',
  'arguments',
  // Invocation control (restrictive, not permissive)
  'disableModelInvocation',
  'userInvocable',
  // Execution context (fork is isolated)
  'context',
  'agent',
  // Path filters (restrictive)
  'paths',
  // Source tracking
  'source',
  // Plugin-source bookkeeping (informational only; does not influence
  // execution semantics, so it must not force a permission prompt).
  'pluginName',
  'pluginPath',
  'pluginId',
  'resolvedPath',
  'alsoDefinedAt',
  // Dynamic skill support
  'getBody',
  'isEnabled',
  // Internal classification (converter-stamped, no security impact)
  'kind',
]);

/**
 * Determines if a skill only has "safe" properties that don't require
 * user confirmation. Skills with hooks, allowedTools, or shell override
 * are NOT considered safe.
 */
export function skillHasOnlySafeProperties(skill: SkillDefinition): boolean {
  for (const key of Object.keys(skill)) {
    if (SAFE_SKILL_PROPERTIES.has(key)) continue;

    const value = (skill as unknown as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    )
      continue;

    // Not in the safe set and has a meaningful value
    return false;
  }
  return true;
}

/**
 * Implementation of the ActivateSkill tool logic
 */
export class ActivateSkillTool extends BaseDeclarativeTool<
  ActivateSkillToolParams,
  ToolResult
> {
  override get exposureHints() {
    return MODEL_ONLY_HINTS;
  }
  static readonly Name = SKILL_TOOL_NAME;

  constructor(private config: Config) {
    const declaration = getActivateSkillDeclaration();

    super(
      ActivateSkillTool.Name,
      'Activate Skill',
      declaration.description!,
      Kind.Other,
      declaration.parametersJsonSchema,
      true,
      true,
    );
  }

  override toClassifierInput(input: ActivateSkillToolParams): unknown {
    return {
      skill: input.skill,
      args: input.args,
    };
  }

  protected createInvocation(
    params: ActivateSkillToolParams,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<ActivateSkillToolParams, ToolResult> {
    return new ActivateSkillToolInvocation(
      this.config,
      params,
      _toolName,
      _toolDisplayName ?? 'Activate Skill',
    );
  }
}
