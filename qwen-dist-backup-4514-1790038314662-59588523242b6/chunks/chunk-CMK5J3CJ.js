// Force strict mode and setup for ESM
"use strict";
import {
  t
} from "./chunk-POMFSBEC.js";
import {
  SessionReferenceService,
  readManyFiles
} from "./chunk-47GVX3K4.js";
import {
  emptyMcpResourceText,
  formatMcpResourceContents,
  summarizeMcpResource
} from "./chunk-ZPJWUGCS.js";
import {
  SessionService
} from "./chunk-MRTRBONQ.js";
import {
  qualifySkillName,
  stripTerminalControlSequences
} from "./chunk-IMV5DBIP.js";
import {
  shouldRunVisionBridge
} from "./chunk-KKGSJZWK.js";
import {
  Storage,
  isSubpath,
  unescapePath,
  unescapeShellSpecials
} from "./chunk-ZYDMQCQP.js";
import {
  getErrorMessage,
  isNodeError
} from "./chunk-S34QJ6IR.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/ui/hooks/atCommandProcessor.ts
init_esbuild_shims();
import * as fs2 from "node:fs/promises";
import * as path from "node:path";

// packages/cli/src/ui/hooks/mcpResourceRef.ts
init_esbuild_shims();
function matchMcpServerPrefix(input, serverNames) {
  let serverName = null;
  for (const name of serverNames) {
    if (input.startsWith(`${name}:`) && (serverName === null || name.length > serverName.length)) {
      serverName = name;
    }
  }
  if (serverName === null) return null;
  return { serverName, rest: input.slice(serverName.length + 1) };
}
__name(matchMcpServerPrefix, "matchMcpServerPrefix");
function buildMcpResourceRef(serverName, uri) {
  return `${serverName}:${uri}`;
}
__name(buildMcpResourceRef, "buildMcpResourceRef");

// packages/cli/src/ui/hooks/extension-mention-ref.ts
init_esbuild_shims();

// packages/cli/src/ui/utils/suggestions.ts
init_esbuild_shims();
var MAX_SUGGESTIONS_TO_SHOW = 8;
function normalizeDescription(description) {
  return description.replace(/\s+/g, " ").trim();
}
__name(normalizeDescription, "normalizeDescription");

// packages/cli/src/utils/extension-mention.ts
init_esbuild_shims();
import * as fs from "node:fs/promises";
var EXTENSION_REF_PREFIX = "ext:";
var EXTENSION_CONTEXT_BUDGET = 2e5;
var EXTENSION_CONTEXT_FILE_CAP = 5e4;
function parseExtensionRef(pathName) {
  if (!pathName.startsWith(EXTENSION_REF_PREFIX)) return null;
  const name = pathName.slice(EXTENSION_REF_PREFIX.length);
  if (!name) return null;
  return { name };
}
__name(parseExtensionRef, "parseExtensionRef");
function buildExtensionRef(extensionName) {
  return `${EXTENSION_REF_PREFIX}${extensionName}`;
}
__name(buildExtensionRef, "buildExtensionRef");
function matchExtensionByRef(name, extensions) {
  const lower = name.toLowerCase();
  return extensions.find(
    (ext) => ext.name.toLowerCase() === lower || ext.config.name.toLowerCase() === lower
  );
}
__name(matchExtensionByRef, "matchExtensionByRef");
var BIDI_CONTROL_RE = /[‎‏؜⁦⁧⁨⁩‪‫‬‭‮]/g;
function sanitizeDisplayText(raw) {
  const stripped = stripTerminalControlSequences(raw).replace(BIDI_CONTROL_RE, "").replace(/\s+/g, " ").trim();
  return stripped.length > 0 ? stripped : null;
}
__name(sanitizeDisplayText, "sanitizeDisplayText");
function getSanitizedExtensionDisplayName(extension) {
  return sanitizeDisplayText(extension.displayName || extension.name) || extension.name;
}
__name(getSanitizedExtensionDisplayName, "getSanitizedExtensionDisplayName");
function buildExtensionContextText(extension) {
  const displayName = getSanitizedExtensionDisplayName(extension);
  const lines = [];
  lines.push(
    `--- Extension: ${displayName} (untrusted third-party content) ---`
  );
  if (extension.config.description) {
    const desc = sanitizeDisplayText(extension.config.description);
    if (desc) {
      lines.push(desc);
      lines.push("");
    }
  }
  const capabilities = [];
  if (extension.skills && extension.skills.length > 0) {
    const skillNames = extension.skills.map(
      (s) => sanitizeDisplayText(qualifySkillName(extension.name, s.name)) || s.name
    ).join(", ");
    capabilities.push(`- Skills: ${skillNames} (invoke via /<skill-name>)`);
  }
  if (extension.mcpServers && Object.keys(extension.mcpServers).length > 0) {
    const serverNames = Object.keys(extension.mcpServers).map((n) => sanitizeDisplayText(n) || n).join(", ");
    capabilities.push(`- MCP Servers: ${serverNames}`);
  }
  if (extension.agents && extension.agents.length > 0) {
    const agentNames = extension.agents.map((a) => sanitizeDisplayText(a.name) || a.name).join(", ");
    capabilities.push(`- Agents: ${agentNames}`);
  }
  if (capabilities.length > 0) {
    lines.push("Available capabilities from this extension:");
    lines.push(...capabilities);
    lines.push("");
  }
  lines.push(`--- End Extension: ${displayName} ---`);
  return lines.join("\n");
}
__name(buildExtensionContextText, "buildExtensionContextText");
async function buildExtensionMentionContext(extension, options) {
  let contextText = buildExtensionContextText(extension);
  let remainingBudget = options.remainingBudget;
  if (extension.contextFiles.length === 0) {
    return { text: contextText, remainingBudget };
  }
  const fileReads = await Promise.allSettled(
    extension.contextFiles.map(async (contextFilePath) => {
      let realPath;
      let realExtPath;
      try {
        realPath = await fs.realpath(contextFilePath);
        realExtPath = await fs.realpath(extension.path);
      } catch {
        options.onDebugMessage?.(
          `Skipping unreadable context file: ${contextFilePath}`
        );
        return null;
      }
      if (!isSubpath(realExtPath, realPath)) {
        options.onDebugMessage?.(
          `Skipping context file outside extension directory: ${contextFilePath}`
        );
        return null;
      }
      return fs.readFile(realPath, {
        encoding: "utf-8",
        signal: options.signal
      });
    })
  );
  for (let i = 0; i < fileReads.length; i++) {
    const outcome = fileReads[i];
    if (outcome.status === "rejected") {
      options.onDebugMessage?.(
        `Failed to read extension context file ${extension.contextFiles[i]}: ${getErrorMessage(outcome.reason)}`
      );
      continue;
    }
    const content = outcome.value;
    if (!content || !content.trim()) continue;
    if (remainingBudget <= 0) {
      options.onDebugMessage?.(
        "Extension context budget exhausted, skipping remaining files."
      );
      break;
    }
    const cap = Math.min(EXTENSION_CONTEXT_FILE_CAP, remainingBudget);
    const cappedContent = content.length > cap ? content.slice(0, cap) + "\n... (truncated)" : content;
    contextText += `

${cappedContent}`;
    remainingBudget -= cappedContent.length;
  }
  return { text: contextText, remainingBudget };
}
__name(buildExtensionMentionContext, "buildExtensionMentionContext");

// packages/cli/src/ui/hooks/extension-mention-ref.ts
function getExtensionSuggestions(config, pattern) {
  if (!config) return [];
  if (config.isTrustedFolder?.() === false) return [];
  const extensions = config.getActiveExtensions?.() ?? [];
  if (extensions.length === 0) return [];
  const query = pattern.toLowerCase();
  return extensions.map((ext) => ({
    ext,
    safeLabel: sanitizeDisplayText(ext.displayName || ext.name) || ext.name
  })).filter(({ safeLabel, ext }) => {
    const label = safeLabel.toLowerCase();
    const name = ext.name.toLowerCase();
    return label.includes(query) || name.includes(query);
  }).sort((a, b) => {
    const aName = a.safeLabel.toLowerCase();
    const bName = b.safeLabel.toLowerCase();
    const aPrefix = aName.startsWith(query) ? 0 : 1;
    const bPrefix = bName.startsWith(query) ? 0 : 1;
    if (aPrefix !== bPrefix) return aPrefix - bPrefix;
    return aName.localeCompare(bName);
  }).slice(0, MAX_SUGGESTIONS_TO_SHOW).map(({ ext, safeLabel }) => ({
    label: safeLabel,
    value: buildExtensionRef(ext.name),
    description: ext.config.description ? sanitizeDisplayText(ext.config.description) ?? void 0 : void 0,
    sourceBadge: t("Extension"),
    isDirectory: false,
    category: "extension"
  }));
}
__name(getExtensionSuggestions, "getExtensionSuggestions");

// packages/cli/src/ui/hooks/session-mention-ref.ts
init_esbuild_shims();
var SESSION_MENTION_PREFIX = "session:";
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isSessionId(value) {
  return UUID_RE.test(value.trim());
}
__name(isSessionId, "isSessionId");
function parseSessionRef(pathName) {
  if (!pathName.startsWith(SESSION_MENTION_PREFIX)) return null;
  const rawRemainder = pathName.slice(SESSION_MENTION_PREFIX.length).trim();
  const remainder = process.platform === "win32" ? unescapeShellSpecials(rawRemainder) : rawRemainder;
  if (remainder.length === 0) return null;
  return isSessionId(remainder) ? { id: remainder } : { title: remainder };
}
__name(parseSessionRef, "parseSessionRef");
function buildSessionRef(idOrTitle) {
  return `${SESSION_MENTION_PREFIX}${idOrTitle}`;
}
__name(buildSessionRef, "buildSessionRef");

// packages/cli/src/utils/mcp-server-mention.ts
init_esbuild_shims();
var MCP_SERVER_REF_PREFIX = "mcp:";
function parseMcpServerRef(pathName) {
  if (!pathName.startsWith(MCP_SERVER_REF_PREFIX)) return null;
  const name = pathName.slice(MCP_SERVER_REF_PREFIX.length);
  if (!name) return null;
  return { name };
}
__name(parseMcpServerRef, "parseMcpServerRef");
function buildMcpServerRef(serverName) {
  return `${MCP_SERVER_REF_PREFIX}${serverName}`;
}
__name(buildMcpServerRef, "buildMcpServerRef");
function matchMcpServerByRef(name, servers) {
  const lower = name.toLowerCase();
  const matchedName = Object.keys(servers).find(
    (serverName) => serverName.toLowerCase() === lower
  );
  if (!matchedName) return void 0;
  return { serverName: matchedName, server: servers[matchedName] };
}
__name(matchMcpServerByRef, "matchMcpServerByRef");
function buildMcpServerContextText(config, serverName) {
  const lines = [
    `--- MCP Server: ${serverName} ---`,
    `The user explicitly mentioned this MCP server. Prefer using tools and resources from this server when relevant for this turn. This is advisory context, not a hard restriction.`
  ];
  const prompts = config.getPromptRegistry?.()?.getPromptsByServer(serverName) ?? [];
  const resources = config.getResourceRegistry?.()?.getResourcesByServer(serverName) ?? [];
  const details = [];
  if (resources.length > 0) {
    details.push(`- Resources: ${resources.length}`);
  }
  if (prompts.length > 0) {
    details.push(`- Prompts: ${prompts.length}`);
  }
  if (details.length > 0) {
    lines.push("Available capabilities from this MCP server:");
    lines.push(...details);
  }
  lines.push(`--- End MCP Server: ${serverName} ---`);
  return lines.join("\n");
}
__name(buildMcpServerContextText, "buildMcpServerContextText");

// packages/cli/src/ui/hooks/atCommandProcessor.ts
function parseAllAtCommands(query) {
  const parts = [];
  let currentIndex = 0;
  while (currentIndex < query.length) {
    let atIndex = -1;
    let nextSearchIndex = currentIndex;
    while (nextSearchIndex < query.length) {
      if (query[nextSearchIndex] === "@" && (nextSearchIndex === 0 || query[nextSearchIndex - 1] !== "\\")) {
        atIndex = nextSearchIndex;
        break;
      }
      nextSearchIndex++;
    }
    if (atIndex === -1) {
      if (currentIndex < query.length) {
        parts.push({ type: "text", content: query.substring(currentIndex) });
      }
      break;
    }
    if (atIndex > currentIndex) {
      parts.push({
        type: "text",
        content: query.substring(currentIndex, atIndex)
      });
    }
    const isUrlRef = /^https?:\/\//i.test(query.slice(atIndex + 1));
    const NON_URL_CHAR = /[^A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/;
    let pathEndIndex = atIndex + 1;
    let inEscape = false;
    while (pathEndIndex < query.length) {
      const char = query[pathEndIndex];
      if (inEscape) {
        inEscape = false;
      } else if (char === "\\") {
        inEscape = true;
      } else if (isUrlRef) {
        if (NON_URL_CHAR.test(char)) break;
      } else if (/[,\s;!?()[\]{}]/.test(char)) {
        break;
      } else if (char === ".") {
        const nextChar = pathEndIndex + 1 < query.length ? query[pathEndIndex + 1] : "";
        if (nextChar === "" || /\s/.test(nextChar)) {
          break;
        }
      }
      pathEndIndex++;
    }
    let rawAtPath = query.substring(atIndex, pathEndIndex);
    if (isUrlRef) {
      const trimmed = rawAtPath.replace(/[.,;:!?]+$/, "");
      pathEndIndex = atIndex + trimmed.length;
      rawAtPath = trimmed;
    }
    const atPath = unescapePath(rawAtPath);
    parts.push({ type: "atPath", content: atPath });
    currentIndex = pathEndIndex;
  }
  return parts.filter(
    (part) => !(part.type === "text" && part.content.trim() === "")
  );
}
__name(parseAllAtCommands, "parseAllAtCommands");
function extractAtPathCommands(query) {
  return parseAllAtCommands(query).flatMap(
    (part) => part.type === "atPath" && part.content !== "@" ? [part.content.substring(1)] : []
  );
}
__name(extractAtPathCommands, "extractAtPathCommands");
function parseMcpResourceRef(pathName, mcpServerNames) {
  const match = matchMcpServerPrefix(pathName, mcpServerNames);
  if (!match || !match.rest) return null;
  return { serverName: match.serverName, uri: match.rest };
}
__name(parseMcpResourceRef, "parseMcpResourceRef");
async function resolveAtCommandQuery({
  query,
  config,
  onDebugMessage,
  messageId: userMessageTimestamp,
  signal
}) {
  const commandParts = parseAllAtCommands(query);
  const atPathCommandParts = commandParts.filter(
    (part) => part.type === "atPath"
  );
  if (atPathCommandParts.length === 0) {
    return { processedQuery: [{ text: query }], shouldProceed: true };
  }
  const fileDiscovery = config.getFileService();
  const respectFileIgnore = config.getFileFilteringOptions();
  const configuredProjectTempDir = Storage.getGlobalTempDir();
  const projectTempDir = await fs2.realpath(configuredProjectTempDir).catch(() => path.resolve(configuredProjectTempDir));
  const pathSpecsToRead = [];
  const atPathToResolvedSpecMap = /* @__PURE__ */ new Map();
  const contentLabelsForDisplay = [];
  const displayPaths = /* @__PURE__ */ new Map();
  const displayPathsByCanonicalPath = /* @__PURE__ */ new Map();
  const ignoredByReason = {
    git: [],
    qwen: [],
    both: []
  };
  const getIgnoreReason = /* @__PURE__ */ __name((candidate) => {
    const gitIgnored = respectFileIgnore.respectGitIgnore && fileDiscovery.shouldIgnoreFile(candidate, {
      respectGitIgnore: true,
      respectQwenIgnore: false
    });
    const qwenIgnored = respectFileIgnore.respectQwenIgnore && fileDiscovery.shouldIgnoreFile(candidate, {
      respectGitIgnore: false,
      respectQwenIgnore: true
    });
    return gitIgnored && qwenIgnored ? "both" : gitIgnored ? "git" : qwenIgnored ? "qwen" : void 0;
  }, "getIgnoreReason");
  const mcpServerNames = new Set(Object.keys(config.getMcpServers() || {}));
  const mcpResourceRefs = [];
  const mcpServerMentions = [];
  const activeExtensions = config.getActiveExtensions?.() ?? [];
  const extensionMentions = [];
  const sessionMentions = [];
  const urlMediaRefs = [];
  const rememberedMediaRefs = [];
  for (const atPathPart of atPathCommandParts) {
    const originalAtPath = atPathPart.content;
    if (originalAtPath === "@") {
      onDebugMessage(
        "Lone @ detected, will be treated as text in the modified query."
      );
      continue;
    }
    const pathName = originalAtPath.substring(1);
    if (/^https?:\/\//i.test(pathName) && config.isOmniEnabled?.()) {
      const omni = await import("./omni-OCJZUDVR.js");
      if (omni.isOmniDeliveryActive(config) && omni.parseHttpUrlRef(pathName)) {
        if (!urlMediaRefs.some((r) => r.url === pathName)) {
          urlMediaRefs.push({ originalAtPath, url: pathName });
        }
        atPathToResolvedSpecMap.set(originalAtPath, pathName);
        continue;
      }
    }
    const extRef = parseExtensionRef(pathName);
    if (extRef) {
      const extension = matchExtensionByRef(extRef.name, activeExtensions);
      if (extension) {
        if (!extensionMentions.some((m) => m.extension.name === extension.name)) {
          extensionMentions.push({ originalAtPath, extension });
        }
        atPathToResolvedSpecMap.set(originalAtPath, pathName);
        continue;
      }
      onDebugMessage(
        `Extension "${extRef.name}" not found among active extensions. Available: ${activeExtensions.map((e) => e.name).join(", ") || "(none)"}`
      );
      continue;
    }
    const sessionRef = parseSessionRef(pathName);
    if (sessionRef) {
      if (!sessionMentions.some(
        (m) => (m.ref.id ?? m.ref.title) === (sessionRef.id ?? sessionRef.title)
      )) {
        sessionMentions.push({ originalAtPath, ref: sessionRef });
      }
      atPathToResolvedSpecMap.set(
        originalAtPath,
        buildSessionRef(sessionRef.id ?? sessionRef.title)
      );
      continue;
    }
    const resourceRef = parseMcpResourceRef(pathName, mcpServerNames);
    if (resourceRef) {
      mcpResourceRefs.push({ originalAtPath, ...resourceRef });
      atPathToResolvedSpecMap.set(originalAtPath, pathName);
      continue;
    }
    const mcpServerRef = parseMcpServerRef(pathName);
    if (mcpServerRef) {
      const matched = matchMcpServerByRef(
        mcpServerRef.name,
        config.getMcpServers() || {}
      );
      if (matched) {
        if (!mcpServerMentions.some((m) => m.serverName === matched.serverName)) {
          mcpServerMentions.push({
            originalAtPath,
            serverName: matched.serverName
          });
        }
        atPathToResolvedSpecMap.set(
          originalAtPath,
          buildMcpServerRef(matched.serverName)
        );
        continue;
      }
      onDebugMessage(
        `MCP server "${mcpServerRef.name}" not found among configured MCP servers. Available: ${Object.keys(config.getMcpServers() || {}).join(", ") || "(none)"}`
      );
      continue;
    }
    const workspaceContext = config.getWorkspaceContext();
    const absolutePathName = path.isAbsolute(pathName) ? pathName : path.resolve(workspaceContext.getDirectories()[0] || "", pathName);
    if (!isSubpath(configuredProjectTempDir, absolutePathName) && !isSubpath(projectTempDir, absolutePathName) && !workspaceContext.isPathWithinWorkspace(pathName)) {
      onDebugMessage(
        `Path ${pathName} is not in the workspace and will be skipped.`
      );
      continue;
    }
    const ignoredReason = getIgnoreReason(pathName);
    if (ignoredReason) {
      const reason = ignoredReason;
      ignoredByReason[reason].push(pathName);
      const reasonText = reason === "both" ? "ignored by both git and qwen" : reason === "git" ? "git-ignored" : "qwen-ignored";
      onDebugMessage(`Path ${pathName} is ${reasonText} and will be skipped.`);
      continue;
    }
    let resolvedSuccessfully = false;
    let sawNotFound = false;
    let deferredIgnoreReason;
    for (const dir of config.getWorkspaceContext().getDirectories()) {
      try {
        const absolutePath = path.resolve(dir, pathName);
        const canonicalPath = await fs2.realpath(absolutePath);
        const stats = await fs2.stat(canonicalPath);
        if (!isSubpath(configuredProjectTempDir, canonicalPath) && !isSubpath(projectTempDir, canonicalPath) && !workspaceContext.isPathWithinWorkspace(canonicalPath)) {
          onDebugMessage(
            `Path ${pathName} is not in the workspace and will be skipped.`
          );
          continue;
        }
        const canonicalIgnoreReason = getIgnoreReason(canonicalPath);
        if (canonicalIgnoreReason) {
          deferredIgnoreReason = canonicalIgnoreReason;
          const reasonText = canonicalIgnoreReason === "both" ? "ignored by both git and qwen" : canonicalIgnoreReason === "git" ? "git-ignored" : "qwen-ignored";
          onDebugMessage(
            `Path ${pathName} is ${reasonText} and will be skipped.`
          );
          continue;
        }
        if (stats.isDirectory()) {
          onDebugMessage(`Path ${pathName} resolved to directory.`);
        } else {
          onDebugMessage(`Path ${pathName} resolved to file: ${absolutePath}`);
        }
        pathSpecsToRead.push(canonicalPath);
        atPathToResolvedSpecMap.set(originalAtPath, pathName);
        contentLabelsForDisplay.push(pathName);
        displayPaths.set(canonicalPath, pathName);
        const canonicalDisplays = displayPathsByCanonicalPath.get(canonicalPath) ?? /* @__PURE__ */ new Set();
        canonicalDisplays.add(pathName);
        displayPathsByCanonicalPath.set(canonicalPath, canonicalDisplays);
        resolvedSuccessfully = true;
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          sawNotFound = true;
          continue;
        } else {
          onDebugMessage(
            `Error stating path ${pathName}: ${getErrorMessage(error)}. Path ${pathName} will be skipped.`
          );
        }
      }
      if (resolvedSuccessfully) {
        break;
      }
    }
    if (!resolvedSuccessfully && sawNotFound) {
      let reanchored = false;
      if (config.isOmniEnabled?.()) {
        const { reanchorRememberedMedia } = await import("./omni-OCJZUDVR.js");
        for (const dir of config.getWorkspaceContext().getDirectories()) {
          const anchor = await reanchorRememberedMedia(
            config,
            path.resolve(dir, pathName)
          );
          if (!anchor) continue;
          rememberedMediaRefs.push({
            originalAtPath,
            pathName,
            annotation: anchor.annotation
          });
          atPathToResolvedSpecMap.set(originalAtPath, pathName);
          onDebugMessage(
            `Path ${pathName} is gone but remembered; re-anchored as ${anchor.resourceId} (bytes unavailable).`
          );
          reanchored = true;
          break;
        }
      }
      if (!reanchored) {
        onDebugMessage(
          `Path ${pathName} not found. Path ${pathName} will be skipped.`
        );
      }
    }
    if (!resolvedSuccessfully && deferredIgnoreReason) {
      ignoredByReason[deferredIgnoreReason].push(pathName);
    }
  }
  const buildInitialQueryText = /* @__PURE__ */ __name(() => {
    let text = "";
    for (let i = 0; i < commandParts.length; i++) {
      const part = commandParts[i];
      if (part.type === "text") {
        text += part.content;
      } else {
        const resolvedSpec = atPathToResolvedSpecMap.get(part.content);
        if (i > 0 && text.length > 0 && !text.endsWith(" ")) {
          const prevPart = commandParts[i - 1];
          if (prevPart.type === "text" || prevPart.type === "atPath") {
            text += " ";
          }
        }
        if (resolvedSpec) {
          text += `@${resolvedSpec}`;
        } else {
          if (i > 0 && text.length > 0 && !text.endsWith(" ") && !part.content.startsWith(" ")) {
            text += " ";
          }
          text += part.content;
        }
      }
    }
    return text.trim();
  }, "buildInitialQueryText");
  let initialQueryText = buildInitialQueryText();
  const totalIgnored = ignoredByReason["git"].length + ignoredByReason["qwen"].length + ignoredByReason["both"].length;
  if (totalIgnored > 0) {
    const messages = [];
    if (ignoredByReason["git"].length) {
      messages.push(`Git-ignored: ${ignoredByReason["git"].join(", ")}`);
    }
    if (ignoredByReason["qwen"].length) {
      messages.push(`Qwen-ignored: ${ignoredByReason["qwen"].join(", ")}`);
    }
    if (ignoredByReason["both"].length) {
      messages.push(`Ignored by both: ${ignoredByReason["both"].join(", ")}`);
    }
    const message = `Ignored ${totalIgnored} files:
${messages.join("\n")}`;
    onDebugMessage(message);
  }
  const resourceReads = await Promise.allSettled(
    mcpResourceRefs.map(
      (ref) => config.getToolRegistry().readMcpResource(ref.serverName, ref.uri, { signal })
    )
  );
  const urlMediaParts = [];
  const urlMediaDisplays = [];
  const urlMediaLabels = [];
  if (urlMediaRefs.length > 0) {
    const core = await import("./omni-OCJZUDVR.js");
    for (let i = 0; i < urlMediaRefs.length; i++) {
      const ref = urlMediaRefs[i];
      const callId = `client-url-media-${userMessageTimestamp}-${i}`;
      const hostLabel = (() => {
        try {
          return new URL(ref.url).hostname;
        } catch {
          return "invalid-url";
        }
      })();
      let tempPartPath;
      try {
        const store = new core.OmniObjectStore(config.storage.getQwenDir());
        const downloadsDir = path.join(store.getOmniRootDir(), "downloads");
        const downloaded = await core.downloadMediaUrl({
          url: ref.url,
          downloadsDir,
          maxBytes: core.effectiveMaxDownloadFileBytes(config),
          signal
        });
        tempPartPath = downloaded.partPath;
        const urlBase = path.basename(new URL(ref.url).pathname) || hostLabel;
        const modalities = config.getContentGeneratorConfig?.()?.modalities ?? {};
        const sniffedModality = await core.sniffFileModality(
          downloaded.partPath
        );
        if (sniffedModality && !modalities[sniffedModality]) {
          urlMediaDisplays.push({
            callId,
            name: "Fetch Media URL",
            description: `Download ${ref.url}`,
            status: "Error" /* Error */,
            resultDisplay: `Skipped ${urlBase}: the active model does not accept ${sniffedModality} input.`,
            confirmationDetails: void 0
          });
          continue;
        }
        const delivery = await core.processMediaForOmniDelivery(
          downloaded.partPath,
          config,
          // displayName: guard/error messages must name the URL's file, not
          // the opaque staging path the download landed under. sourceUrl:
          // the staging path is deleted in the finally below, so memory
          // must anchor this media's identity to the object store and
          // record the URL as its source — a handle bound to the staging
          // path would resolve to ENOENT for the rest of the session.
          { signal, displayName: urlBase, sourceUrl: ref.url }
        );
        const transcriptParts = core.buildTranscriptParts(
          urlBase,
          delivery.transcripts
        );
        const additionalParts = core.buildAdditionalMediaParts(
          urlBase,
          delivery.additionalMedia
        );
        const handleParts = delivery.resourceId ? [
          {
            text: core.formatResourceHandleText(
              urlBase,
              delivery.resourceId
            )
          }
        ] : [];
        if (delivery.omission) {
          urlMediaParts.push(...handleParts);
          urlMediaParts.push({
            text: core.formatOmissionText(urlBase, delivery.omission.reason)
          });
          urlMediaParts.push(...additionalParts);
          urlMediaParts.push(...transcriptParts);
          urlMediaLabels.push(ref.url);
          urlMediaDisplays.push({
            callId,
            name: "Fetch Media URL",
            description: `Downloaded ${ref.url}`,
            status: "Success" /* Success */,
            resultDisplay: `Media omitted by the omni transport guard: ${urlBase}`,
            confirmationDetails: void 0
          });
          continue;
        }
        if (!delivery.fileUri && transcriptParts.length > 0) {
          urlMediaParts.push(...handleParts);
          if (delivery.disclosure) {
            urlMediaParts.push({
              text: core.formatDisclosureText(urlBase, delivery.disclosure)
            });
          }
          urlMediaParts.push(...additionalParts);
          urlMediaParts.push(...transcriptParts);
          urlMediaLabels.push(ref.url);
          urlMediaDisplays.push({
            callId,
            name: "Fetch Media URL",
            description: `Downloaded ${ref.url}`,
            status: "Success" /* Success */,
            resultDisplay: `Localized ${urlBase} and delivered as transcript (omni policy).`,
            confirmationDetails: void 0
          });
          continue;
        }
        urlMediaParts.push(...handleParts);
        if (delivery.disclosure) {
          urlMediaParts.push({
            text: core.formatDisclosureText(urlBase, delivery.disclosure)
          });
        }
        urlMediaParts.push({
          fileData: {
            fileUri: delivery.fileUri,
            mimeType: delivery.mimeType,
            displayName: urlBase
          }
        });
        urlMediaParts.push(...additionalParts);
        urlMediaParts.push(...transcriptParts);
        urlMediaLabels.push(ref.url);
        urlMediaDisplays.push({
          callId,
          name: "Fetch Media URL",
          description: `Downloaded ${ref.url}`,
          status: "Success" /* Success */,
          resultDisplay: `Localized ${urlBase} (${delivery.recognized.modality}, ${(delivery.recognized.sizeBytes / 1024 / 1024).toFixed(1)}MB) and delivered via omni upload${delivery.degraded ? " (degraded by media policy)" : ""}.`,
          confirmationDetails: void 0
        });
      } catch (error) {
        if (signal.aborted) {
          if (tempPartPath) {
            await fs2.rm(tempPartPath, { force: true }).catch(() => {
            });
          }
          return {
            processedQuery: null,
            shouldProceed: false,
            toolDisplays: [...urlMediaDisplays],
            filesRead: urlMediaLabels
            // No chat-recording entry for a user-cancelled resolution.
          };
        }
        const reason = getErrorMessage(error);
        onDebugMessage(`Failed to localize media URL ${ref.url}: ${reason}`);
        urlMediaDisplays.push({
          callId,
          name: "Fetch Media URL",
          description: `Download ${ref.url}`,
          status: "Error" /* Error */,
          resultDisplay: `Failed to fetch media from ${hostLabel}: ${reason}`,
          confirmationDetails: void 0
        });
      } finally {
        if (tempPartPath) {
          await fs2.rm(tempPartPath, { force: true }).catch(() => {
          });
        }
      }
    }
  }
  const resourceParts = [];
  const resourceDisplays = [];
  const resourceLabels = [];
  for (let i = 0; i < mcpResourceRefs.length; i++) {
    const ref = mcpResourceRefs[i];
    const label = `${ref.serverName}:${ref.uri}`;
    const callId = `client-mcp-resource-${userMessageTimestamp}-${i}`;
    const outcome = resourceReads[i];
    if (outcome.status === "rejected") {
      onDebugMessage(
        `Failed to read MCP resource ${label}: ${getErrorMessage(outcome.reason)}`
      );
      resourceDisplays.push({
        callId,
        name: "Read MCP Resource",
        description: `Read resource ${label}`,
        status: "Error" /* Error */,
        resultDisplay: `Failed to read resource ${label}: ${getErrorMessage(outcome.reason)}`,
        confirmationDetails: void 0
      });
      continue;
    }
    const formatted = formatMcpResourceContents(outcome.value, label);
    if (formatted.parts.length > 0) {
      resourceParts.push(...formatted.parts);
    } else {
      resourceParts.push({ text: emptyMcpResourceText(formatted, label) });
    }
    resourceLabels.push(label);
    resourceDisplays.push({
      callId,
      name: "Read MCP Resource",
      description: `Read resource ${label}`,
      status: "Success" /* Success */,
      resultDisplay: summarizeMcpResource(formatted),
      confirmationDetails: void 0
    });
  }
  if (pathSpecsToRead.length === 0 && mcpResourceRefs.length === 0 && mcpServerMentions.length === 0 && extensionMentions.length === 0 && sessionMentions.length === 0 && // URL media refs count as content too: without this, a URL-only prompt
  // would run the whole download→upload pipeline and then discard the
  // delivered parts (and their display cards) via this early return.
  urlMediaRefs.length === 0) {
    onDebugMessage("No valid file paths found in @ commands to read.");
    if (initialQueryText === "@" && query.trim() === "@") {
      return { processedQuery: [{ text: query }], shouldProceed: true };
    } else if (!initialQueryText && query) {
      return { processedQuery: [{ text: query }], shouldProceed: true };
    }
    return {
      processedQuery: [{ text: initialQueryText || query }],
      shouldProceed: true
    };
  }
  let extensionContextBudgetRemaining = EXTENSION_CONTEXT_BUDGET;
  const scopedMentionEntries = [];
  for (let i = 0; i < extensionMentions.length; i++) {
    const { originalAtPath, extension } = extensionMentions[i];
    const displayName = getSanitizedExtensionDisplayName(extension);
    const callId = `client-extension-${userMessageTimestamp}-${i}`;
    const context = await buildExtensionMentionContext(extension, {
      remainingBudget: extensionContextBudgetRemaining,
      signal,
      onDebugMessage
    });
    extensionContextBudgetRemaining = context.remainingBudget;
    scopedMentionEntries.push({
      originalAtPath,
      part: { text: context.text },
      label: buildExtensionRef(extension.name),
      display: {
        callId,
        name: "Activate Extension",
        description: `Activated extension ${displayName}`,
        status: "Success" /* Success */,
        resultDisplay: void 0,
        confirmationDetails: void 0
      }
    });
  }
  for (let i = 0; i < mcpServerMentions.length; i++) {
    const { originalAtPath, serverName } = mcpServerMentions[i];
    scopedMentionEntries.push({
      originalAtPath,
      part: { text: buildMcpServerContextText(config, serverName) },
      label: buildMcpServerRef(serverName),
      display: {
        callId: `client-mcp-server-${userMessageTimestamp}-${i}`,
        name: "Activate MCP Server",
        description: `Activated MCP server ${serverName}`,
        status: "Success" /* Success */,
        resultDisplay: void 0,
        confirmationDetails: void 0
      }
    });
  }
  const resolvedSessionIds = /* @__PURE__ */ new Set();
  for (let i = 0; i < sessionMentions.length; i++) {
    const { originalAtPath, ref } = sessionMentions[i];
    const callId = `client-session-${userMessageTimestamp}-${i}`;
    let sessionId = ref.id;
    if (!sessionId && ref.title) {
      let matches = [];
      try {
        matches = await new SessionService(
          config.getProjectRoot()
        ).findSessionsByTitle(ref.title);
      } catch (error) {
        const reason = `Could not look up sessions matching "@${originalAtPath.substring(1)}" (${getErrorMessage(error)}); try a session id instead.`;
        onDebugMessage(reason);
        scopedMentionEntries.push({
          originalAtPath,
          part: { text: "" },
          label: buildSessionRef(ref.title ?? originalAtPath),
          display: {
            callId,
            name: "Referenced Session",
            description: `Reference session "${ref.title ?? ""}"`,
            status: "Error" /* Error */,
            resultDisplay: reason,
            confirmationDetails: void 0
          }
        });
        continue;
      }
      if (matches.length === 1) {
        sessionId = matches[0].sessionId;
      } else {
        const reason = matches.length === 0 ? `No session matches "@${originalAtPath.substring(1)}".` : `"@${originalAtPath.substring(1)}" is ambiguous (${matches.length} matches); use the picker or a session id.`;
        onDebugMessage(reason);
        scopedMentionEntries.push({
          originalAtPath,
          part: { text: "" },
          label: buildSessionRef(ref.title),
          display: {
            callId,
            name: "Referenced Session",
            description: `Reference session "${ref.title}"`,
            status: "Error" /* Error */,
            resultDisplay: reason,
            confirmationDetails: void 0
          }
        });
        continue;
      }
    }
    if (!sessionId) {
      const reason = `Session reference "@${originalAtPath.substring(1)}" could not be resolved.`;
      onDebugMessage(reason);
      scopedMentionEntries.push({
        originalAtPath,
        part: { text: "" },
        label: buildSessionRef(ref.title ?? ref.id ?? originalAtPath),
        display: {
          callId,
          name: "Referenced Session",
          description: `Reference session "${ref.title ?? ref.id ?? ""}"`,
          status: "Error" /* Error */,
          resultDisplay: reason,
          confirmationDetails: void 0
        }
      });
      continue;
    }
    if (resolvedSessionIds.has(sessionId)) {
      onDebugMessage(
        `Session reference "@${originalAtPath.substring(1)}" resolves to session ${sessionId}, which was already referenced; skipping duplicate.`
      );
      continue;
    }
    resolvedSessionIds.add(sessionId);
    let resolved;
    try {
      resolved = await new SessionReferenceService(
        config.getProjectRoot()
      ).resolve(sessionId, ref.title ? { title: ref.title } : {});
    } catch (error) {
      const reason = `Failed to load session "${sessionId}" (${getErrorMessage(error)}); the transcript may be corrupted or unreadable.`;
      onDebugMessage(reason);
      scopedMentionEntries.push({
        originalAtPath,
        part: { text: "" },
        label: buildSessionRef(sessionId),
        display: {
          callId,
          name: "Referenced Session",
          description: `Reference session ${sessionId}`,
          status: "Error" /* Error */,
          resultDisplay: reason,
          confirmationDetails: void 0
        }
      });
      continue;
    }
    if ("notFound" in resolved) {
      const reason = `Session "${sessionId}" not found in this project.`;
      onDebugMessage(reason);
      scopedMentionEntries.push({
        originalAtPath,
        part: { text: "" },
        label: buildSessionRef(sessionId),
        display: {
          callId,
          name: "Referenced Session",
          description: `Reference session ${sessionId}`,
          status: "Error" /* Error */,
          resultDisplay: reason,
          confirmationDetails: void 0
        }
      });
      continue;
    }
    scopedMentionEntries.push({
      originalAtPath,
      part: { text: resolved.text },
      label: buildSessionRef(sessionId),
      display: {
        callId,
        name: "Referenced Session",
        description: `Referenced session "${resolved.meta.title}"${resolved.truncated ? " (truncated)" : ""}`,
        status: "Success" /* Success */,
        resultDisplay: void 0,
        confirmationDetails: void 0
      }
    });
  }
  const scopedMentionOrder = new Map(
    atPathCommandParts.map((part, index) => [part.content, index])
  );
  scopedMentionEntries.sort(
    (a, b) => (scopedMentionOrder.get(a.originalAtPath) ?? Number.MAX_SAFE_INTEGER) - (scopedMentionOrder.get(b.originalAtPath) ?? Number.MAX_SAFE_INTEGER)
  );
  const scopedMentionParts = scopedMentionEntries.map((entry) => entry.part);
  const scopedMentionLabels = scopedMentionEntries.map((entry) => entry.label);
  const scopedMentionDisplays = scopedMentionEntries.map(
    (entry) => entry.display
  );
  const fileParts = [];
  let fileDisplays = [];
  const revalidatedPathSpecs = [];
  const revalidatedDisplayPaths = /* @__PURE__ */ new Map();
  const validatedPathIdentities = /* @__PURE__ */ new Map();
  const pruneSkippedPath = /* @__PURE__ */ __name((approvedPath) => {
    const displayPath = displayPaths.get(approvedPath);
    const displayLabels = displayPathsByCanonicalPath.get(approvedPath) ?? new Set(displayPath ? [displayPath] : []);
    for (const [originalAtPath, resolvedSpec] of atPathToResolvedSpecMap) {
      if (resolvedSpec === approvedPath || displayLabels.has(resolvedSpec)) {
        atPathToResolvedSpecMap.delete(originalAtPath);
      }
    }
    for (let index = contentLabelsForDisplay.length - 1; index >= 0; index--) {
      const label = contentLabelsForDisplay[index];
      if (label === approvedPath || displayLabels.has(label)) {
        contentLabelsForDisplay.splice(index, 1);
      }
    }
  }, "pruneSkippedPath");
  for (const approvedPath of pathSpecsToRead) {
    try {
      const currentPath = await fs2.realpath(approvedPath);
      const stats = await fs2.stat(currentPath);
      if (currentPath === approvedPath && (stats.isFile() || stats.isDirectory()) && (isSubpath(configuredProjectTempDir, currentPath) || isSubpath(projectTempDir, currentPath) || config.getWorkspaceContext().isPathWithinWorkspace(currentPath)) && getIgnoreReason(currentPath) === void 0) {
        revalidatedPathSpecs.push(currentPath);
        const displayPath = displayPaths.get(approvedPath);
        if (displayPath) revalidatedDisplayPaths.set(currentPath, displayPath);
        validatedPathIdentities.set(currentPath, {
          dev: stats.dev,
          ino: stats.ino
        });
      } else {
        pruneSkippedPath(approvedPath);
        onDebugMessage(
          `Path ${approvedPath} failed revalidation and will be skipped.`
        );
      }
    } catch {
      pruneSkippedPath(approvedPath);
      onDebugMessage(
        `Path ${approvedPath} changed before it could be read and will be skipped.`
      );
    }
  }
  initialQueryText = buildInitialQueryText();
  if (revalidatedPathSpecs.length > 0) {
    try {
      const result = await readManyFiles(config, {
        paths: revalidatedPathSpecs,
        signal,
        preserveUnsupportedImageForBridge: shouldRunVisionBridge(config),
        validatedPathIdentities,
        displayPaths: revalidatedDisplayPaths
      });
      const parts = Array.isArray(result.contentParts) ? result.contentParts : [result.contentParts];
      fileDisplays = result.files.map((file, index) => ({
        callId: `client-read-${userMessageTimestamp}-${index}`,
        name: file.isDirectory ? "Read Directory" : "Read File",
        description: `@${path.basename(file.filePath)}`,
        status: file.error ? "Error" /* Error */ : "Success" /* Success */,
        resultDisplay: file.error ? `Failed to read ${path.basename(file.filePath)}: ${file.error}` : void 0,
        confirmationDetails: void 0
      }));
      if (parts.length > 0 && !result.error) {
        for (const part of parts) {
          fileParts.push(typeof part === "string" ? { text: part } : part);
        }
      } else {
        onDebugMessage("readManyFiles returned no content or empty content.");
      }
    } catch (error) {
      const errorToolCallDisplay = {
        callId: `client-read-${userMessageTimestamp}`,
        name: "Read File(s)",
        description: "Error attempting to read files",
        status: "Error" /* Error */,
        resultDisplay: `Error reading files (${contentLabelsForDisplay.join(", ")}): ${getErrorMessage(error)}`,
        confirmationDetails: void 0
      };
      const errorMessage = typeof errorToolCallDisplay.resultDisplay === "string" ? errorToolCallDisplay.resultDisplay : void 0;
      const labelsOnError = [
        ...scopedMentionLabels,
        ...contentLabelsForDisplay,
        ...resourceLabels,
        ...urlMediaLabels
      ];
      return {
        processedQuery: null,
        shouldProceed: false,
        toolDisplays: [
          ...scopedMentionDisplays,
          ...resourceDisplays,
          ...urlMediaDisplays,
          errorToolCallDisplay
        ],
        filesRead: labelsOnError,
        recording: {
          filesRead: labelsOnError,
          status: "error",
          message: errorMessage
        }
      };
    }
  }
  const rememberedMediaParts = rememberedMediaRefs.flatMap((ref) => [
    { text: ref.annotation },
    {
      text: `\u3010\u5A92\u4F53\u7F3A\u5931\u3011${ref.pathName}\uFF1A\u6587\u4EF6\u5DF2\u4E0D\u5728\u78C1\u76D8\u4E0A\uFF0C\u65E0\u6CD5\u6295\u9012\u753B\u9762/\u97F3\u9891\u3002\u5176\u5904\u7406\u8BB0\u5FC6\u4ECD\u53EF\u7528\u2014\u2014\u7528\u4E0A\u9762\u7684\u53E5\u67C4\u8C03\u7528 omni_recall_media_memory \u53D6\u56DE\u3002`
    }
  ]);
  const processedQueryParts = [
    { text: initialQueryText },
    ...scopedMentionParts,
    ...fileParts,
    ...resourceParts,
    ...urlMediaParts,
    ...rememberedMediaParts
  ];
  const allLabels = [
    ...scopedMentionLabels,
    ...contentLabelsForDisplay,
    ...resourceLabels,
    ...urlMediaLabels,
    ...rememberedMediaRefs.map((ref) => `${ref.pathName} (\u8BB0\u5FC6)`)
  ];
  return {
    processedQuery: processedQueryParts,
    shouldProceed: true,
    toolDisplays: [
      ...scopedMentionDisplays,
      ...fileDisplays,
      ...resourceDisplays,
      ...urlMediaDisplays
    ],
    filesRead: allLabels,
    recording: {
      filesRead: allLabels,
      status: "success"
    }
  };
}
__name(resolveAtCommandQuery, "resolveAtCommandQuery");
async function handleAtCommand(params) {
  const result = await resolveAtCommandQuery(params);
  if (result.recording) {
    const chatRecorder = params.config.getChatRecordingService?.();
    chatRecorder?.recordAtCommand({
      filesRead: result.recording.filesRead,
      status: result.recording.status,
      ...result.recording.message ? { message: result.recording.message } : {},
      userText: params.query
    });
  }
  if (params.addItem && result.toolDisplays && result.toolDisplays.length > 0) {
    const toolGroupItem = {
      type: "tool_group",
      tools: result.toolDisplays
    };
    params.addItem(toolGroupItem, params.messageId);
  }
  return {
    processedQuery: result.processedQuery,
    shouldProceed: result.shouldProceed,
    toolDisplays: result.toolDisplays,
    filesRead: result.filesRead
  };
}
__name(handleAtCommand, "handleAtCommand");

export {
  matchMcpServerPrefix,
  buildMcpResourceRef,
  MAX_SUGGESTIONS_TO_SHOW,
  normalizeDescription,
  EXTENSION_CONTEXT_BUDGET,
  parseExtensionRef,
  matchExtensionByRef,
  sanitizeDisplayText,
  buildExtensionMentionContext,
  getExtensionSuggestions,
  SESSION_MENTION_PREFIX,
  buildSessionRef,
  parseMcpServerRef,
  buildMcpServerRef,
  matchMcpServerByRef,
  buildMcpServerContextText,
  extractAtPathCommands,
  resolveAtCommandQuery,
  handleAtCommand
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
