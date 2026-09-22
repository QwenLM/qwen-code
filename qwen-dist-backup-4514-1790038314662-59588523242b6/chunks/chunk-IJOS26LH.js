// Force strict mode and setup for ESM
"use strict";
import {
  external_exports,
  external_exports2
} from "./chunk-CQ35AJ4Z.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// node_modules/@agentclientprotocol/sdk/dist/schema/index.js
init_esbuild_shims();
var AGENT_METHODS = {
  authenticate: "authenticate",
  initialize: "initialize",
  session_cancel: "session/cancel",
  session_fork: "session/fork",
  session_list: "session/list",
  session_load: "session/load",
  session_new: "session/new",
  session_prompt: "session/prompt",
  session_resume: "session/resume",
  session_set_config_option: "session/set_config_option",
  session_set_mode: "session/set_mode",
  session_set_model: "session/set_model"
};
var CLIENT_METHODS = {
  fs_read_text_file: "fs/read_text_file",
  fs_write_text_file: "fs/write_text_file",
  session_request_permission: "session/request_permission",
  session_update: "session/update",
  terminal_create: "terminal/create",
  terminal_kill: "terminal/kill",
  terminal_output: "terminal/output",
  terminal_release: "terminal/release",
  terminal_wait_for_exit: "terminal/wait_for_exit"
};
var PROTOCOL_VERSION = 1;

// node_modules/@agentclientprotocol/sdk/dist/schema/zod.gen.js
init_esbuild_shims();

// node_modules/zod/v4/classic/index.js
init_esbuild_shims();

// node_modules/@agentclientprotocol/sdk/dist/schema/zod.gen.js
var zAuthMethod = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  description: external_exports2.union([external_exports2.string(), external_exports2.null()]).optional(),
  id: external_exports2.string(),
  name: external_exports2.string()
});
var zAuthenticateRequest = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  methodId: external_exports2.string()
});
var zAuthenticateResponse = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional()
});
var zBlobResourceContents = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  blob: external_exports2.string(),
  mimeType: external_exports2.union([external_exports2.string(), external_exports2.null()]).optional(),
  uri: external_exports2.string()
});
var zCost = external_exports2.object({
  amount: external_exports2.number(),
  currency: external_exports2.string()
});
var zCreateTerminalResponse = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  terminalId: external_exports2.string()
});
var zDiff = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  newText: external_exports2.string(),
  oldText: external_exports2.union([external_exports2.string(), external_exports2.null()]).optional(),
  path: external_exports2.string()
});
var zEnvVariable = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  name: external_exports2.string(),
  value: external_exports2.string()
});
var zErrorCode = external_exports2.union([
  external_exports2.literal(-32700),
  external_exports2.literal(-32600),
  external_exports2.literal(-32601),
  external_exports2.literal(-32602),
  external_exports2.literal(-32603),
  external_exports2.literal(-32800),
  external_exports2.literal(-32e3),
  external_exports2.literal(-32002),
  external_exports2.number().int().min(-2147483648, {
    message: "Invalid value: Expected int32 to be >= -2147483648"
  }).max(2147483647, {
    message: "Invalid value: Expected int32 to be <= 2147483647"
  })
]);
var zError = external_exports2.object({
  code: zErrorCode,
  data: external_exports2.unknown().optional(),
  message: external_exports2.string()
});
var zExtNotification = external_exports2.unknown();
var zExtRequest = external_exports2.unknown();
var zExtResponse = external_exports2.unknown();
var zFileSystemCapability = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  readTextFile: external_exports2.boolean().optional().default(false),
  writeTextFile: external_exports2.boolean().optional().default(false)
});
var zClientCapabilities = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  fs: zFileSystemCapability.optional().default({ readTextFile: false, writeTextFile: false }),
  terminal: external_exports2.boolean().optional().default(false)
});
var zHttpHeader = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  name: external_exports2.string(),
  value: external_exports2.string()
});
var zImplementation = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  name: external_exports2.string(),
  title: external_exports2.union([external_exports2.string(), external_exports2.null()]).optional(),
  version: external_exports2.string()
});
var zKillTerminalCommandResponse = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional()
});
var zListSessionsRequest = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  cursor: external_exports2.union([external_exports2.string(), external_exports2.null()]).optional(),
  cwd: external_exports2.union([external_exports2.string(), external_exports2.null()]).optional()
});
var zMcpCapabilities = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  http: external_exports2.boolean().optional().default(false),
  sse: external_exports2.boolean().optional().default(false)
});
var zMcpServerHttp = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  headers: external_exports2.array(zHttpHeader),
  name: external_exports2.string(),
  url: external_exports2.string()
});
var zMcpServerSse = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  headers: external_exports2.array(zHttpHeader),
  name: external_exports2.string(),
  url: external_exports2.string()
});
var zMcpServerStdio = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  args: external_exports2.array(external_exports2.string()),
  command: external_exports2.string(),
  env: external_exports2.array(zEnvVariable),
  name: external_exports2.string()
});
var zMcpServer = external_exports2.union([
  zMcpServerHttp.and(external_exports2.object({
    type: external_exports2.literal("http")
  })),
  zMcpServerSse.and(external_exports2.object({
    type: external_exports2.literal("sse")
  })),
  zMcpServerStdio
]);
var zModelId = external_exports2.string();
var zModelInfo = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  description: external_exports2.union([external_exports2.string(), external_exports2.null()]).optional(),
  modelId: zModelId,
  name: external_exports2.string()
});
var zNewSessionRequest = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  cwd: external_exports2.string(),
  mcpServers: external_exports2.array(zMcpServer)
});
var zPermissionOptionId = external_exports2.string();
var zPermissionOptionKind = external_exports2.union([
  external_exports2.literal("allow_once"),
  external_exports2.literal("allow_always"),
  external_exports2.literal("reject_once"),
  external_exports2.literal("reject_always")
]);
var zPermissionOption = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  kind: zPermissionOptionKind,
  name: external_exports2.string(),
  optionId: zPermissionOptionId
});
var zPlanEntryPriority = external_exports2.union([
  external_exports2.literal("high"),
  external_exports2.literal("medium"),
  external_exports2.literal("low")
]);
var zPlanEntryStatus = external_exports2.union([
  external_exports2.literal("pending"),
  external_exports2.literal("in_progress"),
  external_exports2.literal("completed")
]);
var zPlanEntry = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  content: external_exports2.string(),
  priority: zPlanEntryPriority,
  status: zPlanEntryStatus
});
var zPlan = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  entries: external_exports2.array(zPlanEntry)
});
var zPromptCapabilities = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  audio: external_exports2.boolean().optional().default(false),
  embeddedContext: external_exports2.boolean().optional().default(false),
  image: external_exports2.boolean().optional().default(false)
});
var zProtocolVersion = external_exports2.number().int().gte(0).lte(65535);
var zInitializeRequest = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  clientCapabilities: zClientCapabilities.optional().default({
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false
  }),
  clientInfo: external_exports2.union([zImplementation, external_exports2.null()]).optional(),
  protocolVersion: zProtocolVersion
});
var zReadTextFileResponse = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  content: external_exports2.string()
});
var zReleaseTerminalResponse = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional()
});
var zRequestId = external_exports2.union([external_exports2.null(), external_exports2.number(), external_exports2.string()]);
var zCancelRequestNotification = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  requestId: zRequestId
});
var zRole = external_exports2.enum(["assistant", "user"]);
var zAnnotations = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  audience: external_exports2.union([external_exports2.array(zRole), external_exports2.null()]).optional(),
  lastModified: external_exports2.union([external_exports2.string(), external_exports2.null()]).optional(),
  priority: external_exports2.union([external_exports2.number(), external_exports2.null()]).optional()
});
var zAudioContent = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  annotations: external_exports2.union([zAnnotations, external_exports2.null()]).optional(),
  data: external_exports2.string(),
  mimeType: external_exports2.string()
});
var zImageContent = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  annotations: external_exports2.union([zAnnotations, external_exports2.null()]).optional(),
  data: external_exports2.string(),
  mimeType: external_exports2.string(),
  uri: external_exports2.union([external_exports2.string(), external_exports2.null()]).optional()
});
var zResourceLink = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  annotations: external_exports2.union([zAnnotations, external_exports2.null()]).optional(),
  description: external_exports2.union([external_exports2.string(), external_exports2.null()]).optional(),
  mimeType: external_exports2.union([external_exports2.string(), external_exports2.null()]).optional(),
  name: external_exports2.string(),
  size: external_exports2.union([external_exports2.number(), external_exports2.null()]).optional(),
  title: external_exports2.union([external_exports2.string(), external_exports2.null()]).optional(),
  uri: external_exports2.string()
});
var zSelectedPermissionOutcome = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  optionId: zPermissionOptionId
});
var zRequestPermissionOutcome = external_exports2.union([
  external_exports2.object({
    outcome: external_exports2.literal("cancelled")
  }),
  zSelectedPermissionOutcome.and(external_exports2.object({
    outcome: external_exports2.literal("selected")
  }))
]);
var zRequestPermissionResponse = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  outcome: zRequestPermissionOutcome
});
var zSessionConfigGroupId = external_exports2.string();
var zSessionConfigId = external_exports2.string();
var zSessionConfigOptionCategory = external_exports2.union([
  external_exports2.literal("mode"),
  external_exports2.literal("model"),
  external_exports2.literal("thought_level"),
  external_exports2.string()
]);
var zSessionConfigValueId = external_exports2.string();
var zSessionConfigSelectOption = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  description: external_exports2.union([external_exports2.string(), external_exports2.null()]).optional(),
  name: external_exports2.string(),
  value: zSessionConfigValueId
});
var zSessionConfigSelectGroup = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  group: zSessionConfigGroupId,
  name: external_exports2.string(),
  options: external_exports2.array(zSessionConfigSelectOption)
});
var zSessionConfigSelectOptions = external_exports2.union([
  external_exports2.array(zSessionConfigSelectOption),
  external_exports2.array(zSessionConfigSelectGroup)
]);
var zSessionConfigSelect = external_exports2.object({
  currentValue: zSessionConfigValueId,
  options: zSessionConfigSelectOptions
});
var zSessionConfigOption = zSessionConfigSelect.and(external_exports2.object({
  type: external_exports2.literal("select")
})).and(external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  category: external_exports2.union([zSessionConfigOptionCategory, external_exports2.null()]).optional(),
  description: external_exports2.union([external_exports2.string(), external_exports2.null()]).optional(),
  id: zSessionConfigId,
  name: external_exports2.string()
}));
var zConfigOptionUpdate = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  configOptions: external_exports2.array(zSessionConfigOption)
});
var zSessionForkCapabilities = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional()
});
var zSessionId = external_exports2.string();
var zCancelNotification = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  sessionId: zSessionId
});
var zClientNotification = external_exports2.object({
  method: external_exports2.string(),
  params: external_exports2.union([external_exports2.union([zCancelNotification, zExtNotification]), external_exports2.null()]).optional()
});
var zCreateTerminalRequest = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  args: external_exports2.array(external_exports2.string()).optional(),
  command: external_exports2.string(),
  cwd: external_exports2.union([external_exports2.string(), external_exports2.null()]).optional(),
  env: external_exports2.array(zEnvVariable).optional(),
  outputByteLimit: external_exports2.union([external_exports2.number(), external_exports2.null()]).optional(),
  sessionId: zSessionId
});
var zForkSessionRequest = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  cwd: external_exports2.string(),
  mcpServers: external_exports2.array(zMcpServer).optional(),
  sessionId: zSessionId
});
var zKillTerminalCommandRequest = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  sessionId: zSessionId,
  terminalId: external_exports2.string()
});
var zLoadSessionRequest = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  cwd: external_exports2.string(),
  mcpServers: external_exports2.array(zMcpServer),
  sessionId: zSessionId
});
var zReadTextFileRequest = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  limit: external_exports2.union([
    external_exports2.number().int().gte(0).max(4294967295, {
      message: "Invalid value: Expected uint32 to be <= 4294967295"
    }),
    external_exports2.null()
  ]).optional(),
  line: external_exports2.union([
    external_exports2.number().int().gte(0).max(4294967295, {
      message: "Invalid value: Expected uint32 to be <= 4294967295"
    }),
    external_exports2.null()
  ]).optional(),
  path: external_exports2.string(),
  sessionId: zSessionId
});
var zReleaseTerminalRequest = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  sessionId: zSessionId,
  terminalId: external_exports2.string()
});
var zResumeSessionRequest = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  cwd: external_exports2.string(),
  mcpServers: external_exports2.array(zMcpServer).optional(),
  sessionId: zSessionId
});
var zSessionInfo = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  cwd: external_exports2.string(),
  sessionId: zSessionId,
  title: external_exports2.union([external_exports2.string(), external_exports2.null()]).optional(),
  updatedAt: external_exports2.union([external_exports2.string(), external_exports2.null()]).optional()
});
var zListSessionsResponse = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  nextCursor: external_exports2.union([external_exports2.string(), external_exports2.null()]).optional(),
  sessions: external_exports2.array(zSessionInfo)
});
var zSessionInfoUpdate = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  title: external_exports2.union([external_exports2.string(), external_exports2.null()]).optional(),
  updatedAt: external_exports2.union([external_exports2.string(), external_exports2.null()]).optional()
});
var zSessionListCapabilities = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional()
});
var zSessionModeId = external_exports2.string();
var zCurrentModeUpdate = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  currentModeId: zSessionModeId
});
var zSessionMode = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  description: external_exports2.union([external_exports2.string(), external_exports2.null()]).optional(),
  id: zSessionModeId,
  name: external_exports2.string()
});
var zSessionModeState = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  availableModes: external_exports2.array(zSessionMode),
  currentModeId: zSessionModeId
});
var zSessionModelState = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  availableModels: external_exports2.array(zModelInfo),
  currentModelId: zModelId
});
var zForkSessionResponse = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  configOptions: external_exports2.union([external_exports2.array(zSessionConfigOption), external_exports2.null()]).optional(),
  models: external_exports2.union([zSessionModelState, external_exports2.null()]).optional(),
  modes: external_exports2.union([zSessionModeState, external_exports2.null()]).optional(),
  sessionId: zSessionId
});
var zLoadSessionResponse = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  configOptions: external_exports2.union([external_exports2.array(zSessionConfigOption), external_exports2.null()]).optional(),
  models: external_exports2.union([zSessionModelState, external_exports2.null()]).optional(),
  modes: external_exports2.union([zSessionModeState, external_exports2.null()]).optional()
});
var zNewSessionResponse = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  configOptions: external_exports2.union([external_exports2.array(zSessionConfigOption), external_exports2.null()]).optional(),
  models: external_exports2.union([zSessionModelState, external_exports2.null()]).optional(),
  modes: external_exports2.union([zSessionModeState, external_exports2.null()]).optional(),
  sessionId: zSessionId
});
var zResumeSessionResponse = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  configOptions: external_exports2.union([external_exports2.array(zSessionConfigOption), external_exports2.null()]).optional(),
  models: external_exports2.union([zSessionModelState, external_exports2.null()]).optional(),
  modes: external_exports2.union([zSessionModeState, external_exports2.null()]).optional()
});
var zSessionResumeCapabilities = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional()
});
var zSessionCapabilities = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  fork: external_exports2.union([zSessionForkCapabilities, external_exports2.null()]).optional(),
  list: external_exports2.union([zSessionListCapabilities, external_exports2.null()]).optional(),
  resume: external_exports2.union([zSessionResumeCapabilities, external_exports2.null()]).optional()
});
var zAgentCapabilities = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  loadSession: external_exports2.boolean().optional().default(false),
  mcpCapabilities: zMcpCapabilities.optional().default({ http: false, sse: false }),
  promptCapabilities: zPromptCapabilities.optional().default({
    audio: false,
    embeddedContext: false,
    image: false
  }),
  sessionCapabilities: zSessionCapabilities.optional().default({})
});
var zInitializeResponse = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  agentCapabilities: zAgentCapabilities.optional().default({
    loadSession: false,
    mcpCapabilities: { http: false, sse: false },
    promptCapabilities: {
      audio: false,
      embeddedContext: false,
      image: false
    },
    sessionCapabilities: {}
  }),
  agentInfo: external_exports2.union([zImplementation, external_exports2.null()]).optional(),
  authMethods: external_exports2.array(zAuthMethod).optional().default([]),
  protocolVersion: zProtocolVersion
});
var zSetSessionConfigOptionRequest = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  configId: zSessionConfigId,
  sessionId: zSessionId,
  value: zSessionConfigValueId
});
var zSetSessionConfigOptionResponse = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  configOptions: external_exports2.array(zSessionConfigOption)
});
var zSetSessionModeRequest = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  modeId: zSessionModeId,
  sessionId: zSessionId
});
var zSetSessionModeResponse = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional()
});
var zSetSessionModelRequest = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  modelId: zModelId,
  sessionId: zSessionId
});
var zSetSessionModelResponse = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional()
});
var zStopReason = external_exports2.union([
  external_exports2.literal("end_turn"),
  external_exports2.literal("max_tokens"),
  external_exports2.literal("max_turn_requests"),
  external_exports2.literal("refusal"),
  external_exports2.literal("cancelled")
]);
var zTerminal = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  terminalId: external_exports2.string()
});
var zTerminalExitStatus = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  exitCode: external_exports2.union([
    external_exports2.number().int().gte(0).max(4294967295, {
      message: "Invalid value: Expected uint32 to be <= 4294967295"
    }),
    external_exports2.null()
  ]).optional(),
  signal: external_exports2.union([external_exports2.string(), external_exports2.null()]).optional()
});
var zTerminalOutputRequest = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  sessionId: zSessionId,
  terminalId: external_exports2.string()
});
var zTerminalOutputResponse = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  exitStatus: external_exports2.union([zTerminalExitStatus, external_exports2.null()]).optional(),
  output: external_exports2.string(),
  truncated: external_exports2.boolean()
});
var zTextContent = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  annotations: external_exports2.union([zAnnotations, external_exports2.null()]).optional(),
  text: external_exports2.string()
});
var zTextResourceContents = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  mimeType: external_exports2.union([external_exports2.string(), external_exports2.null()]).optional(),
  text: external_exports2.string(),
  uri: external_exports2.string()
});
var zEmbeddedResourceResource = external_exports2.union([
  zTextResourceContents,
  zBlobResourceContents
]);
var zEmbeddedResource = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  annotations: external_exports2.union([zAnnotations, external_exports2.null()]).optional(),
  resource: zEmbeddedResourceResource
});
var zContentBlock = external_exports2.union([
  zTextContent.and(external_exports2.object({
    type: external_exports2.literal("text")
  })),
  zImageContent.and(external_exports2.object({
    type: external_exports2.literal("image")
  })),
  zAudioContent.and(external_exports2.object({
    type: external_exports2.literal("audio")
  })),
  zResourceLink.and(external_exports2.object({
    type: external_exports2.literal("resource_link")
  })),
  zEmbeddedResource.and(external_exports2.object({
    type: external_exports2.literal("resource")
  }))
]);
var zContent = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  content: zContentBlock
});
var zContentChunk = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  content: zContentBlock
});
var zPromptRequest = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  prompt: external_exports2.array(zContentBlock),
  sessionId: zSessionId
});
var zClientRequest = external_exports2.object({
  id: zRequestId,
  method: external_exports2.string(),
  params: external_exports2.union([
    external_exports2.union([
      zInitializeRequest,
      zAuthenticateRequest,
      zNewSessionRequest,
      zLoadSessionRequest,
      zListSessionsRequest,
      zForkSessionRequest,
      zResumeSessionRequest,
      zSetSessionModeRequest,
      zSetSessionConfigOptionRequest,
      zPromptRequest,
      zSetSessionModelRequest,
      zExtRequest
    ]),
    external_exports2.null()
  ]).optional()
});
var zToolCallContent = external_exports2.union([
  zContent.and(external_exports2.object({
    type: external_exports2.literal("content")
  })),
  zDiff.and(external_exports2.object({
    type: external_exports2.literal("diff")
  })),
  zTerminal.and(external_exports2.object({
    type: external_exports2.literal("terminal")
  }))
]);
var zToolCallId = external_exports2.string();
var zToolCallLocation = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  line: external_exports2.union([
    external_exports2.number().int().gte(0).max(4294967295, {
      message: "Invalid value: Expected uint32 to be <= 4294967295"
    }),
    external_exports2.null()
  ]).optional(),
  path: external_exports2.string()
});
var zToolCallStatus = external_exports2.union([
  external_exports2.literal("pending"),
  external_exports2.literal("in_progress"),
  external_exports2.literal("completed"),
  external_exports2.literal("failed")
]);
var zToolKind = external_exports2.union([
  external_exports2.literal("read"),
  external_exports2.literal("edit"),
  external_exports2.literal("delete"),
  external_exports2.literal("move"),
  external_exports2.literal("search"),
  external_exports2.literal("execute"),
  external_exports2.literal("think"),
  external_exports2.literal("fetch"),
  external_exports2.literal("switch_mode"),
  external_exports2.literal("other")
]);
var zToolCall = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  content: external_exports2.array(zToolCallContent).optional(),
  kind: zToolKind.optional(),
  locations: external_exports2.array(zToolCallLocation).optional(),
  rawInput: external_exports2.unknown().optional(),
  rawOutput: external_exports2.unknown().optional(),
  status: zToolCallStatus.optional(),
  title: external_exports2.string(),
  toolCallId: zToolCallId
});
var zToolCallUpdate = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  content: external_exports2.union([external_exports2.array(zToolCallContent), external_exports2.null()]).optional(),
  kind: external_exports2.union([zToolKind, external_exports2.null()]).optional(),
  locations: external_exports2.union([external_exports2.array(zToolCallLocation), external_exports2.null()]).optional(),
  rawInput: external_exports2.unknown().optional(),
  rawOutput: external_exports2.unknown().optional(),
  status: external_exports2.union([zToolCallStatus, external_exports2.null()]).optional(),
  title: external_exports2.union([external_exports2.string(), external_exports2.null()]).optional(),
  toolCallId: zToolCallId
});
var zRequestPermissionRequest = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  options: external_exports2.array(zPermissionOption),
  sessionId: zSessionId,
  toolCall: zToolCallUpdate
});
var zUnstructuredCommandInput = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  hint: external_exports2.string()
});
var zAvailableCommandInput = zUnstructuredCommandInput;
var zAvailableCommand = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  description: external_exports2.string(),
  input: external_exports2.union([zAvailableCommandInput, external_exports2.null()]).optional(),
  name: external_exports2.string()
});
var zAvailableCommandsUpdate = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  availableCommands: external_exports2.array(zAvailableCommand)
});
var zUsage = external_exports2.object({
  cachedReadTokens: external_exports2.union([external_exports2.number(), external_exports2.null()]).optional(),
  cachedWriteTokens: external_exports2.union([external_exports2.number(), external_exports2.null()]).optional(),
  inputTokens: external_exports2.number(),
  outputTokens: external_exports2.number(),
  thoughtTokens: external_exports2.union([external_exports2.number(), external_exports2.null()]).optional(),
  totalTokens: external_exports2.number()
});
var zPromptResponse = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  stopReason: zStopReason,
  usage: external_exports2.union([zUsage, external_exports2.null()]).optional()
});
var zAgentResponse = external_exports2.union([
  external_exports2.object({
    id: zRequestId,
    result: external_exports2.union([
      zInitializeResponse,
      zAuthenticateResponse,
      zNewSessionResponse,
      zLoadSessionResponse,
      zListSessionsResponse,
      zForkSessionResponse,
      zResumeSessionResponse,
      zSetSessionModeResponse,
      zSetSessionConfigOptionResponse,
      zPromptResponse,
      zSetSessionModelResponse,
      zExtResponse
    ])
  }),
  external_exports2.object({
    error: zError,
    id: zRequestId
  })
]);
var zUsageUpdate = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  cost: external_exports2.union([zCost, external_exports2.null()]).optional(),
  size: external_exports2.number(),
  used: external_exports2.number()
});
var zSessionUpdate = external_exports2.union([
  zContentChunk.and(external_exports2.object({
    sessionUpdate: external_exports2.literal("user_message_chunk")
  })),
  zContentChunk.and(external_exports2.object({
    sessionUpdate: external_exports2.literal("agent_message_chunk")
  })),
  zContentChunk.and(external_exports2.object({
    sessionUpdate: external_exports2.literal("agent_thought_chunk")
  })),
  zToolCall.and(external_exports2.object({
    sessionUpdate: external_exports2.literal("tool_call")
  })),
  zToolCallUpdate.and(external_exports2.object({
    sessionUpdate: external_exports2.literal("tool_call_update")
  })),
  zPlan.and(external_exports2.object({
    sessionUpdate: external_exports2.literal("plan")
  })),
  zAvailableCommandsUpdate.and(external_exports2.object({
    sessionUpdate: external_exports2.literal("available_commands_update")
  })),
  zCurrentModeUpdate.and(external_exports2.object({
    sessionUpdate: external_exports2.literal("current_mode_update")
  })),
  zConfigOptionUpdate.and(external_exports2.object({
    sessionUpdate: external_exports2.literal("config_option_update")
  })),
  zSessionInfoUpdate.and(external_exports2.object({
    sessionUpdate: external_exports2.literal("session_info_update")
  })),
  zUsageUpdate.and(external_exports2.object({
    sessionUpdate: external_exports2.literal("usage_update")
  }))
]);
var zSessionNotification = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  sessionId: zSessionId,
  update: zSessionUpdate
});
var zAgentNotification = external_exports2.object({
  method: external_exports2.string(),
  params: external_exports2.union([external_exports2.union([zSessionNotification, zExtNotification]), external_exports2.null()]).optional()
});
var zWaitForTerminalExitRequest = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  sessionId: zSessionId,
  terminalId: external_exports2.string()
});
var zWaitForTerminalExitResponse = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  exitCode: external_exports2.union([
    external_exports2.number().int().gte(0).max(4294967295, {
      message: "Invalid value: Expected uint32 to be <= 4294967295"
    }),
    external_exports2.null()
  ]).optional(),
  signal: external_exports2.union([external_exports2.string(), external_exports2.null()]).optional()
});
var zWriteTextFileRequest = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional(),
  content: external_exports2.string(),
  path: external_exports2.string(),
  sessionId: zSessionId
});
var zAgentRequest = external_exports2.object({
  id: zRequestId,
  method: external_exports2.string(),
  params: external_exports2.union([
    external_exports2.union([
      zWriteTextFileRequest,
      zReadTextFileRequest,
      zRequestPermissionRequest,
      zCreateTerminalRequest,
      zTerminalOutputRequest,
      zReleaseTerminalRequest,
      zWaitForTerminalExitRequest,
      zKillTerminalCommandRequest,
      zExtRequest
    ]),
    external_exports2.null()
  ]).optional()
});
var zWriteTextFileResponse = external_exports2.object({
  _meta: external_exports2.union([external_exports2.record(external_exports2.string(), external_exports2.unknown()), external_exports2.null()]).optional()
});
var zClientResponse = external_exports2.union([
  external_exports2.object({
    id: zRequestId,
    result: external_exports2.union([
      zWriteTextFileResponse,
      zReadTextFileResponse,
      zRequestPermissionResponse,
      zCreateTerminalResponse,
      zTerminalOutputResponse,
      zReleaseTerminalResponse,
      zWaitForTerminalExitResponse,
      zKillTerminalCommandResponse,
      zExtResponse
    ])
  }),
  external_exports2.object({
    error: zError,
    id: zRequestId
  })
]);

// node_modules/@agentclientprotocol/sdk/dist/stream.js
init_esbuild_shims();
function ndJsonStream(output, input) {
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  const readable = new ReadableStream({
    async start(controller) {
      let content = "";
      const reader = input.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          if (!value) {
            continue;
          }
          content += textDecoder.decode(value, { stream: true });
          const lines = content.split("\n");
          content = lines.pop() || "";
          for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine) {
              try {
                const message = JSON.parse(trimmedLine);
                controller.enqueue(message);
              } catch (err) {
                console.error("Failed to parse JSON message:", trimmedLine, err);
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
        controller.close();
      }
    }
  });
  const writable = new WritableStream({
    async write(message) {
      const content = JSON.stringify(message) + "\n";
      const writer = output.getWriter();
      try {
        await writer.write(textEncoder.encode(content));
      } finally {
        writer.releaseLock();
      }
    }
  });
  return { readable, writable };
}
__name(ndJsonStream, "ndJsonStream");

// node_modules/@agentclientprotocol/sdk/dist/acp.js
init_esbuild_shims();
var AgentSideConnection = class {
  static {
    __name(this, "AgentSideConnection");
  }
  #connection;
  /**
   * Creates a new agent-side connection to a client.
   *
   * This establishes the communication channel from the agent's perspective
   * following the ACP specification.
   *
   * @param toAgent - A function that creates an Agent handler to process incoming client requests
   * @param stream - The bidirectional message stream for communication. Typically created using
   *                 {@link ndJsonStream} for stdio-based connections.
   *
   * See protocol docs: [Communication Model](https://agentclientprotocol.com/protocol/overview#communication-model)
   */
  constructor(toAgent, stream) {
    const agent = toAgent(this);
    const requestHandler = /* @__PURE__ */ __name(async (method, params) => {
      switch (method) {
        case AGENT_METHODS.initialize: {
          const validatedParams = zInitializeRequest.parse(params);
          return agent.initialize(validatedParams);
        }
        case AGENT_METHODS.session_new: {
          const validatedParams = zNewSessionRequest.parse(params);
          return agent.newSession(validatedParams);
        }
        case AGENT_METHODS.session_load: {
          if (!agent.loadSession) {
            throw RequestError.methodNotFound(method);
          }
          const validatedParams = zLoadSessionRequest.parse(params);
          return agent.loadSession(validatedParams);
        }
        case AGENT_METHODS.session_list: {
          if (!agent.unstable_listSessions) {
            throw RequestError.methodNotFound(method);
          }
          const validatedParams = zListSessionsRequest.parse(params);
          return agent.unstable_listSessions(validatedParams);
        }
        case AGENT_METHODS.session_fork: {
          if (!agent.unstable_forkSession) {
            throw RequestError.methodNotFound(method);
          }
          const validatedParams = zForkSessionRequest.parse(params);
          return agent.unstable_forkSession(validatedParams);
        }
        case AGENT_METHODS.session_resume: {
          if (!agent.unstable_resumeSession) {
            throw RequestError.methodNotFound(method);
          }
          const validatedParams = zResumeSessionRequest.parse(params);
          return agent.unstable_resumeSession(validatedParams);
        }
        case AGENT_METHODS.session_set_mode: {
          if (!agent.setSessionMode) {
            throw RequestError.methodNotFound(method);
          }
          const validatedParams = zSetSessionModeRequest.parse(params);
          const result = await agent.setSessionMode(validatedParams);
          return result ?? {};
        }
        case AGENT_METHODS.authenticate: {
          const validatedParams = zAuthenticateRequest.parse(params);
          const result = await agent.authenticate(validatedParams);
          return result ?? {};
        }
        case AGENT_METHODS.session_prompt: {
          const validatedParams = zPromptRequest.parse(params);
          return agent.prompt(validatedParams);
        }
        case AGENT_METHODS.session_set_model: {
          if (!agent.unstable_setSessionModel) {
            throw RequestError.methodNotFound(method);
          }
          const validatedParams = zSetSessionModelRequest.parse(params);
          const result = await agent.unstable_setSessionModel(validatedParams);
          return result ?? {};
        }
        case AGENT_METHODS.session_set_config_option: {
          if (!agent.setSessionConfigOption) {
            throw RequestError.methodNotFound(method);
          }
          const validatedParams = zSetSessionConfigOptionRequest.parse(params);
          return agent.setSessionConfigOption(validatedParams);
        }
        default:
          if (agent.extMethod) {
            return agent.extMethod(method, params);
          }
          throw RequestError.methodNotFound(method);
      }
    }, "requestHandler");
    const notificationHandler = /* @__PURE__ */ __name(async (method, params) => {
      switch (method) {
        case AGENT_METHODS.session_cancel: {
          const validatedParams = zCancelNotification.parse(params);
          return agent.cancel(validatedParams);
        }
        default:
          if (agent.extNotification) {
            return agent.extNotification(method, params);
          }
          throw RequestError.methodNotFound(method);
      }
    }, "notificationHandler");
    this.#connection = new Connection(requestHandler, notificationHandler, stream);
  }
  /**
   * Handles session update notifications from the agent.
   *
   * This is a notification endpoint (no response expected) that sends
   * real-time updates about session progress, including message chunks,
   * tool calls, and execution plans.
   *
   * Note: Clients SHOULD continue accepting tool call updates even after
   * sending a `session/cancel` notification, as the agent may send final
   * updates before responding with the cancelled stop reason.
   *
   * See protocol docs: [Agent Reports Output](https://agentclientprotocol.com/protocol/prompt-turn#3-agent-reports-output)
   */
  async sessionUpdate(params) {
    return await this.#connection.sendNotification(CLIENT_METHODS.session_update, params);
  }
  /**
   * Requests permission from the user for a tool call operation.
   *
   * Called by the agent when it needs user authorization before executing
   * a potentially sensitive operation. The client should present the options
   * to the user and return their decision.
   *
   * If the client cancels the prompt turn via `session/cancel`, it MUST
   * respond to this request with `RequestPermissionOutcome::Cancelled`.
   *
   * See protocol docs: [Requesting Permission](https://agentclientprotocol.com/protocol/tool-calls#requesting-permission)
   */
  async requestPermission(params) {
    return await this.#connection.sendRequest(CLIENT_METHODS.session_request_permission, params);
  }
  /**
   * Reads content from a text file in the client's file system.
   *
   * Only available if the client advertises the `fs.readTextFile` capability.
   * Allows the agent to access file contents within the client's environment.
   *
   * See protocol docs: [Client](https://agentclientprotocol.com/protocol/overview#client)
   */
  async readTextFile(params) {
    return await this.#connection.sendRequest(CLIENT_METHODS.fs_read_text_file, params);
  }
  /**
   * Writes content to a text file in the client's file system.
   *
   * Only available if the client advertises the `fs.writeTextFile` capability.
   * Allows the agent to create or modify files within the client's environment.
   *
   * See protocol docs: [Client](https://agentclientprotocol.com/protocol/overview#client)
   */
  async writeTextFile(params) {
    return await this.#connection.sendRequest(CLIENT_METHODS.fs_write_text_file, params) ?? {};
  }
  /**
   * Executes a command in a new terminal.
   *
   * Returns a `TerminalHandle` that can be used to get output, wait for exit,
   * kill the command, or release the terminal.
   *
   * The terminal can also be embedded in tool calls by using its ID in
   * `ToolCallContent` with type "terminal".
   *
   * @param params - The terminal creation parameters
   * @returns A handle to control and monitor the terminal
   */
  async createTerminal(params) {
    const response = await this.#connection.sendRequest(CLIENT_METHODS.terminal_create, params);
    return new TerminalHandle(response.terminalId, params.sessionId, this.#connection);
  }
  /**
   * Extension method
   *
   * Allows the Agent to send an arbitrary request that is not part of the ACP spec.
   */
  async extMethod(method, params) {
    return await this.#connection.sendRequest(method, params);
  }
  /**
   * Extension notification
   *
   * Allows the Agent to send an arbitrary notification that is not part of the ACP spec.
   */
  async extNotification(method, params) {
    return await this.#connection.sendNotification(method, params);
  }
  /**
   * AbortSignal that aborts when the connection closes.
   *
   * This signal can be used to:
   * - Listen for connection closure: `connection.signal.addEventListener('abort', () => {...})`
   * - Check connection status synchronously: `if (connection.signal.aborted) {...}`
   * - Pass to other APIs (fetch, setTimeout) for automatic cancellation
   *
   * The connection closes when the underlying stream ends, either normally or due to an error.
   *
   * @example
   * ```typescript
   * const connection = new AgentSideConnection(agent, stream);
   *
   * // Listen for closure
   * connection.signal.addEventListener('abort', () => {
   *   console.log('Connection closed - performing cleanup');
   * });
   *
   * // Check status
   * if (connection.signal.aborted) {
   *   console.log('Connection is already closed');
   * }
   *
   * // Pass to other APIs
   * fetch(url, { signal: connection.signal });
   * ```
   */
  get signal() {
    return this.#connection.signal;
  }
  /**
   * Promise that resolves when the connection closes.
   *
   * The connection closes when the underlying stream ends, either normally or due to an error.
   * Once closed, the connection cannot send or receive any more messages.
   *
   * This is useful for async/await style cleanup:
   *
   * @example
   * ```typescript
   * const connection = new AgentSideConnection(agent, stream);
   * await connection.closed;
   * console.log('Connection closed - performing cleanup');
   * ```
   */
  get closed() {
    return this.#connection.closed;
  }
};
var TerminalHandle = class {
  static {
    __name(this, "TerminalHandle");
  }
  id;
  #sessionId;
  #connection;
  constructor(id, sessionId, conn) {
    this.id = id;
    this.#sessionId = sessionId;
    this.#connection = conn;
  }
  /**
   * Gets the current terminal output without waiting for the command to exit.
   */
  async currentOutput() {
    return await this.#connection.sendRequest(CLIENT_METHODS.terminal_output, {
      sessionId: this.#sessionId,
      terminalId: this.id
    });
  }
  /**
   * Waits for the terminal command to complete and returns its exit status.
   */
  async waitForExit() {
    return await this.#connection.sendRequest(CLIENT_METHODS.terminal_wait_for_exit, {
      sessionId: this.#sessionId,
      terminalId: this.id
    });
  }
  /**
   * Kills the terminal command without releasing the terminal.
   *
   * The terminal remains valid after killing, allowing you to:
   * - Get the final output with `currentOutput()`
   * - Check the exit status
   * - Release the terminal when done
   *
   * Useful for implementing timeouts or cancellation.
   */
  async kill() {
    return await this.#connection.sendRequest(CLIENT_METHODS.terminal_kill, {
      sessionId: this.#sessionId,
      terminalId: this.id
    }) ?? {};
  }
  /**
   * Releases the terminal and frees all associated resources.
   *
   * If the command is still running, it will be killed.
   * After release, the terminal ID becomes invalid and cannot be used
   * with other terminal methods.
   *
   * Tool calls that already reference this terminal will continue to
   * display its output.
   *
   * **Important:** Always call this method when done with the terminal.
   */
  async release() {
    return await this.#connection.sendRequest(CLIENT_METHODS.terminal_release, {
      sessionId: this.#sessionId,
      terminalId: this.id
    }) ?? {};
  }
  async [Symbol.asyncDispose]() {
    await this.release();
  }
};
var ClientSideConnection = class {
  static {
    __name(this, "ClientSideConnection");
  }
  #connection;
  /**
   * Creates a new client-side connection to an agent.
   *
   * This establishes the communication channel between a client and agent
   * following the ACP specification.
   *
   * @param toClient - A function that creates a Client handler to process incoming agent requests
   * @param stream - The bidirectional message stream for communication. Typically created using
   *                 {@link ndJsonStream} for stdio-based connections.
   *
   * See protocol docs: [Communication Model](https://agentclientprotocol.com/protocol/overview#communication-model)
   */
  constructor(toClient, stream) {
    const client = toClient(this);
    const requestHandler = /* @__PURE__ */ __name(async (method, params) => {
      switch (method) {
        case CLIENT_METHODS.fs_write_text_file: {
          const validatedParams = zWriteTextFileRequest.parse(params);
          return client.writeTextFile?.(validatedParams);
        }
        case CLIENT_METHODS.fs_read_text_file: {
          const validatedParams = zReadTextFileRequest.parse(params);
          return client.readTextFile?.(validatedParams);
        }
        case CLIENT_METHODS.session_request_permission: {
          const validatedParams = zRequestPermissionRequest.parse(params);
          return client.requestPermission(validatedParams);
        }
        case CLIENT_METHODS.terminal_create: {
          const validatedParams = zCreateTerminalRequest.parse(params);
          return client.createTerminal?.(validatedParams);
        }
        case CLIENT_METHODS.terminal_output: {
          const validatedParams = zTerminalOutputRequest.parse(params);
          return client.terminalOutput?.(validatedParams);
        }
        case CLIENT_METHODS.terminal_release: {
          const validatedParams = zReleaseTerminalRequest.parse(params);
          const result = await client.releaseTerminal?.(validatedParams);
          return result ?? {};
        }
        case CLIENT_METHODS.terminal_wait_for_exit: {
          const validatedParams = zWaitForTerminalExitRequest.parse(params);
          return client.waitForTerminalExit?.(validatedParams);
        }
        case CLIENT_METHODS.terminal_kill: {
          const validatedParams = zKillTerminalCommandRequest.parse(params);
          const result = await client.killTerminal?.(validatedParams);
          return result ?? {};
        }
        default:
          if (client.extMethod) {
            return client.extMethod(method, params);
          }
          throw RequestError.methodNotFound(method);
      }
    }, "requestHandler");
    const notificationHandler = /* @__PURE__ */ __name(async (method, params) => {
      switch (method) {
        case CLIENT_METHODS.session_update: {
          const validatedParams = zSessionNotification.parse(params);
          return client.sessionUpdate(validatedParams);
        }
        default:
          if (client.extNotification) {
            return client.extNotification(method, params);
          }
          throw RequestError.methodNotFound(method);
      }
    }, "notificationHandler");
    this.#connection = new Connection(requestHandler, notificationHandler, stream);
  }
  /**
   * Establishes the connection with a client and negotiates protocol capabilities.
   *
   * This method is called once at the beginning of the connection to:
   * - Negotiate the protocol version to use
   * - Exchange capability information between client and agent
   * - Determine available authentication methods
   *
   * The agent should respond with its supported protocol version and capabilities.
   *
   * See protocol docs: [Initialization](https://agentclientprotocol.com/protocol/initialization)
   */
  async initialize(params) {
    return await this.#connection.sendRequest(AGENT_METHODS.initialize, params);
  }
  /**
   * Creates a new conversation session with the agent.
   *
   * Sessions represent independent conversation contexts with their own history and state.
   *
   * The agent should:
   * - Create a new session context
   * - Connect to any specified MCP servers
   * - Return a unique session ID for future requests
   *
   * May return an `auth_required` error if the agent requires authentication.
   *
   * See protocol docs: [Session Setup](https://agentclientprotocol.com/protocol/session-setup)
   */
  async newSession(params) {
    return await this.#connection.sendRequest(AGENT_METHODS.session_new, params);
  }
  /**
   * Loads an existing session to resume a previous conversation.
   *
   * This method is only available if the agent advertises the `loadSession` capability.
   *
   * The agent should:
   * - Restore the session context and conversation history
   * - Connect to the specified MCP servers
   * - Stream the entire conversation history back to the client via notifications
   *
   * See protocol docs: [Loading Sessions](https://agentclientprotocol.com/protocol/session-setup#loading-sessions)
   */
  async loadSession(params) {
    return await this.#connection.sendRequest(AGENT_METHODS.session_load, params) ?? {};
  }
  /**
   * **UNSTABLE**
   *
   * This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Forks an existing session to create a new independent session.
   *
   * Creates a new session based on the context of an existing one, allowing
   * operations like generating summaries without affecting the original session's history.
   *
   * This method is only available if the agent advertises the `session.fork` capability.
   *
   * @experimental
   */
  async unstable_forkSession(params) {
    return await this.#connection.sendRequest(AGENT_METHODS.session_fork, params);
  }
  /**
   * **UNSTABLE**
   *
   * This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Lists existing sessions from the agent.
   *
   * This method is only available if the agent advertises the `listSessions` capability.
   *
   * Returns a list of sessions with metadata like session ID, working directory,
   * title, and last update time. Supports filtering by working directory and
   * cursor-based pagination.
   *
   * @experimental
   */
  async unstable_listSessions(params) {
    return await this.#connection.sendRequest(AGENT_METHODS.session_list, params);
  }
  /**
   * **UNSTABLE**
   *
   * This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Resumes an existing session without returning previous messages.
   *
   * This method is only available if the agent advertises the `session.resume` capability.
   *
   * The agent should resume the session context, allowing the conversation to continue
   * without replaying the message history (unlike `session/load`).
   *
   * @experimental
   */
  async unstable_resumeSession(params) {
    return await this.#connection.sendRequest(AGENT_METHODS.session_resume, params);
  }
  /**
   * Sets the operational mode for a session.
   *
   * Allows switching between different agent modes (e.g., "ask", "architect", "code")
   * that affect system prompts, tool availability, and permission behaviors.
   *
   * The mode must be one of the modes advertised in `availableModes` during session
   * creation or loading. Agents may also change modes autonomously and notify the
   * client via `current_mode_update` notifications.
   *
   * This method can be called at any time during a session, whether the Agent is
   * idle or actively generating a turn.
   *
   * See protocol docs: [Session Modes](https://agentclientprotocol.com/protocol/session-modes)
   */
  async setSessionMode(params) {
    return await this.#connection.sendRequest(AGENT_METHODS.session_set_mode, params) ?? {};
  }
  /**
   * **UNSTABLE**
   *
   * This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * Select a model for a given session.
   *
   * @experimental
   */
  async unstable_setSessionModel(params) {
    return await this.#connection.sendRequest(AGENT_METHODS.session_set_model, params) ?? {};
  }
  /**
   * Set a configuration option for a given session.
   *
   * The response contains the full set of configuration options and their current values,
   * as changing one option may affect the available values or state of other options.
   */
  async setSessionConfigOption(params) {
    return await this.#connection.sendRequest(AGENT_METHODS.session_set_config_option, params);
  }
  /**
   * Authenticates the client using the specified authentication method.
   *
   * Called when the agent requires authentication before allowing session creation.
   * The client provides the authentication method ID that was advertised during initialization.
   *
   * After successful authentication, the client can proceed to create sessions with
   * `newSession` without receiving an `auth_required` error.
   *
   * See protocol docs: [Initialization](https://agentclientprotocol.com/protocol/initialization)
   */
  async authenticate(params) {
    return await this.#connection.sendRequest(AGENT_METHODS.authenticate, params) ?? {};
  }
  /**
   * Processes a user prompt within a session.
   *
   * This method handles the whole lifecycle of a prompt:
   * - Receives user messages with optional context (files, images, etc.)
   * - Processes the prompt using language models
   * - Reports language model content and tool calls to the Clients
   * - Requests permission to run tools
   * - Executes any requested tool calls
   * - Returns when the turn is complete with a stop reason
   *
   * See protocol docs: [Prompt Turn](https://agentclientprotocol.com/protocol/prompt-turn)
   */
  async prompt(params) {
    return await this.#connection.sendRequest(AGENT_METHODS.session_prompt, params);
  }
  /**
   * Cancels ongoing operations for a session.
   *
   * This is a notification sent by the client to cancel an ongoing prompt turn.
   *
   * Upon receiving this notification, the Agent SHOULD:
   * - Stop all language model requests as soon as possible
   * - Abort all tool call invocations in progress
   * - Send any pending `session/update` notifications
   * - Respond to the original `session/prompt` request with `StopReason::Cancelled`
   *
   * See protocol docs: [Cancellation](https://agentclientprotocol.com/protocol/prompt-turn#cancellation)
   */
  async cancel(params) {
    return await this.#connection.sendNotification(AGENT_METHODS.session_cancel, params);
  }
  /**
   * Extension method
   *
   * Allows the Client to send an arbitrary request that is not part of the ACP spec.
   */
  async extMethod(method, params) {
    return await this.#connection.sendRequest(method, params);
  }
  /**
   * Extension notification
   *
   * Allows the Client to send an arbitrary notification that is not part of the ACP spec.
   */
  async extNotification(method, params) {
    return await this.#connection.sendNotification(method, params);
  }
  /**
   * AbortSignal that aborts when the connection closes.
   *
   * This signal can be used to:
   * - Listen for connection closure: `connection.signal.addEventListener('abort', () => {...})`
   * - Check connection status synchronously: `if (connection.signal.aborted) {...}`
   * - Pass to other APIs (fetch, setTimeout) for automatic cancellation
   *
   * The connection closes when the underlying stream ends, either normally or due to an error.
   *
   * @example
   * ```typescript
   * const connection = new ClientSideConnection(client, stream);
   *
   * // Listen for closure
   * connection.signal.addEventListener('abort', () => {
   *   console.log('Connection closed - performing cleanup');
   * });
   *
   * // Check status
   * if (connection.signal.aborted) {
   *   console.log('Connection is already closed');
   * }
   *
   * // Pass to other APIs
   * fetch(url, { signal: connection.signal });
   * ```
   */
  get signal() {
    return this.#connection.signal;
  }
  /**
   * Promise that resolves when the connection closes.
   *
   * The connection closes when the underlying stream ends, either normally or due to an error.
   * Once closed, the connection cannot send or receive any more messages.
   *
   * This is useful for async/await style cleanup:
   *
   * @example
   * ```typescript
   * const connection = new ClientSideConnection(client, stream);
   * await connection.closed;
   * console.log('Connection closed - performing cleanup');
   * ```
   */
  get closed() {
    return this.#connection.closed;
  }
};
var Connection = class {
  static {
    __name(this, "Connection");
  }
  #pendingResponses = /* @__PURE__ */ new Map();
  #nextRequestId = 0;
  #requestHandler;
  #notificationHandler;
  #stream;
  #writeQueue = Promise.resolve();
  #abortController = new AbortController();
  #closedPromise;
  constructor(requestHandler, notificationHandler, stream) {
    this.#requestHandler = requestHandler;
    this.#notificationHandler = notificationHandler;
    this.#stream = stream;
    this.#closedPromise = new Promise((resolve) => {
      this.#abortController.signal.addEventListener("abort", () => resolve());
    });
    this.#receive();
  }
  /**
   * AbortSignal that aborts when the connection closes.
   *
   * This signal can be used to:
   * - Listen for connection closure via event listeners
   * - Check connection status synchronously with `signal.aborted`
   * - Pass to other APIs (fetch, setTimeout) for automatic cancellation
   */
  get signal() {
    return this.#abortController.signal;
  }
  /**
   * Promise that resolves when the connection closes.
   *
   * The connection closes when the underlying stream ends, either normally
   * or due to an error. Once closed, the connection cannot send or receive
   * any more messages.
   *
   * @example
   * ```typescript
   * const connection = new ClientSideConnection(client, stream);
   * await connection.closed;
   * console.log('Connection closed - performing cleanup');
   * ```
   */
  get closed() {
    return this.#closedPromise;
  }
  async #receive() {
    const reader = this.#stream.readable.getReader();
    try {
      while (true) {
        const { value: message, done } = await reader.read();
        if (done) {
          break;
        }
        if (!message) {
          continue;
        }
        try {
          this.#processMessage(message);
        } catch (err) {
          console.error("Unexpected error during message processing:", message, err);
          if ("id" in message && message.id !== void 0) {
            this.#sendMessage({
              jsonrpc: "2.0",
              id: message.id,
              error: {
                code: -32700,
                message: "Parse error"
              }
            });
          }
        }
      }
    } finally {
      reader.releaseLock();
      this.#abortController.abort();
    }
  }
  async #processMessage(message) {
    if ("method" in message && "id" in message) {
      const response = await this.#tryCallRequestHandler(message.method, message.params);
      if ("error" in response) {
        console.error("Error handling request", message, response.error);
      }
      await this.#sendMessage({
        jsonrpc: "2.0",
        id: message.id,
        ...response
      });
    } else if ("method" in message) {
      const response = await this.#tryCallNotificationHandler(message.method, message.params);
      if ("error" in response) {
        console.error("Error handling notification", message, response.error);
      }
    } else if ("id" in message) {
      this.#handleResponse(message);
    } else {
      console.error("Invalid message", { message });
    }
  }
  async #tryCallRequestHandler(method, params) {
    try {
      const result = await this.#requestHandler(method, params);
      return { result: result ?? null };
    } catch (error) {
      if (error instanceof RequestError) {
        return error.toResult();
      }
      if (error instanceof external_exports.ZodError) {
        return RequestError.invalidParams(error.format()).toResult();
      }
      let details;
      if (error instanceof Error) {
        details = error.message;
      } else if (typeof error === "object" && error != null && "message" in error && typeof error.message === "string") {
        details = error.message;
      }
      try {
        return RequestError.internalError(details ? JSON.parse(details) : {}).toResult();
      } catch {
        return RequestError.internalError({ details }).toResult();
      }
    }
  }
  async #tryCallNotificationHandler(method, params) {
    try {
      await this.#notificationHandler(method, params);
      return { result: null };
    } catch (error) {
      if (error instanceof RequestError) {
        return error.toResult();
      }
      if (error instanceof external_exports.ZodError) {
        return RequestError.invalidParams(error.format()).toResult();
      }
      let details;
      if (error instanceof Error) {
        details = error.message;
      } else if (typeof error === "object" && error != null && "message" in error && typeof error.message === "string") {
        details = error.message;
      }
      try {
        return RequestError.internalError(details ? JSON.parse(details) : {}).toResult();
      } catch {
        return RequestError.internalError({ details }).toResult();
      }
    }
  }
  #handleResponse(response) {
    const pendingResponse = this.#pendingResponses.get(response.id);
    if (pendingResponse) {
      if ("result" in response) {
        pendingResponse.resolve(response.result);
      } else if ("error" in response) {
        pendingResponse.reject(response.error);
      }
      this.#pendingResponses.delete(response.id);
    } else {
      console.error("Got response to unknown request", response.id);
    }
  }
  async sendRequest(method, params) {
    const id = this.#nextRequestId++;
    const responsePromise = new Promise((resolve, reject) => {
      this.#pendingResponses.set(id, { resolve, reject });
    });
    await this.#sendMessage({ jsonrpc: "2.0", id, method, params });
    return responsePromise;
  }
  async sendNotification(method, params) {
    await this.#sendMessage({ jsonrpc: "2.0", method, params });
  }
  async #sendMessage(message) {
    this.#writeQueue = this.#writeQueue.then(async () => {
      const writer = this.#stream.writable.getWriter();
      try {
        await writer.write(message);
      } finally {
        writer.releaseLock();
      }
    }).catch((error) => {
      console.error("ACP write error:", error);
    });
    return this.#writeQueue;
  }
};
var RequestError = class _RequestError extends Error {
  static {
    __name(this, "RequestError");
  }
  code;
  data;
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.name = "RequestError";
    this.data = data;
  }
  /**
   * Invalid JSON was received by the server. An error occurred on the server while parsing the JSON text.
   */
  static parseError(data, additionalMessage) {
    return new _RequestError(-32700, `Parse error${additionalMessage ? `: ${additionalMessage}` : ""}`, data);
  }
  /**
   * The JSON sent is not a valid Request object.
   */
  static invalidRequest(data, additionalMessage) {
    return new _RequestError(-32600, `Invalid request${additionalMessage ? `: ${additionalMessage}` : ""}`, data);
  }
  /**
   * The method does not exist / is not available.
   */
  static methodNotFound(method) {
    return new _RequestError(-32601, `"Method not found": ${method}`, {
      method
    });
  }
  /**
   * Invalid method parameter(s).
   */
  static invalidParams(data, additionalMessage) {
    return new _RequestError(-32602, `Invalid params${additionalMessage ? `: ${additionalMessage}` : ""}`, data);
  }
  /**
   * Internal JSON-RPC error.
   */
  static internalError(data, additionalMessage) {
    return new _RequestError(-32603, `Internal error${additionalMessage ? `: ${additionalMessage}` : ""}`, data);
  }
  /**
   * Authentication required.
   */
  static authRequired(data, additionalMessage) {
    return new _RequestError(-32e3, `Authentication required${additionalMessage ? `: ${additionalMessage}` : ""}`, data);
  }
  /**
   * Resource, such as a file, was not found
   */
  static resourceNotFound(uri) {
    return new _RequestError(-32002, `Resource not found${uri ? `: ${uri}` : ""}`, uri && { uri });
  }
  toResult() {
    return {
      error: {
        code: this.code,
        message: this.message,
        data: this.data
      }
    };
  }
  toErrorResponse() {
    return {
      code: this.code,
      message: this.message,
      data: this.data
    };
  }
};

export {
  CLIENT_METHODS,
  PROTOCOL_VERSION,
  zCreateTerminalRequest,
  zKillTerminalCommandRequest,
  zReadTextFileRequest,
  zReleaseTerminalRequest,
  zTerminalOutputRequest,
  zRequestPermissionRequest,
  zSessionNotification,
  zWaitForTerminalExitRequest,
  zWriteTextFileRequest,
  ndJsonStream,
  AgentSideConnection,
  ClientSideConnection,
  RequestError
};
