/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Explore Agent — a fast, read-only codebase search specialist.
 *
 * Design: blacklist-only (no toolConfig). Inherits all parent tools, then
 * removes write/control/non-search tools via disallowedTools. This ensures
 * MCP tools and future additions are automatically available without updating
 * a whitelist.
 *
 * See docs/design/subagent-tool-allocation.md for the full rationale.
 */

import type { LocalAgentDefinition } from '../types.js';
import type { Config } from '../../config/config.js';
import type { ToolRegistry } from '../../tools/tool-registry.js';
import { BRAND_NAME } from '../../config/brand.js';
import {
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  SHELL_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  READ_ONLY_SUBAGENT_DISALLOWED_TOOLS,
} from '../../tools/tool-names.js';
import {
  renderReadOnlyModeBlock,
  renderShellRules,
} from './read-only-agent-prompt.js';

export const EXPLORE_AGENT_NAME = 'Explore';

/** Search tools, with the shell command to recommend when one is unavailable. */
const SEARCH_TOOLS = [
  {
    tool: GLOB_TOOL_NAME,
    purpose: 'broad file pattern matching',
    shellCommand: 'find',
    powerShellCommand: 'Get-ChildItem',
  },
  {
    tool: GREP_TOOL_NAME,
    purpose: 'searching file contents with regex',
    shellCommand: 'grep',
    powerShellCommand: 'Select-String',
  },
] as const;

/**
 * Tools that can independently gather evidence from the local codebase.
 *
 * A non-empty child registry is not sufficient: coordination tools such as
 * Skill or WriteTodos do not let Explore inspect code. Keep this deliberately
 * small and capability-based; additional search implementations can opt in by
 * exposing one of these canonical tool identities through the registry.
 *
 * None of these appear in READ_ONLY_SUBAGENT_DISALLOWED_TOOLS, so Explore's
 * blacklist can never strip them.
 */
const EXPLORE_CAPABILITY_TOOL_NAMES = [
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  SHELL_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
] as const;

/**
 * Whether Explore can retain at least one caller-visible tool that can inspect
 * the local codebase. The exact child registry is checked again during setup;
 * this predicate also supports preflight availability listings.
 */
export function hasExploreToolCapability(
  toolRegistry: Pick<ToolRegistry, 'hasToolEnabled'>,
): boolean {
  return EXPLORE_CAPABILITY_TOOL_NAMES.some((name) =>
    toolRegistry.hasToolEnabled(name),
  );
}

/**
 * The single reason a built-in Explore invocation must be refused: the caller
 * left it without any tool that can inspect the codebase, so a model call could
 * only guess.
 *
 * Installed as the definition's `checkAvailability`, so availability listings,
 * Agent-tool dispatch and `agent-setup` all read the same wording without any
 * of them naming Explore.
 */
function checkExploreAvailability(context: {
  toolRegistry: Pick<ToolRegistry, 'hasToolEnabled'>;
}): string | undefined {
  return hasExploreToolCapability(context.toolRegistry)
    ? undefined
    : `Agent type '${EXPLORE_AGENT_NAME}' is unavailable because no usable exploration tools are available to it.`;
}

function buildExploreSystemPrompt(toolRegistry?: ToolRegistry): string {
  if (toolRegistry && !hasExploreToolCapability(toolRegistry)) {
    return `You are the ${EXPLORE_AGENT_NAME} agent for ${BRAND_NAME}, but no usable exploration tools are available in this invocation. Do not claim to have searched the codebase. Report that exploration cannot proceed because the caller did not provide any usable tools.`;
  }

  const hasTool = (name: string) => toolRegistry?.hasToolEnabled(name) ?? true;
  const shellName = hasTool(SHELL_TOOL_NAME)
    ? SHELL_TOOL_NAME
    : POWERSHELL_TOOL_NAME;
  const hasShell = hasTool(shellName);
  const searchCommand = (entry: (typeof SEARCH_TOOLS)[number]) =>
    shellName === POWERSHELL_TOOL_NAME
      ? entry.powerShellCommand
      : entry.shellCommand;

  // A search tool that fell back to the shell must also be permitted by the
  // read-only command list, otherwise the prompt contradicts itself.
  const shellFallbacks = hasShell
    ? SEARCH_TOOLS.filter((entry) => !hasTool(entry.tool)).map(searchCommand)
    : [];

  const guidelines = [
    ...SEARCH_TOOLS.flatMap((entry) => {
      if (hasTool(entry.tool)) {
        return `Use ${entry.tool} for ${entry.purpose}`;
      }
      return hasShell
        ? `Use ${searchCommand(entry)} via ${shellName} for ${entry.purpose}`
        : [];
    }),
    ...(hasTool(READ_FILE_TOOL_NAME)
      ? [
          `Use ${READ_FILE_TOOL_NAME} when you know the specific file path you need to read`,
        ]
      : []),
    ...(hasShell ? renderShellRules(shellFallbacks, toolRegistry) : []),
    'Adapt your search approach based on the thoroughness level specified by the caller',
    'Communicate your final report directly as a regular message - do NOT attempt to create files',
  ]
    .map((line) => `- ${line}`)
    .join('\n');

  return `You are a file search specialist for ${BRAND_NAME}. You excel at thoroughly navigating and exploring codebases.

${renderReadOnlyModeBlock('exploration', 'search and analyze existing code.')}

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents

Guidelines:
${guidelines}

NOTE: You are meant to be a fast agent that returns output as quickly as possible. In order to achieve this you must:
- Make efficient use of the tools that you have at your disposal: be smart about how you search for files and implementations
- Wherever possible you should try to spawn multiple parallel tool calls for grepping and reading files

Complete the user's search request efficiently and report your findings clearly.`;
}

export const ExploreAgent = (_config: Config): LocalAgentDefinition => ({
  kind: 'local',
  name: EXPLORE_AGENT_NAME,
  description:
    'Fast read-only search agent for locating code. Use it to find files by ' +
    'pattern (eg. "src/components/**/*.tsx"), grep for symbols or keywords ' +
    '(eg. "API endpoints"), or answer "where is X defined / which files reference ' +
    'Y." Do NOT use it for code review, design-doc auditing, cross-file ' +
    'consistency checks, or open-ended analysis — it reads excerpts rather than ' +
    'whole files and will miss content past its read window. When calling, specify ' +
    'search breadth: "quick" for a single targeted lookup, "medium" for moderate ' +
    'exploration, or "very thorough" to search across multiple locations and ' +
    'naming conventions.',
  descriptionLean:
    'Read-only search agent for broad fan-out searches — when answering means ' +
    'sweeping many files, directories, or naming conventions and you only need ' +
    'the conclusion, not the file dumps. It reads excerpts rather than whole ' +
    "files, so it locates code; it doesn't review or audit it. Specify search " +
    'breadth: "medium" for moderate exploration, "very thorough" for multiple ' +
    'locations and naming conventions.',
  color: 'cyan',
  modelConfig: {
    model: 'inherit',
  },
  omitAgentsMd: true,
  omitGitStatus: true,
  disallowedTools: [...READ_ONLY_SUBAGENT_DISALLOWED_TOOLS],
  promptConfig: {
    // Static fallback for callers that do not support dynamic agent prompts.
    systemPrompt: buildExploreSystemPrompt(),
  },
  getSystemPrompt: ({ toolRegistry }) => buildExploreSystemPrompt(toolRegistry),
  checkAvailability: checkExploreAvailability,
});
