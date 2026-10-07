/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolConfig } from '../runtime/agent-types.js';
import { resolvePath } from '../../utils/paths.js';
import {
  evaluateToolInvocationGuard,
  type ToolInvocationGuard,
} from '../../core/tool-invocation-guard.js';
import { ToolNames } from '../../tools/tool-names.js';
import { matchesToolPattern } from '../../permissions/rule-parser.js';

export type AgentToolClassification = 'allow' | 'deny' | 'thread';

export const THREAD_TOOL_NAMES = [
  ToolNames.THREAD_POST,
  ToolNames.THREAD_WAIT,
  ToolNames.THREAD_BLOCK,
  ToolNames.THREAD_REVIEW,
  ToolNames.THREAD_CREATE,
  ToolNames.THREAD_READ,
] as const;

type CoreToolName = (typeof ToolNames)[keyof typeof ToolNames];
type AgentThreadToolName = (typeof THREAD_TOOL_NAMES)[number];

export const AGENT_TOOL_CLASSIFICATION = {
  [ToolNames.EDIT]: 'deny',
  [ToolNames.WRITE_FILE]: 'deny',
  [ToolNames.READ_FILE]: 'allow',
  [ToolNames.ZOOM_IMAGE]: 'allow',
  [ToolNames.GREP]: 'allow',
  [ToolNames.GLOB]: 'allow',
  [ToolNames.SHELL]: 'deny',
  // `exec` is the code-mode entry point: every ordinary tool is reached from
  // inside an exec program as `tools.<name>(args)`. Allowing it would let an
  // Agent call `tools.run_shell_command(...)` and any other denied tool through
  // the wrapper, which is the whole classification table undone in one line.
  [ToolNames.EXEC]: 'deny',
  [ToolNames.TODO_WRITE]: 'deny',
  [ToolNames.MEMORY]: 'deny',
  [ToolNames.MANAGE_MEMORY]: 'deny',
  [ToolNames.SEARCH_MEMORY]: 'deny',
  [ToolNames.AGENT]: 'deny',
  [ToolNames.ADVISOR]: 'deny',
  [ToolNames.SKILL]: 'deny',
  [ToolNames.EXIT_PLAN_MODE]: 'deny',
  [ToolNames.ENTER_PLAN_MODE]: 'deny',
  [ToolNames.WEB_FETCH]: 'deny',
  [ToolNames.WEB_SEARCH]: 'deny',
  [ToolNames.IMAGE_GEN]: 'deny',
  [ToolNames.LS]: 'allow',
  [ToolNames.LSP]: 'deny',
  [ToolNames.ASK_USER_QUESTION]: 'deny',
  [ToolNames.CRON_CREATE]: 'deny',
  [ToolNames.CRON_LIST]: 'deny',
  [ToolNames.CRON_DELETE]: 'deny',
  [ToolNames.LOOP_WAKEUP]: 'deny',
  [ToolNames.CREATE_SUB_SESSION]: 'deny',
  [ToolNames.LIST_AGENTS]: 'deny',
  [ToolNames.TASK_STOP]: 'deny',
  [ToolNames.TASK_CREATE]: 'deny',
  [ToolNames.TASK_UPDATE]: 'deny',
  [ToolNames.TASK_LIST]: 'deny',
  [ToolNames.TEAM_CREATE]: 'deny',
  [ToolNames.TEAM_DELETE]: 'deny',
  [ToolNames.TEAM_PLAN_APPROVAL]: 'deny',
  [ToolNames.REQUEST_SHUTDOWN]: 'deny',
  [ToolNames.SEND_MESSAGE]: 'deny',
  [ToolNames.STRUCTURED_OUTPUT]: 'allow',
  [ToolNames.MONITOR]: 'deny',
  [ToolNames.NOTEBOOK_EDIT]: 'deny',
  [ToolNames.TOOL_SEARCH]: 'allow',
  [ToolNames.READ_MCP_RESOURCE]: 'deny',
  [ToolNames.ENTER_WORKTREE]: 'deny',
  [ToolNames.EXIT_WORKTREE]: 'deny',
  [ToolNames.WORKFLOW]: 'deny',
  [ToolNames.ARTIFACT]: 'deny',
  [ToolNames.RECORD_ARTIFACT]: 'deny',
  [ToolNames.RECORD_SOURCE]: 'deny',
  [ToolNames.REPORT_FINDINGS]: 'deny',
  [ToolNames.GET_GOAL]: 'allow',
  [ToolNames.UPDATE_GOAL]: 'deny',
  [ToolNames.PROPOSE_GOAL]: 'deny',
  [ToolNames.DISPLAY_IMAGE]: 'allow',
  // The omni media family is absent from `SAFE_TOOL_ALLOWLIST`, which is where
  // the read-only file and search tools are declared, so an Agent keeps
  // reaching media through `read_file` / `zoom_image` / `display_image` and
  // these stay denied — the same verdict `classifyAgentTool` gives any name it
  // does not know.
  [ToolNames.OMNI_DOWNSAMPLE_IMAGE]: 'deny',
  [ToolNames.OMNI_DOWNSCALE_VIDEO]: 'deny',
  [ToolNames.OMNI_DOWNSAMPLE_AUDIO]: 'deny',
  [ToolNames.OMNI_EXTRACT_KEYFRAMES]: 'deny',
  [ToolNames.OMNI_EXTRACT_AUDIO]: 'deny',
  [ToolNames.OMNI_CLIP_VIDEO]: 'deny',
  [ToolNames.OMNI_CONVERT_IMAGE]: 'deny',
  [ToolNames.OMNI_TRANSCRIBE_AUDIO]: 'deny',
  [ToolNames.OMNI_CLIP_IMAGE]: 'deny',
  [ToolNames.OMNI_CLIP_AUDIO]: 'deny',
  [ToolNames.OMNI_CAPTION_IMAGE]: 'deny',
  [ToolNames.OMNI_CAPTION_AUDIO]: 'deny',
  [ToolNames.OMNI_OCR_IMAGE]: 'deny',
  [ToolNames.OMNI_UNDERSTAND_VIDEO_SEGMENTS]: 'deny',
  [ToolNames.OMNI_RECALL_MEDIA_MEMORY]: 'deny',
  // The deferred-tool bridge can invoke any registered tool, so it is denied
  // for the same reason as exec.
  [ToolNames.TOOL_CALL]: 'deny',
  [ToolNames.THREAD_POST]: 'thread',
  [ToolNames.THREAD_WAIT]: 'thread',
  [ToolNames.THREAD_BLOCK]: 'thread',
  [ToolNames.THREAD_REVIEW]: 'thread',
  [ToolNames.THREAD_CREATE]: 'thread',
  [ToolNames.THREAD_READ]: 'thread',
} as const satisfies Record<
  CoreToolName | AgentThreadToolName,
  AgentToolClassification
>;

export function classifyAgentTool(name: string): AgentToolClassification {
  if (!Object.hasOwn(AGENT_TOOL_CLASSIFICATION, name)) return 'deny';
  return AGENT_TOOL_CLASSIFICATION[
    name as keyof typeof AGENT_TOOL_CLASSIFICATION
  ];
}

export function buildAgentToolConfig(definition?: ToolConfig): ToolConfig {
  const allowAll = definition === undefined || definition.tools.includes('*');
  let allowed = allowAll
    ? Object.entries(AGENT_TOOL_CLASSIFICATION)
        .filter(([, classification]) => classification === 'allow')
        .map(([name]) => name)
    : definition.tools
        .map((tool) => (typeof tool === 'string' ? tool : tool.name))
        .filter(
          (name): name is string =>
            typeof name === 'string' && classifyAgentTool(name) === 'allow',
        );
  if (definition?.executionAllowedTools !== undefined) {
    const executable = new Set(definition.executionAllowedTools);
    allowed = allowed.filter((name) => executable.has(name));
  }
  if (definition?.disallowedTools?.length) {
    const disallowed = new Set(definition.disallowedTools);
    allowed = allowed.filter((name) => !disallowed.has(name));
  }
  const tools = Array.from(new Set([...allowed, ...THREAD_TOOL_NAMES]));
  const threadTools = new Set<string>(THREAD_TOOL_NAMES);

  return {
    tools,
    executionAllowedTools: [...tools],
    disallowedTools: Array.from(
      new Set([
        ...Object.entries(AGENT_TOOL_CLASSIFICATION)
          .filter(([, classification]) => classification === 'deny')
          .map(([name]) => name),
        ...(definition?.disallowedTools ?? []).filter(
          (name) => !threadTools.has(name),
        ),
      ]),
    ),
  };
}

export function createAgentToolInvocationGuard(
  upstream?: ToolInvocationGuard,
  executionAllowedTools?: ReadonlySet<string>,
): ToolInvocationGuard {
  return async (context) => {
    if (upstream) {
      const upstreamDecision = await evaluateToolInvocationGuard(
        upstream,
        context,
      );
      if (!upstreamDecision.allowed) return upstreamDecision;
    }

    const classification = classifyAgentTool(context.toolName);
    if (
      classification === 'deny' ||
      (executionAllowedTools !== undefined &&
        !executionAllowedTools.has(context.toolName))
    ) {
      return {
        allowed: false,
        reason: `Tool "${context.toolName}" is outside this subsystem read-only capability boundary.`,
      };
    }
    return { allowed: true };
  };
}

/**
 * Tool configuration for an agent session started by the session-agents
 * orchestrator (`agents/session-agents`).
 *
 * Product decision 2026-10-05 (session-multi-agent design §8-1): such an agent may use every tool
 * the session offers; writes and command execution are not removed but go
 * through the session's ordinary approval flow, which the orchestrator relays
 * to the chat session. So there is no read-only ceiling here. A linked
 * definition may still narrow the surface; that narrowing is kept.
 * Thread tools are never offered: there is no thread behind such a session.
 */
export function buildSessionAgentToolConfig(
  definition?: ToolConfig,
): ToolConfig {
  const threadTools = new Set<string>(THREAD_TOOL_NAMES);
  const definitionNames = definition?.tools.map((tool) =>
    typeof tool === 'string' ? tool : tool.name,
  );
  let executionAllowedTools: string[] | undefined;
  if (definitionNames !== undefined && !definitionNames.includes('*')) {
    executionAllowedTools = definitionNames.filter(
      (name): name is string =>
        typeof name === 'string' && !threadTools.has(name),
    );
  }
  if (definition?.executionAllowedTools !== undefined) {
    const executable = new Set(definition.executionAllowedTools);
    executionAllowedTools = (
      executionAllowedTools ?? definition.executionAllowedTools
    ).filter((name) => executable.has(name) && !threadTools.has(name));
  }
  return {
    tools: definition?.tools ?? ['*'],
    ...(executionAllowedTools !== undefined ? { executionAllowedTools } : {}),
    disallowedTools: Array.from(
      new Set([...(definition?.disallowedTools ?? []), ...THREAD_TOOL_NAMES]),
    ),
  };
}

/**
 * The guard for a session-agents agent session: the upstream guard, the
 * definition's execution allowlist when it has one, its `disallowedTools`,
 * and no thread tools.
 * Unlike {@link createAgentToolInvocationGuard} there is no read-only
 * classification; writes go through the session's approval flow, which
 * always asks: `Config.markSessionAgentSession` pins such a session to
 * `default` approval and refuses YOLO / auto-edit / auto for it later.
 *
 * `disallowedTools` is matched like AgentCore's blocklist
 * ({@link matchesToolPattern}: exact names, and `mcp__server` patterns), but
 * without the registry's alias / MCP-identity channel, which the guard
 * context does not carry: an MCP tool denied only by an alias is not caught.
 */
export function createSessionAgentToolInvocationGuard(
  upstream?: ToolInvocationGuard,
  executionAllowedTools?: ReadonlySet<string>,
  disallowedTools?: readonly string[],
): ToolInvocationGuard {
  const threadTools = new Set<string>(THREAD_TOOL_NAMES);
  return async (context) => {
    if (upstream) {
      const upstreamDecision = await evaluateToolInvocationGuard(
        upstream,
        context,
      );
      if (!upstreamDecision.allowed) return upstreamDecision;
    }
    if (
      threadTools.has(context.toolName) ||
      (executionAllowedTools !== undefined &&
        !executionAllowedTools.has(context.toolName)) ||
      (disallowedTools?.some((pattern) =>
        matchesToolPattern(pattern, context.toolName),
      ) ??
        false)
    ) {
      return {
        allowed: false,
        reason: `Tool "${context.toolName}" is not available to this agent.`,
      };
    }
    return { allowed: true };
  };
}

export function createAgentHostToolInvocationGuard(
  upstream: ToolInvocationGuard | undefined,
  workspaceCwd: string,
  isPathWithinWorkspace: (candidate: string) => boolean,
): ToolInvocationGuard {
  const readOnlyGuard = createAgentToolInvocationGuard(upstream);
  return async (context) => {
    const decision = await readOnlyGuard(context);
    if (!decision.allowed) return decision;

    if (
      context.toolName === ToolNames.ZOOM_IMAGE ||
      context.toolName === ToolNames.DISPLAY_IMAGE
    ) {
      return {
        allowed: false,
        reason: 'Agent Host media reads are outside its workspace capability.',
      };
    }

    // Glob expansion happens after this guard and can traverse a symlink or a
    // brace branch outside the checked base directory.
    if (context.toolName === ToolNames.GLOB) {
      return {
        allowed: false,
        reason: 'Agent Host glob reads are outside its workspace capability.',
      };
    }

    if (
      context.toolName === ToolNames.GREP &&
      context.args['glob'] !== undefined
    ) {
      return {
        allowed: false,
        reason: 'Agent Host grep does not accept glob filters.',
      };
    }

    let requestedPath: unknown;
    switch (context.toolName) {
      case ToolNames.READ_FILE:
        requestedPath = context.args['file_path'];
        break;
      case ToolNames.GREP:
        requestedPath = context.args['path'] ?? '.';
        break;
      case ToolNames.LS:
        requestedPath = context.args['path'];
        break;
      default:
        return decision;
    }

    if (typeof requestedPath !== 'string' || requestedPath.trim() === '') {
      return {
        allowed: false,
        reason: 'Agent Host read path is missing.',
      };
    }
    const candidate = resolvePath(context.cwd ?? workspaceCwd, requestedPath);
    if (!isPathWithinWorkspace(candidate)) {
      return {
        allowed: false,
        reason: 'Agent Host reads are limited to the assigned workspace.',
      };
    }
    return decision;
  };
}
