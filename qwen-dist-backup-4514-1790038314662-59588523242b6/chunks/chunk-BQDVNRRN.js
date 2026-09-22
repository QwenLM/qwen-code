// Force strict mode and setup for ESM
"use strict";
import {
  ExtensionRefreshState,
  clearSkillArgs,
  resolveHookSettingsForConfig,
  skillArgsNote,
  skillArgsPath,
  staleArgsWarning,
  validateAuthMethod,
  writeSkillArgs
} from "./chunk-PL2V2PQ2.js";
import {
  calculateCost,
  commandRestrictionNames,
  computeSessionStats,
  diffCommand,
  extensionOwnerLabel,
  filterCommandsForMode,
  findInlineMathExpressions,
  formatCompressionTokenCount,
  getCompressionFailureStatusText,
  getSystemInfoFields,
  skillOriginLabel
} from "./chunk-2XC3CR4F.js";
import {
  formatDuration,
  formatTokenCount
} from "./chunk-WEUQIY3Q.js";
import {
  isKittyProtocolEnabled
} from "./chunk-NYX53SV4.js";
import {
  VSCODE_SHIFT_ENTER_SEQUENCE,
  isWaylandSession,
  writeOsc52
} from "./chunk-X3T5IOX6.js";
import {
  contextCommand
} from "./chunk-EOSYAJBL.js";
import {
  rollbackStandaloneUpdate
} from "./chunk-2O4XE2EO.js";
import {
  themeManager
} from "./chunk-S7BE3FMA.js";
import {
  getErrorMessage as getErrorMessage2
} from "./chunk-6OHXRCXH.js";
import {
  GITHUB_WORKFLOW_PATHS,
  INSIGHT_CSS,
  INSIGHT_JS,
  collectSessionData,
  generateExportFilename,
  normalizeSessionData,
  setupGithub,
  toHtml,
  toJson,
  toJsonl,
  toMarkdown
} from "./chunk-TPIZYLF2.js";
import {
  stripUnsafeCharacters,
  toCodePoints,
  truncateToWidth
} from "./chunk-47ECGEJC.js";
import {
  isValidSessionId
} from "./chunk-ZEZKIS2K.js";
import {
  formatUnsupportedVoiceModelMessage,
  getVoiceSettingsScope,
  isSelectableVoiceModel,
  isVoiceEnabled,
  readVoiceMode,
  readVoiceModel
} from "./chunk-JYTJ5FCM.js";
import {
  getExtendedSystemInfo,
  getGitVersion,
  getNpmVersion
} from "./chunk-4JVOFH22.js";
import {
  getReasoningEffortsForConfig
} from "./chunk-BKF7NYFD.js";
import {
  isInlineModelOverrideAllowed,
  parseAcpModelOption
} from "./chunk-Y3Q5OK4D.js";
import {
  getInstallationInfo
} from "./chunk-4JFRCIMW.js";
import {
  OUTPUT_LANGUAGE_AUTO,
  getAllSettingKeys,
  getDefaultValue,
  getFlattenedSchema,
  getNestedProperty,
  getPersistScopeForModelSelection,
  getSettingDefinition,
  isAutoLanguage,
  nextBooleanSettingValue,
  resolveOutputLanguageOrPreserveAuto,
  validateSettingValue,
  writeOutputLanguageAndRegisterPath
} from "./chunk-DRYBBTI5.js";
import {
  getCurrentLanguage,
  setLanguageAsync,
  t
} from "./chunk-POMFSBEC.js";
import {
  SUPPORTED_LANGUAGES,
  getSupportedLanguageIds,
  resolveSupportedLanguage
} from "./chunk-5EJZE3FP.js";
import {
  isFolderTrustEnabled,
  loadTrustedFolders
} from "./chunk-36RKQ7ZS.js";
import {
  require_strip_json_comments
} from "./chunk-NPQ5ZKRP.js";
import {
  BTW_MAX_INPUT_LENGTH,
  Logger,
  analyzeToolResultRetention,
  buildBareRememberPrompt,
  buildBtwCacheSafeParams,
  buildBtwPrompt,
  buildLearnSkillPrompt,
  buildLearnVideoSkillRequest,
  buildManagedRememberPrompt,
  describePeerInboxFailure,
  encodeInsightErrorMessage,
  encodeInsightProgressMessage,
  encodeInsightReadyMessage,
  findOutputStyle,
  generateSessionRecap,
  getIdeInstaller,
  getLastPeerInboxFailure,
  getMCPServerPrompts,
  isWsl,
  listPeerControllers,
  loadOutputStyleCatalog,
  parseLearnVideoInput,
  readPathFromWorkspace,
  removePeerController
} from "./chunk-47GVX3K4.js";
import {
  canonicalizeMsgId,
  describeHoldCause
} from "./chunk-O4A2B6V2.js";
import {
  listWorkflowSnapshots
} from "./chunk-CAAUC2LP.js";
import {
  resolveOpenAILogDir
} from "./chunk-PU756QJZ.js";
import {
  ArenaManager,
  ConditionalRulesRegistry,
  EXTENSIONS_CONFIG_FILENAME,
  ExtensionManager,
  GoalPersistenceUnavailableError,
  IdeClient,
  QWEN_CODE_COMPANION_EXTENSION_NAME,
  SESSION_TITLE_MAX_LENGTH,
  SessionService,
  ShellExecutionService,
  appendToLastTextPart,
  buildBackgroundEntryLabel,
  collectMemoryDiagnostics,
  flatMapTextParts,
  getExtensionDescription,
  getExtensionDisplayName,
  hookEventSupportsMatcher,
  ideContextStore,
  isActiveWorkflowStatus,
  isCompressionFailureStatus,
  isExtensionCommittedWithWarningsError,
  isSignalTermination,
  isSuccessStatus,
  isTerminalStatus,
  isTerminalWorkflowStatus,
  listSavedWorkflows,
  loadServerHierarchicalMemory,
  normalizeClaudeMcpServer,
  normalizeSkillPriority,
  parseInstallSource,
  parseVisionModelSetting,
  partToString,
  persistSessionUsage,
  require_toml,
  runForkedAgent,
  tryGenerateSessionTitle
} from "./chunk-MRTRBONQ.js";
import {
  external_exports
} from "./chunk-CQ35AJ4Z.js";
import {
  projectUserTranscriptForDisplay
} from "./chunk-ANKISCKU.js";
import {
  resolveModelId
} from "./chunk-OB57Y2WH.js";
import {
  GOAL_PAUSE_REASON_COMMAND,
  emptyGoalSnapshot,
  getAutoSkillCuratorStatus,
  parse,
  recordAutoSkillUsage,
  restoreArchivedAutoSkill,
  runAutoSkillCurator,
  setAutoSkillPinned
} from "./chunk-IMV5DBIP.js";
import {
  canUseRipgrep
} from "./chunk-IWMYX5LB.js";
import {
  glob
} from "./chunk-QJNDUTOL.js";
import {
  checkArgumentSafety,
  checkCommandPermissions,
  escapeShellArg,
  getShellConfiguration
} from "./chunk-QPTE6BKL.js";
import {
  escapeJsonTagCharacters,
  formatMemoryUsage
} from "./chunk-CHEIIBT3.js";
import {
  flattenPeerLabel
} from "./chunk-GHG4PQY2.js";
import {
  APPROVAL_MODES
} from "./chunk-JX6XHPTX.js";
import {
  isMediaPolicyToolHiddenFromModel
} from "./chunk-MNU36NGH.js";
import {
  BUILT_IN_OUTPUT_STYLES,
  getArenaSystemReminder,
  getInsightPrompt,
  getPlanModeSystemReminder,
  getProjectSummaryPrompt,
  isSystemMdActive,
  resolveMainSessionOutputStyle
} from "./chunk-B3HGO6BB.js";
import {
  FORK_SUBAGENT_TYPE,
  stripStartupContext
} from "./chunk-2A6RZKP2.js";
import {
  applySkillSideEffects,
  buildSkillLlmContent
} from "./chunk-WDVSRQIQ.js";
import {
  HookEventName,
  sanitizeUserPromptExpansionAdditionalContext
} from "./chunk-GXNXX7A2.js";
import {
  resolveSlimmingConfig
} from "./chunk-NUQ4GK5I.js";
import {
  buildRuntimeSnapshotId,
  findProviderByCredentials,
  isImageGenerationCapable,
  stripRuntimeSnapshotPrefix
} from "./chunk-TLS6QN2S.js";
import {
  openBrowserSecurely
} from "./chunk-NAVJD2PQ.js";
import {
  COMBINED_PASS_TOLERANCE_FACTOR,
  IdeConnectionEvent,
  formatTokenUsageSummaryAsCsv,
  formatTokenUsageSummaryAsJson,
  getMCPServerStatus,
  isImageCapable,
  logIdeConnection,
  queryTokenUsage,
  read,
  recordSkillInvocation,
  uiTelemetryService
} from "./chunk-KKGSJZWK.js";
import {
  getAutoMemoryRoot
} from "./chunk-RVT5L74D.js";
import {
  getCurrentMemoryFilename
} from "./chunk-25FMWESU.js";
import {
  runSideQuery
} from "./chunk-43QUA4MC.js";
import {
  REASONING_EFFORT_TIERS,
  applyReasoningEffort,
  normalizeReasoningEffort
} from "./chunk-KUON6Z6R.js";
import {
  AuthType
} from "./chunk-SBP43AO6.js";
import {
  normalizeContent,
  redactUrlCredentials
} from "./chunk-B3XJFEEH.js";
import {
  isShellProgressData
} from "./chunk-VPGRGNNH.js";
import {
  ToolDisplayNamesMigration,
  ToolNames,
  canonicalToolName
} from "./chunk-ERIBG3BX.js";
import {
  Storage,
  createDebugLogger,
  expandHomeDir,
  isSubpath,
  resolvePath,
  updateSymlink
} from "./chunk-ZYDMQCQP.js";
import {
  getErrorMessage
} from "./chunk-S34QJ6IR.js";
import {
  isCpuProfileRecording,
  startCpuProfile,
  stopCpuProfile
} from "./chunk-SGORY5YI.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/peerMessaging/enabled.ts
init_esbuild_shims();
import { isDeepStrictEqual } from "node:util";
function isCrossSessionMessagingEnabled(settings) {
  const value = settings?.agents?.crossSessionMessaging;
  return value === void 0 || value === true;
}
__name(isCrossSessionMessagingEnabled, "isCrossSessionMessagingEnabled");
function switchIn(file) {
  return file?.settings.agents?.crossSessionMessaging;
}
__name(switchIn, "switchIn");
function workspaceCounts(settings) {
  return settings.isTrusted === true && settings.workspaceSettingsActive === true;
}
__name(workspaceCounts, "workspaceCounts");
function isCrossSessionMessagingOptedIn(settings) {
  if (switchIn(settings.user) === true) return true;
  return workspaceCounts(settings) && switchIn(settings.workspace) === true;
}
__name(isCrossSessionMessagingOptedIn, "isCrossSessionMessagingOptedIn");
function crossSessionMessagingOffScope(settings) {
  if (isCrossSessionMessagingEnabled(settings.merged)) return void 0;
  const merged = settings.merged.agents?.crossSessionMessaging;
  if (switchIn(settings.system) !== void 0) return "system";
  if (isDeepStrictEqual(switchIn(settings.user), merged)) return "user";
  if (isDeepStrictEqual(switchIn(settings.systemDefaults), merged)) {
    return "system-defaults";
  }
  if (workspaceCounts(settings) && isDeepStrictEqual(switchIn(settings.workspace), merged)) {
    return "workspace";
  }
  return void 0;
}
__name(crossSessionMessagingOffScope, "crossSessionMessagingOffScope");

// packages/cli/src/ui/utils/commandUtils.ts
init_esbuild_shims();
import { spawn } from "node:child_process";

// packages/cli/src/ui/commands/commands.ts
init_esbuild_shims();
var MAX_STACKED_SKILLS = 5;
var isStackedSkillCompletableCommand = /* @__PURE__ */ __name((command) => command.kind === "skill" /* SKILL */ && command.userInvocable !== false && !command.hidden, "isStackedSkillCompletableCommand");
var isValidStackedSkillPrefix = /* @__PURE__ */ __name((prefix, commands) => {
  const trimmed = prefix.trim();
  if (!trimmed) return false;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length >= MAX_STACKED_SKILLS) return false;
  return tokens.every((token) => {
    if (!token.startsWith("/")) return false;
    const command = findCommandByName(token.slice(1), commands);
    return command !== void 0 && isStackedSkillCompletableCommand(command);
  });
}, "isValidStackedSkillPrefix");
var parseSlashCommand = /* @__PURE__ */ __name((query, commands) => {
  const trimmed = query.trim();
  const commandText = trimmed.substring(1).trim();
  const parts = commandText.split(/\s+/);
  const commandPath = parts.filter((p) => p);
  let currentCommands = commands;
  let commandToExecute;
  let pathIndex = 0;
  const canonicalPath = [];
  let argsStart = 0;
  for (const part of commandPath) {
    let foundCommand = currentCommands.find((cmd) => cmd.name === part);
    if (!foundCommand) {
      foundCommand = currentCommands.find(
        (cmd) => cmd.altNames?.includes(part)
      );
    }
    if (foundCommand) {
      commandToExecute = foundCommand;
      canonicalPath.push(foundCommand.name);
      pathIndex++;
      const partIndex = commandText.indexOf(part, argsStart);
      argsStart = partIndex + part.length;
      if (foundCommand.subCommands) {
        currentCommands = foundCommand.subCommands;
      } else {
        break;
      }
    } else {
      break;
    }
  }
  const args = commandToExecute ? commandText.slice(argsStart).trim() : parts.slice(pathIndex).join(" ");
  return { commandToExecute, args, canonicalPath };
}, "parseSlashCommand");
var parseStackedSlashCommands = /* @__PURE__ */ __name((query, commands) => {
  const trimmed = query.trim();
  if (!trimmed.startsWith("/")) {
    return { skills: [], remainingText: trimmed, exceededMax: false };
  }
  const commandText = trimmed.substring(1);
  const skills = [];
  let pos = 0;
  let restPos = 0;
  let exceededMax = false;
  while (pos < commandText.length) {
    while (pos < commandText.length && /\s/.test(commandText[pos])) pos++;
    if (pos >= commandText.length) {
      restPos = pos;
      break;
    }
    const tokenStart = pos;
    while (pos < commandText.length && !/\s/.test(commandText[pos])) pos++;
    const token = commandText.slice(tokenStart, pos);
    if (skills.length === 0) {
      if (token.startsWith("/")) break;
      const cmd2 = findCommandByName(token, commands);
      if (!cmd2 || cmd2.kind !== "skill" /* SKILL */) break;
      skills.push(cmd2);
      restPos = pos;
      continue;
    }
    if (!token.startsWith("/")) break;
    const name = token.substring(1);
    if (!name) break;
    const cmd = findCommandByName(name, commands);
    if (!cmd || cmd.kind !== "skill" /* SKILL */) break;
    if (skills.length >= MAX_STACKED_SKILLS) {
      exceededMax = true;
      break;
    }
    skills.push(cmd);
    restPos = pos;
  }
  if (skills.length < 2) {
    return { skills: [], remainingText: trimmed, exceededMax: false };
  }
  const afterSkills = commandText.slice(restPos).trim();
  return { skills, remainingText: afterSkills, exceededMax };
}, "parseStackedSlashCommands");
function findCommandByName(name, commands) {
  return commands.find((cmd) => cmd.name === name) ?? commands.find((cmd) => cmd.altNames?.includes(name));
}
__name(findCommandByName, "findCommandByName");

// packages/cli/src/ui/utils/commandUtils.ts
var CONTEXT_FILES_ANNOUNCEMENT_PREFIX = "Read context files:";
function isContextFilesAnnouncement(item) {
  return item.type === "info" /* INFO */ && typeof item.text === "string" && item.text.startsWith(CONTEXT_FILES_ANNOUNCEMENT_PREFIX);
}
__name(isContextFilesAnnouncement, "isContextFilesAnnouncement");
var CodePage = {
  UTF8: 65001,
  GBK: 936,
  BIG5: 950,
  LATIN1: 1252
};
var isAtCommand = /* @__PURE__ */ __name((query) => (
  // Check if starts with @ OR has a space, then @
  query.startsWith("@") || /\s@/.test(query)
), "isAtCommand");
var SLASH_PATH_SEPARATOR_RE = /[/\\]/;
var SLASH_COMMANDS_SKIP_RECORDING = /* @__PURE__ */ new Set([
  "quit",
  "exit",
  "clear",
  "reset",
  "new",
  "resume",
  "delete",
  "branch",
  "btw",
  "history"
]);
var getSlashCommandFirstToken = /* @__PURE__ */ __name((query) => query.slice(1).trimStart().split(/\s+/u)[0] ?? "", "getSlashCommandFirstToken");
var hasSlashCommandPathSeparator = /* @__PURE__ */ __name((query) => SLASH_PATH_SEPARATOR_RE.test(getSlashCommandFirstToken(query)), "hasSlashCommandPathSeparator");
var isSlashCommand = /* @__PURE__ */ __name((query) => {
  if (!query.startsWith("/")) {
    return false;
  }
  if (query.startsWith("//")) {
    return false;
  }
  if (query.startsWith("/*")) {
    return false;
  }
  if (hasSlashCommandPathSeparator(query)) {
    return false;
  }
  return true;
}, "isSlashCommand");
var BTW_COMMAND_RE = /^[/?]btw(?:\s|$)/;
var isBtwCommand = /* @__PURE__ */ __name((query) => {
  const trimmed = query.trim();
  return trimmed.length > 0 && BTW_COMMAND_RE.test(trimmed);
}, "isBtwCommand");
function consumesContextAnnouncementLatch(trimmedPrompt, options) {
  if (trimmedPrompt.length === 0) {
    return false;
  }
  if (/^\/btw(?:\s|$)/.test(trimmedPrompt)) {
    return false;
  }
  if (isSlashCommand(trimmedPrompt)) {
    return parseSlashCommand(trimmedPrompt, options.slashCommands).commandToExecute?.modelInvocable === true;
  }
  if (options.shellModeActive) {
    return false;
  }
  return true;
}
__name(consumesContextAnnouncementLatch, "consumesContextAnnouncementLatch");
var debugLogger = createDebugLogger("COMMAND_UTILS");
var formatCommandFailure = /* @__PURE__ */ __name((error, command) => error instanceof Error && error.code === "ENOENT" ? `${command} not found` : error instanceof Error ? error.message : String(error), "formatCommandFailure");
var copyToClipboard = /* @__PURE__ */ __name(async (text) => {
  let wlCopyError;
  const run = /* @__PURE__ */ __name((cmd, args, options) => new Promise((resolve4, reject) => {
    const child = options ? spawn(cmd, args, options) : spawn(cmd, args);
    let stderr = "";
    if (child.stderr) {
      child.stderr.on("data", (chunk) => stderr += chunk.toString());
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve4();
      const errorMsg = stderr.trim();
      reject(
        new Error(
          `'${cmd}' exited with code ${code}${errorMsg ? `: ${errorMsg}` : ""}`
        )
      );
    });
    if (child.stdin) {
      child.stdin.on("error", reject);
      child.stdin.write(text);
      child.stdin.end();
    } else {
      reject(new Error("Child process has no stdin stream to write to."));
    }
  }), "run");
  const linuxOptions = { stdio: ["pipe", "inherit", "pipe"] };
  switch (process.platform) {
    case "win32":
      return run("cmd", ["/c", `chcp ${CodePage.UTF8} >nul && clip`]);
    case "darwin":
      return run("pbcopy", []);
    case "linux":
      if (isWaylandSession()) {
        try {
          await run("wl-copy", ["-t", "text/plain"], {
            stdio: ["pipe", "inherit", "ignore"]
          });
          return;
        } catch (error) {
          wlCopyError = error;
          debugLogger.debug(
            "wl-copy failed; falling back to other clipboard methods:",
            error
          );
        }
      }
      try {
        await run("xclip", ["-selection", "clipboard"], linuxOptions);
      } catch (primaryError) {
        try {
          await run("xsel", ["--clipboard", "--input"], linuxOptions);
        } catch (fallbackError) {
          const xclipNotFound = primaryError instanceof Error && primaryError.code === "ENOENT";
          const xselNotFound = fallbackError instanceof Error && fallbackError.code === "ENOENT";
          const wlCopyFailure = wlCopyError === void 0 ? "" : `wl-copy failed ("${formatCommandFailure(wlCopyError, "wl-copy")}"); `;
          if (xclipNotFound && xselNotFound) {
            if (!writeOsc52(text)) {
              throw new Error(
                `Clipboard unavailable: ${wlCopyFailure}xclip/xsel not found and OSC 52 requires a TTY. Try running inside a terminal emulator.`
              );
            }
            return;
          }
          const primaryMsg = formatCommandFailure(primaryError, "xclip");
          const fallbackMsg = formatCommandFailure(fallbackError, "xsel");
          if (writeOsc52(text)) return;
          throw new Error(
            `Clipboard unavailable: ${wlCopyFailure}xclip/xsel failed ("${primaryMsg}", "${fallbackMsg}") and OSC 52 requires a TTY. Try running inside a terminal emulator.`
          );
        }
      }
      return;
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}, "copyToClipboard");
var getUrlOpenCommand = /* @__PURE__ */ __name(() => {
  let openCmd;
  switch (process.platform) {
    case "darwin":
      openCmd = "open";
      break;
    case "win32":
      openCmd = "start";
      break;
    case "linux":
      openCmd = "xdg-open";
      break;
    default:
      openCmd = "xdg-open";
      debugLogger.warn(
        `Unknown platform: ${process.platform}. Attempting to open URLs with: ${openCmd}.`
      );
      break;
  }
  return openCmd;
}, "getUrlOpenCommand");
function isMidInputCompletableCommand(cmd) {
  return cmd.modelInvocable === true && !cmd.hidden;
}
__name(isMidInputCompletableCommand, "isMidInputCompletableCommand");
function findMidInputSlashCommand(input, cursorOffset) {
  const codePoints = toCodePoints(input);
  const beforeCursor = codePoints.slice(0, cursorOffset).join("");
  const match = beforeCursor.match(/\s\/([a-zA-Z0-9_:-]*)$/);
  if (!match) return null;
  const partialCommand = match[1];
  const slashPos = cursorOffset - 1 - partialCommand.length;
  const textAfterSlash = codePoints.slice(slashPos + 1).join("");
  const commandMatch = textAfterSlash.match(/^[a-zA-Z0-9_:-]*/);
  const fullCommand = commandMatch ? commandMatch[0] : "";
  if (cursorOffset !== slashPos + 1 + fullCommand.length) return null;
  return {
    token: "/" + fullCommand,
    startPos: slashPos,
    partialCommand
  };
}
__name(findMidInputSlashCommand, "findMidInputSlashCommand");
function getBestSlashCommandMatch(partialCommand, commands, recentCommands) {
  if (!partialCommand) return null;
  const query = partialCommand.toLowerCase();
  const matches = commands.filter((cmd) => {
    if (!isMidInputCompletableCommand(cmd)) return false;
    const name = cmd.name.toLowerCase();
    return name.startsWith(query) && (name !== query || !!cmd.argumentHint);
  }).sort((left, right) => {
    const leftRecent = recentCommands?.get(left.name);
    const rightRecent = recentCommands?.get(right.name);
    const recentOrder = (rightRecent?.usedAt ?? 0) - (leftRecent?.usedAt ?? 0);
    return (right.completionPriority ?? 0) - (left.completionPriority ?? 0) || recentOrder || left.name.localeCompare(right.name);
  });
  const best = matches[0];
  if (!best) return null;
  return {
    suffix: best.name.slice(partialCommand.length),
    fullCommand: best.name,
    command: best,
    argumentHint: best.argumentHint
  };
}
__name(getBestSlashCommandMatch, "getBestSlashCommandMatch");
var SLASH_TOKEN_RE = /(?:^|(?<=\s))\/([a-zA-Z][a-zA-Z0-9:_-]*)/g;
function findSlashCommandTokens(text, commands) {
  if (!text) return [];
  const commandMapEntries = [];
  for (const cmd of commands) {
    commandMapEntries.push([cmd.name.toLowerCase(), cmd]);
    for (const altName of cmd.altNames ?? []) {
      commandMapEntries.push([altName.toLowerCase(), cmd]);
    }
  }
  const commandMap = new Map(commandMapEntries);
  const tokens = [];
  let match;
  SLASH_TOKEN_RE.lastIndex = 0;
  while ((match = SLASH_TOKEN_RE.exec(text)) !== null) {
    const fullMatch = match[0];
    const commandName = match[1];
    const start = match.index;
    const end = start + fullMatch.length;
    const precedingChar = start > 0 ? text[start - 1] : null;
    const isLineStart = start === 0 || precedingChar === "\n";
    const cmd = commandMap.get(commandName.toLowerCase());
    let valid = false;
    if (cmd) {
      if (isLineStart) {
        valid = cmd.userInvocable !== false && !cmd.hidden;
      } else {
        const prefix = text.slice(0, start);
        valid = cmd.modelInvocable === true || isStackedSkillCompletableCommand(cmd) && isValidStackedSkillPrefix(prefix, commands);
      }
    }
    tokens.push({ start, end, commandName, valid });
  }
  return tokens;
}
__name(findSlashCommandTokens, "findSlashCommandTokens");

// packages/cli/src/acp-integration/session-model-persistence.ts
init_esbuild_shims();
var debugLogger2 = createDebugLogger("SESSION_MODEL");
var AUTH_TYPES = new Set(Object.values(AuthType));
function isAuthType(value) {
  return AUTH_TYPES.has(value);
}
__name(isAuthType, "isAuthType");
function registryHonoredBaseUrl(config, authType, modelId, baseUrl) {
  if (typeof baseUrl !== "string" || !baseUrl) {
    return void 0;
  }
  return config.getResolvedModelConfig?.(authType, modelId, baseUrl) ? baseUrl : void 0;
}
__name(registryHonoredBaseUrl, "registryHonoredBaseUrl");
async function recordDaemonSessionModel(config, payload) {
  const recording = config.getChatRecordingService?.();
  if (!recording?.recordSessionModel) return;
  try {
    await recording.recordSessionModel(payload);
  } catch (error) {
    debugLogger2.debug("recordSessionModel failed", error);
  }
}
__name(recordDaemonSessionModel, "recordDaemonSessionModel");
async function recordDaemonSessionModelFromConfig(config) {
  const modelId = config.getModel()?.trim();
  const authType = config.getAuthType();
  if (!modelId || !authType) return;
  const snapshot = config.getActiveRuntimeModelSnapshot?.();
  const registryBaseUrl = snapshot ? void 0 : config.getCurrentModelRegistryBaseUrl?.();
  await recordDaemonSessionModel(config, {
    modelId,
    authType,
    ...typeof registryBaseUrl === "string" ? { baseUrl: registryBaseUrl } : {},
    ...snapshot ? { isRuntime: true } : {}
  });
}
__name(recordDaemonSessionModelFromConfig, "recordDaemonSessionModelFromConfig");
function hasMatchingRuntimeSnapshot(config, authType, modelId) {
  const snapshot = config.getActiveRuntimeModelSnapshot?.();
  return snapshot?.authType === authType && snapshot.modelId === modelId;
}
__name(hasMatchingRuntimeSnapshot, "hasMatchingRuntimeSnapshot");
function liveAuthType(config) {
  return config.getAuthType() ?? config.getModelsConfig?.()?.getCurrentAuthType?.();
}
__name(liveAuthType, "liveAuthType");
function runtimeSnapshotIdentity(snapshot) {
  if (!snapshot) return void 0;
  if (typeof snapshot.id === "string" && snapshot.id) {
    return snapshot.id;
  }
  if (snapshot.authType && snapshot.modelId) {
    return buildRuntimeSnapshotId(snapshot.authType, snapshot.modelId);
  }
  return void 0;
}
__name(runtimeSnapshotIdentity, "runtimeSnapshotIdentity");
function recordedRouteMatches(recorded, currentRegistryBaseUrl) {
  if (!recorded || recorded.isRuntime) return true;
  const targetBaseUrl = recorded.baseUrl;
  if (targetBaseUrl === void 0) {
    return currentRegistryBaseUrl === null || currentRegistryBaseUrl === void 0;
  }
  if (targetBaseUrl === "") {
    return currentRegistryBaseUrl === null || currentRegistryBaseUrl === void 0 || currentRegistryBaseUrl === "";
  }
  return currentRegistryBaseUrl === targetBaseUrl;
}
__name(recordedRouteMatches, "recordedRouteMatches");
async function applyRestoredSessionModel(config, projection) {
  const recorded = projection?.runtime.recording.sessionModel;
  const fallbackModel = projection?.runtime.recording.lastAssistantModel;
  const recordedAuth = recorded?.authType?.trim();
  const authType = (recordedAuth && isAuthType(recordedAuth) ? recordedAuth : liveAuthType(config))?.trim();
  const modelId = recorded?.modelId || fallbackModel;
  if (!modelId?.trim() || !authType || !isAuthType(authType)) return;
  const currentModel = stripRuntimeSnapshotPrefix(config.getModel() ?? "");
  const currentAuth = liveAuthType(config);
  const targetModel = stripRuntimeSnapshotPrefix(modelId.trim());
  const targetBaseUrl = recorded?.isRuntime ? void 0 : registryHonoredBaseUrl(config, authType, targetModel, recorded?.baseUrl);
  const recordedRoute = recorded ? {
    ...recorded,
    ...targetBaseUrl ? { baseUrl: targetBaseUrl } : { baseUrl: void 0 }
  } : void 0;
  const currentRegistryBaseUrl = config.getCurrentModelRegistryBaseUrl?.();
  const baseUrlMatches = recordedRouteMatches(
    recordedRoute,
    currentRegistryBaseUrl
  );
  const currentRuntimeMatches = hasMatchingRuntimeSnapshot(
    config,
    authType,
    targetModel
  );
  if (currentModel === targetModel && currentAuth === authType && baseUrlMatches && !(recorded && !recorded.isRuntime && currentRuntimeMatches)) {
    return;
  }
  const useRuntimeSnapshot = Boolean(recorded?.isRuntime) && hasMatchingRuntimeSnapshot(config, authType, targetModel);
  const switchModelId = useRuntimeSnapshot ? buildRuntimeSnapshotId(authType, targetModel) : targetModel;
  const requireCachedCredentials = authType === "qwen-oauth" /* QWEN_OAUTH */ && currentAuth !== authType;
  const switchOptions = targetBaseUrl || requireCachedCredentials ? {
    ...targetBaseUrl ? { baseUrl: targetBaseUrl } : {},
    ...requireCachedCredentials ? { requireCachedCredentials: true } : {}
  } : void 0;
  try {
    await config.switchModel(authType, switchModelId, switchOptions);
  } catch (error) {
    debugLogger2.warn(
      `restore session model failed (${targetModel}/${authType}): ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
__name(applyRestoredSessionModel, "applyRestoredSessionModel");
async function restoreSessionModelThenAuthenticate(config, projection, authenticate) {
  const originalAuth = liveAuthType(config);
  const originalModel = config.getModel();
  const originalBaseUrl = config.getCurrentModelRegistryBaseUrl?.();
  const originalRuntimeSnapshot = config.getActiveRuntimeModelSnapshot?.();
  await applyRestoredSessionModel(config, projection);
  try {
    await authenticate();
  } catch (error) {
    if (liveAuthType(config) === originalAuth && config.getModel() === originalModel && (config.getCurrentModelRegistryBaseUrl?.() ?? void 0) === (originalBaseUrl ?? void 0) && runtimeSnapshotIdentity(config.getActiveRuntimeModelSnapshot?.()) === runtimeSnapshotIdentity(originalRuntimeSnapshot)) {
      throw error;
    }
    debugLogger2.warn(
      "restored session model made authentication fail; retrying with settings model"
    );
    if (!originalAuth || !originalModel) {
      throw error;
    }
    const rollbackModelId = originalRuntimeSnapshot?.authType === originalAuth && originalRuntimeSnapshot.modelId === stripRuntimeSnapshotPrefix(originalModel) ? buildRuntimeSnapshotId(
      originalAuth,
      stripRuntimeSnapshotPrefix(originalModel)
    ) : originalModel;
    try {
      await config.switchModel(
        originalAuth,
        rollbackModelId,
        typeof originalBaseUrl === "string" ? { baseUrl: originalBaseUrl } : void 0
      );
    } catch {
      throw error;
    }
    await authenticate();
  }
}
__name(restoreSessionModelThenAuthenticate, "restoreSessionModelThenAuthenticate");

// packages/cli/src/nonInteractiveCliCommands.ts
init_esbuild_shims();

// packages/cli/src/services/CommandService.ts
init_esbuild_shims();
var debugLogger3 = createDebugLogger("CLI_COMMANDS");
function commandOrigin(command) {
  const owner = command.extensionName ? `extension "${command.extensionName}"` : command.kind;
  return `${owner} command "${command.name}"`;
}
__name(commandOrigin, "commandOrigin");
var CommandService = class _CommandService {
  /**
   * Private constructor to enforce the use of the async factory.
   * @param commands A readonly array of the fully loaded and de-duplicated commands.
   */
  constructor(commands) {
    this.commands = commands;
  }
  static {
    __name(this, "CommandService");
  }
  /**
   * Asynchronously creates and initializes a new CommandService instance.
   *
   * This factory method orchestrates the entire command loading process. It
   * runs all provided loaders in parallel, aggregates their results, handles
   * name conflicts for extension commands by renaming them, and then returns a
   * fully constructed `CommandService` instance.
   *
   * Conflict resolution:
   * - Extension commands that conflict with existing commands are renamed to
   *   `extensionName.commandName`
   * - Non-extension commands (built-in, user, project) override earlier commands
   *   with the same name based on loader order
   *
   * @param loaders An array of objects that conform to the `ICommandLoader`
   *   interface. Built-in commands should come first, followed by FileCommandLoader.
   * @param signal An AbortSignal to cancel the loading process.
   * @param disabledNames Optional set of command names to exclude. Matched
   *   case-insensitively against the final (post-rename) command name, and for a
   *   skill command against its authored name as well. Intended
   *   for settings- or flag-driven denylists that gate the CLI surface (see
   *   `slashCommands.disabled` and `--disabled-slash-commands`).
   * @returns A promise that resolves to a new, fully initialized `CommandService` instance.
   */
  static async create(loaders, signal, disabledNames) {
    const results = await Promise.allSettled(
      loaders.map((loader) => loader.loadCommands(signal))
    );
    const allCommands = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        allCommands.push(...result.value);
      } else {
        debugLogger3.debug("A command loader failed:", result.reason);
      }
    }
    const commandMap = /* @__PURE__ */ new Map();
    for (const cmd of allCommands) {
      let finalName = cmd.name;
      if (cmd.extensionName && commandMap.has(cmd.name)) {
        let renamedName = `${cmd.extensionName}.${cmd.name}`;
        let suffix = 1;
        while (commandMap.has(renamedName)) {
          renamedName = `${cmd.extensionName}.${cmd.name}${suffix}`;
          suffix++;
        }
        finalName = renamedName;
      }
      const shadowed = commandMap.get(finalName);
      if (shadowed) {
        debugLogger3.warn(
          `Slash command "/${finalName}" from ${commandOrigin(shadowed)} is replaced by ${commandOrigin(cmd)}`
        );
      }
      commandMap.set(finalName, {
        ...cmd,
        name: finalName
      });
    }
    if (disabledNames && disabledNames.size > 0) {
      const normalizedDisabled = /* @__PURE__ */ new Set();
      for (const entry of disabledNames) {
        const trimmed = entry.trim();
        if (trimmed) normalizedDisabled.add(trimmed.toLowerCase());
      }
      if (normalizedDisabled.size > 0) {
        for (const [name, cmd] of Array.from(commandMap.entries())) {
          if (commandRestrictionNames(cmd).some(
            (candidate) => normalizedDisabled.has(candidate)
          )) {
            commandMap.delete(name);
          }
        }
      }
    }
    const finalCommands = Object.freeze(Array.from(commandMap.values()));
    return new _CommandService(finalCommands);
  }
  /**
   * Retrieves the currently loaded and de-duplicated list of slash commands.
   *
   * This method is a safe accessor for the service's state. It returns a
   * readonly array, preventing consumers from modifying the service's internal state.
   *
   * @returns A readonly, unified array of available `SlashCommand` objects.
   */
  getCommands() {
    return this.commands;
  }
  /**
   * Returns commands available in the specified execution mode.
   * Hidden and non-user-invocable commands are excluded.
   */
  getCommandsForMode(mode) {
    return Object.freeze(
      filterCommandsForMode(
        this.commands.filter(
          (cmd) => !cmd.hidden && cmd.userInvocable !== false
        ),
        mode
      )
    );
  }
  /**
   * Returns commands that the model is allowed to invoke (modelInvocable === true).
   * Hidden commands are excluded.
   */
  getModelInvocableCommands() {
    return this.commands.filter(
      (cmd) => !cmd.hidden && cmd.modelInvocable === true
    );
  }
};

// packages/cli/src/services/BuiltinCommandLoader.ts
init_esbuild_shims();

// packages/cli/src/ui/commands/aboutCommand.ts
init_esbuild_shims();

// packages/cli/src/utils/sessionPaths.ts
init_esbuild_shims();
import fs from "node:fs/promises";
import path from "node:path";
var debugLogger4 = createDebugLogger("SESSION_PATHS");
var OPENAI_LOG_SCAN_LIMIT = 100;
async function collectSessionPathInfo(context) {
  const config = context.services.config;
  const sessionId = config?.getSessionId() || context.session.stats.sessionId || "unknown";
  const contentGeneratorConfig = config?.getContentGeneratorConfig();
  const workingDir = config?.getWorkingDir() || process.cwd();
  const openAILogDir = resolveOpenAILogDir(
    contentGeneratorConfig?.openAILoggingDir,
    workingDir
  );
  const openAILoggingEnabled = contentGeneratorConfig?.enableOpenAILogging === true;
  const latestOpenAILog = openAILoggingEnabled && sessionId !== "unknown" ? await findLatestOpenAILogForSession(openAILogDir, sessionId) : void 0;
  const transcriptPath = config?.getTranscriptPath() || "";
  const debugLogPath = config?.getDebugMode() && sessionId !== "unknown" ? Storage.getDebugLogPath(sessionId) : "";
  const planFilePath = config?.getPlanFilePath() || (sessionId === "unknown" ? "" : Storage.getPlanFilePath(sessionId));
  const planFileExists = planFilePath ? await pathExists(planFilePath) : false;
  const sections = [
    {
      title: "Session files",
      entries: [
        { label: "Session ID", value: sessionId },
        ...transcriptPath ? [{ label: "Transcript", value: transcriptPath }] : [],
        ...debugLogPath ? [{ label: "Debug log", value: debugLogPath }] : [],
        ...planFileExists ? [{ label: "Plan file", value: planFilePath }] : []
      ]
    }
  ];
  if (openAILoggingEnabled) {
    sections.push({
      title: "OpenAI logs",
      entries: [
        { label: "Directory", value: openAILogDir },
        { label: "Latest for session", value: latestOpenAILog ?? "none yet" }
      ]
    });
  }
  return {
    sections
  };
}
__name(collectSessionPathInfo, "collectSessionPathInfo");
function formatSessionPathInfo(info) {
  const lines = [];
  for (const [index, section] of info.sections.entries()) {
    if (index > 0) {
      lines.push("");
    }
    lines.push(`${section.title}:`);
    for (const entry of section.entries) {
      lines.push(`  ${entry.label}: ${entry.value}`);
    }
  }
  return lines.join("\n");
}
__name(formatSessionPathInfo, "formatSessionPathInfo");
async function findLatestOpenAILogForSession(logDir, sessionId) {
  const files = await listLogFiles(
    logDir,
    (name) => /^openai-.*\.json$/.test(name)
  );
  for (const file of files) {
    try {
      const raw = await fs.readFile(file, "utf-8");
      const parsed = JSON.parse(raw);
      if (hasContextSessionId(parsed, sessionId)) {
        return file;
      }
    } catch (error) {
      if (error instanceof SyntaxError || error.code === "ENOENT") {
        continue;
      }
      debugLogger4.warn("Error reading OpenAI log file", file, error);
    }
  }
  return void 0;
}
__name(findLatestOpenAILogForSession, "findLatestOpenAILogForSession");
async function listLogFiles(dir, predicate) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !predicate(entry.name)) {
        continue;
      }
      insertRecentFile(files, path.join(dir, entry.name));
    }
    return files;
  } catch (error) {
    if (error.code !== "ENOENT") {
      debugLogger4.warn("Unable to list OpenAI log directory", dir, error);
    }
    return [];
  }
}
__name(listLogFiles, "listLogFiles");
function insertRecentFile(files, file) {
  const insertAt = files.findIndex((existing) => file > existing);
  if (insertAt === -1) {
    if (files.length < OPENAI_LOG_SCAN_LIMIT) {
      files.push(file);
    }
    return;
  }
  files.splice(insertAt, 0, file);
  if (files.length > OPENAI_LOG_SCAN_LIMIT) {
    files.pop();
  }
}
__name(insertRecentFile, "insertRecentFile");
async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
__name(pathExists, "pathExists");
function hasContextSessionId(value, sessionId) {
  if (!value || typeof value !== "object") {
    return false;
  }
  const context = value.context;
  if (!context || typeof context !== "object") {
    return false;
  }
  const ctx = context;
  return ctx.sessionId === sessionId || ctx.promptId === sessionId;
}
__name(hasContextSessionId, "hasContextSessionId");

// packages/cli/src/ui/commands/aboutCommand.ts
var aboutCommand = {
  name: "status",
  altNames: ["about"],
  get description() {
    return t("show version info");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "non_interactive", "acp"],
  canRunDuringStreaming: true,
  action: /* @__PURE__ */ __name(async (context) => {
    const systemInfo = await getExtendedSystemInfo(context);
    if (context.executionMode !== "interactive") {
      const lines = [
        `Qwen Code v${systemInfo.cliVersion}`,
        `Model: ${systemInfo.modelVersion}`,
        `Fast Model: ${systemInfo.fastModel ?? "not set"}`,
        `Auth: ${systemInfo.selectedAuthType}`,
        `Platform: ${systemInfo.osPlatform} ${systemInfo.osArch} (${systemInfo.osRelease})`,
        `Node.js: ${systemInfo.nodeVersion}`,
        `Session: ${systemInfo.sessionId}`,
        ...systemInfo.gitCommit ? [`Git commit: ${systemInfo.gitCommit}`] : [],
        ...systemInfo.ideClient ? [`IDE: ${systemInfo.ideClient}`] : [],
        ...systemInfo.lspStatus ? [`LSP: ${systemInfo.lspStatus}`] : []
      ];
      return {
        type: "message",
        messageType: "info",
        content: lines.join("\n")
      };
    }
    const aboutItem = {
      type: "about" /* ABOUT */,
      systemInfo
    };
    context.ui.addItem(aboutItem, Date.now());
    return;
  }, "action"),
  subCommands: [
    {
      name: "paths",
      get description() {
        return t("show paths for current session files and logs");
      },
      kind: "built-in" /* BUILT_IN */,
      supportedModes: ["interactive", "non_interactive", "acp"],
      canRunDuringStreaming: true,
      action: /* @__PURE__ */ __name(async (context) => {
        const info = await collectSessionPathInfo(context);
        const content = formatSessionPathInfo(info);
        return {
          type: "message",
          messageType: "info",
          content
        };
      }, "action")
    }
  ]
};

// packages/cli/src/ui/commands/advisor-command.ts
init_esbuild_shims();
var ADVISOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", minLength: 1 },
    risks: { type: "string", minLength: 1 },
    missingEvidence: { type: "string", minLength: 1 },
    recommendation: { type: "string", minLength: 1 }
  },
  required: ["verdict", "risks", "missingEvidence", "recommendation"]
};
function buildAdvisorPrompt(focus) {
  return [
    "<system-reminder>",
    "You are acting as an ADVISOR \u2014 an independent senior reviewer giving a second opinion on the conversation so far. The transcript above may be truncated to the most recent turns; treat what is shown as the evidence available to you.",
    "",
    "CRITICAL CONSTRAINTS:",
    "- You have NO tools. Base every claim strictly on evidence present in the transcript; never claim to have verified something you could not observe.",
    "- Do not perform the task or write the implementation. Review only.",
    "- Be direct about problems: flawed assumptions, premature conclusions, unverified claims, risky next steps.",
    "- The main conversation is NOT interrupted; your review is shown to the user only.",
    "",
    "Return exactly one JSON object with these string fields and no markdown fence, preamble, extra key, or commentary:",
    "- verdict: one short paragraph stating whether the current approach or conclusion is sound.",
    '- risks: concrete risks or flawed assumptions, each citing transcript evidence. Write "None found" if none.',
    "- missingEvidence: claims asserted but not verified in the visible transcript (earlier verification may exist outside the shown window).",
    "- recommendation: the single most valuable next action.",
    "</system-reminder>",
    "",
    focus || "Review the conversation above."
  ].join("\n");
}
__name(buildAdvisorPrompt, "buildAdvisorPrompt");
function formatAdvisorReview(value) {
  const fields = ["verdict", "risks", "missingEvidence", "recommendation"];
  if (!value || Object.keys(value).length !== fields.length || fields.some((field) => {
    const fieldValue = value[field];
    return typeof fieldValue !== "string" || fieldValue.trim().length === 0;
  })) {
    throw new Error("Advisor returned invalid structured output.");
  }
  const review = value;
  return [
    "## Verdict",
    review.verdict.trim(),
    "## Risks",
    review.risks.trim(),
    "## Missing evidence",
    review.missingEvidence.trim(),
    "## Recommendation",
    review.recommendation.trim()
  ].join("\n\n");
}
__name(formatAdvisorReview, "formatAdvisorReview");
function formatAdvisorError(error) {
  return t("Advisor review failed: {{error}}", {
    error: error instanceof Error ? error.message : String(error || "Unknown error")
  });
}
__name(formatAdvisorError, "formatAdvisorError");
async function askAdvisor(context, focus, abortSignal) {
  const { config } = context.services;
  if (!config) throw new Error(t("Config not loaded."));
  const cacheSafeParams = buildBtwCacheSafeParams(config);
  if (!cacheSafeParams || config.getLlmClient().getHistoryForForkWindow().length === 0) {
    throw new Error(t("No conversation context available for /advisor"));
  }
  const advisorModel = context.services.settings.merged.advisorModel?.trim() || void 0;
  const result = await runForkedAgent({
    config,
    userMessage: buildAdvisorPrompt(focus),
    cacheSafeParams,
    jsonSchema: ADVISOR_SCHEMA,
    ...advisorModel ? { model: advisorModel } : {},
    abortSignal,
    disableModelFallbacks: true
  });
  return {
    text: formatAdvisorReview(result.jsonResult),
    model: result.model
  };
}
__name(askAdvisor, "askAdvisor");
var advisorCommand = {
  name: "advisor",
  get description() {
    return t(
      "Get a second opinion on the current conversation from a reviewer model"
    );
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "acp"],
  action: /* @__PURE__ */ __name(async (context, args) => {
    const focus = args.trim();
    if (focus.length > BTW_MAX_INPUT_LENGTH) {
      return {
        type: "message",
        messageType: "error",
        content: t("Focus too long (max {{max}} chars)", {
          max: String(BTW_MAX_INPUT_LENGTH)
        })
      };
    }
    const { config } = context.services;
    const { ui } = context;
    if (!config) {
      return {
        type: "message",
        messageType: "error",
        content: t("Config not loaded.")
      };
    }
    if (!config.getModel()) {
      return {
        type: "message",
        messageType: "error",
        content: t("No model configured.")
      };
    }
    const abortSignal = context.abortSignal ?? new AbortController().signal;
    const executionMode = context.executionMode ?? "interactive";
    if (executionMode !== "interactive") {
      try {
        const review = await askAdvisor(context, focus, abortSignal);
        return { type: "message", messageType: "info", content: review.text };
      } catch (error) {
        return {
          type: "message",
          messageType: "error",
          content: formatAdvisorError(error)
        };
      }
    }
    const turnInFlight = !ui.isIdleRef.current || ui.pendingItem !== null;
    if (turnInFlight) {
      return {
        type: "message",
        messageType: "error",
        content: t(
          "Another operation is in progress, wait for it to complete before running /advisor"
        )
      };
    }
    try {
      ui.setPendingItem({
        type: "info" /* INFO */,
        text: t("Consulting advisor...")
      });
      const review = await askAdvisor(context, focus, abortSignal);
      if (abortSignal.aborted) return;
      ui.addItem(
        { type: "advisor" /* ADVISOR */, text: review.text, model: review.model },
        Date.now()
      );
    } catch (error) {
      if (abortSignal.aborted) return;
      ui.addItem(
        { type: "error" /* ERROR */, text: formatAdvisorError(error) },
        Date.now()
      );
    } finally {
      if (!abortSignal.aborted) ui.setPendingItem(null);
    }
  }, "action")
};

// packages/cli/src/ui/commands/tasksCommand.ts
init_esbuild_shims();
function statusLabel(entry) {
  switch (entry.kind) {
    case "agent": {
      const status = entry.status;
      switch (status) {
        case "completed":
          return "completed";
        case "failed":
          return `failed: ${entry.error ?? "unknown error"}`;
        case "cancelled":
          return "cancelled";
        case "paused":
          return entry.resumeBlockedReason ? `paused (resume blocked): ${entry.resumeBlockedReason}` : "paused";
        case "running":
          return "running";
        default: {
          const _exhaustive = status;
          throw new Error(
            `statusLabel(agent): unknown status: ${JSON.stringify(_exhaustive)}`
          );
        }
      }
    }
    case "shell": {
      const status = entry.status;
      switch (status) {
        case "completed":
          return `completed (exit ${entry.exitCode ?? "?"})`;
        case "failed":
          return `failed: ${entry.error ?? "unknown error"}`;
        case "cancelled":
          return "cancelled";
        case "running":
          return "running";
        default: {
          const _exhaustive = status;
          throw new Error(
            `statusLabel(shell): unknown status: ${JSON.stringify(_exhaustive)}`
          );
        }
      }
    }
    case "monitor": {
      const events = `${entry.eventCount} event${entry.eventCount === 1 ? "" : "s"}`;
      const status = entry.status;
      switch (status) {
        case "completed":
          return entry.error ? `completed (${entry.error}, ${events})` : `completed (exit ${entry.exitCode ?? "?"}, ${events})`;
        case "failed":
          return `failed: ${entry.error ?? "unknown error"} (${events})`;
        case "cancelled":
          return `cancelled (${events})`;
        case "running":
          return `running (${events})`;
        default: {
          const _exhaustive = status;
          throw new Error(
            `statusLabel(monitor): unknown status: ${JSON.stringify(_exhaustive)}`
          );
        }
      }
    }
    default: {
      const _exhaustive = entry;
      throw new Error(
        `statusLabel: unknown TaskEntry kind: ${JSON.stringify(_exhaustive)}`
      );
    }
  }
}
__name(statusLabel, "statusLabel");
function taskLabel(entry) {
  switch (entry.kind) {
    case "agent":
      return buildBackgroundEntryLabel(entry);
    case "shell":
      return entry.command;
    case "monitor":
      return entry.description;
    default: {
      const _exhaustive = entry;
      throw new Error(
        `taskLabel: unknown TaskEntry kind: ${JSON.stringify(_exhaustive)}`
      );
    }
  }
}
__name(taskLabel, "taskLabel");
function taskId(entry) {
  switch (entry.kind) {
    case "agent":
      return entry.agentId;
    case "shell":
      return entry.shellId;
    case "monitor":
      return entry.monitorId;
    default: {
      const _exhaustive = entry;
      throw new Error(
        `taskId: unknown TaskEntry kind: ${JSON.stringify(_exhaustive)}`
      );
    }
  }
}
__name(taskId, "taskId");
function taskOutputPath(entry) {
  switch (entry.kind) {
    case "agent":
    case "shell":
      return entry.outputFile;
    case "monitor":
      return void 0;
    default: {
      const _exhaustive = entry;
      throw new Error(
        `taskOutputPath: unknown TaskEntry kind: ${JSON.stringify(_exhaustive)}`
      );
    }
  }
}
__name(taskOutputPath, "taskOutputPath");
var tasksCommand = {
  name: "tasks",
  get description() {
    return t(
      "List background tasks (text dump \u2014 interactive dialog opens via the footer pill)"
    );
  },
  kind: "built-in" /* BUILT_IN */,
  // Kept on all three modes: the interactive dialog (reachable via ↓ +
  // Enter on the footer Background tasks pill) is the richer surface
  // when a TTY is available, but `non_interactive` and `acp` consumers
  // (headless `-p`, IDE bridges, SDK) have no dialog and rely on this
  // text dump as the only way to inspect background task state. See the
  // interactive-mode hint at the top of the output for the soft redirect.
  supportedModes: ["interactive", "non_interactive", "acp"],
  canRunDuringStreaming: true,
  action: /* @__PURE__ */ __name(async (context) => {
    const { config } = context.services;
    if (!config) {
      return {
        type: "message",
        messageType: "error",
        content: "Config not available."
      };
    }
    const agentEntries = [
      ...config.getBackgroundTaskRegistry().getAll()
    ];
    const shellEntries = [
      ...config.getBackgroundShellRegistry().getAll()
    ];
    const monitorEntries = [
      ...config.getMonitorRegistry().getAll()
    ];
    const entries = [
      ...agentEntries,
      ...shellEntries,
      ...monitorEntries
    ].sort((a, b) => a.startTime - b.startTime);
    if (entries.length === 0) {
      return {
        type: "message",
        messageType: "info",
        content: "No background tasks."
      };
    }
    const now = Date.now();
    const lines = [];
    if (context.executionMode === "interactive") {
      lines.push(
        t(
          "Tip: focus the Background tasks pill in the footer (use \u2193 from an empty composer) and press Enter for the interactive dialog with detail view + live updates."
        ),
        ""
      );
    }
    lines.push(`Background tasks (${entries.length} total)`, "");
    for (const entry of entries) {
      const endTime = entry.endTime ?? now;
      const runtime = formatDuration(endTime - entry.startTime, {
        hideTrailingZeros: true
      });
      const pidPart = (entry.kind === "shell" || entry.kind === "monitor") && entry.pid !== void 0 ? ` pid=${entry.pid}` : "";
      lines.push(
        `[${taskId(entry)}] ${statusLabel(entry)}  ${runtime}${pidPart}  ${taskLabel(entry)}`
      );
      const outputPath = taskOutputPath(entry);
      if (outputPath) {
        lines.push(`            output: ${outputPath}`);
      }
    }
    return {
      type: "message",
      messageType: "info",
      content: stripUnsafeCharacters(lines.join("\n"))
    };
  }, "action")
};

// packages/cli/src/ui/commands/workflowsCommand.ts
init_esbuild_shims();
function snapshotToTask(s) {
  return {
    id: s.runId,
    kind: "workflow",
    runId: s.runId,
    ...s.toolUseId ? { toolUseId: s.toolUseId } : {},
    ...s.sourceRef ? { sourceRef: { ...s.sourceRef } } : {},
    ...s.workflowCalls ? { workflowCalls: s.workflowCalls.map((call) => ({ ...call })) } : {},
    ...s.workflowCallsTruncated ? { workflowCallsTruncated: true } : {},
    ...s.workflowName ? { workflowName: s.workflowName } : {},
    description: s.meta?.name ?? s.runId,
    meta: s.meta,
    status: s.status,
    currentPhase: null,
    currentPhaseVisitId: null,
    phases: s.phases ?? [],
    phaseVisits: s.phaseVisits ?? [],
    dispatches: s.dispatches ?? [],
    sourceRunId: s.sourceRunId,
    startMode: s.startMode,
    agentsDispatched: s.agentsDispatched ?? 0,
    agentsCompleted: s.agentsCompleted ?? 0,
    recentLogs: s.recentLogs ?? [],
    events: s.events ?? [],
    tokensSpent: s.tokensSpent ?? 0,
    tokenBudgetTotal: s.tokenBudgetTotal ?? null,
    perPhaseTokens: new Map(s.perPhaseTokens ?? []),
    pendingApprovals: [],
    script: s.script ?? "",
    scriptPath: s.scriptPath,
    result: s.result,
    error: s.error,
    startTime: s.startTime,
    endTime: s.endTime,
    outputFile: "",
    outputOffset: 0,
    notified: true,
    abortController: new AbortController()
  };
}
__name(snapshotToTask, "snapshotToTask");
function rowLine(entry, now) {
  const endTime = entry.endTime ?? now;
  const runtime = formatDuration(endTime - entry.startTime, {
    hideTrailingZeros: true
  });
  const label = entry.meta?.name ?? entry.runId;
  const phase = entry.currentPhase ? ` \xB7 ${entry.currentPhase}` : "";
  const counts = entry.agentsDispatched > 0 ? ` \xB7 ${entry.agentsCompleted}/${entry.agentsDispatched} agents` : "";
  const phaseCount = entry.phases.length > 0 ? ` \xB7 ${entry.phases.length} ${entry.phases.length === 1 ? "phase" : "phases"}` : "";
  const budgetChip = entry.tokensSpent > 0 || entry.tokenBudgetTotal !== null ? entry.tokenBudgetTotal !== null ? ` \xB7 ${formatTokenCount(entry.tokensSpent)}/${formatTokenCount(entry.tokenBudgetTotal)}t` : ` \xB7 ${formatTokenCount(entry.tokensSpent)}t` : "";
  const errorTail = entry.status === "failed" && entry.error ? ` \u2014 ${entry.error.slice(0, 80)}` : "";
  return `  ${entry.runId.padEnd(20)} ${entry.status.padEnd(10)} ${runtime.padStart(8)}  ${label}${phase}${counts}${phaseCount}${budgetChip}${errorTail}`;
}
__name(rowLine, "rowLine");
function detailLines(entry, now) {
  const lines = [];
  const endTime = entry.endTime ?? now;
  const runtime = formatDuration(endTime - entry.startTime, {
    hideTrailingZeros: true
  });
  lines.push(`Workflow ${entry.runId}`);
  if (entry.meta?.name) {
    lines.push(`  name        : ${entry.meta.name}`);
  }
  if (entry.meta?.description) {
    lines.push(`  description : ${entry.meta.description}`);
  }
  if (entry.meta?.whenToUse) {
    lines.push(`  whenToUse   : ${entry.meta.whenToUse}`);
  }
  lines.push(`  status      : ${entry.status}`);
  lines.push(`  runtime     : ${runtime}`);
  if (entry.currentPhase) {
    lines.push(`  currentPhase: ${entry.currentPhase}`);
  }
  lines.push(
    `  agents      : ${entry.agentsCompleted}/${entry.agentsDispatched}`
  );
  lines.push(`  tokens      : ${formatTokenCount(entry.tokensSpent)}`);
  lines.push(
    `  cap         : ${entry.tokenBudgetTotal !== null ? formatTokenCount(entry.tokenBudgetTotal) : "(no cap)"}`
  );
  if (entry.error) {
    lines.push(`  error       : ${entry.error}`);
  }
  if (entry.phases.length > 0) {
    lines.push("");
    lines.push(`  Phases (${entry.phases.length})`);
    for (const phase of entry.phases) {
      const phaseTokens = entry.perPhaseTokens.get(phase) ?? 0;
      const chip = phaseTokens > 0 ? ` \xB7 ${formatTokenCount(phaseTokens)}t` : "";
      lines.push(`    \xB7 ${phase}${chip}`);
    }
    const prePhaseTokens = entry.perPhaseTokens.get(null) ?? 0;
    if (prePhaseTokens > 0) {
      lines.push(`    \xB7 (no phase) \xB7 ${formatTokenCount(prePhaseTokens)}t`);
    }
  }
  if (entry.recentLogs.length > 0) {
    lines.push("");
    lines.push(`  Logs (last ${entry.recentLogs.length})`);
    for (const line of entry.recentLogs) {
      lines.push(`    ${line}`);
    }
  }
  return lines;
}
__name(detailLines, "detailLines");
var workflowsCommand = {
  name: "workflows",
  get description() {
    return t("List workflow runs or cooperatively pause/resume a live run");
  },
  get argumentHint() {
    return t("[runId | p <runId>]");
  },
  kind: "built-in" /* BUILT_IN */,
  // Same triple-mode coverage as `/tasks`: the dialog is richer in
  // interactive mode but headless / acp consumers need the text dump
  // as their only inspection path.
  supportedModes: ["interactive", "non_interactive", "acp"],
  action: /* @__PURE__ */ __name(async (context, args) => {
    const { config } = context.services;
    if (!config) {
      return {
        type: "message",
        messageType: "error",
        content: "Config not available."
      };
    }
    const registry = config.getWorkflowRunRegistry();
    const allEntries = registry.list();
    const trimmedArgs = (args ?? "").trim();
    const tokens = trimmedArgs.split(/\s+/);
    if (tokens[0] === "p") {
      if (context.executionMode !== "interactive") {
        return {
          type: "message",
          messageType: "error",
          content: "Workflow pause controls are available only in the interactive TUI."
        };
      }
      if (tokens.length !== 2 || !tokens[1]) {
        return {
          type: "message",
          messageType: "error",
          content: "Usage: /workflows p <runId>"
        };
      }
      const runId = tokens[1];
      let target = registry.get(runId);
      let fromSnapshot = false;
      if (!target) {
        const snapshot = (await listWorkflowSnapshots(config)).find(
          (s) => s.runId === runId
        );
        if (snapshot) {
          target = snapshotToTask(snapshot);
          fromSnapshot = true;
        }
      }
      if (!target) {
        return {
          type: "message",
          messageType: "error",
          content: `Unknown live workflow runId: ${runId}`
        };
      }
      if (isTerminalWorkflowStatus(target.status)) {
        return {
          type: "message",
          messageType: "error",
          content: `Workflow ${runId} is ${target.status} and cannot be paused or resumed.`
        };
      }
      if (!fromSnapshot && !target.isBackgrounded) {
        return {
          type: "message",
          messageType: "error",
          content: "Foreground workflow runs cannot be paused or resumed; only background runs support cooperative pause."
        };
      }
      if (target.status === "pausing") {
        return {
          type: "message",
          messageType: "warning",
          content: `Workflow ${runId} is still pausing; wait until it reaches paused before resuming.`
        };
      }
      if (target.status === "running") {
        return registry.pause(runId) ? {
          type: "message",
          messageType: "info",
          content: `Cooperative pause requested for workflow ${runId}.`
        } : {
          type: "message",
          messageType: "error",
          content: `Workflow ${runId} could not be paused because its state changed.`
        };
      }
      if (target.status === "paused") {
        return registry.resume(runId) ? {
          type: "message",
          messageType: "info",
          content: `Resume requested for workflow ${runId}.`
        } : {
          type: "message",
          messageType: "error",
          content: `Workflow ${runId} could not be resumed because its state changed.`
        };
      }
      return {
        type: "message",
        messageType: "error",
        content: `Workflow ${runId} is ${target.status} and cannot be paused or resumed.`
      };
    }
    if (trimmedArgs.length > 0) {
      let target = registry.get(trimmedArgs);
      if (!target) {
        const snapshot = (await listWorkflowSnapshots(config)).find(
          (s) => s.runId === trimmedArgs
        );
        if (snapshot) target = snapshotToTask(snapshot);
      }
      if (!target) {
        return {
          type: "message",
          messageType: "error",
          content: `Unknown workflow runId: ${trimmedArgs}`
        };
      }
      return {
        type: "message",
        messageType: "info",
        content: detailLines(target, Date.now()).join("\n")
      };
    }
    const snapshots = await listWorkflowSnapshots(config);
    const liveRunIds = new Set(allEntries.map((e) => e.runId));
    const snapshotTasks = snapshots.filter((s) => !liveRunIds.has(s.runId)).map(snapshotToTask);
    if (allEntries.length === 0 && snapshotTasks.length === 0) {
      return {
        type: "message",
        messageType: "info",
        content: "No workflow runs recorded yet."
      };
    }
    const now = Date.now();
    const active = allEntries.filter((e) => isActiveWorkflowStatus(e.status)).sort((a, b) => a.startTime - b.startTime);
    const terminal = [
      ...allEntries.filter((e) => !isActiveWorkflowStatus(e.status)),
      ...snapshotTasks
    ].sort((a, b) => (b.endTime ?? 0) - (a.endTime ?? 0));
    const lines = [];
    if (context.executionMode === "interactive") {
      lines.push(
        t(
          "Tip: use `/workflows p <runId>` or Background tasks + p to cooperatively pause/resume; use `/workflows <runId>` for details."
        ),
        ""
      );
    }
    lines.push(
      `Workflow runs (${active.length + terminal.length} total \xB7 ${active.length} active)`,
      ""
    );
    if (active.length > 0) {
      lines.push("Active");
      for (const entry of active) lines.push(rowLine(entry, now));
      lines.push("");
    }
    if (terminal.length > 0) {
      lines.push("Recent");
      for (const entry of terminal) lines.push(rowLine(entry, now));
    }
    return {
      type: "message",
      messageType: "info",
      content: lines.join("\n")
    };
  }, "action")
};

// packages/cli/src/ui/commands/agentsCommand.ts
init_esbuild_shims();
var agentsCommand = {
  name: "agents",
  get description() {
    return t("Manage subagents for specialized task delegation.");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive"],
  subCommands: [
    {
      name: "manage",
      get description() {
        return t("Manage existing subagents (view, edit, delete).");
      },
      kind: "built-in" /* BUILT_IN */,
      supportedModes: ["interactive"],
      action: /* @__PURE__ */ __name(() => ({
        type: "dialog",
        dialog: "subagent_list"
      }), "action")
    },
    {
      name: "create",
      get description() {
        return t("Create a new subagent with guided setup.");
      },
      kind: "built-in" /* BUILT_IN */,
      supportedModes: ["interactive"],
      action: /* @__PURE__ */ __name(() => ({
        type: "dialog",
        dialog: "subagent_create"
      }), "action")
    }
  ]
};

// packages/cli/src/ui/commands/arenaCommand.ts
init_esbuild_shims();
function parseArenaArgs(args) {
  const modelsMatch = args.match(/--models\s+(\S+)/);
  let models = [];
  let task = args;
  if (modelsMatch) {
    const modelStrings = modelsMatch[1].split(",").filter(Boolean);
    models = modelStrings.map((str) => {
      const colonIndex = str.indexOf(":");
      if (colonIndex > 0) {
        return {
          authType: str.substring(0, colonIndex),
          modelId: str.substring(colonIndex + 1)
        };
      }
      return { modelId: str };
    });
    task = task.replace(/--models\s+\S+/, "").trim();
  }
  task = task.replace(/^["']|["']$/g, "").trim();
  return { models, task };
}
__name(parseArenaArgs, "parseArenaArgs");
var debugLogger5 = createDebugLogger("ARENA_COMMAND");
function buildArenaExecutionInput(parsed, config) {
  if (!parsed.task) {
    return {
      type: "message",
      messageType: "error",
      content: [
        t("Usage: /arena start --models model1,model2 <task>"),
        "",
        t("Options:"),
        "  --models [authType:]model1,[authType:]model2",
        `                            ${t(
          "Models to compete (required, at least 2)"
        )}`,
        `                            ${t(
          "Format: authType:modelId or just modelId"
        )}`,
        "",
        t("Examples:"),
        '  /arena start --models openai:gpt-4o,anthropic:claude-3 "implement sorting"',
        '  /arena start --models qwen-coder-plus,kimi-for-coding "fix the bug"'
      ].join("\n")
    };
  }
  if (parsed.models.length < 2) {
    return {
      type: "message",
      messageType: "error",
      content: [
        t(
          "Arena requires at least 2 models. Use --models model1,model2 to specify."
        ),
        t("Format: [authType:]modelId (e.g., openai:gpt-4o or just gpt-4o)")
      ].join("\n")
    };
  }
  const contentGeneratorConfig = config.getContentGeneratorConfig();
  const defaultAuthType = contentGeneratorConfig?.authType ?? "openai" /* USE_OPENAI */;
  const modelsConfig = config.getModelsConfig();
  const models = [];
  for (const parsedModel of parsed.models) {
    const authType = parsedModel.authType ?? defaultAuthType;
    const registryModels = modelsConfig.getAvailableModelsForAuthType(authType);
    const resolved = registryModels.find((m) => m.id === parsedModel.modelId);
    if (resolved?.imageOnly) {
      return {
        type: "message",
        messageType: "error",
        content: t(
          "Image-only model '{{model}}' cannot be used in an Arena session.",
          { model: parsedModel.modelId }
        )
      };
    }
    models.push({
      modelId: parsedModel.modelId,
      authType,
      displayName: resolved?.label ?? parsedModel.modelId
    });
  }
  return {
    task: parsed.task,
    models,
    approvalMode: config.getApprovalMode()
  };
}
__name(buildArenaExecutionInput, "buildArenaExecutionInput");
function recordArenaItem(config, item) {
  try {
    const chatRecorder = config.getChatRecordingService();
    if (!chatRecorder) return;
    chatRecorder.recordSlashCommand({
      phase: "result",
      rawCommand: "/arena",
      outputHistoryItems: [{ ...item }]
    });
  } catch {
    debugLogger5.error("Failed to record arena history item");
  }
}
__name(recordArenaItem, "recordArenaItem");
function executeArenaCommand(config, ui, input) {
  let chatHistory;
  try {
    const fullHistory = config.getLlmClient().getChat().getHistoryShallow();
    chatHistory = stripStartupContext(fullHistory);
  } catch {
    debugLogger5.debug("Could not retrieve chat history for arena agents");
  }
  const manager = new ArenaManager(config);
  const emitter = manager.getEventEmitter();
  const detachListeners = [];
  const agentLabels = /* @__PURE__ */ new Map();
  const addArenaMessage = /* @__PURE__ */ __name((type, text) => {
    ui.addItem({ type, text }, Date.now());
  }, "addArenaMessage");
  const addAndRecordArenaMessage = /* @__PURE__ */ __name((type, text) => {
    const item = { type, text };
    ui.addItem(item, Date.now());
    recordArenaItem(config, item);
  }, "addAndRecordArenaMessage");
  const handleSessionStart = /* @__PURE__ */ __name((event) => {
    const modelList = event.models.map((model, index) => `  ${index + 1}. ${model.modelId}`).join("\n");
    addArenaMessage(
      "info" /* INFO */,
      t(
        'Arena started with {{count}} agents on task: "{{task}}"\nModels:\n{{modelList}}',
        {
          count: String(event.models.length),
          task: event.task,
          modelList
        }
      )
    );
  }, "handleSessionStart");
  const handleAgentStart = /* @__PURE__ */ __name((event) => {
    agentLabels.set(event.agentId, event.model.modelId);
    debugLogger5.debug(
      `Arena agent started: ${event.model.modelId} (${event.agentId})`
    );
  }, "handleAgentStart");
  const handleSessionUpdate = /* @__PURE__ */ __name((event) => {
    const attachHintPrefix = "To view agent panes, run: ";
    if (event.message.startsWith(attachHintPrefix)) {
      const command = event.message.slice(attachHintPrefix.length).trim();
      addAndRecordArenaMessage(
        "info" /* INFO */,
        t("Arena panes are running in tmux. Attach with: `{{command}}`", {
          command
        })
      );
      return;
    }
    if (event.type === "success") {
      addAndRecordArenaMessage("success" /* SUCCESS */, event.message);
    } else if (event.type === "info") {
      addAndRecordArenaMessage("info" /* INFO */, event.message);
    } else {
      addAndRecordArenaMessage("warning" /* WARNING */, event.message);
    }
  }, "handleSessionUpdate");
  const handleAgentError = /* @__PURE__ */ __name((event) => {
    const label = agentLabels.get(event.agentId) || event.agentId;
    addAndRecordArenaMessage(
      "error" /* ERROR */,
      t("[{{label}}] failed: {{error}}", {
        label,
        error: event.error
      })
    );
  }, "handleAgentError");
  const buildAgentCardData = /* @__PURE__ */ __name((result) => ({
    label: result.model.modelId,
    status: result.status,
    durationMs: result.stats.durationMs,
    totalTokens: result.stats.totalTokens,
    inputTokens: result.stats.inputTokens,
    outputTokens: result.stats.outputTokens,
    toolCalls: result.stats.toolCalls,
    successfulToolCalls: result.stats.successfulToolCalls,
    failedToolCalls: result.stats.failedToolCalls,
    rounds: result.stats.rounds,
    error: result.error,
    diff: result.diff,
    diffSummary: result.diffSummary,
    modifiedFiles: result.modifiedFiles,
    approachSummary: result.approachSummary
  }), "buildAgentCardData");
  const handleAgentComplete = /* @__PURE__ */ __name((event) => {
    if (!isTerminalStatus(event.result.status)) {
      return;
    }
    const agent = buildAgentCardData(event.result);
    const item = {
      type: "arena_agent_complete",
      agent
    };
    ui.addItem(item, Date.now());
    recordArenaItem(config, item);
  }, "handleAgentComplete");
  const handleSessionError = /* @__PURE__ */ __name((event) => {
    addAndRecordArenaMessage("error" /* ERROR */, `${event.error}`);
  }, "handleSessionError");
  const handleSessionComplete = /* @__PURE__ */ __name((event) => {
    const item = {
      type: "arena_session_complete",
      sessionStatus: event.result.status,
      task: event.result.task,
      totalDurationMs: event.result.totalDurationMs ?? 0,
      agents: event.result.agents.map(buildAgentCardData)
    };
    ui.addItem(item, Date.now());
    recordArenaItem(config, item);
  }, "handleSessionComplete");
  emitter.on("session_start" /* SESSION_START */, handleSessionStart);
  detachListeners.push(
    () => emitter.off("session_start" /* SESSION_START */, handleSessionStart)
  );
  emitter.on("agent_start" /* AGENT_START */, handleAgentStart);
  detachListeners.push(
    () => emitter.off("agent_start" /* AGENT_START */, handleAgentStart)
  );
  emitter.on("session_update" /* SESSION_UPDATE */, handleSessionUpdate);
  detachListeners.push(
    () => emitter.off("session_update" /* SESSION_UPDATE */, handleSessionUpdate)
  );
  emitter.on("agent_error" /* AGENT_ERROR */, handleAgentError);
  detachListeners.push(
    () => emitter.off("agent_error" /* AGENT_ERROR */, handleAgentError)
  );
  emitter.on("agent_complete" /* AGENT_COMPLETE */, handleAgentComplete);
  detachListeners.push(
    () => emitter.off("agent_complete" /* AGENT_COMPLETE */, handleAgentComplete)
  );
  emitter.on("session_error" /* SESSION_ERROR */, handleSessionError);
  detachListeners.push(
    () => emitter.off("session_error" /* SESSION_ERROR */, handleSessionError)
  );
  emitter.on("session_complete" /* SESSION_COMPLETE */, handleSessionComplete);
  detachListeners.push(
    () => emitter.off("session_complete" /* SESSION_COMPLETE */, handleSessionComplete)
  );
  config.setArenaManager(manager);
  const cols = process.stdout.columns || 120;
  const rows = Math.max((process.stdout.rows || 40) - 2, 1);
  const lifecycle = manager.start({
    task: input.task,
    models: input.models,
    cols,
    rows,
    approvalMode: input.approvalMode,
    chatHistory
  }).then(
    () => {
      debugLogger5.debug("Arena agents settled");
    },
    (error) => {
      const message2 = error instanceof Error ? error.message : String(error);
      addAndRecordArenaMessage("error" /* ERROR */, `${message2}`);
      debugLogger5.error("Arena session failed:", error);
      config.setArenaManager(null);
      for (const detach of detachListeners) {
        detach();
      }
    }
  );
  manager.setLifecyclePromise(lifecycle);
}
__name(executeArenaCommand, "executeArenaCommand");
var arenaCommand = {
  name: "arena",
  get description() {
    return t("Manage Arena sessions");
  },
  kind: "built-in" /* BUILT_IN */,
  subCommands: [
    {
      name: "start",
      get description() {
        return t(
          "Start an Arena session with multiple models competing on the same task"
        );
      },
      kind: "built-in" /* BUILT_IN */,
      action: /* @__PURE__ */ __name(async (context, args) => {
        const executionMode = context.executionMode ?? "interactive";
        if (executionMode !== "interactive") {
          return {
            type: "message",
            messageType: "error",
            content: t(
              "Arena is not supported in non-interactive mode. Use interactive mode to start an Arena session."
            )
          };
        }
        const { services, ui } = context;
        const { config } = services;
        if (!config) {
          return {
            type: "message",
            messageType: "error",
            content: t("Configuration not available.")
          };
        }
        const existingManager = config.getArenaManager();
        if (existingManager) {
          return {
            type: "message",
            messageType: "error",
            content: t(
              "An Arena session exists. Use /arena stop or /arena select to end it before starting a new one."
            )
          };
        }
        const parsed = parseArenaArgs(args);
        if (parsed.models.length === 0) {
          return {
            type: "dialog",
            dialog: "arena_start"
          };
        }
        const executionInput = buildArenaExecutionInput(parsed, config);
        if ("type" in executionInput) {
          return executionInput;
        }
        executeArenaCommand(config, ui, executionInput);
      }, "action")
    },
    {
      name: "stop",
      get description() {
        return t("Stop the current Arena session");
      },
      kind: "built-in" /* BUILT_IN */,
      action: /* @__PURE__ */ __name(async (context) => {
        const executionMode = context.executionMode ?? "interactive";
        if (executionMode !== "interactive") {
          return {
            type: "message",
            messageType: "error",
            content: t(
              "Arena is not supported in non-interactive mode. Use interactive mode to stop an Arena session."
            )
          };
        }
        const { config } = context.services;
        if (!config) {
          return {
            type: "message",
            messageType: "error",
            content: t("Configuration not available.")
          };
        }
        const manager = config.getArenaManager();
        if (!manager) {
          return {
            type: "message",
            messageType: "error",
            content: t("No running Arena session found.")
          };
        }
        return {
          type: "dialog",
          dialog: "arena_stop"
        };
      }, "action")
    },
    {
      name: "status",
      get description() {
        return t("Show the current Arena session status");
      },
      kind: "built-in" /* BUILT_IN */,
      action: /* @__PURE__ */ __name(async (context) => {
        const executionMode = context.executionMode ?? "interactive";
        if (executionMode !== "interactive") {
          return {
            type: "message",
            messageType: "error",
            content: t("Arena is not supported in non-interactive mode.")
          };
        }
        const { config } = context.services;
        if (!config) {
          return {
            type: "message",
            messageType: "error",
            content: t("Configuration not available.")
          };
        }
        const manager = config.getArenaManager();
        if (!manager) {
          return {
            type: "message",
            messageType: "error",
            content: t("No Arena session found. Start one with /arena start.")
          };
        }
        return {
          type: "dialog",
          dialog: "arena_status"
        };
      }, "action")
    },
    {
      name: "select",
      altNames: ["choose"],
      get description() {
        return t(
          "Select a model result and merge its diff into the current workspace"
        );
      },
      kind: "built-in" /* BUILT_IN */,
      action: /* @__PURE__ */ __name(async (context, args) => {
        const executionMode = context.executionMode ?? "interactive";
        if (executionMode !== "interactive") {
          return {
            type: "message",
            messageType: "error",
            content: t("Arena is not supported in non-interactive mode.")
          };
        }
        const { config } = context.services;
        if (!config) {
          return {
            type: "message",
            messageType: "error",
            content: t("Configuration not available.")
          };
        }
        const manager = config.getArenaManager();
        if (!manager) {
          return {
            type: "message",
            messageType: "error",
            content: t("No Arena session found. Start one with /arena start.")
          };
        }
        const sessionStatus = manager.getSessionStatus();
        if (sessionStatus === "running" /* RUNNING */ || sessionStatus === "initializing" /* INITIALIZING */) {
          return {
            type: "message",
            messageType: "error",
            content: t(
              "Arena session is still running. Wait for it to complete or use /arena stop first."
            )
          };
        }
        const trimmedArgs = args.trim();
        if (trimmedArgs === "--discard") {
          if (!context.overwriteConfirmed) {
            return {
              type: "confirm_action",
              prompt: t("Discard all Arena results and clean up worktrees?"),
              originalInvocation: {
                raw: context.invocation?.raw || "/arena select --discard"
              }
            };
          }
          await config.cleanupArenaRuntime(true);
          return {
            type: "message",
            messageType: "info",
            content: t("Arena results discarded. All worktrees cleaned up.")
          };
        }
        const agents = manager.getAgentStates();
        const hasSuccessful = agents.some((a) => isSuccessStatus(a.status));
        if (!hasSuccessful) {
          return {
            type: "message",
            messageType: "error",
            content: [
              t(
                "No successful agent results to select from. All agents failed or were cancelled."
              ),
              t("Use /arena stop to end the session.")
            ].join("\n")
          };
        }
        if (trimmedArgs) {
          const matchingAgent = agents.find(
            (a) => isSuccessStatus(a.status) && a.model.modelId.toLowerCase() === trimmedArgs.toLowerCase()
          );
          if (!matchingAgent) {
            return {
              type: "message",
              messageType: "error",
              content: t('No idle agent found matching "{{name}}".', {
                name: trimmedArgs
              })
            };
          }
          const label = matchingAgent.model.modelId;
          const result = await manager.applyAgentResult(matchingAgent.agentId);
          if (!result.success) {
            return {
              type: "message",
              messageType: "error",
              content: t("Failed to apply changes from {{label}}: {{error}}", {
                label,
                error: result.error ?? "Unknown error"
              })
            };
          }
          await config.cleanupArenaRuntime(true);
          return {
            type: "message",
            messageType: "info",
            content: t(
              "Applied changes from {{label}} to workspace. Arena session complete.",
              {
                label
              }
            )
          };
        }
        return {
          type: "dialog",
          dialog: "arena_select"
        };
      }, "action")
    }
  ]
};

// packages/cli/src/ui/commands/approvalModeCommand.ts
init_esbuild_shims();

// packages/cli/src/ui/utils/approvalModeDisplay.ts
init_esbuild_shims();
function formatApprovalModeName(mode) {
  switch (mode) {
    case "plan" /* PLAN */:
      return t("plan mode");
    case "default" /* DEFAULT */:
      return t("Ask permissions");
    case "auto-edit" /* AUTO_EDIT */:
      return t("auto-accept edits");
    case "auto" /* AUTO */:
      return t("Auto mode");
    case "yolo" /* YOLO */:
      return t("YOLO mode");
    default:
      return mode;
  }
}
__name(formatApprovalModeName, "formatApprovalModeName");
function formatApprovalModeDescription(mode) {
  switch (mode) {
    case "plan" /* PLAN */:
      return t("Analyze only, do not modify files or execute commands");
    case "default" /* DEFAULT */:
      return t("Require approval for file edits or shell commands");
    case "auto-edit" /* AUTO_EDIT */:
      return t("Automatically approve file edits");
    case "auto" /* AUTO */:
      return t("Use classifier to automatically approve safe tool calls");
    case "yolo" /* YOLO */:
      return t("Automatically approve all tools");
    default:
      return mode;
  }
}
__name(formatApprovalModeDescription, "formatApprovalModeDescription");

// packages/cli/src/ui/commands/approvalModeCommand.ts
function parseApprovalModeArg(arg) {
  const trimmed = arg.trim().toLowerCase();
  if (!trimmed) {
    return void 0;
  }
  return APPROVAL_MODES.find((mode) => mode.toLowerCase() === trimmed);
}
__name(parseApprovalModeArg, "parseApprovalModeArg");
var approvalModeCommand = {
  name: "approval-mode",
  get description() {
    return t("View or change the approval mode for tool usage");
  },
  argumentHint: "<mode>",
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive"],
  action: /* @__PURE__ */ __name(async (context, args) => {
    const mode = parseApprovalModeArg(args);
    if (!args.trim()) {
      return {
        type: "dialog",
        dialog: "approval-mode"
      };
    }
    if (!mode) {
      return {
        type: "message",
        messageType: "error",
        content: t('Invalid approval mode "{{arg}}". Valid modes: {{modes}}', {
          arg: args.trim(),
          modes: APPROVAL_MODES.join(", ")
        })
      };
    }
    const { config, settings } = context.services;
    let priorMode;
    if (config) {
      try {
        priorMode = config.getApprovalMode();
      } catch (e) {
        return {
          type: "message",
          messageType: "error",
          content: e.message
        };
      }
    }
    const autoModeNotices = mode === "auto" /* AUTO */ && priorMode !== "auto" /* AUTO */ && config ? await import("./useAutoAcceptIndicator-GU7OCGAF.js") : void 0;
    if (config) {
      try {
        config.setApprovalMode(mode);
      } catch (e) {
        return {
          type: "message",
          messageType: "error",
          content: e.message
        };
      }
    }
    if (autoModeNotices && config) {
      autoModeNotices.emitAutoModeEntryNotices({
        config,
        settings,
        addItem: context.ui.addItem
      });
    }
    return {
      type: "message",
      messageType: "info",
      content: t('Approval mode set to "{{mode}}"', {
        mode: formatApprovalModeName(mode)
      })
    };
  }, "action")
};

// packages/cli/src/ui/commands/authCommand.ts
init_esbuild_shims();
var authCommand = {
  name: "auth",
  altNames: ["connect", "login"],
  get description() {
    return t("Connect an LLM provider");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "non_interactive", "acp"],
  action: /* @__PURE__ */ __name((context, _args) => {
    const executionMode = context.executionMode ?? "interactive";
    if (executionMode !== "interactive") {
      return {
        type: "message",
        messageType: "info",
        content: t(
          "Authentication configuration is only available in interactive mode. To configure authentication, run Qwen Code interactively and use /auth, or set environment variables: OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL."
        )
      };
    }
    return {
      type: "dialog",
      dialog: "auth"
    };
  }, "action")
};

// packages/cli/src/ui/commands/branchCommand.ts
init_esbuild_shims();
var branchCommand = {
  name: "branch",
  kind: "built-in" /* BUILT_IN */,
  get description() {
    return t("Fork the current conversation into a new session");
  },
  action: /* @__PURE__ */ __name(async (context, args) => {
    const { config } = context.services;
    if (!config) {
      return {
        type: "message",
        messageType: "error",
        content: t("Config is not available.")
      };
    }
    if (context.ui.isIdleRef?.current === false) {
      return {
        type: "message",
        messageType: "error",
        content: t(
          "Cannot branch while a response or tool call is in progress. Wait for it to finish or resolve the pending tool call."
        )
      };
    }
    const sessionService = config.getSessionService();
    const currentId = config.getSessionId();
    const hasRecords = await sessionService.sessionExists(currentId);
    if (!hasRecords) {
      return {
        type: "message",
        messageType: "error",
        content: t("No conversation to branch.")
      };
    }
    const name = args.trim().replace(/[\r\n]+/g, " ");
    return name ? { type: "dialog", dialog: "branch", name } : { type: "dialog", dialog: "branch" };
  }, "action")
};

// packages/cli/src/ui/commands/peers-command.ts
init_esbuild_shims();
function shortId(msgId) {
  return msgId.replace(/-/g, "").slice(0, 6);
}
__name(shortId, "shortId");
function displayHandle(entry, held) {
  const own = canonicalizeMsgId(entry.frame.msgId);
  let length = Math.min(shortId(entry.frame.msgId).length, own.length);
  const collides = /* @__PURE__ */ __name((len) => held.some(
    (other) => other !== entry && canonicalizeMsgId(other.frame.msgId).startsWith(own.slice(0, len))
  ), "collides");
  while (length < own.length && collides(length)) {
    length += 1;
  }
  return own.slice(0, length);
}
__name(displayHandle, "displayHandle");
function preview(text, max = 100) {
  const oneLine = flattenPeerLabel(text).replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}\u2026` : oneLine;
}
__name(preview, "preview");
function describeRemaining(entry, expiryMs) {
  if (expiryMs === null) return "";
  const wallAge = Date.now() - entry.heldAt;
  const age = entry.monotonicAt === void 0 ? wallAge : Math.max(wallAge, performance.now() - entry.monotonicAt);
  const remaining = expiryMs - age;
  if (remaining <= 0) return ", expiring now";
  const minutes = Math.ceil(remaining / 6e4);
  return remaining < 6e4 ? ", less than a minute left" : `, ${minutes} minute${minutes === 1 ? "" : "s"} left`;
}
__name(describeRemaining, "describeRemaining");
function formatHeldList(held, expiryMs = null) {
  if (held.length === 0) return "No messages from other sessions are waiting.";
  const lines = held.map((entry) => {
    const peerLabel = entry.controller ? flattenPeerLabel(entry.controller.label) : flattenPeerLabel(
      entry.frame.fromName ?? entry.frame.from ?? (entry.selfSent ? "this session" : "unknown session")
    );
    const origin = entry.controller ? "[controller]" : entry.selfSent ? "[own process]" : "[peer]";
    const who = `${origin} ${peerLabel}`;
    const handle = flattenPeerLabel(displayHandle(entry, held));
    return `  ${handle}  ${who}
      ${preview(entry.frame.message.content)}
      held because ${describeHoldCause(entry.cause, entry.policyScope)}` + describeRemaining(entry, expiryMs);
  });
  return [
    `${held.length} message${held.length === 1 ? "" : "s"} waiting for your review:`,
    ...lines,
    "",
    "Release with /peers accept <id|all>, or drop with /peers deny <id|all>."
  ].join("\n");
}
__name(formatHeldList, "formatHeldList");
function resolveHeld(held, token) {
  const needle = token.toLowerCase();
  const exact = held.filter(
    (entry) => canonicalizeMsgId(entry.frame.msgId) === needle
  );
  if (exact.length === 1) return { kind: "one", msgId: exact[0].frame.msgId };
  const matches = held.filter(
    (entry) => canonicalizeMsgId(entry.frame.msgId).startsWith(needle) || entry.frame.msgId.toLowerCase().startsWith(needle)
  );
  if (matches.length === 0) return { kind: "none" };
  if (matches.length > 1) return { kind: "ambiguous" };
  return { kind: "one", msgId: matches[0].frame.msgId };
}
__name(resolveHeld, "resolveHeld");
async function listControllers() {
  try {
    return await listPeerControllers();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
__name(listControllers, "listControllers");
function formatControllerList(controllers) {
  if (!Array.isArray(controllers)) {
    return `Could not read the trusted controllers: ${controllers.error}`;
  }
  if (controllers.length === 0) {
    return `No trusted controllers. Without an explicit "accept" setting, a message that asserts no review class is held for your review, except one from a process this session started, which is always accepted. A sender's own review-class claim is not authenticated; set agents.crossSessionInbound to "hold" to review every inbound message.
Add one with: qwen sessions controllers add --label <name>`;
  }
  const lines = controllers.map(
    (record) => `  ${record.id}  ${flattenPeerLabel(record.label)}  added ${formatCreated(
      record.createdAt
    )}`
  );
  return [
    `${controllers.length} trusted controller${controllers.length === 1 ? "" : "s"}. Messages presenting one of these tokens are delivered without per-message review unless crossSessionInbound is "hold" or "refuse". A process this session started is always accepted; other senders' review-class claims are not authenticated, so set crossSessionInbound to "hold" to review every inbound message:`,
    ...lines,
    "",
    "Revoke with /peers revoke <id>."
  ].join("\n");
}
__name(formatControllerList, "formatControllerList");
function formatCreated(createdAt) {
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toISOString().replace("T", " ").slice(0, 16);
}
__name(formatCreated, "formatCreated");
var peersCommand = {
  name: "peers",
  kind: "built-in" /* BUILT_IN */,
  get description() {
    return t(
      "Review messages held from other Qwen Code sessions (accept | deny), and manage trusted controllers (controllers | revoke)"
    );
  },
  action: /* @__PURE__ */ __name(async (context, args) => {
    const [verb, ...rest] = args.trim().split(/\s+/).filter(Boolean);
    if (verb === "controllers") {
      return {
        type: "message",
        messageType: "info",
        content: formatControllerList(await listControllers())
      };
    }
    if (verb === "revoke") {
      const id = rest[0];
      if (id === void 0) {
        return {
          type: "message",
          messageType: "error",
          content: "Which controller? Use /peers revoke <id> \u2014 /peers controllers lists the ids."
        };
      }
      let removed;
      try {
        removed = await removePeerController(id);
      } catch (error) {
        return {
          type: "message",
          messageType: "error",
          content: `Could not revoke that controller: ${error instanceof Error ? error.message : String(error)}`
        };
      }
      if (!removed) {
        return {
          type: "message",
          messageType: "error",
          content: `No controller has the id "${flattenPeerLabel(id)}". Run /peers controllers to see them.`
        };
      }
      const forgotten = context.services.peerMessaging?.forgetController(removed.id) ?? 0;
      const backlog = forgotten === 0 ? "No held messages in this session used that grant." : `${forgotten} held message${forgotten === 1 ? "" : "s"} from it ${forgotten === 1 ? "remains" : "remain"} parked for review as ${forgotten === 1 ? "an ordinary peer message" : "ordinary peer messages"}.`;
      return {
        type: "message",
        messageType: "info",
        content: `Revoked the controller "${flattenPeerLabel(removed.label)}" (${removed.id}). Running sessions revalidate active connections, and new connections can no longer use its token. ${backlog}`
      };
    }
    const peerMessaging = context.services.peerMessaging;
    if (!peerMessaging) {
      const settings = context.services.settings;
      if (!isCrossSessionMessagingEnabled(settings?.merged)) {
        return {
          type: "message",
          messageType: "info",
          content: describeMessagingOff(
            settings ? crossSessionMessagingOffScope(settings) : void 0
          )
        };
      }
      const failure = getLastPeerInboxFailure();
      if (failure?.cause === "unsupported_platform") {
        return {
          type: "message",
          messageType: "info",
          content: "Cross-session messaging is not available on this platform, so this session has no inbox and other sessions cannot reach it."
        };
      }
      return {
        type: "message",
        messageType: "error",
        content: failure ? `Cross-session messaging is on, but this session has no inbox \u2014 it failed to bind its socket: ${describePeerInboxFailure(failure)}` : "Cross-session messaging is on, but this session has no inbox: it failed to register in the session registry, or the inbox is still starting. Re-run with DEBUG=1 to see the registration error."
      };
    }
    const held = peerMessaging.getHeld();
    if (verb === void 0 || verb === "list") {
      peerMessaging.recordHeldListing(held);
      return {
        type: "message",
        messageType: "info",
        content: formatHeldList(held, peerMessaging.getHeldExpiryMs())
      };
    }
    if (verb !== "accept" && verb !== "deny") {
      return {
        type: "message",
        messageType: "error",
        content: `Unknown subcommand "${verb}". Use /peers, /peers accept <id|all>, /peers deny <id|all>, /peers controllers, or /peers revoke <id>.`
      };
    }
    const decision = verb === "accept" ? "approve" : "deny";
    const target = rest[0];
    if (target === void 0) {
      return {
        type: "message",
        messageType: "error",
        content: `Which message? Use /peers ${verb} <id|all> \u2014 /peers lists the ids.`
      };
    }
    if (peerMessaging.heldSetChangedSinceListing()) {
      return {
        type: "message",
        messageType: "error",
        content: "The waiting list changed since you listed it \u2014 run /peers again to review what is waiting now."
      };
    }
    if (held.length === 0) {
      return {
        type: "message",
        messageType: "info",
        content: "No messages from other sessions are waiting."
      };
    }
    if (target.toLowerCase() === "all") {
      const ids = held.map((entry) => entry.frame.msgId);
      let count = 0;
      let failed = 0;
      let gone = 0;
      for (const msgId of ids) {
        const outcome2 = peerMessaging.decide(msgId, decision);
        if (outcome2 === "done") count += 1;
        else if (outcome2 === "failed") failed += 1;
        else if (outcome2 === "gone") gone += 1;
      }
      peerMessaging.recordHeldListing(peerMessaging.getHeld());
      return {
        type: "message",
        messageType: "info",
        content: `${verb === "accept" ? "Released" : "Dropped"} ${count} message${count === 1 ? "" : "s"}.` + (failed > 0 ? ` ${failed} could not be delivered and ${failed === 1 ? "is" : "are"} still waiting \u2014 try again once the session catches up.` : "") + (gone > 0 ? ` ${gone} had already expired or been decided \u2014 run /peers to see what is waiting now.` : "")
      };
    }
    const resolved = resolveHeld(held, target);
    if (resolved.kind === "none") {
      return {
        type: "message",
        messageType: "error",
        content: `No held message matches "${target}". Run /peers to see what is waiting.`
      };
    }
    if (resolved.kind === "ambiguous") {
      return {
        type: "message",
        messageType: "error",
        content: `"${target}" matches more than one held message. Use more characters of the id.`
      };
    }
    const outcome = peerMessaging.decide(resolved.msgId, decision);
    peerMessaging.recordHeldListing(peerMessaging.getHeld());
    if (outcome === "gone") {
      return {
        type: "message",
        messageType: "info",
        content: "That message is no longer waiting \u2014 it may have expired or already been decided."
      };
    }
    if (outcome === "failed") {
      return {
        type: "message",
        messageType: "error",
        content: "The session could not take the message just now \u2014 its input queue is full. It is still waiting; try again in a moment."
      };
    }
    return {
      type: "message",
      messageType: "info",
      content: verb === "accept" ? "Released to this session. It will be picked up on the next turn." : "Dropped. The sending session has been told."
    };
  }, "action")
};
function describeMessagingOff(scope) {
  switch (scope) {
    case "workspace":
      return `Cross-session messaging is off: this repository's .qwen/settings.json turns "agents.crossSessionMessaging" off. A workspace may only make that setting stricter, so your user settings cannot turn it back on here. Remove the entry from that file, then restart.`;
    case "system":
      return 'Cross-session messaging is off: system settings set "agents.crossSessionMessaging", and system settings override every other scope. Whoever manages them can remove the entry.';
    case "system-defaults":
      return 'Cross-session messaging is off: the system defaults turn "agents.crossSessionMessaging" off. Set it to true in your user settings, then restart.';
    case "user":
      return 'Cross-session messaging is off: your user settings turn "agents.crossSessionMessaging" off (only true, or leaving it unset, turns it on). Remove that entry, then restart.';
    default:
      return 'Cross-session messaging is off because of the "agents.crossSessionMessaging" setting (only true, or leaving it unset, turns it on). Remove that entry, then restart.';
  }
}
__name(describeMessagingOff, "describeMessagingOff");

// packages/cli/src/ui/commands/btwCommand.ts
init_esbuild_shims();
function formatBtwError(error) {
  return t("Failed to answer btw question: {{error}}", {
    error: error instanceof Error ? error.message : String(error || "Unknown error")
  });
}
__name(formatBtwError, "formatBtwError");
function getBtwCacheSafeParams(context) {
  const { config } = context.services;
  if (config) {
    return buildBtwCacheSafeParams(config);
  }
  return null;
}
__name(getBtwCacheSafeParams, "getBtwCacheSafeParams");
async function askBtw(context, question, abortSignal) {
  const { config } = context.services;
  if (!config) throw new Error("Config not loaded");
  const cacheSafeParams = getBtwCacheSafeParams(context);
  if (!cacheSafeParams)
    throw new Error(t("No conversation context available for /btw"));
  const result = await runForkedAgent({
    config,
    userMessage: buildBtwPrompt(question),
    cacheSafeParams,
    abortSignal
  });
  return result.text || t("No response received.");
}
__name(askBtw, "askBtw");
var btwCommand = {
  name: "btw",
  get description() {
    return t(
      "Ask a quick side question without affecting the main conversation"
    );
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "acp"],
  action: /* @__PURE__ */ __name(async (context, args) => {
    const question = args.trim();
    if (!question) {
      return {
        type: "message",
        messageType: "error",
        content: t("Please provide a question. Usage: /btw <your question>")
      };
    }
    if (question.length > BTW_MAX_INPUT_LENGTH) {
      return {
        type: "message",
        messageType: "error",
        content: t("Question too long (max {{max}} chars)", {
          max: String(BTW_MAX_INPUT_LENGTH)
        })
      };
    }
    const { config } = context.services;
    const { ui } = context;
    if (!config) {
      return {
        type: "message",
        messageType: "error",
        content: t("Config not loaded.")
      };
    }
    const model = config.getModel();
    if (!model) {
      return {
        type: "message",
        messageType: "error",
        content: t("No model configured.")
      };
    }
    const executionMode = context.executionMode ?? "interactive";
    if (executionMode !== "interactive") {
      try {
        const answer = await askBtw(
          context,
          question,
          context.abortSignal ?? new AbortController().signal
        );
        return { type: "message", messageType: "info", content: answer };
      } catch (error) {
        return {
          type: "message",
          messageType: "error",
          content: formatBtwError(error)
        };
      }
    }
    ui.cancelBtw();
    const btwAbortController = new AbortController();
    const btwSignal = btwAbortController.signal;
    ui.btwAbortControllerRef.current = btwAbortController;
    const pendingItem = {
      type: "btw" /* BTW */,
      btw: {
        question,
        answer: "",
        isPending: true
      }
    };
    ui.setBtwItem(pendingItem);
    void askBtw(context, question, btwSignal).then((answer) => {
      if (btwSignal.aborted) return;
      ui.btwAbortControllerRef.current = null;
      const completedItem = {
        type: "btw" /* BTW */,
        btw: {
          question,
          answer,
          isPending: false
        }
      };
      ui.setBtwItem(completedItem);
    }).catch((error) => {
      if (btwSignal.aborted) return;
      ui.btwAbortControllerRef.current = null;
      ui.setBtwItem(null);
      ui.addItem(
        {
          type: "error" /* ERROR */,
          text: formatBtwError(error)
        },
        Date.now()
      );
    });
  }, "action")
};

// packages/cli/src/ui/commands/bugCommand.ts
init_esbuild_shims();
var bugCommand = {
  name: "bug",
  get description() {
    return t("submit a bug report");
  },
  kind: "built-in" /* BUILT_IN */,
  argumentHint: "<description>",
  supportedModes: ["interactive", "non_interactive", "acp"],
  canRunDuringStreaming: true,
  action: /* @__PURE__ */ __name(async (context, args) => {
    const bugDescription = (args || "").trim();
    const systemInfo = await getExtendedSystemInfo(context);
    const fields = getSystemInfoFields(systemInfo);
    const info = fields.map((field) => `${field.label}: ${field.value}`).join("\n");
    let bugReportUrl = "https://github.com/QwenLM/qwen-code/issues/new?template=bug_report.yml&title={title}&info={info}";
    const bugCommandSettings = context.services.config?.getBugCommand();
    if (bugCommandSettings?.urlTemplate) {
      bugReportUrl = bugCommandSettings.urlTemplate;
    }
    bugReportUrl = bugReportUrl.replace("{title}", encodeURIComponent(bugDescription)).replace("{info}", encodeURIComponent(`
${info}
`));
    const bugReportItem = {
      type: "info" /* INFO */,
      text: "To submit your bug report, please open the following URL in your browser:",
      linkUrl: bugReportUrl,
      linkText: "Open GitHub bug report form"
    };
    context.ui.addItem(bugReportItem, Date.now());
    try {
      await openBrowserSecurely(bugReportUrl);
    } catch (error) {
      const errorMessage2 = error instanceof Error ? error.message : String(error);
      context.ui.addItem(
        {
          type: "error" /* ERROR */,
          text: `Could not open URL in browser: ${errorMessage2}`
        },
        Date.now()
      );
    }
  }, "action")
};

// packages/cli/src/ui/commands/cdCommand.ts
init_esbuild_shims();
import * as fs3 from "node:fs/promises";
import * as path3 from "node:path";

// packages/cli/src/ui/commands/directoryCommand.tsx
init_esbuild_shims();
import * as fs2 from "node:fs";
import * as path2 from "node:path";
function findExistingWorkspaceDirectory(directory, existingDirectories) {
  if (existingDirectories.has(directory)) {
    return directory;
  }
  try {
    const absolutePath = path2.isAbsolute(directory) ? directory : path2.resolve(directory);
    const resolvedDirectory = fs2.realpathSync(absolutePath);
    if (existingDirectories.has(resolvedDirectory)) {
      return resolvedDirectory;
    }
  } catch {
  }
  return void 0;
}
__name(findExistingWorkspaceDirectory, "findExistingWorkspaceDirectory");
function getDirPathCompletions(partialArg) {
  const lastComma = partialArg.lastIndexOf(",");
  const prefix = lastComma >= 0 ? partialArg.substring(0, lastComma + 1) : "";
  const partial = lastComma >= 0 ? partialArg.substring(lastComma + 1).trimStart() : partialArg;
  return getPathCompletions(prefix, partial);
}
__name(getDirPathCompletions, "getDirPathCompletions");
function getSingleDirPathCompletions(partialArg) {
  return getPathCompletions("", partialArg);
}
__name(getSingleDirPathCompletions, "getSingleDirPathCompletions");
function getPathCompletions(prefix, partial) {
  const trimmed = partial.trim();
  if (!trimmed) return [];
  const inputEndsWithSep = trimmed.endsWith("/") || trimmed.endsWith("\\");
  const expanded = expandHomeDir(trimmed);
  const endsWithSep = inputEndsWithSep || expanded.endsWith("/") || expanded.endsWith(path2.sep);
  const searchDir = endsWithSep ? expanded : path2.dirname(expanded);
  const namePrefix = endsWithSep ? "" : path2.basename(expanded);
  try {
    const children = fs2.readdirSync(searchDir, { withFileTypes: true }).filter(
      (e) => e.isDirectory() && e.name.startsWith(namePrefix) && !e.name.startsWith(".")
    ).map((e) => ({
      value: prefix + path2.join(searchDir, e.name) + path2.sep,
      isDirectory: true
    }));
    if (endsWithSep) {
      const selfPath = prefix + searchDir;
      const normalizedSelf = selfPath.endsWith(path2.sep) ? selfPath : selfPath + path2.sep;
      if (!children.some((c) => c.value === normalizedSelf)) {
        children.unshift({ value: normalizedSelf, isDirectory: true });
      }
    }
    return children.slice(0, 8);
  } catch {
    return [];
  }
}
__name(getPathCompletions, "getPathCompletions");
var directoryCommand = {
  name: "directory",
  altNames: ["dir"],
  get description() {
    return t("Manage workspace directories");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "acp"],
  action: /* @__PURE__ */ __name(async () => ({
    type: "message",
    messageType: "info",
    content: t("Usage: /directory add <path>[,<path>,...] or /directory show")
  }), "action"),
  subCommands: [
    {
      name: "add",
      get description() {
        return t(
          "Add directories to the workspace. Use comma to separate multiple paths"
        );
      },
      kind: "built-in" /* BUILT_IN */,
      supportedModes: ["interactive", "acp"],
      argumentHint: "<path>[,<path>,...]",
      completion: /* @__PURE__ */ __name(async (_context, partialArg) => getDirPathCompletions(partialArg), "completion"),
      action: /* @__PURE__ */ __name(async (context, args) => {
        const { config, settings } = context.services;
        if (!config) {
          return {
            type: "message",
            messageType: "error",
            content: t("Configuration is not available.")
          };
        }
        const workspaceContext = config.getWorkspaceContext();
        const pathsToAdd = args.split(",").filter((p) => p.trim());
        if (pathsToAdd.length === 0) {
          return {
            type: "message",
            messageType: "error",
            content: t("Please provide at least one path to add.")
          };
        }
        if (config.isRestrictiveSandbox()) {
          return {
            type: "message",
            messageType: "error",
            content: t(
              "The /directory add command is not supported in restrictive sandbox profiles. Please use --include-directories when starting the session instead."
            )
          };
        }
        try {
          const added = [];
          const alreadyAdded = [];
          const errors = [];
          const messages = [];
          for (const pathToAdd of pathsToAdd) {
            const directory = expandHomeDir(pathToAdd.trim());
            const directoriesBeforeAdd = new Set(
              workspaceContext.getDirectories()
            );
            try {
              workspaceContext.addDirectory(directory);
              const acceptedDirectories = workspaceContext.getDirectories().filter((dir) => !directoriesBeforeAdd.has(dir));
              if (acceptedDirectories.length > 0) {
                added.push(...acceptedDirectories);
              } else {
                const existingDirectory = findExistingWorkspaceDirectory(
                  directory,
                  directoriesBeforeAdd
                );
                if (existingDirectory) {
                  alreadyAdded.push(existingDirectory);
                }
              }
            } catch (e) {
              const error = e;
              errors.push(
                t("Error adding '{{path}}': {{error}}", {
                  path: pathToAdd.trim(),
                  error: error.message
                })
              );
            }
          }
          if (added.length > 0) {
            try {
              const existingIncludeDirectories = settings.workspace.originalSettings.context?.includeDirectories ?? [];
              const includeDirectories = Array.from(
                /* @__PURE__ */ new Set([...existingIncludeDirectories, ...added])
              );
              settings.setValue(
                "Workspace" /* Workspace */,
                "context.includeDirectories",
                includeDirectories
              );
            } catch (error) {
              errors.push(
                t("Error saving directories to workspace settings: {{error}}", {
                  error: error.message
                })
              );
            }
          }
          if (added.length > 0) {
            try {
              if (config.isSafeMode()) {
                messages.push(
                  t(
                    "Safe mode active \u2014 skipping memory reload from include directories."
                  )
                );
              } else if (config.shouldLoadMemoryFromIncludeDirectories()) {
                const {
                  memoryContent,
                  fileCount,
                  contextFilePaths,
                  conditionalRules,
                  projectRoot
                } = await loadServerHierarchicalMemory(
                  config.getWorkingDir(),
                  [...config.getWorkspaceContext().getDirectories(), ...added],
                  config.getFileService(),
                  config.getExtensionContextFilePaths(),
                  config.getFolderTrust(),
                  context.services.settings.merged.context?.importFormat || "tree",
                  config.getContextRuleExcludes()
                );
                config.setUserMemory(memoryContent);
                config.setMemoryFileCount(fileCount);
                config.setContextFilePaths(contextFilePaths);
                config.setConditionalRulesRegistry(
                  new ConditionalRulesRegistry(conditionalRules, projectRoot)
                );
                context.ui.setMemoryFileCount(fileCount);
                messages.push(
                  t(
                    "Successfully added QWEN.md files from the following directories if there are:\n- {{directories}}",
                    { directories: added.join("\n- ") }
                  )
                );
              }
            } catch (error) {
              errors.push(
                t("Error refreshing memory: {{error}}", {
                  error: error.message
                })
              );
            }
          }
          if (added.length > 0) {
            const gemini = config.getLlmClient();
            if (gemini) {
              try {
                await gemini.addDirectoryContext();
              } catch (error) {
                errors.push(
                  t("Error notifying model of new directories: {{error}}", {
                    error: error.message
                  })
                );
              }
            }
            messages.push(
              t("Successfully added directories:\n- {{directories}}", {
                directories: added.join("\n- ")
              })
            );
          }
          if (alreadyAdded.length > 0) {
            const directories = Array.from(new Set(alreadyAdded));
            messages.push(
              t("Directories already in workspace:\n- {{directories}}", {
                directories: directories.join("\n- ")
              })
            );
          }
          if (errors.length > 0) {
            return {
              type: "message",
              messageType: added.length > 0 ? "warning" : "error",
              content: [...messages, ...errors].join("\n")
            };
          }
          return {
            type: "message",
            messageType: "info",
            content: messages.join("\n") || t("No directories added.")
          };
        } catch (error) {
          return {
            type: "message",
            messageType: "error",
            content: t("Failed to process /directory add: {{message}}", {
              message: error instanceof Error ? error.message : String(error)
            })
          };
        }
      }, "action")
    },
    {
      name: "show",
      get description() {
        return t("Show all directories in the workspace");
      },
      kind: "built-in" /* BUILT_IN */,
      supportedModes: ["interactive", "acp"],
      action: /* @__PURE__ */ __name(async (context) => {
        const { config } = context.services;
        if (!config) {
          return {
            type: "message",
            messageType: "error",
            content: t("Configuration is not available.")
          };
        }
        const directories = config.getWorkspaceContext().getDirectories();
        const directoryList = directories.map((dir) => `- ${dir}`).join("\n");
        return {
          type: "message",
          messageType: "info",
          content: t("Current workspace directories:\n{{directories}}", {
            directories: directoryList
          })
        };
      }, "action")
    }
  ]
};

// packages/cli/src/ui/commands/cdCommand.ts
var MAX_PENDING_TRUST_CONFIRMATIONS = 50;
var pendingTrustedPathConfirmations = /* @__PURE__ */ new Map();
function parsePathArgument(input) {
  const trimmed = input.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') || trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed.replace(/\\([\\\s'"])/g, "$1");
}
__name(parsePathArgument, "parsePathArgument");
function resolveCdPath(input, baseDir) {
  if (input.includes("\0") || baseDir.includes("\0")) {
    throw new Error("Path contains null bytes.");
  }
  return path3.normalize(resolvePath(baseDir, input));
}
__name(resolveCdPath, "resolveCdPath");
var cdCommand = {
  name: "cd",
  get description() {
    return t("Move this session to a new working directory");
  },
  kind: "built-in" /* BUILT_IN */,
  argumentHint: "<path>",
  supportedModes: ["interactive"],
  completion: /* @__PURE__ */ __name(async (_context, partialArg) => getSingleDirPathCompletions(partialArg), "completion"),
  action: /* @__PURE__ */ __name(async (context, args) => {
    const targetArg = parsePathArgument(args);
    if (!targetArg) {
      return {
        type: "message",
        messageType: "info",
        content: "Usage: /cd <path>"
      };
    }
    const { config } = context.services;
    if (!config) {
      return {
        type: "message",
        messageType: "error",
        content: "Configuration is not available."
      };
    }
    if (context.ui.isIdleRef.current === false) {
      return {
        type: "message",
        messageType: "error",
        content: "Cannot change directory while a response or tool call is in progress."
      };
    }
    if (config.isRestrictiveSandbox()) {
      return {
        type: "message",
        messageType: "error",
        content: "The /cd command is not supported in restrictive sandbox profiles. Start a new session in the target directory instead."
      };
    }
    const oldDir = config.getTargetDir();
    let targetPath;
    try {
      targetPath = resolveCdPath(targetArg, oldDir);
    } catch (error) {
      return {
        type: "message",
        messageType: "error",
        content: error instanceof Error ? error.message : String(error)
      };
    }
    let stats;
    try {
      stats = await fs3.stat(targetPath);
    } catch {
      return {
        type: "message",
        messageType: "error",
        content: `Couldn't find a directory at ${targetPath}.`
      };
    }
    if (!stats.isDirectory()) {
      return {
        type: "message",
        messageType: "error",
        content: `${targetPath} is not a directory.`
      };
    }
    const [realOldDir, realTargetPath] = await Promise.all([
      fs3.realpath(oldDir).catch(() => oldDir),
      fs3.realpath(targetPath).catch(() => targetPath)
    ]);
    if (realTargetPath === realOldDir) {
      return {
        type: "message",
        messageType: "info",
        content: `Already in ${realTargetPath}.`
      };
    }
    let trustedTargetPath;
    if (isFolderTrustEnabled(context.services.settings.merged)) {
      const trustedFolders = loadTrustedFolders();
      if (trustedFolders.isPathTrusted(realTargetPath) !== true) {
        const rawInvocation = context.invocation?.raw || `/cd ${targetArg}`;
        const confirmedPath = pendingTrustedPathConfirmations.get(rawInvocation);
        if (context.overwriteConfirmed && confirmedPath && confirmedPath === realTargetPath) {
          pendingTrustedPathConfirmations.delete(rawInvocation);
          trustedTargetPath = realTargetPath;
        } else {
          if (!pendingTrustedPathConfirmations.has(rawInvocation) && pendingTrustedPathConfirmations.size >= MAX_PENDING_TRUST_CONFIRMATIONS) {
            pendingTrustedPathConfirmations.clear();
          }
          pendingTrustedPathConfirmations.set(rawInvocation, realTargetPath);
          return {
            type: "confirm_action",
            prompt: `Move this session to ${realTargetPath}? Qwen Code will be able to read, edit, and execute files there. This folder will be trusted for future sessions.`,
            originalInvocation: {
              raw: rawInvocation
            }
          };
        }
      }
    }
    const warnings = [];
    try {
      const relocation = await config.relocateWorkingDirectory(
        realTargetPath,
        realTargetPath
      );
      if (relocation.memoryRefreshError) {
        warnings.push(
          `Memory refresh failed: ${relocation.memoryRefreshError instanceof Error ? relocation.memoryRefreshError.message : String(relocation.memoryRefreshError)}`
        );
      }
      if (relocation.mcpRefreshError) {
        warnings.push(
          `MCP refresh failed: ${relocation.mcpRefreshError instanceof Error ? relocation.mcpRefreshError.message : String(relocation.mcpRefreshError)}`
        );
      }
    } catch (error) {
      return {
        type: "message",
        messageType: "error",
        content: `Couldn't move to ${realTargetPath}: ${error instanceof Error ? error.message : String(error)}`
      };
    }
    if (trustedTargetPath) {
      try {
        loadTrustedFolders().setValue(
          trustedTargetPath,
          "TRUST_FOLDER" /* TRUST_FOLDER */
        );
      } catch (error) {
        warnings.push(
          `Trust setting update failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    try {
      await config.getLlmClient()?.addWorkingDirectoryChangedContext(realOldDir, realTargetPath);
    } catch (error) {
      warnings.push(
        `Model context refresh failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return {
      type: "message",
      messageType: warnings.length > 0 ? "warning" : "info",
      content: warnings.length > 0 ? `Moved to ${realTargetPath}. ${warnings.join(" ")}` : `Moved to ${realTargetPath}.`
    };
  }, "action")
};

// packages/cli/src/ui/commands/clearCommand.ts
init_esbuild_shims();

// packages/cli/src/ui/utils/backgroundWorkUtils.ts
init_esbuild_shims();
function hasBlockingBackgroundWork(config) {
  return (
    // hasRunningTasks, not hasUnfinalizedTasks: a cancelled task whose
    // finalize callback hasn't fired yet must not block /clear or
    // session resume — both abort-and-reset the registry right after
    // this gate, suppressing the pending notification anyway. Gating on
    // the unfinalized set made /new silently no-op when typed in the
    // window between cancel and finalize (issue #5949).
    config.getBackgroundTaskRegistry().hasRunningTasks() || config.getMonitorRegistry().getRunning().length > 0 || config.getBackgroundShellRegistry().hasRunningEntries() || // R7 (wenshao): the WorkflowRunRegistry is a 4th sibling that the
    // earlier P4b commit forgot to wire here. Without this OR clause,
    // /clear and session-resume happily ran while a workflow was
    // mid-run, orphaning the dispatch loop.
    config.getWorkflowRunRegistry().hasRunningEntries()
  );
}
__name(hasBlockingBackgroundWork, "hasBlockingBackgroundWork");
function resetBackgroundStateForSessionSwitch(config) {
  config.getBackgroundTaskRegistry().reset();
  config.getMonitorRegistry().reset();
  config.getBackgroundShellRegistry().reset();
  config.getWorkflowRunRegistry().abortAll();
  config.getWorkflowRunRegistry().reset();
}
__name(resetBackgroundStateForSessionSwitch, "resetBackgroundStateForSessionSwitch");
var MAX_LISTED_BLOCKING_ENTRIES = 10;
var MAX_BLOCKING_LABEL_WIDTH = 80;
function describeBlockingBackgroundWork(config) {
  const now = Date.now();
  const entries = [];
  for (const entry of config.getBackgroundTaskRegistry().getAll()) {
    if (!entry.isBackgrounded || entry.status !== "running") continue;
    entries.push({
      startTime: entry.startTime,
      id: entry.agentId,
      label: buildBackgroundEntryLabel(entry),
      status: entry.status,
      isWorkflowRun: false
    });
  }
  for (const entry of config.getMonitorRegistry().getRunning()) {
    entries.push({
      startTime: entry.startTime,
      id: entry.monitorId,
      label: entry.description,
      status: entry.status,
      isWorkflowRun: false
    });
  }
  for (const entry of config.getBackgroundShellRegistry().getAll()) {
    if (entry.status !== "running") continue;
    entries.push({
      startTime: entry.startTime,
      id: entry.shellId,
      label: entry.command,
      status: entry.status,
      isWorkflowRun: false
    });
  }
  for (const entry of config.getWorkflowRunRegistry().list()) {
    if (entry.status !== "running" && entry.status !== "pausing") continue;
    entries.push({
      startTime: entry.startTime,
      id: entry.runId,
      label: entry.meta?.name ?? entry.runId,
      status: entry.status,
      isWorkflowRun: true
    });
  }
  for (const runId of config.getWorkflowRunRegistry().listStartingRunIds()) {
    entries.push({
      startTime: now,
      id: runId,
      label: runId,
      status: "starting",
      isWorkflowRun: true,
      isStarting: true
    });
  }
  if (entries.length === 0) return void 0;
  entries.sort((a, b) => a.startTime - b.startTime);
  const listed = entries.slice(0, MAX_LISTED_BLOCKING_ENTRIES);
  const lines = listed.map((entry) => {
    const label = truncateToWidth(
      stripUnsafeCharacters(entry.label).replace(/[\r\n]+/g, " "),
      MAX_BLOCKING_LABEL_WIDTH
    );
    if (entry.isStarting) return `  [${entry.id}] (starting)`;
    return `  [${entry.id}] ${label} (${entry.status} ${formatDuration(
      now - entry.startTime,
      { hideTrailingZeros: true }
    )})`;
  });
  const overflow = entries.length - listed.length;
  if (overflow > 0) {
    lines.push(`  \u2026and ${overflow} more`);
  }
  return {
    lines,
    hasTaskEntries: entries.some((entry) => !entry.isWorkflowRun),
    hasInspectableWorkflowRuns: entries.some(
      (entry) => entry.isWorkflowRun && !entry.isStarting
    ),
    hasStartingWorkflowRuns: entries.some((entry) => entry.isStarting)
  };
}
__name(describeBlockingBackgroundWork, "describeBlockingBackgroundWork");
function buildBackgroundWorkBlockedMessage(config, baseMessage) {
  const blocking = describeBlockingBackgroundWork(config);
  if (!blocking) return baseMessage;
  const surfaces = [
    ...blocking.hasTaskEntries ? ["/tasks"] : [],
    ...blocking.hasInspectableWorkflowRuns ? ["/workflows"] : []
  ].join(" and ");
  return [
    baseMessage,
    ...blocking.lines,
    ...surfaces ? [`Use ${surfaces} to inspect them, then retry.`] : [],
    ...blocking.hasStartingWorkflowRuns ? ["Retry once the run has finished starting."] : []
  ].join("\n");
}
__name(buildBackgroundWorkBlockedMessage, "buildBackgroundWorkBlockedMessage");

// packages/cli/src/ui/commands/clearCommand.ts
import process2 from "node:process";
var debugLogger6 = createDebugLogger("CLEAR_COMMAND");
var clearCommand = {
  name: "clear",
  altNames: ["reset", "new"],
  get description() {
    return t("Clear conversation history and free up context");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "non_interactive", "acp"],
  action: /* @__PURE__ */ __name(async (context, _args) => {
    const { config } = context.services;
    const memBefore = process2.memoryUsage();
    if (debugLogger6.isEnabled()) {
      debugLogger6.debug(
        `[CLEAR_START] Starting clear command, heapUsed=${(memBefore.heapUsed / 1024 / 1024).toFixed(1)}MB, rss=${(memBefore.rss / 1024 / 1024).toFixed(1)}MB`
      );
    }
    if (config) {
      if (hasBlockingBackgroundWork(config)) {
        const baseMessage = "Stop the current session's running background tasks before starting a new session.";
        context.ui.setDebugMessage(baseMessage);
        return {
          type: "message",
          messageType: "error",
          content: buildBackgroundWorkBlockedMessage(config, baseMessage)
        };
      }
      config.getHookSystem()?.fireSessionEndEvent("clear" /* Clear */).catch((err) => {
        config.getDebugLogger().warn(`SessionEnd hook failed: ${err}`);
      });
      config.getBackgroundTaskRegistry().abortAll({ notify: false });
      config.getMonitorRegistry().abortAll({ notify: false });
      config.getBackgroundShellRegistry().abortAll();
      resetBackgroundStateForSessionSwitch(config);
      const metrics = uiTelemetryService.getMetrics();
      const hasActivity = Object.values(metrics.models).some(
        (m) => m.api.totalRequests > 0
      );
      if (hasActivity) {
        try {
          persistSessionUsage({
            sessionId: config.getSessionId(),
            startTime: context.session.stats.sessionStartTime ?? /* @__PURE__ */ new Date(),
            endTime: /* @__PURE__ */ new Date(),
            project: config.getProjectRoot(),
            metrics
          });
        } catch {
        }
      }
      const newSessionId = config.startNewSession();
      uiTelemetryService.reset();
      const skillTool = config.getToolRegistry()?.getAllTools().find((tool) => tool.name === ToolNames.SKILL);
      if (skillTool && "clearLoadedSkills" in skillTool) {
        skillTool.clearLoadedSkills();
      }
      if (newSessionId && context.session.startNewSession) {
        context.session.startNewSession(newSessionId);
      }
      context.ui.clear();
      const llmClient = config.getLlmClient();
      if (llmClient) {
        context.ui.setDebugMessage(
          t("Starting a new session, resetting chat, and clearing terminal.")
        );
        await llmClient.resetChat();
      } else {
        context.ui.setDebugMessage(t("Starting a new session and clearing."));
      }
    } else {
      context.ui.setDebugMessage(t("Starting a new session and clearing."));
      context.ui.clear();
    }
    const memAfter = process2.memoryUsage();
    if (debugLogger6.isEnabled()) {
      const heapDiff = (memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024;
      const rssDiff = (memAfter.rss - memBefore.rss) / 1024 / 1024;
      debugLogger6.debug(
        `[CLEAR_END] Clear command completed, heapUsed=${(memAfter.heapUsed / 1024 / 1024).toFixed(1)}MB, rss=${(memAfter.rss / 1024 / 1024).toFixed(1)}MB, heapDiff=${heapDiff.toFixed(1)}MB, rssDiff=${rssDiff.toFixed(1)}MB`
      );
    }
    if (context.executionMode !== "interactive") {
      return {
        type: "message",
        messageType: "info",
        content: "Context cleared. Previous messages are no longer in context."
      };
    }
    return;
  }, "action")
};

// packages/cli/src/ui/commands/config-command.ts
init_esbuild_shims();
var SETTABLE_TYPES = /* @__PURE__ */ new Set(["boolean", "string", "number", "enum"]);
var SENSITIVE_KEY_PATTERNS = [
  /apikey/i,
  /api[_-]?key/i,
  /secret/i,
  /(?:^|\.)token(?:$|\.)/i,
  /password/i,
  /credential/i,
  /private[_-]?key/i
];
var SENSITIVE_URL_PATTERNS = [/baseurl/i, /base_url/i, /proxy/i];
function isSensitiveKey(key) {
  return SENSITIVE_KEY_PATTERNS.some((p) => p.test(key)) || SENSITIVE_URL_PATTERNS.some((p) => p.test(key));
}
__name(isSensitiveKey, "isSensitiveKey");
function maskValue(value) {
  if (value === void 0) return t("(not set)");
  if (typeof value === "string") {
    if (!value) return t("(empty)");
    if (value.length <= 4) return "****";
    return `${value.slice(0, 4)}****`;
  }
  return "****";
}
__name(maskValue, "maskValue");
function findClosestKey(input) {
  const allKeys = getAllSettingKeys();
  let bestMatch;
  let bestDistance = Infinity;
  for (const key of allKeys) {
    const def = getSettingDefinition(key);
    if (!def || !SETTABLE_TYPES.has(def.type)) continue;
    const distance = levenshteinDistance(
      input.toLowerCase(),
      key.toLowerCase()
    );
    if (distance < bestDistance && distance <= 3) {
      bestDistance = distance;
      bestMatch = key;
    }
  }
  return bestMatch;
}
__name(findClosestKey, "findClosestKey");
function levenshteinDistance(a, b) {
  const matrix = [];
  for (let i = 0; i <= a.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= b.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[a.length][b.length];
}
__name(levenshteinDistance, "levenshteinDistance");
function coerceValue(def, rawValue) {
  switch (def.type) {
    case "boolean": {
      const normalised = rawValue?.toLowerCase().trim();
      if (normalised === "true" || normalised === "1") return { value: true };
      if (normalised === "false" || normalised === "0") return { value: false };
      return {
        value: void 0,
        error: t('Invalid boolean value: "{{value}}". Use "true" or "false".', {
          value: String(rawValue)
        })
      };
    }
    case "number":
    case "integer": {
      if (!rawValue || rawValue.trim() === "") {
        return {
          value: void 0,
          error: t('Invalid {{type}} value: "{{value}}".', {
            type: def.type,
            value: String(rawValue)
          })
        };
      }
      const parsed = Number(rawValue);
      if (Number.isNaN(parsed) || !Number.isFinite(parsed)) {
        return {
          value: void 0,
          error: t('Invalid {{type}} value: "{{value}}".', {
            type: def.type,
            value: String(rawValue)
          })
        };
      }
      const validationError = validateSettingValue(def, parsed);
      if (validationError) {
        return { value: void 0, error: validationError };
      }
      return { value: parsed };
    }
    case "string": {
      const strValue = rawValue ?? "";
      const validationError = validateSettingValue(def, strValue);
      if (validationError) {
        return { value: void 0, error: validationError };
      }
      return { value: strValue };
    }
    case "enum": {
      const validValues = def.options?.map((o) => o.value) ?? [];
      if (!validValues.includes(rawValue)) {
        return {
          value: void 0,
          error: t(
            'Invalid enum value: "{{value}}". Valid values: {{options}}.',
            { value: String(rawValue), options: validValues.join(", ") }
          )
        };
      }
      return { value: rawValue };
    }
    case "array":
    case "object":
      return {
        value: void 0,
        error: t(
          'Setting "{{type}}" type cannot be set via /config. Edit settings.json directly.',
          { type: def.type }
        )
      };
    default:
      return {
        value: void 0,
        error: t('Unsupported setting type: "{{type}}".', {
          type: String(def.type)
        })
      };
  }
}
__name(coerceValue, "coerceValue");
function formatValue(value) {
  if (value === void 0) return t("(not set)");
  if (typeof value === "string") return value || t("(empty)");
  return JSON.stringify(value);
}
__name(formatValue, "formatValue");
function padRight(str, len) {
  if (str.length > len) return str.slice(0, len - 3) + "... ";
  if (str.length === len) return str + " ";
  return str + " ".repeat(len - str.length);
}
__name(padRight, "padRight");
function listAllSettings(context) {
  const flattened = getFlattenedSchema();
  const merged = context.services.settings.merged;
  const lines = [];
  lines.push(t("Available settings:"));
  lines.push("");
  lines.push(
    padRight("Key", 40) + padRight("Type", 10) + padRight("Current", 15) + "Description"
  );
  lines.push("-".repeat(90));
  const keys = Object.keys(flattened).sort();
  for (const key of keys) {
    const def = flattened[key];
    if (!SETTABLE_TYPES.has(def.type)) continue;
    const current = getNestedProperty(merged, key);
    let displayCurrent;
    if (isSensitiveKey(key)) {
      displayCurrent = maskValue(current ?? def.default);
    } else {
      displayCurrent = current !== void 0 ? formatValue(current) : formatValue(def.default);
    }
    lines.push(
      padRight(key, 40) + padRight(def.type, 10) + padRight(displayCurrent, 15) + (def.description ?? def.label)
    );
  }
  return {
    type: "message",
    messageType: "info",
    content: lines.join("\n")
  };
}
__name(listAllSettings, "listAllSettings");
var configCommand = {
  name: "config",
  get description() {
    return t("Get or set any setting by dot-path key");
  },
  argumentHint: "<key>[=<value>] or --help",
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "non_interactive", "acp"],
  action: /* @__PURE__ */ __name(async (context, args) => {
    const trimmed = args.trim();
    if (!trimmed || trimmed === "--help" || trimmed === "-h") {
      return listAllSettings(context);
    }
    const eqIndex = trimmed.indexOf("=");
    const isToggle = eqIndex === -1;
    const key = isToggle ? trimmed : trimmed.slice(0, eqIndex).trim();
    const rawValue = isToggle ? void 0 : trimmed.slice(eqIndex + 1).trim();
    const def = getSettingDefinition(key);
    if (!def) {
      const suggestion = findClosestKey(key);
      return {
        type: "message",
        messageType: "error",
        content: suggestion ? t(
          'Unknown setting key: "{{key}}". Did you mean "{{suggestion}}"?',
          { key, suggestion }
        ) : t('Unknown setting key: "{{key}}".', { key })
      };
    }
    const currentValue = getNestedProperty(
      context.services.settings.merged,
      key
    );
    if (isToggle && def.type !== "boolean") {
      const display = isSensitiveKey(key) ? maskValue(currentValue) : formatValue(currentValue);
      return {
        type: "message",
        messageType: "info",
        content: `${key} = ${display}`
      };
    }
    if (isToggle && def.type === "boolean") {
      const newValue = nextBooleanSettingValue(
        currentValue,
        getDefaultValue(key)
      );
      try {
        context.services.settings.setValues([
          { scope: "User" /* User */, key, value: newValue }
        ]);
      } catch (error) {
        return {
          type: "message",
          messageType: "error",
          content: t('Failed to set "{{key}}": {{error}}', {
            key,
            error: error instanceof Error ? error.message : String(error)
          })
        };
      }
      let message3 = t("Set {{key}} = {{value}}", {
        key,
        value: String(newValue)
      });
      if (def.requiresRestart) {
        message3 += "\n" + t("(This setting requires a restart to take effect.)");
      }
      return {
        type: "message",
        messageType: "info",
        content: message3
      };
    }
    const result = coerceValue(def, rawValue);
    if (result.error) {
      return {
        type: "message",
        messageType: "error",
        content: result.error
      };
    }
    if (key === "tools.approvalMode" && result.value === "yolo") {
      return {
        type: "message",
        messageType: "error",
        content: t(
          'Setting tools.approvalMode to "yolo" is blocked via /config for security reasons. Edit settings.json directly if you understand the risks.'
        )
      };
    }
    try {
      context.services.settings.setValues([
        { scope: "User" /* User */, key, value: result.value }
      ]);
    } catch (error) {
      return {
        type: "message",
        messageType: "error",
        content: t('Failed to set "{{key}}": {{error}}', {
          key,
          error: error instanceof Error ? error.message : String(error)
        })
      };
    }
    const displayValue = isSensitiveKey(key) ? maskValue(result.value) : formatValue(result.value);
    let message2 = t("Set {{key}} = {{value}}", {
      key,
      value: displayValue
    });
    if (def.requiresRestart) {
      message2 += "\n" + t("(This setting requires a restart to take effect.)");
    }
    if (isSensitiveKey(key)) {
      message2 += "\n" + t(
        "(Security-sensitive setting \u2014 verify you are not exposing credentials.)"
      );
    }
    return {
      type: "message",
      messageType: "info",
      content: message2
    };
  }, "action"),
  completion: /* @__PURE__ */ __name(async (_context, partialArg) => {
    const current = partialArg.trimStart();
    if (current.includes("=")) return null;
    const allKeys = getAllSettingKeys();
    return allKeys.filter((k) => {
      if (!k.startsWith(current)) return false;
      const def = getSettingDefinition(k);
      return def && SETTABLE_TYPES.has(def.type);
    }).map((k) => {
      const def = getSettingDefinition(k);
      return {
        value: k,
        description: def?.description ?? ""
      };
    });
  }, "completion")
};

// packages/cli/src/ui/commands/deleteCommand.ts
init_esbuild_shims();
var deleteCommand = {
  name: "delete",
  kind: "built-in" /* BUILT_IN */,
  get description() {
    return t("Delete a previous session");
  },
  action: /* @__PURE__ */ __name(async () => ({
    type: "dialog",
    dialog: "delete"
  }), "action")
};

// packages/cli/src/ui/commands/compressCommand.ts
init_esbuild_shims();
var MAX_COMPRESS_INSTRUCTIONS_CHARS = 2e3;
var compressCommand = {
  name: "compress",
  altNames: ["summarize"],
  get description() {
    return t("Compresses the context by replacing it with a summary.");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "non_interactive", "acp"],
  action: /* @__PURE__ */ __name(async (context) => {
    const { ui } = context;
    const executionMode = context.executionMode ?? "interactive";
    const abortSignal = context.abortSignal;
    if (executionMode === "interactive" && ui.pendingItem) {
      ui.addItem(
        {
          type: "error" /* ERROR */,
          text: t("Already compressing, wait for previous request to complete")
        },
        Date.now()
      );
      return;
    }
    const pendingMessage = {
      type: "compression" /* COMPRESSION */,
      compression: {
        isPending: true,
        originalTokenCount: null,
        newTokenCount: null,
        compressionStatus: null
      }
    };
    const config = context.services.config;
    const llmClient = config?.getLlmClient();
    if (!config || !llmClient) {
      return {
        type: "message",
        messageType: "error",
        content: t("Config not loaded.")
      };
    }
    const rawArgs = context.invocation?.args?.trim() ?? "";
    const wasTruncated = rawArgs.length > MAX_COMPRESS_INSTRUCTIONS_CHARS;
    const customInstructions = rawArgs ? rawArgs.slice(0, MAX_COMPRESS_INSTRUCTIONS_CHARS) : void 0;
    const truncationNotice = wasTruncated ? t("Compression instructions were truncated to {{max}} characters.", {
      max: String(MAX_COMPRESS_INSTRUCTIONS_CHARS)
    }) : void 0;
    const doCompress = /* @__PURE__ */ __name(async () => {
      const promptId = `compress-${Date.now()}`;
      return await llmClient.tryCompressChat(
        promptId,
        true,
        abortSignal,
        customInstructions
      );
    }, "doCompress");
    if (executionMode === "acp") {
      const messages = /* @__PURE__ */ __name(async function* () {
        try {
          if (truncationNotice) {
            yield {
              messageType: "info",
              content: truncationNotice
            };
          }
          yield {
            messageType: "info",
            content: "Compressing context..."
          };
          const compressed = await doCompress();
          if (!compressed || isCompressionFailureStatus(compressed.compressionStatus)) {
            yield {
              messageType: "error",
              content: compressed ? getCompressionFailureStatusText({
                compressionStatus: compressed.compressionStatus,
                originalTokenCount: compressed.originalTokenCount
              }) : t("Failed to compress chat history.")
            };
            return;
          }
          yield {
            messageType: "info",
            content: `Context compressed (${formatCompressionTokenCount(compressed.originalTokenCount, compressed.originalTokenCountIsEstimated)} -> ${formatCompressionTokenCount(compressed.newTokenCount, compressed.newTokenCountIsEstimated)}).` + (compressed.warning ? `
\u26A0\uFE0F ${compressed.warning}` : "")
          };
        } catch (e) {
          yield {
            messageType: "error",
            content: t("Failed to compress chat history: {{error}}", {
              error: e instanceof Error ? e.message : String(e)
            })
          };
        }
      }, "messages");
      return { type: "stream_messages", messages: messages() };
    }
    try {
      if (executionMode === "interactive") {
        if (truncationNotice) {
          ui.addItem(
            { type: "info" /* INFO */, text: truncationNotice },
            Date.now()
          );
        }
        ui.setPendingItem(pendingMessage);
      }
      const compressed = await doCompress();
      if (abortSignal?.aborted) {
        return;
      }
      if (!compressed || executionMode !== "interactive" && isCompressionFailureStatus(compressed.compressionStatus)) {
        if (executionMode === "interactive") {
          ui.addItem(
            {
              type: "error" /* ERROR */,
              text: t("Failed to compress chat history.")
            },
            Date.now()
          );
          return;
        }
        return {
          type: "message",
          messageType: "error",
          content: compressed ? getCompressionFailureStatusText({
            compressionStatus: compressed.compressionStatus,
            originalTokenCount: compressed.originalTokenCount
          }) : t("Failed to compress chat history.")
        };
      }
      if (executionMode === "interactive") {
        ui.addItem(
          {
            type: "compression" /* COMPRESSION */,
            compression: {
              isPending: false,
              originalTokenCount: compressed.originalTokenCount,
              newTokenCount: compressed.newTokenCount,
              compressionStatus: compressed.compressionStatus,
              compressionKind: "summarize",
              originalTokenCountIsEstimated: compressed.originalTokenCountIsEstimated,
              newTokenCountIsEstimated: compressed.newTokenCountIsEstimated
            }
          },
          Date.now()
        );
        if (compressed.warning) {
          ui.addItem(
            { type: "info" /* INFO */, text: `\u26A0\uFE0F ${compressed.warning}` },
            Date.now()
          );
        }
        return;
      }
      return {
        type: "message",
        messageType: "info",
        content: `${truncationNotice ? `${truncationNotice} ` : ""}Context compressed (${formatCompressionTokenCount(compressed.originalTokenCount, compressed.originalTokenCountIsEstimated)} -> ${formatCompressionTokenCount(compressed.newTokenCount, compressed.newTokenCountIsEstimated)}).` + (compressed.warning ? `
\u26A0\uFE0F ${compressed.warning}` : "")
      };
    } catch (e) {
      if (abortSignal?.aborted) {
        return;
      }
      if (executionMode === "interactive") {
        ui.addItem(
          {
            type: "error" /* ERROR */,
            text: t("Failed to compress chat history: {{error}}", {
              error: e instanceof Error ? e.message : String(e)
            })
          },
          Date.now()
        );
        return;
      }
      return {
        type: "message",
        messageType: "error",
        content: t("Failed to compress chat history: {{error}}", {
          error: e instanceof Error ? e.message : String(e)
        })
      };
    } finally {
      if (executionMode === "interactive") {
        ui.setPendingItem(null);
      }
    }
  }, "action")
};

// packages/cli/src/ui/commands/compressFastCommand.ts
init_esbuild_shims();
var formatTokenCount2 = /* @__PURE__ */ __name((count, isEstimated) => isEstimated ? `~${count}` : String(count), "formatTokenCount");
var compressFastCommand = {
  name: "compress-fast",
  get description() {
    return t(
      "Fast context compression without AI. Strips old tool outputs and thinking parts."
    );
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "non_interactive", "acp"],
  action: /* @__PURE__ */ __name(async (context) => {
    const { ui } = context;
    const executionMode = context.executionMode ?? "interactive";
    if (executionMode === "interactive" && ui.pendingItem) {
      ui.addItem(
        {
          type: "error" /* ERROR */,
          text: t("Already compressing, wait for previous request to complete")
        },
        Date.now()
      );
      return;
    }
    if (context.invocation?.args?.trim()) {
      return {
        type: "message",
        messageType: "info",
        content: t("The /compress-fast command does not accept arguments.")
      };
    }
    const pendingMessage = {
      type: "compression" /* COMPRESSION */,
      compression: {
        isPending: true,
        originalTokenCount: null,
        newTokenCount: null,
        compressionStatus: null
      }
    };
    const config = context.services.config;
    const llmClient = config?.getLlmClient();
    if (!config || !llmClient) {
      return {
        type: "message",
        messageType: "error",
        content: t("Config not loaded.")
      };
    }
    const doCompress = /* @__PURE__ */ __name(async () => await llmClient.tryCompressChatFast(), "doCompress");
    if (executionMode === "acp") {
      const messages = /* @__PURE__ */ __name(async function* () {
        try {
          yield {
            messageType: "info",
            content: "Compressing context (fast)..."
          };
          const compressed = await doCompress();
          if (!compressed || compressed.compressionStatus === 5 /* NOOP */) {
            yield {
              messageType: "info",
              content: t("No compression needed.")
            };
            return;
          }
          yield {
            messageType: "info",
            content: `Context compressed (${formatTokenCount2(compressed.originalTokenCount, compressed.originalTokenCountIsEstimated)} -> ${formatTokenCount2(compressed.newTokenCount, compressed.newTokenCountIsEstimated)}).`
          };
        } catch (e) {
          yield {
            messageType: "error",
            content: t("Failed to compress chat history: {{error}}", {
              error: e instanceof Error ? e.message : String(e)
            })
          };
        }
      }, "messages");
      return { type: "stream_messages", messages: messages() };
    }
    try {
      if (executionMode === "interactive") {
        ui.setPendingItem(pendingMessage);
      }
      const compressed = await doCompress();
      if (!compressed || compressed.compressionStatus === 5 /* NOOP */) {
        if (executionMode === "interactive") {
          ui.addItem(
            {
              type: "info" /* INFO */,
              text: t("No compression needed.")
            },
            Date.now()
          );
          return;
        }
        return {
          type: "message",
          messageType: "info",
          content: t("No compression needed.")
        };
      }
      if (executionMode === "interactive") {
        ui.addItem(
          {
            type: "compression" /* COMPRESSION */,
            compression: {
              isPending: false,
              originalTokenCount: compressed.originalTokenCount,
              newTokenCount: compressed.newTokenCount,
              compressionStatus: compressed.compressionStatus,
              compressionKind: "fast",
              originalTokenCountIsEstimated: compressed.originalTokenCountIsEstimated,
              newTokenCountIsEstimated: compressed.newTokenCountIsEstimated
            }
          },
          Date.now()
        );
        return;
      }
      return {
        type: "message",
        messageType: "info",
        content: `Context compressed (${formatTokenCount2(compressed.originalTokenCount, compressed.originalTokenCountIsEstimated)} -> ${formatTokenCount2(compressed.newTokenCount, compressed.newTokenCountIsEstimated)}).`
      };
    } catch (e) {
      if (executionMode === "interactive") {
        ui.addItem(
          {
            type: "error" /* ERROR */,
            text: t("Failed to compress chat history: {{error}}", {
              error: e instanceof Error ? e.message : String(e)
            })
          },
          Date.now()
        );
        return;
      }
      return {
        type: "message",
        messageType: "error",
        content: t("Failed to compress chat history: {{error}}", {
          error: e instanceof Error ? e.message : String(e)
        })
      };
    } finally {
      if (executionMode === "interactive") {
        ui.setPendingItem(null);
      }
    }
  }, "action")
};

// packages/cli/src/ui/commands/curator-command.ts
init_esbuild_shims();
function message(content, messageType = "info") {
  return { type: "message", messageType, content };
}
__name(message, "message");
function mutationGuard(config) {
  if (config.isSafeMode()) {
    return message(
      t("Auto-skill curator changes are disabled in safe mode."),
      "error"
    );
  }
  if (!config.isTrustedFolder()) {
    return message(
      t(
        "Auto-skill curator changes are only available in trusted workspaces. Trust this folder via `/trust` and try again."
      ),
      "error"
    );
  }
  return void 0;
}
__name(mutationGuard, "mutationGuard");
async function refreshSkillCache(config) {
  try {
    await config.getSkillManager()?.refreshCache();
  } catch {
  }
}
__name(refreshSkillCache, "refreshSkillCache");
function displayName(entry) {
  return entry.skillName === entry.directoryName ? entry.directoryName : `${entry.skillName} (${entry.directoryName})`;
}
__name(displayName, "displayName");
function formatStatus(status) {
  const lines = [
    t("Auto-skill curator"),
    t("Last run: {{time}}", { time: status.lastRunAt ?? t("never") }),
    t("Active: {{count}}", { count: String(status.active.length) }),
    t("Stale: {{count}}", { count: String(status.stale.length) }),
    t("Archived: {{count}}", { count: String(status.archived.length) })
  ];
  if (status.stale.length > 0) {
    lines.push("", t("Stale skills:"));
    lines.push(...status.stale.map((entry) => `  ${displayName(entry)}`));
  }
  const pinned = [...status.active, ...status.stale].filter(
    (entry) => entry.pinned
  );
  if (pinned.length > 0) {
    lines.push("", t("Pinned skills:"));
    lines.push(...pinned.map((entry) => `  ${displayName(entry)}`));
  }
  if (status.archived.length > 0) {
    lines.push("", t("Archived skills:"));
    lines.push(...status.archived.map((entry) => `  ${displayName(entry)}`));
  }
  return lines.join("\n");
}
__name(formatStatus, "formatStatus");
function formatRun(result) {
  const prefix = result.dryRun ? t("Dry run complete.") : t("Curator run complete.");
  const lines = [
    prefix,
    t("Checked: {{count}}", { count: String(result.checked) }),
    t("First observed: {{count}}", { count: String(result.seeded.length) }),
    t("Marked stale: {{count}}", {
      count: String(result.markedStale.length)
    }),
    t("Reactivated: {{count}}", {
      count: String(result.reactivated.length)
    }),
    t("{{verb}}: {{count}}", {
      verb: result.dryRun ? t("Would archive") : t("Archived"),
      count: String(result.archived.length)
    }),
    t("Skipped archive collisions: {{count}}", {
      count: String(result.skippedCollisions.length)
    }),
    t("Skipped rename errors: {{count}}", {
      count: String(result.skippedErrors.length)
    })
  ];
  if (result.archived.length > 0) {
    lines.push(
      "",
      result.dryRun ? t("Archive candidates:") : t("Archived skills:")
    );
    lines.push(...result.archived.map((name) => `  ${name}`));
  }
  if (result.skippedCollisions.length > 0) {
    lines.push("", t("Skipped archive collisions:"));
    lines.push(
      ...result.skippedCollisions.map(
        (name) => `  ${name} \u2014 remove or rename .qwen/archived-skills/${name} to re-archive`
      )
    );
  }
  if (result.skippedErrors.length > 0) {
    lines.push("", t("Skipped rename errors:"));
    lines.push(...result.skippedErrors.map((name) => `  ${name}`));
  }
  return lines.join("\n");
}
__name(formatRun, "formatRun");
async function statusAction(context) {
  const config = context.services.config;
  if (!config) return message(t("Config not loaded."), "error");
  try {
    return message(
      formatStatus(await getAutoSkillCuratorStatus(config.getProjectRoot()))
    );
  } catch (error) {
    return message(
      t("Failed to read auto-skill curator status: {{message}}", {
        message: error instanceof Error ? error.message : String(error)
      }),
      "error"
    );
  }
}
__name(statusAction, "statusAction");
var statusCommand = {
  name: "status",
  get description() {
    return t("Show project auto-skill lifecycle status.");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "non_interactive", "acp"],
  action: statusAction
};
var runCommand = {
  name: "run",
  get description() {
    return t("Run project auto-skill lifecycle maintenance.");
  },
  argumentHint: "[--dry-run]",
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "non_interactive", "acp"],
  action: /* @__PURE__ */ __name(async (context, args) => {
    const config = context.services.config;
    if (!config) return message(t("Config not loaded."), "error");
    const normalized = args.trim();
    if (normalized !== "" && normalized !== "--dry-run") {
      return message(t("Usage: /curator run [--dry-run]"), "error");
    }
    if (normalized !== "--dry-run") {
      const blocked = mutationGuard(config);
      if (blocked) return blocked;
    }
    try {
      const result = await runAutoSkillCurator(config.getProjectRoot(), {
        dryRun: normalized === "--dry-run"
      });
      if (!result.dryRun && result.archived.length > 0) {
        await refreshSkillCache(config);
      }
      return message(formatRun(result));
    } catch (error) {
      return message(
        t("Failed to run auto-skill curator: {{message}}", {
          message: error instanceof Error ? error.message : String(error)
        }),
        "error"
      );
    }
  }, "action")
};
var restoreCommand = {
  name: "restore",
  get description() {
    return t("Restore an archived project auto-skill.");
  },
  argumentHint: "<directory>",
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "non_interactive", "acp"],
  action: /* @__PURE__ */ __name(async (context, args) => {
    const config = context.services.config;
    if (!config) return message(t("Config not loaded."), "error");
    const directoryName = args.trim();
    if (!directoryName) {
      return message(t("Usage: /curator restore <directory>"), "error");
    }
    const blocked = mutationGuard(config);
    if (blocked) return blocked;
    try {
      await restoreArchivedAutoSkill(config.getProjectRoot(), directoryName);
      await refreshSkillCache(config);
      return message(
        t("Restored auto-skill: {{name}}", { name: directoryName })
      );
    } catch (error) {
      return message(
        t("Failed to restore auto-skill: {{message}}", {
          message: error instanceof Error ? error.message : String(error)
        }),
        "error"
      );
    }
  }, "action"),
  completion: /* @__PURE__ */ __name(async (context, partialArg) => {
    const config = context.services.config;
    if (!config) return [];
    try {
      const status = await getAutoSkillCuratorStatus(config.getProjectRoot());
      return status.archived.map((entry) => entry.directoryName).filter((name) => name.startsWith(partialArg));
    } catch {
      return [];
    }
  }, "completion")
};
function pinCommand(name, pinned) {
  return {
    name,
    get description() {
      return pinned ? t("Exclude an auto-skill from automatic maintenance.") : t("Return a pinned auto-skill to automatic maintenance.");
    },
    argumentHint: "<directory>",
    kind: "built-in" /* BUILT_IN */,
    supportedModes: ["interactive", "non_interactive", "acp"],
    action: /* @__PURE__ */ __name(async (context, args) => {
      const config = context.services.config;
      if (!config) return message(t("Config not loaded."), "error");
      const directoryName = args.trim();
      if (!directoryName) {
        return message(
          pinned ? t("Usage: /curator pin <directory>") : t("Usage: /curator unpin <directory>"),
          "error"
        );
      }
      const blocked = mutationGuard(config);
      if (blocked) return blocked;
      try {
        await setAutoSkillPinned(
          config.getProjectRoot(),
          directoryName,
          pinned
        );
        return message(
          pinned ? t("Pinned auto-skill: {{name}}", { name: directoryName }) : t("Unpinned auto-skill: {{name}}", { name: directoryName })
        );
      } catch (error) {
        return message(
          t("Failed to update auto-skill pin: {{message}}", {
            message: error instanceof Error ? error.message : String(error)
          }),
          "error"
        );
      }
    }, "action"),
    completion: /* @__PURE__ */ __name(async (context, partialArg) => {
      const config = context.services.config;
      if (!config) return [];
      try {
        const status = await getAutoSkillCuratorStatus(config.getProjectRoot());
        return [...status.active, ...status.stale].filter((entry) => entry.pinned !== pinned).map((entry) => entry.directoryName).filter((directoryName) => directoryName.startsWith(partialArg));
      } catch {
        return [];
      }
    }, "completion")
  };
}
__name(pinCommand, "pinCommand");
var pinAutoSkillCommand = pinCommand("pin", true);
var unpinAutoSkillCommand = pinCommand("unpin", false);
var curatorCommand = {
  name: "curator",
  get description() {
    return t("Maintain project auto-skills based on recent use.");
  },
  argumentHint: "[status|run [--dry-run]|pin <directory>|unpin <directory>|restore <directory>]",
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "non_interactive", "acp"],
  action: statusAction,
  subCommands: [
    statusCommand,
    runCommand,
    pinAutoSkillCommand,
    unpinAutoSkillCommand,
    restoreCommand
  ]
};

// packages/cli/src/ui/commands/copyCommand.ts
init_esbuild_shims();
function parseFencedCodeBlocks(markdown) {
  const blocks = [];
  const lines = markdown.split(/\r?\n/);
  const fenceRegex = /^ *(`{3,}|~{3,}) *([^`]*)$/;
  const languageCounts = /* @__PURE__ */ new Map();
  let activeFence = null;
  let activeLang = null;
  let activeLangIndex = null;
  let activeLines = [];
  for (const line of lines) {
    const match = line.match(fenceRegex);
    if (!activeFence) {
      if (match) {
        activeFence = match[1];
        activeLang = match[2]?.trim().split(/\s+/)[0]?.toLowerCase() || null;
        if (activeLang) {
          const nextLangIndex = (languageCounts.get(activeLang) ?? 0) + 1;
          languageCounts.set(activeLang, nextLangIndex);
          activeLangIndex = nextLangIndex;
        } else {
          activeLangIndex = null;
        }
        activeLines = [];
      }
      continue;
    }
    if (match && match[1].startsWith(activeFence[0]) && match[1].length >= activeFence.length) {
      blocks.push({
        lang: activeLang,
        content: activeLines.join("\n"),
        index: blocks.length + 1,
        langIndex: activeLangIndex
      });
      activeFence = null;
      activeLang = null;
      activeLangIndex = null;
      activeLines = [];
      continue;
    }
    activeLines.push(line);
  }
  return blocks;
}
__name(parseFencedCodeBlocks, "parseFencedCodeBlocks");
function parseInlineLatexExpressions(markdown) {
  const expressions = [];
  const lines = markdown.split(/\r?\n/);
  const codeFenceRegex = /^ *(`{3,}|~{3,}) *([^`]*)$/;
  const mathFenceRegex = /^ *\$\$ *$/;
  let activeCodeFence = null;
  let inLatexBlock = false;
  for (const line of lines) {
    const codeFenceMatch = line.match(codeFenceRegex);
    if (activeCodeFence) {
      if (codeFenceMatch && codeFenceMatch[1].startsWith(activeCodeFence[0]) && codeFenceMatch[1].length >= activeCodeFence.length) {
        activeCodeFence = null;
      }
      continue;
    }
    if (inLatexBlock) {
      if (mathFenceRegex.test(line)) {
        inLatexBlock = false;
      }
      continue;
    }
    if (codeFenceMatch) {
      activeCodeFence = codeFenceMatch[1];
      continue;
    }
    if (mathFenceRegex.test(line)) {
      inLatexBlock = true;
      continue;
    }
    for (const content of findInlineMathExpressions(line)) {
      expressions.push({
        content,
        index: expressions.length + 1
      });
    }
  }
  return expressions;
}
__name(parseInlineLatexExpressions, "parseInlineLatexExpressions");
function selectInlineLatexExpression(markdown, tokens) {
  const expressions = parseInlineLatexExpressions(markdown);
  if (expressions.length === 0) return null;
  let requestedIndex = null;
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      requestedIndex = Number(token);
    }
  }
  const selected = requestedIndex !== null ? expressions.find((expression) => expression.index === requestedIndex) : expressions[expressions.length - 1];
  return selected ? {
    expression: selected,
    label: `Inline LaTeX expression ${selected.index}`
  } : null;
}
__name(selectInlineLatexExpression, "selectInlineLatexExpression");
function parseLatexBlocks(markdown) {
  const blocks = [];
  const lines = markdown.split(/\r?\n/);
  const codeFenceRegex = /^ *(`{3,}|~{3,}) *([^`]*)$/;
  const mathFenceRegex = /^ *\$\$ *$/;
  let activeCodeFence = null;
  let inLatexBlock = false;
  let activeLines = [];
  for (const line of lines) {
    const codeFenceMatch = line.match(codeFenceRegex);
    if (activeCodeFence) {
      if (codeFenceMatch && codeFenceMatch[1].startsWith(activeCodeFence[0]) && codeFenceMatch[1].length >= activeCodeFence.length) {
        activeCodeFence = null;
      }
      continue;
    }
    if (!inLatexBlock) {
      if (codeFenceMatch) {
        activeCodeFence = codeFenceMatch[1];
        continue;
      }
      if (mathFenceRegex.test(line)) {
        inLatexBlock = true;
        activeLines = [];
      }
      continue;
    }
    if (mathFenceRegex.test(line)) {
      blocks.push({
        content: activeLines.join("\n"),
        index: blocks.length + 1
      });
      inLatexBlock = false;
      activeLines = [];
      continue;
    }
    activeLines.push(line);
  }
  return blocks;
}
__name(parseLatexBlocks, "parseLatexBlocks");
function selectLatexBlock(markdown, args) {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const firstToken = tokens[0]?.toLowerCase();
  if (firstToken !== "latex" && firstToken !== "math" && firstToken !== "inline-latex") {
    return void 0;
  }
  if (firstToken === "inline-latex") {
    return selectInlineLatexExpression(markdown, tokens.slice(1));
  }
  const selectorTokens = tokens.slice(1);
  const inlineSelectorIndex = selectorTokens.findIndex(
    (token) => token.toLowerCase() === "inline"
  );
  if (inlineSelectorIndex !== -1) {
    return selectInlineLatexExpression(
      markdown,
      selectorTokens.filter((_, index) => index !== inlineSelectorIndex)
    );
  }
  const blocks = parseLatexBlocks(markdown);
  if (blocks.length === 0) return null;
  let requestedIndex = null;
  for (const token of selectorTokens) {
    if (/^\d+$/.test(token)) {
      requestedIndex = Number(token);
    }
  }
  const selected = requestedIndex !== null ? blocks.find((block) => block.index === requestedIndex) : blocks[blocks.length - 1];
  return selected ? { block: selected, label: `LaTeX block ${selected.index}` } : null;
}
__name(selectLatexBlock, "selectLatexBlock");
function selectCodeBlock(markdown, args) {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const firstToken = tokens[0]?.toLowerCase();
  if (!firstToken) return void 0;
  const blocks = parseFencedCodeBlocks(markdown);
  if (blocks.length === 0) return null;
  let lang = null;
  let requestedIndex = null;
  const selectorTokens = firstToken === "code" ? tokens.slice(1) : tokens;
  for (const token of selectorTokens) {
    if (/^\d+$/.test(token)) {
      requestedIndex = Number(token);
    } else if (token.toLowerCase() !== "code") {
      lang = token.toLowerCase();
    }
  }
  const candidates = lang ? blocks.filter((block) => block.lang === lang) : blocks;
  if (candidates.length === 0) return null;
  if (requestedIndex !== null) {
    const requested = lang ? candidates.find((block) => block.langIndex === requestedIndex) : blocks.find((block) => block.index === requestedIndex);
    return requested ? { block: requested, label: formatCodeBlockLabel(requested, lang) } : null;
  }
  const selected = candidates[candidates.length - 1];
  return selected ? { block: selected, label: formatCodeBlockLabel(selected, lang) } : null;
}
__name(selectCodeBlock, "selectCodeBlock");
function formatCodeBlockLabel(block, selectedLanguage) {
  if (selectedLanguage && block.langIndex !== null) {
    return `${selectedLanguage} code block ${block.langIndex}`;
  }
  return `Code block ${block.index}`;
}
__name(formatCodeBlockLabel, "formatCodeBlockLabel");
function parseLeadingMessageIndex(args) {
  const trimmed = args.trim();
  if (!trimmed) return { messageIndex: null, subArgs: "" };
  const firstWhitespace = trimmed.search(/\s/);
  const firstToken = firstWhitespace === -1 ? trimmed : trimmed.slice(0, firstWhitespace);
  if (!/^\d+$/.test(firstToken)) {
    return { messageIndex: null, subArgs: args };
  }
  return {
    messageIndex: Number(firstToken),
    subArgs: firstWhitespace === -1 ? "" : trimmed.slice(firstWhitespace + 1)
  };
}
__name(parseLeadingMessageIndex, "parseLeadingMessageIndex");
var copyCommand = {
  name: "copy",
  get description() {
    return t(
      "Copy to clipboard: reply, code (by lang), LaTeX, or Mermaid. N = Nth-latest message, index = block number"
    );
  },
  argumentHint: "[N] [<lang>|code|latex|mermaid] [<index>]",
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive"],
  action: /* @__PURE__ */ __name(async (context, args) => {
    const chat = await context.services.config?.getLlmClient()?.getChat();
    const history = chat?.getHistoryShallow();
    const aiMessages = history?.filter((item) => item.role === "model") ?? [];
    if (aiMessages.length === 0) {
      return {
        type: "message",
        messageType: "info",
        content: "No output in history"
      };
    }
    const { messageIndex, subArgs } = parseLeadingMessageIndex(args);
    let selectedAiMessage;
    if (messageIndex !== null) {
      if (messageIndex < 1) {
        return {
          type: "message",
          messageType: "info",
          content: "Message index must be a positive integer (1 = last AI message)."
        };
      }
      if (messageIndex > aiMessages.length) {
        const turnLabel = aiMessages.length === 1 ? "AI message" : "AI messages";
        return {
          type: "message",
          messageType: "info",
          content: `Only ${aiMessages.length} ${turnLabel} in this session.`
        };
      }
      selectedAiMessage = aiMessages[aiMessages.length - messageIndex];
    } else {
      selectedAiMessage = aiMessages[aiMessages.length - 1];
    }
    const isIndexed = messageIndex !== null && messageIndex > 1;
    const sourceLabel = isIndexed ? `AI message ${messageIndex}` : "the last AI output";
    const sourceLabelCapitalized = isIndexed ? `AI message ${messageIndex}` : "Last AI output";
    const aiOutput = selectedAiMessage.parts?.filter((part) => part.text && !part.thought).map((part) => part.text).join("");
    if (aiOutput) {
      try {
        const selectedLatexBlock = selectLatexBlock(aiOutput, subArgs);
        if (selectedLatexBlock === null) {
          return {
            type: "message",
            messageType: "info",
            content: subArgs.trim().split(/\s+/).some((token) => token === "inline") || subArgs.trim().toLowerCase().startsWith("inline-latex") ? `No matching inline LaTeX expression found in ${sourceLabel}.` : `No matching LaTeX block found in ${sourceLabel}.`
          };
        }
        if (selectedLatexBlock !== void 0) {
          const copiedLatex = "expression" in selectedLatexBlock ? selectedLatexBlock.expression.content : selectedLatexBlock.block.content;
          await copyToClipboard(copiedLatex);
          return {
            type: "message",
            messageType: "info",
            content: `${selectedLatexBlock.label} copied to the clipboard`
          };
        }
        const selectedCodeBlock = selectCodeBlock(aiOutput, subArgs);
        if (selectedCodeBlock === null) {
          return {
            type: "message",
            messageType: "info",
            content: `No matching code block found in ${sourceLabel}.`
          };
        }
        const copiedText = selectedCodeBlock?.block.content ?? aiOutput;
        await copyToClipboard(copiedText);
        return {
          type: "message",
          messageType: "info",
          content: selectedCodeBlock ? `${selectedCodeBlock.label} copied to the clipboard` : isIndexed ? `AI message ${messageIndex} copied to the clipboard` : "Last output copied to the clipboard"
        };
      } catch (error) {
        const message2 = error instanceof Error ? error.message : String(error);
        context.services.config?.getDebugLogger().debug(message2);
        return {
          type: "message",
          messageType: "error",
          content: `Failed to copy to the clipboard. ${message2}`
        };
      }
    } else {
      return {
        type: "message",
        messageType: "info",
        content: `${sourceLabelCapitalized} contains no text to copy.`
      };
    }
  }, "action")
};

// packages/cli/src/ui/commands/docsCommand.ts
init_esbuild_shims();
import process3 from "node:process";
var docsCommand = {
  name: "docs",
  get description() {
    return t("open full Qwen Code documentation in your browser");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "non_interactive", "acp"],
  canRunDuringStreaming: true,
  action: /* @__PURE__ */ __name(async (context) => {
    const langPath = getCurrentLanguage()?.startsWith("zh") ? "zh" : "en";
    const docsUrl = `https://qwenlm.github.io/qwen-code-docs/${langPath}`;
    if (context.executionMode !== "interactive") {
      return {
        type: "message",
        messageType: "info",
        content: `Qwen Code documentation: ${docsUrl}`
      };
    }
    if (process3.env["SANDBOX"] && process3.env["SANDBOX"] !== "sandbox-exec") {
      context.ui.addItem(
        {
          type: "info" /* INFO */,
          text: t(
            "Please open the following URL in your browser to view the documentation:\n{{url}}",
            {
              url: docsUrl
            }
          )
        },
        Date.now()
      );
    } else {
      context.ui.addItem(
        {
          type: "info" /* INFO */,
          text: t("Opening documentation in your browser: {{url}}", {
            url: docsUrl
          })
        },
        Date.now()
      );
      try {
        await openBrowserSecurely(docsUrl);
      } catch (_error) {
        context.ui.addItem(
          {
            type: "error" /* ERROR */,
            text: t("Failed to open browser. View documentation at {{url}}", {
              url: docsUrl
            })
          },
          Date.now()
        );
      }
    }
    return;
  }, "action")
};

// packages/cli/src/ui/commands/doctorCommand.ts
init_esbuild_shims();

// packages/cli/src/ui/commands/doctorChecks.ts
init_esbuild_shims();
import process4 from "node:process";
import os from "node:os";
var MIN_NODE_MAJOR = 22;
function checkNodeVersion() {
  const version = process4.version;
  const major = parseInt(version.replace(/^v/, "").split(".")[0], 10);
  if (isNaN(major) || major < MIN_NODE_MAJOR) {
    return {
      category: t("System"),
      name: t("Node.js version"),
      status: "fail",
      message: version,
      detail: t("Node.js v{{min}}+ is required. Current: {{version}}", {
        min: String(MIN_NODE_MAJOR),
        version
      })
    };
  }
  return {
    category: t("System"),
    name: t("Node.js version"),
    status: "pass",
    message: version
  };
}
__name(checkNodeVersion, "checkNodeVersion");
async function checkNpmVersion() {
  const version = await getNpmVersion();
  if (version === "unknown") {
    return {
      category: t("System"),
      name: t("npm version"),
      status: "warn",
      message: t("not found"),
      detail: t("npm is not available. Some features may not work.")
    };
  }
  return {
    category: t("System"),
    name: t("npm version"),
    status: "pass",
    message: version
  };
}
__name(checkNpmVersion, "checkNpmVersion");
function checkPlatform() {
  return {
    category: t("System"),
    name: t("Platform"),
    status: "pass",
    message: `${process4.platform}/${process4.arch} (${os.release()})`
  };
}
__name(checkPlatform, "checkPlatform");
function checkAuth(context) {
  const config = context.services.config;
  const authType = config?.getAuthType();
  if (!authType) {
    return {
      category: t("Authentication"),
      name: t("API key"),
      status: "fail",
      message: t("not configured"),
      detail: t("Run /auth to configure authentication.")
    };
  }
  const error = validateAuthMethod(authType, config ?? void 0);
  if (error) {
    return {
      category: t("Authentication"),
      name: t("API key"),
      status: "fail",
      message: t("invalid ({{authType}})", { authType }),
      detail: error
    };
  }
  const cgConfig = typeof config?.getContentGeneratorConfig === "function" ? config.getContentGeneratorConfig() : void 0;
  const model = cgConfig?.model ?? config?.getModel();
  const baseUrl = cgConfig?.baseUrl;
  const envKey = cgConfig?.apiKeyEnvKey;
  const provider = findProviderByCredentials(baseUrl, envKey);
  const detailParts = [];
  if (provider) {
    detailParts.push(
      t("Provider: {{provider}}", { provider: t(provider.label) })
    );
  }
  if (baseUrl) {
    detailParts.push(t("Base URL: {{baseUrl}}", { baseUrl }));
  }
  if (model) {
    detailParts.push(t("Model: {{model}}", { model }));
  }
  if (envKey) {
    const hasKey = !!process4.env[envKey];
    detailParts.push(
      hasKey ? t("API key: configured ({{envKey}})", { envKey }) : t("API key: {{envKey}} not set", { envKey })
    );
  }
  return {
    category: t("Authentication"),
    name: t("API key"),
    status: "pass",
    message: t("configured ({{authType}})", { authType }),
    detail: detailParts.length > 0 ? detailParts.join("\n") : void 0
  };
}
__name(checkAuth, "checkAuth");
async function checkApiClient(context) {
  const config = context.services.config;
  if (!config) {
    return {
      category: t("Authentication"),
      name: t("API client"),
      status: "fail",
      message: t("config not loaded")
    };
  }
  try {
    const client = config.getLlmClient();
    if (client.isInitialized()) {
      return {
        category: t("Authentication"),
        name: t("API client"),
        status: "pass",
        message: t("client initialized")
      };
    }
    return {
      category: t("Authentication"),
      name: t("API client"),
      status: "warn",
      message: t("client not initialized"),
      detail: t("The API client has not been initialized yet.")
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      category: t("Authentication"),
      name: t("API client"),
      status: "warn",
      message: t("error"),
      detail: errorMsg
    };
  }
}
__name(checkApiClient, "checkApiClient");
function checkSettings(context) {
  const settings = context.services.settings;
  if (!settings) {
    return {
      category: t("Configuration"),
      name: t("Settings"),
      status: "fail",
      message: t("not loaded"),
      detail: t(
        "Settings could not be loaded. Check your settings files for syntax errors."
      )
    };
  }
  return {
    category: t("Configuration"),
    name: t("Settings"),
    status: "pass",
    message: t("loaded")
  };
}
__name(checkSettings, "checkSettings");
function checkModel(context) {
  const model = context.services.config?.getModel();
  if (!model) {
    return {
      category: t("Configuration"),
      name: t("Model"),
      status: "fail",
      message: t("not configured"),
      detail: t("Run /model to select a model.")
    };
  }
  return {
    category: t("Configuration"),
    name: t("Model"),
    status: "pass",
    message: model
  };
}
__name(checkModel, "checkModel");
function checkMcpServers(context) {
  const config = context.services.config;
  const servers = config?.getMcpServers();
  if (!servers || Object.keys(servers).length === 0) {
    return [
      {
        category: t("MCP Servers"),
        name: t("MCP servers"),
        status: "pass",
        message: t("none configured")
      }
    ];
  }
  if (context.executionMode !== "interactive") {
    return Object.keys(servers).map((name) => ({
      category: t("MCP Servers"),
      name,
      status: "pass",
      message: config?.isMcpServerDisabled(name) ? t("disabled") : t("configured (not checked in non-interactive mode)")
    }));
  }
  return Object.keys(servers).map((name) => {
    if (config?.isMcpServerDisabled(name)) {
      return {
        category: t("MCP Servers"),
        name,
        status: "pass",
        message: t("disabled")
      };
    }
    const status = getMCPServerStatus(name);
    switch (status) {
      case "connected" /* CONNECTED */:
        return {
          category: t("MCP Servers"),
          name,
          status: "pass",
          message: t("connected")
        };
      case "connecting" /* CONNECTING */:
        return {
          category: t("MCP Servers"),
          name,
          status: "warn",
          message: t("connecting"),
          detail: t("Server is still starting up.")
        };
      case "disconnected" /* DISCONNECTED */:
      default:
        return {
          category: t("MCP Servers"),
          name,
          status: "fail",
          message: t("disconnected"),
          detail: t(
            "Check that the server process is running and configuration is correct."
          )
        };
    }
  });
}
__name(checkMcpServers, "checkMcpServers");
function checkToolRegistry(context) {
  const registry = context.services.config?.getToolRegistry();
  if (!registry) {
    return {
      category: t("Tools"),
      name: t("Tool registry"),
      status: "fail",
      message: t("not loaded")
    };
  }
  const count = registry.getAllTools().length;
  return {
    category: t("Tools"),
    name: t("Tool registry"),
    status: "pass",
    message: t("{{count}} tools registered", { count: String(count) })
  };
}
__name(checkToolRegistry, "checkToolRegistry");
async function checkRipgrep(context) {
  try {
    const useBuiltin = context.services.config?.getUseBuiltinRipgrep() ?? false;
    const result = await canUseRipgrep(useBuiltin);
    if (result) {
      return {
        category: t("Tools"),
        name: t("Ripgrep"),
        status: "pass",
        message: t("available")
      };
    }
    return {
      category: t("Tools"),
      name: t("Ripgrep"),
      status: "warn",
      message: t("not available"),
      detail: t(
        "Install ripgrep for faster file search: https://github.com/BurntSushi/ripgrep"
      )
    };
  } catch {
    return {
      category: t("Tools"),
      name: t("Ripgrep"),
      status: "warn",
      message: t("check failed")
    };
  }
}
__name(checkRipgrep, "checkRipgrep");
async function checkGit(_context) {
  const version = await getGitVersion();
  if (version === "unknown") {
    return {
      category: t("Git"),
      name: t("Git"),
      status: "warn",
      message: t("not available"),
      detail: t("Git features will be limited.")
    };
  }
  return {
    category: t("Git"),
    name: t("Git"),
    status: "pass",
    message: version
  };
}
__name(checkGit, "checkGit");
async function runDoctorChecks(context) {
  const [npmResult, ripgrepResult, apiClientResult, gitResult] = await Promise.all([
    checkNpmVersion(),
    checkRipgrep(context),
    checkApiClient(context),
    checkGit(context)
  ]);
  return [
    // System
    checkNodeVersion(),
    npmResult,
    checkPlatform(),
    // Authentication
    checkAuth(context),
    apiClientResult,
    // Configuration
    checkSettings(context),
    checkModel(context),
    // MCP Servers
    ...checkMcpServers(context),
    // Tools
    checkToolRegistry(context),
    ripgrepResult,
    // Git
    gitResult
  ];
}
__name(runDoctorChecks, "runDoctorChecks");

// packages/cli/src/utils/memoryDiagnostics.ts
init_esbuild_shims();
import * as fs4 from "node:fs";
import * as os2 from "node:os";
import * as path4 from "node:path";
import * as v8 from "node:v8";
var HIGH_HEAP_PRESSURE_THRESHOLD = 0.85;
function countProcessInternals(name) {
  const getter = process[name];
  if (typeof getter !== "function") {
    return { count: 0, unavailable: true };
  }
  try {
    const entries = getter();
    if (!Array.isArray(entries)) {
      return { count: 0, unavailable: true };
    }
    return {
      count: entries.length,
      unavailable: false
    };
  } catch {
    return { count: 0, unavailable: true };
  }
}
__name(countProcessInternals, "countProcessInternals");
function getMemoryDiagnostics() {
  let heapStatistics;
  let heapSpaces = [];
  try {
    heapStatistics = v8.getHeapStatistics();
  } catch {
    heapStatistics = void 0;
  }
  try {
    heapSpaces = v8.getHeapSpaceStatistics();
  } catch {
    heapSpaces = [];
  }
  return {
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    process: {
      pid: process.pid,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      uptimeSeconds: process.uptime()
    },
    memory: process.memoryUsage(),
    v8: {
      heapStatistics,
      heapSpaces,
      unavailable: heapStatistics === void 0
    },
    activeHandles: countProcessInternals("_getActiveHandles"),
    activeRequests: countProcessInternals("_getActiveRequests")
  };
}
__name(getMemoryDiagnostics, "getMemoryDiagnostics");
function defaultHeapSnapshotDir() {
  return path4.join(os2.homedir(), ".qwen", "memory-snapshots");
}
__name(defaultHeapSnapshotDir, "defaultHeapSnapshotDir");
function formatSnapshotTimestamp(now) {
  return now.toISOString().replace(/[:.]/g, "-");
}
__name(formatSnapshotTimestamp, "formatSnapshotTimestamp");
function estimateHeapSnapshotBytes() {
  const overheadFactor = 3;
  try {
    const heapStats = v8.getHeapStatistics();
    return Math.max(heapStats.total_heap_size, process.memoryUsage().heapTotal) * overheadFactor;
  } catch {
    return process.memoryUsage().heapTotal * overheadFactor;
  }
}
__name(estimateHeapSnapshotBytes, "estimateHeapSnapshotBytes");
function getAvailableBytes(outputDir) {
  try {
    const stats = fs4.statfsSync(outputDir);
    return stats.bavail * stats.bsize;
  } catch (error) {
    throw new Error(
      `Unable to check available disk space for heap snapshot: ${formatErrorMessage(
        error
      )}`
    );
  }
}
__name(getAvailableBytes, "getAvailableBytes");
function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
__name(formatErrorMessage, "formatErrorMessage");
function cleanupOldHeapSnapshots(outputDir, maxSnapshots) {
  if (maxSnapshots < 1) return;
  const snapshots = fs4.readdirSync(outputDir).filter(
    (name) => name.startsWith("qwen-code-heap-") && name.endsWith(".heapsnapshot")
  ).map((name) => path4.join(outputDir, name)).sort((a, b) => {
    const mtimeDelta = getSnapshotMtimeMs(b) - getSnapshotMtimeMs(a);
    if (mtimeDelta !== 0) return mtimeDelta;
    return extractHeapSnapshotTimestamp(b).localeCompare(
      extractHeapSnapshotTimestamp(a)
    ) || path4.basename(b).localeCompare(path4.basename(a));
  });
  for (const filePath of snapshots.slice(maxSnapshots)) {
    try {
      fs4.rmSync(filePath, { force: true });
    } catch {
    }
  }
}
__name(cleanupOldHeapSnapshots, "cleanupOldHeapSnapshots");
function getSnapshotMtimeMs(filePath) {
  try {
    return fs4.lstatSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}
__name(getSnapshotMtimeMs, "getSnapshotMtimeMs");
function extractHeapSnapshotTimestamp(filePath) {
  return path4.basename(filePath).match(/^qwen-code-heap-\d+-(.+)\.heapsnapshot$/)?.[1] ?? "";
}
__name(extractHeapSnapshotTimestamp, "extractHeapSnapshotTimestamp");
var lastHeapSnapshotWriteByDir = /* @__PURE__ */ new Map();
function enforceHeapSnapshotRateLimit(outputDir, now, rateLimitMs) {
  if (rateLimitMs <= 0) return;
  const key = path4.resolve(outputDir);
  const nowMs = now.getTime();
  const lastWriteMs = lastHeapSnapshotWriteByDir.get(key);
  if (lastWriteMs !== void 0 && nowMs - lastWriteMs < rateLimitMs) {
    const waitSeconds = Math.ceil((rateLimitMs - (nowMs - lastWriteMs)) / 1e3);
    throw new Error(
      `Heap snapshot rate limit: wait ${waitSeconds}s before writing another snapshot in this directory.`
    );
  }
}
__name(enforceHeapSnapshotRateLimit, "enforceHeapSnapshotRateLimit");
function recordHeapSnapshotWrite(outputDir, now) {
  lastHeapSnapshotWriteByDir.set(path4.resolve(outputDir), now.getTime());
}
__name(recordHeapSnapshotWrite, "recordHeapSnapshotWrite");
function writeMemoryHeapSnapshot({
  outputDir = defaultHeapSnapshotDir(),
  now = /* @__PURE__ */ new Date(),
  writeSnapshot = v8.writeHeapSnapshot,
  estimateSnapshotBytes: estimateSnapshotBytesOption = estimateHeapSnapshotBytes,
  getAvailableBytes: getAvailableBytesOption = getAvailableBytes,
  minFreeBytesAfterSnapshot = 512 * 1024 * 1024,
  maxSnapshots = 5,
  rateLimitMs = 6e4
} = {}) {
  fs4.mkdirSync(outputDir, { recursive: true, mode: 448 });
  try {
    fs4.chmodSync(outputDir, 448);
  } catch {
  }
  enforceHeapSnapshotRateLimit(outputDir, now, rateLimitMs);
  const estimatedSnapshotBytes = estimateSnapshotBytesOption();
  const availableBytes = getAvailableBytesOption(outputDir);
  if (availableBytes - estimatedSnapshotBytes < minFreeBytesAfterSnapshot) {
    throw new Error(
      "Insufficient free disk space for heap snapshot; skipping to avoid filling the disk."
    );
  }
  const filePath = path4.join(
    outputDir,
    `qwen-code-heap-${process.pid}-${formatSnapshotTimestamp(now)}.heapsnapshot`
  );
  let writtenPath;
  try {
    writtenPath = writeSnapshot(filePath);
  } catch (error) {
    try {
      fs4.rmSync(filePath, { force: true });
    } catch {
    }
    throw error;
  }
  try {
    fs4.chmodSync(writtenPath, 384);
  } catch {
  }
  recordHeapSnapshotWrite(outputDir, now);
  try {
    cleanupOldHeapSnapshots(outputDir, maxSnapshots);
  } catch {
  }
  return writtenPath;
}
__name(writeMemoryHeapSnapshot, "writeMemoryHeapSnapshot");
function defaultWait(ms) {
  return new Promise((resolve4) => setTimeout(resolve4, ms));
}
__name(defaultWait, "defaultWait");
function normalizeSampleCount(sampleCount) {
  if (!Number.isFinite(sampleCount) || sampleCount <= 0) {
    return 3;
  }
  return Math.max(1, Math.floor(sampleCount));
}
__name(normalizeSampleCount, "normalizeSampleCount");
async function collectMemoryPressureSamples({
  sampleCount = 3,
  intervalMs = 1e3,
  signal,
  now = /* @__PURE__ */ __name(() => /* @__PURE__ */ new Date(), "now"),
  memoryUsage = process.memoryUsage,
  wait = defaultWait
} = {}) {
  const count = normalizeSampleCount(sampleCount);
  const samples = [];
  for (let index = 1; index <= count; index++) {
    if (signal?.aborted) {
      break;
    }
    const memory = memoryUsage();
    samples.push({
      index,
      timestamp: now().toISOString(),
      rss: memory.rss,
      heapTotal: memory.heapTotal,
      heapUsed: memory.heapUsed,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers
    });
    if (index < count && !signal?.aborted) {
      await wait(intervalMs);
    }
  }
  return samples;
}
__name(collectMemoryPressureSamples, "collectMemoryPressureSamples");
function formatBytes(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "unavailable";
  }
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}
__name(formatBytes, "formatBytes");
function formatActiveCount(value) {
  return value.unavailable ? "unavailable" : String(value.count);
}
__name(formatActiveCount, "formatActiveCount");
function asFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
__name(asFiniteNumber, "asFiniteNumber");
function formatPercent(value) {
  if (value === void 0 || !Number.isFinite(value)) {
    return "unavailable";
  }
  return `${(value * 100).toFixed(1)}%`;
}
__name(formatPercent, "formatPercent");
function buildMemoryInsights(diagnostics) {
  const heapPressure = getHeapPressure(diagnostics);
  const heapIsHigh = isHighHeapPressure(diagnostics);
  const rssHeapGapBytes = Math.max(
    0,
    diagnostics.memory.rss - diagnostics.memory.heapTotal
  );
  const externalAndBuffers = diagnostics.memory.external + diagnostics.memory.arrayBuffers;
  const nonHeapGapIsHigh = rssHeapGapBytes >= 256 * 1024 * 1024 && diagnostics.memory.rss >= diagnostics.memory.heapTotal * 2;
  const externalMemoryIsHigh = externalAndBuffers >= 256 * 1024 * 1024 && externalAndBuffers >= diagnostics.memory.rss * 0.3;
  const signals = [];
  const recommendations = [];
  if (diagnostics.v8.unavailable) {
    signals.push(
      "V8 heap statistics are unavailable; heap pressure assessment may be incomplete."
    );
    recommendations.push(
      "Re-run /doctor memory after restarting Qwen Code; if V8 diagnostics remain unavailable, include this report when filing an issue."
    );
  }
  if (heapIsHigh) {
    signals.push(
      "V8 heap usage is high; the process is close to its configured heap limit."
    );
    recommendations.push(
      "If the CLI is sluggish or near OOM, restart Qwen Code to recover memory, then capture a heap snapshot before the next restart to identify retained objects."
    );
  }
  if (nonHeapGapIsHigh || externalMemoryIsHigh) {
    signals.push(
      "Non-heap memory is high; investigate large tool results, buffers, or native allocations."
    );
    recommendations.push(
      "Compare RSS against heap usage over time; if RSS grows while heap stays flat, inspect external buffers, tool-result payloads, and native dependencies before increasing the V8 heap limit."
    );
  }
  if (diagnostics.activeHandles.count >= 1e3 && !diagnostics.activeHandles.unavailable) {
    signals.push(
      "Active handle count is high; long-lived timers, sockets, or file watchers may be accumulating."
    );
    recommendations.push(
      "Check recently enabled MCP servers, watchers, or streaming sessions for resources that are not being closed."
    );
  }
  return {
    status: signals.length > 0 ? "warn" : "ok",
    heapPressure,
    rssHeapGapBytes,
    signals,
    recommendations
  };
}
__name(buildMemoryInsights, "buildMemoryInsights");
function getHeapPressure(diagnostics) {
  const heapStatistics = diagnostics.v8.heapStatistics ?? {};
  const heapSizeLimit = asFiniteNumber(heapStatistics["heap_size_limit"]);
  return heapSizeLimit !== void 0 && heapSizeLimit > 0 ? diagnostics.memory.heapUsed / heapSizeLimit : void 0;
}
__name(getHeapPressure, "getHeapPressure");
function isHighHeapPressure(diagnostics) {
  const heapPressure = getHeapPressure(diagnostics);
  return heapPressure !== void 0 && heapPressure >= HIGH_HEAP_PRESSURE_THRESHOLD;
}
__name(isHighHeapPressure, "isHighHeapPressure");
function formatMemoryPressureSamples(samples) {
  const first = samples[0];
  const last = samples.at(-1);
  const rssDelta = first && last && samples.length > 1 ? last.rss - first.rss : void 0;
  const heapUsedDelta = first && last && samples.length > 1 ? last.heapUsed - first.heapUsed : void 0;
  const sampleLines = samples.map(
    (sample) => `  #${sample.index} ${sample.timestamp}: RSS ${formatBytes(
      sample.rss
    )}, heap used ${formatBytes(sample.heapUsed)}, external ${formatBytes(
      sample.external
    )}, array buffers ${formatBytes(sample.arrayBuffers)}`
  );
  return [
    "Memory pressure samples",
    `  Sample count: ${samples.length}`,
    `  RSS delta: ${formatBytes(rssDelta)}`,
    `  Heap used delta: ${formatBytes(heapUsedDelta)}`,
    ...sampleLines
  ].join("\n");
}
__name(formatMemoryPressureSamples, "formatMemoryPressureSamples");
function formatMemoryDiagnostics(diagnostics) {
  const heapStatistics = diagnostics.v8.heapStatistics ?? {};
  const insights = buildMemoryInsights(diagnostics);
  const heapSpaceLines = diagnostics.v8.heapSpaces.map((space) => {
    const name = String(space["space_name"] ?? "unknown_space");
    return `  - ${name}: ${formatBytes(space["space_used_size"])} / ${formatBytes(
      space["space_size"]
    )}`;
  });
  return [
    "Memory diagnostics",
    `Generated: ${diagnostics.generatedAt}`,
    "",
    "Process",
    `  PID: ${diagnostics.process.pid}`,
    `  Node.js: ${diagnostics.process.nodeVersion}`,
    `  Platform: ${diagnostics.process.platform} ${diagnostics.process.arch}`,
    `  Uptime: ${diagnostics.process.uptimeSeconds.toFixed(1)}s`,
    "",
    "Memory usage",
    `  RSS: ${formatBytes(diagnostics.memory.rss)}`,
    `  Heap used / total: ${formatBytes(
      diagnostics.memory.heapUsed
    )} / ${formatBytes(diagnostics.memory.heapTotal)}`,
    `  External: ${formatBytes(diagnostics.memory.external)}`,
    `  Array buffers: ${formatBytes(diagnostics.memory.arrayBuffers)}`,
    "",
    "V8 heap",
    `  Heap size limit: ${formatBytes(heapStatistics["heap_size_limit"])}`,
    `  Total available: ${formatBytes(heapStatistics["total_available_size"])}`,
    `  Total heap size executable: ${formatBytes(
      heapStatistics["total_heap_size_executable"]
    )}`,
    `  Used heap size: ${formatBytes(heapStatistics["used_heap_size"])}`,
    "  Heap spaces:",
    ...heapSpaceLines.length > 0 ? heapSpaceLines : ["  - unavailable"],
    "",
    "Runtime internals",
    `  Active handles: ${formatActiveCount(diagnostics.activeHandles)}`,
    `  Active requests: ${formatActiveCount(diagnostics.activeRequests)}`,
    "",
    "Assessment",
    `  Status: ${insights.status}`,
    `  Heap pressure: ${formatPercent(insights.heapPressure)}`,
    `  RSS / heap-total gap: ${formatBytes(insights.rssHeapGapBytes)}`,
    "  Signals:",
    ...insights.signals.length > 0 ? insights.signals.map((signal) => `  - ${signal}`) : ["  - No immediate memory pressure signals detected."],
    "  Recommendations:",
    ...insights.recommendations.length > 0 ? insights.recommendations.map(
      (recommendation) => `  - ${recommendation}`
    ) : [
      "  - Re-run /doctor memory when memory grows, before restarting, to compare snapshots."
    ]
  ].join("\n");
}
__name(formatMemoryDiagnostics, "formatMemoryDiagnostics");

// packages/cli/src/ui/commands/doctorCommand.ts
var debugLogger7 = createDebugLogger("DOCTOR_MEMORY");
var MEMORY_SUBCOMMAND = "memory";
var CPU_PROFILE_SUBCOMMAND = "cpu-profile";
var ROLLBACK_SUBCOMMAND = "rollback";
var DOCTOR_SUBCOMMANDS = [
  MEMORY_SUBCOMMAND,
  CPU_PROFILE_SUBCOMMAND,
  ROLLBACK_SUBCOMMAND
];
function getHeapSnapshotSensitiveDataWarning() {
  return t(
    "Heap snapshot may contain prompts, file contents, tool results, and other sensitive data. Do not share it publicly without reviewing it first."
  );
}
__name(getHeapSnapshotSensitiveDataWarning, "getHeapSnapshotSensitiveDataWarning");
function formatErrorMessage2(error) {
  return error instanceof Error ? error.message : String(error);
}
__name(formatErrorMessage2, "formatErrorMessage");
function formatHeapSnapshotErrorMessage(error) {
  const message2 = formatErrorMessage2(error);
  return message2.startsWith("Heap snapshot") ? message2 : `${t("Heap snapshot failed:")} ${message2}`;
}
__name(formatHeapSnapshotErrorMessage, "formatHeapSnapshotErrorMessage");
var doctorCommand = {
  name: "doctor",
  get description() {
    return t("Run installation and environment diagnostics");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "non_interactive", "acp"],
  argumentHint: "[memory|cpu-profile|rollback] [--sample] [--snapshot] [--duration]",
  examples: [
    "/doctor",
    "/doctor memory",
    "/doctor memory --sample",
    "/doctor memory --snapshot",
    "/doctor cpu-profile",
    "/doctor cpu-profile --duration 10",
    "/doctor rollback"
  ],
  completion: /* @__PURE__ */ __name(async (_context, partialArg) => {
    const trimmed = partialArg.trimStart();
    return DOCTOR_SUBCOMMANDS.filter(
      (candidate) => candidate.startsWith(trimmed)
    );
  }, "completion"),
  action: /* @__PURE__ */ __name(async (context, args) => {
    const executionMode = context.executionMode ?? "interactive";
    const abortSignal = context.abortSignal;
    const subCommandArgs = args?.trim().toLowerCase().split(/\s+/).filter(Boolean) ?? [];
    const subCommand = subCommandArgs[0] ?? "";
    const shouldWriteHeapSnapshot = subCommandArgs.includes("--snapshot");
    const shouldSampleMemory = subCommandArgs.includes("--sample");
    if (subCommand === ROLLBACK_SUBCOMMAND) {
      if (executionMode === "acp") {
        return {
          type: "message",
          messageType: "error",
          content: t("Rollback is not available in ACP mode.")
        };
      }
      return rollbackDoctorAction(context);
    }
    if (subCommand === MEMORY_SUBCOMMAND) {
      if (abortSignal?.aborted) {
        return;
      }
      const diagnostics = getMemoryDiagnostics();
      if (abortSignal?.aborted) {
        return;
      }
      let report = formatMemoryDiagnostics(diagnostics);
      const toolResultRetention = collectToolResultRetention(context);
      if (toolResultRetention) {
        report = `${report}

${formatToolResultRetention(toolResultRetention)}`;
      }
      let messageType = "info";
      let heapSnapshotWritten = false;
      if (abortSignal?.aborted) {
        return;
      }
      if (shouldSampleMemory) {
        const samples = await collectMemoryPressureSamples({
          sampleCount: 3,
          intervalMs: 1e3,
          signal: abortSignal
        });
        report = `${report}

${formatMemoryPressureSamples(samples)}`;
        if (abortSignal?.aborted) {
          if (executionMode === "interactive") {
            context.ui.addItem(
              {
                type: "info",
                text: report
              },
              Date.now()
            );
            return;
          }
          return {
            type: "message",
            messageType: "info",
            content: report
          };
        }
      }
      if (shouldWriteHeapSnapshot) {
        if (abortSignal?.aborted) {
          return;
        }
        if (executionMode === "interactive") {
          context.ui.setPendingItem({
            type: "info",
            text: t("Writing heap snapshot, this may take a moment...")
          });
        }
        try {
          const latestDiagnostics = shouldSampleMemory ? getMemoryDiagnostics() : diagnostics;
          if (isHighHeapPressure(latestDiagnostics)) {
            throw new Error(
              t(
                "Heap snapshot skipped: V8 heap pressure is already high, and writing a synchronous heap snapshot could make the process unresponsive or trigger OOM. Restart Qwen Code first if it is unstable, or retry before memory pressure reaches the warning threshold."
              )
            );
          }
          const heapSnapshotPath = writeMemoryHeapSnapshot();
          heapSnapshotWritten = true;
          report = `${report}

${t("Heap snapshot written:")} ${heapSnapshotPath}
${getHeapSnapshotSensitiveDataWarning()}`;
        } catch (error) {
          messageType = "error";
          report = `${report}

${formatHeapSnapshotErrorMessage(error)}`;
        } finally {
          if (executionMode === "interactive") {
            context.ui.setPendingItem(null);
          }
        }
      }
      if (abortSignal?.aborted && shouldWriteHeapSnapshot && !heapSnapshotWritten) {
        return;
      }
      if (executionMode === "interactive") {
        context.ui.addItem(
          {
            type: messageType === "error" ? "error" : "info",
            text: report
          },
          Date.now()
        );
        return;
      }
      return {
        type: "message",
        messageType,
        content: report
      };
    }
    if (subCommand === CPU_PROFILE_SUBCOMMAND) {
      return cpuProfileDoctorAction(context, subCommandArgs.slice(1).join(" "));
    }
    if (executionMode === "interactive") {
      context.ui.setPendingItem({
        type: "info",
        text: t("Running diagnostics...")
      });
    }
    try {
      const checks = await runDoctorChecks(context);
      if (abortSignal?.aborted) {
        return;
      }
      const summary = {
        pass: checks.filter((c) => c.status === "pass").length,
        warn: checks.filter((c) => c.status === "warn").length,
        fail: checks.filter((c) => c.status === "fail").length
      };
      if (executionMode === "interactive") {
        const doctorItem = {
          type: "doctor",
          checks,
          summary
        };
        context.ui.addItem(doctorItem, Date.now());
        return;
      }
      return {
        type: "message",
        messageType: summary.fail > 0 ? "error" : "info",
        content: JSON.stringify({ checks, summary }, null, 2)
      };
    } finally {
      if (executionMode === "interactive") {
        context.ui.setPendingItem(null);
      }
    }
  }, "action"),
  subCommands: [
    {
      name: "memory",
      get description() {
        return t("Show current process memory diagnostics");
      },
      kind: "built-in" /* BUILT_IN */,
      supportedModes: ["interactive", "non_interactive", "acp"],
      argumentHint: "[--json] [--sample] [--snapshot]",
      action: memoryDoctorAction
    },
    {
      name: "cpu-profile",
      get description() {
        return t("Record a CPU profile for Chrome DevTools analysis");
      },
      kind: "built-in" /* BUILT_IN */,
      supportedModes: ["interactive", "non_interactive", "acp"],
      argumentHint: "[--duration <seconds>]",
      action: cpuProfileDoctorAction
    },
    {
      name: "rollback",
      get description() {
        return t("Roll back a standalone update to the previous version");
      },
      kind: "built-in" /* BUILT_IN */,
      supportedModes: ["interactive", "non_interactive"],
      action: rollbackDoctorAction
    }
  ]
};
var MEMORY_USAGE_HINT = "/doctor memory [--json] [--sample] [--snapshot]";
async function memoryDoctorAction(context, args = "") {
  if (context.abortSignal?.aborted) {
    return;
  }
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const unknown = tokens.filter(
    (token) => token !== "--json" && token !== "--sample" && token !== "--snapshot"
  );
  if (unknown.length > 0) {
    return {
      type: "message",
      messageType: "error",
      content: `${t("Unknown argument(s)")}: ${unknown.join(", ")}. ${t("Usage")}: ${MEMORY_USAGE_HINT}`
    };
  }
  const shouldSampleMemory = tokens.includes("--sample");
  const shouldWriteHeapSnapshot = tokens.includes("--snapshot");
  if (shouldSampleMemory || shouldWriteHeapSnapshot) {
    return doctorCommand.action?.(
      context,
      [MEMORY_SUBCOMMAND, ...tokens.filter((token) => token !== "--json")].join(
        " "
      )
    );
  }
  try {
    const diagnostics = await collectMemoryDiagnostics({
      sessionId: context.services.config?.getSessionId(),
      qwenVersion: context.services.config?.getCliVersion()
    });
    if (context.abortSignal?.aborted) {
      return;
    }
    const toolResultRetention = collectToolResultRetention(context);
    return {
      type: "message",
      messageType: diagnostics.analysis.risks.length > 0 ? "warning" : "info",
      content: tokens.includes("--json") ? JSON.stringify(
        {
          ...diagnostics,
          ...toolResultRetention ? { toolResultRetention } : {}
        },
        null,
        2
      ) : formatCoreDiagnostics(diagnostics) + (toolResultRetention ? `

${formatToolResultRetention(toolResultRetention)}` : "")
    };
  } catch (error) {
    if (context.abortSignal?.aborted) {
      return;
    }
    return {
      type: "message",
      messageType: "error",
      content: `${t("Failed to collect memory diagnostics")}: ${formatErrorMessage2(error)}`
    };
  }
}
__name(memoryDoctorAction, "memoryDoctorAction");
function formatCpuMicroseconds(micros) {
  return `${(micros / 1e6).toFixed(2)}s`;
}
__name(formatCpuMicroseconds, "formatCpuMicroseconds");
function formatHeapSpaces(spaces) {
  if (!spaces || spaces.length === 0) {
    return void 0;
  }
  const top = [...spaces].sort((a, b) => b.used - a.used).slice(0, 4);
  const lines = top.map(
    (space) => `  - ${space.name}: used ${formatMemoryUsage(space.used)} / size ${formatMemoryUsage(space.size)}`
  );
  if (spaces.length > top.length) {
    lines.push(`  - \u2026 ${spaces.length - top.length} more`);
  }
  return lines.join("\n");
}
__name(formatHeapSpaces, "formatHeapSpaces");
function formatSmapsRollup(smapsRollup) {
  if (!smapsRollup) {
    return t("unavailable");
  }
  const rssLine = smapsRollup.split(/\r?\n/).map((line) => line.trim().replace(/\s+/g, " ")).find((line) => line.startsWith("Rss:"));
  if (rssLine) {
    return rssLine;
  }
  const preview2 = smapsRollup.slice(0, 80).trim().replace(/\s+/g, " ");
  return `${t("parse error")}: ${preview2}`;
}
__name(formatSmapsRollup, "formatSmapsRollup");
function formatCoreDiagnostics(diagnostics) {
  const risks = diagnostics.analysis.risks.length > 0 ? diagnostics.analysis.risks.map((risk) => `  - ${risk.type}: ${risk.message}`).join("\n") : `  ${t("none")}`;
  const lines = [
    t("Memory Diagnostics"),
    `timestamp: ${diagnostics.timestamp}`,
    `uptimeSeconds: ${diagnostics.uptimeSeconds.toFixed(1)}`,
    `heapUsed: ${formatMemoryUsage(diagnostics.memoryUsage.heapUsed)}`,
    `heapTotal: ${formatMemoryUsage(diagnostics.memoryUsage.heapTotal)}`,
    `rss: ${formatMemoryUsage(diagnostics.memoryUsage.rss)}`,
    `external: ${formatMemoryUsage(diagnostics.memoryUsage.external)}`,
    `arrayBuffers: ${formatMemoryUsage(diagnostics.memoryUsage.arrayBuffers)}`,
    `v8HeapLimit: ${formatMemoryUsage(diagnostics.v8HeapStats.heapSizeLimit)}`,
    `v8MallocedMemory: ${formatMemoryUsage(diagnostics.v8HeapStats.mallocedMemory)}`,
    `v8PeakMallocedMemory: ${formatMemoryUsage(diagnostics.v8HeapStats.peakMallocedMemory)}`,
    `detachedContexts: ${diagnostics.v8HeapStats.detachedContexts}`,
    `nativeContexts: ${diagnostics.v8HeapStats.nativeContexts}`,
    `maxRSS: ${formatMemoryUsage(diagnostics.resourceUsage.maxRSS)}`,
    `userCPUTime: ${formatCpuMicroseconds(diagnostics.resourceUsage.userCPUTime)}`,
    `systemCPUTime: ${formatCpuMicroseconds(diagnostics.resourceUsage.systemCPUTime)}`,
    `activeHandles: ${diagnostics.activeHandles}`,
    `activeRequests: ${diagnostics.activeRequests}`,
    `openFileDescriptors: ${diagnostics.openFileDescriptors ?? t("unavailable")}`,
    `smapsRollup: ${formatSmapsRollup(diagnostics.smapsRollup)}`
  ];
  const heapSpaces = formatHeapSpaces(diagnostics.v8HeapSpaces);
  if (heapSpaces) {
    lines.push("v8HeapSpaces:", heapSpaces);
  }
  lines.push(
    "risks:",
    risks,
    `recommendation: ${diagnostics.analysis.recommendation}`
  );
  return lines.join("\n");
}
__name(formatCoreDiagnostics, "formatCoreDiagnostics");
function collectToolResultRetention(context) {
  try {
    const config = context.services.config;
    const history = config?.getLlmClient()?.getHistoryShallow();
    if (!history) {
      return null;
    }
    const resolveToolBudgetChars = /* @__PURE__ */ __name((name) => config?.getToolRegistry?.()?.getTool(canonicalToolName(name))?.maxOutputChars, "resolveToolBudgetChars");
    const displayNameBudgets = /* @__PURE__ */ new Map();
    for (const tool of config?.getToolRegistry?.()?.getAllTools() ?? []) {
      if (tool.displayName) {
        displayNameBudgets.set(tool.displayName, tool.maxOutputChars);
      }
    }
    const stats = analyzeToolResultRetention(history, {
      // Compare each result against its own tool's declared budget (mirroring
      // the scheduler), so compliant high-budget results (e.g. MCP) are not
      // flagged; tools declaring none fall back to the configured global
      // threshold — the bound the scheduler applies to them.
      resolveToolBudgetChars,
      thresholdChars: config?.getTruncateToolOutputThreshold?.(),
      imageTokenEstimate: resolveSlimmingConfig(config?.getChatCompression?.()).imageTokenEstimate
    });
    const threshold = config?.getTruncateToolOutputThreshold?.() ?? stats.oversizedThresholdChars;
    let largeOutputsInUIHistory = 0;
    for (const item of context.ui.history ?? []) {
      if (item.type !== "tool_group") {
        continue;
      }
      for (const tool of item.tools) {
        if (typeof tool.resultDisplay !== "string") {
          continue;
        }
        const migratedName = ToolDisplayNamesMigration[tool.name] ?? tool.name;
        const budget = displayNameBudgets.get(tool.name) ?? displayNameBudgets.get(migratedName) ?? resolveToolBudgetChars(tool.name) ?? threshold;
        if (Number.isFinite(budget) && tool.resultDisplay.length > budget * COMBINED_PASS_TOLERANCE_FACTOR) {
          largeOutputsInUIHistory += 1;
        }
      }
    }
    return {
      ...stats,
      largeOutputsInUIHistory,
      // Derived assumption: compression reads the live history by reference
      // (getHistoryShallow; see chatCompressionService). If compression input
      // assembly ever changes to copy or filter history, this derivation must
      // be revisited.
      presentInCompressionInput: stats.oversizedResultCount > 0
    };
  } catch (error) {
    debugLogger7.warn(
      `Tool result retention diagnostics unavailable: ${formatErrorMessage2(error)}`
    );
    return null;
  }
}
__name(collectToolResultRetention, "collectToolResultRetention");
function formatToolResultRetention(stats) {
  const lines = [
    "Tool result retention",
    `  Tool results in history: ${stats.toolResultCount}`,
    `  Total retained: ${stats.totalChars} chars`,
    `  Largest result: ${stats.largestResultChars} chars`,
    `  Oversized results (above tool budget): ${stats.oversizedResultCount}`,
    `  Oversized also rendered in UI history: ${stats.largeOutputsInUIHistory} item(s)`,
    `  Oversized also in compression input: ${stats.presentInCompressionInput ? "yes (shared by reference, no extra copy)" : "no"}`
  ];
  if (stats.oversizedResultCount > 0) {
    lines.push(
      "  Hint: oversized tool results stay in context and tax every later turn; /compress can reclaim space."
    );
  }
  return lines.join("\n");
}
__name(formatToolResultRetention, "formatToolResultRetention");
var CPU_PROFILE_USAGE_HINT = "/doctor cpu-profile [--duration <seconds>]";
var DEFAULT_CPU_PROFILE_DURATION_SEC = 30;
var MAX_CPU_PROFILE_DURATION_SEC = 300;
function parseCpuProfileDuration(raw) {
  if (!raw || !/^\d+$/.test(raw)) {
    return NaN;
  }
  return Number(raw);
}
__name(parseCpuProfileDuration, "parseCpuProfileDuration");
async function cpuProfileDoctorAction(context, args = "") {
  const executionMode = context.executionMode ?? "interactive";
  const abortSignal = context.abortSignal;
  if (abortSignal?.aborted) return;
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  let durationSec = DEFAULT_CPU_PROFILE_DURATION_SEC;
  const durationIdx = tokens.indexOf("--duration");
  if (durationIdx !== -1) {
    const rawVal = tokens[durationIdx + 1];
    const val = parseCpuProfileDuration(rawVal);
    if (!Number.isFinite(val) || val < 1 || val > MAX_CPU_PROFILE_DURATION_SEC) {
      const errorMsg = `${t("Duration must be between 1 and {max} seconds", { max: String(MAX_CPU_PROFILE_DURATION_SEC) })}. ${t("Usage")}: ${CPU_PROFILE_USAGE_HINT}`;
      if (executionMode === "interactive") {
        context.ui.addItem({ type: "error", text: errorMsg }, Date.now());
        return;
      }
      return { type: "message", messageType: "error", content: errorMsg };
    }
    durationSec = val;
  }
  const knownTokens = /* @__PURE__ */ new Set(["--duration"]);
  const unknown = tokens.filter((token, idx) => {
    if (knownTokens.has(token)) return false;
    if (idx > 0 && tokens[idx - 1] === "--duration") return false;
    return true;
  });
  if (unknown.length > 0) {
    const errorMsg = `${t("Unknown argument(s)")}: ${unknown.join(", ")}. ${t("Usage")}: ${CPU_PROFILE_USAGE_HINT}`;
    if (executionMode === "interactive") {
      context.ui.addItem({ type: "error", text: errorMsg }, Date.now());
      return;
    }
    return { type: "message", messageType: "error", content: errorMsg };
  }
  if (isCpuProfileRecording()) {
    const errorMsg = process.platform === "win32" ? t("CPU profiling is already in progress. Wait for it to complete.") : t(
      "CPU profiling is already in progress. Send SIGUSR1 or wait for it to complete."
    );
    if (executionMode === "interactive") {
      context.ui.addItem({ type: "error", text: errorMsg }, Date.now());
      return;
    }
    return { type: "message", messageType: "error", content: errorMsg };
  }
  const startResult = await startCpuProfile();
  if (!startResult.ok) {
    if (executionMode === "interactive") {
      context.ui.addItem(
        { type: "error", text: startResult.error },
        Date.now()
      );
      return;
    }
    return {
      type: "message",
      messageType: "error",
      content: startResult.error
    };
  }
  if (abortSignal?.aborted) {
    const abortResult = await stopCpuProfile();
    if (abortResult.ok) {
      const msg = t("CPU profile aborted early. Profile saved: {path}", {
        path: abortResult.filePath
      });
      if (executionMode === "interactive") {
        context.ui.addItem({ type: "info", text: msg }, Date.now());
      }
    } else {
      const msg = `${t("CPU profile aborted but failed to stop cleanly")}: ${abortResult.error}`;
      if (executionMode === "interactive") {
        context.ui.addItem({ type: "error", text: msg }, Date.now());
      }
    }
    return;
  }
  if (executionMode === "interactive") {
    context.ui.setPendingItem({
      type: "info",
      text: t("Recording CPU profile for {duration}s...", {
        duration: String(durationSec)
      })
    });
  }
  await new Promise((resolve4) => {
    const timer = setTimeout(resolve4, durationSec * 1e3);
    if (abortSignal) {
      abortSignal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve4();
        },
        { once: true }
      );
    }
  });
  if (executionMode === "interactive") {
    context.ui.setPendingItem(null);
  }
  const stopResult = await stopCpuProfile();
  if (!stopResult.ok) {
    const alreadyStopped = stopResult.error.includes("not recording");
    if (alreadyStopped) {
      const infoMsg = process.platform === "win32" ? t(
        "CPU profile was stopped externally. Check ~/.qwen/cpu-profiles/ for the output."
      ) : t(
        "CPU profile was stopped externally (e.g., via SIGUSR1). Check ~/.qwen/cpu-profiles/ for the output."
      );
      if (executionMode === "interactive") {
        context.ui.addItem({ type: "info", text: infoMsg }, Date.now());
        return;
      }
      return { type: "message", messageType: "info", content: infoMsg };
    }
    if (executionMode === "interactive") {
      context.ui.addItem({ type: "error", text: stopResult.error }, Date.now());
      return;
    }
    return { type: "message", messageType: "error", content: stopResult.error };
  }
  const successMsg = `${t("CPU profile written:")} ${stopResult.filePath}
${t("Open in Chrome DevTools \u2192 Performance tab \u2192 Load profile")}`;
  if (executionMode === "interactive") {
    context.ui.addItem({ type: "info", text: successMsg }, Date.now());
    return;
  }
  return { type: "message", messageType: "info", content: successMsg };
}
__name(cpuProfileDoctorAction, "cpuProfileDoctorAction");
function rollbackDoctorAction(context) {
  const installInfo = getInstallationInfo(process.cwd(), false);
  if (!installInfo.isStandalone || !installInfo.standaloneDir) {
    const msg2 = t("Rollback is only available for standalone installations.");
    if (context.executionMode === "interactive") {
      context.ui.addItem({ type: "info", text: msg2 }, Date.now());
      return;
    }
    return {
      type: "message",
      messageType: "info",
      content: msg2
    };
  }
  if (process.platform === "win32") {
    const winMsg = t(
      "Rollback on Windows requires manual intervention. Rename qwen-code.old to qwen-code in your installation directory."
    );
    if (context.executionMode === "interactive") {
      context.ui.addItem({ type: "info", text: winMsg }, Date.now());
      return;
    }
    return {
      type: "message",
      messageType: "info",
      content: winMsg
    };
  }
  const result = rollbackStandaloneUpdate(installInfo.standaloneDir);
  let msg;
  let messageType;
  if (result.ok) {
    msg = t(
      "Rollback successful. Restart your terminal to use the previous version."
    );
    messageType = "info";
  } else {
    msg = `${t("Rollback failed:")} ${result.detail}`;
    messageType = "error";
  }
  if (context.executionMode === "interactive") {
    context.ui.addItem({ type: messageType, text: msg }, Date.now());
    return;
  }
  return {
    type: "message",
    messageType,
    content: msg
  };
}
__name(rollbackDoctorAction, "rollbackDoctorAction");

// packages/cli/src/ui/commands/editorCommand.ts
init_esbuild_shims();
var editorCommand = {
  name: "editor",
  get description() {
    return t("set external editor preference");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive"],
  canRunDuringStreaming: true,
  action: /* @__PURE__ */ __name(() => ({
    type: "dialog",
    dialog: "editor"
  }), "action")
};

// packages/cli/src/ui/commands/effort-command.ts
init_esbuild_shims();

// packages/cli/src/ui/commands/effort-utils.ts
init_esbuild_shims();
function formatEffortChangeMessage(config, tier) {
  if (config.getReasoningEffort() !== tier) {
    const override2 = config.getReasoningEffortOverride?.();
    if (override2) {
      return t(
        "Reasoning effort set to {{tier}}, but thinking is currently disabled; after thinking is re-enabled, {{source}}.{{field}} will still have higher priority.",
        { tier, source: override2.source, field: override2.field }
      );
    }
    return t(
      "Reasoning effort set to {{tier}}, but thinking is currently disabled \u2014 it will take effect when thinking is re-enabled.",
      { tier }
    );
  }
  const override = config.getReasoningEffortOverride?.();
  if (override) {
    return t(
      "Reasoning effort: {{tier}} requested, but {{source}}.{{field}} has higher priority for the active DashScope Qwen model; that configured value will remain effective.",
      { tier, source: override.source, field: override.field }
    );
  }
  return t(
    "Reasoning effort: {{tier}} (requested; the effective tier depends on the active provider/model).",
    { tier }
  );
}
__name(formatEffortChangeMessage, "formatEffortChangeMessage");

// packages/cli/src/ui/commands/effort-command.ts
var TIER_LIST = REASONING_EFFORT_TIERS.join(", ");
var effortCommand = {
  name: "effort",
  get description() {
    return t(
      "Set how hard reasoning-capable models think ({{tiers}}); mapped and clamped per provider.",
      { tiers: TIER_LIST }
    );
  },
  // The tiers show up as a placeholder via argumentHint rather than as
  // autocompletion suggestions: bare `/effort` should open the picker dialog
  // (no tier auto-selected), while `/effort <tier>` still sets one directly. A
  // completion function would surface the tiers as submenu-like entries and let
  // Enter auto-pick the first one, which we don't want here.
  argumentHint: "[low|medium|high|xhigh|max]",
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "non_interactive", "acp"],
  action: /* @__PURE__ */ __name(async (context, actionArgs) => {
    const { services } = context;
    const { config, settings } = services;
    if (!config) {
      return {
        type: "message",
        messageType: "error",
        content: t("Configuration not available.")
      };
    }
    const args = context.invocation?.args?.trim() || actionArgs.trim();
    const availableTiers = getReasoningEffortsForConfig(config);
    if (availableTiers.length === 0) {
      return {
        type: "message",
        messageType: "info",
        content: t("The current model does not expose reasoning effort tiers.")
      };
    }
    const availableTierList = availableTiers.join(", ");
    if (!args) {
      if (context.executionMode === "interactive") {
        return { type: "dialog", dialog: "effort" };
      }
      const current = config.getReasoningEffort();
      return {
        type: "message",
        messageType: "info",
        content: current && availableTiers.includes(current) ? t(
          'Current reasoning effort: {{current}}\nAvailable: {{tiers}}\nUse "/effort <tier>" to change it.',
          { current, tiers: availableTierList }
        ) : t(
          'Reasoning effort: not set (using the model/provider default).\nAvailable: {{tiers}}\nUse "/effort <tier>" to set it.',
          { tiers: availableTierList }
        )
      };
    }
    const tier = normalizeReasoningEffort(args);
    if (!tier || !availableTiers.includes(tier)) {
      return {
        type: "message",
        messageType: "error",
        content: t(
          'Unknown reasoning effort "{{value}}". Choose one of: {{tiers}}.',
          { value: args, tiers: availableTierList }
        )
      };
    }
    if (!settings) {
      return {
        type: "message",
        messageType: "error",
        content: t("Settings service not available.")
      };
    }
    applyReasoningEffort(config, tier);
    if (context.executionPolicy?.persistModelSelection !== false) {
      settings.setValue(
        getPersistScopeForModelSelection(settings),
        "model.reasoningEffort",
        tier
      );
    }
    return {
      type: "message",
      messageType: "info",
      content: formatEffortChangeMessage(config, tier)
    };
  }, "action")
};

// packages/cli/src/ui/commands/exportCommand.ts
init_esbuild_shims();
import * as fs5 from "node:fs/promises";
import path5 from "node:path";
var EXPORT_DIR_OUT_OF_CWD = "Export directory must be within the project working directory.";
var debugLogger8 = createDebugLogger("EXPORT_COMMAND");
function formatExportTargetContext(target) {
  return `target: "${target.outputDir}", cwd: "${target.resolvedCwd}"`;
}
__name(formatExportTargetContext, "formatExportTargetContext");
function formatMissingCwdError(resolvedCwd) {
  return `Cannot resolve any existing ancestor within cwd: ${resolvedCwd}. This usually means the project working directory has been deleted or is on an unmounted filesystem.`;
}
__name(formatMissingCwdError, "formatMissingCwdError");
function resolveExportTarget(cwd, args, extension) {
  const filename = generateExportFilename(extension);
  const outputDirArg = args.trim();
  const resolvedCwd = path5.resolve(cwd);
  const outputDir = outputDirArg ? path5.resolve(resolvedCwd, outputDirArg) : resolvedCwd;
  const filepath = path5.join(outputDir, filename);
  const isDefaultOutputDir = outputDir === resolvedCwd;
  const isInsideCwd = isSubpath(resolvedCwd, outputDir);
  const outputDirKind = outputDirArg && !isDefaultOutputDir ? "custom" : "default";
  return {
    filepath,
    outputDir,
    displayPath: isDefaultOutputDir ? filename : path5.join(outputDirArg, filename),
    resolvedCwd,
    outputDirKind,
    isInsideCwd
  };
}
__name(resolveExportTarget, "resolveExportTarget");
async function validateExportTargetWithinCwd(target) {
  debugLogger8.debug(
    "Validating export target realpath:",
    formatExportTargetContext(target)
  );
  let realCwd;
  let realOutputDir;
  try {
    [realCwd, realOutputDir] = await Promise.all([
      fs5.realpath(target.resolvedCwd),
      fs5.realpath(target.outputDir)
    ]);
  } catch (error) {
    if (error.code === "ENOENT") {
      debugLogger8.debug(
        "Export target realpath validation failed: missing path",
        formatExportTargetContext(target)
      );
      return {
        type: "message",
        messageType: "error",
        content: `Export target directory is not accessible (path does not exist; ${formatExportTargetContext(
          target
        )}).`
      };
    }
    throw error;
  }
  if (!isSubpath(realCwd, realOutputDir)) {
    debugLogger8.debug("Export target realpath escaped cwd:", {
      realCwd,
      realOutputDir,
      target
    });
    return {
      type: "message",
      messageType: "error",
      content: `${EXPORT_DIR_OUT_OF_CWD} (target path resolves outside cwd via symlink; ${formatExportTargetContext(
        target
      )})`
    };
  }
  return void 0;
}
__name(validateExportTargetWithinCwd, "validateExportTargetWithinCwd");
async function realpathNearestExisting(outputDir, resolvedCwd) {
  let currentPath = outputDir;
  debugLogger8.debug("Resolving nearest existing export parent:", {
    outputDir,
    resolvedCwd
  });
  while (isSubpath(resolvedCwd, currentPath)) {
    try {
      const realCurrentPath = await fs5.realpath(currentPath);
      debugLogger8.debug("Resolved nearest existing export parent:", {
        currentPath,
        realCurrentPath
      });
      return realCurrentPath;
    } catch (error) {
      if (error.code !== "ENOENT") {
        debugLogger8.debug("Failed to resolve existing export parent:", error);
        throw error;
      }
      const parentPath = path5.dirname(currentPath);
      if (parentPath === currentPath) {
        break;
      }
      currentPath = parentPath;
    }
  }
  throw new Error(formatMissingCwdError(resolvedCwd));
}
__name(realpathNearestExisting, "realpathNearestExisting");
async function validateExistingExportParentWithinCwd(target) {
  debugLogger8.debug(
    "Validating existing export parent realpath:",
    formatExportTargetContext(target)
  );
  let realCwd;
  try {
    realCwd = await fs5.realpath(target.resolvedCwd);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(formatMissingCwdError(target.resolvedCwd));
    }
    throw error;
  }
  const realExistingParent = await realpathNearestExisting(
    target.outputDir,
    target.resolvedCwd
  );
  if (!isSubpath(realCwd, realExistingParent)) {
    debugLogger8.debug("Existing export parent escaped cwd:", {
      realCwd,
      realExistingParent,
      target
    });
    return {
      type: "message",
      messageType: "error",
      content: `${EXPORT_DIR_OUT_OF_CWD} (parent path resolves outside cwd via symlink; ${formatExportTargetContext(
        target
      )})`
    };
  }
  return void 0;
}
__name(validateExistingExportParentWithinCwd, "validateExistingExportParentWithinCwd");
async function exportSessionAction(context, args, exportFormat) {
  const { services } = context;
  const { config } = services;
  if (!config) {
    return {
      type: "message",
      messageType: "error",
      content: "Configuration not available."
    };
  }
  const cwd = config.getWorkingDir() || config.getProjectRoot();
  if (!cwd) {
    return {
      type: "message",
      messageType: "error",
      content: "Could not determine current working directory."
    };
  }
  const target = resolveExportTarget(cwd, args, exportFormat.extension);
  const targetFilepath = target.filepath;
  debugLogger8.debug("Resolved export target:", {
    format: exportFormat.displayName,
    cwd,
    outputDirArg: args.trim(),
    outputDir: target.outputDir,
    outputDirKind: target.outputDirKind,
    filepath: target.filepath
  });
  if (!target.isInsideCwd) {
    debugLogger8.debug(
      "Export target rejected before realpath validation:",
      formatExportTargetContext(target)
    );
    return {
      type: "message",
      messageType: "error",
      content: `${EXPORT_DIR_OUT_OF_CWD} (target path is outside cwd; ${formatExportTargetContext(
        target
      )})`
    };
  }
  try {
    const initialValidationError = target.outputDirKind === "custom" ? await validateExistingExportParentWithinCwd(target) : await validateExportTargetWithinCwd(target);
    if (initialValidationError) {
      return initialValidationError;
    }
    debugLogger8.debug("Export target validation passed:", {
      format: exportFormat.displayName,
      outputDir: target.outputDir,
      outputDirKind: target.outputDirKind
    });
    const sessionService = new SessionService(cwd);
    const sessionId = config.getSessionId();
    debugLogger8.debug("Loading session for export:", { sessionId, cwd });
    const sessionData = await sessionService.loadSession(sessionId);
    if (!sessionData) {
      debugLogger8.debug("No active session found for export:", {
        sessionId,
        cwd
      });
      return {
        type: "message",
        messageType: "error",
        content: "No active session found to export."
      };
    }
    const { conversation } = sessionData;
    const exportData = await collectSessionData(conversation, config);
    const normalizedData = normalizeSessionData(
      exportData,
      conversation.messages,
      config
    );
    const content = exportFormat.format(normalizedData, conversation.messages);
    if (target.outputDirKind === "custom") {
      try {
        debugLogger8.debug("Creating export directory:", {
          outputDir: target.outputDir
        });
        await fs5.mkdir(target.outputDir, { recursive: true, mode: 448 });
      } catch (error) {
        debugLogger8.debug("Failed to create export directory:", error);
        return {
          type: "message",
          messageType: "error",
          content: `Failed to create export directory "${target.outputDir}": ${error instanceof Error ? error.message : String(error)}`
        };
      }
    }
    try {
      const writeValidationError = await validateExportTargetWithinCwd(target);
      if (writeValidationError) {
        return writeValidationError;
      }
    } catch (error) {
      debugLogger8.debug("Export path validation failed before write:", error);
      return {
        type: "message",
        messageType: "error",
        content: `Export path validation failed: ${error instanceof Error ? error.message : String(error)} (${exportFormat.displayName} target: "${targetFilepath}")`
      };
    }
    try {
      debugLogger8.debug("Writing export file:", {
        format: exportFormat.displayName,
        filepath: target.filepath
      });
      await fs5.writeFile(target.filepath, content, {
        encoding: "utf-8",
        mode: 384
      });
      await fs5.chmod(target.filepath, 384).catch((error) => {
        debugLogger8.debug("Failed to tighten export file permissions:", error);
      });
    } catch (error) {
      debugLogger8.debug("Failed to write export file:", error);
      return {
        type: "message",
        messageType: "error",
        content: `Failed to export session: ${error instanceof Error ? error.message : String(error)} (${exportFormat.displayName} target: "${targetFilepath}")`
      };
    }
    debugLogger8.debug("Session export completed:", {
      format: exportFormat.displayName,
      filepath: target.filepath
    });
    return {
      type: "message",
      messageType: "info",
      content: `Session exported to ${exportFormat.displayName}: ${target.displayPath}`
    };
  } catch (error) {
    debugLogger8.debug("Session export failed:", {
      format: exportFormat.displayName,
      target,
      error
    });
    return {
      type: "message",
      messageType: "error",
      content: `Failed to export session: ${error instanceof Error ? error.message : String(error)} (${exportFormat.displayName})`
    };
  }
}
__name(exportSessionAction, "exportSessionAction");
async function exportMarkdownAction(context, args) {
  return exportSessionAction(context, args, {
    extension: "md",
    displayName: "markdown",
    format: toMarkdown
  });
}
__name(exportMarkdownAction, "exportMarkdownAction");
async function exportHtmlAction(context, args) {
  return exportSessionAction(context, args, {
    extension: "html",
    displayName: "HTML",
    format: toHtml
  });
}
__name(exportHtmlAction, "exportHtmlAction");
async function exportJsonAction(context, args) {
  return exportSessionAction(context, args, {
    extension: "json",
    displayName: "JSON",
    format: toJson
  });
}
__name(exportJsonAction, "exportJsonAction");
async function exportJsonlAction(context, args) {
  return exportSessionAction(context, args, {
    extension: "jsonl",
    displayName: "JSONL",
    format: toJsonl
  });
}
__name(exportJsonlAction, "exportJsonlAction");
var exportCommand = {
  name: "export",
  get description() {
    return t("Export current session message history to a file");
  },
  argumentHint: "[md|html|json|jsonl] [path]",
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "non_interactive", "acp"],
  action: exportHtmlAction,
  subCommands: [
    {
      name: "html",
      get description() {
        return t("Export session to HTML format");
      },
      kind: "built-in" /* BUILT_IN */,
      supportedModes: ["interactive", "non_interactive", "acp"],
      action: exportHtmlAction
    },
    {
      name: "md",
      get description() {
        return t("Export session to markdown format");
      },
      kind: "built-in" /* BUILT_IN */,
      supportedModes: ["interactive", "non_interactive", "acp"],
      action: exportMarkdownAction
    },
    {
      name: "json",
      get description() {
        return t("Export session to JSON format");
      },
      kind: "built-in" /* BUILT_IN */,
      supportedModes: ["interactive", "non_interactive", "acp"],
      action: exportJsonAction
    },
    {
      name: "jsonl",
      get description() {
        return t("Export session to JSONL format (one message per line)");
      },
      kind: "built-in" /* BUILT_IN */,
      supportedModes: ["interactive", "non_interactive", "acp"],
      action: exportJsonlAction
    }
  ]
};

// packages/cli/src/ui/commands/forkCommand.ts
init_esbuild_shims();
var debugLogger9 = createDebugLogger("FORK_COMMAND");
function deriveForkDescription(directive) {
  const oneLine = directive.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}\u2026` : oneLine;
}
__name(deriveForkDescription, "deriveForkDescription");
function hasFailedDisplayStatus(display) {
  return display !== null && typeof display === "object" && "status" in display && display.status === "failed";
}
__name(hasFailedDisplayStatus, "hasFailedDisplayStatus");
var forkCommand = {
  name: "fork",
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive"],
  argumentHint: "<directive>",
  get description() {
    return t("Spawn a background agent that inherits the full conversation");
  },
  action: /* @__PURE__ */ __name(async (context, args) => {
    const directive = args.trim();
    if (!directive) {
      return {
        type: "message",
        messageType: "error",
        content: t("Please provide a directive. Usage: /fork <directive>")
      };
    }
    const { config } = context.services;
    const { ui } = context;
    if (!config) {
      return {
        type: "message",
        messageType: "error",
        content: t("Config is not available.")
      };
    }
    if (ui.isIdleRef?.current === false) {
      return {
        type: "message",
        messageType: "error",
        content: t(
          "Cannot fork while a response or tool call is in progress. Wait for it to finish or resolve the pending tool call."
        )
      };
    }
    if (!config.getModel()) {
      return {
        type: "message",
        messageType: "error",
        content: t("No model configured.")
      };
    }
    let hasHistory = false;
    try {
      hasHistory = (config.getLlmClient().getHistoryShallow() ?? []).length > 0;
    } catch (error) {
      debugLogger9.debug("Failed to read history before /fork:", error);
      hasHistory = false;
    }
    if (!hasHistory) {
      return {
        type: "message",
        messageType: "error",
        content: t("Cannot fork before the first conversation turn.")
      };
    }
    const agentTool = config.getToolRegistry().getTool(ToolNames.AGENT);
    if (!agentTool) {
      return {
        type: "message",
        messageType: "error",
        content: t("The agent tool is unavailable; cannot fork.")
      };
    }
    const params = {
      description: deriveForkDescription(directive),
      prompt: directive,
      subagent_type: FORK_SUBAGENT_TYPE,
      run_in_background: true
    };
    let result;
    try {
      result = await agentTool.build(params).execute(new AbortController().signal);
    } catch (error) {
      return {
        type: "message",
        messageType: "error",
        content: t("Failed to launch fork: {{error}}", {
          error: error instanceof Error ? error.message : String(error)
        })
      };
    }
    const display = result?.returnDisplay;
    if (hasFailedDisplayStatus(display)) {
      const reason = typeof result.llmContent === "string" && result.llmContent.trim() ? result.llmContent.trim() : t("the background agent could not be started.");
      return {
        type: "message",
        messageType: "error",
        content: t("Failed to launch fork: {{error}}", { error: reason })
      };
    }
    try {
      config.getLlmClient().addHistory({
        role: "user",
        parts: [
          {
            text: t(
              "User launched a background fork via /fork: {{directive}}",
              {
                directive
              }
            )
          }
        ]
      });
    } catch (error) {
      debugLogger9.debug("Failed to record fork event in history:", error);
    }
    return {
      type: "message",
      messageType: "info",
      content: t(
        "Forked into a background agent. It inherits this conversation and runs without blocking \u2014 track it in the background tasks panel; it reports back when done."
      )
    };
  }, "action")
};

// packages/cli/src/ui/commands/extensionsCommand.ts
init_esbuild_shims();
var debugLogger10 = createDebugLogger("EXTENSIONS_COMMAND");
var EXTENSION_EXPLORE_URL = {
  Gemini: "https://geminicli.com/extensions/",
  ClaudeCode: "https://claudemarketplaces.com/"
};
async function exploreAction(context, args) {
  const mode = context.executionMode ?? "interactive";
  if (mode !== "interactive") {
    return {
      type: "message",
      messageType: "error",
      content: t("/extensions explore is only available in interactive mode.")
    };
  }
  const source = args.trim();
  const extensionsUrl = source ? EXTENSION_EXPLORE_URL[source] : "";
  if (!extensionsUrl) {
    context.ui.addItem(
      {
        type: "error" /* ERROR */,
        text: t("Unknown extensions source: {{source}}.", { source })
      },
      Date.now()
    );
    return;
  }
  if (false) {
    context.ui.addItem(
      {
        type: "info" /* INFO */,
        text: t(
          "Would open extensions page in your browser: {{url}} (skipped in test environment)",
          { url: extensionsUrl }
        )
      },
      Date.now()
    );
  } else if (process.env["SANDBOX"] && process.env["SANDBOX"] !== "sandbox-exec") {
    context.ui.addItem(
      {
        type: "info" /* INFO */,
        text: t("View available extensions at {{url}}", { url: extensionsUrl })
      },
      Date.now()
    );
  } else {
    context.ui.addItem(
      {
        type: "info" /* INFO */,
        text: t("Opening extensions page in your browser: {{url}}", {
          url: extensionsUrl
        })
      },
      Date.now()
    );
    try {
      await openBrowserSecurely(extensionsUrl);
    } catch (_error) {
      context.ui.addItem(
        {
          type: "error" /* ERROR */,
          text: t(
            "Failed to open browser. Check out the extensions gallery at {{url}}",
            { url: extensionsUrl }
          )
        },
        Date.now()
      );
    }
  }
  return void 0;
}
__name(exploreAction, "exploreAction");
async function listAction(context, args) {
  const mode = context.executionMode ?? "interactive";
  if (mode !== "interactive") {
    return listTextAction(context, args);
  }
  return {
    type: "dialog",
    dialog: "extensions_manage"
  };
}
__name(listAction, "listAction");
async function listTextAction(context, _args) {
  const config = context.services.config;
  if (!config) {
    return {
      type: "message",
      messageType: "error",
      content: t("Config not loaded.")
    };
  }
  let extensions;
  try {
    extensions = config.getExtensions();
  } catch (error) {
    return {
      type: "message",
      messageType: "error",
      content: t("Failed to read extensions: {{error}}", {
        error: error instanceof Error ? error.message : String(error)
      })
    };
  }
  if (extensions.length === 0) {
    return {
      type: "message",
      messageType: "info",
      content: t("No extensions installed.")
    };
  }
  const active = extensions.filter((e) => e.isActive);
  let output = t("**Installed Extensions ({{total}} total, {{active}} active)**", {
    total: String(extensions.length),
    active: String(active.length)
  }) + "\n\n";
  const locale = getCurrentLanguage();
  for (const ext of extensions) {
    const status = ext.isActive ? "\u2713" : "\u2717";
    const displayLabel = getExtensionDisplayName(ext, locale);
    const description = getExtensionDescription(ext, locale);
    const caps = [];
    const mcpCount = ext.mcpServers ? Object.keys(ext.mcpServers).length : 0;
    if (mcpCount > 0) {
      caps.push(t("{{count}} MCP servers", { count: String(mcpCount) }));
    }
    if (ext.skills && ext.skills.length > 0) {
      caps.push(t("{{count}} skills", { count: String(ext.skills.length) }));
    }
    if (ext.commands && ext.commands.length > 0) {
      caps.push(
        t("{{count}} commands", { count: String(ext.commands.length) })
      );
    }
    const capsStr = caps.length > 0 ? ` [${caps.join(", ")}]` : "";
    output += `- [${status}] **${displayLabel}**${capsStr}
`;
    if (description) {
      const maxLen = 80;
      const truncated = description.length > maxLen ? description.slice(0, maxLen - 1) + "\u2026" : description;
      output += `  ${truncated}
`;
    }
  }
  return {
    type: "message",
    messageType: "info",
    content: output
  };
}
__name(listTextAction, "listTextAction");
async function installAction(context, args) {
  const mode = context.executionMode ?? "interactive";
  if (mode !== "interactive") {
    return {
      type: "message",
      messageType: "error",
      content: t("/extensions install is only available in interactive mode.")
    };
  }
  const extensionManager = context.services.config?.getExtensionManager();
  if (!(extensionManager instanceof ExtensionManager)) {
    debugLogger10.error(
      `Cannot ${context.invocation?.name} extensions in this environment`
    );
    return;
  }
  const source = args.trim();
  if (!source) {
    context.ui.addItem(
      {
        type: "error" /* ERROR */,
        text: t("Usage: /extensions install <source>")
      },
      Date.now()
    );
    return;
  }
  try {
    const installMetadata = await parseInstallSource(source);
    const redactedSource = redactUrlCredentials(source);
    context.ui.addItem(
      {
        type: "info" /* INFO */,
        text: t('Installing extension from "{{source}}"...', {
          source: redactedSource
        })
      },
      Date.now()
    );
    const extension = await extensionManager.installExtension(installMetadata);
    context.ui.addItem(
      {
        type: "info" /* INFO */,
        text: t('Extension "{{name}}" installed successfully.', {
          name: extension.name
        })
      },
      Date.now()
    );
    context.ui.reloadCommands();
  } catch (error) {
    if (isExtensionCommittedWithWarningsError(error)) {
      context.ui.addItem(
        {
          type: "warning" /* WARNING */,
          text: t(
            "Extension was installed but could not be reloaded: {{error}}",
            { error: redactUrlCredentials(getErrorMessage2(error)) }
          )
        },
        Date.now()
      );
      context.ui.reloadCommands();
      return;
    }
    context.ui.addItem(
      {
        type: "error" /* ERROR */,
        text: t('Failed to install extension from "{{source}}": {{error}}', {
          source: redactUrlCredentials(source),
          error: redactUrlCredentials(getErrorMessage2(error))
        })
      },
      Date.now()
    );
    return;
  }
  return void 0;
}
__name(installAction, "installAction");
async function completeExtensionsExplore(context, partialArg) {
  const suggestions = Object.keys(EXTENSION_EXPLORE_URL).filter(
    (name) => name.startsWith(partialArg)
  );
  return suggestions;
}
__name(completeExtensionsExplore, "completeExtensionsExplore");
var exploreExtensionsCommand = {
  name: "explore",
  get description() {
    return t("Open extensions page in your browser");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive"],
  action: exploreAction,
  completion: completeExtensionsExplore
};
var manageExtensionsCommand = {
  name: "manage",
  get description() {
    return t("Manage installed extensions");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive"],
  action: listAction
};
var listExtensionsCommand = {
  name: "list",
  get description() {
    return t("List installed extensions");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "non_interactive", "acp"],
  action: listTextAction
};
var installCommand = {
  name: "install",
  get description() {
    return t("Install an extension from a git repo or local path");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive"],
  action: installAction
};
var extensionsCommand = {
  name: "extensions",
  get description() {
    return t("Manage extensions");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "non_interactive", "acp"],
  subCommands: [
    listExtensionsCommand,
    manageExtensionsCommand,
    installCommand,
    exploreExtensionsCommand
  ],
  action: /* @__PURE__ */ __name(async (context, args) => {
    const executionMode = context.executionMode ?? "interactive";
    if (executionMode === "interactive") {
      return manageExtensionsCommand.action(context, args);
    }
    return listTextAction(context, args);
  }, "action")
};

// packages/cli/src/ui/commands/goalCommand.ts
init_esbuild_shims();
var CLEAR_KEYWORDS = /* @__PURE__ */ new Set([
  "clear",
  "stop",
  "off",
  "reset",
  "none",
  "cancel"
]);
function parseGoalCommand(args) {
  let input = args.trim();
  if (/^\/goal(?:\s|$)/i.test(input)) {
    input = input.slice("/goal".length).trim();
  }
  if (!input) return { kind: "status" };
  const [head = "", ...tail] = input.split(/\s+/);
  const keyword = head.toLowerCase();
  const objective = tail.join(" ").trim();
  if (keyword === "set") {
    return objective ? { kind: "set", objective } : { kind: "error", message: "`/goal set` requires an objective." };
  }
  if (keyword === "edit") {
    return objective ? { kind: "edit", objective } : { kind: "error", message: "`/goal edit` requires an objective." };
  }
  if (tail.length === 0) {
    if (keyword === "pause") return { kind: "pause" };
    if (keyword === "resume") return { kind: "resume" };
    if (CLEAR_KEYWORDS.has(keyword)) return { kind: "clear" };
  }
  return { kind: "set", objective: input };
}
__name(parseGoalCommand, "parseGoalCommand");
function errorMessage(content) {
  return { type: "message", messageType: "error", content };
}
__name(errorMessage, "errorMessage");
function goalControl(operation, response, cause) {
  return {
    type: "goal_control",
    operation,
    response,
    ...cause ? { cause } : {}
  };
}
__name(goalControl, "goalControl");
var goalCommand = {
  name: "goal",
  get description() {
    return t("Set or control a session goal");
  },
  argumentHint: "[<objective> | set <objective> | edit <objective> | pause | resume | clear]",
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "non_interactive", "acp"],
  action: /* @__PURE__ */ __name(async (context, args) => {
    const { config } = context.services;
    if (!config) return errorMessage("Configuration is not available.");
    const operation = parseGoalCommand(args);
    if (operation.kind === "error") return errorMessage(operation.message);
    const requiresTrustedFolder = operation.kind === "set" || operation.kind === "edit" || operation.kind === "resume";
    if (requiresTrustedFolder && !config.isTrustedFolder()) {
      return errorMessage(
        "/goal is only available in trusted workspaces. Trust this folder via `/trust` and try again."
      );
    }
    let runtime;
    try {
      runtime = await config.getGoalRuntimeReady();
    } catch (error) {
      if (error instanceof GoalPersistenceUnavailableError && (operation.kind === "status" || operation.kind === "clear") && config.getChatRecordingService() === void 0) {
        return goalControl(operation, { snapshot: emptyGoalSnapshot() });
      }
      return errorMessage(
        error instanceof Error ? error.message : String(error)
      );
    }
    try {
      const snapshot = runtime.getSnapshot();
      if (operation.kind === "status") {
        return goalControl(operation, { snapshot });
      }
      const current = snapshot.goal;
      if (operation.kind === "set") {
        const request2 = current ? {
          action: "replace",
          objective: operation.objective,
          expectedGoalId: current.goalId,
          expectedRevision: current.revision
        } : { action: "create", objective: operation.objective };
        return goalControl(
          operation,
          await runtime.dispatch(request2),
          request2.action
        );
      }
      if (!current) {
        if (operation.kind === "clear") {
          return goalControl(operation, { snapshot });
        }
        return errorMessage(`Cannot ${operation.kind}: no Goal is active.`);
      }
      const version = {
        expectedGoalId: current.goalId,
        expectedRevision: current.revision
      };
      const request = operation.kind === "edit" ? {
        action: "edit",
        objective: operation.objective,
        ...version
      } : operation.kind === "pause" ? {
        action: "pause",
        ...version,
        reason: GOAL_PAUSE_REASON_COMMAND
      } : { action: operation.kind, ...version };
      return goalControl(
        operation,
        await runtime.dispatch(request),
        request.action
      );
    } catch (error) {
      return errorMessage(
        error instanceof Error ? error.message : String(error)
      );
    }
  }, "action")
};

// packages/cli/src/ui/commands/helpCommand.ts
init_esbuild_shims();
var helpCommand = {
  name: "help",
  altNames: ["?"],
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive"],
  canRunDuringStreaming: true,
  get description() {
    return t("for help on Qwen Code");
  },
  action: /* @__PURE__ */ __name(async () => ({
    type: "dialog",
    dialog: "help"
  }), "action")
};

// packages/cli/src/ui/commands/historyCommand.ts
init_esbuild_shims();
var collapseOnResumeCommand = {
  name: "collapse-on-resume",
  get description() {
    return t("Set history to collapse by default when resuming a session");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive"],
  action: /* @__PURE__ */ __name((context) => {
    const { settings } = context.services;
    settings.setValue("User" /* User */, "ui.history.collapseOnResume", true);
    return {
      type: "message",
      messageType: "info",
      content: t(
        "History will be collapsed by default for future resumed sessions."
      )
    };
  }, "action")
};
var expandOnResumeCommand = {
  name: "expand-on-resume",
  get description() {
    return t("Set history to expand by default when resuming a session");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive"],
  action: /* @__PURE__ */ __name((context) => {
    const { settings } = context.services;
    settings.setValue("User" /* User */, "ui.history.collapseOnResume", false);
    return {
      type: "message",
      messageType: "info",
      content: t(
        "History will be expanded by default for future resumed sessions."
      )
    };
  }, "action")
};
var expandNowCommand = {
  name: "expand-now",
  get description() {
    return t("Expand the currently collapsed history transcript");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive"],
  action: /* @__PURE__ */ __name(async (context) => {
    const { history, loadHistory, refreshStatic } = context.ui;
    const hasSuppressed = history.some(
      (item) => item.display?.suppressOnRestore
    );
    if (!hasSuppressed) {
      return {
        type: "message",
        messageType: "info",
        content: t("History is already expanded in this session.")
      };
    }
    const { expandCollapsedHistory } = await import("./resumeHistoryUtils-OQFROUBJ.js");
    const updated = expandCollapsedHistory(history);
    loadHistory(updated);
    refreshStatic();
  }, "action")
};
var historyCommand = {
  name: "history",
  get description() {
    return t("Control history display preferences and visibility");
  },
  argumentHint: "collapse-on-resume|expand-on-resume|expand-now",
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive"],
  subCommands: [
    collapseOnResumeCommand,
    expandOnResumeCommand,
    expandNowCommand
  ],
  action: /* @__PURE__ */ __name(async () => ({
    type: "message",
    messageType: "error",
    content: t(
      "Usage: /history collapse-on-resume|expand-on-resume|expand-now"
    )
  }), "action")
};

// packages/cli/src/ui/commands/hooksCommand.ts
init_esbuild_shims();

// packages/cli/src/ui/components/hooks/constants.ts
init_esbuild_shims();
function getHookExitCodes(eventName) {
  const exitCodesMap = {
    ["Stop" /* Stop */]: [
      { code: 0, description: t("stdout/stderr not shown") },
      {
        code: 2,
        description: t("show stderr to model and continue conversation")
      },
      { code: "Other", description: t("show stderr to user only") }
    ],
    ["PreToolUse" /* PreToolUse */]: [
      { code: 0, description: t("stdout/stderr not shown") },
      { code: 2, description: t("show stderr to model and block tool call") },
      {
        code: "Other",
        description: t("show stderr to user only but continue with tool call")
      }
    ],
    ["PostToolUse" /* PostToolUse */]: [
      { code: 0, description: t("stdout shown in transcript mode (ctrl+o)") },
      { code: 2, description: t("show stderr to model immediately") },
      { code: "Other", description: t("show stderr to user only") }
    ],
    ["PostToolUseFailure" /* PostToolUseFailure */]: [
      { code: 0, description: t("stdout shown in transcript mode (ctrl+o)") },
      { code: 2, description: t("show stderr to model immediately") },
      { code: "Other", description: t("show stderr to user only") }
    ],
    ["PostToolBatch" /* PostToolBatch */]: [
      { code: 0, description: t("stdout shown in transcript mode (ctrl+o)") },
      { code: 2, description: t("show stderr to model immediately") },
      { code: "Other", description: t("show stderr to user only") }
    ],
    ["MessageDisplay" /* MessageDisplay */]: [
      {
        code: 0,
        description: t("fire-and-forget; exit status is ignored")
      },
      {
        code: "Other",
        description: t("fire-and-forget; exit status is ignored")
      }
    ],
    ["Notification" /* Notification */]: [
      { code: 0, description: t("stdout/stderr not shown") },
      { code: "Other", description: t("show stderr to user only") }
    ],
    ["InstructionsLoaded" /* InstructionsLoaded */]: [
      { code: 0, description: t("stdout/stderr not shown") },
      { code: "Other", description: t("show stderr to user only") }
    ],
    ["UserPromptSubmit" /* UserPromptSubmit */]: [
      { code: 0, description: t("stdout shown to Qwen") },
      {
        code: 2,
        description: t(
          "block processing, erase original prompt, and show stderr to user only"
        )
      },
      { code: "Other", description: t("show stderr to user only") }
    ],
    ["UserPromptExpansion" /* UserPromptExpansion */]: [
      { code: 0, description: t("stdout shown to Qwen") },
      {
        code: 2,
        description: t(
          "block expanded prompt submission and show stderr to user only"
        )
      },
      { code: "Other", description: t("show stderr to user only") }
    ],
    ["SessionStart" /* SessionStart */]: [
      { code: 0, description: t("stdout shown to Qwen") },
      {
        code: "Other",
        description: t("show stderr to user only (blocking errors ignored)")
      }
    ],
    ["SessionEnd" /* SessionEnd */]: [
      { code: 0, description: t("command completes successfully") },
      { code: "Other", description: t("show stderr to user only") }
    ],
    ["SessionDelete" /* SessionDelete */]: [
      { code: 0, description: t("fire-and-forget; exit status is ignored") },
      {
        code: "Other",
        description: t("fire-and-forget; exit status is ignored")
      }
    ],
    ["SubagentStart" /* SubagentStart */]: [
      { code: 0, description: t("stdout shown to subagent") },
      {
        code: "Other",
        description: t("show stderr to user only (blocking errors ignored)")
      }
    ],
    ["SubagentStop" /* SubagentStop */]: [
      { code: 0, description: t("stdout/stderr not shown") },
      {
        code: 2,
        description: t("show stderr to subagent and continue having it run")
      },
      { code: "Other", description: t("show stderr to user only") }
    ],
    ["PreCompact" /* PreCompact */]: [
      {
        code: 0,
        description: t("stdout appended as custom compact instructions")
      },
      { code: 2, description: t("block compaction") },
      {
        code: "Other",
        description: t("show stderr to user only but continue with compaction")
      }
    ],
    ["PostCompact" /* PostCompact */]: [
      { code: 0, description: t("stdout/stderr not shown") },
      { code: "Other", description: t("show stderr to user only") }
    ],
    ["StopFailure" /* StopFailure */]: [
      {
        code: 0,
        description: t("fire-and-forget; exit status is ignored")
      },
      {
        code: "Other",
        description: t("fire-and-forget; exit status is ignored")
      }
    ],
    ["PermissionRequest" /* PermissionRequest */]: [
      { code: 0, description: t("use hook decision if provided") },
      { code: "Other", description: t("show stderr to user only") }
    ],
    ["PermissionDenied" /* PermissionDenied */]: [
      { code: 0, description: t("stdout/stderr not shown") },
      { code: "Other", description: t("show stderr to user only") }
    ],
    ["TodoCreated" /* TodoCreated */]: [
      { code: 0, description: t("allow todo creation") },
      {
        code: 2,
        description: t("block todo creation and show reason to model")
      },
      { code: "Other", description: t("show stderr to user only") }
    ],
    ["TodoCompleted" /* TodoCompleted */]: [
      { code: 0, description: t("allow todo completion") },
      {
        code: 2,
        description: t("block todo completion and show reason to model")
      },
      { code: "Other", description: t("show stderr to user only") }
    ]
  };
  return exitCodesMap[eventName] || [];
}
__name(getHookExitCodes, "getHookExitCodes");
function getHookShortDescription(eventName) {
  const descriptions = {
    ["PreToolUse" /* PreToolUse */]: t("Before tool execution"),
    ["PostToolUse" /* PostToolUse */]: t("After tool execution"),
    ["PostToolUseFailure" /* PostToolUseFailure */]: t("After tool execution fails"),
    ["PostToolBatch" /* PostToolBatch */]: t("After all tool calls in a batch resolve"),
    ["Notification" /* Notification */]: t("When notifications are sent"),
    ["InstructionsLoaded" /* InstructionsLoaded */]: t("When instruction files are loaded"),
    ["UserPromptSubmit" /* UserPromptSubmit */]: t("When the user submits a prompt"),
    ["UserPromptExpansion" /* UserPromptExpansion */]: t(
      "When a slash command expands into a prompt"
    ),
    ["SessionStart" /* SessionStart */]: t("When a new session is started"),
    ["MessageDisplay" /* MessageDisplay */]: t(
      "Repeatedly, as the assistant reply streams"
    ),
    ["Stop" /* Stop */]: t("Right before Qwen Code concludes its response"),
    ["SubagentStart" /* SubagentStart */]: t(
      "When a subagent (Agent tool call) is started"
    ),
    ["SubagentStop" /* SubagentStop */]: t(
      "Right before a subagent concludes its response"
    ),
    ["PreCompact" /* PreCompact */]: t("Before conversation compaction"),
    ["PostCompact" /* PostCompact */]: t("After conversation compaction"),
    ["StopFailure" /* StopFailure */]: t(
      "When the turn ends due to an API error (fires instead of Stop)"
    ),
    ["SessionEnd" /* SessionEnd */]: t("When a session is ending"),
    ["SessionDelete" /* SessionDelete */]: t(
      "After an explicitly selected session is deleted"
    ),
    ["PermissionRequest" /* PermissionRequest */]: t(
      "When a permission dialog is displayed"
    ),
    ["PermissionDenied" /* PermissionDenied */]: t(
      "When AUTO-mode classification denies a tool call"
    ),
    ["TodoCreated" /* TodoCreated */]: t("When a new todo item is created"),
    ["TodoCompleted" /* TodoCompleted */]: t("When a todo item is marked as completed")
  };
  return descriptions[eventName] || "";
}
__name(getHookShortDescription, "getHookShortDescription");
function getHookDescription(eventName) {
  const descriptions = {
    ["Stop" /* Stop */]: "",
    ["PreToolUse" /* PreToolUse */]: t(
      "Input to command is JSON of tool call arguments."
    ),
    ["PostToolUse" /* PostToolUse */]: t(
      'Input to command is JSON with fields "inputs" (tool call arguments) and "response" (tool call response).'
    ),
    ["PostToolUseFailure" /* PostToolUseFailure */]: t(
      "Input to command is JSON with tool_name, tool_input, tool_use_id, error, error_type, is_interrupt, and is_timeout."
    ),
    ["PostToolBatch" /* PostToolBatch */]: t(
      "Input to command is JSON with tool_calls, an array of resolved tool calls containing tool_name, tool_input, tool_use_id, and tool_response."
    ),
    ["Notification" /* Notification */]: t(
      "Input to command is JSON with notification message and type."
    ),
    ["InstructionsLoaded" /* InstructionsLoaded */]: t(
      "Input to command is JSON with file_path, memory_type, load_reason, and optional trigger_file_path and parent_file_path."
    ),
    ["UserPromptSubmit" /* UserPromptSubmit */]: t(
      'Input to command is JSON with "prompt" (the current model-bound prompt) and optional "submitted_prompt" (the text projection captured at a supported submission boundary).'
    ),
    ["UserPromptExpansion" /* UserPromptExpansion */]: t(
      "Input to command is JSON with command_name, command_args, and expanded prompt text."
    ),
    ["SessionStart" /* SessionStart */]: t(
      "Input to command is JSON with session start source."
    ),
    ["MessageDisplay" /* MessageDisplay */]: t(
      "Input to command is JSON with message_id, displayed_text (cumulative text streamed so far), and is_final. Fire-and-forget: output and exit status are ignored."
    ),
    ["SessionEnd" /* SessionEnd */]: t(
      "Input to command is JSON with session end reason."
    ),
    ["SessionDelete" /* SessionDelete */]: t(
      "Input to command is JSON with deleted_session_id. It runs after an explicitly selected session is deleted; output and failures are ignored."
    ),
    ["SubagentStart" /* SubagentStart */]: t(
      "Input to command is JSON with agent_id and agent_type."
    ),
    ["SubagentStop" /* SubagentStop */]: t(
      "Input to command is JSON with agent_id, agent_type, and agent_transcript_path."
    ),
    ["PreCompact" /* PreCompact */]: t(
      "Input to command is JSON with compaction details."
    ),
    ["PostCompact" /* PostCompact */]: t(
      "Input to command is JSON with trigger (manual/auto) and compact_summary. Output is ignored for control purposes."
    ),
    ["StopFailure" /* StopFailure */]: t(
      "Input to command is JSON with error (rate_limit, authentication_failed, billing_error, invalid_request, server_error, max_output_tokens, unknown) and optional error_details. Fire-and-forget: output and exit status are ignored."
    ),
    ["PermissionRequest" /* PermissionRequest */]: t(
      "Input to command is JSON with tool_name, tool_input, and tool_use_id. Output JSON with hookSpecificOutput containing decision to allow or deny."
    ),
    ["PermissionDenied" /* PermissionDenied */]: t(
      "Input to command is JSON with tool_name, tool_input, tool_use_id, and reason."
    ),
    ["TodoCreated" /* TodoCreated */]: t(
      "Input to command is JSON with todo_id, todo_content, todo_status, all_todos, and phase. In validation, output JSON with decision (allow/block/deny) and reason. In postWrite, block/deny is ignored."
    ),
    ["TodoCompleted" /* TodoCompleted */]: t(
      "Input to command is JSON with todo_id, todo_content, previous_status, all_todos, and phase. In validation, output JSON with decision (allow/block/deny) and reason. In postWrite, block/deny is ignored."
    )
  };
  return descriptions[eventName] || "";
}
__name(getHookDescription, "getHookDescription");
function getTranslatedSourceDisplayMap() {
  return {
    ["project" /* Project */]: t("Local Settings"),
    ["user" /* User */]: t("User Settings"),
    ["system" /* System */]: t("System Settings"),
    ["extensions" /* Extensions */]: t("Extensions"),
    ["session" /* Session */]: t("Session (temporary)")
  };
}
__name(getTranslatedSourceDisplayMap, "getTranslatedSourceDisplayMap");
var DISPLAY_HOOK_EVENTS = Object.values(HookEventName);
function supportsMatchers(eventName) {
  return hookEventSupportsMatcher(eventName);
}
__name(supportsMatchers, "supportsMatchers");
function createEmptyHookEventInfo(eventName) {
  return {
    event: eventName,
    shortDescription: getHookShortDescription(eventName),
    description: getHookDescription(eventName),
    exitCodes: getHookExitCodes(eventName),
    matcherGroups: []
  };
}
__name(createEmptyHookEventInfo, "createEmptyHookEventInfo");

// packages/cli/src/ui/components/hooks/matcherGrouping.ts
init_esbuild_shims();
function normalizeMatcher(matcher) {
  const trimmed = matcher?.trim();
  return trimmed ? trimmed : "*";
}
__name(normalizeMatcher, "normalizeMatcher");
function addConfigToMatcherGroup(hookInfo, matcher, sequential, configInfo, groupByMatcher = true) {
  const normalizedMatcher = groupByMatcher ? normalizeMatcher(matcher) : "*";
  const normalizedSequential = sequential ?? false;
  const normalizedConfig = {
    ...configInfo,
    matcher: normalizedMatcher,
    sequential: normalizedSequential
  };
  let group = hookInfo.matcherGroups.find(
    (candidate) => candidate.matcher === normalizedMatcher
  );
  if (!group) {
    group = {
      matcher: normalizedMatcher,
      sequential: normalizedSequential,
      configs: []
    };
    hookInfo.matcherGroups.push(group);
  } else if (normalizedSequential) {
    group.sequential = true;
  }
  group.configs.push(normalizedConfig);
}
__name(addConfigToMatcherGroup, "addConfigToMatcherGroup");
function getAllConfigs(hookInfo) {
  return hookInfo.matcherGroups.flatMap((group) => group.configs);
}
__name(getAllConfigs, "getAllConfigs");

// packages/cli/src/ui/commands/hooksCommand.ts
var debugLogger11 = createDebugLogger("HOOKS_COMMAND");
async function reloadHooksFromSettings(config, settings) {
  const hookSystem = config.getHookSystem();
  if (!hookSystem) {
    return;
  }
  if (!settings.reloadScopesFromDiskAtomically([
    "User" /* User */,
    "Workspace" /* Workspace */
  ])) {
    throw new Error(
      "Settings could not be read; the previous hooks are still active."
    );
  }
  const systemScopes = ["System" /* System */, "SystemDefaults" /* SystemDefaults */];
  const systemReloaded = settings.reloadScopesFromDiskAtomically(systemScopes);
  config.setHooksFromSettings(
    resolveHookSettingsForConfig(
      settings.merged.hooks,
      {
        systemHooks: settings.getSystemHooks(),
        userHooks: settings.getUserHooks(),
        projectHooks: settings.getProjectHooks()
      },
      config.getBareMode() || config.isSafeMode()
    )
  );
  await hookSystem.reload();
  if (!systemReloaded) {
    const paths = systemScopes.map((scope) => settings.forScope(scope).path).join(", ");
    throw new Error(
      `System settings could not be read (${paths}); hooks from them are unchanged, and other hook edits were applied.`
    );
  }
}
__name(reloadHooksFromSettings, "reloadHooksFromSettings");
function formatHookSource(source) {
  switch (source) {
    case "project":
      return t("Project");
    case "user":
      return t("User");
    case "system":
      return t("System");
    case "extensions":
      return t("Extension");
    case "session":
      return t("Session (temporary)");
    default:
      return source;
  }
}
__name(formatHookSource, "formatHookSource");
var listCommand = {
  name: "list",
  get description() {
    return t("List all configured hooks");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "non_interactive", "acp"],
  action: /* @__PURE__ */ __name(async (context, _args) => {
    const { config } = context.services;
    if (!config) {
      return {
        type: "message",
        messageType: "error",
        content: t("Config not loaded.")
      };
    }
    const hookSystem = config.getHookSystem();
    if (!hookSystem) {
      return {
        type: "message",
        messageType: "info",
        content: t(
          "Hooks are not enabled. Enable hooks in settings to use this feature."
        )
      };
    }
    const registry = hookSystem.getRegistry();
    const configHooks = registry.getAllHooks();
    const sessionId = config.getSessionId();
    const sessionHooksManager = hookSystem.getSessionHooksManager();
    const sessionHooks = sessionId ? sessionHooksManager.getAllSessionHooks(sessionId) : [];
    const totalHooks = configHooks.length + sessionHooks.length;
    if (totalHooks === 0) {
      return {
        type: "message",
        messageType: "info",
        content: t(
          "No hooks configured. Add hooks in your settings.json file or invoke a skill with hooks."
        )
      };
    }
    const hooksByEvent = /* @__PURE__ */ new Map();
    const addHook = /* @__PURE__ */ __name((eventName, matcher, hook) => {
      const matcherKey = supportsMatchers(eventName) ? matcher : "*";
      let matcherMap = hooksByEvent.get(eventName);
      if (!matcherMap) {
        matcherMap = /* @__PURE__ */ new Map();
        hooksByEvent.set(eventName, matcherMap);
      }
      let bucket = matcherMap.get(matcherKey);
      if (!bucket) {
        bucket = [];
        matcherMap.set(matcherKey, bucket);
      }
      bucket.push(hook);
    }, "addHook");
    const extractName = /* @__PURE__ */ __name((config2) => config2.name || (config2.type === "command" ? config2.command : void 0) || (config2.type === "http" ? config2.url : void 0) || "unnamed", "extractName");
    for (const hook of configHooks) {
      const configHook = hook;
      const config2 = configHook.config;
      addHook(configHook.eventName, normalizeMatcher(configHook.matcher), {
        name: extractName(config2),
        source: formatHookSource(configHook.source)
      });
    }
    for (const hook of sessionHooks) {
      const sessionHook = hook;
      const config2 = sessionHook.config;
      addHook(sessionHook.eventName, normalizeMatcher(sessionHook.matcher), {
        name: extractName(config2),
        source: formatHookSource("session")
      });
    }
    let output = `**Configured Hooks (${totalHooks} total)**

`;
    for (const [eventName, matcherMap] of hooksByEvent) {
      output += `### ${eventName}

`;
      const useMatchers = supportsMatchers(eventName);
      if (useMatchers) {
        for (const [matcher, hookList] of matcherMap) {
          output += `#### ${t("Matcher:")} ${matcher}
`;
          for (const hook of hookList) {
            output += `- **${hook.name}** [${hook.source}]
`;
          }
          output += "\n";
        }
      } else {
        for (const hookList of matcherMap.values()) {
          for (const hook of hookList) {
            output += `- **${hook.name}** [${hook.source}]
`;
          }
        }
        output += "\n";
      }
    }
    return {
      type: "message",
      messageType: "info",
      content: output
    };
  }, "action")
};
var hooksCommand = {
  name: "hooks",
  get description() {
    return t("Manage Qwen Code hooks");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "non_interactive", "acp"],
  canRunDuringStreaming: true,
  action: /* @__PURE__ */ __name(async (context, args) => {
    const executionMode = context.executionMode ?? "interactive";
    if (executionMode === "interactive") {
      const { config, settings } = context.services;
      if (config) {
        try {
          await reloadHooksFromSettings(config, settings);
        } catch (error) {
          debugLogger11.warn(`Failed to reload hooks for /hooks: ${error}`);
          context.ui.addItem(
            {
              type: "error" /* ERROR */,
              text: t("Failed to reload hook definitions: {{error}}", {
                error: error instanceof Error ? error.message : String(error)
              })
            },
            Date.now()
          );
        }
      }
      return {
        type: "dialog",
        dialog: "hooks"
      };
    }
    const result = await listCommand.action?.(context, args);
    return result ?? { type: "message", messageType: "info", content: "" };
  }, "action")
};

// packages/cli/src/ui/commands/ideCommand.ts
init_esbuild_shims();
import path6 from "node:path";
function getIdeStatusMessage(ideClient) {
  const connection = ideClient.getConnectionStatus();
  switch (connection.status) {
    case "connected" /* Connected */:
      return {
        messageType: "info",
        content: `\u2713 Connected to ${ideClient.getDetectedIdeDisplayName()}`
      };
    case "connecting" /* Connecting */:
      return {
        messageType: "info",
        content: `\u25D0 Connecting...`
      };
    default: {
      let content = `\u2717 Disconnected`;
      if (connection?.details) {
        content += `: ${connection.details}`;
      }
      return {
        messageType: "error",
        content
      };
    }
  }
}
__name(getIdeStatusMessage, "getIdeStatusMessage");
function formatFileList(openFiles) {
  const basenameCounts = /* @__PURE__ */ new Map();
  for (const file of openFiles) {
    const basename3 = path6.basename(file.path);
    basenameCounts.set(basename3, (basenameCounts.get(basename3) || 0) + 1);
  }
  const fileList = openFiles.map((file) => {
    const basename3 = path6.basename(file.path);
    const isDuplicate = (basenameCounts.get(basename3) || 0) > 1;
    const parentDir = path6.basename(path6.dirname(file.path));
    const displayName2 = isDuplicate ? `${basename3} (/${parentDir})` : basename3;
    return `  - ${displayName2}${file.isActive ? " (active)" : ""}`;
  }).join("\n");
  const infoMessage = `
(Note: The file list is limited to a number of recently accessed files within your workspace and only includes local files on disk)`;
  return `

Open files:
${fileList}
${infoMessage}`;
}
__name(formatFileList, "formatFileList");
async function getIdeStatusMessageWithFiles(ideClient) {
  const connection = ideClient.getConnectionStatus();
  switch (connection.status) {
    case "connected" /* Connected */: {
      let content = `\u2713 Connected to ${ideClient.getDetectedIdeDisplayName()}`;
      const context = ideContextStore.get();
      const openFiles = context?.workspaceState?.openFiles;
      if (openFiles && openFiles.length > 0) {
        content += formatFileList(openFiles);
      }
      return {
        messageType: "info",
        content
      };
    }
    case "connecting" /* Connecting */:
      return {
        messageType: "info",
        content: `\u25D0 Connecting...`
      };
    default: {
      let content = `\u2717 Disconnected`;
      if (connection?.details) {
        content += `: ${connection.details}`;
      }
      return {
        messageType: "error",
        content
      };
    }
  }
}
__name(getIdeStatusMessageWithFiles, "getIdeStatusMessageWithFiles");
async function setIdeModeAndSyncConnection(config, value) {
  config.setIdeMode(value);
  const ideClient = await IdeClient.getInstance();
  if (value) {
    await ideClient.connect();
    logIdeConnection(config, new IdeConnectionEvent("session" /* SESSION */));
  } else {
    await ideClient.disconnect();
  }
}
__name(setIdeModeAndSyncConnection, "setIdeModeAndSyncConnection");
var ideCommand = /* @__PURE__ */ __name(async () => {
  const ideClient = await IdeClient.getInstance();
  const currentIDE = ideClient.getCurrentIde();
  if (!currentIDE) {
    return {
      name: "ide",
      get description() {
        return t("manage IDE integration");
      },
      kind: "built-in" /* BUILT_IN */,
      supportedModes: ["interactive"],
      action: /* @__PURE__ */ __name(() => ({
        type: "message",
        messageType: "error",
        content: t(
          "IDE integration is not supported in your current environment. To use this feature, run Qwen Code in one of these supported IDEs: VS Code or VS Code forks."
        )
      }), "action")
    };
  }
  const ideSlashCommand = {
    name: "ide",
    get description() {
      return t("manage IDE integration");
    },
    kind: "built-in" /* BUILT_IN */,
    supportedModes: ["interactive"],
    subCommands: []
  };
  const statusCommand2 = {
    name: "status",
    get description() {
      return t("check status of IDE integration");
    },
    kind: "built-in" /* BUILT_IN */,
    supportedModes: ["interactive"],
    action: /* @__PURE__ */ __name(async () => {
      const { messageType, content } = await getIdeStatusMessageWithFiles(ideClient);
      return {
        type: "message",
        messageType,
        content
      };
    }, "action")
  };
  const installCommand2 = {
    name: "install",
    get description() {
      const ideName = ideClient.getDetectedIdeDisplayName() ?? "IDE";
      return t("install required IDE companion for {{ideName}}", {
        ideName
      });
    },
    kind: "built-in" /* BUILT_IN */,
    supportedModes: ["interactive"],
    action: /* @__PURE__ */ __name(async (context) => {
      const installer = getIdeInstaller(currentIDE);
      const isSandBox = !!process.env["SANDBOX"];
      if (isSandBox) {
        context.ui.addItem(
          {
            type: "info",
            text: `IDE integration needs to be installed on the host. If you have already installed it, you can directly connect the ide`
          },
          Date.now()
        );
        return;
      }
      if (!installer) {
        const ideName = ideClient.getDetectedIdeDisplayName();
        context.ui.addItem(
          {
            type: "error",
            text: `Automatic installation is not supported for ${ideName}. Please install the '${QWEN_CODE_COMPANION_EXTENSION_NAME}' extension manually from the marketplace.`
          },
          Date.now()
        );
        return;
      }
      context.ui.addItem(
        {
          type: "info",
          text: `Installing IDE companion...`
        },
        Date.now()
      );
      const result = await installer.install();
      context.ui.addItem(
        {
          type: result.success ? "info" : "error",
          text: result.message
        },
        Date.now()
      );
      if (result.success) {
        context.services.settings.setValue(
          "User" /* User */,
          "ide.enabled",
          true
        );
        for (let i = 0; i < 10; i++) {
          await setIdeModeAndSyncConnection(context.services.config, true);
          if (ideClient.getConnectionStatus().status === "connected" /* Connected */) {
            break;
          }
          await new Promise((resolve4) => setTimeout(resolve4, 500));
        }
        const { messageType, content } = getIdeStatusMessage(ideClient);
        if (messageType === "error") {
          context.ui.addItem(
            {
              type: messageType,
              text: `Failed to automatically enable IDE integration. To fix this, run the CLI in a new terminal window.`
            },
            Date.now()
          );
        } else {
          context.ui.addItem(
            {
              type: messageType,
              text: content
            },
            Date.now()
          );
        }
      }
    }, "action")
  };
  const enableCommand = {
    name: "enable",
    get description() {
      return t("enable IDE integration");
    },
    kind: "built-in" /* BUILT_IN */,
    supportedModes: ["interactive"],
    action: /* @__PURE__ */ __name(async (context) => {
      context.services.settings.setValue(
        "User" /* User */,
        "ide.enabled",
        true
      );
      await setIdeModeAndSyncConnection(context.services.config, true);
      const { messageType, content } = getIdeStatusMessage(ideClient);
      context.ui.addItem(
        {
          type: messageType,
          text: content
        },
        Date.now()
      );
    }, "action")
  };
  const disableCommand = {
    name: "disable",
    get description() {
      return t("disable IDE integration");
    },
    kind: "built-in" /* BUILT_IN */,
    supportedModes: ["interactive"],
    action: /* @__PURE__ */ __name(async (context) => {
      context.services.settings.setValue(
        "User" /* User */,
        "ide.enabled",
        false
      );
      await setIdeModeAndSyncConnection(context.services.config, false);
      const { messageType, content } = getIdeStatusMessage(ideClient);
      context.ui.addItem(
        {
          type: messageType,
          text: content
        },
        Date.now()
      );
    }, "action")
  };
  const { status } = ideClient.getConnectionStatus();
  const isConnected = status === "connected" /* Connected */;
  if (isConnected) {
    ideSlashCommand.subCommands = [statusCommand2, disableCommand];
  } else {
    ideSlashCommand.subCommands = [
      enableCommand,
      statusCommand2,
      installCommand2
    ];
  }
  return ideSlashCommand;
}, "ideCommand");

// packages/cli/src/ui/commands/importConfigCommand.ts
init_esbuild_shims();

// packages/cli/src/config/claudeMcpImport.ts
init_esbuild_shims();
import * as fs6 from "node:fs";
import * as os3 from "node:os";
import * as path7 from "node:path";
var import_strip_json_comments = __toESM(require_strip_json_comments(), 1);
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
__name(isRecord, "isRecord");
function isReadableConfigError(error) {
  return !!error && typeof error === "object" && "code" in error;
}
__name(isReadableConfigError, "isReadableConfigError");
function isReservedServerName(name) {
  return name === "__proto__" || name === "constructor" || name === "prototype";
}
__name(isReservedServerName, "isReservedServerName");
function emptyServerRecord() {
  return /* @__PURE__ */ Object.create(null);
}
__name(emptyServerRecord, "emptyServerRecord");
function readJsonObject(filePath) {
  let raw;
  try {
    raw = fs6.readFileSync(filePath, "utf-8");
  } catch (error) {
    if (isReadableConfigError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return { found: false };
    }
    return {
      found: true,
      error: `Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  if (!raw.trim()) {
    return { found: false };
  }
  let parsed;
  try {
    parsed = JSON.parse((0, import_strip_json_comments.default)(raw));
  } catch (error) {
    return {
      found: true,
      error: `Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  if (!isRecord(parsed)) {
    return {
      found: true,
      error: `${filePath} must contain a JSON object`
    };
  }
  return { found: true, data: parsed };
}
__name(readJsonObject, "readJsonObject");
function copyMcpServers(value, sourcePath, servers, errors) {
  if (value === void 0) {
    return;
  }
  if (!isRecord(value)) {
    errors.push(`${sourcePath} has no "mcpServers" object`);
    return;
  }
  for (const [name, serverConfig] of Object.entries(value)) {
    if (!isRecord(serverConfig)) {
      errors.push(`${sourcePath}: server "${name}" is not an object - skipped`);
      continue;
    }
    servers[name] = normalizeClaudeMcpServer(serverConfig);
  }
}
__name(copyMcpServers, "copyMcpServers");
function normalizeProjectPath(projectPath) {
  return path7.resolve(projectPath);
}
__name(normalizeProjectPath, "normalizeProjectPath");
function getClaudeProjectSettings(projects, cwd) {
  if (!isRecord(projects)) {
    return void 0;
  }
  const normalizedCwd = normalizeProjectPath(cwd);
  for (const [projectPath, projectSettings] of Object.entries(projects)) {
    if (normalizeProjectPath(projectPath) === normalizedCwd && isRecord(projectSettings)) {
      return projectSettings;
    }
  }
  return void 0;
}
__name(getClaudeProjectSettings, "getClaudeProjectSettings");
function getClaudeCodeConfigPath(homeDir = os3.homedir()) {
  return path7.join(homeDir, ".claude.json");
}
__name(getClaudeCodeConfigPath, "getClaudeCodeConfigPath");
function getClaudeDesktopConfigPath(homeDir = os3.homedir(), platform2 = process.platform, env = process.env) {
  if (platform2 === "win32") {
    const appData = env["APPDATA"] ?? path7.win32.join(homeDir, "AppData", "Roaming");
    return path7.win32.join(appData, "Claude", "claude_desktop_config.json");
  }
  if (platform2 === "darwin") {
    return path7.join(
      homeDir,
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json"
    );
  }
  return path7.join(homeDir, ".config", "Claude", "claude_desktop_config.json");
}
__name(getClaudeDesktopConfigPath, "getClaudeDesktopConfigPath");
function loadMcpServersFromSettingsFile(filePath, label, source) {
  const errors = [];
  const servers = emptyServerRecord();
  const parsed = readJsonObject(filePath);
  if (!parsed.found) {
    return {
      source,
      label,
      path: filePath,
      servers,
      errors,
      found: false
    };
  }
  if (!parsed.data) {
    return {
      source,
      label,
      path: filePath,
      servers,
      errors: parsed.error ? [parsed.error] : errors,
      found: true
    };
  }
  copyMcpServers(parsed.data["mcpServers"], filePath, servers, errors);
  return {
    source,
    label,
    path: filePath,
    servers,
    errors,
    found: true
  };
}
__name(loadMcpServersFromSettingsFile, "loadMcpServersFromSettingsFile");
function loadClaudeCodeJsonMcpServers(homeDir, cwd, scope) {
  const filePath = getClaudeCodeConfigPath(homeDir);
  const errors = [];
  const servers = emptyServerRecord();
  const parsed = readJsonObject(filePath);
  if (!parsed.found) {
    return {
      source: "claude-code",
      label: "Claude Code",
      path: filePath,
      servers,
      errors,
      found: false
    };
  }
  if (!parsed.data) {
    return {
      source: "claude-code",
      label: "Claude Code",
      path: filePath,
      servers,
      errors: parsed.error ? [parsed.error] : errors,
      found: true
    };
  }
  if (scope === "user") {
    copyMcpServers(parsed.data["mcpServers"], filePath, servers, errors);
  } else {
    const projectSettings = getClaudeProjectSettings(
      parsed.data["projects"],
      cwd
    );
    if (projectSettings) {
      copyMcpServers(
        projectSettings["mcpServers"],
        `${filePath} projects["${normalizeProjectPath(cwd)}"]`,
        servers,
        errors
      );
    }
  }
  return {
    source: "claude-code",
    label: "Claude Code",
    path: filePath,
    servers,
    errors,
    found: true
  };
}
__name(loadClaudeCodeJsonMcpServers, "loadClaudeCodeJsonMcpServers");
function loadClaudeCodeMcpSources(homeDir, cwd, scope) {
  const candidates = scope === "project" ? [
    loadMcpServersFromSettingsFile(
      path7.join(cwd, ".claude", "settings.json"),
      "Claude Code project settings",
      "claude-code"
    ),
    loadClaudeCodeJsonMcpServers(homeDir, cwd, scope)
  ] : [
    loadClaudeCodeJsonMcpServers(homeDir, cwd, scope),
    loadMcpServersFromSettingsFile(
      path7.join(homeDir, ".claude", "settings.json"),
      "Claude Code global settings",
      "claude-code"
    )
  ];
  const seen = /* @__PURE__ */ new Set();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.path)) {
      return false;
    }
    seen.add(candidate.path);
    return true;
  });
}
__name(loadClaudeCodeMcpSources, "loadClaudeCodeMcpSources");
function loadClaudeDesktopMcpServers(homeDir, platform2, env) {
  const filePath = getClaudeDesktopConfigPath(homeDir, platform2, env);
  const errors = [];
  const servers = emptyServerRecord();
  const parsed = readJsonObject(filePath);
  if (!parsed.found) {
    return {
      source: "claude-desktop",
      label: "Claude Desktop",
      path: filePath,
      servers,
      errors,
      found: false
    };
  }
  if (!parsed.data) {
    return {
      source: "claude-desktop",
      label: "Claude Desktop",
      path: filePath,
      servers,
      errors: parsed.error ? [parsed.error] : errors,
      found: true
    };
  }
  copyMcpServers(parsed.data["mcpServers"], filePath, servers, errors);
  return {
    source: "claude-desktop",
    label: "Claude Desktop",
    path: filePath,
    servers,
    errors,
    found: true
  };
}
__name(loadClaudeDesktopMcpServers, "loadClaudeDesktopMcpServers");
function loadClaudeMcpSources(options) {
  const homeDir = options.homeDir ?? os3.homedir();
  const cwd = options.cwd ?? process.cwd();
  const platform2 = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const scope = options.scope ?? "user";
  const sources = options.source === "all" ? ["claude-code", "claude-desktop"] : [options.source];
  return sources.flatMap(
    (source) => source === "claude-code" ? loadClaudeCodeMcpSources(homeDir, cwd, scope) : [loadClaudeDesktopMcpServers(homeDir, platform2, env)]
  );
}
__name(loadClaudeMcpSources, "loadClaudeMcpSources");
function getSettingScope(settings, scope) {
  if (scope === "user") {
    return "User" /* User */;
  }
  if (settings.workspace.path === settings.user.path) {
    throw new Error(
      "Please use --scope user to edit settings in the home directory."
    );
  }
  return "Workspace" /* Workspace */;
}
__name(getSettingScope, "getSettingScope");
function addServerNamesFromRecord(value, names) {
  if (!isRecord(value)) {
    return;
  }
  for (const name of Object.keys(value)) {
    names.add(name);
  }
}
__name(addServerNamesFromRecord, "addServerNamesFromRecord");
function copyExistingServers(settings, settingScope) {
  const existingServers = settings.forScope(settingScope).settings.mcpServers;
  const existingNames = /* @__PURE__ */ new Set();
  if (existingServers === void 0) {
    addServerNamesFromRecord(settings.merged?.mcpServers, existingNames);
    return { nextServers: emptyServerRecord(), existingNames };
  }
  if (!isRecord(existingServers)) {
    throw new Error("Existing mcpServers setting must be an object.");
  }
  const copy = emptyServerRecord();
  for (const [name, serverConfig] of Object.entries(existingServers)) {
    copy[name] = serverConfig;
    existingNames.add(name);
  }
  addServerNamesFromRecord(settings.merged?.mcpServers, existingNames);
  return { nextServers: copy, existingNames };
}
__name(copyExistingServers, "copyExistingServers");
function importClaudeMcpServers(options) {
  const settingScope = getSettingScope(options.settings, options.scope);
  const { nextServers, existingNames } = copyExistingServers(
    options.settings,
    settingScope
  );
  const scanned = loadClaudeMcpSources(options);
  const imported = [];
  const skipped = [];
  const errors = scanned.flatMap((source) => source.errors);
  for (const source of scanned) {
    for (const [name, serverConfig] of Object.entries(source.servers)) {
      if (isReservedServerName(name)) {
        skipped.push({ name, source: source.label, reason: "reserved-name" });
        continue;
      }
      if (existingNames.has(name)) {
        skipped.push({ name, source: source.label, reason: "already-exists" });
        continue;
      }
      nextServers[name] = serverConfig;
      existingNames.add(name);
      imported.push({ name, source: source.label });
    }
  }
  if (imported.length > 0) {
    options.settings.setValue(settingScope, "mcpServers", nextServers);
  }
  return {
    scope: options.scope,
    settingScope,
    scanned,
    imported,
    skipped,
    errors
  };
}
__name(importClaudeMcpServers, "importClaudeMcpServers");

// packages/cli/src/ui/commands/importConfigCommand.ts
var SOURCE_ALIASES = {
  all: "all",
  claude: "claude-code",
  "claude-code": "claude-code",
  code: "claude-code",
  desktop: "claude-desktop",
  "claude-desktop": "claude-desktop"
};
function parseSource(value) {
  return SOURCE_ALIASES[value.toLowerCase()];
}
__name(parseSource, "parseSource");
function parseScope(value) {
  if (value === "user" || value === "project") {
    return value;
  }
  return void 0;
}
__name(parseScope, "parseScope");
function parseImportConfigArgs(args) {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  let source = "all";
  let sourceWasSet = false;
  let scope = "user";
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--help" || token === "-h" || token === "help") {
      return { source, sourceExplicit: sourceWasSet, scope, help: true };
    }
    if (token === "--from") {
      const value = tokens[++i];
      if (!value) {
        return {
          source,
          sourceExplicit: sourceWasSet,
          scope,
          help: false,
          error: t("Missing value for --from.")
        };
      }
      const parsed2 = parseSource(value);
      if (!parsed2) {
        return {
          source,
          sourceExplicit: sourceWasSet,
          scope,
          help: false,
          error: t("Unknown import source: {{source}}", { source: value })
        };
      }
      source = parsed2;
      sourceWasSet = true;
      continue;
    }
    if (token.startsWith("--from=")) {
      const value = token.slice("--from=".length);
      const parsed2 = parseSource(value);
      if (!parsed2) {
        return {
          source,
          sourceExplicit: sourceWasSet,
          scope,
          help: false,
          error: t("Unknown import source: {{source}}", { source: value })
        };
      }
      source = parsed2;
      sourceWasSet = true;
      continue;
    }
    if (token === "--scope" || token === "-s") {
      const value = tokens[++i];
      const parsed2 = value ? parseScope(value) : void 0;
      if (!parsed2) {
        return {
          source,
          sourceExplicit: sourceWasSet,
          scope,
          help: false,
          error: t('Expected --scope to be "user" or "project".')
        };
      }
      scope = parsed2;
      continue;
    }
    if (token.startsWith("--scope=")) {
      const value = token.slice("--scope=".length);
      const parsed2 = parseScope(value);
      if (!parsed2) {
        return {
          source,
          sourceExplicit: sourceWasSet,
          scope,
          help: false,
          error: t('Expected --scope to be "user" or "project".')
        };
      }
      scope = parsed2;
      continue;
    }
    const parsed = parseSource(token);
    if (parsed && !sourceWasSet) {
      source = parsed;
      sourceWasSet = true;
      continue;
    }
    return {
      source,
      sourceExplicit: sourceWasSet,
      scope,
      help: false,
      error: t("Unknown argument: {{arg}}", { arg: token })
    };
  }
  return { source, sourceExplicit: sourceWasSet, scope, help: false };
}
__name(parseImportConfigArgs, "parseImportConfigArgs");
function resolveImportSourceForScope(source, scope, sourceExplicit) {
  if (scope === "project" && source === "all" && !sourceExplicit) {
    return "claude-code";
  }
  return source;
}
__name(resolveImportSourceForScope, "resolveImportSourceForScope");
function usage() {
  return [
    t("Import MCP servers from Claude configs."),
    "",
    t(
      "Usage: /import-config [all|claude-code|claude-desktop] [--scope user|project]"
    ),
    "",
    t("Examples:"),
    "  /import-config",
    "  /import-config claude-code",
    "  /import-config claude-desktop --scope user",
    "  /import-config --scope project"
  ].join("\n");
}
__name(usage, "usage");
function formatNameList(names) {
  if (names.length <= 6) {
    return names.join(", ");
  }
  return `${names.slice(0, 6).join(", ")} +${names.length - 6} more`;
}
__name(formatNameList, "formatNameList");
function formatClaudeMcpImportResult(result) {
  const target = result.scope === "user" ? "user" : "project";
  const importedNames = result.imported.map((entry) => entry.name);
  const skippedExisting = result.skipped.filter((entry) => entry.reason === "already-exists").map((entry) => entry.name);
  const skippedReserved = result.skipped.filter((entry) => entry.reason === "reserved-name").map((entry) => entry.name);
  const checkedPaths = result.scanned.map((entry) => entry.path);
  const lines = [];
  if (result.imported.length > 0) {
    lines.push(
      t("Imported {{count}} MCP server(s) to {{scope}} settings: {{names}}", {
        count: String(result.imported.length),
        scope: target,
        names: formatNameList(importedNames)
      })
    );
  } else {
    lines.push(
      t("No new Claude MCP servers imported into {{scope}} settings.", {
        scope: target
      })
    );
  }
  if (skippedExisting.length > 0) {
    lines.push(
      t("Skipped existing server(s): {{names}}", {
        names: formatNameList([...new Set(skippedExisting)])
      })
    );
  }
  if (skippedReserved.length > 0) {
    lines.push(
      t("Skipped unsupported server name(s): {{names}}", {
        names: formatNameList([...new Set(skippedReserved)])
      })
    );
  }
  if (result.errors.length > 0) {
    lines.push("", t("Warnings:"));
    lines.push(...result.errors.map((error) => `  - ${error}`));
  }
  if (result.imported.length === 0 && result.skipped.length === 0 && result.errors.length === 0) {
    lines.push("", t("Checked:"));
    lines.push(...checkedPaths.map((filePath) => `  - ${filePath}`));
  }
  const messageType = result.errors.length > 0 || result.skipped.length > 0 ? "warning" : "info";
  return {
    type: "message",
    messageType,
    content: lines.join("\n")
  };
}
__name(formatClaudeMcpImportResult, "formatClaudeMcpImportResult");
var importConfigCommand = {
  name: "import-config",
  get description() {
    return t("Import MCP servers from Claude configs");
  },
  argumentHint: "[all|claude-code|claude-desktop] [--scope user|project]",
  examples: [
    "/import-config",
    "/import-config claude-code",
    "/import-config claude-desktop --scope user",
    "/import-config --scope project"
  ],
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "non_interactive", "acp"],
  action: /* @__PURE__ */ __name(async (context, args) => {
    const parsed = parseImportConfigArgs(args);
    if (parsed.help) {
      return {
        type: "message",
        messageType: "info",
        content: usage()
      };
    }
    if (parsed.error) {
      return {
        type: "message",
        messageType: "error",
        content: `${parsed.error}

${usage()}`
      };
    }
    if (parsed.scope === "project" && context.executionPolicy?.allowWorkspaceSettingsWrite === false) {
      return {
        type: "message",
        messageType: "error",
        content: t(
          "Project configuration imports are not available in this session."
        )
      };
    }
    try {
      const importSource = resolveImportSourceForScope(
        parsed.source,
        parsed.scope,
        parsed.sourceExplicit
      );
      const result = importClaudeMcpServers({
        source: importSource,
        scope: parsed.scope,
        settings: context.services.settings,
        cwd: context.services.config?.getTargetDir() ?? process.cwd()
      });
      return formatClaudeMcpImportResult(result);
    } catch (error) {
      return {
        type: "message",
        messageType: "error",
        content: error instanceof Error ? error.message : t("Import failed: {{error}}", {
          error: String(error)
        })
      };
    }
  }, "action"),
  completion: /* @__PURE__ */ __name(async (_context, partialArg) => {
    const current = partialArg.trimStart();
    const candidates = [
      "all",
      "claude-code",
      "claude-desktop",
      "--scope user",
      "--scope project"
    ];
    return candidates.filter((candidate) => candidate.startsWith(current));
  }, "completion")
};

// packages/cli/src/ui/commands/initCommand.ts
init_esbuild_shims();
import * as fs7 from "node:fs";
import * as path8 from "node:path";
var initCommand = {
  name: "init",
  get description() {
    return t("Analyzes the project and creates a tailored QWEN.md file.");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "non_interactive", "acp"],
  action: /* @__PURE__ */ __name(async (context, _args) => {
    if (!context.services.config) {
      return {
        type: "message",
        messageType: "error",
        content: t("Configuration not available.")
      };
    }
    const targetDir = context.services.config.getTargetDir();
    const contextFileName = getCurrentMemoryFilename();
    const contextFilePath = path8.join(targetDir, contextFileName);
    try {
      if (fs7.existsSync(contextFilePath)) {
        let existing = "";
        try {
          existing = fs7.readFileSync(contextFilePath, "utf8");
        } catch {
        }
        if (existing && existing.trim().length > 0) {
          if (!context.overwriteConfirmed) {
            const [{ Text }, { default: React }] = await Promise.all([
              import("./build-5OQN7CDU.js"),
              import("./react-SG7JAQSZ.js")
            ]);
            return {
              type: "confirm_action",
              prompt: React.createElement(
                Text,
                null,
                `A ${contextFileName} file already exists in this directory. Do you want to regenerate it?`
              ),
              originalInvocation: {
                raw: context.invocation?.raw || "/init"
              }
            };
          }
        }
      }
      try {
        fs7.writeFileSync(contextFilePath, "", "utf8");
        context.ui.addItem(
          {
            type: "info",
            text: `Empty ${contextFileName} created. Now analyzing the project to populate it.`
          },
          Date.now()
        );
      } catch (err) {
        return {
          type: "message",
          messageType: "error",
          content: `Failed to create ${contextFileName}: ${err instanceof Error ? err.message : String(err)}`
        };
      }
    } catch (error) {
      return {
        type: "message",
        messageType: "error",
        content: `Unexpected error preparing ${contextFileName}: ${error instanceof Error ? error.message : String(error)}`
      };
    }
    return {
      type: "submit_prompt",
      content: `
You are Qwen Code, an interactive CLI agent. Analyze the current directory and generate a comprehensive ${contextFileName} file to be used as instructional context for future interactions.

**Analysis Process:**

1.  **Initial Exploration:**
    *   Start by listing the files and directories to get a high-level overview of the structure.
    *   Read the README file (e.g., \`README.md\`, \`README.txt\`) if it exists. This is often the best place to start.

2.  **Iterative Deep Dive (up to 10 files):**
    *   Based on your initial findings, select a few files that seem most important (e.g., configuration files, main source files, documentation).
    *   Read them. As you learn more, refine your understanding and decide which files to read next. You don't need to decide all 10 files at once. Let your discoveries guide your exploration.

3.  **Identify Project Type:**
    *   **Code Project:** Look for clues like \`package.json\`, \`requirements.txt\`, \`pom.xml\`, \`go.mod\`, \`Cargo.toml\`, \`build.gradle\`, or a \`src\` directory. If you find them, this is likely a software project.
    *   **Non-Code Project:** If you don't find code-related files, this might be a directory for documentation, research papers, notes, or something else.

**${contextFileName} Content Generation:**

**For a Code Project:**

*   **Project Overview:** Write a clear and concise summary of the project's purpose, main technologies, and architecture.
*   **Building and Running:** Document the key commands for building, running, and testing the project. Infer these from the files you've read (e.g., \`scripts\` in \`package.json\`, \`Makefile\`, etc.). If you can't find explicit commands, provide a placeholder with a TODO.
*   **Development Conventions:** Describe any coding styles, testing practices, or contribution guidelines you can infer from the codebase.

**For a Non-Code Project:**

*   **Directory Overview:** Describe the purpose and contents of the directory. What is it for? What kind of information does it hold?
*   **Key Files:** List the most important files and briefly explain what they contain.
*   **Usage:** Explain how the contents of this directory are intended to be used.

**Final Output:**

Write the complete content to the \`${contextFileName}\` file. The output must be well-formatted Markdown.
`
    };
  }, "action")
};

// packages/cli/src/ui/commands/languageCommand.ts
init_esbuild_shims();
var debugLogger12 = createDebugLogger("LANGUAGE_COMMAND");
function getCurrentOutputLanguage(context) {
  const settingValue = context?.services?.settings?.merged?.general?.outputLanguage || OUTPUT_LANGUAGE_AUTO;
  const resolved = resolveOutputLanguageOrPreserveAuto(settingValue);
  return { setting: settingValue, resolved };
}
__name(getCurrentOutputLanguage, "getCurrentOutputLanguage");
function parseUiLanguageArg(input) {
  return resolveSupportedLanguage(input) ?? null;
}
__name(parseUiLanguageArg, "parseUiLanguageArg");
function formatUiLanguageDisplay(lang) {
  const option = SUPPORTED_LANGUAGES.find((o) => o.code === lang);
  if (!option) return lang;
  return option.nativeName && option.nativeName !== option.fullName ? `${option.nativeName} (${option.fullName}) [${option.id}]` : `${option.fullName} [${option.id}]`;
}
__name(formatUiLanguageDisplay, "formatUiLanguageDisplay");
function parseUiScopeFlags(input) {
  let remaining = input;
  const hasProject = /(?:^|\s)--project(?:\s|$)/.test(remaining);
  const hasGlobal = /(?:^|\s)--global(?:\s|$)/.test(remaining);
  let scope;
  if (hasProject) {
    scope = "Workspace" /* Workspace */;
    remaining = remaining.replace(/(?:^|\s)--project(?:\s|$)/, " ").trim();
  }
  if (hasGlobal) {
    scope = "User" /* User */;
    remaining = remaining.replace(/(?:^|\s)--global(?:\s|$)/, " ").trim();
  }
  return { scope, remaining, hasProject, hasGlobal };
}
__name(parseUiScopeFlags, "parseUiScopeFlags");
function validateUiScopeFlags(context, parsed) {
  if (parsed.hasProject && parsed.hasGlobal) {
    return {
      type: "message",
      messageType: "error",
      content: t(
        "Cannot use both --project and --global. Choose one scope flag."
      )
    };
  }
  if (parsed.scope === "Workspace" /* Workspace */ && context.executionPolicy?.allowWorkspaceSettingsWrite === false) {
    return {
      type: "message",
      messageType: "error",
      content: t(
        "Project language settings are not available in this session."
      )
    };
  }
  if (parsed.scope === "Workspace" /* Workspace */ && context.services.settings && !context.services.settings.isTrusted) {
    return {
      type: "message",
      messageType: "error",
      content: t("Workspace is untrusted; run /trust first or use --global.")
    };
  }
  return void 0;
}
__name(validateUiScopeFlags, "validateUiScopeFlags");
async function setUiLanguage(context, lang, scope = "User" /* User */) {
  const { services } = context;
  if (!services.config) {
    return {
      type: "message",
      messageType: "error",
      content: t("Configuration not available.")
    };
  }
  if (services.settings?.setValue) {
    try {
      services.settings.setValue(scope, "general.language", lang, void 0, {
        throwOnWriteFailure: true
      });
    } catch (error) {
      debugLogger12.warn("Failed to save language setting:", error);
      return {
        type: "message",
        messageType: "error",
        content: t('Failed to set "{{key}}": {{error}}', {
          key: "general.language",
          error: error instanceof Error ? error.message : String(error)
        })
      };
    }
  }
  await setLanguageAsync(lang);
  context.ui.reloadCommands();
  return {
    type: "message",
    messageType: "info",
    content: t("UI language changed to {{lang}}", {
      lang: formatUiLanguageDisplay(lang)
    })
  };
}
__name(setUiLanguage, "setUiLanguage");
async function setOutputLanguage(context, language) {
  try {
    const isAuto = isAutoLanguage(language);
    const resolved = resolveOutputLanguageOrPreserveAuto(language);
    const settingValue = isAuto ? OUTPUT_LANGUAGE_AUTO : resolved;
    writeOutputLanguageAndRegisterPath(settingValue, context.services.config);
    if (context.services.settings?.setValue) {
      try {
        context.services.settings.setValue(
          "User" /* User */,
          "general.outputLanguage",
          settingValue
        );
      } catch (error) {
        debugLogger12.warn("Failed to save output language setting:", error);
      }
    }
    const config = context.services.config;
    if (config) {
      try {
        await config.refreshHierarchicalMemory();
        await config.getLlmClient().refreshSystemInstruction();
      } catch (error) {
        debugLogger12.warn(
          "Failed to apply output language to running session:",
          error
        );
      }
    }
    const displayLang = isAuto ? t("Auto (follow user input)") : resolved;
    return {
      type: "message",
      messageType: "info",
      content: t("LLM output language set to {{lang}}", { lang: displayLang })
    };
  } catch (error) {
    return {
      type: "message",
      messageType: "error",
      content: t(
        "Failed to generate LLM output language rule file: {{error}}",
        {
          error: error instanceof Error ? error.message : String(error)
        }
      )
    };
  }
}
__name(setOutputLanguage, "setOutputLanguage");
var languageCommand = {
  name: "language",
  get description() {
    return t("View or change the language setting");
  },
  argumentHint: "ui|output <language>",
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "non_interactive", "acp"],
  action: /* @__PURE__ */ __name(async (context, args) => {
    if (!context.services.config) {
      return {
        type: "message",
        messageType: "error",
        content: t("Configuration not available.")
      };
    }
    const trimmedArgs = args.trim();
    if (trimmedArgs) {
      const [firstArg, ...rest] = trimmedArgs.split(/\s+/);
      const subCommandName = firstArg.toLowerCase();
      const subArgs = rest.join(" ");
      if (subCommandName === "ui" || subCommandName === "output") {
        const subCommand = languageCommand.subCommands?.find(
          (s) => s.name === subCommandName
        );
        if (subCommand?.action) {
          return subCommand.action(
            context,
            subArgs
          );
        }
      }
      const targetLang = parseUiLanguageArg(trimmedArgs);
      if (targetLang) {
        return setUiLanguage(context, targetLang);
      }
      return {
        type: "message",
        messageType: "error",
        content: [
          t("Invalid command. Available subcommands:"),
          `  - /language ui [${getSupportedLanguageIds()}] - ${t("Set UI language")}`,
          `  - /language output <language> - ${t("Set LLM output language")}`
        ].join("\n")
      };
    }
    const currentUiLang = getCurrentLanguage();
    const { setting: outputSetting, resolved: outputResolved } = getCurrentOutputLanguage(context);
    const outputLangDisplay = isAutoLanguage(outputSetting) ? t("Auto (follow user input)") : outputResolved;
    return {
      type: "message",
      messageType: "info",
      content: [
        t("Current UI language: {{lang}}", {
          lang: formatUiLanguageDisplay(currentUiLang)
        }),
        t("Current LLM output language: {{lang}}", { lang: outputLangDisplay }),
        "",
        t("Available subcommands:"),
        `  /language ui [${getSupportedLanguageIds()}] - ${t("Set UI language")}`,
        `  /language output <language> - ${t("Set LLM output language")}`
      ].join("\n")
    };
  }, "action"),
  subCommands: [
    // /language ui subcommand
    {
      name: "ui",
      get description() {
        return t("Set UI language");
      },
      kind: "built-in" /* BUILT_IN */,
      supportedModes: ["interactive", "non_interactive", "acp"],
      action: /* @__PURE__ */ __name(async (context, args) => {
        const parsed = parseUiScopeFlags(args.trim());
        const scopeError = validateUiScopeFlags(context, parsed);
        if (scopeError) {
          return scopeError;
        }
        const trimmedArgs = parsed.remaining;
        if (!trimmedArgs) {
          return {
            type: "message",
            messageType: "info",
            content: [
              t("Set UI language"),
              "",
              t("Usage: /language ui [{{options}}]", {
                options: getSupportedLanguageIds()
              }),
              "",
              t("Available options:"),
              ...SUPPORTED_LANGUAGES.map(
                (o) => `  - ${o.id}: ${o.nativeName || o.fullName}`
              ),
              "",
              t(
                "To request additional UI language packs, please open an issue on GitHub."
              )
            ].join("\n")
          };
        }
        const targetLang = parseUiLanguageArg(trimmedArgs);
        if (!targetLang) {
          return {
            type: "message",
            messageType: "error",
            content: t("Invalid language. Available: {{options}}", {
              options: getSupportedLanguageIds(",")
            })
          };
        }
        return setUiLanguage(context, targetLang, parsed.scope);
      }, "action"),
      // Nested subcommands for each supported language (e.g., /language ui zh-CN)
      subCommands: SUPPORTED_LANGUAGES.map(
        (lang) => ({
          name: lang.id,
          get description() {
            return t("Set UI language to {{name}}", {
              name: lang.nativeName || lang.fullName
            });
          },
          kind: "built-in" /* BUILT_IN */,
          supportedModes: ["interactive", "non_interactive", "acp"],
          action: /* @__PURE__ */ __name(async (context, args) => {
            const parsed = parseUiScopeFlags(args.trim());
            const scopeError = validateUiScopeFlags(context, parsed);
            if (scopeError) {
              return scopeError;
            }
            if (parsed.remaining) {
              return {
                type: "message",
                messageType: "error",
                content: t(
                  "Language subcommands do not accept additional arguments."
                )
              };
            }
            return setUiLanguage(context, lang.code, parsed.scope);
          }, "action")
        })
      )
    },
    // /language output subcommand
    {
      name: "output",
      get description() {
        return t("Set LLM output language");
      },
      kind: "built-in" /* BUILT_IN */,
      supportedModes: ["interactive", "non_interactive", "acp"],
      action: /* @__PURE__ */ __name(async (context, args) => {
        const trimmedArgs = args.trim();
        if (!trimmedArgs) {
          return {
            type: "message",
            messageType: "info",
            content: [
              t("Set LLM output language"),
              "",
              t("Usage: /language output <language>"),
              `  ${t("Example: /language output \u4E2D\u6587")}`,
              `  ${t("Example: /language output English")}`,
              `  ${t("Example: /language output \u65E5\u672C\u8A9E")}`
            ].join("\n")
          };
        }
        return setOutputLanguage(context, trimmedArgs);
      }, "action")
    }
  ]
};

// packages/cli/src/ui/commands/mcpCommand.ts
init_esbuild_shims();
var mcpCommand = {
  name: "mcp",
  get description() {
    return t("Open MCP management dialog");
  },
  argumentHint: "desc|nodesc|schema",
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive"],
  action: /* @__PURE__ */ __name(async (_context, args = "") => {
    const [subcommand, serverName] = args.trim().split(/\s+/);
    if (subcommand === "auth" || subcommand === "noauth") {
      return {
        type: "message",
        messageType: "warning",
        content: serverName ? t(
          "MCP OAuth is now managed in the /mcp dialog. Open /mcp, select '{{serverName}}', then use the Auth actions there.",
          { serverName }
        ) : t(
          "MCP OAuth is now managed in the /mcp dialog. Open /mcp, select a server, then use the Auth actions there."
        )
      };
    }
    return {
      type: "dialog",
      dialog: "mcp"
    };
  }, "action")
};

// packages/cli/src/ui/commands/dreamCommand.ts
init_esbuild_shims();
import * as path9 from "node:path";
var dreamCommand = {
  name: "dream",
  get description() {
    return t("Consolidate managed auto-memory topic files.");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "acp"],
  action: /* @__PURE__ */ __name(async (context) => {
    const config = context.services.config;
    if (!config) {
      return {
        type: "message",
        messageType: "error",
        content: t("Config not loaded.")
      };
    }
    try {
      const projectRoot = config.getProjectRoot();
      const memoryRoot = getAutoMemoryRoot(projectRoot);
      const transcriptDir = path9.join(
        new Storage(projectRoot).getProjectDir(),
        "chats"
      );
      const prompt = config.getMemoryManager().buildConsolidationPrompt(memoryRoot, transcriptDir);
      const recordDream = /* @__PURE__ */ __name(async () => config.getMemoryManager().writeDreamManualRun(projectRoot, config.getSessionId()), "recordDream");
      if (context.executionMode === "acp") {
        recordDream().catch(() => {
        });
        return { type: "submit_prompt", content: prompt };
      }
      return {
        type: "submit_prompt",
        content: prompt,
        onComplete: recordDream
      };
    } catch (error) {
      return {
        type: "message",
        messageType: "error",
        content: t("Failed to process /dream: {{message}}", {
          message: error instanceof Error ? error.message : String(error)
        })
      };
    }
  }, "action")
};

// packages/cli/src/ui/commands/forgetCommand.ts
init_esbuild_shims();
var forgetCommand = {
  name: "forget",
  get description() {
    return t("Remove matching entries from managed auto-memory.");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "acp"],
  argumentHint: "<memory text to remove>",
  action: /* @__PURE__ */ __name(async (context, args) => {
    const query = args.trim();
    if (!query) {
      return {
        type: "message",
        messageType: "error",
        content: t("Usage: /forget <memory text to remove>")
      };
    }
    const config = context.services.config;
    if (!config) {
      return {
        type: "message",
        messageType: "error",
        content: t("Config not loaded.")
      };
    }
    try {
      const selection = await config.getMemoryManager().selectForgetCandidates(config.getProjectRoot(), query, { config });
      const result = await config.getMemoryManager().forgetMatches(config.getProjectRoot(), selection.matches);
      return {
        type: "message",
        messageType: "info",
        content: result.systemMessage ?? t("No managed auto-memory entries matched: {{query}}", { query })
      };
    } catch (error) {
      return {
        type: "message",
        messageType: "error",
        content: t("Failed to process /forget: {{message}}", {
          message: error instanceof Error ? error.message : String(error)
        })
      };
    }
  }, "action")
};

// packages/cli/src/ui/commands/memoryCommand.ts
init_esbuild_shims();
var memoryCommand = {
  name: "memory",
  get description() {
    return t("Open the memory manager.");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive"],
  action: /* @__PURE__ */ __name(async () => ({
    type: "dialog",
    dialog: "memory"
  }), "action")
};

// packages/cli/src/ui/commands/modelCommand.ts
init_esbuild_shims();

// packages/cli/src/ui/voice/voice-model.ts
init_esbuild_shims();

// packages/cli/src/ui/commands/modelCommand.ts
var MAIN_MODEL_CONFIGURATION_HINT = "Configure models in settings.modelProviders and ensure the required environment variables are set. In interactive mode, run /auth to configure or switch providers, or run /model without arguments to choose from configured models.";
var FAST_MODEL_CONFIGURATION_HINT = "Configure models in settings.modelProviders and ensure the required environment variables are set. In interactive mode, run /auth to configure or switch providers, or run /model --fast without a model to choose from configured models.";
var VISION_MODEL_CONFIGURATION_HINT = "Configure an image-capable model in settings.modelProviders and ensure the required environment variables are set. Run /model --vision <model-id> to set it, or leave it unset to auto-pick a same-provider vision model.";
var COMPACTION_MODEL_CONFIGURATION_HINT = "Configure models in settings.modelProviders and ensure the required environment variables are set. In interactive mode, run /auth to configure or switch providers, or run /model --compaction without a model to choose from configured models.";
var IMAGE_MODEL_CONFIGURATION_HINT = "Configure a model with supportsImageGeneration: true (or legacy imageOnly: true), baseUrl, and envKey in settings.modelProviders. Run /model --image <model-id> to select it.";
var MODEL_PICKER_FLAGS = [
  "fast",
  "voice",
  "vision",
  "compaction",
  "image",
  "project",
  "global"
];
var MODEL_PICKER_FLAG_PATTERN = `(?:${MODEL_PICKER_FLAGS.join("|")})`;
var MODEL_PICKER_ONLY_PATTERN = new RegExp(
  `^(?:\\s*--${MODEL_PICKER_FLAG_PATTERN})*\\s*$`
);
function isPickerOnlyModelInvocation(args) {
  return MODEL_PICKER_ONLY_PATTERN.test(args);
}
__name(isPickerOnlyModelInvocation, "isPickerOnlyModelInvocation");
function parseScopeFlags(args) {
  let scopeOverride;
  let remaining = args;
  const hasProject = /(?:^|\s)--project(?:\s|$)/.test(remaining);
  const hasGlobal = /(?:^|\s)--global(?:\s|$)/.test(remaining);
  if (hasProject) {
    scopeOverride = "Workspace" /* Workspace */;
    remaining = remaining.replace(/(?:^|\s)--project(?:\s|$)/, " ").trim();
  } else if (hasGlobal) {
    scopeOverride = "User" /* User */;
    remaining = remaining.replace(/(?:^|\s)--global(?:\s|$)/, " ").trim();
  }
  return { scopeOverride, remaining, hasProject, hasGlobal };
}
__name(parseScopeFlags, "parseScopeFlags");
function resolveScope(settings, scopeOverride) {
  return scopeOverride ?? getPersistScopeForModelSelection(settings);
}
__name(resolveScope, "resolveScope");
function persistScopeSpread(scopeOverride) {
  if (scopeOverride === "Workspace" /* Workspace */)
    return { persistScope: "workspace" };
  if (scopeOverride === "User" /* User */)
    return { persistScope: "user" };
  return {};
}
__name(persistScopeSpread, "persistScopeSpread");
function formatVisionModelSettingForDisplay(setting) {
  const parsed = parseVisionModelSetting(setting);
  if (!parsed) return setting.replace(/\0/g, "\\0");
  return parsed.baseUrl ? `${parsed.selector} (${parsed.baseUrl})` : parsed.selector;
}
__name(formatVisionModelSettingForDisplay, "formatVisionModelSettingForDisplay");
function persistSetting(settings, path18, value, scopeOverride) {
  settings.setValue(resolveScope(settings, scopeOverride), path18, value);
}
__name(persistSetting, "persistSetting");
async function switchMainModel(config, settings, currentAuthType, modelArg, scopeOverride, persistSelection = true) {
  const parsed = parseAcpModelOption(modelArg);
  if (parsed.authType) {
    await config.switchModel(
      parsed.authType,
      parsed.modelId,
      parsed.authType !== currentAuthType && parsed.authType === "qwen-oauth" /* QWEN_OAUTH */ ? { requireCachedCredentials: true } : void 0
    );
    if (persistSelection) {
      persistSetting(
        settings,
        "security.auth.selectedType",
        parsed.authType,
        scopeOverride
      );
      persistSetting(settings, "model.name", parsed.modelId, scopeOverride);
      persistSetting(settings, "model.baseUrl", "", scopeOverride);
    }
    return parsed.modelId;
  }
  await config.switchModel(currentAuthType, modelArg, void 0);
  if (persistSelection) {
    persistSetting(settings, "model.name", modelArg, scopeOverride);
    persistSetting(settings, "model.baseUrl", "", scopeOverride);
  }
  return modelArg;
}
__name(switchMainModel, "switchMainModel");
function formatUnavailableModelMessage(kind, modelName, authType, availableModels) {
  const availableModelIds = Array.from(
    new Set(availableModels.map((model) => model.id))
  );
  const availableModelsLine = availableModelIds.length === 0 ? `No models are configured for auth type '${authType}'.` : `Available models for '${authType}': ${availableModelIds.join(", ")}.`;
  const hint = kind === "Fast model" ? FAST_MODEL_CONFIGURATION_HINT : kind === "Vision model" ? VISION_MODEL_CONFIGURATION_HINT : kind === "Compaction model" ? COMPACTION_MODEL_CONFIGURATION_HINT : kind === "Image model" ? IMAGE_MODEL_CONFIGURATION_HINT : MAIN_MODEL_CONFIGURATION_HINT;
  return `${kind} '${modelName}' is not available for auth type '${authType}'.
${availableModelsLine}
` + hint;
}
__name(formatUnavailableModelMessage, "formatUnavailableModelMessage");
function formatUnavailableAuxModelMessage(label, modelName, availableModels, hint) {
  const availableModelIds = Array.from(
    new Set(availableModels.map((model) => model.id))
  );
  const availableModelsLine = availableModelIds.length === 0 ? "No models are configured." : `Configured models: ${availableModelIds.join(", ")}.`;
  return `${label} '${modelName}' is not configured for any auth type.
${availableModelsLine}
` + hint;
}
__name(formatUnavailableAuxModelMessage, "formatUnavailableAuxModelMessage");
function formatUnavailableFastModelMessage(modelName, availableModels) {
  return formatUnavailableAuxModelMessage(
    "Fast model",
    modelName,
    availableModels,
    FAST_MODEL_CONFIGURATION_HINT
  );
}
__name(formatUnavailableFastModelMessage, "formatUnavailableFastModelMessage");
function formatUnavailableVisionModelMessage(modelName, availableModels) {
  return formatUnavailableAuxModelMessage(
    "Vision model",
    modelName,
    availableModels,
    VISION_MODEL_CONFIGURATION_HINT
  );
}
__name(formatUnavailableVisionModelMessage, "formatUnavailableVisionModelMessage");
function formatUnavailableCompactionModelMessage(modelName, availableModels) {
  return formatUnavailableAuxModelMessage(
    "Compaction model",
    modelName,
    availableModels,
    COMPACTION_MODEL_CONFIGURATION_HINT
  );
}
__name(formatUnavailableCompactionModelMessage, "formatUnavailableCompactionModelMessage");
function formatUnavailableImageModelMessage(modelName, availableModels) {
  return formatUnavailableAuxModelMessage(
    "Image model",
    modelName,
    availableModels,
    IMAGE_MODEL_CONFIGURATION_HINT
  );
}
__name(formatUnavailableImageModelMessage, "formatUnavailableImageModelMessage");
function formatAmbiguousVisionModelMessage(modelName, matchingModels) {
  const endpoints = matchingModels.map((model) => model.baseUrl ?? "(default endpoint)").join(", ");
  const qualifiedSelectors = Array.from(
    new Set(
      matchingModels.map(
        (model) => model.authType ? `${model.authType}:${model.id}` : void 0
      ).filter((selector) => selector !== void 0)
    )
  );
  const scriptedHint = qualifiedSelectors.length > 1 ? `
${t(
    "For scripts, pass an auth-qualified selector such as {{selector}}.",
    {
      selector: qualifiedSelectors[0]
    }
  )}` : "";
  return t("Vision model '{{modelName}}' matches multiple configured endpoints.", {
    modelName
  }) + "\n" + t("Matching endpoints: {{endpoints}}.", { endpoints }) + "\n" + t(
    "Run /model --vision without an argument and choose the exact endpoint."
  ) + scriptedHint;
}
__name(formatAmbiguousVisionModelMessage, "formatAmbiguousVisionModelMessage");
function formatNonVisionModelWarning(modelName) {
  return t(
    "\u26A0 '{{model}}' is not a known image-capable model; the vision bridge may fail on images.",
    { model: modelName }
  );
}
__name(formatNonVisionModelWarning, "formatNonVisionModelWarning");
function formatUnavailableVoiceModelMessage(modelName, availableModels) {
  const availableModelIds = Array.from(
    new Set(availableModels.map((model) => model.id))
  );
  const availableModelsLine = availableModelIds.length === 0 ? t("No models are configured.") : t("Configured models: {{models}}.", {
    models: availableModelIds.join(", ")
  });
  return t("Voice model '{{modelName}}' is not configured.", { modelName }) + `
${availableModelsLine}
` + t(
    "Configure a unique model id in settings.modelProviders or run /model --voice to select an available model."
  );
}
__name(formatUnavailableVoiceModelMessage, "formatUnavailableVoiceModelMessage");
function getAvailableModelIds(context, mode = "main") {
  const { services } = context;
  const { config } = services;
  if (!config) {
    return [];
  }
  const models = mode === "image" ? config.getAllConfiguredModels() : config.getAvailableModels();
  const availableModels = models.filter((m) => {
    if (mode === "image")
      return isImageGenerationCapable(m) && !m.fastOnly && !m.voiceOnly;
    if (mode === "vision") return !m.fastOnly && !m.voiceOnly && !m.imageOnly;
    if (mode === "fast") return !m.voiceOnly && !m.imageOnly && !m.visionOnly;
    if (mode === "voice") return !m.fastOnly && !m.imageOnly && !m.visionOnly;
    return !m.fastOnly && !m.voiceOnly && !m.imageOnly && !m.visionOnly;
  });
  return availableModels.map((model) => model.id);
}
__name(getAvailableModelIds, "getAvailableModelIds");
var modelCommand = {
  name: "model",
  completionPriority: 100,
  get description() {
    return t(
      "Switch the model for this session (--fast for suggestion model, --voice for voice transcription model, --vision for the vision bridge model, --compaction for chat compression model, --image for the image generation model, --project to persist to project settings, --global to persist to user settings, [model-id] to switch immediately, or [model-id] [prompt] to run a one-off prompt on another model; the inline prompt is sent verbatim without @file expansion)."
    );
  },
  argumentHint: "[--fast|--voice|--vision|--compaction|--image] [--project|--global] [<model-id>] | <model-id> <prompt>",
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "non_interactive", "acp"],
  completion: /* @__PURE__ */ __name(async (context, partialArg) => {
    if (partialArg) {
      const flagCompletions = [
        {
          value: "--fast",
          description: t(
            "Set a lighter model for prompt suggestions and speculative execution"
          )
        },
        {
          value: "--voice",
          description: t("Set the model for voice transcription")
        },
        {
          value: "--vision",
          description: t(
            "Set the image-capable model used to transcribe images for a text-only main model"
          )
        },
        {
          value: "--compaction",
          description: t(
            "Set the model used for chat compression (auto-compaction)"
          )
        },
        {
          value: "--image",
          description: t("Set the model used to generate images")
        },
        {
          value: "--project",
          description: t(
            "Persist the model selection to the project settings (workspace scope)"
          )
        },
        {
          value: "--global",
          description: t(
            "Persist the model selection to the user settings (global scope)"
          )
        }
      ].filter((item) => item.value.startsWith(partialArg));
      if (flagCompletions.length > 0) {
        return flagCompletions;
      }
      const trimmed = partialArg.trim();
      if (trimmed) {
        let mode = "main";
        const modelPrefix = trimmed.replace(/(?:^|\s)--fast(?:\s|$)/, " ").replace(/(?:^|\s)--voice(?:\s|$)/, " ").replace(/(?:^|\s)--vision(?:\s|$)/, " ").replace(/(?:^|\s)--compaction(?:\s|$)/, " ").replace(/(?:^|\s)--image(?:\s|$)/, " ").replace(/(?:^|\s)--project(?:\s|$)/, " ").replace(/(?:^|\s)--global(?:\s|$)/, " ").trim();
        if (/(?:^|\s)--fast(?:\s|$)/.test(trimmed)) mode = "fast";
        else if (/(?:^|\s)--voice(?:\s|$)/.test(trimmed)) mode = "voice";
        else if (/(?:^|\s)--vision(?:\s|$)/.test(trimmed)) mode = "vision";
        else if (/(?:^|\s)--compaction(?:\s|$)/.test(trimmed))
          mode = "compaction";
        else if (/(?:^|\s)--image(?:\s|$)/.test(trimmed)) mode = "image";
        return getAvailableModelIds(context, mode).filter(
          (id) => id.startsWith(modelPrefix)
        );
      }
      return null;
    } else {
      return null;
    }
  }, "completion"),
  action: /* @__PURE__ */ __name(async (context, actionArgs) => {
    const { services } = context;
    const { config, settings } = services;
    if (!config) {
      return {
        type: "message",
        messageType: "error",
        content: t("Configuration not available.")
      };
    }
    const rawArgs = context.invocation?.args?.trim() || actionArgs.trim();
    const {
      scopeOverride,
      remaining: args,
      hasProject,
      hasGlobal
    } = parseScopeFlags(rawArgs);
    if (hasProject && hasGlobal) {
      return {
        type: "message",
        messageType: "error",
        content: t(
          "Cannot use both --project and --global. Choose one scope flag."
        )
      };
    }
    const auxiliarySelection = /(?:^|\s)--(?:fast|voice|vision|compaction|image)(?:\s|$)/.test(rawArgs);
    if (hasProject && context.executionPolicy?.allowWorkspaceSettingsWrite === false || context.executionPolicy?.persistModelSelection === false && (hasProject || hasGlobal || auxiliarySelection)) {
      return {
        type: "message",
        messageType: "error",
        content: t("This model selection is not available in this session.")
      };
    }
    if (scopeOverride === "Workspace" /* Workspace */ && settings && !settings.isTrusted) {
      return {
        type: "message",
        messageType: "error",
        content: t("Workspace is untrusted; run /trust first or use --global.")
      };
    }
    const scopeSuffix = scopeOverride === "Workspace" /* Workspace */ ? t(" (this project)") : scopeOverride === "User" /* User */ ? t(" (global)") : "";
    const isVoiceModelCommand = args === "--voice" || args.startsWith("--voice ");
    if (isVoiceModelCommand) {
      const modelName2 = args.replace("--voice", "").trim();
      if (!modelName2) {
        if (context.executionMode !== "interactive") {
          const voiceModel = context.services.settings?.merged?.voiceModel?.trim() || t("not set");
          return {
            type: "message",
            messageType: "info",
            content: t(
              'Current voice model: {{voiceModel}}\nUse "/model --voice <model-id>" to set voice model.',
              { voiceModel }
            )
          };
        }
        return {
          type: "dialog",
          dialog: "voice-model",
          ...persistScopeSpread(scopeOverride)
        };
      }
      if (!settings) {
        return {
          type: "message",
          messageType: "error",
          content: t("Settings service not available.")
        };
      }
      const availableModels = config.getAllConfiguredModels().filter((m) => !m.fastOnly && !m.imageOnly && !m.visionOnly);
      const matches = availableModels.filter((model) => model.id === modelName2);
      if (matches.length === 0) {
        return {
          type: "message",
          messageType: "error",
          content: formatUnavailableVoiceModelMessage(
            modelName2,
            availableModels
          )
        };
      }
      if (matches.length > 1) {
        return {
          type: "message",
          messageType: "error",
          content: t(
            "Voice model '{{modelName}}' is ambiguous. Configure a unique model id before using /model --voice.",
            { modelName: modelName2 }
          )
        };
      }
      if (!isSelectableVoiceModel(matches[0])) {
        return {
          type: "message",
          messageType: "error",
          content: formatUnsupportedVoiceModelMessage(modelName2)
        };
      }
      persistSetting(settings, "voiceModel", modelName2, scopeOverride);
      return {
        type: "message",
        messageType: "info",
        content: t("Voice Model") + ": " + modelName2 + scopeSuffix
      };
    }
    const isFastModelCommand = args === "--fast" || args.startsWith("--fast ");
    if (isFastModelCommand) {
      const modelName2 = args.replace("--fast", "").trim();
      if (!modelName2) {
        if (context.executionMode !== "interactive") {
          const fastModel = context.services.settings?.merged?.fastModel ?? "not set";
          return {
            type: "message",
            messageType: "info",
            content: `Current fast model: ${fastModel}
Use "/model --fast <model-id>" to set fast model.`
          };
        }
        return {
          type: "dialog",
          dialog: "fast-model",
          ...persistScopeSpread(scopeOverride)
        };
      }
      if (!settings) {
        return {
          type: "message",
          messageType: "error",
          content: t("Settings service not available.")
        };
      }
      const contentGeneratorConfig2 = config.getContentGeneratorConfig();
      const authType2 = contentGeneratorConfig2?.authType;
      if (!authType2) {
        return {
          type: "message",
          messageType: "error",
          content: t("Authentication type not available.")
        };
      }
      const selector = (() => {
        try {
          return resolveModelId(modelName2);
        } catch {
          return void 0;
        }
      })();
      if (!selector) {
        return {
          type: "message",
          messageType: "error",
          content: formatUnavailableFastModelMessage(modelName2, [])
        };
      }
      const availableModels = (selector.authType ? config.getAvailableModelsForAuthType(selector.authType) : config.getAllConfiguredModels()).filter((m) => !m.voiceOnly && !m.imageOnly && !m.visionOnly);
      if (!availableModels.some((model) => model.id === selector.modelId)) {
        return {
          type: "message",
          messageType: "error",
          content: selector.authType ? formatUnavailableModelMessage(
            "Fast model",
            selector.modelId,
            selector.authType,
            availableModels
          ) : formatUnavailableFastModelMessage(modelName2, availableModels)
        };
      }
      persistSetting(settings, "fastModel", modelName2, scopeOverride);
      config.setFastModel(modelName2);
      return {
        type: "message",
        messageType: "info",
        content: t("Fast Model") + ": " + modelName2 + scopeSuffix
      };
    }
    const isVisionModelCommand = args === "--vision" || args.startsWith("--vision ");
    if (isVisionModelCommand) {
      const modelName2 = args.replace("--vision", "").trim();
      if (!modelName2) {
        if (context.executionMode !== "interactive") {
          const visionModel2 = context.services.settings?.merged?.visionModel?.trim();
          return {
            type: "message",
            messageType: "info",
            content: t(
              'Current vision model: {{visionModel}}\nUse "/model --vision <model-id>" to set the vision bridge model.',
              {
                visionModel: visionModel2 ? formatVisionModelSettingForDisplay(visionModel2) : t("not set")
              }
            )
          };
        }
        return {
          type: "dialog",
          dialog: "vision-model",
          ...persistScopeSpread(scopeOverride)
        };
      }
      if (!settings) {
        return {
          type: "message",
          messageType: "error",
          content: t("Settings service not available.")
        };
      }
      const selector = (() => {
        try {
          return resolveModelId(modelName2);
        } catch {
          return void 0;
        }
      })();
      if (!selector) {
        return {
          type: "message",
          messageType: "error",
          content: formatUnavailableVisionModelMessage(modelName2, [])
        };
      }
      const availableModels = (selector.authType ? config.getAvailableModelsForAuthType(selector.authType) : config.getAllConfiguredModels()).filter((m) => !m.fastOnly && !m.voiceOnly && !m.imageOnly);
      const matchingModels = availableModels.filter(
        (model) => model.id === selector.modelId
      );
      if (matchingModels.length > 1) {
        return {
          type: "message",
          messageType: "error",
          content: formatAmbiguousVisionModelMessage(modelName2, matchingModels)
        };
      }
      const matched = matchingModels[0];
      if (!matched) {
        return {
          type: "message",
          messageType: "error",
          content: selector.authType ? formatUnavailableModelMessage(
            "Vision model",
            selector.modelId,
            selector.authType,
            availableModels
          ) : formatUnavailableVisionModelMessage(modelName2, availableModels)
        };
      }
      if (config.isCurrentPrimaryModel(matched)) {
        return {
          type: "message",
          messageType: "error",
          content: t(
            "'{{model}}' is the current primary model and cannot be used as the vision bridge. Choose a different image-capable model.",
            { model: modelName2 }
          )
        };
      }
      const qualifiedModelName = `${selector.authType ?? matched.authType}:${selector.modelId}`;
      const visionModel = matched.baseUrl ? `${qualifiedModelName}\0${matched.baseUrl}` : qualifiedModelName;
      persistSetting(settings, "visionModel", visionModel, scopeOverride);
      config.setVisionModel(visionModel);
      const visionWarning = isImageCapable(matched) ? "" : `
${formatNonVisionModelWarning(modelName2)}`;
      return {
        type: "message",
        messageType: "info",
        content: t("Vision Model") + ": " + modelName2 + scopeSuffix + visionWarning
      };
    }
    const isCompactionModelCommand = args === "--compaction" || args.startsWith("--compaction ");
    if (isCompactionModelCommand) {
      const modelName2 = args.replace("--compaction", "").trim();
      if (!modelName2 || modelName2 === "clear") {
        if (modelName2 === "clear") {
          if (!settings) {
            return {
              type: "message",
              messageType: "error",
              content: t("Settings service not available.")
            };
          }
          persistSetting(settings, "compactionModel", void 0, scopeOverride);
          config.setCompactionModel(void 0);
          return {
            type: "message",
            messageType: "info",
            content: t("Compaction model override cleared") + scopeSuffix
          };
        }
        if (context.executionMode !== "interactive") {
          const compactionModel = context.services.settings?.merged?.compactionModel?.trim() || t("not set (falls back to the main model)");
          return {
            type: "message",
            messageType: "info",
            content: t(
              'Current compaction model: {{compactionModel}}\nUse "/model --compaction <model-id>" to set compaction model, or "/model --compaction clear" to clear the override.',
              { compactionModel }
            )
          };
        }
        return {
          type: "dialog",
          dialog: "compaction-model",
          ...persistScopeSpread(scopeOverride)
        };
      }
      if (!settings) {
        return {
          type: "message",
          messageType: "error",
          content: t("Settings service not available.")
        };
      }
      const selector = (() => {
        try {
          return resolveModelId(modelName2);
        } catch {
          return void 0;
        }
      })();
      if (!selector) {
        return {
          type: "message",
          messageType: "error",
          content: formatUnavailableCompactionModelMessage(modelName2, [])
        };
      }
      const availableModels = (selector.authType ? config.getAvailableModelsForAuthType(selector.authType) : config.getAllConfiguredModels()).filter(
        (m) => !m.fastOnly && !m.voiceOnly && !m.imageOnly && !m.visionOnly
      );
      if (!availableModels.some((model) => model.id === selector.modelId)) {
        return {
          type: "message",
          messageType: "error",
          content: selector.authType ? formatUnavailableModelMessage(
            "Compaction model",
            selector.modelId,
            selector.authType,
            availableModels
          ) : formatUnavailableCompactionModelMessage(
            modelName2,
            availableModels
          )
        };
      }
      persistSetting(settings, "compactionModel", modelName2, scopeOverride);
      config.setCompactionModel(modelName2);
      return {
        type: "message",
        messageType: "info",
        content: t("Compaction Model") + ": " + modelName2 + scopeSuffix
      };
    }
    const isImageModelCommand = args === "--image" || args.startsWith("--image ");
    if (isImageModelCommand) {
      const modelName2 = args.replace("--image", "").trim();
      if (!modelName2) {
        if (context.executionMode !== "interactive") {
          const imageModel2 = context.services.settings?.merged?.imageModel?.trim();
          return {
            type: "message",
            messageType: "info",
            content: t(
              'Current image model: {{imageModel}}\nUse "/model --image <model-id>" to set the image generation model.',
              {
                imageModel: imageModel2 ? formatVisionModelSettingForDisplay(imageModel2) : t("not set")
              }
            )
          };
        }
        return {
          type: "dialog",
          dialog: "image-model",
          ...persistScopeSpread(scopeOverride)
        };
      }
      if (!settings) {
        return {
          type: "message",
          messageType: "error",
          content: t("Settings service not available.")
        };
      }
      const selector = (() => {
        try {
          return resolveModelId(modelName2);
        } catch {
          return void 0;
        }
      })();
      if (!selector) {
        return {
          type: "message",
          messageType: "error",
          content: formatUnavailableImageModelMessage(modelName2, [])
        };
      }
      const availableModels = (selector.authType ? config.getAvailableModelsForAuthType(selector.authType) : config.getAllConfiguredModels()).filter(
        (model) => isImageGenerationCapable(model) && !model.fastOnly && !model.voiceOnly
      );
      const matchingModels = availableModels.filter(
        (model) => model.id === selector.modelId
      );
      if (matchingModels.length > 1) {
        return {
          type: "message",
          messageType: "error",
          content: t(
            "Image model '{{modelName}}' matches multiple configured endpoints. Run /model --image without an argument and choose the exact endpoint.",
            { modelName: modelName2 }
          )
        };
      }
      const matched = matchingModels[0];
      if (!matched) {
        return {
          type: "message",
          messageType: "error",
          content: selector.authType ? formatUnavailableModelMessage(
            "Image model",
            selector.modelId,
            selector.authType,
            availableModels
          ) : formatUnavailableImageModelMessage(modelName2, availableModels)
        };
      }
      const qualifiedModelName = `${selector.authType ?? matched.authType}:${selector.modelId}`;
      const imageModel = matched.baseUrl ? `${qualifiedModelName}\0${matched.baseUrl}` : qualifiedModelName;
      if (!config.resolveImageGenerationModel(imageModel)) {
        return {
          type: "message",
          messageType: "error",
          content: t(
            "Image model '{{modelName}}' must declare a valid HTTPS baseUrl and credential environment variable.",
            { modelName: modelName2 }
          )
        };
      }
      persistSetting(settings, "imageModel", imageModel, scopeOverride);
      await config.setImageModel(imageModel);
      return {
        type: "message",
        messageType: "info",
        content: t("Image Model") + ": " + modelName2 + scopeSuffix
      };
    }
    const contentGeneratorConfig = config.getContentGeneratorConfig();
    if (!contentGeneratorConfig) {
      return {
        type: "message",
        messageType: "error",
        content: t("Content generator configuration not available.")
      };
    }
    const authType = contentGeneratorConfig.authType;
    if (!authType) {
      return {
        type: "message",
        messageType: "error",
        content: t("Authentication type not available.")
      };
    }
    const trimmedArgs = args.trim();
    const firstSpace = trimmedArgs.search(/\s/);
    const modelName = firstSpace === -1 ? trimmedArgs : trimmedArgs.slice(0, firstSpace);
    const inlinePrompt = firstSpace === -1 ? "" : trimmedArgs.slice(firstSpace + 1).trim();
    if (modelName) {
      const parsed = parseAcpModelOption(modelName);
      const targetAuthType = parsed.authType ?? authType;
      const availableModels = config.getAvailableModelsForAuthType(targetAuthType).filter((m) => !m.fastOnly && !m.voiceOnly && !m.imageOnly);
      if (!availableModels.some((model) => model.id === parsed.modelId)) {
        return {
          type: "message",
          messageType: "error",
          content: formatUnavailableModelMessage(
            "Model",
            parsed.modelId,
            targetAuthType,
            availableModels
          )
        };
      }
      if (inlinePrompt) {
        if (context.executionMode === "acp") {
          return {
            type: "message",
            messageType: "error",
            content: t(
              "Inline one-shot override isn't supported in this mode \u2014 run '/model {{model}}' first, then send your prompt.",
              { model: modelName }
            )
          };
        }
        if (scopeOverride) {
          const scopeFlag = hasProject ? "--project" : hasGlobal ? "--global" : "";
          return {
            type: "message",
            messageType: "error",
            content: t(
              "Cannot combine {{flag}} with an inline prompt. Run '/model {{flag}} {{model}}' first, then send your prompt.",
              { flag: scopeFlag }
            )
          };
        }
        const sameAuthType = targetAuthType === authType;
        if (!sameAuthType || !isInlineModelOverrideAllowed(config, parsed.modelId)) {
          return {
            type: "message",
            messageType: "error",
            content: t(
              "Inline one-shot override can't switch providers. '{{model}}' belongs to a different provider \u2014 run '/model {{model}}' first, then send your prompt.",
              { model: modelName }
            )
          };
        }
        return {
          type: "submit_prompt",
          content: inlinePrompt,
          modelOverride: parsed.modelId
        };
      }
      if (!settings) {
        return {
          type: "message",
          messageType: "error",
          content: t("Settings service not available.")
        };
      }
      const effectiveModelName = await switchMainModel(
        config,
        settings,
        authType,
        modelName,
        scopeOverride,
        context.executionPolicy?.persistModelSelection !== false
      );
      if (context.executionMode === "acp") {
        await recordDaemonSessionModelFromConfig(config);
      }
      return {
        type: "message",
        messageType: "info",
        content: t("Model") + ": " + effectiveModelName + scopeSuffix
      };
    }
    if (context.executionMode !== "interactive") {
      const currentModel = config.getModel() ?? "unknown";
      return {
        type: "message",
        messageType: "info",
        content: t(
          'Current model: {{model}}\nUse "/model <model-id>" to switch models, "/model --fast <model-id>" to set the fast model, "/model --project <model-id>" to persist to project settings, or "/model --global <model-id>" to persist to user settings.',
          { model: currentModel }
        )
      };
    }
    return {
      type: "dialog",
      dialog: "model",
      ...persistScopeSpread(scopeOverride)
    };
  }, "action")
};

// packages/cli/src/ui/commands/output-style-command.ts
init_esbuild_shims();

// packages/cli/src/ui/commands/output-style-utils.ts
init_esbuild_shims();
var debugLogger13 = createDebugLogger("OUTPUT_STYLE_COMMAND");
var OUTPUT_STYLE_LIST = BUILT_IN_OUTPUT_STYLES.map(
  (style) => style.name
).join(", ");
function formatOutputStyleNames(styles) {
  return styles.map((style) => style.name).join(", ");
}
__name(formatOutputStyleNames, "formatOutputStyleNames");
async function loadSessionOutputStyles(config) {
  return loadOutputStyleCatalog({
    projectRoot: config.isTrustedFolder() ? config.getProjectRoot() : void 0
  });
}
__name(loadSessionOutputStyles, "loadSessionOutputStyles");
function resolveOutputStyleChoice(name, available) {
  if (name.trim().toLowerCase() === "default") {
    return void 0;
  }
  return findOutputStyle(available, name) ?? null;
}
__name(resolveOutputStyleChoice, "resolveOutputStyleChoice");
async function applyOutputStyleSelection(config, settings, style, options = {}) {
  if (config.getBareMode() || config.isSafeMode()) {
    throw new Error(
      t("Output styles are unavailable in --bare and --safe-mode.")
    );
  }
  const workspaceOwnsOutputStyle = settings.isTrusted && Object.prototype.hasOwnProperty.call(
    settings.workspace.settings.general ?? {},
    "outputStyle"
  );
  if (workspaceOwnsOutputStyle && options.allowWorkspaceSettingsWrite === false) {
    throw new Error(
      t("Project output style settings are not available in this session.")
    );
  }
  const scope = workspaceOwnsOutputStyle ? "Workspace" /* Workspace */ : "User" /* User */;
  settings.setValue(
    scope,
    "general.outputStyle",
    style ? style.name : "default",
    void 0,
    { throwOnWriteFailure: true }
  );
  config.setOutputStyle(style);
  try {
    await config.getLlmClient().refreshSystemInstruction();
  } catch (error) {
    debugLogger13.warn(
      "Failed to apply output style to the running session:",
      error
    );
  }
  if (!style) {
    return t("Output style cleared; responses use the default style.");
  }
  let message2 = t("Output style set to {{name}}.", { name: style.name });
  if (!resolveMainSessionOutputStyle(config)) {
    message2 += config.getSystemPrompt() || isSystemMdActive() ? ` ${t(
      "It is saved but has no effect in this session because the system prompt is replaced (--system-prompt or QWEN_SYSTEM_MD)."
    )}` : style.source === "project" && !config.isTrustedFolder() ? ` ${t(
      "It is saved but does not apply while this workspace is untrusted."
    )}` : ` ${t("It is saved but Learning is skipped in headless runs.")}`;
  }
  if (scope === "Workspace" /* Workspace */ && style.source === "user") {
    message2 += ` ${t(
      "{{name}} is a personal style, so it will not resolve for anyone else who reads the project settings file it was written to.",
      { name: style.name }
    )}`;
  } else if (scope === "User" /* User */ && style.source === "project") {
    message2 += ` ${t(
      "{{name}} is a project style, so it will not resolve in other projects that read your user settings.",
      { name: style.name }
    )}`;
  }
  return message2;
}
__name(applyOutputStyleSelection, "applyOutputStyleSelection");

// packages/cli/src/ui/commands/output-style-command.ts
var outputStyleCommand = {
  name: "output-style",
  get description() {
    return t(
      "Choose the output style that shapes how responses are written ({{styles}}, or a custom style name).",
      { styles: OUTPUT_STYLE_LIST }
    );
  },
  // Styles show up as a placeholder rather than as autocompletion suggestions
  // for the same reason as /effort: bare `/output-style` should open the
  // picker with nothing auto-selected.
  argumentHint: "[Concise|Proactive|Explanatory|Learning|<custom>|default]",
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "non_interactive", "acp"],
  action: /* @__PURE__ */ __name(async (context, actionArgs) => {
    const { services } = context;
    const { config, settings } = services;
    if (!config) {
      return {
        type: "message",
        messageType: "error",
        content: t("Configuration not available.")
      };
    }
    if (config.getBareMode() || config.isSafeMode()) {
      return {
        type: "message",
        messageType: "error",
        content: t("Output styles are unavailable in --bare and --safe-mode.")
      };
    }
    const args = context.invocation?.args?.trim() || actionArgs.trim();
    if (!args && context.executionMode === "interactive") {
      return { type: "dialog", dialog: "output-style" };
    }
    const available = await loadSessionOutputStyles(config);
    const styles = formatOutputStyleNames(available);
    if (!args) {
      const current = resolveMainSessionOutputStyle(config);
      return {
        type: "message",
        messageType: "info",
        content: current ? t(
          'Current output style: {{current}}\nAvailable: {{styles}}, default\nUse "/output-style <name>" to change it.',
          { current: current.name, styles }
        ) : t(
          'Output style: default.\nAvailable: {{styles}}\nUse "/output-style <name>" to set one.',
          { styles }
        )
      };
    }
    const style = resolveOutputStyleChoice(args, available);
    if (style === null) {
      return {
        type: "message",
        messageType: "error",
        content: t(
          'Unknown output style "{{value}}". Choose one of: {{styles}}, or "default" for no style.',
          { value: args, styles }
        )
      };
    }
    if (!settings) {
      return {
        type: "message",
        messageType: "error",
        content: t("Settings service not available.")
      };
    }
    try {
      return {
        type: "message",
        messageType: "info",
        content: await applyOutputStyleSelection(config, settings, style, {
          allowWorkspaceSettingsWrite: context.executionPolicy?.allowWorkspaceSettingsWrite
        })
      };
    } catch (error) {
      return {
        type: "message",
        messageType: "error",
        content: t('Failed to set "{{key}}": {{error}}', {
          key: "general.outputStyle",
          error: error instanceof Error ? error.message : String(error)
        })
      };
    }
  }, "action")
};

// packages/cli/src/ui/commands/rememberCommand.ts
init_esbuild_shims();
var rememberCommand = {
  name: "remember",
  get description() {
    return t("Save a durable memory to the memory system.");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "acp"],
  argumentHint: "<text to remember>",
  action: /* @__PURE__ */ __name((context, args) => {
    const fact = args.trim();
    if (!fact) {
      return {
        type: "message",
        messageType: "error",
        content: t("Usage: /remember <text to remember>")
      };
    }
    const config = context.services.config;
    if (!config) {
      return {
        type: "message",
        messageType: "error",
        content: t("Config not loaded.")
      };
    }
    const useManagedMemory = config?.isManagedMemoryAvailable() ?? false;
    if (useManagedMemory) {
      return {
        type: "submit_prompt",
        content: buildManagedRememberPrompt(fact, config.getProjectRoot())
      };
    }
    return {
      type: "submit_prompt",
      content: buildBareRememberPrompt(fact),
      refreshContextFilesOnWrite: true
    };
  }, "action")
};

// packages/cli/src/ui/commands/planCommand.ts
init_esbuild_shims();
var planCommand = {
  name: "plan",
  get description() {
    return t("Switch to plan mode or exit plan mode");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive"],
  action: /* @__PURE__ */ __name(async (context, args) => {
    const { config } = context.services;
    if (!config) {
      return {
        type: "message",
        messageType: "error",
        content: t("Configuration is not available.")
      };
    }
    const trimmedArgs = args.trim();
    const currentMode = config.getApprovalMode();
    if (trimmedArgs === "exit") {
      if (currentMode !== "plan" /* PLAN */) {
        return {
          type: "message",
          messageType: "error",
          content: t('Not in plan mode. Use "/plan" to enter plan mode first.')
        };
      }
      try {
        config.setApprovalMode(config.getPrePlanMode());
      } catch (e) {
        return {
          type: "message",
          messageType: "error",
          content: e.message
        };
      }
      return {
        type: "message",
        messageType: "info",
        content: t("Exited plan mode. Previous approval mode restored.")
      };
    }
    if (currentMode !== "plan" /* PLAN */) {
      try {
        config.setApprovalMode("plan" /* PLAN */);
      } catch (e) {
        return {
          type: "message",
          messageType: "error",
          content: e.message
        };
      }
      if (trimmedArgs) {
        return {
          type: "submit_prompt",
          content: [{ text: trimmedArgs }]
        };
      }
      return {
        type: "message",
        messageType: "info",
        content: t(
          "Enabled plan mode. The agent will analyze and plan without executing tools."
        )
      };
    }
    if (trimmedArgs) {
      return {
        type: "submit_prompt",
        content: [{ text: trimmedArgs }]
      };
    }
    return {
      type: "message",
      messageType: "info",
      content: t('Already in plan mode. Use "/plan exit" to exit plan mode.')
    };
  }, "action")
};

// packages/cli/src/ui/commands/permissionsCommand.ts
init_esbuild_shims();
var permissionsCommand = {
  name: "permissions",
  get description() {
    return t("Manage permission rules");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive"],
  action: /* @__PURE__ */ __name(() => ({
    type: "dialog",
    dialog: "permissions"
  }), "action")
};

// packages/cli/src/ui/commands/trustCommand.ts
init_esbuild_shims();
var trustCommand = {
  name: "trust",
  get description() {
    return t("Manage folder trust settings");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive"],
  action: /* @__PURE__ */ __name(() => ({
    type: "dialog",
    dialog: "trust"
  }), "action")
};

// packages/cli/src/ui/commands/quitCommand.ts
init_esbuild_shims();
var quitCommand = {
  name: "quit",
  altNames: ["exit"],
  get description() {
    return t("exit the cli");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive"],
  action: /* @__PURE__ */ __name((context) => {
    const now = Date.now();
    const { sessionStartTime } = context.session.stats;
    const wallDuration = now - sessionStartTime.getTime();
    return {
      type: "quit",
      messages: [
        {
          type: "user",
          text: `/quit`,
          // Keep it consistent, even if /exit was used
          id: now - 1
        },
        {
          type: "quit",
          duration: formatDuration(wallDuration),
          id: now
        }
      ]
    };
  }, "action")
};

// packages/cli/src/ui/commands/recapCommand.ts
init_esbuild_shims();
var recapCommand = {
  name: "recap",
  kind: "built-in" /* BUILT_IN */,
  get description() {
    return t("Generate a one-line session recap now");
  },
  action: /* @__PURE__ */ __name(async (context) => {
    const { config } = context.services;
    const abortSignal = context.abortSignal ?? new AbortController().signal;
    if (!config) {
      return {
        type: "message",
        messageType: "error",
        content: t("Config not loaded.")
      };
    }
    if (context.executionMode === "interactive") {
      const turnInFlight = !context.ui.isIdleRef.current || context.ui.pendingItem !== null;
      if (turnInFlight) {
        return {
          type: "message",
          messageType: "error",
          content: t(
            "Cannot run /recap while another operation is in progress."
          )
        };
      }
    }
    const recap = await generateSessionRecap(config, abortSignal);
    if (abortSignal.aborted) return;
    if (!recap) {
      return {
        type: "message",
        messageType: "info",
        content: t("Not enough conversation context for a recap yet.")
      };
    }
    if (context.executionMode === "interactive") {
      const item = {
        type: "away_recap",
        text: recap
      };
      context.ui.addItem(item, Date.now());
      return;
    }
    return { type: "message", messageType: "info", content: recap };
  }, "action")
};

// packages/cli/src/ui/commands/reload-plugins-command.ts
init_esbuild_shims();

// packages/cli/src/config/extension-runtime-reload.ts
init_esbuild_shims();
var debugLogger14 = createDebugLogger("EXTENSION_RUNTIME_RELOAD");
async function reloadPluginsRuntime(options) {
  if (options.config.isSafeMode()) {
    throw new Error("Extension reload is disabled in safe mode.");
  }
  const manager = options.config.getExtensionManager();
  await manager.refreshCache();
  await manager.refreshTools();
  await options.reloadCommands?.();
  return summarizeExtensions(options.config.getActiveExtensions());
}
__name(reloadPluginsRuntime, "reloadPluginsRuntime");
async function refreshExtensionContentRuntime(options) {
  if (options.config.isSafeMode()) return;
  const manager = options.config.getExtensionManager();
  const errors = [];
  try {
    await manager.refreshCache();
  } catch (error) {
    errors.push(error);
    debugLogger14.warn(
      "refreshExtensionContentRuntime: refreshCache failed:",
      error
    );
  }
  const settled = await Promise.allSettled([
    options.config.getSkillManager()?.refreshCache(),
    options.config.getSubagentManager()?.refreshCache(),
    options.reloadCommands?.()
  ]);
  for (const result of settled) {
    if (result.status === "rejected") {
      errors.push(result.reason);
      debugLogger14.warn(
        "refreshExtensionContentRuntime: a refresh leg failed:",
        result.reason
      );
    }
  }
  if (errors.length > 0) {
    throw new Error(
      errors.map(
        (error) => error instanceof Error ? error.message : String(error)
      ).join("; ")
    );
  }
}
__name(refreshExtensionContentRuntime, "refreshExtensionContentRuntime");
function summarizeExtensions(extensions) {
  return extensions.reduce(
    (summary, extension) => {
      summary.extensionCount++;
      summary.commandCount += extension.commands?.length ?? 0;
      summary.skillCount += extension.skills?.length ?? 0;
      summary.agentCount += extension.agents?.length ?? 0;
      summary.workflowCount += extension.workflows?.length ?? 0;
      summary.hookCount += countHooks(extension);
      summary.mcpServerCount += Object.keys(extension.mcpServers ?? {}).length;
      summary.lspServerCount += countLspServers(extension);
      return summary;
    },
    {
      extensionCount: 0,
      commandCount: 0,
      skillCount: 0,
      agentCount: 0,
      workflowCount: 0,
      hookCount: 0,
      mcpServerCount: 0,
      lspServerCount: 0
    }
  );
}
__name(summarizeExtensions, "summarizeExtensions");
function countHooks(extension) {
  return Object.values(extension.hooks ?? {}).reduce(
    (sum, definitions) => sum + (definitions ?? []).reduce(
      (innerSum, definition) => innerSum + (definition.hooks?.length ?? 0),
      0
    ),
    0
  );
}
__name(countHooks, "countHooks");
function countLspServers(extension) {
  const lspServers = extension.config.lspServers;
  if (!lspServers) return 0;
  if (typeof lspServers === "string") return 1;
  return Object.keys(lspServers).length;
}
__name(countLspServers, "countLspServers");

// packages/cli/src/ui/commands/reload-plugins-command.ts
function summaryCountTerm(count, singularKey, pluralKey) {
  return t(count === 1 ? singularKey : pluralKey, {
    count: String(count)
  });
}
__name(summaryCountTerm, "summaryCountTerm");
function formatReloadPluginsSummary(summary) {
  return [
    summaryCountTerm(
      summary.extensionCount,
      "{{count}} extension",
      "{{count}} extensions"
    ),
    summaryCountTerm(
      summary.commandCount,
      "{{count}} command",
      "{{count}} commands"
    ),
    summaryCountTerm(summary.skillCount, "{{count}} skill", "{{count}} skills"),
    summaryCountTerm(summary.agentCount, "{{count}} agent", "{{count}} agents"),
    summaryCountTerm(
      summary.workflowCount,
      "{{count}} workflow",
      "{{count}} workflows"
    ),
    summaryCountTerm(summary.hookCount, "{{count}} hook", "{{count}} hooks"),
    summaryCountTerm(
      summary.mcpServerCount,
      "{{count}} extension MCP server",
      "{{count}} extension MCP servers"
    ),
    summaryCountTerm(
      summary.lspServerCount,
      "{{count}} extension LSP server",
      "{{count}} extension LSP servers"
    )
  ].join(" \xB7 ");
}
__name(formatReloadPluginsSummary, "formatReloadPluginsSummary");
var reloadPluginsCommand = {
  name: "reload-plugins",
  get description() {
    return t("Reload extension changes from disk");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive"],
  action: /* @__PURE__ */ __name(async (context) => {
    const config = context.services.config;
    if (!config) {
      return {
        type: "message",
        messageType: "error",
        content: t("Config not loaded.")
      };
    }
    const extensionRefreshState = context.services.extensionRefreshState ?? new ExtensionRefreshState();
    try {
      extensionRefreshState.notifyExtensionsReloadStarted();
      const summary = await reloadPluginsRuntime({
        config,
        reloadCommands: context.ui.reloadCommands
      });
      extensionRefreshState.clearExtensionsChanged();
      return {
        type: "message",
        messageType: "info",
        content: t("Reloaded extensions: {{summary}}", {
          summary: formatReloadPluginsSummary(summary)
        })
      };
    } catch (error) {
      extensionRefreshState.markExtensionsReloadFailed();
      return {
        type: "message",
        messageType: "error",
        content: error instanceof Error ? t("Reload failed: {{message}}", { message: error.message }) : t("Reload failed.")
      };
    }
  }, "action")
};

// packages/cli/src/ui/commands/renameCommand.ts
init_esbuild_shims();
var MAX_TITLE_LENGTH = SESSION_TITLE_MAX_LENGTH;
function titleFailureMessage(reason) {
  switch (reason) {
    case "no_fast_model":
      return t(
        "Auto-generating a title requires a fast model. Configure one with `/model --fast <model>`, or pass a name: `/rename <name>`."
      );
    case "empty_history":
      return t(
        "No conversation to title yet \u2014 send at least one message first."
      );
    case "empty_result":
      return t(
        "The fast model returned no usable title. Try `/rename <name>` to set one yourself."
      );
    case "aborted":
      return t("Title generation was cancelled.");
    case "model_error":
      return t(
        "The fast model could not generate a title (rate limit, auth, network error, or unexpected response format). Check debug log or try again."
      );
    case "no_client":
      return t("Session is still initializing \u2014 try again in a moment.");
    default:
      return t("Could not generate a title.");
  }
}
__name(titleFailureMessage, "titleFailureMessage");
function parseArgs(raw) {
  const trimmed = raw.trim().replace(/[\r\n]+/g, " ");
  if (!trimmed) return { auto: false, positional: "" };
  const parts = trimmed.split(/\s+/);
  let auto = false;
  let unknownFlag;
  let flagsDone = false;
  const rest = [];
  for (const p of parts) {
    if (!flagsDone && p === "--") {
      flagsDone = true;
      continue;
    }
    if (!flagsDone && p.startsWith("--")) {
      if (p.toLowerCase() === "--auto") {
        auto = true;
        continue;
      }
      if (!unknownFlag) unknownFlag = p;
      continue;
    }
    rest.push(p);
  }
  return { auto, positional: rest.join(" "), unknownFlag };
}
__name(parseArgs, "parseArgs");
var renameCommand = {
  name: "rename",
  altNames: ["tag"],
  kind: "built-in" /* BUILT_IN */,
  get description() {
    return t(
      "Rename the current conversation. --auto lets the fast model pick a title."
    );
  },
  argumentHint: "[--auto] [<name>]",
  completion: /* @__PURE__ */ __name(async (_context, partialArg) => {
    const trimmed = partialArg.trim();
    if (trimmed && "--auto".startsWith(trimmed)) {
      return [
        {
          value: "--auto",
          description: t(
            "Let the fast model generate a sentence-case title from the conversation so far."
          )
        }
      ];
    }
    return null;
  }, "completion"),
  action: /* @__PURE__ */ __name(async (context, args) => {
    const { config } = context.services;
    if (!config) {
      return {
        type: "message",
        messageType: "error",
        content: t("Config is not available.")
      };
    }
    const { auto, positional, unknownFlag } = parseArgs(args);
    if (unknownFlag) {
      return {
        type: "message",
        messageType: "error",
        content: t(
          'Unknown flag "{{flag}}". Supported: --auto. To use this as a literal name, run `/rename -- {{flag}}`.',
          { flag: unknownFlag }
        )
      };
    }
    let name = positional;
    const titleSource = name ? "manual" : "auto";
    if (auto && positional) {
      return {
        type: "message",
        messageType: "error",
        content: t(
          "/rename --auto does not take a name. Use `/rename <name>` to set a name yourself."
        )
      };
    }
    if (!name) {
      const dots = [".", "..", "..."];
      let dotIndex = 0;
      const baseText = t("Generating session title");
      context.ui.setPendingItem({
        type: "info",
        text: baseText + dots[dotIndex]
      });
      const timer = setInterval(() => {
        dotIndex = (dotIndex + 1) % dots.length;
        context.ui.setPendingItem({
          type: "info",
          text: baseText + dots[dotIndex]
        });
      }, 500);
      let outcome;
      try {
        const userDisplayTexts = config.getChatRecordingService()?.getUserDisplayTextsForTitle?.() ?? [];
        const lastDisplayText = userDisplayTexts.at(-1)?.trim();
        const titleDisplayTexts = lastDisplayText?.match(
          /^\/(?:rename|tag)(?:\s+--auto)?$/i
        ) ? userDisplayTexts.slice(0, -1) : userDisplayTexts;
        outcome = await tryGenerateSessionTitle(
          config,
          context.abortSignal ?? new AbortController().signal,
          titleDisplayTexts
        );
      } finally {
        clearInterval(timer);
        context.ui.setPendingItem(null);
      }
      if (!outcome.ok) {
        return {
          type: "message",
          messageType: "error",
          content: titleFailureMessage(outcome.reason)
        };
      }
      name = outcome.title;
    }
    if (name.length > MAX_TITLE_LENGTH) {
      return {
        type: "message",
        messageType: "error",
        content: t("Name is too long. Maximum {{max}} characters.", {
          max: String(MAX_TITLE_LENGTH)
        })
      };
    }
    const chatRecordingService = config.getChatRecordingService();
    if (chatRecordingService) {
      const ok = await chatRecordingService.recordCustomTitle(
        name,
        titleSource
      );
      if (!ok) {
        return {
          type: "message",
          messageType: "error",
          content: t("Failed to rename session.")
        };
      }
    } else {
      const sessionId = config.getSessionId();
      const sessionService = config.getSessionService();
      const success = await sessionService.renameSession(
        sessionId,
        name,
        titleSource
      );
      if (!success) {
        return {
          type: "message",
          messageType: "error",
          content: t("Failed to rename session.")
        };
      }
    }
    context.ui.setSessionName(name);
    return {
      type: "message",
      messageType: "info",
      content: t('Session renamed to "{{name}}"', { name })
    };
  }, "action")
};

// packages/cli/src/ui/commands/restoreCommand.ts
init_esbuild_shims();
import * as fs8 from "node:fs/promises";
import path10 from "node:path";
async function restoreAction(context, args) {
  const { services, ui } = context;
  const { config } = services;
  const { addItem, loadHistory } = ui;
  const checkpointDir = config?.storage.getProjectTempCheckpointsDir();
  if (!checkpointDir) {
    return {
      type: "message",
      messageType: "error",
      content: "Could not determine the .qwen directory path."
    };
  }
  try {
    await fs8.mkdir(checkpointDir, { recursive: true });
    const files = await fs8.readdir(checkpointDir);
    const jsonFiles = files.filter((file) => file.endsWith(".json"));
    if (!args) {
      if (jsonFiles.length === 0) {
        return {
          type: "message",
          messageType: "info",
          content: "No restorable tool calls found."
        };
      }
      const truncatedFiles = jsonFiles.map((file) => {
        const components = file.split(".");
        if (components.length <= 1) {
          return file;
        }
        components.pop();
        return components.join(".");
      });
      const fileList = truncatedFiles.join("\n");
      return {
        type: "message",
        messageType: "info",
        content: `Available tool calls to restore:

${fileList}`
      };
    }
    const selectedFile = args.endsWith(".json") ? args : `${args}.json`;
    if (!jsonFiles.includes(selectedFile)) {
      return {
        type: "message",
        messageType: "error",
        content: `File not found: ${selectedFile}`
      };
    }
    const filePath = path10.join(checkpointDir, selectedFile);
    const data = await fs8.readFile(filePath, "utf-8");
    const toolCallData = JSON.parse(data);
    if (toolCallData.commitHash && !toolCallData.promptId) {
      return {
        type: "message",
        messageType: "error",
        content: "This checkpoint uses a legacy format that is no longer supported. Please create a new checkpoint."
      };
    }
    const toolCall = toolCallData.toolCall;
    if (!toolCall || typeof toolCall !== "object" || typeof toolCall.name !== "string") {
      throw new Error("Checkpoint is missing a valid toolCall.");
    }
    if (toolCallData.promptId) {
      if (!config) {
        return {
          type: "message",
          messageType: "error",
          content: "Configuration is not available."
        };
      }
      try {
        const result = await config.getFileHistoryService().rewind(toolCallData.promptId, true);
        if (result.filesFailed.length > 0) {
          addItem(
            {
              type: "warning",
              text: `Partially restored: ${result.filesChanged.length} file(s) reverted, ${result.filesFailed.length} file(s) failed. Aborting tool replay.`
            },
            Date.now()
          );
          return;
        }
        addItem(
          {
            type: "info",
            text: "Restored project to the state at the start of this turn."
          },
          Date.now()
        );
      } catch (error) {
        addItem(
          {
            type: "warning",
            text: `Could not restore files: ${error instanceof Error ? error.message : String(error)}`
          },
          Date.now()
        );
        return;
      }
    }
    if (toolCallData.history) {
      if (!loadHistory) {
        return {
          type: "message",
          messageType: "error",
          content: "loadHistory function is not available."
        };
      }
      context.ui.clearPendingState?.();
      loadHistory(toolCallData.history);
    }
    if (toolCallData.clientHistory) {
      await config?.getLlmClient()?.setHistory(toolCallData.clientHistory);
    }
    return {
      type: "tool",
      toolName: toolCall.name,
      toolArgs: toolCall.args
    };
  } catch (error) {
    return {
      type: "message",
      messageType: "error",
      content: `Could not read restorable tool calls. This is the error: ${error}`
    };
  }
}
__name(restoreAction, "restoreAction");
async function completion(context, _partialArg) {
  const { services } = context;
  const { config } = services;
  const checkpointDir = config?.storage.getProjectTempCheckpointsDir();
  if (!checkpointDir) {
    return [];
  }
  try {
    const files = await fs8.readdir(checkpointDir);
    return files.filter((file) => file.endsWith(".json")).map((file) => file.replace(".json", ""));
  } catch (_err) {
    return [];
  }
}
__name(completion, "completion");
var restoreCommand2 = /* @__PURE__ */ __name((config) => {
  if (!config?.getFileCheckpointingEnabled()) {
    return null;
  }
  return {
    name: "restore",
    get description() {
      return t(
        "Restore a tool call. This will reset the conversation and file history to the state it was in when the tool call was suggested"
      );
    },
    kind: "built-in" /* BUILT_IN */,
    supportedModes: ["interactive"],
    action: restoreAction,
    completion
  };
}, "restoreCommand");

// packages/cli/src/ui/commands/resumeCommand.ts
init_esbuild_shims();
var resumeCommand = {
  name: "resume",
  altNames: ["continue"],
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive"],
  get description() {
    return t("Resume a previous session");
  },
  action: /* @__PURE__ */ __name(async (context, args) => {
    const arg = args.trim();
    if (!arg) {
      return { type: "dialog", dialog: "resume" };
    }
    const { config } = context.services;
    if (!config) {
      return {
        type: "message",
        messageType: "error",
        content: t("Config is not available.")
      };
    }
    if (isValidSessionId(arg)) {
      const sessionService2 = config.getSessionService();
      const exists = await sessionService2.sessionExists(arg);
      if (exists) {
        return { type: "dialog", dialog: "resume", sessionId: arg };
      }
      return {
        type: "message",
        messageType: "error",
        content: t('No session found with ID "{{id}}".', { id: arg })
      };
    }
    const sessionService = config.getSessionService();
    const matches = await sessionService.findSessionsByTitle(arg);
    if (matches.length === 1) {
      return {
        type: "dialog",
        dialog: "resume",
        sessionId: matches[0].sessionId
      };
    }
    if (matches.length > 1) {
      return { type: "dialog", dialog: "resume", matchedSessions: matches };
    }
    return {
      type: "message",
      messageType: "error",
      content: t('No session found with title "{{title}}".', { title: arg })
    };
  }, "action")
};

// packages/cli/src/ui/commands/rewindCommand.ts
init_esbuild_shims();
var rewindCommand = {
  name: "rewind",
  altNames: ["rollback"],
  get description() {
    return t("Rewind conversation to a previous turn");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive"],
  action: /* @__PURE__ */ __name(async () => ({
    type: "dialog",
    dialog: "rewind"
  }), "action")
};

// packages/cli/src/ui/commands/settingsCommand.ts
init_esbuild_shims();
var settingsCommand = {
  name: "settings",
  get description() {
    return t("View and edit Qwen Code settings");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive"],
  canRunDuringStreaming: true,
  action: /* @__PURE__ */ __name((_context, _args) => ({
    type: "dialog",
    dialog: "settings"
  }), "action")
};

// packages/cli/src/ui/commands/skillsCommand.ts
init_esbuild_shims();
var skillsCommand = {
  name: "skills",
  get description() {
    return t("Open the skills panel (browse, search, toggle, pick).");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "acp"],
  // Accepting `/skills` from the auto-completion popup (e.g. typing
  // `/skil<Enter>`) submits immediately rather than inserting `/skills `
  // and forcing a second Enter — `/skills` has no required arg, the bare
  // action just opens the dialog. See `SlashCommand.submitOnAccept`.
  submitOnAccept: true,
  action: /* @__PURE__ */ __name(async (context) => {
    const skillManager = context.services.config?.getSkillManager();
    if (!skillManager) {
      if (context.executionMode === "interactive") {
        context.ui.addItem(
          {
            type: "error" /* ERROR */,
            text: t("Could not retrieve skill manager.")
          },
          Date.now()
        );
        return;
      }
      return {
        type: "message",
        messageType: "error",
        content: t("Could not retrieve skill manager.")
      };
    }
    if (context.executionMode === "interactive") {
      return { type: "dialog", dialog: "skills_manage" };
    }
    const skills = await skillManager.listSkills();
    const userInvocableSkills = skills.filter(
      (skill) => skill.userInvocable !== false
    );
    const visibleSkills = userInvocableSkills.filter(
      (skill) => context.services.config?.isSkillEnabled(skill) ?? true
    );
    if (visibleSkills.length === 0) {
      const content = skills.length > 0 && userInvocableSkills.length === 0 ? t("All skills are marked as non-user-invocable.") : userInvocableSkills.length === 0 ? t("No skills are currently available.") : t(
        "All available skills are disabled. Edit ~/.qwen/settings.json or .qwen/settings.json (skills.disabled) to re-enable."
      );
      return {
        type: "message",
        messageType: "info",
        content
      };
    }
    const sortedSkills = [...visibleSkills].sort(
      (a, b) => normalizeSkillPriority(b.priority) - normalizeSkillPriority(a.priority) || a.name.localeCompare(b.name)
    );
    const sanitize = /* @__PURE__ */ __name((text, max) => {
      const oneLine = text.replace(/[\r\n]+/g, " ").trim();
      return oneLine.length <= max ? oneLine : `${oneLine.slice(0, Math.max(0, max - 1))}\u2026`;
    }, "sanitize");
    const lines = sortedSkills.map(
      (s) => `  - ${s.name}${s.description ? `  ${sanitize(s.description, 80)}` : ""}${s.level ? `  ${skillOriginLabel(s)}` : ""}`
    );
    return {
      type: "message",
      messageType: "info",
      content: `${t("Available skills:")}

${lines.join("\n")}`
    };
  }, "action")
};

// packages/cli/src/ui/commands/statsCommand.ts
init_esbuild_shims();
import * as fs9 from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path11 from "node:path";
var VALID_EXPORT_FORMATS = /* @__PURE__ */ new Set(["csv", "json"]);
var EMPTY_SKILL_METRICS = {
  totalCalls: 0,
  totalSuccess: 0,
  totalFail: 0,
  byName: {}
};
function formatGenerationMetrics(metrics) {
  const last = metrics?.last;
  if (!metrics || !last) {
    return [];
  }
  const lastTps = last.generationDurationMs > 0 ? last.outputTokens / (last.generationDurationMs / 1e3) : void 0;
  const averageTtft = metrics.timedRequests > 0 ? metrics.totalTtftMs / metrics.timedRequests : void 0;
  const sessionTps = metrics.totalGenerationDurationMs > 0 ? metrics.totalThroughputOutputTokens / (metrics.totalGenerationDurationMs / 1e3) : void 0;
  return [
    "",
    `${t("Generation Metrics")} (${t("Latest Request")})`,
    `${t("Model")}: ${last.model}`,
    `TTFT: ${formatDuration(last.ttftMs)}`,
    `${t("Generation Time")}: ${formatDuration(last.generationDurationMs)}`,
    `${t("Output Tokens")}: ${formatInteger(last.outputTokens)}`,
    `TPS: ${lastTps === void 0 ? "\u2014" : `${lastTps.toFixed(1)} tok/s`}`,
    `${t("Requests")}: ${formatInteger(metrics.timedRequests)}`,
    `${t("Average TTFT")}: ${averageTtft === void 0 ? "\u2014" : formatDuration(averageTtft)}`,
    `${t("Session TPS")}: ${sessionTps === void 0 ? "\u2014" : `${sessionTps.toFixed(1)} tok/s`}`
  ];
}
__name(formatGenerationMetrics, "formatGenerationMetrics");
function formatInteger(value) {
  return new Intl.NumberFormat(getCurrentLanguage()).format(value);
}
__name(formatInteger, "formatInteger");
function formatGroupLines(titleKey, groups) {
  if (groups.length === 0) {
    return [t(titleKey), `  ${t("No usage data.")}`];
  }
  return [
    t(titleKey),
    ...groups.map((group) => {
      const label = group.model && group.authType ? `${group.model} (${group.authType})` : group.model || group.authType || group.source || group.key;
      return `  ${t("{{label}}: {{tokens}} tokens ({{requests}} requests)", {
        label,
        tokens: formatInteger(group.totalTokens),
        requests: formatInteger(group.requests)
      })}`;
    })
  ];
}
__name(formatGroupLines, "formatGroupLines");
function formatSkillStats(skills) {
  const skillNames = Object.keys(skills.byName).sort((a, b) => {
    const countDelta = skills.byName[b].count - skills.byName[a].count;
    return countDelta !== 0 ? countDelta : a.localeCompare(b);
  });
  if (skillNames.length === 0) {
    return t("No skill usage data yet.");
  }
  return [
    t("Skill calls: {{total}} ({{success}} ok, {{fail}} fail)", {
      total: String(skills.totalCalls),
      success: String(skills.totalSuccess),
      fail: String(skills.totalFail)
    }),
    ...skillNames.map((name) => {
      const stats = skills.byName[name];
      return t("  {{name}}: {{count}} ({{success}} ok, {{fail}} fail)", {
        name,
        count: String(stats.count),
        success: String(stats.success),
        fail: String(stats.fail)
      });
    })
  ].join("\n");
}
__name(formatSkillStats, "formatSkillStats");
function formatTokenUsageSummary(summary) {
  const label = summary.period === "day" ? t("Daily token usage for {{value}}", { value: summary.value }) : t("Monthly token usage for {{value}}", { value: summary.value });
  return [
    label,
    t("Total: {{tokens}} tokens", {
      tokens: formatInteger(summary.totals.totalTokens)
    }),
    t("Requests: {{requests}}", {
      requests: formatInteger(summary.totals.requests)
    }),
    "",
    t("Breakdown:"),
    `  ${t("Input: {{tokens}}", {
      tokens: formatInteger(summary.totals.inputTokens)
    })}`,
    `  ${t("Output: {{tokens}}", {
      tokens: formatInteger(summary.totals.outputTokens)
    })}`,
    `  ${t("Cached (included in Input): {{tokens}}", {
      tokens: formatInteger(summary.totals.cachedTokens)
    })}`,
    `  ${t("Thoughts: {{tokens}}", {
      tokens: formatInteger(summary.totals.thoughtsTokens)
    })}`,
    "",
    ...formatGroupLines("By model:", summary.byModel),
    "",
    ...formatGroupLines("By auth type:", summary.byAuthType),
    "",
    ...formatGroupLines("By model/auth type:", summary.byModelAndAuthType),
    "",
    ...formatGroupLines("By source:", summary.bySource),
    "",
    t("Note: generation timing (TTFT/TPS) belongs to generation metrics.")
  ].join("\n");
}
__name(formatTokenUsageSummary, "formatTokenUsageSummary");
function asMessage(content, messageType = "info") {
  return {
    type: "message",
    messageType,
    content
  };
}
__name(asMessage, "asMessage");
function addInteractiveMessage(context, content, type = "info" /* INFO */) {
  context.ui.addItem(
    {
      type,
      text: content
    },
    Date.now()
  );
}
__name(addInteractiveMessage, "addInteractiveMessage");
async function showTokenUsageStats(context, period, args) {
  try {
    const value = args.trim() || void 0;
    const summary = await queryTokenUsage({ period, value });
    const content = formatTokenUsageSummary(summary);
    if (context.executionMode !== "interactive") {
      return asMessage(content);
    }
    addInteractiveMessage(context, content);
  } catch (error) {
    const content = t("Failed to load token usage stats: {{error}}", {
      error: error instanceof Error ? error.message : String(error)
    });
    if (context.executionMode !== "interactive") {
      return asMessage(content, "error");
    }
    addInteractiveMessage(context, content, "error" /* ERROR */);
  }
}
__name(showTokenUsageStats, "showTokenUsageStats");
function tokenizeArgs(args) {
  const tokens = [];
  let current = "";
  let quote;
  for (let index = 0; index < args.length; index++) {
    const char = args[index];
    if (quote) {
      if (char === "\\") {
        if (args[index + 1] === quote) {
          current += quote;
          index++;
        } else {
          current += char;
        }
        continue;
      }
      if (char === quote) {
        quote = void 0;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote !== void 0) {
    throw new Error(t("Unclosed quote in arguments."));
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}
__name(tokenizeArgs, "tokenizeArgs");
function isNotFoundError(error) {
  return error.code === "ENOENT";
}
__name(isNotFoundError, "isNotFoundError");
function statsExportPathError() {
  return asMessage(
    t("Token usage export path must be within the project working directory."),
    "error"
  );
}
__name(statsExportPathError, "statsExportPathError");
function statsExportTargetMissingError(targetPath) {
  return asMessage(
    t("Export target does not exist: {{path}}", { path: targetPath }),
    "error"
  );
}
__name(statsExportTargetMissingError, "statsExportTargetMissingError");
async function realpathNearestExisting2(targetDirectory, cwd) {
  let currentDirectory = targetDirectory;
  while (isSubpath(cwd, currentDirectory)) {
    try {
      return await fs9.realpath(currentDirectory);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
      const parentDirectory = path11.dirname(currentDirectory);
      if (parentDirectory === currentDirectory) {
        break;
      }
      currentDirectory = parentDirectory;
    }
  }
  throw new Error(
    t("Cannot resolve export path within the working directory.")
  );
}
__name(realpathNearestExisting2, "realpathNearestExisting");
async function validateStatsExportExistingParent(cwd, outputDirectory) {
  const [realCwd, realExistingParent] = await Promise.all([
    fs9.realpath(cwd),
    realpathNearestExisting2(outputDirectory, cwd)
  ]);
  if (!isSubpath(realCwd, realExistingParent)) {
    return statsExportPathError();
  }
  return void 0;
}
__name(validateStatsExportExistingParent, "validateStatsExportExistingParent");
async function validateStatsExportDirectory(cwd, outputDirectory) {
  const [realCwd, realOutputDirectory] = await Promise.all([
    fs9.realpath(cwd),
    fs9.realpath(outputDirectory)
  ]);
  if (!isSubpath(realCwd, realOutputDirectory)) {
    return statsExportPathError();
  }
  return void 0;
}
__name(validateStatsExportDirectory, "validateStatsExportDirectory");
function validateStatsExportPathShape(targetPath) {
  if (process.platform === "win32" && path11.basename(targetPath).includes(":")) {
    return statsExportPathError();
  }
  return void 0;
}
__name(validateStatsExportPathShape, "validateStatsExportPathShape");
async function validateStatsExportFileTarget(targetPath) {
  try {
    const stats = await fs9.lstat(targetPath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      return statsExportPathError();
    }
  } catch (error) {
    if (isNotFoundError(error)) {
      return void 0;
    }
    throw error;
  }
  return void 0;
}
__name(validateStatsExportFileTarget, "validateStatsExportFileTarget");
async function validateStatsExportFinalFile(cwd, targetPath) {
  let stats;
  try {
    stats = await fs9.lstat(targetPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return statsExportTargetMissingError(targetPath);
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    return statsExportPathError();
  }
  const [realCwd, realTargetPath] = await Promise.all([
    fs9.realpath(cwd),
    fs9.realpath(targetPath)
  ]);
  if (!isSubpath(realCwd, realTargetPath)) {
    return statsExportPathError();
  }
  return void 0;
}
__name(validateStatsExportFinalFile, "validateStatsExportFinalFile");
function createTemporaryExportPath(outputDirectory, targetPath) {
  return path11.join(
    outputDirectory,
    `.${path11.basename(targetPath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  );
}
__name(createTemporaryExportPath, "createTemporaryExportPath");
function isSamePath(leftPath, rightPath) {
  return isSubpath(leftPath, rightPath) && isSubpath(rightPath, leftPath);
}
__name(isSamePath, "isSamePath");
async function validateStatsExportDirectoryIdentity(cwd, outputDirectory, expectedRealOutputDirectory) {
  const [realCwd, realOutputDirectory] = await Promise.all([
    fs9.realpath(cwd),
    fs9.realpath(outputDirectory)
  ]);
  if (!isSubpath(realCwd, realOutputDirectory) || !isSamePath(expectedRealOutputDirectory, realOutputDirectory)) {
    return statsExportPathError();
  }
  return void 0;
}
__name(validateStatsExportDirectoryIdentity, "validateStatsExportDirectoryIdentity");
async function writeStatsExportFileAtomically(cwd, outputDirectory, targetPath, content) {
  const initialDirectoryError = await validateStatsExportDirectory(
    cwd,
    outputDirectory
  );
  if (initialDirectoryError) {
    return initialDirectoryError;
  }
  const [realCwd, realOutputDirectory] = await Promise.all([
    fs9.realpath(cwd),
    fs9.realpath(outputDirectory)
  ]);
  const realTargetPath = path11.join(
    realOutputDirectory,
    path11.basename(targetPath)
  );
  if (!isSubpath(realCwd, realTargetPath)) {
    return statsExportPathError();
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    let tempPath = createTemporaryExportPath(
      realOutputDirectory,
      targetPath
    );
    try {
      if (!isSubpath(realCwd, tempPath)) {
        return statsExportPathError();
      }
      const preTempDirectoryError = await validateStatsExportDirectoryIdentity(
        cwd,
        outputDirectory,
        realOutputDirectory
      );
      if (preTempDirectoryError) {
        return preTempDirectoryError;
      }
      const preTempFileError = await validateStatsExportFileTarget(realTargetPath);
      if (preTempFileError) {
        return preTempFileError;
      }
      const file = await fs9.open(tempPath, "wx", 384);
      try {
        await file.writeFile(content, { encoding: "utf-8" });
      } finally {
        await file.close();
      }
      const tempFileError = await validateStatsExportFinalFile(cwd, tempPath);
      if (tempFileError) {
        return tempFileError;
      }
      const preRenameDirectoryError = await validateStatsExportDirectoryIdentity(
        cwd,
        outputDirectory,
        realOutputDirectory
      );
      if (preRenameDirectoryError) {
        return preRenameDirectoryError;
      }
      const preRenameFileError = await validateStatsExportFileTarget(realTargetPath);
      if (preRenameFileError) {
        return preRenameFileError;
      }
      await fs9.rename(tempPath, realTargetPath);
      tempPath = void 0;
      return validateStatsExportFinalFile(cwd, realTargetPath);
    } catch (error) {
      if (error.code === "EEXIST") {
        continue;
      }
      throw error;
    } finally {
      if (tempPath) {
        await fs9.rm(tempPath, { force: true }).catch(() => void 0);
      }
    }
  }
  throw new Error(t("Could not create a temporary export file."));
}
__name(writeStatsExportFileAtomically, "writeStatsExportFileAtomically");
function parseStatsExportArgs(args) {
  const tokens = tokenizeArgs(args);
  let period;
  let value;
  let format = "csv";
  let outputPath;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "--format" || token === "-f") {
      const next = tokens[++index];
      if (!next || !VALID_EXPORT_FORMATS.has(next)) {
        throw new Error(t("Expected --format csv or --format json."));
      }
      format = next;
      continue;
    }
    if (token.startsWith("--format=")) {
      const next = token.slice("--format=".length);
      if (!VALID_EXPORT_FORMATS.has(next)) {
        throw new Error(t("Expected --format csv or --format json."));
      }
      format = next;
      continue;
    }
    if (token === "--output" || token === "-o") {
      const next = tokens[++index];
      if (!next) {
        throw new Error(t("Expected a file path after --output."));
      }
      outputPath = next;
      continue;
    }
    if (token.startsWith("--output=")) {
      outputPath = token.slice("--output=".length);
      continue;
    }
    if (!period && (token === "daily" || token === "day")) {
      period = "day";
      continue;
    }
    if (!period && (token === "monthly" || token === "month")) {
      period = "month";
      continue;
    }
    if (!value) {
      value = token;
      continue;
    }
    if (!outputPath) {
      outputPath = token;
      continue;
    }
    throw new Error(
      t("Unexpected argument: {{argument}}", { argument: token })
    );
  }
  if (!period) {
    throw new Error(
      t(
        "Usage: /stats export <daily|monthly> [YYYY-MM-DD|YYYY-MM] [--format csv|json] [--output path]"
      )
    );
  }
  return {
    period,
    value,
    format,
    outputPath
  };
}
__name(parseStatsExportArgs, "parseStatsExportArgs");
function getConfigCwd(context) {
  const config = context.services.config;
  return config?.getWorkingDir() || config?.getProjectRoot() || process.cwd();
}
__name(getConfigCwd, "getConfigCwd");
async function writeStatsExport(context, args) {
  try {
    const parsed = parseStatsExportArgs(args);
    const summary = await queryTokenUsage({
      period: parsed.period,
      value: parsed.value
    });
    const content = parsed.format === "json" ? formatTokenUsageSummaryAsJson(summary) : `${formatTokenUsageSummaryAsCsv(summary)}
`;
    const cwd = path11.resolve(getConfigCwd(context));
    const defaultFilename = `qwen-token-usage-${summary.period}-${summary.value}.${parsed.format}`;
    const targetPath = path11.resolve(cwd, parsed.outputPath || defaultFilename);
    const outputDirectory = path11.dirname(targetPath);
    if (!isSubpath(cwd, targetPath) || !isSubpath(cwd, outputDirectory)) {
      return statsExportPathError();
    }
    const pathShapeError = validateStatsExportPathShape(targetPath);
    if (pathShapeError) {
      return pathShapeError;
    }
    const parentError = await validateStatsExportExistingParent(
      cwd,
      outputDirectory
    );
    if (parentError) {
      return parentError;
    }
    await fs9.mkdir(outputDirectory, { recursive: true });
    const postMkdirError = await validateStatsExportDirectory(
      cwd,
      outputDirectory
    );
    if (postMkdirError) {
      return postMkdirError;
    }
    const preWriteFileError = await validateStatsExportFileTarget(targetPath);
    if (preWriteFileError) {
      return preWriteFileError;
    }
    const writeError = await writeStatsExportFileAtomically(
      cwd,
      outputDirectory,
      targetPath,
      content
    );
    if (writeError) {
      return writeError;
    }
    return asMessage(
      t("Token usage exported to {{format}}: {{path}}", {
        format: parsed.format.toUpperCase(),
        path: path11.relative(cwd, targetPath)
      })
    );
  } catch (error) {
    return asMessage(
      t("Failed to export token usage stats: {{error}}", {
        error: error instanceof Error ? error.message : String(error)
      }),
      "error"
    );
  }
}
__name(writeStatsExport, "writeStatsExport");
var statsCommand = {
  name: "stats",
  altNames: ["usage"],
  get description() {
    return t("Show usage statistics dashboard.");
  },
  argumentHint: "[model|tools|skills|daily|monthly|export]",
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "non_interactive", "acp"],
  action: /* @__PURE__ */ __name((context) => {
    if (context.executionMode !== "interactive") {
      const now = /* @__PURE__ */ new Date();
      const { sessionStartTime, promptCount, metrics } = context.session.stats;
      const wallDuration = sessionStartTime ? now.getTime() - sessionStartTime.getTime() : 0;
      let totalPromptTokens = 0;
      let totalCandidateTokens = 0;
      let totalRequests = 0;
      for (const modelMetrics of Object.values(metrics.models)) {
        totalPromptTokens += modelMetrics.tokens.prompt;
        totalCandidateTokens += modelMetrics.tokens.candidates;
        totalRequests += modelMetrics.api.totalRequests;
      }
      return {
        type: "message",
        messageType: "info",
        content: [
          t("Session duration: {{duration}}", {
            duration: formatDuration(wallDuration)
          }),
          t("Prompts: {{count}}", { count: String(promptCount) }),
          t("API requests: {{count}}", { count: String(totalRequests) }),
          t("Tokens \u2014 prompt: {{prompt}}, output: {{output}}", {
            prompt: String(totalPromptTokens),
            output: String(totalCandidateTokens)
          }),
          ...formatGenerationMetrics(metrics.generation),
          t("Tool calls: {{total}} ({{success}} ok, {{fail}} fail)", {
            total: String(metrics.tools.totalCalls),
            success: String(metrics.tools.totalSuccess),
            fail: String(metrics.tools.totalFail)
          }),
          t("Files: +{{added}} / -{{removed}} lines", {
            added: String(metrics.files.totalLinesAdded),
            removed: String(metrics.files.totalLinesRemoved)
          })
        ].join("\n")
      };
    }
    return { type: "dialog", dialog: "stats" };
  }, "action"),
  subCommands: [
    {
      name: "model",
      get description() {
        return t("Show model-specific usage statistics.");
      },
      kind: "built-in" /* BUILT_IN */,
      supportedModes: ["interactive", "non_interactive", "acp"],
      action: /* @__PURE__ */ __name((context) => {
        if (context.executionMode !== "interactive") {
          const { metrics } = context.session.stats;
          const pricing = context.services.settings.merged.modelPricing;
          const lines = [];
          for (const [modelName, modelMetrics] of Object.entries(
            metrics.models
          )) {
            lines.push(
              `${modelName}: ${t("prompt")}=${modelMetrics.tokens.prompt}, ${t("output")}=${modelMetrics.tokens.candidates}, ${t("cached")}=${modelMetrics.tokens.cached}`
            );
            const cost = calculateCost({
              inputTokens: modelMetrics.tokens.prompt,
              outputTokens: modelMetrics.tokens.candidates + modelMetrics.tokens.thoughts,
              pricing: pricing?.[modelName]
            });
            if (cost != null) {
              lines.push(
                `  ${t("Estimated cost: ${{cost}}", { cost: cost.toFixed(4) })}`
              );
            }
          }
          if (lines.length === 0) {
            lines.push(t("No model usage data yet."));
          }
          return {
            type: "message",
            messageType: "info",
            content: lines.join("\n")
          };
        }
        context.ui.addItem(
          {
            type: "model_stats" /* MODEL_STATS */
          },
          Date.now()
        );
      }, "action")
    },
    {
      name: "tools",
      get description() {
        return t("Show tool-specific usage statistics.");
      },
      kind: "built-in" /* BUILT_IN */,
      supportedModes: ["interactive", "non_interactive", "acp"],
      action: /* @__PURE__ */ __name((context) => {
        if (context.executionMode !== "interactive") {
          const { metrics } = context.session.stats;
          const { tools } = metrics;
          const toolNames = Object.keys(tools.byName);
          const content = toolNames.length > 0 ? [
            t("Tool calls: {{total}} ({{success}} ok, {{fail}} fail)", {
              total: String(tools.totalCalls),
              success: String(tools.totalSuccess),
              fail: String(tools.totalFail)
            }),
            ...toolNames.map((name) => `  ${name}`)
          ].join("\n") : t("No tool usage data yet.");
          return { type: "message", messageType: "info", content };
        }
        context.ui.addItem(
          {
            type: "tool_stats" /* TOOL_STATS */
          },
          Date.now()
        );
      }, "action")
    },
    {
      name: "skills",
      get description() {
        return t("Show skill-specific usage statistics.");
      },
      kind: "built-in" /* BUILT_IN */,
      supportedModes: ["interactive", "non_interactive", "acp"],
      action: /* @__PURE__ */ __name((context) => {
        if (context.executionMode !== "interactive") {
          const skills = context.session.stats.metrics.skills ?? EMPTY_SKILL_METRICS;
          return {
            type: "message",
            messageType: "info",
            content: formatSkillStats(skills)
          };
        }
        context.ui.addItem(
          {
            type: "skill_stats" /* SKILL_STATS */
          },
          Date.now()
        );
      }, "action")
    },
    {
      name: "daily",
      altNames: ["day"],
      get description() {
        return t("Show daily token usage statistics.");
      },
      argumentHint: "[YYYY-MM-DD]",
      kind: "built-in" /* BUILT_IN */,
      supportedModes: ["interactive", "non_interactive", "acp"],
      action: /* @__PURE__ */ __name((context, args) => showTokenUsageStats(context, "day", args), "action")
    },
    {
      name: "monthly",
      altNames: ["month"],
      get description() {
        return t("Show monthly token usage statistics.");
      },
      argumentHint: "[YYYY-MM]",
      kind: "built-in" /* BUILT_IN */,
      supportedModes: ["interactive", "non_interactive", "acp"],
      action: /* @__PURE__ */ __name((context, args) => showTokenUsageStats(context, "month", args), "action")
    },
    {
      name: "export",
      get description() {
        return t("Export token usage statistics to CSV or JSON.");
      },
      argumentHint: "<daily|monthly> [date|month] [--format csv|json] [--output path]",
      kind: "built-in" /* BUILT_IN */,
      supportedModes: ["interactive", "non_interactive", "acp"],
      action: /* @__PURE__ */ __name(async (context, args) => {
        const result = await writeStatsExport(context, args);
        if (context.executionMode !== "interactive") {
          return result;
        }
        addInteractiveMessage(
          context,
          result.content,
          result.messageType === "error" ? "error" /* ERROR */ : "info" /* INFO */
        );
      }, "action")
    }
  ]
};

// packages/cli/src/ui/commands/summaryCommand.ts
init_esbuild_shims();
import * as fsPromises from "fs/promises";
import path12 from "path";
var realpathNearestExisting3 = /* @__PURE__ */ __name(async (targetPath) => {
  let currentPath = targetPath;
  for (; ; ) {
    try {
      return await fsPromises.realpath(currentPath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      const parentPath = path12.dirname(currentPath);
      if (parentPath === currentPath) {
        return currentPath;
      }
      currentPath = parentPath;
    }
  }
}, "realpathNearestExisting");
var assertLeafNotSymlinkEscape = /* @__PURE__ */ __name(async (filePath, realProjectRoot) => {
  let current = filePath;
  const seen = /* @__PURE__ */ new Set();
  for (; ; ) {
    const linkStat = await fsPromises.lstat(current).catch(() => null);
    if (!linkStat?.isSymbolicLink()) break;
    if (seen.has(current)) {
      throw new Error(t("Summary path must be within the project root."));
    }
    seen.add(current);
    const linkTarget = await fsPromises.readlink(current);
    current = path12.isAbsolute(linkTarget) ? linkTarget : path12.resolve(path12.dirname(current), linkTarget);
  }
  const realTarget = await realpathNearestExisting3(current);
  if (!isSubpath(realProjectRoot, realTarget)) {
    throw new Error(t("Summary path must be within the project root."));
  }
}, "assertLeafNotSymlinkEscape");
var SUMMARY_FOOTER_PREFIX = "\n---\n\n## Summary Metadata\n**Update time**: ";
var buildSummaryFooter = /* @__PURE__ */ __name((timestamp) => `${SUMMARY_FOOTER_PREFIX}${timestamp}
`, "buildSummaryFooter");
var readSummaryTail = /* @__PURE__ */ __name(async (p, bytes = 4096) => {
  const handle = await fsPromises.open(p, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, size - length));
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}, "readSummaryTail");
var isGeneratedSummary = /* @__PURE__ */ __name((content) => new RegExp(
  `${SUMMARY_FOOTER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*\\n?$`
).test(content.replace(/\r\n/g, "\n")), "isGeneratedSummary");
var summaryCommand = {
  name: "summary",
  get description() {
    return t(
      "Generate a project summary and save it to .qwen/PROJECT_SUMMARY.md"
    );
  },
  argumentHint: "[path]",
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "non_interactive", "acp"],
  action: /* @__PURE__ */ __name(async (context, args) => {
    const { config } = context.services;
    const { ui } = context;
    const executionMode = context.executionMode ?? "interactive";
    const abortSignal = context.abortSignal;
    if (!config) {
      return {
        type: "message",
        messageType: "error",
        content: t("Config not loaded.")
      };
    }
    const llmClient = config.getLlmClient();
    if (!llmClient) {
      return {
        type: "message",
        messageType: "error",
        content: t("No chat client available to generate summary.")
      };
    }
    if (executionMode === "interactive" && ui.pendingItem) {
      ui.addItem(
        {
          type: "error",
          text: t(
            "Already generating summary, wait for previous request to complete"
          )
        },
        Date.now()
      );
      return {
        type: "message",
        messageType: "error",
        content: t(
          "Already generating summary, wait for previous request to complete"
        )
      };
    }
    const getChatHistory = /* @__PURE__ */ __name(() => {
      const chat = llmClient.getChat();
      return chat.getHistoryShallow();
    }, "getChatHistory");
    const validateChatHistory = /* @__PURE__ */ __name((history2) => {
      if (history2.length <= 2) {
        throw new Error(t("No conversation found to summarize."));
      }
    }, "validateChatHistory");
    const generateSummaryMarkdown = /* @__PURE__ */ __name(async (history2) => {
      const conversationContext = history2.map((message2) => ({
        role: message2.role,
        parts: message2.parts
      }));
      const rawSystemInstruction = llmClient.getChat().getGenerationConfig().systemInstruction;
      const chatSystemInstruction = typeof rawSystemInstruction === "string" ? rawSystemInstruction : void 0;
      const result = await runSideQuery(config, {
        purpose: "project-summary",
        skipOutputLanguagePreference: true,
        model: config.getModel(),
        systemInstruction: chatSystemInstruction,
        contents: [
          ...conversationContext,
          {
            role: "user",
            parts: [
              {
                text: getProjectSummaryPrompt()
              }
            ]
          }
        ],
        abortSignal: abortSignal ?? new AbortController().signal
      });
      if (!result.text) {
        throw new Error(
          t(
            "Failed to generate summary - no text content received from LLM response"
          )
        );
      }
      return result.text;
    }, "generateSummaryMarkdown");
    const resolveSummaryTarget = /* @__PURE__ */ __name(async () => {
      const projectRoot = config.getProjectRoot();
      const defaultSummaryPath = path12.join(
        projectRoot,
        ".qwen",
        "PROJECT_SUMMARY.md"
      );
      const customPath = args?.trim();
      if (!customPath) {
        return {
          summaryPath: defaultSummaryPath,
          filePathForDisplay: ".qwen/PROJECT_SUMMARY.md",
          isDefaultTarget: true,
          realProjectRoot: await fsPromises.realpath(projectRoot)
        };
      }
      const resolved = resolvePath(projectRoot, customPath);
      if (!isSubpath(projectRoot, resolved)) {
        throw new Error(t("Summary path must be within the project root."));
      }
      const realProjectRoot = await fsPromises.realpath(projectRoot);
      await assertLeafNotSymlinkEscape(resolved, realProjectRoot);
      const realResolved = await realpathNearestExisting3(resolved);
      if (!isSubpath(realProjectRoot, realResolved)) {
        throw new Error(t("Summary path must be within the project root."));
      }
      const hasTrailingSep = customPath.endsWith("/") || customPath.endsWith(path12.sep);
      const resolvedStat = await fsPromises.stat(resolved).catch(() => null);
      if (hasTrailingSep && resolvedStat?.isFile()) {
        throw new Error(
          t(
            "Summary path ends with a separator but is an existing file: {{path}}",
            { path: customPath }
          )
        );
      }
      const isDir = hasTrailingSep || (resolvedStat?.isDirectory() ?? false);
      const summaryPath = isDir ? path12.join(resolved, "PROJECT_SUMMARY.md") : resolved;
      if (isDir) {
        await assertLeafNotSymlinkEscape(summaryPath, realProjectRoot);
      }
      const filePathForDisplay = (path12.isAbsolute(customPath) ? summaryPath : path12.relative(projectRoot, summaryPath)).replaceAll(path12.sep, "/");
      const isDefaultTarget = summaryPath === defaultSummaryPath;
      const existingStat = await fsPromises.stat(summaryPath).catch(() => null);
      if (existingStat?.isDirectory()) {
        throw new Error(
          t("Summary path resolves to an existing directory: {{path}}", {
            path: filePathForDisplay
          })
        );
      }
      if (!isDefaultTarget && existingStat?.isFile() && existingStat.size > 0) {
        const existing = await readSummaryTail(summaryPath).catch(() => "");
        if (!isGeneratedSummary(existing)) {
          throw new Error(
            t(
              "Summary path already exists and is not a generated summary: {{path}}",
              { path: filePathForDisplay }
            )
          );
        }
      }
      return {
        summaryPath,
        filePathForDisplay,
        isDefaultTarget,
        realProjectRoot
      };
    }, "resolveSummaryTarget");
    const saveSummaryToDisk = /* @__PURE__ */ __name(async (markdownSummary, target) => {
      const summaryContent = `${markdownSummary}
${buildSummaryFooter(
        (/* @__PURE__ */ new Date()).toISOString()
      )}`;
      if (!target.isDefaultTarget) {
        await assertLeafNotSymlinkEscape(
          target.summaryPath,
          target.realProjectRoot
        );
      }
      const preWriteStat = await fsPromises.stat(target.summaryPath).catch(() => null);
      if (!target.isDefaultTarget && preWriteStat?.isFile() && preWriteStat.size > 0) {
        const existing = await readSummaryTail(target.summaryPath).catch(
          () => ""
        );
        if (!isGeneratedSummary(existing)) {
          throw new Error(
            t(
              "Summary path already exists and is not a generated summary: {{path}}",
              { path: target.filePathForDisplay }
            )
          );
        }
      }
      await fsPromises.mkdir(path12.dirname(target.summaryPath), {
        recursive: true,
        ...target.isDefaultTarget ? { mode: 448 } : {}
      });
      await fsPromises.writeFile(target.summaryPath, summaryContent, {
        encoding: "utf8",
        mode: 384
      });
      return {
        filePathForDisplay: target.filePathForDisplay,
        fullPath: target.summaryPath
      };
    }, "saveSummaryToDisk");
    const emitInteractivePending = /* @__PURE__ */ __name((stage) => {
      if (executionMode !== "interactive") {
        return;
      }
      const pendingMessage = {
        type: "summary",
        summary: {
          isPending: true,
          stage
        }
      };
      ui.setPendingItem(pendingMessage);
    }, "emitInteractivePending");
    const completeInteractive = /* @__PURE__ */ __name((filePathForDisplay) => {
      if (executionMode !== "interactive") {
        return;
      }
      ui.setPendingItem(null);
      const completedSummaryItem = {
        type: "summary",
        summary: {
          isPending: false,
          stage: "completed",
          filePath: filePathForDisplay
        }
      };
      ui.addItem(completedSummaryItem, Date.now());
    }, "completeInteractive");
    const formatErrorMessage3 = /* @__PURE__ */ __name((error) => t("Failed to generate project context summary: {{error}}", {
      error: error instanceof Error ? error.message : String(error)
    }), "formatErrorMessage");
    const failInteractive = /* @__PURE__ */ __name((error) => {
      if (executionMode !== "interactive") {
        return;
      }
      if (abortSignal?.aborted) {
        return;
      }
      ui.setPendingItem(null);
      ui.addItem(
        {
          type: "error",
          text: `\u2717 ${formatErrorMessage3(error)}`
        },
        Date.now()
      );
    }, "failInteractive");
    const formatSuccessMessage = /* @__PURE__ */ __name((filePathForDisplay) => t("Saved project summary to {{filePathForDisplay}}.", {
      filePathForDisplay
    }), "formatSuccessMessage");
    const returnNoConversationMessage = /* @__PURE__ */ __name(() => {
      const msg = t("No conversation found to summarize.");
      if (executionMode === "acp") {
        const messages = /* @__PURE__ */ __name(async function* () {
          yield {
            messageType: "info",
            content: msg
          };
        }, "messages");
        return {
          type: "stream_messages",
          messages: messages()
        };
      }
      return {
        type: "message",
        messageType: "info",
        content: msg
      };
    }, "returnNoConversationMessage");
    const executeSummaryGeneration = /* @__PURE__ */ __name(async (history2) => {
      const target = await resolveSummaryTarget();
      emitInteractivePending("generating");
      const markdownSummary = await generateSummaryMarkdown(history2);
      if (abortSignal?.aborted) {
        throw new DOMException("Summary generation cancelled.", "AbortError");
      }
      emitInteractivePending("saving");
      const { filePathForDisplay } = await saveSummaryToDisk(
        markdownSummary,
        target
      );
      completeInteractive(filePathForDisplay);
      return { markdownSummary, filePathForDisplay };
    }, "executeSummaryGeneration");
    const history = getChatHistory();
    try {
      validateChatHistory(history);
    } catch (_error) {
      return returnNoConversationMessage();
    }
    if (executionMode === "acp") {
      const messages = /* @__PURE__ */ __name(async function* () {
        try {
          yield {
            messageType: "info",
            content: t("Generating project summary...")
          };
          const { filePathForDisplay } = await executeSummaryGeneration(history);
          yield {
            messageType: "info",
            content: formatSuccessMessage(filePathForDisplay)
          };
        } catch (error) {
          failInteractive(error);
          yield {
            messageType: "error",
            content: formatErrorMessage3(error)
          };
        }
      }, "messages");
      return {
        type: "stream_messages",
        messages: messages()
      };
    }
    try {
      const { filePathForDisplay } = await executeSummaryGeneration(history);
      if (executionMode === "non_interactive") {
        return {
          type: "message",
          messageType: "info",
          content: formatSuccessMessage(filePathForDisplay)
        };
      }
      return {
        type: "message",
        messageType: "info",
        content: ""
      };
    } catch (error) {
      failInteractive(error);
      return {
        type: "message",
        messageType: "error",
        content: executionMode === "interactive" ? "" : formatErrorMessage3(error)
      };
    }
  }, "action")
};

// packages/cli/src/ui/commands/terminalSetupCommand.ts
init_esbuild_shims();

// packages/cli/src/ui/utils/terminalSetup.ts
init_esbuild_shims();
import { promises as fs10 } from "node:fs";
import * as os4 from "node:os";
import * as path13 from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
var debugLogger15 = createDebugLogger("TERMINAL_SETUP");
var execAsync = promisify(exec);
function stripJsonComments2(content) {
  return content.replace(/^\s*\/\/.*$/gm, "");
}
__name(stripJsonComments2, "stripJsonComments");
async function detectTerminal() {
  const termProgram = process.env["TERM_PROGRAM"];
  if (process.env["CURSOR_TRACE_ID"] || process.env["VSCODE_GIT_ASKPASS_MAIN"]?.toLowerCase().includes("cursor")) {
    return "cursor";
  }
  if (process.env["VSCODE_GIT_ASKPASS_MAIN"]?.toLowerCase().includes("windsurf")) {
    return "windsurf";
  }
  if (process.env["TERM_PRODUCT"]?.toLowerCase().includes("trae")) {
    return "trae";
  }
  if (termProgram === "vscode" || process.env["VSCODE_GIT_IPC_HANDLE"]) {
    return "vscode";
  }
  if (os4.platform() !== "win32") {
    try {
      const { stdout } = await execAsync("ps -o comm= -p $PPID");
      const parentName = stdout.trim();
      if (parentName.includes("windsurf") || parentName.includes("Windsurf"))
        return "windsurf";
      if (parentName.includes("cursor") || parentName.includes("Cursor"))
        return "cursor";
      if (parentName.includes("code") || parentName.includes("Code"))
        return "vscode";
      if (parentName.includes("trae") || parentName.includes("Trae"))
        return "trae";
    } catch (error) {
      debugLogger15.debug("Parent process detection failed:", error);
    }
  }
  return null;
}
__name(detectTerminal, "detectTerminal");
async function backupFile(filePath) {
  try {
    const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
    const backupPath = `${filePath}.backup.${timestamp}`;
    await fs10.copyFile(filePath, backupPath);
  } catch (error) {
    debugLogger15.warn(`Failed to create backup of ${filePath}:`, error);
  }
}
__name(backupFile, "backupFile");
function getVSCodeStyleConfigDir(appName) {
  const platform2 = os4.platform();
  if (platform2 === "darwin") {
    return path13.join(
      os4.homedir(),
      "Library",
      "Application Support",
      appName,
      "User"
    );
  } else if (platform2 === "win32") {
    if (!process.env["APPDATA"]) {
      return null;
    }
    return path13.join(process.env["APPDATA"], appName, "User");
  } else {
    return path13.join(os4.homedir(), ".config", appName, "User");
  }
}
__name(getVSCodeStyleConfigDir, "getVSCodeStyleConfigDir");
async function configureVSCodeStyle(terminalName, appName) {
  const configDir = getVSCodeStyleConfigDir(appName);
  if (!configDir) {
    return {
      success: false,
      message: t(
        "Could not determine {{terminalName}} config path on Windows: APPDATA environment variable is not set.",
        { terminalName }
      )
    };
  }
  const keybindingsFile = path13.join(configDir, "keybindings.json");
  try {
    await fs10.mkdir(configDir, { recursive: true });
    let keybindings = [];
    try {
      const content = await fs10.readFile(keybindingsFile, "utf8");
      await backupFile(keybindingsFile);
      try {
        const cleanContent = stripJsonComments2(content);
        const parsedContent = JSON.parse(cleanContent);
        if (!Array.isArray(parsedContent)) {
          return {
            success: false,
            message: t(
              "{{terminalName}} keybindings.json exists but is not a valid JSON array. Please fix the file manually or delete it to allow automatic configuration.",
              { terminalName }
            ) + "\n" + t("File: {{file}}", { file: keybindingsFile })
          };
        }
        keybindings = parsedContent;
      } catch (parseError) {
        return {
          success: false,
          message: t(
            "Failed to parse {{terminalName}} keybindings.json. The file contains invalid JSON. Please fix the file manually or delete it to allow automatic configuration.",
            { terminalName }
          ) + "\n" + t("File: {{file}}", { file: keybindingsFile }) + "\n" + t("Error: {{error}}", { error: String(parseError) })
        };
      }
    } catch {
    }
    const shiftEnterBinding = {
      key: "shift+enter",
      command: "workbench.action.terminal.sendSequence",
      when: "terminalFocus",
      args: { text: VSCODE_SHIFT_ENTER_SEQUENCE }
    };
    const ctrlEnterBinding = {
      key: "ctrl+enter",
      command: "workbench.action.terminal.sendSequence",
      when: "terminalFocus",
      args: { text: VSCODE_SHIFT_ENTER_SEQUENCE }
    };
    const existingShiftEnter = keybindings.find((kb) => {
      const binding = kb;
      return binding.key === "shift+enter";
    });
    const existingCtrlEnter = keybindings.find((kb) => {
      const binding = kb;
      return binding.key === "ctrl+enter";
    });
    if (existingShiftEnter || existingCtrlEnter) {
      const messages = [];
      if (existingShiftEnter) {
        messages.push("- " + t("Shift+Enter binding already exists"));
      }
      if (existingCtrlEnter) {
        messages.push("- " + t("Ctrl+Enter binding already exists"));
      }
      return {
        success: false,
        message: t(
          "Existing keybindings detected. Will not modify to avoid conflicts."
        ) + "\n" + messages.join("\n") + "\n" + t("Please check and modify manually if needed: {{file}}", {
          file: keybindingsFile
        })
      };
    }
    const hasOurShiftEnter = keybindings.some((kb) => {
      const binding = kb;
      return binding.key === "shift+enter" && binding.command === "workbench.action.terminal.sendSequence" && binding.args?.text === "\\\r\n";
    });
    const hasOurCtrlEnter = keybindings.some((kb) => {
      const binding = kb;
      return binding.key === "ctrl+enter" && binding.command === "workbench.action.terminal.sendSequence" && binding.args?.text === "\\\r\n";
    });
    if (!hasOurShiftEnter || !hasOurCtrlEnter) {
      if (!hasOurShiftEnter) keybindings.unshift(shiftEnterBinding);
      if (!hasOurCtrlEnter) keybindings.unshift(ctrlEnterBinding);
      await fs10.writeFile(keybindingsFile, JSON.stringify(keybindings, null, 4));
      return {
        success: true,
        message: t(
          "Added Shift+Enter and Ctrl+Enter keybindings to {{terminalName}}.",
          {
            terminalName
          }
        ) + "\n" + t("Modified: {{file}}", { file: keybindingsFile }),
        requiresRestart: true
      };
    } else {
      return {
        success: true,
        message: t("{{terminalName}} keybindings already configured.", {
          terminalName
        })
      };
    }
  } catch (error) {
    return {
      success: false,
      message: t("Failed to configure {{terminalName}}.", { terminalName }) + "\n" + t("File: {{file}}", { file: keybindingsFile }) + "\n" + t("Error: {{error}}", { error: String(error) })
    };
  }
}
__name(configureVSCodeStyle, "configureVSCodeStyle");
async function configureVSCode() {
  return configureVSCodeStyle("VS Code", "Code");
}
__name(configureVSCode, "configureVSCode");
async function configureCursor() {
  return configureVSCodeStyle("Cursor", "Cursor");
}
__name(configureCursor, "configureCursor");
async function configureWindsurf() {
  return configureVSCodeStyle("Windsurf", "Windsurf");
}
__name(configureWindsurf, "configureWindsurf");
async function configureTrae() {
  return configureVSCodeStyle("Trae", "Trae");
}
__name(configureTrae, "configureTrae");
async function terminalSetup() {
  if (isKittyProtocolEnabled()) {
    return {
      success: true,
      message: t(
        "Your terminal is already configured for an optimal experience with multiline input (Shift+Enter and Ctrl+Enter)."
      )
    };
  }
  const terminal = await detectTerminal();
  if (!terminal) {
    return {
      success: false,
      message: t(
        "Could not detect terminal type. Supported terminals: VS Code, Cursor, Windsurf, and Trae."
      )
    };
  }
  switch (terminal) {
    case "vscode":
      return configureVSCode();
    case "cursor":
      return configureCursor();
    case "windsurf":
      return configureWindsurf();
    case "trae":
      return configureTrae();
    default:
      return {
        success: false,
        message: t('Terminal "{{terminal}}" is not supported yet.', {
          terminal
        })
      };
  }
}
__name(terminalSetup, "terminalSetup");

// packages/cli/src/ui/commands/terminalSetupCommand.ts
var terminalSetupCommand = {
  name: "terminal-setup",
  get description() {
    return t(
      "Configure terminal keybindings for multiline input (VS Code, Cursor, Windsurf, Trae)"
    );
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive"],
  canRunDuringStreaming: true,
  action: /* @__PURE__ */ __name(async () => {
    try {
      const result = await terminalSetup();
      let content = result.message;
      if (result.requiresRestart) {
        content += "\n\n" + t("Please restart your terminal for the changes to take effect.");
      }
      return {
        type: "message",
        content,
        messageType: result.success ? "info" : "error"
      };
    } catch (error) {
      return {
        type: "message",
        content: t("Failed to configure terminal: {{error}}", {
          error: String(error)
        }),
        messageType: "error"
      };
    }
  }, "action")
};

// packages/cli/src/ui/commands/themeCommand.ts
init_esbuild_shims();
import process5 from "node:process";
var themeCommand = {
  name: "theme",
  get description() {
    return t("change the theme");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive"],
  canRunDuringStreaming: true,
  action: /* @__PURE__ */ __name((_context, _args) => {
    if (process5.env["NO_COLOR"]) {
      return {
        type: "message",
        messageType: "info",
        content: t(
          "Theme configuration unavailable due to NO_COLOR env variable."
        )
      };
    }
    return {
      type: "dialog",
      dialog: "theme"
    };
  }, "action")
};

// packages/cli/src/ui/commands/toolsCommand.ts
init_esbuild_shims();
var toolsCommand = {
  name: "tools",
  get description() {
    return t("List available Qwen Code tools. Usage: /tools [desc]");
  },
  kind: "built-in" /* BUILT_IN */,
  canRunDuringStreaming: true,
  action: /* @__PURE__ */ __name(async (context, args) => {
    const subCommand = args?.trim();
    let useShowDescriptions = false;
    if (subCommand === "desc" || subCommand === "descriptions") {
      useShowDescriptions = true;
    }
    const toolRegistry = context.services.config?.getToolRegistry();
    if (!toolRegistry) {
      context.ui.addItem(
        {
          type: "error" /* ERROR */,
          text: t("Could not retrieve tool registry.")
        },
        Date.now()
      );
      return;
    }
    const config = context.services.config;
    const tools = toolRegistry.getAllTools();
    const llmTools = tools.filter((tool) => !("serverName" in tool));
    const toolsListItem = {
      type: "tools_list" /* TOOLS_LIST */,
      tools: llmTools.map((tool) => ({
        name: tool.name,
        displayName: tool.displayName,
        description: tool.description,
        // Omni media-policy tools without modelAccess.enabled are stripped
        // from the model's declarations but stay listed here for the human;
        // the flag renders a "fixed-only" marker so the discrepancy between
        // /tools and what the model can call is visible, not confusing.
        ...isMediaPolicyToolHiddenFromModel(config, tool) ? { fixedOnly: true } : {},
        // Surface the deferred/eager split so a `tools.eager` allowlist is
        // visible rather than silently reshaping the model's toolset — the
        // user-facing half of #10075.
        deferred: toolRegistry.isDeferredAndHidden(tool.name)
      })),
      showDescriptions: useShowDescriptions
    };
    context.ui.addItem(toolsListItem, Date.now());
  }, "action")
};

// packages/cli/src/ui/commands/vimCommand.ts
init_esbuild_shims();
var vimCommand = {
  name: "vim",
  get description() {
    return t("toggle vim mode on/off");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive"],
  canRunDuringStreaming: true,
  action: /* @__PURE__ */ __name(async (context, _args) => {
    const newVimState = await context.ui.toggleVimEnabled();
    const message2 = newVimState ? "Entered Vim mode. Run /vim again to exit." : "Exited Vim mode.";
    return {
      type: "message",
      messageType: "info",
      content: message2
    };
  }, "action")
};

// packages/cli/src/ui/commands/voice-command.ts
init_esbuild_shims();

// packages/cli/src/ui/voice/voice-availability.ts
init_esbuild_shims();
import { existsSync as existsSync2 } from "node:fs";
import process6 from "node:process";
var SUPPORTED_PLATFORMS = [
  "darwin",
  "linux",
  "win32"
];
function getVoiceUnavailableReason(environment = {
  platform: process6.platform,
  env: process6.env
}) {
  const { platform: platform2, env } = environment;
  const fileExists = environment.fileExists ?? existsSync2;
  if (!SUPPORTED_PLATFORMS.includes(platform2)) {
    return t("Voice dictation is not supported on {{platform}}.", {
      platform: platform2
    });
  }
  if (platform2 === "linux" && isWsl(env) && !env["PULSE_SERVER"] && !fileExists("/mnt/wslg/PulseServer")) {
    return t(
      "Voice dictation needs microphone access, which is unavailable in this WSL session. Use WSLg/PulseAudio, or run Qwen Code on a host with a microphone."
    );
  }
  return void 0;
}
__name(getVoiceUnavailableReason, "getVoiceUnavailableReason");

// packages/cli/src/ui/commands/voice-command.ts
var voiceCommand = {
  name: "voice",
  get description() {
    return t("Toggle voice dictation input");
  },
  argumentHint: "[hold|tap|off|status]",
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive"],
  canRunDuringStreaming: true,
  action: /* @__PURE__ */ __name((context, args) => {
    const settings = context.services.settings;
    const command = args.trim().toLowerCase();
    if (command === "status") {
      const voiceModel2 = readVoiceModel(settings);
      const status = isVoiceEnabled(settings) ? "enabled" : "disabled";
      const modelText = voiceModel2 ? t("model: {{voiceModel}}", { voiceModel: voiceModel2 }) : t("no voice model selected");
      return {
        type: "message",
        messageType: "info",
        content: t(
          "Voice dictation: {{status}} (mode: {{mode}}, {{modelText}}).",
          {
            status,
            mode: readVoiceMode(settings),
            modelText
          }
        )
      };
    }
    if (command === "off") {
      settings.setValue(
        getVoiceSettingsScope(settings),
        "general.voice.enabled",
        false
      );
      return {
        type: "message",
        messageType: "info",
        content: t("Voice dictation disabled.")
      };
    }
    if (command !== "" && command !== "hold" && command !== "tap") {
      return {
        type: "message",
        messageType: "warning",
        content: t("Usage: /voice [hold|tap|off|status]")
      };
    }
    if (command === "" && isVoiceEnabled(settings)) {
      settings.setValue(
        getVoiceSettingsScope(settings),
        "general.voice.enabled",
        false
      );
      return {
        type: "message",
        messageType: "info",
        content: t("Voice dictation disabled.")
      };
    }
    const voiceModel = readVoiceModel(settings);
    if (!voiceModel) {
      return {
        type: "message",
        messageType: "warning",
        content: t(
          "No voice model selected. Run /model --voice to choose one before enabling voice dictation."
        )
      };
    }
    const unavailableReason = getVoiceUnavailableReason();
    if (unavailableReason) {
      return {
        type: "message",
        messageType: "warning",
        content: unavailableReason
      };
    }
    const scope = getVoiceSettingsScope(settings);
    const mode = command === "tap" ? "tap" : command === "hold" ? "hold" : readVoiceMode(settings);
    settings.setValue(scope, "general.voice.mode", mode);
    settings.setValue(scope, "general.voice.enabled", true);
    return {
      type: "message",
      messageType: "info",
      content: mode === "tap" ? t(
        "Voice dictation enabled (tap mode). Tap Space at an empty prompt to start, tap again or pause to stop and submit, using {{voiceModel}}.",
        { voiceModel }
      ) : t(
        "Voice dictation enabled (hold mode). Hold Space at an empty prompt to dictate with {{voiceModel}}.",
        { voiceModel }
      )
    };
  }, "action")
};

// packages/cli/src/ui/commands/setupGithubCommand.ts
init_esbuild_shims();
function getOpenUrlsCommands(readmeUrl, secretsUrl) {
  const openCmd = getUrlOpenCommand();
  const urlsToOpen = [readmeUrl];
  if (secretsUrl) urlsToOpen.push(secretsUrl);
  const commands = urlsToOpen.map((url) => `${openCmd} "${url}"`);
  return commands;
}
__name(getOpenUrlsCommands, "getOpenUrlsCommands");
var setupGithubCommand = {
  name: "setup-github",
  get description() {
    return t("Set up GitHub Actions");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive"],
  action: /* @__PURE__ */ __name(async (context) => {
    const abortController = new AbortController();
    if (context.abortSignal) {
      context.abortSignal.addEventListener(
        "abort",
        () => abortController.abort(),
        { once: true }
      );
    }
    const proxy = context?.services?.config?.getProxy();
    const result = await setupGithub({
      proxy,
      abortSignal: abortController.signal
    }).finally(() => abortController.abort());
    const commands = [];
    commands.push("set -eEuo pipefail");
    commands.push(
      `echo "Successfully downloaded ${GITHUB_WORKFLOW_PATHS.length} workflows and updated .gitignore. Follow the steps in ${result.readmeUrl} (skipping the /setup-github step) to complete setup."`
    );
    commands.push(...getOpenUrlsCommands(result.readmeUrl, result.secretsUrl));
    const command = `(${commands.join(" && ")})`;
    return {
      type: "tool",
      toolName: "run_shell_command",
      toolArgs: {
        description: "Setting up GitHub Actions to triage issues and review PRs with Qwen.",
        command,
        is_background: false
      }
    };
  }, "action")
};

// packages/cli/src/ui/commands/insightCommand.ts
init_esbuild_shims();
import { join as join7 } from "path";
import { pathToFileURL } from "node:url";

// packages/cli/src/services/insight/generators/StaticInsightGenerator.ts
init_esbuild_shims();
import fs12 from "fs/promises";
import path15 from "path";

// packages/cli/src/services/insight/generators/DataProcessor.ts
init_esbuild_shims();
import fs11 from "fs/promises";
import path14 from "path";

// packages/cli/node_modules/p-limit/index.js
init_esbuild_shims();

// packages/cli/node_modules/yocto-queue/index.js
init_esbuild_shims();
var Node = class {
  static {
    __name(this, "Node");
  }
  value;
  next;
  constructor(value) {
    this.value = value;
  }
};
var Queue = class {
  static {
    __name(this, "Queue");
  }
  #head;
  #tail;
  #size;
  constructor() {
    this.clear();
  }
  enqueue(value) {
    const node = new Node(value);
    if (this.#head) {
      this.#tail.next = node;
      this.#tail = node;
    } else {
      this.#head = node;
      this.#tail = node;
    }
    this.#size++;
  }
  dequeue() {
    const current = this.#head;
    if (!current) {
      return;
    }
    this.#head = this.#head.next;
    this.#size--;
    if (!this.#head) {
      this.#tail = void 0;
    }
    return current.value;
  }
  peek() {
    if (!this.#head) {
      return;
    }
    return this.#head.value;
  }
  clear() {
    this.#head = void 0;
    this.#tail = void 0;
    this.#size = 0;
  }
  get size() {
    return this.#size;
  }
  *[Symbol.iterator]() {
    let current = this.#head;
    while (current) {
      yield current.value;
      current = current.next;
    }
  }
  *drain() {
    while (this.#head) {
      yield this.dequeue();
    }
  }
};

// packages/cli/node_modules/p-limit/index.js
function pLimit(concurrency) {
  let rejectOnClear = false;
  if (typeof concurrency === "object") {
    ({ concurrency, rejectOnClear = false } = concurrency);
  }
  validateConcurrency(concurrency);
  if (typeof rejectOnClear !== "boolean") {
    throw new TypeError("Expected `rejectOnClear` to be a boolean");
  }
  const queue = new Queue();
  let activeCount = 0;
  const resumeNext = /* @__PURE__ */ __name(() => {
    if (activeCount < concurrency && queue.size > 0) {
      activeCount++;
      queue.dequeue().run();
    }
  }, "resumeNext");
  const next = /* @__PURE__ */ __name(() => {
    activeCount--;
    resumeNext();
  }, "next");
  const run = /* @__PURE__ */ __name(async (function_, resolve4, arguments_) => {
    const result = (async () => function_(...arguments_))();
    resolve4(result);
    try {
      await result;
    } catch {
    }
    next();
  }, "run");
  const enqueue = /* @__PURE__ */ __name((function_, resolve4, reject, arguments_) => {
    const queueItem = { reject };
    new Promise((internalResolve) => {
      queueItem.run = internalResolve;
      queue.enqueue(queueItem);
    }).then(run.bind(void 0, function_, resolve4, arguments_));
    if (activeCount < concurrency) {
      resumeNext();
    }
  }, "enqueue");
  const generator = /* @__PURE__ */ __name((function_, ...arguments_) => new Promise((resolve4, reject) => {
    enqueue(function_, resolve4, reject, arguments_);
  }), "generator");
  Object.defineProperties(generator, {
    activeCount: {
      get: /* @__PURE__ */ __name(() => activeCount, "get")
    },
    pendingCount: {
      get: /* @__PURE__ */ __name(() => queue.size, "get")
    },
    clearQueue: {
      value() {
        if (!rejectOnClear) {
          queue.clear();
          return;
        }
        const abortError = AbortSignal.abort().reason;
        while (queue.size > 0) {
          queue.dequeue().reject(abortError);
        }
      }
    },
    concurrency: {
      get: /* @__PURE__ */ __name(() => concurrency, "get"),
      set(newConcurrency) {
        validateConcurrency(newConcurrency);
        concurrency = newConcurrency;
        queueMicrotask(() => {
          while (activeCount < concurrency && queue.size > 0) {
            resumeNext();
          }
        });
      }
    },
    map: {
      async value(iterable, function_) {
        const promises = Array.from(iterable, (value, index) => this(function_, value, index));
        return Promise.all(promises);
      }
    }
  });
  return generator;
}
__name(pLimit, "pLimit");
function validateConcurrency(concurrency) {
  if (!((Number.isInteger(concurrency) || concurrency === Number.POSITIVE_INFINITY) && concurrency > 0)) {
    throw new TypeError("Expected `concurrency` to be a number from 1 and up");
  }
}
__name(validateConcurrency, "validateConcurrency");

// packages/cli/src/services/insight/dates.ts
init_esbuild_shims();
function dayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
__name(dayKey, "dayKey");
function parseDayKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}
__name(parseDayKey, "parseDayKey");
function todayKey(now = /* @__PURE__ */ new Date()) {
  return dayKey(now);
}
__name(todayKey, "todayKey");
function hourOfDay(date) {
  return date.getHours();
}
__name(hourOfDay, "hourOfDay");

// packages/cli/src/services/insight/generators/DataProcessor.ts
var logger = createDebugLogger("DataProcessor");
var CONCURRENCY_LIMIT = 4;
var SESSION_OUTCOMES = [
  "fully_achieved",
  "mostly_achieved",
  "partially_achieved",
  "not_achieved",
  "unclear_from_transcript"
];
var OUTCOME_FALLBACK = "unclear_from_transcript";
var QWEN_HELPFULNESS_LEVELS = [
  "unhelpful",
  "slightly_helpful",
  "moderately_helpful",
  "very_helpful",
  "essential"
];
var SESSION_TYPES = [
  "single_task",
  "multi_task",
  "iterative_refinement",
  "exploration",
  "quick_question"
];
var PRIMARY_SUCCESS_VALUES = [
  "none",
  "fast_accurate_search",
  "correct_code_edits",
  "good_explanations",
  "proactive_help",
  "multi_file_changes",
  "good_debugging"
];
var PRIMARY_SUCCESS_FALLBACK = "none";
function hasMeaningfulInsightValue(value) {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && value !== 0;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasMeaningfulInsightValue(item));
  }
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => hasMeaningfulInsightValue(item));
  }
  return false;
}
__name(hasMeaningfulInsightValue, "hasMeaningfulInsightValue");
function normalizeInsightText(value) {
  return typeof value === "string" ? value.trim() : "";
}
__name(normalizeInsightText, "normalizeInsightText");
function normalizeInsightCountRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.entries(value).reduce(
    (acc, [key, count]) => {
      if (typeof count === "number" && Number.isFinite(count) && count > 0) {
        acc[key] = count;
      }
      return acc;
    },
    {}
  );
}
__name(normalizeInsightCountRecord, "normalizeInsightCountRecord");
function getInsightCountEntries(value) {
  return Object.entries(normalizeInsightCountRecord(value));
}
__name(getInsightCountEntries, "getInsightCountEntries");
function normalizeInsightEnum(value, allowed, fallback) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed) {
    const match = allowed.find(
      (item) => String(item).toLowerCase() === trimmed.toLowerCase()
    );
    if (match) return match;
  }
  logger.debug(
    `Normalized unknown insight enum value "${String(value)}" to fallback "${fallback}"`
  );
  return fallback;
}
__name(normalizeInsightEnum, "normalizeInsightEnum");
function normalizeSessionFacet(facet, sessionId) {
  if (!facet || typeof facet !== "object" || Array.isArray(facet)) {
    return null;
  }
  const rawFacet = facet;
  const normalizedFacet = {
    session_id: sessionId,
    underlying_goal: normalizeInsightText(rawFacet["underlying_goal"]),
    goal_categories: normalizeInsightCountRecord(rawFacet["goal_categories"]),
    outcome: normalizeInsightEnum(
      rawFacet["outcome"],
      SESSION_OUTCOMES,
      OUTCOME_FALLBACK
    ),
    user_satisfaction_counts: normalizeInsightCountRecord(
      rawFacet["user_satisfaction_counts"]
    ),
    Qwen_helpfulness: normalizeInsightEnum(
      rawFacet["Qwen_helpfulness"],
      QWEN_HELPFULNESS_LEVELS,
      "moderately_helpful"
    ),
    session_type: normalizeInsightEnum(
      rawFacet["session_type"],
      SESSION_TYPES,
      "single_task"
    ),
    friction_counts: normalizeInsightCountRecord(rawFacet["friction_counts"]),
    friction_detail: normalizeInsightText(rawFacet["friction_detail"]),
    primary_success: normalizeInsightEnum(
      rawFacet["primary_success"],
      PRIMARY_SUCCESS_VALUES,
      PRIMARY_SUCCESS_FALLBACK
    ),
    brief_summary: normalizeInsightText(rawFacet["brief_summary"])
  };
  const meaningfulContent = {
    underlying_goal: normalizedFacet.underlying_goal,
    goal_categories: normalizedFacet.goal_categories,
    outcome: normalizedFacet.outcome === OUTCOME_FALLBACK ? "" : normalizedFacet.outcome,
    user_satisfaction_counts: normalizedFacet.user_satisfaction_counts,
    friction_counts: normalizedFacet.friction_counts,
    friction_detail: normalizedFacet.friction_detail,
    primary_success: normalizedFacet.primary_success === PRIMARY_SUCCESS_FALLBACK ? "" : normalizedFacet.primary_success,
    brief_summary: normalizedFacet.brief_summary
  };
  return hasMeaningfulInsightValue(meaningfulContent) ? normalizedFacet : null;
}
__name(normalizeSessionFacet, "normalizeSessionFacet");
var DataProcessor = class {
  constructor(config) {
    this.config = config;
  }
  static {
    __name(this, "DataProcessor");
  }
  // Format chat records for LLM analysis
  formatRecordsForAnalysis(records) {
    let output = "";
    const sessionStart = records.length > 0 ? new Date(records[0].timestamp) : /* @__PURE__ */ new Date();
    output += `Session: ${records[0]?.sessionId || "unknown"}
`;
    output += `Date: ${sessionStart.toISOString()}
`;
    output += `Duration: ${records.length} turns

`;
    for (const record of records) {
      if (record.type === "user") {
        const projection = projectUserTranscriptForDisplay(record);
        const text = projection.displayText ?? projection.parts.map(
          (part) => typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : ""
        ).join("");
        output += `[User]: ${text}
`;
      } else if (record.type === "assistant") {
        if (record.message?.parts) {
          for (const part of record.message.parts) {
            if ("text" in part && part.text) {
              output += `[Assistant]: ${part.text}
`;
            } else if ("functionCall" in part) {
              const call = part.functionCall;
              if (call) {
                output += `[Tool: ${call.name}]
`;
              }
            }
          }
        }
      }
    }
    return output;
  }
  // Only analyze conversational sessions for facets (skip system-only logs).
  hasUserAndAssistantRecords(records) {
    let hasUser = false;
    let hasAssistant = false;
    for (const record of records) {
      if (record.type === "user") {
        hasUser = true;
      } else if (record.type === "assistant") {
        hasAssistant = true;
      }
      if (hasUser && hasAssistant) {
        return true;
      }
    }
    return false;
  }
  // Analyze a single session using LLM
  async analyzeSession(records) {
    if (records.length === 0) return null;
    const INSIGHT_SCHEMA = {
      type: "object",
      properties: {
        underlying_goal: {
          type: "string",
          description: "What the user fundamentally wanted to achieve"
        },
        goal_categories: {
          type: "object",
          additionalProperties: { type: "number" }
        },
        outcome: {
          type: "string",
          enum: [
            "fully_achieved",
            "mostly_achieved",
            "partially_achieved",
            "not_achieved",
            "unclear_from_transcript"
          ]
        },
        user_satisfaction_counts: {
          type: "object",
          additionalProperties: { type: "number" }
        },
        Qwen_helpfulness: {
          type: "string",
          enum: [
            "unhelpful",
            "slightly_helpful",
            "moderately_helpful",
            "very_helpful",
            "essential"
          ]
        },
        session_type: {
          type: "string",
          enum: [
            "single_task",
            "multi_task",
            "iterative_refinement",
            "exploration",
            "quick_question"
          ]
        },
        friction_counts: {
          type: "object",
          additionalProperties: { type: "number" }
        },
        friction_detail: {
          type: "string",
          description: "One sentence describing friction or empty"
        },
        primary_success: {
          type: "string",
          enum: [
            "none",
            "fast_accurate_search",
            "correct_code_edits",
            "good_explanations",
            "proactive_help",
            "multi_file_changes",
            "good_debugging"
          ]
        },
        brief_summary: {
          type: "string",
          description: "One sentence: what user wanted and whether they got it"
        }
      },
      required: [
        "underlying_goal",
        "goal_categories",
        "outcome",
        "user_satisfaction_counts",
        "Qwen_helpfulness",
        "session_type",
        "friction_counts",
        "friction_detail",
        "primary_success",
        "brief_summary"
      ]
    };
    const sessionText = this.formatRecordsForAnalysis(records);
    const prompt = `${getInsightPrompt("analysis")}

SESSION:
${sessionText}`;
    try {
      const result = await runSideQuery(this.config, {
        purpose: "insight-session-analysis",
        // Quality is the entire point — keep main model + reasoning on.
        model: this.config.getModel(),
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        schema: INSIGHT_SCHEMA,
        config: {
          thinkingConfig: { includeThoughts: true }
        },
        abortSignal: AbortSignal.timeout(6e5)
        // 10 minute timeout per session
      });
      if (!result || Object.keys(result).length === 0) {
        return null;
      }
      const sessionId = records[0].sessionId;
      const normalizedFacet = normalizeSessionFacet(result, sessionId);
      if (!normalizedFacet) {
        logger.warn(
          `Ignoring malformed insight facet for session ${sessionId}`
        );
        return null;
      }
      return normalizedFacet;
    } catch (error) {
      logger.error(
        `Failed to analyze session ${records[0]?.sessionId}:`,
        error
      );
      return null;
    }
  }
  // Calculate streaks from activity dates
  calculateStreaks(dates) {
    if (dates.length === 0) {
      return { currentStreak: 0, longestStreak: 0, dates: [] };
    }
    const dateObjects = dates.map((dateStr) => parseDayKey(dateStr));
    dateObjects.sort((a, b) => a.getTime() - b.getTime());
    let currentStreak = 1;
    let maxStreak = 1;
    let currentDate = dateObjects[0];
    for (let i = 1; i < dateObjects.length; i++) {
      const nextDate = dateObjects[i];
      const diffDays = Math.round(
        (nextDate.getTime() - currentDate.getTime()) / (1e3 * 60 * 60 * 24)
      );
      if (diffDays === 1) {
        currentStreak++;
        maxStreak = Math.max(maxStreak, currentStreak);
      } else if (diffDays > 1) {
        currentStreak = 1;
      }
      currentDate = nextDate;
    }
    const today = parseDayKey(todayKey());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (currentDate.getTime() !== today.getTime() && currentDate.getTime() !== yesterday.getTime()) {
      currentStreak = 0;
    }
    return {
      currentStreak,
      longestStreak: maxStreak,
      dates
    };
  }
  // Process chat files from all projects in the base directory and generate insights
  async generateInsights(baseDir, facetsOutputDir, onProgress) {
    if (onProgress) onProgress("Scanning chat history...", 0);
    const allChatFiles = await this.scanChatFiles(baseDir);
    if (onProgress) onProgress("Crunching the numbers", 10);
    const metrics = await this.generateMetrics(allChatFiles, onProgress);
    if (onProgress) onProgress("Preparing sessions...", 20);
    const facets = await this.generateFacets(
      allChatFiles,
      facetsOutputDir,
      onProgress
    );
    if (onProgress) onProgress("Generating personalized insights...", 80);
    const qualitative = await this.generateQualitativeInsights(metrics, facets);
    const {
      satisfactionAgg,
      frictionAgg,
      primarySuccessAgg,
      outcomesAgg,
      goalsAgg
    } = this.aggregateFacetsData(facets);
    if (onProgress) onProgress("Assembling report...", 100);
    return {
      ...metrics,
      qualitative,
      satisfaction: satisfactionAgg,
      friction: frictionAgg,
      primarySuccess: primarySuccessAgg,
      outcomes: outcomesAgg,
      topGoals: goalsAgg
    };
  }
  // Aggregate satisfaction and friction data from facets
  aggregateFacetsData(facets) {
    const satisfactionAgg = {};
    const frictionAgg = {};
    const primarySuccessAgg = {};
    const outcomesAgg = {};
    const goalsAgg = {};
    facets.forEach((facet) => {
      getInsightCountEntries(facet.user_satisfaction_counts).forEach(
        ([sat, count]) => {
          satisfactionAgg[sat] = (satisfactionAgg[sat] || 0) + count;
        }
      );
      getInsightCountEntries(facet.friction_counts).forEach(([fric, count]) => {
        frictionAgg[fric] = (frictionAgg[fric] || 0) + count;
      });
      const primarySuccess = normalizeInsightEnum(
        facet.primary_success,
        PRIMARY_SUCCESS_VALUES,
        PRIMARY_SUCCESS_FALLBACK
      );
      if (primarySuccess !== PRIMARY_SUCCESS_FALLBACK) {
        primarySuccessAgg[primarySuccess] = (primarySuccessAgg[primarySuccess] || 0) + 1;
      }
      const outcome = normalizeInsightEnum(
        facet.outcome,
        SESSION_OUTCOMES,
        OUTCOME_FALLBACK
      );
      outcomesAgg[outcome] = (outcomesAgg[outcome] || 0) + 1;
      getInsightCountEntries(facet.goal_categories).forEach(([goal, count]) => {
        goalsAgg[goal] = (goalsAgg[goal] || 0) + count;
      });
    });
    return {
      satisfactionAgg,
      frictionAgg,
      primarySuccessAgg,
      outcomesAgg,
      goalsAgg
    };
  }
  async generateQualitativeInsights(metrics, facets) {
    if (facets.length === 0) {
      return void 0;
    }
    logger.info("Generating qualitative insights...");
    const commonData = this.prepareCommonPromptData(metrics, facets);
    const generate = /* @__PURE__ */ __name(async (promptTemplate, schema) => {
      const prompt = `${promptTemplate}

${commonData}`;
      try {
        const result = await runSideQuery(
          this.config,
          {
            purpose: "insight-qualitative-generate",
            model: this.config.getModel(),
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            schema,
            config: {
              thinkingConfig: { includeThoughts: true }
            },
            abortSignal: AbortSignal.timeout(6e5)
          }
        );
        return result;
      } catch (error) {
        logger.error("Failed to generate insight:", error);
        return void 0;
      }
    }, "generate");
    const schemaImpressiveWorkflows = {
      type: "object",
      properties: {
        intro: { type: "string" },
        impressive_workflows: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              description: { type: "string" }
            },
            required: ["title", "description"]
          }
        }
      },
      required: ["intro", "impressive_workflows"]
    };
    const schemaProjectAreas = {
      type: "object",
      properties: {
        areas: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              session_count: { type: "number" },
              description: { type: "string" }
            },
            required: ["name", "session_count", "description"]
          }
        }
      },
      required: ["areas"]
    };
    const schemaFutureOpportunities = {
      type: "object",
      properties: {
        intro: { type: "string" },
        opportunities: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              whats_possible: { type: "string" },
              how_to_try: { type: "string" },
              copyable_prompt: { type: "string" }
            },
            required: [
              "title",
              "whats_possible",
              "how_to_try",
              "copyable_prompt"
            ]
          }
        }
      },
      required: ["intro", "opportunities"]
    };
    const schemaFrictionPoints = {
      type: "object",
      properties: {
        intro: { type: "string" },
        categories: {
          type: "array",
          items: {
            type: "object",
            properties: {
              category: { type: "string" },
              description: { type: "string" },
              examples: { type: "array", items: { type: "string" } }
            },
            required: ["category", "description", "examples"]
          }
        }
      },
      required: ["intro", "categories"]
    };
    const schemaMemorableMoment = {
      type: "object",
      properties: {
        headline: { type: "string" },
        detail: { type: "string" }
      },
      required: ["headline", "detail"]
    };
    const schemaImprovements = {
      type: "object",
      properties: {
        Qwen_md_additions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              addition: { type: "string" },
              why: { type: "string" },
              prompt_scaffold: { type: "string" }
            },
            required: ["addition", "why", "prompt_scaffold"]
          }
        },
        features_to_try: {
          type: "array",
          items: {
            type: "object",
            properties: {
              feature: { type: "string" },
              one_liner: { type: "string" },
              why_for_you: { type: "string" },
              example_code: { type: "string" }
            },
            required: ["feature", "one_liner", "why_for_you", "example_code"]
          }
        },
        usage_patterns: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              suggestion: { type: "string" },
              detail: { type: "string" },
              copyable_prompt: { type: "string" }
            },
            required: ["title", "suggestion", "detail", "copyable_prompt"]
          }
        }
      },
      required: ["Qwen_md_additions", "features_to_try", "usage_patterns"]
    };
    const schemaInteractionStyle = {
      type: "object",
      properties: {
        narrative: { type: "string" },
        key_pattern: { type: "string" }
      },
      required: ["narrative", "key_pattern"]
    };
    const schemaAtAGlance = {
      type: "object",
      properties: {
        whats_working: { type: "string" },
        whats_hindering: { type: "string" },
        quick_wins: { type: "string" },
        ambitious_workflows: { type: "string" }
      },
      required: [
        "whats_working",
        "whats_hindering",
        "quick_wins",
        "ambitious_workflows"
      ]
    };
    const limit = pLimit(CONCURRENCY_LIMIT);
    try {
      const [
        impressiveWorkflows,
        projectAreas,
        futureOpportunities,
        frictionPoints,
        memorableMoment,
        improvements,
        interactionStyle,
        atAGlance
      ] = await Promise.all([
        limit(
          () => generate(
            getInsightPrompt("impressive_workflows"),
            schemaImpressiveWorkflows
          )
        ),
        limit(
          () => generate(
            getInsightPrompt("project_areas"),
            schemaProjectAreas
          )
        ),
        limit(
          () => generate(
            getInsightPrompt("future_opportunities"),
            schemaFutureOpportunities
          )
        ),
        limit(
          () => generate(
            getInsightPrompt("friction_points"),
            schemaFrictionPoints
          )
        ),
        limit(
          () => generate(
            getInsightPrompt("memorable_moment"),
            schemaMemorableMoment
          )
        ),
        limit(
          () => generate(
            getInsightPrompt("improvements"),
            schemaImprovements
          )
        ),
        limit(
          () => generate(
            getInsightPrompt("interaction_style"),
            schemaInteractionStyle
          )
        ),
        limit(
          () => generate(
            getInsightPrompt("at_a_glance"),
            schemaAtAGlance
          )
        )
      ]);
      logger.debug(
        JSON.stringify(
          {
            impressiveWorkflows,
            projectAreas,
            futureOpportunities,
            frictionPoints,
            memorableMoment,
            improvements,
            interactionStyle,
            atAGlance
          },
          null,
          2
        )
      );
      const qualitative = {
        impressiveWorkflows,
        projectAreas,
        futureOpportunities,
        frictionPoints,
        memorableMoment,
        improvements,
        interactionStyle,
        atAGlance
      };
      return hasMeaningfulInsightValue(qualitative) ? qualitative : void 0;
    } catch (e) {
      logger.error("Error generating qualitative insights:", e);
      return void 0;
    }
  }
  prepareCommonPromptData(metrics, facets) {
    const goalsAgg = {};
    const outcomesAgg = {};
    const satisfactionAgg = {};
    const frictionAgg = {};
    const successAgg = {};
    facets.forEach((facet) => {
      getInsightCountEntries(facet.goal_categories).forEach(([goal, count]) => {
        goalsAgg[goal] = (goalsAgg[goal] || 0) + count;
      });
      const outcome = normalizeInsightEnum(
        facet.outcome,
        SESSION_OUTCOMES,
        OUTCOME_FALLBACK
      );
      outcomesAgg[outcome] = (outcomesAgg[outcome] || 0) + 1;
      getInsightCountEntries(facet.user_satisfaction_counts).forEach(
        ([sat, count]) => {
          satisfactionAgg[sat] = (satisfactionAgg[sat] || 0) + count;
        }
      );
      getInsightCountEntries(facet.friction_counts).forEach(([fric, count]) => {
        frictionAgg[fric] = (frictionAgg[fric] || 0) + count;
      });
      const primarySuccess = normalizeInsightEnum(
        facet.primary_success,
        PRIMARY_SUCCESS_VALUES,
        PRIMARY_SUCCESS_FALLBACK
      );
      if (primarySuccess !== PRIMARY_SUCCESS_FALLBACK) {
        successAgg[primarySuccess] = (successAgg[primarySuccess] || 0) + 1;
      }
    });
    const topGoals = Object.entries(goalsAgg).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const dataObj = {
      sessions: metrics.totalSessions || facets.length,
      analyzed: facets.length,
      date_range: {
        start: Object.keys(metrics.heatmap).sort()[0] || "N/A",
        end: Object.keys(metrics.heatmap).sort().pop() || "N/A"
      },
      messages: metrics.totalMessages || 0,
      hours: metrics.totalHours || 0,
      commits: 0,
      // Not tracked yet
      top_tools: metrics.topTools || [],
      top_goals: topGoals,
      outcomes: outcomesAgg,
      satisfaction: satisfactionAgg,
      friction: frictionAgg,
      success: successAgg
    };
    const sessionSummaries = facets.map((f) => normalizeInsightText(f.brief_summary)).filter((summary) => summary.length > 0).map((summary) => `- ${summary}`).join("\n");
    const frictionDetails = facets.map((f) => normalizeInsightText(f.friction_detail)).filter((detail) => detail.length > 0).map((detail) => `- ${detail}`).join("\n");
    return `DATA:
${JSON.stringify(dataObj, null, 2)}

SESSION SUMMARIES:
${sessionSummaries}

FRICTION DETAILS:
${frictionDetails}

USER INSTRUCTIONS TO Qwen:
None captured`;
  }
  async scanChatFiles(baseDir) {
    const allChatFiles = [];
    try {
      const projectDirs = await fs11.readdir(baseDir);
      for (const projectDir of projectDirs) {
        const projectPath = path14.join(baseDir, projectDir);
        const stats = await fs11.stat(projectPath);
        if (stats.isDirectory()) {
          const chatsDir = path14.join(projectPath, "chats");
          try {
            const files = await fs11.readdir(chatsDir);
            const chatFiles = files.filter(
              (file) => file.endsWith(".jsonl") && !file.endsWith(".ledger.jsonl")
            );
            for (const file of chatFiles) {
              const filePath = path14.join(chatsDir, file);
              try {
                const fileStats = await fs11.stat(filePath);
                allChatFiles.push({ path: filePath, mtime: fileStats.mtimeMs });
              } catch (e) {
                logger.error(`Failed to stat file ${filePath}:`, e);
              }
            }
          } catch (error) {
            if (error.code !== "ENOENT") {
              logger.error(
                `Error reading chats directory for project ${projectDir}: ${error}`
              );
            }
            continue;
          }
        }
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        logger.info(`Base directory does not exist: ${baseDir}`);
      } else {
        logger.error(`Error reading base directory: ${error}`);
      }
    }
    return allChatFiles;
  }
  async generateMetrics(files, onProgress) {
    const heatmap = {};
    const activeHours = {};
    let latestActiveTimestamp = null;
    const sessionStartTimes = {};
    const sessionEndTimes = {};
    let totalMessages = 0;
    let totalLinesAdded = 0;
    let totalLinesRemoved = 0;
    const uniqueFiles = /* @__PURE__ */ new Set();
    const toolUsage = {};
    const BATCH_SIZE = 50;
    const totalFiles = files.length;
    for (let i = 0; i < totalFiles; i += BATCH_SIZE) {
      const batchEnd = Math.min(i + BATCH_SIZE, totalFiles);
      const batch = files.slice(i, batchEnd);
      for (const fileInfo of batch) {
        try {
          const records = await read(fileInfo.path);
          for (const record of records) {
            const timestamp = new Date(record.timestamp);
            const dateKey = dayKey(timestamp);
            const hour = hourOfDay(timestamp);
            const isUserMessage = record.type === "user";
            const isSlashCommand2 = record.type === "system" && record.subtype === "slash_command";
            if (isUserMessage || isSlashCommand2) {
              totalMessages++;
              heatmap[dateKey] = (heatmap[dateKey] || 0) + 1;
              activeHours[hour] = (activeHours[hour] || 0) + 1;
              if (latestActiveTimestamp === null || timestamp > latestActiveTimestamp) {
                latestActiveTimestamp = timestamp;
              }
            }
            if (!sessionStartTimes[record.sessionId]) {
              sessionStartTimes[record.sessionId] = timestamp;
            }
            sessionEndTimes[record.sessionId] = timestamp;
            if (record.type === "assistant" && record.message?.parts) {
              for (const part of record.message.parts) {
                if ("functionCall" in part) {
                  const name = part.functionCall.name;
                  toolUsage[name] = (toolUsage[name] || 0) + 1;
                }
              }
            }
            if (record.type === "tool_result" && record.toolCallResult?.resultDisplay) {
              const display = record.toolCallResult.resultDisplay;
              if (typeof display === "object" && display !== null && "fileName" in display) {
                const diff = display;
                if (typeof diff.fileName === "string") {
                  uniqueFiles.add(diff.fileName);
                }
                if (diff.diffStat) {
                  totalLinesAdded += diff.diffStat.model_added_lines || 0;
                  totalLinesRemoved += diff.diffStat.model_removed_lines || 0;
                }
              }
            }
          }
        } catch (error) {
          logger.error(
            `Failed to process metrics for file ${fileInfo.path}:`,
            error
          );
        }
      }
      if (onProgress) {
        const percentComplete = batchEnd / totalFiles;
        const overallProgress = 10 + Math.round(percentComplete * 10);
        onProgress(
          `Crunching the numbers (${batchEnd}/${totalFiles})`,
          overallProgress
        );
      }
      await new Promise((resolve4) => setTimeout(resolve4, 0));
    }
    const streakData = this.calculateStreaks(Object.keys(heatmap));
    let longestWorkDuration = 0;
    let longestWorkDate = null;
    let totalDurationMs = 0;
    const sessionIds = Object.keys(sessionStartTimes);
    const totalSessions = sessionIds.length;
    for (const sessionId of sessionIds) {
      const start = sessionStartTimes[sessionId];
      const end = sessionEndTimes[sessionId];
      const durationMs = end.getTime() - start.getTime();
      const durationMinutes = Math.round(durationMs / (1e3 * 60));
      totalDurationMs += durationMs;
      if (durationMinutes > longestWorkDuration) {
        longestWorkDuration = durationMinutes;
        longestWorkDate = dayKey(start);
      }
    }
    const totalHours = Math.round(totalDurationMs / (1e3 * 60 * 60));
    const latestActiveTime = latestActiveTimestamp ? latestActiveTimestamp.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    }) : null;
    const topTools = Object.entries(toolUsage).sort((a, b) => b[1] - a[1]).slice(0, 10);
    return {
      heatmap,
      currentStreak: streakData.currentStreak,
      longestStreak: streakData.longestStreak,
      longestWorkDate,
      longestWorkDuration,
      activeHours,
      latestActiveTime,
      totalSessions,
      totalMessages,
      totalHours,
      topTools,
      totalLinesAdded,
      totalLinesRemoved,
      totalFiles: uniqueFiles.size
    };
  }
  async generateFacets(allFiles, facetsOutputDir, onProgress) {
    const MAX_ELIGIBLE_SESSIONS = 50;
    const sortedFiles = [...allFiles].sort((a, b) => b.mtime - a.mtime);
    const eligibleSessions = [];
    for (const fileInfo of sortedFiles) {
      if (eligibleSessions.length >= MAX_ELIGIBLE_SESSIONS) {
        break;
      }
      try {
        const records = await read(fileInfo.path);
        if (!this.hasUserAndAssistantRecords(records)) {
          continue;
        }
        eligibleSessions.push({ fileInfo, records });
      } catch (e) {
        logger.error(
          `Error reading session file ${fileInfo.path} for facet eligibility:`,
          e
        );
      }
    }
    logger.info(
      `Analyzing ${eligibleSessions.length} eligible recent sessions with LLM...`
    );
    const limit = pLimit(CONCURRENCY_LIMIT);
    let completed = 0;
    const total = eligibleSessions.length;
    const analysisPromises = eligibleSessions.map(
      ({ fileInfo, records }) => limit(async () => {
        try {
          if (records.length > 0 && facetsOutputDir) {
            const sessionId = records[0].sessionId;
            if (sessionId) {
              const existingFacetPath = path14.join(
                facetsOutputDir,
                `${sessionId}.json`
              );
              try {
                const existingData = await fs11.readFile(
                  existingFacetPath,
                  "utf-8"
                );
                const existingFacet = JSON.parse(existingData);
                const normalizedFacet = normalizeSessionFacet(
                  existingFacet,
                  sessionId
                );
                if (!normalizedFacet) {
                  logger.warn(
                    `Cached insight facet for ${sessionId} is malformed, regenerating.`
                  );
                  throw new Error("Malformed cached insight facet");
                }
                const normalizedData = JSON.stringify(normalizedFacet, null, 2);
                if (existingData !== normalizedData) {
                  try {
                    await fs11.writeFile(
                      existingFacetPath,
                      normalizedData,
                      "utf-8"
                    );
                  } catch (writeError) {
                    logger.warn(
                      `Failed to write back normalized facet for ${sessionId}:`,
                      writeError
                    );
                  }
                }
                completed++;
                if (onProgress) {
                  const percent = 20 + Math.round(completed / total * 60);
                  onProgress(
                    "Analyzing sessions",
                    percent,
                    `${completed}/${total}`
                  );
                }
                return normalizedFacet;
              } catch (readError) {
                if (readError.code !== "ENOENT") {
                  logger.warn(
                    `Failed to read existing facet for ${sessionId}, regenerating:`,
                    readError
                  );
                }
              }
            }
          }
          const facet = await this.analyzeSession(records);
          if (facet && facetsOutputDir) {
            try {
              const facetPath = path14.join(
                facetsOutputDir,
                `${facet.session_id}.json`
              );
              await fs11.writeFile(
                facetPath,
                JSON.stringify(facet, null, 2),
                "utf-8"
              );
            } catch (writeError) {
              logger.error(
                `Failed to write facet file for session ${facet.session_id}:`,
                writeError
              );
            }
          }
          completed++;
          if (onProgress) {
            const percent = 20 + Math.round(completed / total * 60);
            onProgress("Analyzing sessions", percent, `${completed}/${total}`);
          }
          return facet;
        } catch (e) {
          logger.error(`Error analyzing session file ${fileInfo.path}:`, e);
          completed++;
          if (onProgress) {
            const percent = 20 + Math.round(completed / total * 60);
            onProgress("Analyzing sessions", percent, `${completed}/${total}`);
          }
          return null;
        }
      })
    );
    const sessionFacetsWithNulls = await Promise.all(analysisPromises);
    const facets = sessionFacetsWithNulls.filter(
      (f) => f !== null
    );
    return facets;
  }
};

// packages/cli/src/services/insight/generators/TemplateRenderer.ts
init_esbuild_shims();
var TemplateRenderer = class {
  static {
    __name(this, "TemplateRenderer");
  }
  // Render the complete HTML file
  async renderInsightHTML(insights) {
    const insightJson = escapeJsonTagCharacters(JSON.stringify(insights)).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Qwen Code Insights</title>
    <style>
      ${INSIGHT_CSS}
    </style>
  </head>
  <body>
    <div class="min-h-screen" id="container">
      <div class="mx-auto max-w-6xl px-6 py-10 md:py-12">
        <div id="react-root"></div>
      </div>
    </div>

    <!-- React CDN -->
    <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>

    <!-- CDN Libraries -->
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js"></script>

    <!-- Application Data -->
    <script>
      window.INSIGHT_DATA = ${insightJson};
    </script>

    <!-- App Script -->
    <script>
      ${INSIGHT_JS}
    </script>
  </body>
</html>`;
    return html;
  }
};

// packages/cli/src/services/insight/generators/StaticInsightGenerator.ts
var StaticInsightGenerator = class {
  static {
    __name(this, "StaticInsightGenerator");
  }
  dataProcessor;
  templateRenderer;
  constructor(config) {
    this.dataProcessor = new DataProcessor(config);
    this.templateRenderer = new TemplateRenderer();
  }
  // Ensure the output directory exists
  async ensureOutputDirectory() {
    const outputDir = path15.join(Storage.getRuntimeBaseDir(), "insights");
    await fs12.mkdir(outputDir, { recursive: true });
    return outputDir;
  }
  // Generate timestamped filename with collision detection
  async generateOutputPath(outputDir) {
    const now = /* @__PURE__ */ new Date();
    const date = dayKey(now);
    const time = now.toTimeString().slice(0, 8).replace(/:/g, "");
    let outputPath = path15.join(outputDir, `insight-${date}.html`);
    try {
      await fs12.access(outputPath);
      outputPath = path15.join(outputDir, `insight-${date}-${time}.html`);
    } catch {
    }
    return outputPath;
  }
  async updateInsightSymlink(outputDir, targetPath) {
    const latestPath = path15.join(outputDir, "insight.html");
    await updateSymlink(latestPath, targetPath);
  }
  // Generate the static insight HTML file
  async generateStaticInsight(baseDir, onProgress) {
    const outputDir = await this.ensureOutputDirectory();
    const facetsDir = path15.join(outputDir, "facets");
    await fs12.mkdir(facetsDir, { recursive: true });
    const insights = await this.dataProcessor.generateInsights(
      baseDir,
      facetsDir,
      onProgress
    );
    const html = await this.templateRenderer.renderInsightHTML(insights);
    const outputPath = await this.generateOutputPath(outputDir);
    await fs12.writeFile(outputPath, html, "utf-8");
    await this.updateInsightSymlink(outputDir, outputPath);
    return outputPath;
  }
};

// packages/cli/src/ui/commands/insightCommand.ts
var logger2 = createDebugLogger("DataProcessor");
var insightCommand = {
  name: "insight",
  get description() {
    return t(
      "generate personalized programming insights from your chat history"
    );
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "non_interactive", "acp"],
  action: /* @__PURE__ */ __name(async (context) => {
    try {
      context.ui.setDebugMessage(t("Generating insights..."));
      const projectsDir = join7(Storage.getRuntimeBaseDir(), "projects");
      if (!context.services.config) {
        if (context.executionMode !== "interactive") {
          return {
            type: "message",
            messageType: "error",
            content: "Config service is not available."
          };
        }
        throw new Error("Config service is not available");
      }
      const insightGenerator = new StaticInsightGenerator(
        context.services.config
      );
      if (context.executionMode === "non_interactive") {
        try {
          const outputPath2 = await insightGenerator.generateStaticInsight(
            projectsDir,
            () => {
            }
          );
          return {
            type: "message",
            messageType: "info",
            content: t("Insight report generated at: {{path}}", {
              path: outputPath2
            })
          };
        } catch (error) {
          return {
            type: "message",
            messageType: "error",
            content: t("Failed to generate insights: {{error}}", {
              error: error.message
            })
          };
        }
      }
      if (context.executionMode === "acp") {
        const pendingMessages = [];
        let isComplete = false;
        let resume = null;
        const flushResume = /* @__PURE__ */ __name(() => {
          const resolve4 = resume;
          if (!resolve4) {
            return;
          }
          resume = null;
          resolve4();
        }, "flushResume");
        const pushMessage = /* @__PURE__ */ __name((message2) => {
          pendingMessages.push(message2);
          flushResume();
        }, "pushMessage");
        const streamMessages = /* @__PURE__ */ __name(async function* () {
          while (!isComplete || pendingMessages.length > 0) {
            if (pendingMessages.length === 0) {
              await new Promise((resolve4) => {
                resume = resolve4;
              });
            }
            while (pendingMessages.length > 0) {
              const message2 = pendingMessages.shift();
              if (message2) {
                yield message2;
              }
            }
          }
        }, "streamMessages");
        void (async () => {
          try {
            pushMessage({
              messageType: "info",
              content: t("This may take a couple minutes. Sit tight!")
            });
            pushMessage({
              messageType: "info",
              content: encodeInsightProgressMessage(
                t("Starting insight generation..."),
                0
              )
            });
            const outputPath2 = await insightGenerator.generateStaticInsight(
              projectsDir,
              (stage, progress, detail) => {
                pushMessage({
                  messageType: "info",
                  content: encodeInsightProgressMessage(
                    stage,
                    progress,
                    detail
                  )
                });
              }
            );
            pushMessage({
              messageType: "info",
              content: encodeInsightReadyMessage(outputPath2)
            });
          } catch (error) {
            const errorText = error.message;
            pushMessage({
              messageType: "info",
              content: encodeInsightErrorMessage(errorText)
            });
            pushMessage({
              messageType: "error",
              content: t("Failed to generate insights: {{error}}", {
                error: errorText
              })
            });
            logger2.error("Insight generation error:", error);
          } finally {
            isComplete = true;
            flushResume();
          }
        })();
        return {
          type: "stream_messages",
          messages: streamMessages()
        };
      }
      const updateProgress = /* @__PURE__ */ __name((stage, progress, detail) => {
        const progressItem = {
          type: "insight_progress" /* INSIGHT_PROGRESS */,
          progress: {
            stage,
            progress,
            detail
          }
        };
        context.ui.setPendingItem(progressItem);
      }, "updateProgress");
      context.ui.addItem(
        {
          type: "info" /* INFO */,
          text: t("This may take a couple minutes. Sit tight!")
        },
        Date.now()
      );
      updateProgress(t("Starting insight generation..."), 0);
      const outputPath = await insightGenerator.generateStaticInsight(
        projectsDir,
        updateProgress
      );
      context.ui.setPendingItem(null);
      context.ui.addItem(
        {
          type: "info" /* INFO */,
          text: t("Insight report generated successfully!")
        },
        Date.now()
      );
      context.ui.addItem(
        {
          type: "info" /* INFO */,
          text: t(
            "Insights generated at: {{path}}. If the browser does not open automatically, open this file manually.",
            {
              path: outputPath
            }
          )
        },
        Date.now()
      );
      try {
        await openBrowserSecurely(pathToFileURL(outputPath).href, {
          allowFile: true,
          allowedFilePaths: [outputPath]
        });
      } catch (browserError) {
        logger2.error("Failed to open browser automatically:", browserError);
      }
      context.ui.setDebugMessage(t("Insights ready."));
      return;
    } catch (error) {
      context.ui.setPendingItem(null);
      if (context.executionMode !== "interactive") {
        return {
          type: "message",
          messageType: "error",
          content: `Failed to generate insights: ${error.message}`
        };
      }
      context.ui.addItem(
        {
          type: "error" /* ERROR */,
          text: t("Failed to generate insights: {{error}}", {
            error: error.message
          })
        },
        Date.now()
      );
      logger2.error("Insight generation error:", error);
      return;
    }
  }, "action")
};

// packages/cli/src/ui/commands/learn-command.ts
init_esbuild_shims();
var learnCommand = {
  name: "learn",
  get description() {
    return t(
      "Create a reusable skill from a knowledge source (file, URL, conversation, or text)."
    );
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "acp"],
  argumentHint: "<path|URL|text> [focus]",
  action: /* @__PURE__ */ __name(async (context, args) => {
    const rawInput = args.trim();
    if (!rawInput) {
      return {
        type: "message",
        messageType: "error",
        content: t(
          "Usage: /learn <path|URL|text> [focus]\nExamples:\n  /learn https://docs.example.com/api\n  /learn ~/projects/acme-sdk\n  /learn Our deploy process: ssh to prod, run migrate, restart"
        )
      };
    }
    const config = context.services.config;
    if (!config) {
      return {
        type: "message",
        messageType: "error",
        content: t("Config not loaded.")
      };
    }
    const projectRoot = config.getProjectRoot();
    const video = parseLearnVideoInput(rawInput);
    if (video) {
      if (video.kind === "youtube") {
        return {
          type: "message",
          messageType: "error",
          content: t(
            "YouTube page URLs cannot be sent as native video input. Download the video into your workspace and pass the local video file path to /learn."
          )
        };
      }
      const authType = config.getContentGeneratorConfig()?.authType;
      const supportsVideoTransport = authType === "openai" /* USE_OPENAI */ || authType === "qwen-oauth" /* QWEN_OAUTH */;
      if (config.getEffectiveInputModalities().video !== true || !supportsVideoTransport) {
        return {
          type: "message",
          messageType: "error",
          content: t(
            "The current model or provider does not support native video input for /learn. Switch to a video-capable model on an OpenAI-compatible provider and try again."
          )
        };
      }
      let localVideoPart;
      if (video.kind === "local") {
        let parts;
        try {
          parts = await readPathFromWorkspace(
            expandHomeDir(video.source),
            config
          );
        } catch {
          return {
            type: "submit_prompt",
            content: await buildLearnSkillPrompt(rawInput, projectRoot)
          };
        }
        localVideoPart = parts.find(
          (part) => typeof part !== "string" && part.inlineData?.mimeType?.startsWith("video/") === true
        );
        if (!localVideoPart) {
          const inlineParts = parts.filter(
            (part) => typeof part !== "string" && part.inlineData != null
          );
          if (inlineParts.length === 1 && inlineParts[0].inlineData) {
            inlineParts[0].inlineData.mimeType = video.mimeType;
            localVideoPart = inlineParts[0];
          }
        }
        if (!localVideoPart) {
          const errorDetail = parts.filter((p) => typeof p === "string").join(" ");
          return {
            type: "message",
            messageType: "error",
            content: errorDetail ? `${t("The local video could not be attached for /learn.")} ${errorDetail}` : t("The local video could not be attached for /learn.")
          };
        }
      }
      return {
        type: "submit_prompt",
        content: await buildLearnVideoSkillRequest(
          video,
          projectRoot,
          localVideoPart
        )
      };
    }
    return {
      type: "submit_prompt",
      content: await buildLearnSkillPrompt(rawInput, projectRoot)
    };
  }, "action")
};

// packages/cli/src/ui/commands/statuslineCommand.ts
init_esbuild_shims();
var statuslineCommand = {
  name: "statusline",
  get description() {
    return t("Set up Qwen Code's status line UI");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive"],
  action: /* @__PURE__ */ __name((_context, args) => {
    const prompt = args.trim();
    if (!prompt) {
      return {
        type: "dialog",
        dialog: "statusline"
      };
    }
    return {
      type: "submit_prompt",
      content: [
        {
          text: `Use the Agent tool with subagent_type: "statusline-setup" and this prompt:

${prompt}`
        }
      ]
    };
  }, "action")
};

// packages/cli/src/ui/commands/lspCommand.ts
init_esbuild_shims();
function emitMessage(context, messageType, content) {
  if (context.executionMode !== "interactive") {
    return {
      type: "message",
      messageType,
      content
    };
  }
  context.ui.addItem(
    {
      type: messageType === "error" ? "error" /* ERROR */ : "info" /* INFO */,
      text: content
    },
    Date.now()
  );
}
__name(emitMessage, "emitMessage");
var lspCommand = {
  name: "lsp",
  get description() {
    return t("Show LSP server status. Usage: /lsp [status]");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "non_interactive", "acp"],
  canRunDuringStreaming: true,
  action: /* @__PURE__ */ __name(async (context, _args) => {
    const config = context.services.config;
    if (!config) {
      return emitMessage(context, "error", t("Config not available."));
    }
    if (!config.isLspEnabled()) {
      return emitMessage(
        context,
        "info",
        t(
          "LSP is not enabled. Start Qwen Code with `--experimental-lsp` to enable LSP support."
        )
      );
    }
    const client = config.getLspClient();
    if (!client) {
      return emitMessage(
        context,
        "info",
        t(
          "LSP is enabled but no client is connected. Check debug logs under `${QWEN_RUNTIME_DIR:-~/.qwen}/debug/` or see the LSP troubleshooting docs."
        )
      );
    }
    if (!client.getServerStatus) {
      return emitMessage(
        context,
        "info",
        t("LSP is enabled, but server status is unavailable.")
      );
    }
    const servers = client.getServerStatus();
    if (servers.length === 0) {
      return emitMessage(
        context,
        "info",
        t(
          "No LSP servers configured. Add a `.lsp.json` file to your project root. See `/help` for details."
        )
      );
    }
    const lines = ["**LSP Server Status**", ""];
    lines.push("| Server | Command | Languages | Status |");
    lines.push("|--------|---------|-----------|--------|");
    for (const server of servers) {
      const cmd = server.command ?? "(n/a)";
      const langs = server.languages.join(", ") || "(auto)";
      const statusText = server.error ? `${server.status} - ${server.error}` : server.status;
      lines.push(`| ${server.name} | \`${cmd}\` | ${langs} | ${statusText} |`);
    }
    return emitMessage(context, "info", lines.join("\n"));
  }, "action")
};

// packages/cli/src/ui/commands/update-command.ts
init_esbuild_shims();
var updateCommand = {
  name: "update",
  get description() {
    return t("Check for Qwen Code updates and install if available");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "non_interactive", "acp"],
  action: /* @__PURE__ */ __name(async (context) => {
    const [
      { checkForUpdatesDetailed, describeUpdateCheckFailure },
      {
        CUSTOM_SANDBOX_IMAGE_ENV_VAR,
        HOST_UPDATE_RELAUNCH_ENV_VAR,
        relaunchForUpdate
      },
      { performStandaloneUpdate },
      installationInfo
    ] = await Promise.all([
      import("./updateCheck-V5SKNDFE.js"),
      import("./processUtils-QXQWZSH4.js"),
      import("./standalone-update-7DJX56A6.js"),
      import("./installationInfo-VY2CUV7O.js")
    ]);
    const { formatUpdateInstructions, getInstallationInfo: getInstallationInfo2 } = installationInfo;
    const settings = context.services.settings;
    const projectRoot = context.services.config?.getProjectRoot();
    const updateCheck = await checkForUpdatesDetailed();
    if (updateCheck.status === "up-to-date") {
      const msg = t("Qwen Code {{version}} is up to date!", {
        version: updateCheck.currentVersion
      });
      return {
        type: "message",
        messageType: "info",
        content: msg
      };
    }
    if (updateCheck.status === "error") {
      return {
        type: "message",
        messageType: "error",
        content: t(
          "Failed to check for updates ({{reason}}). Please check your network or registry configuration.",
          { reason: describeUpdateCheckFailure(updateCheck.error) }
        )
      };
    }
    if (updateCheck.status === "skipped") {
      return {
        type: "message",
        messageType: "error",
        content: t("Unable to check for updates: {{reason}}", {
          reason: updateCheck.reason
        })
      };
    }
    const info = updateCheck.info;
    const installInfo = getInstallationInfo2(projectRoot || process.cwd(), true);
    const manualInstructions = /* @__PURE__ */ __name(() => {
      const lines = [
        info.message,
        ...formatUpdateInstructions(installInfo, info.update.latest).map(
          (line) => t(line)
        )
      ];
      return {
        type: "message",
        messageType: "info",
        content: lines.join("\n")
      };
    }, "manualInstructions");
    if (context.executionMode === "interactive" && projectRoot) {
      const customSandboxImage = process.env[CUSTOM_SANDBOX_IMAGE_ENV_VAR];
      if (customSandboxImage) {
        return {
          type: "message",
          messageType: "info",
          content: `${info.message}
${t(
            "This session uses the custom sandbox image {{image}}. Update that image and restart Qwen Code.",
            { image: customSandboxImage }
          )}`
        };
      }
      const hostUpdateRelaunch = process.env[HOST_UPDATE_RELAUNCH_ENV_VAR];
      const isAutoUpdateEnabled = settings.merged.general?.enableAutoUpdate !== false;
      if (hostUpdateRelaunch === "true" && isAutoUpdateEnabled) {
        await relaunchForUpdate();
        return;
      }
      if (hostUpdateRelaunch !== void 0) {
        return {
          type: "message",
          messageType: "info",
          content: `${info.message}
${t(
            "Update Qwen Code on the host, then restart the sandbox."
          )}`
        };
      }
      const canAutoUpdate = installInfo.updateCommand || installInfo.isStandalone && installInfo.standaloneDir;
      if (isAutoUpdateEnabled && canAutoUpdate) {
        await relaunchForUpdate();
        return;
      }
      return manualInstructions();
    }
    if (installInfo.isStandalone && installInfo.standaloneDir) {
      try {
        const result = await performStandaloneUpdate(
          installInfo.standaloneDir,
          info.update.latest
        );
        const message2 = result === "done" ? t(
          "Update successful! The new version will be used on your next run."
        ) : t(
          "Update downloaded. It will be applied after you exit this session."
        );
        return {
          type: "message",
          messageType: "info",
          content: `${info.message}
${t("Downloading update...")}
${message2}`
        };
      } catch (err) {
        const message2 = t("Update failed: {{error}}", {
          error: err instanceof Error ? err.message : String(err)
        });
        return {
          type: "message",
          messageType: "error",
          content: `${info.message}
${message2}`
        };
      }
    }
    return manualInstructions();
  }, "action")
};

// packages/cli/src/services/BuiltinCommandLoader.ts
var builtinDebugLogger = createDebugLogger("BUILTIN_COMMAND_LOADER");
var BuiltinCommandLoader = class {
  constructor(config) {
    this.config = config;
  }
  static {
    __name(this, "BuiltinCommandLoader");
  }
  /**
   * Gathers all raw built-in command definitions, injects dependencies where
   * needed (e.g., config) and filters out any that are not available.
   *
   * @param _signal An AbortSignal (unused for this synchronous loader).
   * @returns A promise that resolves to an array of `SlashCommand` objects.
   */
  async loadCommands(_signal) {
    let resolvedIdeCommand = null;
    try {
      resolvedIdeCommand = await ideCommand();
    } catch (error) {
      builtinDebugLogger.warn(
        "Failed to load IDE command:",
        error instanceof Error ? error.message : String(error)
      );
    }
    const allDefinitions = [
      aboutCommand,
      advisorCommand,
      agentsCommand,
      tasksCommand,
      // Gated behind isWorkflowsEnabled — feature flag honors
      // tools.workflowsEnabled, QWEN_CODE_ENABLE_WORKFLOWS (opt-in), and
      // QWEN_CODE_DISABLE_WORKFLOWS (kill switch). When the flag is off the
      // command vanishes entirely from typeahead and help, matching the
      // established convention for experimental builtins.
      this.config?.isWorkflowsEnabled() ? workflowsCommand : null,
      arenaCommand,
      approvalModeCommand,
      authCommand,
      branchCommand,
      peersCommand,
      btwCommand,
      forkCommand,
      bugCommand,
      cdCommand,
      clearCommand,
      compressCommand,
      compressFastCommand,
      configCommand,
      contextCommand,
      curatorCommand,
      copyCommand,
      diffCommand,
      deleteCommand,
      docsCommand,
      doctorCommand,
      directoryCommand,
      editorCommand,
      effortCommand,
      exportCommand,
      extensionsCommand,
      helpCommand,
      historyCommand,
      hooksCommand,
      resolvedIdeCommand,
      importConfigCommand,
      initCommand,
      languageCommand,
      learnCommand,
      mcpCommand,
      ...this.config?.isManagedMemoryAvailable() ? [dreamCommand, forgetCommand] : [],
      goalCommand,
      memoryCommand,
      modelCommand,
      outputStyleCommand,
      rememberCommand,
      planCommand,
      permissionsCommand,
      ...this.config?.getFolderTrust() ? [trustCommand] : [],
      quitCommand,
      recapCommand,
      reloadPluginsCommand,
      renameCommand,
      restoreCommand2(this.config),
      resumeCommand,
      rewindCommand,
      skillsCommand,
      statsCommand,
      summaryCommand,
      themeCommand,
      toolsCommand,
      settingsCommand,
      vimCommand,
      updateCommand,
      voiceCommand,
      setupGithubCommand,
      terminalSetupCommand,
      insightCommand,
      statuslineCommand,
      ...this.config?.isLspEnabled() ? [lspCommand] : []
    ];
    return allDefinitions.filter((cmd) => cmd !== null).map((cmd) => ({
      ...cmd,
      source: "builtin-command",
      sourceLabel: "Built-in",
      modelInvocable: false,
      userInvocable: cmd.userInvocable ?? true
    }));
  }
};

// packages/cli/src/services/BundledSkillLoader.ts
init_esbuild_shims();
import { dirname as dirname2 } from "node:path";
var debugLogger16 = createDebugLogger("BUNDLED_SKILL_LOADER");
var BundledSkillLoader = class {
  constructor(config) {
    this.config = config;
  }
  static {
    __name(this, "BundledSkillLoader");
  }
  async loadCommands(_signal) {
    if (this.config?.getBareMode?.()) {
      debugLogger16.debug("Bare mode enabled, skipping bundled skills");
      return [];
    }
    const skillManager = this.config?.getSkillManager();
    if (!skillManager) {
      debugLogger16.debug("SkillManager not available, skipping bundled skills");
      return [];
    }
    try {
      const allSkills = await skillManager.listSkills({ level: "bundled" });
      const cronEnabled = this.config?.isCronEnabled() ?? false;
      const cronVisible = allSkills.filter((skill) => {
        if (!cronEnabled && skill.allowedTools?.some((t2) => t2.startsWith("cron_"))) {
          debugLogger16.debug(
            `Hiding skill "${skill.name}" because cron is not enabled`
          );
          return false;
        }
        return true;
      });
      const disabled = this.config?.getDisabledSkillNames() ?? /* @__PURE__ */ new Set();
      const skills = cronVisible.filter(
        (skill) => !disabled.has(skill.name.toLowerCase())
      );
      debugLogger16.debug(
        `Loaded ${skills.length} bundled skill(s) as slash commands; ${cronVisible.length - skills.length} hidden by skills.disabled`
      );
      return skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        modelDescription: skill.description,
        kind: "skill" /* SKILL */,
        source: "bundled-skill",
        sourceLabel: t("Skill"),
        userInvocable: skill.userInvocable ?? true,
        modelInvocable: !skill.disableModelInvocation,
        argumentHint: skill.argumentHint,
        whenToUse: skill.whenToUse,
        skillDetail: {
          name: skill.name,
          description: skill.description,
          body: skill.body,
          level: skill.level
        },
        action: /* @__PURE__ */ __name(async (context, _args) => {
          if (this.config && !this.config.isSkillEnabled(skill)) {
            return {
              type: "message",
              messageType: "error",
              content: `Skill "${skill.name}" is disabled.`
            };
          }
          await applySkillSideEffects(this.config, skill);
          let body = skill.body;
          const modelId = this.config?.getModel()?.trim() || "";
          const cliVersion = this.config?.getCliVersion()?.trim() || "unknown";
          body = body.replaceAll("{{cliVersion}}", cliVersion);
          if (body.includes("{{model}}") || body.includes("YOUR_MODEL_ID")) {
            body = body.replaceAll("{{model}}", modelId);
            body = body.replaceAll("YOUR_MODEL_ID", modelId);
            if (modelId) {
              body = `YOUR_MODEL_ID="${modelId}"

${body}`;
            }
          }
          const skillPrompt = buildSkillLlmContent(
            dirname2(skill.filePath),
            body
          );
          const rawArgs = context.invocation?.args ?? "";
          let content;
          if (rawArgs) {
            content = appendToLastTextPart(
              [{ text: skillPrompt }],
              context.invocation.raw + (writeSkillArgs(skill.name, rawArgs) ? skillArgsNote(skillArgsPath(skill.name), rawArgs) : "")
            );
          } else {
            content = [{ text: skillPrompt }];
            if (!clearSkillArgs(skill.name)) {
              content = appendToLastTextPart(content, staleArgsWarning());
            }
          }
          return {
            type: "submit_prompt",
            content
          };
        }, "action")
      }));
    } catch (error) {
      debugLogger16.error("Failed to load bundled skills:", error);
      return [];
    }
  }
};

// packages/cli/src/services/FileCommandLoader.ts
init_esbuild_shims();
var import_toml = __toESM(require_toml(), 1);
import { promises as fs13 } from "node:fs";
import * as fsSync from "node:fs";
import path17 from "node:path";

// packages/cli/src/services/markdown-command-parser.ts
init_esbuild_shims();
var MarkdownCommandDefSchema = external_exports.object({
  frontmatter: external_exports.object({
    description: external_exports.string().optional(),
    "argument-hint": external_exports.string().optional(),
    when_to_use: external_exports.string().optional(),
    "disable-model-invocation": external_exports.boolean().optional()
  }).passthrough().optional(),
  prompt: external_exports.string({
    required_error: "The prompt content is required.",
    invalid_type_error: "The prompt content must be a string."
  })
});
function parseMarkdownCommand(content) {
  const normalizedContent = normalizeContent(content);
  const frontmatterRegex = /^---\n(?:([\s\S]*?)\n)?---(?:\n|$)([\s\S]*)$/;
  const match = normalizedContent.match(frontmatterRegex);
  if (!match) {
    return {
      prompt: normalizedContent.trim()
    };
  }
  const [, frontmatterYaml = "", body] = match;
  let frontmatter;
  if (frontmatterYaml.trim()) {
    try {
      frontmatter = parse(frontmatterYaml);
    } catch (error) {
      throw new Error(
        `Failed to parse YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return {
    frontmatter,
    prompt: body.trim()
  };
}
__name(parseMarkdownCommand, "parseMarkdownCommand");

// packages/cli/src/services/command-factory.ts
init_esbuild_shims();
import path16 from "node:path";

// packages/cli/src/services/prompt-processors/argumentProcessor.ts
init_esbuild_shims();
var DefaultArgumentProcessor = class {
  static {
    __name(this, "DefaultArgumentProcessor");
  }
  async process(prompt, context) {
    if (context.invocation?.args) {
      return appendToLastTextPart(prompt, context.invocation.raw);
    }
    return prompt;
  }
};

// packages/cli/src/services/prompt-processors/types.ts
init_esbuild_shims();
var SHORTHAND_ARGS_PLACEHOLDER = "{{args}}";
var SHELL_INJECTION_TRIGGER = "!{";
var AT_FILE_INJECTION_TRIGGER = "@{";

// packages/cli/src/services/prompt-processors/shellProcessor.ts
init_esbuild_shims();

// packages/cli/src/services/prompt-processors/injectionParser.ts
init_esbuild_shims();
function extractInjections(prompt, trigger, contextName) {
  const injections = [];
  let index = 0;
  while (index < prompt.length) {
    const startIndex = prompt.indexOf(trigger, index);
    if (startIndex === -1) {
      break;
    }
    let currentIndex = startIndex + trigger.length;
    let braceCount = 1;
    let foundEnd = false;
    while (currentIndex < prompt.length) {
      const char = prompt[currentIndex];
      if (char === "{") {
        braceCount++;
      } else if (char === "}") {
        braceCount--;
        if (braceCount === 0) {
          const injectionContent = prompt.substring(
            startIndex + trigger.length,
            currentIndex
          );
          const endIndex = currentIndex + 1;
          injections.push({
            content: injectionContent.trim(),
            startIndex,
            endIndex
          });
          index = endIndex;
          foundEnd = true;
          break;
        }
      }
      currentIndex++;
    }
    if (!foundEnd) {
      const contextInfo = contextName ? ` in command '${contextName}'` : "";
      throw new Error(
        `Invalid syntax${contextInfo}: Unclosed injection starting at index ${startIndex} ('${trigger}'). Ensure braces are balanced. Paths or commands with unbalanced braces are not supported directly.`
      );
    }
  }
  return injections;
}
__name(extractInjections, "extractInjections");

// packages/cli/src/services/prompt-processors/shellProcessor.ts
var ConfirmationRequiredError = class extends Error {
  constructor(message2, commandsToConfirm) {
    super(message2);
    this.commandsToConfirm = commandsToConfirm;
    this.name = "ConfirmationRequiredError";
  }
  static {
    __name(this, "ConfirmationRequiredError");
  }
};
var ShellProcessor = class {
  constructor(commandName) {
    this.commandName = commandName;
  }
  static {
    __name(this, "ShellProcessor");
  }
  async process(prompt, context) {
    return flatMapTextParts(
      prompt,
      (text) => this.processString(text, context)
    );
  }
  async processString(prompt, context) {
    const userArgsRaw = context.invocation?.args || "";
    if (!prompt.includes(SHELL_INJECTION_TRIGGER)) {
      return [
        { text: prompt.replaceAll(SHORTHAND_ARGS_PLACEHOLDER, userArgsRaw) }
      ];
    }
    const config = context.services.config;
    if (!config) {
      throw new Error(
        `Security configuration not loaded. Cannot verify shell command permissions for '${this.commandName}'. Aborting.`
      );
    }
    const { sessionShellAllowlist } = context.session;
    const injections = extractInjections(
      prompt,
      SHELL_INJECTION_TRIGGER,
      this.commandName
    );
    if (injections.length === 0) {
      return [
        { text: prompt.replaceAll(SHORTHAND_ARGS_PLACEHOLDER, userArgsRaw) }
      ];
    }
    const { shell } = getShellConfiguration();
    const userArgsEscaped = escapeShellArg(userArgsRaw, shell);
    let userArgsForArgumentsPlaceholder = userArgsRaw.replace(
      /^'([\s\S]*?)'$/,
      "$1"
    );
    const argumentSafety = checkArgumentSafety(userArgsForArgumentsPlaceholder);
    if (!argumentSafety.isSafe) {
      userArgsForArgumentsPlaceholder = userArgsEscaped;
    }
    const resolvedInjections = injections.map(
      (injection) => {
        const command = injection.content;
        if (command === "") {
          return { ...injection, resolvedCommand: void 0 };
        }
        const resolvedCommand = command.replaceAll(SHORTHAND_ARGS_PLACEHOLDER, userArgsEscaped).replaceAll("$ARGUMENTS", userArgsForArgumentsPlaceholder);
        return { ...injection, resolvedCommand };
      }
    );
    const commandsToConfirm = /* @__PURE__ */ new Set();
    for (const injection of resolvedInjections) {
      const command = injection.resolvedCommand;
      if (!command) continue;
      const { allAllowed, disallowedCommands, blockReason, isHardDenial } = await checkCommandPermissions(command, config, sessionShellAllowlist);
      const pm = config.getPermissionManager?.();
      const isAllowedBySettings = pm ? await pm.isCommandAllowed(command) === "allow" : false;
      if (!allAllowed) {
        if (isHardDenial) {
          throw new Error(
            `${this.commandName} cannot be run. Blocked command: "${command}". Reason: ${blockReason || "Blocked by configuration."}`
          );
        }
        if (isAllowedBySettings) {
          continue;
        }
        if (config.getApprovalMode() === "yolo" /* YOLO */) {
          continue;
        }
        disallowedCommands.forEach((uc) => commandsToConfirm.add(uc));
      }
    }
    if (commandsToConfirm.size > 0) {
      throw new ConfirmationRequiredError(
        "Shell command confirmation required",
        Array.from(commandsToConfirm)
      );
    }
    let processedPrompt = "";
    let lastIndex = 0;
    for (const injection of resolvedInjections) {
      const segment = prompt.substring(lastIndex, injection.startIndex);
      processedPrompt += segment.replaceAll(
        SHORTHAND_ARGS_PLACEHOLDER,
        userArgsRaw
      );
      if (injection.resolvedCommand) {
        const activeTheme = themeManager.getActiveTheme();
        const shellExecutionConfig = {
          ...config.getShellExecutionConfig(),
          defaultFg: activeTheme.colors.Foreground,
          defaultBg: activeTheme.colors.Background
        };
        const { result } = await ShellExecutionService.execute(
          injection.resolvedCommand,
          config.getTargetDir(),
          () => {
          },
          new AbortController().signal,
          config.getShouldUseNodePtyShell(),
          shellExecutionConfig
        );
        const executionResult = await result;
        if (executionResult.error && !executionResult.aborted) {
          throw new Error(
            `Failed to start shell command in '${this.commandName}': ${executionResult.error.message}. Command: ${injection.resolvedCommand}`
          );
        }
        processedPrompt += executionResult.output;
        if (executionResult.aborted) {
          processedPrompt += `
[Shell command '${injection.resolvedCommand}' aborted]`;
        } else if (executionResult.exitCode !== 0 && executionResult.exitCode !== null) {
          processedPrompt += `
[Shell command '${injection.resolvedCommand}' exited with code ${executionResult.exitCode}]`;
        } else if (isSignalTermination(executionResult.signal)) {
          processedPrompt += `
[Shell command '${injection.resolvedCommand}' terminated by signal ${executionResult.signal}]`;
        }
      }
      lastIndex = injection.endIndex;
    }
    const finalSegment = prompt.substring(lastIndex);
    processedPrompt += finalSegment.replaceAll(
      SHORTHAND_ARGS_PLACEHOLDER,
      userArgsRaw
    );
    return [{ text: processedPrompt }];
  }
};

// packages/cli/src/services/prompt-processors/atFileProcessor.ts
init_esbuild_shims();
var debugLogger17 = createDebugLogger("AT_FILE_PROCESSOR");
var AtFileProcessor = class {
  constructor(commandName) {
    this.commandName = commandName;
  }
  static {
    __name(this, "AtFileProcessor");
  }
  async process(input, context) {
    const config = context.services.config;
    if (!config) {
      return input;
    }
    return flatMapTextParts(input, async (text) => {
      if (!text.includes(AT_FILE_INJECTION_TRIGGER)) {
        return [{ text }];
      }
      const injections = extractInjections(
        text,
        AT_FILE_INJECTION_TRIGGER,
        this.commandName
      );
      if (injections.length === 0) {
        return [{ text }];
      }
      const output = [];
      let lastIndex = 0;
      for (const injection of injections) {
        const prefix = text.substring(lastIndex, injection.startIndex);
        if (prefix) {
          output.push({ text: prefix });
        }
        const pathStr = injection.content;
        try {
          const fileContentParts = await readPathFromWorkspace(pathStr, config);
          if (fileContentParts.length === 0) {
            const uiMessage = `File '@{${pathStr}}' was ignored by .gitignore or configured Qwen ignore files and was not included in the prompt.`;
            context.ui.addItem(
              { type: "info" /* INFO */, text: uiMessage },
              Date.now()
            );
          }
          output.push(...fileContentParts);
        } catch (error) {
          const message2 = error instanceof Error ? error.message : String(error);
          const uiMessage = `Failed to inject content for '@{${pathStr}}': ${message2}`;
          debugLogger17.error(
            `[AtFileProcessor] ${uiMessage}. Leaving placeholder in prompt.`
          );
          context.ui.addItem(
            { type: "error" /* ERROR */, text: uiMessage },
            Date.now()
          );
          const placeholder = text.substring(
            injection.startIndex,
            injection.endIndex
          );
          output.push({ text: placeholder });
        }
        lastIndex = injection.endIndex;
      }
      const suffix = text.substring(lastIndex);
      if (suffix) {
        output.push({ text: suffix });
      }
      return output;
    });
  }
};

// packages/cli/src/services/command-factory.ts
var debugLogger18 = createDebugLogger("COMMAND_FACTORY");
function createSlashCommandFromDefinition(filePath, baseDir, definition, extensionName, fileExtension) {
  const relativePathWithExt = path16.relative(baseDir, filePath);
  const relativePath = relativePathWithExt.substring(
    0,
    relativePathWithExt.length - fileExtension.length
  );
  const baseCommandName = relativePath.split(path16.sep).map((segment) => segment.replaceAll(":", "_")).join(":");
  const defaultDescription = `Custom command from ${path16.basename(filePath)}`;
  let description = definition.description || defaultDescription;
  if (extensionName) {
    description = `[${extensionName}] ${description}`;
  }
  const processors = [];
  const usesArgs = definition.prompt.includes(SHORTHAND_ARGS_PLACEHOLDER);
  const usesShellInjection = definition.prompt.includes(
    SHELL_INJECTION_TRIGGER
  );
  const usesAtFileInjection = definition.prompt.includes(
    AT_FILE_INJECTION_TRIGGER
  );
  if (usesAtFileInjection) {
    processors.push(new AtFileProcessor(baseCommandName));
  }
  if (usesShellInjection || usesArgs) {
    processors.push(new ShellProcessor(baseCommandName));
  }
  if (!usesArgs) {
    processors.push(new DefaultArgumentProcessor());
  }
  return {
    name: baseCommandName,
    description,
    modelDescription: description,
    kind: "file" /* FILE */,
    extensionName,
    source: extensionName ? "plugin-command" : "skill-dir-command",
    // `extensionName` reaches the factory already resolved to
    // `displayName ?? name` by `FileCommandLoader.getCommandDirectories`, so
    // the id/display chain runs once per extension, not once per surface. The
    // label format still comes from the single home the skill surfaces use.
    sourceLabel: extensionName ? extensionOwnerLabel({ name: extensionName }) : t("Custom"),
    sourceDetail: extensionName ? "extension" : "custom",
    modelInvocable: definition.disableModelInvocation ? false : !extensionName || !!(definition.description || definition.whenToUse),
    argumentHint: definition.argumentHint,
    whenToUse: definition.whenToUse,
    action: /* @__PURE__ */ __name(async (context, _args) => {
      if (!context.invocation) {
        debugLogger18.error(
          `[FileCommandLoader] Critical error: Command '${baseCommandName}' was executed without invocation context.`
        );
        return {
          type: "submit_prompt",
          content: [{ text: definition.prompt }]
          // Fallback to unprocessed prompt
        };
      }
      try {
        let processedContent = [
          { text: definition.prompt }
        ];
        for (const processor of processors) {
          processedContent = await processor.process(processedContent, context);
        }
        return {
          type: "submit_prompt",
          content: processedContent
        };
      } catch (e) {
        if (e instanceof ConfirmationRequiredError) {
          return {
            type: "confirm_shell_commands",
            commandsToConfirm: e.commandsToConfirm,
            originalInvocation: {
              raw: context.invocation.raw
            }
          };
        }
        throw e;
      }
    }, "action")
  };
}
__name(createSlashCommandFromDefinition, "createSlashCommandFromDefinition");

// packages/cli/src/services/FileCommandLoader.ts
var debugLogger19 = createDebugLogger("FILE_COMMAND_LOADER");
var TomlCommandDefSchema = external_exports.object({
  prompt: external_exports.string({
    required_error: "The 'prompt' field is required.",
    invalid_type_error: "The 'prompt' field must be a string."
  }),
  description: external_exports.string().optional()
});
var FileCommandLoader = class {
  constructor(config) {
    this.config = config;
    this.folderTrustEnabled = !!config?.getFolderTrustFeature();
    this.folderTrust = !!config?.getFolderTrust();
    this.projectRoot = config?.getProjectRoot() || process.cwd();
  }
  static {
    __name(this, "FileCommandLoader");
  }
  projectRoot;
  folderTrustEnabled;
  folderTrust;
  /**
   * Loads all commands from user, project, and extension directories.
   * Returns commands in order: user → project → extensions (alphabetically).
   *
   * Order is important for conflict resolution in CommandService:
   * - User/project commands (without extensionName) use "last wins" strategy
   * - Extension commands (with extensionName) get renamed if conflicts exist
   *
   * @param signal An AbortSignal to cancel the loading process.
   * @returns A promise that resolves to an array of all loaded SlashCommands.
   */
  async loadCommands(signal) {
    if (this.config?.getBareMode?.()) {
      debugLogger19.debug("Bare mode enabled, skipping auto-discovered commands");
      return [];
    }
    const allCommands = [];
    const globOptions = {
      nodir: true,
      dot: true,
      signal,
      follow: true
    };
    const commandDirs = this.getCommandDirectories();
    for (const dirInfo of commandDirs) {
      try {
        const tomlFiles = await glob("**/*.toml", {
          ...globOptions,
          cwd: dirInfo.path
        });
        const mdFiles = await glob("**/*.md", {
          ...globOptions,
          cwd: dirInfo.path
        });
        if (this.folderTrustEnabled && !this.folderTrust) {
          return [];
        }
        const tomlCommandPromises = tomlFiles.map(
          (file) => this.parseAndAdaptTomlFile(
            path17.join(dirInfo.path, file),
            dirInfo.path,
            dirInfo.extensionName
          )
        );
        const mdCommandPromises = mdFiles.map(
          (file) => this.parseAndAdaptMarkdownFile(
            path17.join(dirInfo.path, file),
            dirInfo.path,
            dirInfo.extensionName
          )
        );
        const commands = (await Promise.all([...tomlCommandPromises, ...mdCommandPromises])).filter((cmd) => cmd !== null);
        allCommands.push(...commands);
      } catch (error) {
        const isEnoent = error.code === "ENOENT";
        const isAbortError = error instanceof Error && error.name === "AbortError";
        if (!isEnoent && !isAbortError) {
          debugLogger19.error(
            `[FileCommandLoader] Error loading commands from ${dirInfo.path}:`,
            error
          );
        }
      }
    }
    return allCommands;
  }
  /**
   * Get all command directories in order for loading.
   * User commands → Project commands → Extension commands
   * This order ensures extension commands can detect all conflicts.
   */
  getCommandDirectories() {
    const dirs = [];
    const storage = this.config?.storage ?? new Storage(this.projectRoot);
    dirs.push({ path: Storage.getUserCommandsDir() });
    dirs.push({ path: storage.getProjectCommandsDir() });
    if (this.config) {
      const activeExtensions = this.config.getExtensions().filter(
        (ext) => ext.isActive && ext.format !== "agent-plugins-v1" && ext.installMetadata?.originSource !== "AgentPlugins"
      ).sort((a, b) => a.name.localeCompare(b.name));
      for (const ext of activeExtensions) {
        const commandsPaths = this.getExtensionCommandsPaths(ext);
        for (const cmdPath of commandsPaths) {
          dirs.push({
            path: cmdPath,
            extensionName: ext.displayName ?? ext.name
          });
        }
      }
    }
    return dirs;
  }
  /**
   * Get commands paths from an extension.
   * Returns paths from config.commands if specified, otherwise defaults to 'commands' directory.
   */
  getExtensionCommandsPaths(ext) {
    try {
      const configPath = path17.join(ext.path, EXTENSIONS_CONFIG_FILENAME);
      if (fsSync.existsSync(configPath)) {
        const configContent = fsSync.readFileSync(configPath, "utf-8");
        const config = JSON.parse(configContent);
        if (config.commands) {
          const commandsArray = Array.isArray(config.commands) ? config.commands : [config.commands];
          return commandsArray.map(
            (cmdPath) => path17.isAbsolute(cmdPath) ? cmdPath : path17.join(ext.path, cmdPath)
          ).filter((cmdPath) => {
            try {
              return fsSync.existsSync(cmdPath);
            } catch {
              return false;
            }
          });
        }
      }
    } catch (error) {
      debugLogger19.warn(
        `Failed to read extension config for ${ext.name}:`,
        error
      );
    }
    const defaultPath = path17.join(ext.path, "commands");
    try {
      if (fsSync.existsSync(defaultPath)) {
        return [defaultPath];
      }
    } catch {
    }
    return [];
  }
  /**
   * Parses a single .toml file and transforms it into a SlashCommand object.
   * @param filePath The absolute path to the .toml file.
   * @param baseDir The root command directory for name calculation.
   * @param extensionName Optional extension name to prefix commands with.
   * @returns A promise resolving to a SlashCommand, or null if the file is invalid.
   */
  async parseAndAdaptTomlFile(filePath, baseDir, extensionName) {
    let fileContent;
    try {
      fileContent = await fs13.readFile(filePath, "utf-8");
    } catch (error) {
      debugLogger19.error(
        `[FileCommandLoader] Failed to read file ${filePath}:`,
        error instanceof Error ? error.message : String(error)
      );
      return null;
    }
    let parsed;
    try {
      parsed = import_toml.default.parse(fileContent);
    } catch (error) {
      debugLogger19.error(
        `[FileCommandLoader] Failed to parse TOML file ${filePath}:`,
        error instanceof Error ? error.message : String(error)
      );
      return null;
    }
    const validationResult = TomlCommandDefSchema.safeParse(parsed);
    if (!validationResult.success) {
      debugLogger19.error(
        `[FileCommandLoader] Skipping invalid command file: ${filePath}. Validation errors:`,
        validationResult.error.flatten()
      );
      return null;
    }
    const validDef = validationResult.data;
    return createSlashCommandFromDefinition(
      filePath,
      baseDir,
      validDef,
      extensionName,
      ".toml"
    );
  }
  /**
   * Parses a single .md file and transforms it into a SlashCommand object.
   * @param filePath The absolute path to the .md file.
   * @param baseDir The root command directory for name calculation.
   * @param extensionName Optional extension name to prefix commands with.
   * @returns A promise resolving to a SlashCommand, or null if the file is invalid.
   */
  async parseAndAdaptMarkdownFile(filePath, baseDir, extensionName) {
    let fileContent;
    try {
      fileContent = await fs13.readFile(filePath, "utf-8");
    } catch (error) {
      debugLogger19.error(
        `[FileCommandLoader] Failed to read file ${filePath}:`,
        error instanceof Error ? error.message : String(error)
      );
      return null;
    }
    let parsed;
    try {
      parsed = parseMarkdownCommand(fileContent);
    } catch (error) {
      debugLogger19.error(
        `[FileCommandLoader] Failed to parse Markdown file ${filePath}:`,
        error instanceof Error ? error.message : String(error)
      );
      return null;
    }
    const validationResult = MarkdownCommandDefSchema.safeParse(parsed);
    if (!validationResult.success) {
      debugLogger19.error(
        `[FileCommandLoader] Skipping invalid command file: ${filePath}. Validation errors:`,
        validationResult.error.flatten()
      );
      return null;
    }
    const validDef = validationResult.data;
    const definition = {
      prompt: validDef.prompt,
      description: validDef.frontmatter?.description && typeof validDef.frontmatter.description === "string" ? validDef.frontmatter.description : void 0,
      whenToUse: validDef.frontmatter?.when_to_use,
      argumentHint: validDef.frontmatter?.["argument-hint"],
      disableModelInvocation: validDef.frontmatter?.["disable-model-invocation"]
    };
    return createSlashCommandFromDefinition(
      filePath,
      baseDir,
      definition,
      extensionName,
      ".md"
    );
  }
};

// packages/cli/src/services/saved-workflow-loader.ts
init_esbuild_shims();
var debugLogger20 = createDebugLogger("SavedWorkflowLoader");
var SavedWorkflowLoader = class {
  constructor(config) {
    this.config = config;
  }
  static {
    __name(this, "SavedWorkflowLoader");
  }
  async loadCommands(signal) {
    if (!this.config) return [];
    if (!this.config.isWorkflowsEnabled?.()) return [];
    if (this.config.getBareMode?.()) return [];
    const folderTrustEnabled = !!this.config.getFolderTrustFeature?.();
    const folderTrust = !!this.config.getFolderTrust?.();
    if (folderTrustEnabled && !folderTrust) return [];
    let entries;
    try {
      entries = await listSavedWorkflows(this.config);
    } catch (e) {
      debugLogger20.debug(`listSavedWorkflows failed: ${e}`);
      return [];
    }
    if (signal.aborted) return [];
    return entries.map((entry) => this.toCommand(entry));
  }
  toCommand(entry) {
    const description = entry.source === "extension" && entry.description ? entry.description : `Run the "${entry.name}" saved workflow (${entry.source})`;
    const modelInvocable = entry.source === "extension" && !!entry.whenToUse;
    return {
      name: entry.name,
      description,
      ...modelInvocable ? {
        modelInvocable: true,
        // Commands reach the skill listing as a name and a description,
        // so the condition rides in the description, as it does for a
        // skill entry.
        modelDescription: `${description} \u2014 ${entry.whenToUse}`,
        whenToUse: entry.whenToUse
      } : {},
      // File-derived command (all execution modes via commandUtils fallback);
      // `source` carries the distinct workflow identity for display/telemetry.
      kind: "file" /* FILE */,
      source: "workflow-command",
      // An extension workflow names its owner, which becomes its source badge.
      sourceLabel: entry.extensionName ? extensionOwnerLabel({
        name: entry.extensionName,
        displayName: entry.extensionDisplayName
      }) : "Workflow",
      sourceDetail: entry.source,
      // 'project' | 'user' | 'extension'
      // An extension workflow is an extension command. On a collision with its
      // extension's same-named skill, `CommandService` renames it to
      // `<extension>.<name>` and the skill keeps its surfaces; `workflowName`
      // keeps a denylist entry written with the documented name matching. A
      // user or project custom command of the same name still takes the slash
      // command, because `FileCommandLoader` loads after this loader.
      ...entry.extensionName ? { extensionName: entry.extensionName, workflowName: entry.name } : {},
      acceptsInput: true,
      argumentHint: "[json-args]",
      action: /* @__PURE__ */ __name((context, args) => {
        const workflowArgs = parseWorkflowArgs(args);
        if (context.executionMode === "non_interactive" || context.executionMode === "acp") {
          return {
            type: "submit_prompt",
            content: buildWorkflowInvocationPrompt(entry, workflowArgs)
          };
        }
        return {
          type: "tool",
          toolName: ToolNames.WORKFLOW,
          toolArgs: {
            // The tool reads the file fresh at execution time (hot reload).
            // A path keeps grants written as Workflow(scriptPath:...) working;
            // a name-only session refuses paths, so it names the workflow.
            ...this.config?.isWorkflowNameOnly?.() === true ? { name: entry.name } : { scriptPath: entry.scriptPath },
            ...workflowArgs !== void 0 ? { args: workflowArgs } : {}
          }
        };
      }, "action")
    };
  }
};
function buildWorkflowInvocationPrompt(entry, workflowArgs) {
  const name = JSON.stringify(entry.name);
  const call = workflowArgs === void 0 ? `{ name: ${name} }` : `{ name: ${name}, args: ${JSON.stringify(workflowArgs)} }`;
  return [
    entry.source === "extension" ? `Run the "${entry.name}" workflow.` : `Run the "${entry.name}" saved workflow (${entry.source}).`,
    entry.description,
    entry.whenToUse,
    `Invoke: Workflow(${call})`
  ].filter((part) => part).join("\n\n");
}
__name(buildWorkflowInvocationPrompt, "buildWorkflowInvocationPrompt");
function parseWorkflowArgs(raw) {
  const trimmed = (raw ?? "").trim();
  return trimmed.length > 0 ? tryParseJson(trimmed) : void 0;
}
__name(parseWorkflowArgs, "parseWorkflowArgs");
function tryParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
__name(tryParseJson, "tryParseJson");

// packages/cli/src/services/McpPromptLoader.ts
init_esbuild_shims();
var NAMED_ARG_REGEX = /--([^=]+)=(?:"((?:\\.|[^"\\])*)"|([^ ]+))/;
var McpPromptLoader = class {
  constructor(config) {
    this.config = config;
  }
  static {
    __name(this, "McpPromptLoader");
  }
  /**
   * Loads all available prompts from all configured MCP servers and adapts
   * them into executable SlashCommand objects.
   *
   * @param _signal An AbortSignal (unused for this synchronous loader).
   * @returns A promise that resolves to an array of loaded SlashCommands.
   */
  loadCommands(_signal) {
    const promptCommands = [];
    if (!this.config) {
      return Promise.resolve([]);
    }
    const mcpServers = this.config.getMcpServers() || {};
    for (const serverName in mcpServers) {
      const prompts = getMCPServerPrompts(this.config, serverName) || [];
      for (const prompt of prompts) {
        const commandName = `${prompt.name}`;
        const description = prompt.description || `Invoke prompt ${prompt.name}`;
        const newPromptCommand = {
          name: commandName,
          description,
          modelDescription: description,
          kind: "mcp-prompt" /* MCP_PROMPT */,
          source: "mcp-prompt",
          sourceLabel: `MCP: ${serverName}`,
          subCommands: [
            {
              name: "help",
              description: "Show help for this prompt",
              modelDescription: "Show help for this prompt",
              kind: "mcp-prompt" /* MCP_PROMPT */,
              source: "mcp-prompt",
              action: /* @__PURE__ */ __name(async () => {
                if (!prompt.arguments || prompt.arguments.length === 0) {
                  return {
                    type: "message",
                    messageType: "info",
                    content: `Prompt "${prompt.name}" has no declared arguments. Any text you provide will be forwarded as-is (e.g., /${prompt.name} some text sends { input: "some text" }).`
                  };
                }
                let helpMessage = `Arguments for "${prompt.name}":

`;
                if (prompt.arguments && prompt.arguments.length > 0) {
                  helpMessage += `You can provide arguments by name (e.g., --argName="value") or by position.

`;
                  helpMessage += `e.g., ${prompt.name} ${prompt.arguments?.map((_) => `"foo"`)} is equivalent to ${prompt.name} ${prompt.arguments?.map((arg) => `--${arg.name}="foo"`)}

`;
                }
                for (const arg of prompt.arguments) {
                  helpMessage += `  --${arg.name}
`;
                  if (arg.description) {
                    helpMessage += `    ${arg.description}
`;
                  }
                  helpMessage += `    (required: ${arg.required ? "yes" : "no"})

`;
                }
                return {
                  type: "message",
                  messageType: "info",
                  content: helpMessage
                };
              }, "action")
            }
          ],
          action: /* @__PURE__ */ __name(async (context, args) => {
            if (!this.config) {
              return {
                type: "message",
                messageType: "error",
                content: "Config not loaded."
              };
            }
            const promptInputs = this.parseArgs(args, prompt.arguments);
            if (promptInputs instanceof Error) {
              return {
                type: "message",
                messageType: "error",
                content: promptInputs.message
              };
            }
            try {
              const mcpServers2 = this.config.getMcpServers() || {};
              const mcpServerConfig = mcpServers2[serverName];
              if (!mcpServerConfig) {
                return {
                  type: "message",
                  messageType: "error",
                  content: `MCP server config not found for '${serverName}'.`
                };
              }
              const result = await prompt.invoke(promptInputs);
              if (result["error"]) {
                return {
                  type: "message",
                  messageType: "error",
                  content: `Error invoking prompt: ${result["error"]}`
                };
              }
              const firstMessage = result.messages?.[0];
              const content = firstMessage?.content;
              if (content?.type !== "text") {
                return {
                  type: "message",
                  messageType: "error",
                  content: "Received an empty or invalid prompt response from the server."
                };
              }
              return {
                type: "submit_prompt",
                content: JSON.stringify(content.text)
              };
            } catch (error) {
              return {
                type: "message",
                messageType: "error",
                content: `Error: ${getErrorMessage(error)}`
              };
            }
          }, "action"),
          completion: /* @__PURE__ */ __name(async (commandContext, partialArg) => {
            const invocation = commandContext.invocation;
            if (!prompt || !prompt.arguments || !invocation) {
              return [];
            }
            const indexOfFirstSpace = invocation.raw.indexOf(" ") + 1;
            const argsString = indexOfFirstSpace === 0 ? "" : invocation.raw.substring(indexOfFirstSpace);
            const namedArgRegex = new RegExp(NAMED_ARG_REGEX.source, "g");
            const providedArgNames = /* @__PURE__ */ new Set();
            let m;
            while ((m = namedArgRegex.exec(argsString)) !== null) {
              providedArgNames.add(m[1]);
            }
            const positionalTokens = argsString.replace(namedArgRegex, " ").match(/(?:"(?:\\.|[^"\\])*"|[^ ]+)/g) || [];
            const positionalCount = positionalTokens.filter(
              (token) => !token.startsWith("--")
            ).length;
            if (positionalCount > 0) {
              const unfilled = prompt.arguments.filter((arg) => !providedArgNames.has(arg.name)).sort(
                (a, b) => a.required === b.required ? 0 : a.required ? -1 : 1
              );
              for (let i = 0; i < positionalCount && i < unfilled.length; i++) {
                providedArgNames.add(unfilled[i].name);
              }
            }
            const unusedRequired = [];
            const unusedOptional = [];
            for (const arg of prompt.arguments) {
              if (providedArgNames.has(arg.name)) continue;
              const flag = `--${arg.name}="`;
              if (arg.required) {
                unusedRequired.push(flag);
              } else {
                unusedOptional.push(flag);
              }
            }
            const unusedArguments = unusedRequired.length > 0 ? partialArg.length > 0 ? [...unusedRequired, ...unusedOptional] : unusedRequired : partialArg.length > 0 ? unusedOptional : [];
            const exactlyMatchingArgumentAtTheEnd = prompt.arguments.map((argument) => `--${argument.name}="`).filter((flagArgument) => {
              const regex = new RegExp(`${flagArgument}[^"]*$`);
              return regex.test(invocation.raw);
            });
            if (exactlyMatchingArgumentAtTheEnd.length === 1) {
              if (exactlyMatchingArgumentAtTheEnd[0] === partialArg) {
                return [`${partialArg}"`];
              }
              if (partialArg.endsWith('"')) {
                return [partialArg];
              }
              return [`${partialArg}"`];
            }
            const matchingArguments = unusedArguments.filter(
              (flagArgument) => flagArgument.startsWith(partialArg)
            );
            return matchingArguments;
          }, "completion")
        };
        promptCommands.push(newPromptCommand);
      }
    }
    return Promise.resolve(promptCommands);
  }
  /**
   * Parses the `userArgs` string representing the prompt arguments (all the text
   * after the command) into a record matching the shape of the `promptArgs`.
   *
   * @param userArgs
   * @param promptArgs
   * @returns A record of the parsed arguments
   * @visibleForTesting
   */
  parseArgs(userArgs, promptArgs) {
    const argValues = {};
    const promptInputs = {};
    const namedArgRegex = new RegExp(NAMED_ARG_REGEX.source, "g");
    let match;
    let lastIndex = 0;
    const positionalParts = [];
    while ((match = namedArgRegex.exec(userArgs)) !== null) {
      const key = match[1];
      const value = (match[2] ?? match[3]).replace(/\\(.)/g, "$1");
      argValues[key] = value;
      if (match.index > lastIndex) {
        positionalParts.push(userArgs.substring(lastIndex, match.index));
      }
      lastIndex = namedArgRegex.lastIndex;
    }
    if (lastIndex < userArgs.length) {
      positionalParts.push(userArgs.substring(lastIndex));
    }
    const positionalArgsString = positionalParts.join("").trim();
    const positionalArgRegex = /(?:"((?:\\.|[^"\\])*)"|([^ ]+))/g;
    const positionalArgs = [];
    while ((match = positionalArgRegex.exec(positionalArgsString)) !== null) {
      positionalArgs.push((match[1] ?? match[2]).replace(/\\(.)/g, "$1"));
    }
    if (!promptArgs || promptArgs.length === 0) {
      Object.assign(promptInputs, argValues);
      const positionalInput = positionalArgs.join(" ");
      if (positionalInput && !Object.hasOwn(argValues, "input")) {
        promptInputs["input"] = positionalInput;
      }
      return promptInputs;
    }
    for (const arg of promptArgs) {
      if (Object.hasOwn(argValues, arg.name)) {
        promptInputs[arg.name] = argValues[arg.name];
      }
    }
    const unfilledArgs = promptArgs.filter((arg) => !Object.hasOwn(promptInputs, arg.name)).sort((a, b) => a.required === b.required ? 0 : a.required ? -1 : 1);
    if (unfilledArgs.length === 1 && positionalArgs.length > 0) {
      promptInputs[unfilledArgs[0].name] = positionalArgs.join(" ");
    } else if (positionalArgs.length > 0) {
      for (let i = 0; i < unfilledArgs.length && i < positionalArgs.length; i++) {
        promptInputs[unfilledArgs[i].name] = positionalArgs[i];
      }
    }
    const missingRequired = promptArgs.filter(
      (arg) => arg.required && !Object.hasOwn(promptInputs, arg.name)
    );
    if (missingRequired.length > 0) {
      const missingArgNames = missingRequired.map((arg) => `--${arg.name}`).join(", ");
      return new Error(`Missing required argument(s): ${missingArgNames}`);
    }
    return promptInputs;
  }
};

// packages/cli/src/services/SkillCommandLoader.ts
init_esbuild_shims();
import { dirname as dirname3 } from "node:path";
var debugLogger21 = createDebugLogger("SKILL_COMMAND_LOADER");
async function recordAutoSkillCommandUsage(config, command) {
  const detail = command.skillDetail;
  if (!config || detail?.level !== "project" || !detail.filePath) {
    return;
  }
  try {
    await recordAutoSkillUsage(config.getProjectRoot(), {
      name: detail.name,
      level: "project",
      filePath: detail.filePath
    });
  } catch (error) {
    debugLogger21.warn(
      `Failed to record auto-skill command usage: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
__name(recordAutoSkillCommandUsage, "recordAutoSkillCommandUsage");
var SkillCommandLoader = class {
  constructor(config) {
    this.config = config;
  }
  static {
    __name(this, "SkillCommandLoader");
  }
  async loadCommands(_signal) {
    if (this.config?.getBareMode?.()) {
      debugLogger21.debug("Bare mode enabled, skipping skill commands");
      return [];
    }
    const skillManager = this.config?.getSkillManager();
    if (!skillManager) {
      debugLogger21.debug("SkillManager not available, skipping skill commands");
      return [];
    }
    try {
      const [userSkills, projectSkills, extensionSkills] = await Promise.all([
        skillManager.listSkills({ level: "user" }),
        skillManager.listSkills({ level: "project" }),
        skillManager.listSkills({ level: "extension" })
      ]);
      const allSkills = [...userSkills, ...projectSkills, ...extensionSkills];
      const visibleSkills = allSkills.filter(
        (skill) => this.config?.isSkillEnabled(skill) ?? true
      );
      const nonUserInvocableCount = visibleSkills.filter(
        (skill) => skill.userInvocable === false
      ).length;
      debugLogger21.debug(
        `Loaded ${userSkills.length} user + ${projectSkills.length} project + ${extensionSkills.length} extension skill(s) as slash commands; ${allSkills.length - visibleSkills.length} disabled; ${nonUserInvocableCount} marked non-user-invocable`
      );
      return visibleSkills.map((skill) => {
        const isExtension = skill.level === "extension";
        const modelInvocable = skill.disableModelInvocation ? false : isExtension ? !!(skill.description || skill.whenToUse) : true;
        const sourceLabel = isExtension ? extensionOwnerLabel({
          name: skill.extensionName,
          displayName: skill.extensionDisplayName
        }) : skill.level === "project" ? t("Project") : t("User");
        return {
          name: skill.name,
          description: skill.description,
          modelDescription: skill.description,
          kind: "skill" /* SKILL */,
          source: isExtension ? "plugin-command" : "skill-dir-command",
          sourceLabel,
          sourceDetail: isExtension ? "extension" : skill.level === "project" ? "project" : "user",
          userInvocable: skill.userInvocable ?? true,
          modelInvocable,
          argumentHint: skill.argumentHint,
          whenToUse: skill.whenToUse,
          skillDetail: {
            name: skill.name,
            description: skill.description,
            body: skill.body,
            filePath: skill.filePath,
            level: skill.level,
            ...isExtension && skill.extensionName ? {
              extensionName: skill.extensionName,
              authoredName: skill.authoredName
            } : {}
          },
          action: /* @__PURE__ */ __name(async (context, _args) => {
            if (this.config && !this.config.isSkillEnabled(skill)) {
              return {
                type: "message",
                messageType: "error",
                content: `Skill "${skill.name}" is disabled.`
              };
            }
            await applySkillSideEffects(this.config, skill);
            const body = buildSkillLlmContent(
              dirname3(skill.filePath),
              skill.body
            );
            const rawArgs = context.invocation?.args ?? "";
            let content;
            if (rawArgs) {
              content = appendToLastTextPart(
                [{ text: body }],
                context.invocation.raw + (writeSkillArgs(skill.name, rawArgs) ? skillArgsNote(skillArgsPath(skill.name), rawArgs) : "")
              );
            } else {
              content = [{ text: body }];
              if (!clearSkillArgs(skill.name)) {
                content = appendToLastTextPart(content, staleArgsWarning());
              }
            }
            return {
              type: "submit_prompt",
              content
            };
          }, "action")
        };
      });
    } catch (error) {
      debugLogger21.error("Failed to load skill commands:", error);
      return [];
    }
  }
};

// packages/cli/src/ui/noninteractive/nonInteractiveUi.ts
init_esbuild_shims();
function createNonInteractiveUI() {
  return {
    history: [],
    addItem: /* @__PURE__ */ __name((_item, _timestamp) => 0, "addItem"),
    clear: /* @__PURE__ */ __name(() => {
    }, "clear"),
    setDebugMessage: /* @__PURE__ */ __name((_message) => {
    }, "setDebugMessage"),
    loadHistory: /* @__PURE__ */ __name((_newHistory) => {
    }, "loadHistory"),
    refreshStatic: /* @__PURE__ */ __name(() => {
    }, "refreshStatic"),
    pendingItem: null,
    setPendingItem: /* @__PURE__ */ __name((_item) => {
    }, "setPendingItem"),
    btwItem: null,
    setBtwItem: /* @__PURE__ */ __name((_item) => {
    }, "setBtwItem"),
    cancelBtw: /* @__PURE__ */ __name(() => {
    }, "cancelBtw"),
    btwAbortControllerRef: { current: null },
    isIdleRef: { current: true },
    toggleVimEnabled: /* @__PURE__ */ __name(async () => false, "toggleVimEnabled"),
    setMemoryFileCount: /* @__PURE__ */ __name((_count) => {
    }, "setMemoryFileCount"),
    reloadCommands: /* @__PURE__ */ __name(() => {
    }, "reloadCommands"),
    setSessionName: /* @__PURE__ */ __name(() => {
    }, "setSessionName"),
    extensionsUpdateState: /* @__PURE__ */ new Map(),
    dispatchExtensionStateUpdate: /* @__PURE__ */ __name((_action) => {
    }, "dispatchExtensionStateUpdate"),
    addConfirmUpdateExtensionRequest: /* @__PURE__ */ __name((_request) => {
    }, "addConfirmUpdateExtensionRequest")
  };
}
__name(createNonInteractiveUI, "createNonInteractiveUI");

// packages/cli/src/utils/userPromptExpansionHook.ts
init_esbuild_shims();
function appendUserPromptExpansionAdditionalContext(content, additionalContext) {
  if (!additionalContext) {
    return content;
  }
  const suffix = `

${additionalContext}`;
  if (typeof content === "string") {
    return `${content}${suffix}`;
  }
  if (Array.isArray(content)) {
    return [...content, { text: suffix }];
  }
  return [content, { text: suffix }];
}
__name(appendUserPromptExpansionAdditionalContext, "appendUserPromptExpansionAdditionalContext");
function serializeUserPromptExpansionPrompt(content) {
  return partToString(content, { verbose: true });
}
__name(serializeUserPromptExpansionPrompt, "serializeUserPromptExpansionPrompt");
function formatUserPromptExpansionBlockedMessage(reason) {
  const sanitizedReason = sanitizeUserPromptExpansionAdditionalContext(reason);
  return `UserPromptExpansion blocked: ${sanitizedReason}`;
}
__name(formatUserPromptExpansionBlockedMessage, "formatUserPromptExpansionBlockedMessage");

// packages/cli/src/nonInteractiveCliCommands.ts
var debugLogger22 = createDebugLogger("NON_INTERACTIVE_COMMANDS");
function getSkillCommandName(command) {
  return command.skillDetail?.name ?? command.name;
}
__name(getSkillCommandName, "getSkillCommandName");
function isCommandAllowedByPolicy(command, policy) {
  if (!policy || command.kind !== "built-in" /* BUILT_IN */) return true;
  if (command.name === "clear" && !policy.allowSessionReset) return false;
  return !policy.blockedBuiltinCommandNames.includes(command.name);
}
__name(isCommandAllowedByPolicy, "isCommandAllowedByPolicy");
function handleCommandResult(result, outputHistoryItems) {
  switch (result.type) {
    case "submit_prompt":
      return {
        type: "submit_prompt",
        content: result.content,
        ...result.modelOverride ? { modelOverride: result.modelOverride } : {},
        ...result.refreshContextFilesOnWrite ? { refreshContextFilesOnWrite: true } : {},
        ...outputHistoryItems?.length ? { outputHistoryItems } : {}
      };
    case "message":
      return {
        type: "message",
        messageType: result.messageType,
        content: result.content,
        ...outputHistoryItems?.length ? { outputHistoryItems } : {}
      };
    case "stream_messages":
      return {
        type: "stream_messages",
        messages: result.messages
      };
    case "goal_control":
      return {
        type: "goal_control",
        operation: result.operation,
        response: result.response,
        ...result.cause ? { cause: result.cause } : {}
      };
    /**
     * Currently return types below are never generated due to the
     * whitelist of allowed slash commands in ACP and non-interactive mode.
     * We'll try to add more supported return types in the future.
     */
    case "tool":
      return {
        type: "unsupported",
        reason: "Tool execution from slash commands is not supported in non-interactive mode.",
        originalType: "tool"
      };
    case "quit":
      return {
        type: "unsupported",
        reason: "Quit command is not supported in non-interactive mode. The process will exit naturally after completion.",
        originalType: "quit"
      };
    case "dialog":
      return {
        type: "unsupported",
        reason: `Dialog '${result.dialog}' cannot be opened in non-interactive mode.`,
        originalType: "dialog"
      };
    case "load_history":
      return {
        type: "unsupported",
        reason: "Loading history is not supported in non-interactive mode. Each invocation starts with a fresh context.",
        originalType: "load_history"
      };
    case "confirm_shell_commands":
      return {
        type: "unsupported",
        reason: "Shell command confirmation is not supported in non-interactive mode. Use YOLO mode or pre-approve commands.",
        originalType: "confirm_shell_commands"
      };
    case "confirm_action":
      return {
        type: "unsupported",
        reason: "Action confirmation is not supported in non-interactive mode. Commands requiring confirmation cannot be executed.",
        originalType: "confirm_action"
      };
    default: {
      const _exhaustive = result;
      return {
        type: "unsupported",
        reason: `Unknown command result type: ${_exhaustive.type}`,
        originalType: "unknown"
      };
    }
  }
}
__name(handleCommandResult, "handleCommandResult");
async function fireUserPromptExpansionHook(config, commandName, commandArgs, content, signal) {
  if (config.getDisableAllHooks?.() || !(config.hasHooksForEvent?.("UserPromptExpansion") ?? false)) {
    return { content };
  }
  const hookSystem = config.getHookSystem();
  if (!hookSystem) {
    return { content };
  }
  const output = await hookSystem.fireUserPromptExpansionEvent(
    commandName,
    commandArgs,
    serializeUserPromptExpansionPrompt(content),
    signal
  );
  if (!output) {
    return { content };
  }
  const blockingError = output.getBlockingError();
  if (blockingError.blocked || output.shouldStopExecution()) {
    return {
      blockedResult: {
        type: "message",
        messageType: "error",
        content: formatUserPromptExpansionBlockedMessage(
          blockingError.reason || output.getEffectiveReason()
        )
      },
      content
    };
  }
  return {
    content: appendUserPromptExpansionAdditionalContext(
      content,
      output.getAdditionalContext()
    )
  };
}
__name(fireUserPromptExpansionHook, "fireUserPromptExpansionHook");
async function registerModelInvocableCommands(commandService, config, executionMode, settings, executionPolicy) {
  if (!settings) {
    return;
  }
  config.setModelInvocableCommandsProvider(
    () => commandService.getModelInvocableCommands().filter((cmd) => isCommandAllowedByPolicy(cmd, executionPolicy)).map((cmd) => ({
      name: cmd.name,
      description: cmd.modelDescription ?? cmd.description
    }))
  );
  config.setModelInvocableCommandsExecutor(
    async (name, args = "") => {
      const commands = commandService.getModelInvocableCommands();
      const cmd = commands.find(
        (candidate) => candidate.name === name && isCommandAllowedByPolicy(candidate, executionPolicy)
      );
      if (!cmd?.action) return null;
      const minimalContext = {
        executionMode,
        invocation: {
          raw: args ? `/${name} ${args}` : `/${name}`,
          name,
          args
        },
        services: { config, settings, logger: null },
        ...executionPolicy ? { executionPolicy } : {}
      };
      const result = await cmd.action(minimalContext, args);
      if (!result || result.type !== "submit_prompt") return null;
      const hookSignal = new AbortController().signal;
      const hookResult = await fireUserPromptExpansionHook(
        config,
        name,
        args,
        result.content,
        hookSignal
      );
      if (hookResult.blockedResult) {
        return hookResult.blockedResult.type === "message" ? { error: hookResult.blockedResult.content } : null;
      }
      const content = hookResult.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content.map(
          (p) => typeof p === "string" ? p : p.text ?? ""
        ).join("");
      }
      return null;
    }
  );
  const skillManager = typeof config.getSkillManager === "function" ? config.getSkillManager() : null;
  await skillManager?.notifyConfigChanged();
}
__name(registerModelInvocableCommands, "registerModelInvocableCommands");
var handleSlashCommand = /* @__PURE__ */ __name(async (rawQuery, abortController, config, settings, sessionHooks, executionPolicy) => {
  const trimmed = rawQuery.trim();
  if (!trimmed.startsWith("/")) {
    return { type: "no_command" };
  }
  const isAcpMode = config.getExperimentalZedIntegration();
  const isInteractive = config.isInteractive();
  const executionMode = isAcpMode ? "acp" : isInteractive ? "interactive" : "non_interactive";
  const allLoaders = [
    new McpPromptLoader(config),
    new BuiltinCommandLoader(config),
    new BundledSkillLoader(config),
    new SkillCommandLoader(config),
    new SavedWorkflowLoader(config),
    new FileCommandLoader(config)
  ];
  const disabledSlashCommandsRaw = config.getDisabledSlashCommands();
  const disabledNameSet = /* @__PURE__ */ new Set();
  for (const name of disabledSlashCommandsRaw) {
    const trimmed2 = name.trim();
    if (trimmed2) disabledNameSet.add(trimmed2.toLowerCase());
  }
  const isDisabled = /* @__PURE__ */ __name((cmd) => commandRestrictionNames(cmd).some((name) => disabledNameSet.has(name)), "isDisabled");
  const allCommandService = await CommandService.create(
    allLoaders,
    abortController.signal
  );
  const commandService = disabledNameSet.size > 0 ? await CommandService.create(
    allLoaders,
    abortController.signal,
    disabledNameSet
  ) : allCommandService;
  await registerModelInvocableCommands(
    commandService,
    config,
    executionMode,
    settings,
    executionPolicy
  );
  const allCommands = allCommandService.getCommands();
  const filteredCommands = commandService.getCommandsForMode(executionMode).filter(
    (cmd) => !isDisabled(cmd) && isCommandAllowedByPolicy(cmd, executionPolicy)
  );
  const { commandToExecute, args } = parseSlashCommand(
    rawQuery,
    filteredCommands
  );
  const stackedResult = parseStackedSlashCommands(rawQuery, filteredCommands);
  if (stackedResult.skills.length >= 2) {
    const combinedContent = [];
    let firstModelOverride;
    let refreshContextFilesOnWrite = false;
    const onCompleteCallbacks = [];
    const successfulSkillCommands = [];
    for (const skill of stackedResult.skills) {
      if (!skill.action) continue;
      const skillContext = {
        executionMode,
        ...executionPolicy ? { executionPolicy } : {},
        invocation: {
          raw: `/${skill.name}`,
          name: skill.name,
          args: ""
        },
        services: { config, settings, logger: null }
      };
      const skillResult = await skill.action(skillContext, "");
      if (skillResult?.type === "submit_prompt") {
        combinedContent.push(skillResult.content);
        firstModelOverride ??= skillResult.modelOverride;
        refreshContextFilesOnWrite ||= Boolean(
          skillResult.refreshContextFilesOnWrite
        );
        if (skillResult.onComplete) {
          onCompleteCallbacks.push(skillResult.onComplete);
        }
      }
      const succeeded = skillResult?.type === "submit_prompt";
      recordSkillInvocation(config, {
        skillName: getSkillCommandName(skill),
        success: succeeded
      });
      if (succeeded) {
        successfulSkillCommands.push(skill);
      }
    }
    if (stackedResult.remainingText) {
      combinedContent.push([{ text: stackedResult.remainingText }]);
    }
    const mergedContent = combinedContent.flat();
    const hookResult = await fireUserPromptExpansionHook(
      config,
      stackedResult.skills.map((s) => s.name).join(" "),
      stackedResult.remainingText,
      mergedContent,
      abortController.signal
    );
    if (hookResult.blockedResult) {
      return hookResult.blockedResult;
    }
    for (const skill of successfulSkillCommands) {
      void recordAutoSkillCommandUsage(config, skill);
    }
    return {
      type: "submit_prompt",
      content: hookResult.content,
      ...firstModelOverride ? { modelOverride: firstModelOverride } : {},
      ...refreshContextFilesOnWrite ? { refreshContextFilesOnWrite: true } : {},
      ...onCompleteCallbacks.length ? {
        onComplete: /* @__PURE__ */ __name(async () => {
          for (const cb of onCompleteCallbacks) await cb();
        }, "onComplete")
      } : {}
    };
  }
  if (!commandToExecute) {
    const { commandToExecute: knownCommand } = parseSlashCommand(
      rawQuery,
      allCommands
    );
    if (knownCommand) {
      const typedToken = rawQuery.trim().substring(1).trim().split(/\s+/)[0] ?? knownCommand.name;
      if (isDisabled(knownCommand)) {
        return {
          type: "unsupported",
          reason: t(
            'The command "/{{command}}" is disabled by the current configuration.',
            { command: typedToken }
          ),
          originalType: "filtered_command"
        };
      }
      if (!isCommandAllowedByPolicy(knownCommand, executionPolicy)) {
        return {
          type: "unsupported",
          reason: t('The command "/{{command}}" is not available here.', {
            command: typedToken
          }),
          originalType: "unsupported_action"
        };
      }
      return {
        type: "unsupported",
        reason: t('The command "/{{command}}" is not supported in this mode.', {
          command: typedToken
        }),
        originalType: "filtered_command"
      };
    }
    return { type: "no_command" };
  }
  if (!commandToExecute.action) {
    return { type: "no_command" };
  }
  const resolvedCommand = {
    name: commandToExecute.name,
    kind: commandToExecute.kind
  };
  const sessionStats = {
    sessionId: config?.getSessionId(),
    sessionStartTime: /* @__PURE__ */ new Date(),
    metrics: config ? uiTelemetryService.getMetricsForSession(config.getSessionId()) : uiTelemetryService.getMetrics(),
    lastPromptTokenCount: 0,
    promptCount: 1
  };
  const logger3 = new Logger(config?.getSessionId() || "", config?.storage);
  const outputHistoryItems = [];
  const ui = createNonInteractiveUI();
  ui.addItem = (item) => {
    outputHistoryItems.push(item);
    return 0;
  };
  const context = {
    executionMode,
    ...executionPolicy ? { executionPolicy } : {},
    abortSignal: commandToExecute.name === "advisor" ? abortController.signal : void 0,
    services: {
      config,
      settings,
      logger: logger3
    },
    ui,
    session: {
      stats: sessionStats,
      sessionShellAllowlist: /* @__PURE__ */ new Set(),
      ...sessionHooks?.startNewSession ? { startNewSession: sessionHooks.startNewSession } : {}
    },
    invocation: {
      raw: trimmed,
      name: commandToExecute.name,
      args
    }
  };
  const isSkillCommand = commandToExecute.kind === "skill" /* SKILL */;
  let skillInvocationRecorded = false;
  const recordSkillCommandInvocation = /* @__PURE__ */ __name((success) => {
    if (!isSkillCommand || skillInvocationRecorded) {
      return;
    }
    recordSkillInvocation(config, {
      skillName: getSkillCommandName(commandToExecute),
      success
    });
    skillInvocationRecorded = true;
  }, "recordSkillCommandInvocation");
  let result;
  try {
    result = await commandToExecute.action(context, args);
  } catch (error) {
    recordSkillCommandInvocation(false);
    throw error;
  }
  if (!result) {
    return {
      type: "message",
      messageType: "info",
      content: "Command executed successfully.",
      resolvedCommand
    };
  }
  if (result.type === "submit_prompt") {
    let hookResult;
    try {
      hookResult = await fireUserPromptExpansionHook(
        config,
        commandToExecute.name,
        args,
        result.content,
        abortController.signal
      );
    } catch (error) {
      recordSkillCommandInvocation(false);
      throw error;
    }
    if (hookResult.blockedResult) {
      recordSkillCommandInvocation(false);
      return { ...hookResult.blockedResult, resolvedCommand };
    }
    recordSkillCommandInvocation(true);
    void recordAutoSkillCommandUsage(config, commandToExecute);
    return {
      ...handleCommandResult(
        { ...result, content: hookResult.content },
        outputHistoryItems
      ),
      resolvedCommand
    };
  }
  return {
    ...handleCommandResult(result, outputHistoryItems),
    resolvedCommand
  };
}, "handleSlashCommand");
var getAvailableCommands = /* @__PURE__ */ __name(async (config, abortSignal, mode = "acp", settings, executionPolicy) => {
  try {
    const loaders = [
      new McpPromptLoader(config),
      new BuiltinCommandLoader(config),
      new BundledSkillLoader(config),
      new SkillCommandLoader(config),
      new SavedWorkflowLoader(config),
      new FileCommandLoader(config)
    ];
    const disabledSlashCommands = config.getDisabledSlashCommands();
    const commandService = await CommandService.create(
      loaders,
      abortSignal,
      disabledSlashCommands.length > 0 ? new Set(disabledSlashCommands) : void 0
    );
    await registerModelInvocableCommands(
      commandService,
      config,
      mode,
      settings,
      executionPolicy
    );
    return commandService.getCommandsForMode(mode).filter(
      (command) => isCommandAllowedByPolicy(command, executionPolicy)
    );
  } catch (error) {
    debugLogger22.error("Error loading available commands:", error);
    return [];
  }
}, "getAvailableCommands");

// packages/cli/src/nonInteractive/nonInteractiveHelpers.ts
init_esbuild_shims();
var debugLogger23 = createDebugLogger("NON_INTERACTIVE");
function extractPartsFromUserMessage(message2) {
  if (!message2) {
    return null;
  }
  const content = message2.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (!block || typeof block !== "object" || !("type" in block)) {
        continue;
      }
      if (block.type === "text" && "text" in block && block.text) {
        parts.push({ text: block.text });
      } else {
        parts.push({ text: JSON.stringify(block) });
      }
    }
    return parts.length > 0 ? parts : null;
  }
  return null;
}
__name(extractPartsFromUserMessage, "extractPartsFromUserMessage");
function computeUsageFromMetrics(metrics) {
  const stats = computeSessionStats(metrics);
  const { models } = metrics;
  const totalOutputTokens = Object.values(models).reduce(
    (acc, model) => acc + model.tokens.candidates,
    0
  );
  const totalTokens = Object.values(models).reduce(
    (acc, model) => acc + model.tokens.total,
    0
  );
  const usage2 = {
    input_tokens: stats.totalPromptTokens,
    output_tokens: totalOutputTokens,
    cache_read_input_tokens: stats.totalCachedTokens
  };
  if (totalTokens > 0) {
    usage2.total_tokens = totalTokens;
  }
  return usage2;
}
__name(computeUsageFromMetrics, "computeUsageFromMetrics");
function buildInitialSystemReminders(config) {
  const reminders = [];
  if (config.getApprovalMode() === "plan" /* PLAN */) {
    reminders.push({ text: getPlanModeSystemReminder(config.getSdkMode?.()) });
  }
  const arenaManager = config.getArenaManager?.();
  if (arenaManager) {
    try {
      const sessionDir = arenaManager.getArenaSessionDir();
      const configPath = `${sessionDir}/config.json`;
      reminders.push({ text: getArenaSystemReminder(configPath) });
    } catch {
    }
  }
  return reminders;
}
__name(buildInitialSystemReminders, "buildInitialSystemReminders");
function insertAfterFunctionResponses(parts, additions) {
  const firstNonFunctionResponse = parts.findIndex(
    (part) => !part.functionResponse
  );
  const insertAt = firstNonFunctionResponse === -1 ? parts.length : firstNonFunctionResponse;
  return [...parts.slice(0, insertAt), ...additions, ...parts.slice(insertAt)];
}
__name(insertAfterFunctionResponses, "insertAfterFunctionResponses");
async function loadSlashCommandNames(config, settings) {
  const controller = new AbortController();
  try {
    const commands = await getAvailableCommands(
      config,
      controller.signal,
      "non_interactive",
      settings
    );
    return commands.map((cmd) => cmd.name).sort();
  } catch (error) {
    debugLogger23.error(
      "[buildSystemMessage] Failed to load slash commands:",
      error
    );
    return [];
  } finally {
    controller.abort();
  }
}
__name(loadSlashCommandNames, "loadSlashCommandNames");
async function buildSystemMessage(config, sessionId, permissionMode, settings) {
  const toolRegistry = config.getToolRegistry();
  const tools = toolRegistry ? toolRegistry.getAllToolNames() : [];
  const mcpServers = config.getMcpServers();
  const mcpServerList = mcpServers ? Object.keys(mcpServers).map((name) => ({
    name,
    status: getMCPServerStatus(name)
  })) : [];
  const slashCommands = await loadSlashCommandNames(config, settings);
  let agentNames = [];
  try {
    const subagentManager = config.getSubagentManager();
    const subagents = await subagentManager.listSubagents();
    agentNames = subagents.map((subagent) => subagent.name);
  } catch (error) {
    debugLogger23.error("[buildSystemMessage] Failed to load subagents:", error);
  }
  const systemMessage = {
    type: "system",
    subtype: "init",
    uuid: sessionId,
    session_id: sessionId,
    cwd: config.getTargetDir(),
    tools,
    mcp_servers: mcpServerList,
    model: config.getModel(),
    permission_mode: permissionMode,
    slash_commands: slashCommands,
    qwen_code_version: config.getCliVersion() || "unknown",
    agents: agentNames
  };
  return systemMessage;
}
__name(buildSystemMessage, "buildSystemMessage");
function isMcpToolProgressData(output) {
  return typeof output === "object" && output !== null && "type" in output && output.type === "mcp_tool_progress";
}
__name(isMcpToolProgressData, "isMcpToolProgressData");
function createToolProgressHandler(request, adapter) {
  const handler = /* @__PURE__ */ __name((_callId, output) => {
    if (isMcpToolProgressData(output) || isShellProgressData(output)) {
      adapter.emitToolProgress(request, output);
    }
  }, "handler");
  return { handler };
}
__name(createToolProgressHandler, "createToolProgressHandler");
function createAgentToolProgressHandler(config, agentToolCallId, adapter) {
  const previousTaskStates = /* @__PURE__ */ new Map();
  const emittedToolUseIds = /* @__PURE__ */ new Set();
  const emittedToolResultIds = /* @__PURE__ */ new Set();
  const buildRequest = /* @__PURE__ */ __name((toolCall) => ({
    callId: toolCall.callId,
    name: toolCall.name,
    args: toolCall.args || {},
    isClientInitiated: true,
    prompt_id: "",
    response_id: void 0
  }), "buildRequest");
  const buildResponse = /* @__PURE__ */ __name((toolCall) => ({
    callId: toolCall.callId,
    error: toolCall.status === "failed" ? new Error(toolCall.error || "Tool execution failed") : void 0,
    errorType: toolCall.status === "failed" ? "execution_failed" /* EXECUTION_FAILED */ : void 0,
    resultDisplay: toolCall.resultDisplay,
    responseParts: toolCall.responseParts || [],
    boundaryArtifact: toolCall.boundaryArtifact
  }), "buildResponse");
  const hasResultContent = /* @__PURE__ */ __name((toolCall) => {
    if (typeof toolCall.resultDisplay === "string" && toolCall.resultDisplay.trim().length > 0) {
      return true;
    }
    if (toolCall.responseParts && toolCall.responseParts.length > 0) {
      return true;
    }
    return toolCall.status === "failed";
  }, "hasResultContent");
  const emitToolUseIfNeeded = /* @__PURE__ */ __name((toolCall, fallbackStatus) => {
    if (emittedToolUseIds.has(toolCall.callId)) {
      return;
    }
    const toolCallToEmit = fallbackStatus ? {
      ...toolCall,
      status: fallbackStatus
    } : toolCall;
    if (toolCallToEmit.status === "executing" || toolCallToEmit.status === "awaiting_approval") {
      if (adapter.processSubagentToolCall) {
        adapter.processSubagentToolCall(toolCallToEmit, agentToolCallId);
        emittedToolUseIds.add(toolCall.callId);
      }
    }
  }, "emitToolUseIfNeeded");
  const emitToolResultIfNeeded = /* @__PURE__ */ __name((toolCall) => {
    if (emittedToolResultIds.has(toolCall.callId)) {
      return;
    }
    if (!hasResultContent(toolCall)) {
      return;
    }
    emittedToolResultIds.add(toolCall.callId);
    const request = buildRequest(toolCall);
    const response = buildResponse(toolCall);
    if ("emitToolResult" in adapter && typeof adapter.emitToolResult === "function") {
      adapter.emitToolResult(request, response, agentToolCallId);
    } else {
      adapter.emitToolResult(request, response);
    }
  }, "emitToolResultIfNeeded");
  const processToolCall = /* @__PURE__ */ __name((toolCall, previousCall) => {
    const isCompleted = toolCall.status === "success" || toolCall.status === "failed";
    const isExecuting = toolCall.status === "executing" || toolCall.status === "awaiting_approval";
    const wasExecuting = previousCall && (previousCall.status === "executing" || previousCall.status === "awaiting_approval");
    if (isExecuting) {
      emitToolUseIfNeeded(toolCall);
    } else if (isCompleted && !emittedToolUseIds.has(toolCall.callId)) {
      emitToolUseIfNeeded(toolCall, "executing");
    } else if (wasExecuting && isCompleted) {
      emitToolUseIfNeeded(toolCall, "executing");
    }
    if (isCompleted) {
      emitToolResultIfNeeded(toolCall);
    }
  }, "processToolCall");
  const outputUpdateHandler = /* @__PURE__ */ __name((callId, outputChunk) => {
    if (typeof outputChunk === "object" && outputChunk !== null && "type" in outputChunk && outputChunk.type === "task_execution") {
      const taskDisplay = outputChunk;
      const previous = previousTaskStates.get(callId);
      if (!adapter.processSubagentToolCall || !adapter.emitSubagentErrorResult) {
        previousTaskStates.set(callId, taskDisplay);
        return;
      }
      if (taskDisplay.toolCalls) {
        if (!previous || !previous.toolCalls) {
          for (const toolCall of taskDisplay.toolCalls) {
            processToolCall(toolCall);
          }
        } else {
          for (const toolCall of taskDisplay.toolCalls) {
            const previousCall = previous.toolCalls.find(
              (tc) => tc.callId === toolCall.callId
            );
            processToolCall(toolCall, previousCall);
          }
        }
      }
      if (taskDisplay.status === "failed" || taskDisplay.status === "cancelled") {
        const previousStatus = previous?.status;
        if (previousStatus !== "failed" && previousStatus !== "cancelled" && previousStatus !== void 0) {
          const errorMessage2 = taskDisplay.terminateReason || (taskDisplay.status === "cancelled" ? "Task was cancelled" : "Task execution failed");
          adapter.emitSubagentErrorResult(errorMessage2, 0, agentToolCallId);
        }
      }
      if (!previous && taskDisplay.taskPrompt && !config.isInteractive() && (config.getOutputFormat() === "json" /* JSON */ || config.getOutputFormat() === "stream-json" /* STREAM_JSON */)) {
        adapter.emitUserMessage(
          [{ text: taskDisplay.taskPrompt }],
          agentToolCallId
        );
      }
      previousTaskStates.set(callId, taskDisplay);
    }
  }, "outputUpdateHandler");
  return {
    handler: outputUpdateHandler
  };
}
__name(createAgentToolProgressHandler, "createAgentToolProgressHandler");
function functionResponsePartsToString(parts) {
  return parts.map((part) => {
    if ("functionResponse" in part) {
      const response = part.functionResponse?.response;
      const content = response?.["output"] ?? response?.["error"] ?? "";
      return content;
    }
    return JSON.stringify(part);
  }).join("");
}
__name(functionResponsePartsToString, "functionResponsePartsToString");

export {
  MAX_STACKED_SKILLS,
  isStackedSkillCompletableCommand,
  isValidStackedSkillPrefix,
  parseSlashCommand,
  parseStackedSlashCommands,
  CommandService,
  formatApprovalModeName,
  formatApprovalModeDescription,
  isCrossSessionMessagingEnabled,
  isCrossSessionMessagingOptedIn,
  hasBlockingBackgroundWork,
  resetBackgroundStateForSessionSwitch,
  buildBackgroundWorkBlockedMessage,
  CONTEXT_FILES_ANNOUNCEMENT_PREFIX,
  isContextFilesAnnouncement,
  isAtCommand,
  SLASH_COMMANDS_SKIP_RECORDING,
  getSlashCommandFirstToken,
  hasSlashCommandPathSeparator,
  isSlashCommand,
  isBtwCommand,
  consumesContextAnnouncementLatch,
  copyToClipboard,
  isMidInputCompletableCommand,
  findMidInputSlashCommand,
  getBestSlashCommandMatch,
  findSlashCommandTokens,
  formatEffortChangeMessage,
  getHookShortDescription,
  getTranslatedSourceDisplayMap,
  DISPLAY_HOOK_EVENTS,
  supportsMatchers,
  createEmptyHookEventInfo,
  normalizeMatcher,
  addConfigToMatcherGroup,
  getAllConfigs,
  recordDaemonSessionModel,
  restoreSessionModelThenAuthenticate,
  isPickerOnlyModelInvocation,
  loadSessionOutputStyles,
  resolveOutputStyleChoice,
  applyOutputStyleSelection,
  quitCommand,
  refreshExtensionContentRuntime,
  pLimit,
  dayKey,
  parseDayKey,
  BuiltinCommandLoader,
  BundledSkillLoader,
  FileCommandLoader,
  SavedWorkflowLoader,
  McpPromptLoader,
  recordAutoSkillCommandUsage,
  SkillCommandLoader,
  appendUserPromptExpansionAdditionalContext,
  serializeUserPromptExpansionPrompt,
  formatUserPromptExpansionBlockedMessage,
  handleSlashCommand,
  getAvailableCommands,
  extractPartsFromUserMessage,
  computeUsageFromMetrics,
  buildInitialSystemReminders,
  insertAfterFunctionResponses,
  buildSystemMessage,
  createToolProgressHandler,
  createAgentToolProgressHandler,
  functionResponsePartsToString
};
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */
