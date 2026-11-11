/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createPowerShellToolChecker } from './checkers/powershell-checker.js';
import {
  AGENT_TOOL_NAME,
  ASK_USER_TOOL_NAME,
  BASH_INPUT_TOOL_NAME,
  BASH_OUTPUT_TOOL_NAME,
  BASH_RESIZE_TOOL_NAME,
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  EDIT_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  ENTER_WORKTREE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  EXIT_WORKTREE_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  IMAGE_GEN_TOOL_NAME,
  IMAGE_SEARCH_TOOL_NAME,
  MONITOR_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  SHELL_TOOL_NAME,
  SKILL_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WORKFLOW_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../tool-names.js';
import { MCP_CALL_TOOL_NAME } from '../mcp-lazy/constants.js';
import { MCP_LIST_TOOL_NAME } from '../mcp-lazy/mcp-list-tool.js';
import { MCP_GET_TOOL_NAME } from '../mcp-lazy/mcp-get-tool.js';
import { withCheckLog } from './check-logger.js';
import {
  withHookAsk,
  withToolLevelRules,
  withReadProbe,
  type HostToolChecker,
} from './rule-precedence.js';
import { isPreapprovedHost } from '../web-fetch-preapproved.js';
import { createReadToolChecker } from './checkers/read-checker.js';
import { createGlobToolChecker } from './checkers/glob-checker.js';
import { createGrepToolChecker } from './checkers/grep-checker.js';
import { createWriteToolChecker } from './checkers/write-checker.js';
import { createEditToolChecker } from './checkers/edit-checker.js';
import { createNotebookEditToolChecker } from './checkers/notebook-edit-checker.js';
import { createShellToolChecker } from './checkers/bash-checker.js';
import type { ShellReadOnlyContext } from '../shell-permissions/gitReadOnlySafety.js';
import { createAgentToolChecker } from './checkers/agent-checker.js';
import { createSkillToolChecker } from './checkers/skill-checker.js';
import type { SkillCheckerDeps } from './content-checkers.js';
import { createWorkflowToolChecker } from './checkers/workflow-checker.js';
import {
  createMcpCallToolChecker,
  type McpCallCheckerDeps,
} from './checkers/mcp-call-checker.js';
import {
  createMcpGetToolChecker,
  createMcpListToolChecker,
} from './checkers/mcp-discovery-checkers.js';
import { createWebFetchToolChecker } from './checkers/web-fetch-checker.js';
import { createWebSearchToolChecker } from './checkers/web-search-checker.js';
import { createImageSearchToolChecker } from './checkers/image-search-checker.js';
import { createImageGenToolChecker } from './checkers/image-gen-checker.js';
import { createSendMessageToolChecker } from './checkers/send-message-checker.js';
import {
  createEnterWorktreeToolChecker,
  createExitWorktreeToolChecker,
} from './checkers/worktree-checkers.js';
import {
  createCronCreateToolChecker,
  createCronDeleteToolChecker,
} from './checkers/cron-checkers.js';
import {
  createEnterPlanModeToolChecker,
  createExitPlanModeToolChecker,
} from './checkers/plan-mode-checkers.js';
import { createAskUserToolChecker } from './checkers/ask-user-checker.js';
import {
  createBashInputToolChecker,
  createBashOutputToolChecker,
  createBashResizeToolChecker,
} from './checkers/bash-pty-checkers.js';
import {
  createDefaultToolChecker,
  SESSION_LOCAL_TOOL_NAMES,
} from './checkers/default-checker.js';
import type { InternalPathDeps } from '../filesystem-permissions/internal-path-deps.js';

/**
 * What the checks need from the rest of the host. Kept to the two things a rule
 * set cannot answer, so assembling the table stays cheap.
 */
export interface ToolCheckerRegistryDeps {
  readonly internalPaths?: InternalPathDeps;
  /** Live host context shared by shell permission and concurrency checks. */
  getShellReadOnlyContext?: () => ShellReadOnlyContext;
  getSearchCwd?: () => string;
  skill: SkillCheckerDeps;
  /** What the lazy MCP dispatcher's check needs to resolve a qualified name. */
  mcpCall: McpCallCheckerDeps;
}

/** AcceptEdits 覆盖的文件编辑工具；模式落定时需要这条注册期事实。 */
export const ACCEPT_EDITS_TOOL_NAMES: ReadonlySet<string> = new Set([
  WRITE_FILE_TOOL_NAME,
  EDIT_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
]);

export function createToolCheckerMap(
  deps: ToolCheckerRegistryDeps,
  pluginCheckers: ReadonlyMap<string, HostToolChecker> = new Map(),
): Map<string, HostToolChecker> {
  const map = new Map<string, HostToolChecker>();

  const register = (name: string, checker: HostToolChecker): void => {
    const layered = withHookAsk(withToolLevelRules(name, checker));
    map.set(
      name,
      withReadProbe(
        withCheckLog(`main ${name}`, layered),
        withToolLevelRules(name, checker),
      ),
    );
  };

  // ── Analysed by their arguments ───────────────────────────────────────────
  register(READ_FILE_TOOL_NAME, createReadToolChecker(deps.internalPaths));
  register(
    GLOB_TOOL_NAME,
    createGlobToolChecker(deps.getSearchCwd, deps.internalPaths),
  );
  register(
    GREP_TOOL_NAME,
    createGrepToolChecker(deps.getSearchCwd, deps.internalPaths),
  );
  register(WRITE_FILE_TOOL_NAME, createWriteToolChecker(deps.internalPaths));
  register(EDIT_TOOL_NAME, createEditToolChecker(deps.internalPaths));
  register(
    NOTEBOOK_EDIT_TOOL_NAME,
    createNotebookEditToolChecker(deps.internalPaths),
  );
  // Monitor runs commands too, and its rules are written under its own name.
  register(
    SHELL_TOOL_NAME,
    createShellToolChecker(
      SHELL_TOOL_NAME,
      deps.getShellReadOnlyContext,
      deps.internalPaths,
    ),
  );
  register(
    MONITOR_TOOL_NAME,
    createShellToolChecker(
      MONITOR_TOOL_NAME,
      deps.getShellReadOnlyContext,
      deps.internalPaths,
    ),
  );
  register(
    POWERSHELL_TOOL_NAME,
    createPowerShellToolChecker(
      deps.getShellReadOnlyContext,
      deps.internalPaths,
    ),
  );
  register(AGENT_TOOL_NAME, createAgentToolChecker(AGENT_TOOL_NAME));
  register(
    SKILL_TOOL_NAME,
    createSkillToolChecker(SKILL_TOOL_NAME, deps.skill),
  );
  register(WORKFLOW_TOOL_NAME, createWorkflowToolChecker(WORKFLOW_TOOL_NAME));
  // The lazy MCP dispatcher names its server and tool in the input.
  register(MCP_CALL_TOOL_NAME, createMcpCallToolChecker(deps.mcpCall));
  // Its two discovery helpers only describe what is connected. They stay
  // rule-governed — a user can deny one — but need no prompt of their own.
  register(MCP_LIST_TOOL_NAME, createMcpListToolChecker(MCP_LIST_TOOL_NAME));
  register(MCP_GET_TOOL_NAME, createMcpGetToolChecker(MCP_GET_TOOL_NAME));
  register(
    WEB_FETCH_TOOL_NAME,
    createWebFetchToolChecker(WEB_FETCH_TOOL_NAME, isPreapprovedHost),
  );

  // ── Reach outside the session, keyed only by their own name ───────────────
  register(
    WEB_SEARCH_TOOL_NAME,
    createWebSearchToolChecker(WEB_SEARCH_TOOL_NAME),
  );
  register(
    IMAGE_SEARCH_TOOL_NAME,
    createImageSearchToolChecker(IMAGE_SEARCH_TOOL_NAME),
  );
  register(IMAGE_GEN_TOOL_NAME, createImageGenToolChecker(IMAGE_GEN_TOOL_NAME));
  register(
    SEND_MESSAGE_TOOL_NAME,
    createSendMessageToolChecker(SEND_MESSAGE_TOOL_NAME),
  );
  // Worktrees create and remove directories outside the session's own state.
  register(
    ENTER_WORKTREE_TOOL_NAME,
    createEnterWorktreeToolChecker(ENTER_WORKTREE_TOOL_NAME),
  );
  register(
    EXIT_WORKTREE_TOOL_NAME,
    createExitWorktreeToolChecker(EXIT_WORKTREE_TOOL_NAME),
  );
  // A cron entry runs prompts later, on its own.
  register(
    CRON_CREATE_TOOL_NAME,
    createCronCreateToolChecker(CRON_CREATE_TOOL_NAME),
  );
  register(
    CRON_DELETE_TOOL_NAME,
    createCronDeleteToolChecker(CRON_DELETE_TOOL_NAME),
  );
  // Plan entry is a mode change the user should see.
  register(
    ENTER_PLAN_MODE_TOOL_NAME,
    createEnterPlanModeToolChecker(ENTER_PLAN_MODE_TOOL_NAME),
  );

  // ── The prompt is the feature ─────────────────────────────────────────────
  register(ASK_USER_TOOL_NAME, createAskUserToolChecker(ASK_USER_TOOL_NAME));
  register(
    EXIT_PLAN_MODE_TOOL_NAME,
    createExitPlanModeToolChecker(EXIT_PLAN_MODE_TOOL_NAME),
  );

  // Writing to a PTY session is equivalent to executing commands: never the
  // default allow; with no matching rule the permission mode resolves the
  // gap-shaped ask. Reading output and resizing are observation/viewport only
  // and stay allowed, but keep their own decision points so permission
  // reports can tell them apart.
  register(
    BASH_INPUT_TOOL_NAME,
    createBashInputToolChecker(BASH_INPUT_TOOL_NAME),
  );
  register(
    BASH_OUTPUT_TOOL_NAME,
    createBashOutputToolChecker(BASH_OUTPUT_TOOL_NAME),
  );
  register(
    BASH_RESIZE_TOOL_NAME,
    createBashResizeToolChecker(BASH_RESIZE_TOOL_NAME),
  );

  // ── Session-local: no effect a user needs to approve ──────────────────────
  for (const name of SESSION_LOCAL_TOOL_NAMES) {
    register(name, createDefaultToolChecker(name));
  }

  for (const [name, checker] of pluginCheckers) {
    // Product plugins are trusted host contributions. Register them last so a
    // migrated product tool can replace the legacy checker still shipped by
    // Core during the extraction. Duplicate names between plugins are rejected
    // while their contributions are collected.
    register(name, checker);
  }

  return map;
}
