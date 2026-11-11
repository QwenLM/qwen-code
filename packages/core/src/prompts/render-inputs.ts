/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CodeModeSetting } from '../codemode/settings.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import { EXPLORE_AGENT_NAME } from '../agents/builtin/explore-agent.js';
import { isAgentSessionsEnabled } from '../agents/agent-session-feature.js';
import { asAgentPolicyView } from '../agents/agent-policy-view.js';
import { FORK_SUBAGENT_TYPE } from '../agents/fork-subagent.js';
import { areExplorePlanAgentsDisabled } from '../config/brand.js';
import { loadAutoMemoryPrompt } from '../memory/auto-memory-prompt.js';
import {
  AGENT_TOOL_NAME,
  CODE_MODE_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  SKILL_TOOL_NAME,
  TASK_CREATE_TOOL_NAME,
  WORKFLOW_TOOL_NAME,
  WRITE_TODOS_TOOL_NAME,
} from '../tools/tool-names.js';
import { renderUsingToolsSection } from './snippets.js';
import { getConfigHomeDir } from '../utils/paths.js';
import type {
  AssembledPromptSource,
  PromptBundle,
  PromptHostCapability,
  PromptRenderInputs,
  PromptSurface,
  SdkMemoryPromptState,
} from './types.js';

const DEFAULT_AGENT_GUIDANCE =
  "Use the Agent tool with specialized agents when the task at hand matches the agent's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but they should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing - if you delegate research to a subagent, do not also perform the same searches yourself.";

const FORK_AGENT_GUIDANCE = `Calling ${AGENT_TOOL_NAME} with subagent_type: "fork" creates a fork — it inherits your full conversation context, runs in the background, and keeps its tool output out of your context — so you can keep chatting with the user while it works. Reach for it when research or multi-step implementation work would otherwise fill your context with raw output you won't need again. Other subagent_type values start fresh agents with no context. **If you ARE the fork** — execute directly; do not re-delegate.`;

function freezeInput<T extends object>(input: T): Readonly<T> {
  return Object.freeze(input);
}

function createToolCapabilityShape(options: {
  enabled: ReadonlySet<string>;
  skillsAvailable: boolean;
  exploreAgentGuidance: boolean;
  forkAgentGuidanceEnabled: boolean;
  interactive: boolean;
  userResourceDir: string;
  codeMode: CodeModeSetting;
}): string {
  const bit = (value: boolean) => (value ? 1 : 0);
  return [
    `agent=${bit(options.enabled.has(AGENT_TOOL_NAME))}`,
    `skill_tool=${bit(options.enabled.has(SKILL_TOOL_NAME))}`,
    `skills_available=${bit(options.skillsAvailable)}`,
    `workflow=${bit(options.enabled.has(WORKFLOW_TOOL_NAME))}`,
    `explore_agent_guidance=${bit(options.exploreAgentGuidance)}`,
    `fork_agent_guidance=${bit(options.forkAgentGuidanceEnabled)}`,
    `interactive=${bit(options.interactive)}`,
    `user_resource_dir=${JSON.stringify(options.userResourceDir)}`,
    `code_mode=${options.codeMode}`,
  ].join(';');
}

const EXPLORE_FALLBACK_SEARCH: Record<CodeModeSetting, string> = {
  off: 'directly',
  on: `directly or batched in ${CODE_MODE_TOOL_NAME}`,
  only: `through ${CODE_MODE_TOOL_NAME}`,
};

function renderSessionGuidance(
  options: {
    enabled: ReadonlySet<string>;
    skillsAvailable: boolean;
    exploreAgentGuidance: boolean;
    forkAgentGuidanceEnabled: boolean;
    interactive: boolean;
    userResourceDir: string;
    codeMode: CodeModeSetting;
  },
  bundle: PromptBundle,
): string | null {
  const items: string[] = [];
  if (options.interactive) {
    items.push(
      'If you need the user to run a shell command themselves (e.g., an interactive login like `gh auth login`), suggest they type `! <command>` in the prompt — the `!` prefix runs the command in this session so its output lands directly in the conversation.',
    );
  }
  if (options.enabled.has(AGENT_TOOL_NAME)) {
    if (bundle === 'full') {
      items.push(
        options.forkAgentGuidanceEnabled
          ? FORK_AGENT_GUIDANCE
          : DEFAULT_AGENT_GUIDANCE,
      );
    }
    if (
      bundle === 'full' &&
      !options.forkAgentGuidanceEnabled &&
      options.exploreAgentGuidance
    ) {
      items.push(
        `For broad codebase exploration or research that'll take more than 3 queries, spawn \`${AGENT_TOOL_NAME}\` with subagent_type=${EXPLORE_AGENT_NAME}. Otherwise use the \`${GLOB_TOOL_NAME}\` or \`${GREP_TOOL_NAME}\` ${EXPLORE_FALLBACK_SEARCH[options.codeMode]}.`,
      );
    }
  }
  items.push(
    `Skills, plugins, and other resources may be stored in the user resource directory (\`${options.userResourceDir}\`) or the current project directory.`,
  );
  if (options.skillsAvailable && options.enabled.has(SKILL_TOOL_NAME)) {
    items.push(
      `When the user types \`/<skill-name>\`, invoke it via ${SKILL_TOOL_NAME}. Only use skills listed in the user-invocable skills section — don't guess.`,
    );
  }
  if (items.length === 0) return null;
  return [
    '# Session-specific guidance',
    ...items.map((item) => `- ${item}`),
  ].join('\n');
}

/** native memory 输入在多个分支中复用，保持完全一致的 cacheVariant。 */
function nativeMemoryInput(
  ctx: AgentLoopContext,
): PromptRenderInputs['memory'] {
  return freezeInput({
    owner: 'native' as const,
    cacheVariant: 'native:types=skill',
    versionForBundle: () => 'skill',
    computeForBundle: (bundle) => loadAutoMemoryPrompt(ctx.config, bundle),
  });
}

/** SDK surface 可以自带 memory prompt，也可以完全关闭 memory。 */
function sdkMemoryInput(
  state: SdkMemoryPromptState,
  ctx: AgentLoopContext,
): PromptRenderInputs['memory'] {
  if (state.owner === 'none') return undefined;
  if (state.owner === 'native') return nativeMemoryInput(ctx);
  return freezeInput({
    owner: 'sdk' as const,
    cacheVariant: `sdk:${state.shapeKey}`,
    versionForBundle: () =>
      'prompt' in state ? (state.version ?? 'custom') : 'skill',
    // SDK 明确提供的 prompt 原样复用；缺省 prompt 时由 CLI 生成两种 bundle。
    computeForBundle: (bundle) =>
      'prompt' in state ? state.prompt : state.promptsByBundle[bundle],
  });
}

/** Recomputed before prompt assembly so memory-only rollbacks do not refresh other sections. */
export function createMemoryPromptInput(
  ctx: AgentLoopContext,
  source: AssembledPromptSource,
  surface: PromptSurface,
  sdkMemoryState: SdkMemoryPromptState = { owner: 'native' },
): PromptRenderInputs['memory'] {
  return source === 'default' && surface === 'sdk'
    ? sdkMemoryInput(sdkMemoryState, ctx)
    : nativeMemoryInput(ctx);
}

export function createPromptRenderInputs(
  agentLoopContext: AgentLoopContext,
  source: AssembledPromptSource,
  surface: PromptSurface,
  sdkMemoryState: SdkMemoryPromptState = { owner: 'native' },
): PromptRenderInputs {
  const { config } = agentLoopContext;
  const enabled = new Set(agentLoopContext.toolRegistry.getAllToolNames());
  const skillsAvailable =
    config.getSkillManager().getModelVisibleSkills().length > 0;
  const agentTool = asAgentPolicyView(
    agentLoopContext.toolRegistry.getTool?.(AGENT_TOOL_NAME),
  );
  // 这个开关只压制「推荐」，不影响 dispatch：Explore 仍可被显式调用，只是
  // 不再出现在 system prompt 的指引里。attachments/normalize.ts 对 plan-mode
  // 提醒做同样的区分。
  const exploreAgentGuidance =
    !areExplorePlanAgentsDisabled() &&
    agentTool?.isAgentTypeAvailable(EXPLORE_AGENT_NAME) === true;
  const interactive = surface === 'local_tui';

  const language = config.getLanguage();
  const outputStyle = config.getOutputStyle?.();
  const languageInput = language
    ? freezeInput({
        cacheVariant: language,
        compute: () =>
          `# Language\nAlways respond in ${language}. Use ${language} for all explanations, comments, and communications with the user. Technical terms and code identifiers should remain in their original form.\nMaintain full orthographic correctness for ${language}, including all required diacritical marks, accents, and special characters. Never substitute accented characters with their ASCII equivalents (e.g., never write "nao" for "não", "fur" for "für", or "loeschen" for "löschen").`,
      })
    : undefined;
  const outputStyleInput = outputStyle
    ? freezeInput({
        cacheVariant: outputStyle.name,
        keepCodingInstructions: outputStyle.keepCodingInstructions !== false,
        compute: () =>
          `# Output Style: ${outputStyle.name}\n${outputStyle.prompt}`,
      })
    : undefined;

  const memory = createMemoryPromptInput(
    agentLoopContext,
    source,
    surface,
    sdkMemoryState,
  );

  const hostCapabilities: PromptHostCapability[] = ['compression'];
  if (memory) hostCapabilities.push('memory');
  if (enabled.has(WORKFLOW_TOOL_NAME)) hostCapabilities.push('workflows');
  hostCapabilities.sort();

  const codeMode: CodeModeSetting =
    (enabled.has(CODE_MODE_TOOL_NAME) &&
      agentLoopContext.toolRegistry.getCodeModeExposure()) ||
    'off';
  // The cache key and the rendered text must be derived from the same inputs,
  // so they read one shape instead of two copies of the same literal.
  const toolCapabilities = {
    enabled,
    codeMode,
    skillsAvailable,
    exploreAgentGuidance,
    forkAgentGuidanceEnabled:
      isAgentSessionsEnabled() &&
      agentTool?.isAgentTypeAvailable(FORK_SUBAGENT_TYPE) === true,
    interactive,
    userResourceDir: getConfigHomeDir(),
  };
  const sessionGuidance = freezeInput({
    cacheVariant: createToolCapabilityShape(toolCapabilities),
    computeForBundle: (bundle: PromptBundle) =>
      renderSessionGuidance(toolCapabilities, bundle),
  });
  // 与 sessionGuidance 同一套做法：缓存键只编码这一节真正读到的输入，
  // 而不是整份工具名清单（清单会因 MCP 工具而很长，且大部分与本节无关）。
  const usingTools = freezeInput({
    cacheVariant: [
      `task_create=${enabled.has(TASK_CREATE_TOOL_NAME) ? 1 : 0}`,
      `write_todos=${enabled.has(WRITE_TODOS_TOOL_NAME) ? 1 : 0}`,
      `code_mode=${codeMode}`,
    ].join(';'),
    compute: () => renderUsingToolsSection(enabled, codeMode),
  });
  return Object.freeze({
    ...(languageInput ? { language: languageInput } : {}),
    ...(outputStyleInput ? { outputStyle: outputStyleInput } : {}),
    usingTools,
    codeMode,
    hostCapabilities: Object.freeze(hostCapabilities),
    ...(memory ? { memory } : {}),
    sessionGuidance,
  });
}
