// Force strict mode and setup for ESM
"use strict";
import {
  loadSettings
} from "./chunk-DRYBBTI5.js";
import {
  getCurrentLanguage
} from "./chunk-POMFSBEC.js";
import {
  isWorkspaceTrusted
} from "./chunk-36RKQ7ZS.js";
import {
  require_strip_json_comments
} from "./chunk-NPQ5ZKRP.js";
import {
  hashMcpServerConfig
} from "./chunk-47GVX3K4.js";
import {
  Config,
  ExtensionManager,
  FileDiscoveryService,
  MCPOAuthTokenStorage,
  createMcpClient,
  createTransport,
  isGatedMcpScope,
  normalizeClaudeMcpServer,
  runWithTimeout
} from "./chunk-MRTRBONQ.js";
import {
  getMCPServerLastError,
  getMCPServerStatus
} from "./chunk-KKGSJZWK.js";
import {
  atomicWriteFile
} from "./chunk-CA63HYHU.js";
import {
  Storage
} from "./chunk-ZYDMQCQP.js";
import {
  getErrorMessage
} from "./chunk-S34QJ6IR.js";
import {
  writeStderrLine,
  writeStdoutLine
} from "./chunk-7FA2II6K.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/commands/mcp.ts
init_esbuild_shims();

// packages/cli/src/commands/mcp/add.ts
init_esbuild_shims();
async function addMcpServer(name, commandOrUrl, args, options) {
  const {
    scope,
    transport,
    env,
    header,
    timeout,
    trust,
    description,
    includeTools,
    excludeTools,
    oauthClientId,
    oauthClientSecret,
    oauthRedirectUri,
    oauthAuthorizationUrl,
    oauthTokenUrl,
    oauthScopes
  } = options;
  const settings = loadSettings(process.cwd());
  const inHome = settings.workspace.path === settings.user.path;
  if (scope === "project" && inHome) {
    writeStderrLine(
      "Error: Please use --scope user to edit settings in the home directory."
    );
    process.exit(1);
  }
  const settingsScope = scope === "user" ? "User" /* User */ : "Workspace" /* Workspace */;
  let newServer = {};
  const scopes = oauthScopes?.flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
  const hasOAuth = Boolean(
    oauthClientId || oauthClientSecret || oauthRedirectUri || oauthAuthorizationUrl || oauthTokenUrl || scopes && scopes.length > 0
  );
  if (hasOAuth && transport === "stdio") {
    writeStderrLine(
      "Error: OAuth options (--oauth-*) are only supported with --transport sse or --transport http."
    );
    process.exit(1);
  }
  const oauthConfig = hasOAuth ? {
    enabled: true,
    ...oauthClientId && { clientId: oauthClientId },
    ...oauthClientSecret && { clientSecret: oauthClientSecret },
    ...oauthRedirectUri && { redirectUri: oauthRedirectUri },
    ...oauthAuthorizationUrl && {
      authorizationUrl: oauthAuthorizationUrl
    },
    ...oauthTokenUrl && { tokenUrl: oauthTokenUrl },
    ...scopes && scopes.length > 0 && { scopes }
  } : void 0;
  const headers = header?.reduce(
    (acc, curr) => {
      const [key, ...valueParts] = curr.split(":");
      const value = valueParts.join(":").trim();
      if (key.trim() && value) {
        acc[key.trim()] = value;
      }
      return acc;
    },
    {}
  );
  switch (transport) {
    case "sse":
      newServer = {
        url: commandOrUrl,
        headers,
        timeout,
        trust,
        description,
        includeTools,
        excludeTools,
        oauth: oauthConfig
      };
      break;
    case "http":
      newServer = {
        httpUrl: commandOrUrl,
        headers,
        timeout,
        trust,
        description,
        includeTools,
        excludeTools,
        oauth: oauthConfig
      };
      break;
    case "stdio":
    default:
      newServer = {
        command: commandOrUrl,
        args: args?.map(String),
        env: env?.reduce(
          (acc, curr) => {
            const separator = curr.indexOf("=");
            if (separator === -1) {
              return acc;
            }
            const key = curr.slice(0, separator);
            const value = curr.slice(separator + 1);
            if (key && value) {
              acc[key] = value;
            }
            return acc;
          },
          {}
        ),
        timeout,
        trust,
        description,
        includeTools,
        excludeTools
      };
      break;
  }
  const existingSettings = settings.forScope(settingsScope).settings;
  const mcpServers = existingSettings.mcpServers || {};
  const isExistingServer = !!mcpServers[name];
  if (isExistingServer) {
    writeStdoutLine(
      `MCP server "${name}" is already configured within ${scope} settings.`
    );
  }
  mcpServers[name] = newServer;
  settings.setValue(settingsScope, "mcpServers", mcpServers);
  if (isExistingServer) {
    writeStdoutLine(`MCP server "${name}" updated in ${scope} settings.`);
  } else {
    writeStdoutLine(
      `MCP server "${name}" added to ${scope} settings. (${transport})`
    );
  }
}
__name(addMcpServer, "addMcpServer");
var addCommand = {
  command: "add <name> <commandOrUrl> [args...]",
  describe: "Add a server",
  builder: /* @__PURE__ */ __name((yargs) => yargs.usage("Usage: qwen mcp add [options] <name> <commandOrUrl> [args...]").parserConfiguration({
    "unknown-options-as-args": true,
    // Pass unknown options as server args
    "populate--": true
    // Populate server args after -- separator
  }).positional("name", {
    describe: "Name of the server",
    type: "string",
    demandOption: true
  }).positional("commandOrUrl", {
    describe: "Command (stdio) or URL (sse, http)",
    type: "string",
    demandOption: true
  }).option("scope", {
    alias: "s",
    describe: "Configuration scope (user or project)",
    type: "string",
    default: "user",
    choices: ["user", "project"]
  }).option("transport", {
    alias: "t",
    describe: "Transport type (stdio, sse, http). Auto-detected from URL if not specified.",
    type: "string",
    choices: ["stdio", "sse", "http"]
  }).option("env", {
    alias: "e",
    describe: "Set environment variables (e.g. -e KEY=value)",
    type: "array",
    string: true,
    nargs: 1
  }).option("header", {
    alias: "H",
    describe: 'Set HTTP headers for SSE and HTTP transports (e.g. -H "X-Api-Key: abc123" -H "Authorization: Bearer abc123")',
    type: "array",
    string: true,
    nargs: 1
  }).option("timeout", {
    describe: "Set connection timeout in milliseconds",
    type: "number"
  }).option("trust", {
    describe: "Trust the server (bypass its tool call confirmations in a trusted workspace)",
    type: "boolean"
  }).option("description", {
    describe: "Set the description for the server",
    type: "string"
  }).option("include-tools", {
    describe: "A comma-separated list of tools to include",
    type: "array",
    string: true
  }).option("exclude-tools", {
    describe: "A comma-separated list of tools to exclude",
    type: "array",
    string: true
  }).option("oauth-client-id", {
    describe: "OAuth client ID for MCP server authentication",
    type: "string"
  }).option("oauth-client-secret", {
    describe: "OAuth client secret for MCP server authentication",
    type: "string"
  }).option("oauth-redirect-uri", {
    describe: "OAuth redirect URI (e.g., https://your-server.com/oauth/callback). Defaults to localhost for local setups.",
    type: "string"
  }).option("oauth-authorization-url", {
    describe: "OAuth authorization URL",
    type: "string"
  }).option("oauth-token-url", {
    describe: "OAuth token URL",
    type: "string"
  }).option("oauth-scopes", {
    describe: "OAuth scopes (comma-separated)",
    type: "array",
    string: true
  }).middleware((argv) => {
    if (argv["--"]) {
      const existingArgs = argv["args"] || [];
      argv["args"] = [...existingArgs, ...argv["--"]];
    }
    if (!argv["transport"]) {
      const commandOrUrl = argv["commandOrUrl"];
      if (commandOrUrl && /^https?:\/\//i.test(commandOrUrl)) {
        argv["transport"] = "http";
      } else {
        argv["transport"] = "stdio";
      }
    }
  }), "builder"),
  handler: /* @__PURE__ */ __name(async (argv) => {
    await addMcpServer(
      argv["name"],
      argv["commandOrUrl"],
      argv["args"],
      {
        scope: argv["scope"],
        transport: argv["transport"],
        env: argv["env"],
        header: argv["header"],
        timeout: argv["timeout"],
        trust: argv["trust"],
        description: argv["description"],
        includeTools: argv["includeTools"],
        excludeTools: argv["excludeTools"],
        oauthClientId: argv["oauthClientId"],
        oauthClientSecret: argv["oauthClientSecret"],
        oauthRedirectUri: argv["oauthRedirectUri"],
        oauthAuthorizationUrl: argv["oauthAuthorizationUrl"],
        oauthTokenUrl: argv["oauthTokenUrl"],
        oauthScopes: argv["oauthScopes"]
      }
    );
  }, "handler")
};

// packages/cli/src/commands/mcp/remove.ts
init_esbuild_shims();
async function removeMcpServer(name, options) {
  const { scope } = options;
  const settingsScope = scope === "user" ? "User" /* User */ : "Workspace" /* Workspace */;
  const settings = loadSettings();
  const existingSettings = settings.forScope(settingsScope).settings;
  const mcpServers = existingSettings.mcpServers || {};
  if (!mcpServers[name]) {
    writeStdoutLine(`Server "${name}" not found in ${scope} settings.`);
    return;
  }
  delete mcpServers[name];
  settings.setValue(settingsScope, "mcpServers", mcpServers);
  try {
    const tokenStorage = new MCPOAuthTokenStorage();
    await tokenStorage.deleteCredentials(name);
  } catch {
  }
  writeStdoutLine(`Server "${name}" removed from ${scope} settings.`);
}
__name(removeMcpServer, "removeMcpServer");
var removeCommand = {
  command: "remove <name>",
  describe: "Remove a server",
  builder: /* @__PURE__ */ __name((yargs) => yargs.usage("Usage: qwen mcp remove [options] <name>").positional("name", {
    describe: "Name of the server",
    type: "string",
    demandOption: true
  }).option("scope", {
    alias: "s",
    describe: "Configuration scope (user or project)",
    type: "string",
    default: "user",
    choices: ["user", "project"]
  }), "builder"),
  handler: /* @__PURE__ */ __name(async (argv) => {
    await removeMcpServer(argv["name"], {
      scope: argv["scope"]
    });
  }, "handler")
};

// packages/cli/src/commands/mcp/list.ts
init_esbuild_shims();

// packages/cli/src/config/mcpServers.ts
init_esbuild_shims();

// packages/cli/src/config/mcpJson.ts
init_esbuild_shims();
import * as fs from "node:fs";
import * as path from "node:path";
var import_strip_json_comments = __toESM(require_strip_json_comments(), 1);
var PROJECT_MCP_FILENAME = ".mcp.json";
function loadProjectMcpServers(projectRoot) {
  const filePath = path.join(projectRoot, PROJECT_MCP_FILENAME);
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return { servers: {}, path: void 0, errors: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse((0, import_strip_json_comments.default)(raw));
  } catch (e) {
    return {
      servers: {},
      path: filePath,
      errors: [`Failed to parse ${filePath}: ${e.message}`]
    };
  }
  const mcpServers = parsed?.mcpServers;
  if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
    return {
      servers: {},
      path: filePath,
      errors: [`${filePath} has no "mcpServers" object`]
    };
  }
  const servers = /* @__PURE__ */ Object.create(null);
  const errors = [];
  for (const [name, value] of Object.entries(
    mcpServers
  )) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${filePath}: server "${name}" is not an object \u2014 skipped`);
      continue;
    }
    servers[name] = {
      ...normalizeClaudeMcpServer(value),
      scope: "project"
    };
  }
  return { servers, path: filePath, errors };
}
__name(loadProjectMcpServers, "loadProjectMcpServers");

// packages/cli/src/config/mcpServers.ts
function assembleMcpServers(mergedSettingsServers, cwd, cliMcpServers) {
  const belowProject = {};
  const aboveProject = {};
  for (const [name, config] of Object.entries(mergedSettingsServers ?? {})) {
    if (config.scope === "workspace" || config.scope === "system") {
      aboveProject[name] = config;
    } else {
      belowProject[name] = config;
    }
  }
  const projectResult = loadProjectMcpServers(cwd);
  for (const error of projectResult.errors) {
    writeStderrLine(`Warning: ${error}`);
  }
  return {
    ...belowProject,
    ...projectResult.servers,
    ...aboveProject,
    ...cliMcpServers ?? {}
  };
}
__name(assembleMcpServers, "assembleMcpServers");

// packages/cli/src/config/mcpApprovals.ts
init_esbuild_shims();
import * as fs2 from "node:fs";
import * as os from "node:os";
import * as path2 from "node:path";
var import_strip_json_comments2 = __toESM(require_strip_json_comments(), 1);
var MCP_APPROVALS_FILENAME = "mcpApprovals.json";
function getMcpApprovalsPath() {
  if (process.env["QWEN_CODE_MCP_APPROVALS_PATH"]) {
    return process.env["QWEN_CODE_MCP_APPROVALS_PATH"];
  }
  return path2.join(Storage.getGlobalQwenDir(), MCP_APPROVALS_FILENAME);
}
__name(getMcpApprovalsPath, "getMcpApprovalsPath");
function normalizeProjectRoot(projectRoot) {
  const resolved = path2.resolve(projectRoot);
  return os.platform() === "win32" ? resolved.toLowerCase() : resolved;
}
__name(normalizeProjectRoot, "normalizeProjectRoot");
function isApprovalRecordMap(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isApprovalRecordMap, "isApprovalRecordMap");
function isWin32AbsolutePath(p) {
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p);
}
__name(isWin32AbsolutePath, "isWin32AbsolutePath");
function mergeApprovalRecords(existing, incoming) {
  const merged = Object.assign(
    /* @__PURE__ */ Object.create(null),
    existing
  );
  for (const [name, record] of Object.entries(incoming)) {
    if (!isApprovalRecordMap(record)) {
      continue;
    }
    const current = merged[name];
    if (!current) {
      merged[name] = record;
    } else if (current.status !== record.status) {
      merged[name] = current.status === "rejected" ? current : record;
    }
  }
  return merged;
}
__name(mergeApprovalRecords, "mergeApprovalRecords");
function normalizeStoredProjectKeys(config) {
  if (os.platform() !== "win32") {
    return config;
  }
  const normalized = /* @__PURE__ */ Object.create(null);
  for (const [key, value] of Object.entries(config)) {
    const projectKey = isWin32AbsolutePath(key) ? key.toLowerCase() : key;
    const existing = normalized[projectKey];
    normalized[projectKey] = isApprovalRecordMap(existing) && isApprovalRecordMap(value) ? mergeApprovalRecords(existing, value) : isApprovalRecordMap(value) || !isApprovalRecordMap(existing) ? value : existing;
  }
  return normalized;
}
__name(normalizeStoredProjectKeys, "normalizeStoredProjectKeys");
var LoadedMcpApprovals = class {
  constructor(file, errors) {
    this.file = file;
    this.errors = errors;
  }
  static {
    __name(this, "LoadedMcpApprovals");
  }
  /**
   * Live approval state for a project server. Returns `pending` when there is no
   * stored decision OR when the stored decision was bound to a different config
   * hash (i.e. `.mcp.json` changed since approval). This is the hash-binding
   * that makes a config edit require re-approval.
   */
  getState(projectRoot, serverName, config) {
    const record = this.file.config[normalizeProjectRoot(projectRoot)]?.[serverName];
    if (!record) {
      return "pending";
    }
    if (record.hash !== hashMcpServerConfig(config)) {
      return "pending";
    }
    return record.status;
  }
  /** Persist an approve/reject decision bound to the current config hash. */
  async setState(projectRoot, serverName, config, status) {
    const root = normalizeProjectRoot(projectRoot);
    const existing = this.file.config[root];
    const project = isApprovalRecordMap(
      existing
    ) ? existing : /* @__PURE__ */ Object.create(null);
    Object.defineProperty(project, serverName, {
      value: { hash: hashMcpServerConfig(config), status },
      enumerable: true,
      configurable: true,
      writable: true
    });
    this.file.config[root] = project;
    await saveMcpApprovals(this.file);
  }
};
var loadedMcpApprovals;
function loadMcpApprovals() {
  if (loadedMcpApprovals) {
    return loadedMcpApprovals;
  }
  const errors = [];
  let config = {};
  const filePath = getMcpApprovalsPath();
  try {
    if (fs2.existsSync(filePath)) {
      const content = fs2.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse((0, import_strip_json_comments2.default)(content));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        errors.push({
          message: "MCP approvals file is not a valid JSON object.",
          path: filePath
        });
      } else {
        config = normalizeStoredProjectKeys(parsed);
      }
    }
  } catch (error) {
    errors.push({ message: getErrorMessage(error), path: filePath });
  }
  loadedMcpApprovals = new LoadedMcpApprovals(
    { path: filePath, config },
    errors
  );
  for (const error of errors) {
    writeStderrLine(`Warning: MCP approvals file error: ${error.message}`);
  }
  return loadedMcpApprovals;
}
__name(loadMcpApprovals, "loadMcpApprovals");
function getPendingGatedMcpServers(mcpServers, projectRoot) {
  const approvals = loadMcpApprovals();
  const pending = [];
  for (const [name, config] of Object.entries(mcpServers)) {
    if (!isGatedMcpScope(config.scope)) {
      continue;
    }
    if (approvals.getState(projectRoot, name, config) !== "approved") {
      pending.push(name);
    }
  }
  return pending;
}
__name(getPendingGatedMcpServers, "getPendingGatedMcpServers");
function getPromptableMcpServers(mcpServers, projectRoot) {
  const approvals = loadMcpApprovals();
  const promptable = [];
  for (const [name, config] of Object.entries(mcpServers)) {
    if (!isGatedMcpScope(config.scope)) {
      continue;
    }
    if (approvals.getState(projectRoot, name, config) === "pending") {
      promptable.push(name);
    }
  }
  return promptable;
}
__name(getPromptableMcpServers, "getPromptableMcpServers");
async function saveMcpApprovals(file) {
  try {
    const dirPath = path2.dirname(file.path);
    if (!fs2.existsSync(dirPath)) {
      fs2.mkdirSync(dirPath, { recursive: true });
    }
    await atomicWriteFile(file.path, JSON.stringify(file.config, null, 2), {
      mode: 384
    });
  } catch (error) {
    writeStderrLine("Error saving MCP approvals file.");
    writeStderrLine(error instanceof Error ? error.message : String(error));
  }
}
__name(saveMcpApprovals, "saveMcpApprovals");

// packages/cli/src/commands/mcp/list.ts
var COLOR_GREEN = "\x1B[32m";
var COLOR_YELLOW = "\x1B[33m";
var COLOR_RED = "\x1B[31m";
var RESET_COLOR = "\x1B[0m";
var MCP_CONNECT_TIMEOUT_MS = 1e4;
async function getMcpServersFromConfig() {
  const settings = loadSettings();
  const extensionManager = new ExtensionManager({
    isWorkspaceTrusted: isWorkspaceTrusted(settings.merged).isTrusted ?? true,
    telemetrySettings: settings.merged.telemetry,
    locale: getCurrentLanguage()
  });
  await extensionManager.refreshCache();
  const extensions = extensionManager.getLoadedExtensions();
  const mcpServers = assembleMcpServers(
    settings.merged.mcpServers,
    process.cwd()
  );
  for (const extension of extensions) {
    if (extension.isActive) {
      Object.entries(extension.config.mcpServers || {}).forEach(
        ([key, server]) => {
          if (mcpServers[key]) {
            return;
          }
          mcpServers[key] = {
            ...server,
            extensionName: extension.config.name
          };
        }
      );
    }
  }
  return mcpServers;
}
__name(getMcpServersFromConfig, "getMcpServersFromConfig");
async function testMCPConnection(serverName, config) {
  const client = createMcpClient("mcp-test-client", config);
  let transport;
  try {
    transport = await createTransport(serverName, config, false);
  } catch (_error) {
    await client.close();
    return { status: "disconnected" /* DISCONNECTED */, timedOut: false };
  }
  try {
    await runWithTimeout(
      client.connect(transport, { timeout: MCP_CONNECT_TIMEOUT_MS }),
      MCP_CONNECT_TIMEOUT_MS,
      `MCP connection for ${serverName}`
    );
    await client.close();
    return { status: "connected" /* CONNECTED */, timedOut: false };
  } catch (error) {
    await transport.close();
    return {
      status: "disconnected" /* DISCONNECTED */,
      timedOut: error instanceof Error && error.message.startsWith("Timed out after ")
    };
  }
}
__name(testMCPConnection, "testMCPConnection");
async function getServerStatus(serverName, server) {
  return await testMCPConnection(serverName, server);
}
__name(getServerStatus, "getServerStatus");
async function listMcpServers() {
  const mcpServers = await getMcpServersFromConfig();
  const serverNames = Object.keys(mcpServers);
  if (serverNames.length === 0) {
    writeStdoutLine("No MCP servers configured.");
    return;
  }
  writeStdoutLine("Configured MCP servers:\n");
  const cwd = process.cwd();
  let approvals;
  for (const serverName of serverNames) {
    const server = mcpServers[serverName];
    let serverInfo = `${serverName}: `;
    if (server.httpUrl) {
      serverInfo += `${server.httpUrl} (http)`;
    } else if (server.url) {
      serverInfo += `${server.url} (sse)`;
    } else if (server.command) {
      serverInfo += `${server.command} ${server.args?.join(" ") || ""} (stdio)`;
    }
    if (isGatedMcpScope(server.scope)) {
      approvals ??= loadMcpApprovals();
      const state = approvals.getState(cwd, serverName, server);
      if (state !== "approved") {
        const statusText2 = state === "rejected" ? "Rejected" : "Pending approval";
        writeStdoutLine(
          `${COLOR_YELLOW}\u25CF${RESET_COLOR} ${serverInfo} - ${statusText2}`
        );
        continue;
      }
    }
    const { status, timedOut } = await getServerStatus(serverName, server);
    let statusIndicator = "";
    let statusText = "";
    switch (status) {
      case "connected" /* CONNECTED */:
        statusIndicator = COLOR_GREEN + "\u2713" + RESET_COLOR;
        statusText = "Connected";
        break;
      case "connecting" /* CONNECTING */:
        statusIndicator = COLOR_YELLOW + "\u2026" + RESET_COLOR;
        statusText = "Connecting";
        break;
      case "disconnected" /* DISCONNECTED */:
      default:
        statusIndicator = COLOR_RED + "\u2717" + RESET_COLOR;
        statusText = timedOut ? `Disconnected (timed out after ${MCP_CONNECT_TIMEOUT_MS}ms)` : "Disconnected";
        break;
    }
    writeStdoutLine(`${statusIndicator} ${serverInfo} - ${statusText}`);
  }
}
__name(listMcpServers, "listMcpServers");
var listCommand = {
  command: "list",
  describe: "List all configured MCP servers",
  handler: /* @__PURE__ */ __name(async () => {
    await listMcpServers();
  }, "handler")
};

// packages/cli/src/commands/mcp/reconnect.ts
init_esbuild_shims();
async function getMcpServersFromConfig2(extensionManager) {
  const settings = loadSettings();
  const extManager = extensionManager ?? new ExtensionManager({
    isWorkspaceTrusted: isWorkspaceTrusted(settings.merged).isTrusted ?? true,
    telemetrySettings: settings.merged.telemetry,
    locale: getCurrentLanguage()
  });
  if (!extensionManager) {
    await extManager.refreshCache();
  }
  const extensions = extManager.getLoadedExtensions();
  const mcpServers = assembleMcpServers(
    settings.merged.mcpServers,
    process.cwd()
  );
  for (const extension of extensions) {
    if (extension.isActive) {
      Object.entries(extension.config.mcpServers || {}).forEach(
        ([key, server]) => {
          if (mcpServers[key]) {
            return;
          }
          mcpServers[key] = {
            ...server,
            extensionName: extension.config.name
          };
        }
      );
    }
  }
  return mcpServers;
}
__name(getMcpServersFromConfig2, "getMcpServersFromConfig");
async function createMinimalConfig() {
  const settings = loadSettings();
  const cwd = process.cwd();
  const fileFiltering = settings.merged.context?.fileFiltering;
  const fileService = new FileDiscoveryService(
    cwd,
    fileFiltering?.customIgnoreFiles
  );
  const mcpServers = await getMcpServersFromConfig2();
  const allowedMcpServers = settings.merged.mcp?.allowed ? new Set(settings.merged.mcp.allowed.filter(Boolean)) : void 0;
  const excludedMcpServers = settings.merged.mcp?.excluded ? new Set(settings.merged.mcp.excluded.filter(Boolean)) : void 0;
  const config = new Config({
    sessionId: "mcp-reconnect",
    targetDir: cwd,
    cwd,
    debugMode: false,
    chatRecording: false,
    mcpServers,
    pendingMcpServers: getPendingGatedMcpServers(mcpServers, cwd),
    fileDiscoveryService: fileService,
    mcpServerCommand: settings.merged.mcp?.serverCommand,
    allowedMcpServers: allowedMcpServers ? Array.from(allowedMcpServers) : void 0,
    excludedMcpServers: excludedMcpServers ? Array.from(excludedMcpServers) : void 0,
    // Mirror a real session's trust gate: discovery skips MCP servers in an
    // untrusted workspace, so the throwaway Config must carry the same trust
    // state. Without it `isTrustedFolder()` defaults to true here, the
    // untrusted-skip reporting below becomes unreachable, and this command
    // would attempt connections a normal session would not (issue #9944).
    trustedFolder: isWorkspaceTrusted(settings.merged).isTrusted ?? true,
    ...fileFiltering !== void 0 ? { fileFiltering } : {}
  });
  await config.initialize({ skipMcpDiscovery: true });
  return config;
}
__name(createMinimalConfig, "createMinimalConfig");
var SkippedConnectionError = class extends Error {
  static {
    __name(this, "SkippedConnectionError");
  }
  skipReason;
  constructor(skipReason) {
    super(`no connection attempt was made: ${skipReason}`);
    this.name = "SkippedConnectionError";
    this.skipReason = skipReason;
  }
};
var SESSION_SCOPE_NOTE = "Note: this command reconnects in a separate process; it cannot refresh the MCP tools of an already-running Qwen Code session. Restart that session if its tools remain unavailable.";
function createReconnectError(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  return error;
}
__name(createReconnectError, "createReconnectError");
function describeSkippedConnectionReason(config, serverName) {
  const unavailableReason = config.getMcpServerUnavailableReason(serverName);
  if (unavailableReason === "excluded") {
    return "server is excluded in settings (mcp.excluded)";
  }
  if (unavailableReason === "not_allowed") {
    return "server is not in the mcp.allowed list";
  }
  if (config.isMcpServerDisabled(serverName)) {
    return "server is disabled in settings";
  }
  if (config.isMcpServerPendingApproval(serverName)) {
    return "server is pending approval (.mcp.json)";
  }
  if (config.isTrustedFolder() === false) {
    return "workspace folder is not trusted";
  }
  return void 0;
}
__name(describeSkippedConnectionReason, "describeSkippedConnectionReason");
async function discoverAndVerifyConnection(config, serverName) {
  const toolRegistry = config.getToolRegistry();
  await toolRegistry.discoverToolsForServer(serverName);
  const status = getMCPServerStatus(serverName);
  if (status !== "connected" /* CONNECTED */) {
    const skippedReason = describeSkippedConnectionReason(config, serverName);
    if (skippedReason) {
      throw new SkippedConnectionError(skippedReason);
    }
    const lastError = getMCPServerLastError(serverName);
    throw new Error(
      `connection attempt finished without a live connection (status: ${status})` + (lastError ? `: ${lastError}` : "")
    );
  }
}
__name(discoverAndVerifyConnection, "discoverAndVerifyConnection");
async function reconnectMcpServer(serverName) {
  const mcpServers = await getMcpServersFromConfig2();
  if (!mcpServers[serverName]) {
    throw createReconnectError(
      `Error: Server "${serverName}" not found in configuration.`
    );
  }
  writeStdoutLine(`Reconnecting to server "${serverName}"...`);
  let config;
  try {
    config = await createMinimalConfig();
    await discoverAndVerifyConnection(config, serverName);
    writeStdoutLine(`Successfully reconnected to server "${serverName}".`);
    writeStdoutLine(SESSION_SCOPE_NOTE);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStdoutLine(SESSION_SCOPE_NOTE);
    throw createReconnectError(
      `Failed to reconnect to server "${serverName}": ${message}`
    );
  } finally {
    if (config) {
      await config.shutdown();
    }
  }
}
__name(reconnectMcpServer, "reconnectMcpServer");
async function reconnectAllMcpServers() {
  const settings = loadSettings();
  const extensionManager = new ExtensionManager({
    isWorkspaceTrusted: isWorkspaceTrusted(settings.merged).isTrusted ?? true,
    telemetrySettings: settings.merged.telemetry,
    locale: getCurrentLanguage()
  });
  await extensionManager.refreshCache();
  const mcpServers = await getMcpServersFromConfig2(extensionManager);
  const serverNames = Object.keys(mcpServers);
  if (serverNames.length === 0) {
    writeStdoutLine("No MCP servers configured.");
    return;
  }
  writeStdoutLine("Reconnecting to all MCP servers...\n");
  let config;
  let failedCount = 0;
  try {
    config = await createMinimalConfig();
    for (const serverName of serverNames) {
      try {
        await discoverAndVerifyConnection(config, serverName);
        writeStdoutLine(`\u2713 ${serverName}: Reconnected successfully`);
      } catch (error) {
        if (error instanceof SkippedConnectionError) {
          writeStdoutLine(`- ${serverName}: Skipped - ${error.skipReason}`);
          continue;
        }
        failedCount++;
        const message = error instanceof Error ? error.message : String(error);
        writeStdoutLine(`\u2717 ${serverName}: Failed - ${message}`);
      }
    }
    writeStdoutLine("");
    writeStdoutLine(SESSION_SCOPE_NOTE);
  } finally {
    if (config) {
      await config.shutdown();
    }
  }
  if (failedCount > 0) {
    throw createReconnectError(
      `Failed to reconnect ${failedCount} of ${serverNames.length} configured server(s).`
    );
  }
}
__name(reconnectAllMcpServers, "reconnectAllMcpServers");
var reconnectCommand = {
  command: "reconnect [server-name]",
  describe: "Reconnect MCP server(s)",
  builder: /* @__PURE__ */ __name((yargs) => yargs.usage("Usage: qwen mcp reconnect [options] [server-name]").positional("server-name", {
    describe: "Name of the server to reconnect",
    type: "string"
  }).option("all", {
    alias: "a",
    describe: "Reconnect all configured servers",
    type: "boolean",
    default: false
  }).conflicts("server-name", "all").check((argv) => {
    const serverName = argv["server-name"];
    const all = argv["all"];
    if (!serverName && !all) {
      throw new Error(
        "Please specify a server name or use --all to reconnect all servers."
      );
    }
    return true;
  }), "builder"),
  handler: /* @__PURE__ */ __name(async (argv) => {
    const serverName = argv["server-name"];
    const all = argv["all"];
    try {
      if (all) {
        await reconnectAllMcpServers();
      } else if (serverName) {
        await reconnectMcpServer(serverName);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const exitCode = error?.exitCode ?? 1;
      writeStderrLine(message);
      process.exit(exitCode);
    }
  }, "handler")
};

// packages/cli/src/commands/mcp/approve.ts
init_esbuild_shims();
function loadGatedServers(cwd) {
  const settings = loadSettings(cwd);
  const all = assembleMcpServers(settings.merged.mcpServers, cwd);
  const gated = {};
  for (const [serverName, config] of Object.entries(all)) {
    if (isGatedMcpScope(config.scope)) {
      gated[serverName] = config;
    }
  }
  return gated;
}
__name(loadGatedServers, "loadGatedServers");
async function setProjectServerStatus(name, status, all) {
  const cwd = process.cwd();
  const servers = loadGatedServers(cwd);
  const names = Object.keys(servers);
  if (names.length === 0) {
    writeStdoutLine(
      "No approval-requiring MCP servers found (looked in .mcp.json and .qwen/settings.json)."
    );
    return;
  }
  const verb = status === "approved" ? "Approved" : "Rejected";
  const approvals = loadMcpApprovals();
  const targets = all ? names : name ? [name] : [];
  if (targets.length === 0) {
    writeStdoutLine("Specify a server name or pass --all.");
    return;
  }
  for (const target of targets) {
    const config = servers[target];
    if (!config) {
      writeStdoutLine(
        `Server "${target}" not found. Available: ${names.join(", ")}`
      );
      continue;
    }
    await approvals.setState(cwd, target, config, status);
    writeStdoutLine(
      `${verb} MCP server "${target}" (bound to its current config).`
    );
  }
  if (status === "approved") {
    writeStdoutLine(
      "Approved servers connect in your next interactive session."
    );
  }
}
__name(setProjectServerStatus, "setProjectServerStatus");
var approveCommand = {
  command: "approve [name]",
  describe: "Approve a gated MCP server (.mcp.json or workspace .qwen/settings.json)",
  builder: /* @__PURE__ */ __name((yargs) => yargs.usage("Usage: qwen mcp approve [options] [name]").positional("name", {
    describe: "Name of the gated server to approve",
    type: "string"
  }).option("all", {
    describe: "Approve all gated servers in this workspace",
    type: "boolean",
    default: false
  }), "builder"),
  handler: /* @__PURE__ */ __name(async (argv) => {
    await setProjectServerStatus(
      argv["name"],
      "approved",
      argv["all"]
    );
  }, "handler")
};
var rejectCommand = {
  command: "reject [name]",
  describe: "Reject a gated MCP server (.mcp.json or workspace .qwen/settings.json)",
  builder: /* @__PURE__ */ __name((yargs) => yargs.usage("Usage: qwen mcp reject [options] [name]").positional("name", {
    describe: "Name of the gated server to reject",
    type: "string"
  }).option("all", {
    describe: "Reject all gated servers in this workspace",
    type: "boolean",
    default: false
  }), "builder"),
  handler: /* @__PURE__ */ __name(async (argv) => {
    await setProjectServerStatus(
      argv["name"],
      "rejected",
      argv["all"]
    );
  }, "handler")
};

// packages/cli/src/commands/mcp.ts
var mcpCommand = {
  command: "mcp",
  describe: "Manage MCP servers",
  builder: /* @__PURE__ */ __name((yargs) => yargs.command(addCommand).command(removeCommand).command(listCommand).command(reconnectCommand).command(approveCommand).command(rejectCommand).demandCommand(1, "You need at least one command before continuing.").version(false), "builder"),
  handler: /* @__PURE__ */ __name(() => {
  }, "handler")
};

export {
  assembleMcpServers,
  loadMcpApprovals,
  getPendingGatedMcpServers,
  getPromptableMcpServers,
  mcpCommand
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
