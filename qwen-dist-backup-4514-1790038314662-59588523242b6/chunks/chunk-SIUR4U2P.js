// Force strict mode and setup for ESM
"use strict";
import {
  SkillError
} from "./chunk-IMV5DBIP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/acp-bridge/src/status.ts
init_esbuild_shims();
var STATUS_SCHEMA_VERSION = 1;
var BridgeTimeoutError = class extends Error {
  static {
    __name(this, "BridgeTimeoutError");
  }
  label;
  timeoutMs;
  constructor(label, timeoutMs) {
    super(`AcpSessionBridge ${label} timed out after ${timeoutMs}ms`);
    this.name = "BridgeTimeoutError";
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
};
var SessionRestoreTimeoutError = class extends BridgeTimeoutError {
  static {
    __name(this, "SessionRestoreTimeoutError");
  }
  sessionId;
  action;
  constructor(sessionId, action, timeoutMs) {
    super(`session/${action}`, timeoutMs);
    this.name = "SessionRestoreTimeoutError";
    this.sessionId = sessionId;
    this.action = action;
  }
};
var BridgeChannelClosedError = class extends Error {
  static {
    __name(this, "BridgeChannelClosedError");
  }
  context;
  constructor(context) {
    super(`agent channel closed ${context}`);
    this.name = "BridgeChannelClosedError";
    this.context = context;
  }
};
var MissingCliEntryError = class extends Error {
  static {
    __name(this, "MissingCliEntryError");
  }
  constructor() {
    super(
      "Cannot determine CLI entry path for spawning the ACP child: process.argv[1] is empty and QWEN_CLI_ENTRY is unset. Set QWEN_CLI_ENTRY to the absolute path of the qwen entry script (e.g. `export QWEN_CLI_ENTRY=$(which qwen)`) to override."
    );
    this.name = "MissingCliEntryError";
  }
};
var SERVE_STATUS_EXT_METHODS = {
  channelPing: "qwen/status/channel/ping",
  workspaceMcp: "qwen/status/workspace/mcp",
  workspaceMcpTools: "qwen/status/workspace/mcp/tools",
  workspaceMcpResources: "qwen/status/workspace/mcp/resources",
  workspaceSkills: "qwen/status/workspace/skills",
  workspaceTools: "qwen/status/workspace/tools",
  workspaceProviders: "qwen/status/workspace/providers",
  workspaceMemory: "qwen/status/workspace/memory",
  workspaceAgents: "qwen/status/workspace/agents",
  workspacePreflight: "qwen/status/workspace/preflight",
  sessionContext: "qwen/status/session/context",
  sessionContextUsage: "qwen/status/session/context_usage",
  sessionSupportedCommands: "qwen/status/session/supported_commands",
  sessionTasks: "qwen/status/session/tasks",
  sessionAgents: "qwen/status/session/agents",
  sessionAgentTrace: "qwen/status/session/agent_trace",
  sessionStats: "qwen/status/session/stats",
  sessionLspStatus: "qwen/status/session/lsp",
  sessionResources: "qwen/status/session/resources",
  /**
   * Read one saved workflow definition (script + parsed `meta`). Params:
   * `{ sessionId, name }`; result: `ServeSessionSavedWorkflowStatus`, whose
   * `workflow` is null when the name is unknown or Workflow controls are
   * unavailable.
   */
  sessionSavedWorkflow: "qwen/status/session/saved_workflow",
  sessionTranscript: "qwen/status/session/transcript",
  sessionTurnIndex: "qwen/status/session/turn_index",
  sessionRewindSnapshots: "qwen/status/session/rewind_snapshots",
  workspaceHooks: "qwen/status/workspace/hooks",
  sessionHooks: "qwen/status/session/hooks",
  workspaceExtensions: "qwen/status/workspace/extensions",
  // Process-wide rss/cpu of this ACP child, self-reported to the daemon for
  // the Daemon Status resource charts (workspace-scoped; no sessionId).
  workspaceResource: "qwen/status/workspace/resource"
};
var SERVE_CONTROL_EXT_METHODS = {
  sessionClose: "qwen/control/session/close",
  sessionApprovalMode: "qwen/control/session/approval_mode",
  sessionBranch: "qwen/control/session/branch",
  sessionSideTask: "qwen/control/session/side_task",
  sessionForkAgent: "qwen/control/session/fork_agent",
  sessionRecap: "qwen/control/session/recap",
  sessionGenerationStart: "qwen/control/session/generation/start",
  sessionGenerationCancel: "qwen/control/session/generation/cancel",
  sessionBtw: "qwen/control/session/btw",
  sessionShellHistory: "qwen/control/session/shell_history",
  sessionLanguage: "qwen/control/session/language",
  sessionRewind: "qwen/control/session/rewind",
  sessionContinue: "qwen/control/session/continue",
  sessionTitle: "qwen/control/session/title",
  sessionParent: "qwen/control/session/parent",
  sessionSource: "qwen/control/session/source",
  sessionLiveConversation: "qwen/control/session/live-conversation",
  sessionLiveTranscript: "qwen/control/session/live-transcript",
  sessionBackgroundNotification: "qwen/control/session/background_notification",
  sessionArtifactsPersist: "qwen/control/session/artifacts/persist",
  workspaceMcpRestart: "qwen/control/workspace/mcp/restart",
  workspaceMcpManage: "qwen/control/workspace/mcp/manage",
  workspaceMcpInitialize: "qwen/control/workspace/mcp/initialize",
  workspaceMcpReload: "qwen/control/workspace/mcp/reload",
  workspaceAgentGenerate: "qwen/control/workspace/agents/generate",
  workspaceGenerationStart: "qwen/control/workspace/generation/start",
  workspaceGenerationCancel: "qwen/control/workspace/generation/cancel",
  workspaceSessionWorkflow: "qwen/control/workspace/session-workflow",
  workspaceMemoryRememberAvailability: "qwen/control/workspace/memory/remember/availability",
  workspaceMemoryRemember: "qwen/control/workspace/memory/remember",
  workspaceMemoryForget: "qwen/control/workspace/memory/forget",
  workspaceMemoryDream: "qwen/control/workspace/memory/dream",
  /**
   * Sessionless user-level language sync: the runtime switches its process
   * UI language, reloads the user-scope settings the daemon already
   * persisted, and, when `syncOutputLanguage` is true, refreshes every local
   * session's system instruction.
   * Params: `{ language, syncOutputLanguage }`; result:
   * `{ language, sessions, failed }`.
   */
  userLanguage: "qwen/control/user/language",
  // Runtime MCP server mutation ext-methods
  sessionTaskCancel: "qwen/control/session/task/cancel",
  /**
   * Control a workflow run, delete its history, or start a new run from a
   * saved definition or a caller-supplied script. Params:
   * `{ sessionId, taskId, action }` plus the optional start input
   * ({@link ServeWorkflowActionInput}) the two start actions read.
   */
  sessionWorkflowTaskAction: "qwen/control/session/task/workflow-action",
  sessionGoalControl: "qwen/control/session/goal/control",
  sessionGoalClear: "qwen/control/session/goal/clear",
  /**
   * Read a live session's `/goal` state from the child's Goal runtime. Params:
   * `{ sessionId }`; result: `BridgeSessionGoal` — the runtime's
   * `GoalSnapshotV2` plus `active`, a projection of it for clients that still
   * read the older shape.
   */
  sessionGoalGet: "qwen/control/session/goal/get",
  sessionMcpRuntimeAdd: "qwen/control/session/mcp/runtime-add",
  sessionMcpRuntimeRemove: "qwen/control/session/mcp/runtime-remove",
  /** Read a bounded settled `turn_result` from the active transcript. */
  sessionTurnStatus: "qwen/control/session/turn_status",
  workspaceMcpRuntimeAdd: "qwen/control/workspace/mcp/runtime-add",
  workspaceMcpRuntimeRemove: "qwen/control/workspace/mcp/runtime-remove",
  workspaceModelProvidersReload: "qwen/control/workspace/model-providers/reload",
  workspaceReload: "qwen/control/workspace/reload",
  workspaceSkillsRefresh: "qwen/control/workspace/skills/refresh",
  workspaceExtensionsRefresh: "qwen/control/workspace/extensions/refresh",
  /**
   * Reverse tool channel (issue #5626, Phase 2). Unlike every other entry
   * here — which the PARENT serve process calls DOWN into the `qwen --acp`
   * child — this one is called by the CHILD UP into the parent: a
   * client-hosted (extension) MCP server's `sendSdkMcpMessage` round-trips a
   * JSON-RPC `mcp_message` from the child's `McpClientManager` back to the
   * parent's `ClientMcpRegistrar`, which pushes it down the daemon WS to the
   * client and returns the correlated response. Params: `{ server, payload }`;
   * result: `{ payload }`.
   */
  clientMcpMessage: "qwen/control/client_mcp/message",
  /**
   * Called by a private ACP CHILD immediately before a tool executor. The
   * parent validates the runtime-owned session/prompt identity, invokes its
   * configured external provider once, and returns allow/deny. Unavailable
   * unless the daemon explicitly enabled required external guarding.
   */
  externalToolGuardPrepare: "qwen/control/external_tool_guard/prepare",
  sessionCd: "qwen/control/session/cd",
  sessionManagedConversationBindingCommit: "qwen/control/session/managed-conversation-binding/commit",
  sessionManagedConversationBindingRelease: "qwen/control/session/managed-conversation-binding/release",
  /**
   * Also called by the CHILD UP into the parent (like `clientMcpMessage`): the
   * `create_sub_session` tool, running inside a child's agent turn, asks the
   * daemon to spawn a fresh top-level sub-session and run a prompt in it. Params:
   * `{ prompt, completion:'sent'|'first-turn', model?, name?, callerSessionId? }`;
   * result: `{ sessionId, result?, stopReason? }` (result present only for the
   * `first-turn` mode, which waits for the sub-session's first turn to finish).
   */
  createSubSession: "qwen/control/create-sub-session",
  createCurrentSessionScheduledTask: "qwen/control/scheduled-task/create-current",
  liveCaptureScreenContext: "qwen/control/live/capture-screen-context",
  liveTaskTool: "qwen/control/live/task-tool",
  liveSpeakToUser: "qwen/control/live/speak-to-user",
  channelDelivery: "qwen/control/channel-delivery"
};
function readServeWorkflowActionInput(body) {
  const input = {};
  if (Object.hasOwn(body, "args")) input.args = body["args"];
  if (Object.hasOwn(body, "sourceRef")) {
    input.sourceRef = body["sourceRef"];
  }
  if (Object.hasOwn(body, "script")) {
    input.script = body["script"];
  }
  return Object.keys(input).length > 0 ? input : void 0;
}
__name(readServeWorkflowActionInput, "readServeWorkflowActionInput");
var IDLE_HOOK_EVENTS = {
  PreToolUse: { description: "Before tool execution", matcherKind: "toolName" },
  PostToolUse: { description: "After tool execution", matcherKind: "toolName" },
  PostToolUseFailure: {
    description: "After tool execution fails",
    matcherKind: "toolName"
  },
  PostToolBatch: { description: "After a batch of tool calls resolves" },
  Notification: {
    description: "When notifications are sent",
    matcherKind: "notificationType"
  },
  UserPromptSubmit: { description: "When the user submits a prompt" },
  UserPromptExpansion: {
    description: "When a slash command expands into a prompt",
    matcherKind: "commandName"
  },
  SessionStart: {
    description: "When a new session is started",
    matcherKind: "sessionTrigger"
  },
  MessageDisplay: {
    description: "Repeatedly, as the assistant reply streams"
  },
  Stop: { description: "Right before Qwen Code concludes its response" },
  SubagentStart: {
    description: "When a subagent is started",
    matcherKind: "agentType"
  },
  SubagentStop: {
    description: "Right before a subagent concludes its response",
    matcherKind: "agentType"
  },
  PreCompact: {
    description: "Before conversation compaction",
    matcherKind: "trigger"
  },
  PostCompact: {
    description: "After conversation compaction",
    matcherKind: "trigger"
  },
  SessionEnd: {
    description: "When a session is ending",
    matcherKind: "sessionTrigger"
  },
  SessionDelete: {
    description: "After an explicitly selected session is deleted"
  },
  PermissionRequest: {
    description: "When a permission dialog is displayed",
    matcherKind: "toolName"
  },
  PermissionDenied: {
    description: "When a tool call is denied",
    matcherKind: "toolName"
  },
  StopFailure: {
    description: "When the turn ends due to an API error",
    matcherKind: "error"
  },
  TodoCreated: { description: "When a new todo item is created" },
  TodoCompleted: { description: "When a todo item is marked as completed" },
  InstructionsLoaded: {
    description: "When an instruction or context file is loaded",
    matcherKind: "filePath"
  }
};
function createIdleWorkspaceExtensionsStatus(workspaceCwd) {
  return {
    v: STATUS_SCHEMA_VERSION,
    workspaceCwd,
    initialized: false,
    extensions: []
  };
}
__name(createIdleWorkspaceExtensionsStatus, "createIdleWorkspaceExtensionsStatus");
function createIdleWorkspaceHooksStatus(workspaceCwd) {
  return {
    v: STATUS_SCHEMA_VERSION,
    workspaceCwd,
    initialized: false,
    disabled: false,
    hooks: [],
    events: IDLE_HOOK_EVENTS
  };
}
__name(createIdleWorkspaceHooksStatus, "createIdleWorkspaceHooksStatus");
function createIdleWorkspaceMemoryStatus(workspaceCwd) {
  return {
    v: STATUS_SCHEMA_VERSION,
    workspaceCwd,
    initialized: false,
    files: [],
    totalBytes: 0,
    fileCount: 0,
    ruleCount: 0
  };
}
__name(createIdleWorkspaceMemoryStatus, "createIdleWorkspaceMemoryStatus");
function createIdleWorkspaceMcpStatus(workspaceCwd) {
  return {
    v: STATUS_SCHEMA_VERSION,
    workspaceCwd,
    initialized: false,
    discoveryState: "not_started",
    servers: [],
    clientCount: 0,
    budgetMode: "off",
    budgets: []
  };
}
__name(createIdleWorkspaceMcpStatus, "createIdleWorkspaceMcpStatus");
function createIdleWorkspaceSkillsStatus(workspaceCwd) {
  return {
    v: STATUS_SCHEMA_VERSION,
    workspaceCwd,
    initialized: false,
    skills: []
  };
}
__name(createIdleWorkspaceSkillsStatus, "createIdleWorkspaceSkillsStatus");
function createIdleWorkspaceProvidersStatus(workspaceCwd) {
  return {
    v: STATUS_SCHEMA_VERSION,
    workspaceCwd,
    initialized: false,
    providers: []
  };
}
__name(createIdleWorkspaceProvidersStatus, "createIdleWorkspaceProvidersStatus");
function createIdleEnvStatus(workspaceCwd, acpChannelLive) {
  return {
    v: STATUS_SCHEMA_VERSION,
    workspaceCwd,
    initialized: true,
    acpChannelLive,
    cells: []
  };
}
__name(createIdleEnvStatus, "createIdleEnvStatus");
var ACP_PREFLIGHT_KINDS = [
  "auth",
  "mcp_discovery",
  "skills",
  "providers",
  "tool_registry",
  "egress"
];
function createIdleAcpPreflightCells() {
  return ACP_PREFLIGHT_KINDS.map((kind) => ({
    kind,
    status: "not_started",
    locality: "acp",
    hint: "spawn a session to populate"
  }));
}
__name(createIdleAcpPreflightCells, "createIdleAcpPreflightCells");
var SKILL_PARSE_CODES = /* @__PURE__ */ new Set([
  "PARSE_ERROR",
  "INVALID_CONFIG",
  "INVALID_NAME"
]);
var SKILL_FILE_CODES = /* @__PURE__ */ new Set([
  "FILE_ERROR",
  "NOT_FOUND"
]);
var FS_MISSING_CODES = /* @__PURE__ */ new Set([
  "ENOENT",
  "EACCES",
  "EPERM"
]);
var MODEL_CONFIG_ERROR_NAMES = /* @__PURE__ */ new Set([
  "StrictMissingCredentialsError",
  "StrictMissingModelIdError",
  "MissingApiKeyError",
  "MissingModelError",
  "MissingBaseUrlError",
  "MissingAnthropicBaseUrlEnvError"
]);
function mapDomainErrorToErrorKind(err) {
  if (err instanceof SessionRestoreTimeoutError) return "restore_timeout";
  if (err instanceof BridgeTimeoutError) return "init_timeout";
  if (err instanceof BridgeChannelClosedError) return "protocol_error";
  if (err instanceof MissingCliEntryError) return "missing_binary";
  if (err instanceof SkillError || err?.name === "SkillError") {
    const code2 = err.code;
    if (code2 && SKILL_PARSE_CODES.has(code2)) return "parse_error";
    if (code2 && SKILL_FILE_CODES.has(code2)) return "missing_file";
    return void 0;
  }
  if (err instanceof SyntaxError) return "parse_error";
  if (!(err instanceof Error)) return void 0;
  if (err.name === "TrustGateError") return "auth_env_error";
  if (MODEL_CONFIG_ERROR_NAMES.has(err.name)) return "auth_env_error";
  const code = err.code;
  if (typeof code === "string" && FS_MISSING_CODES.has(code)) {
    return "missing_file";
  }
  return void 0;
}
__name(mapDomainErrorToErrorKind, "mapDomainErrorToErrorKind");

export {
  STATUS_SCHEMA_VERSION,
  BridgeTimeoutError,
  SessionRestoreTimeoutError,
  BridgeChannelClosedError,
  MissingCliEntryError,
  SERVE_STATUS_EXT_METHODS,
  SERVE_CONTROL_EXT_METHODS,
  readServeWorkflowActionInput,
  IDLE_HOOK_EVENTS,
  createIdleWorkspaceExtensionsStatus,
  createIdleWorkspaceHooksStatus,
  createIdleWorkspaceMemoryStatus,
  createIdleWorkspaceMcpStatus,
  createIdleWorkspaceSkillsStatus,
  createIdleWorkspaceProvidersStatus,
  createIdleEnvStatus,
  ACP_PREFLIGHT_KINDS,
  createIdleAcpPreflightCells,
  mapDomainErrorToErrorKind
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
