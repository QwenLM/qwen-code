// Force strict mode and setup for ESM
"use strict";
import {
  sanitizeFilenameForDisplay,
  truncateToWidth
} from "./chunk-47ECGEJC.js";
import {
  t
} from "./chunk-POMFSBEC.js";
import {
  fetchGitDiff,
  isCompressionFailureStatus
} from "./chunk-MRTRBONQ.js";
import {
  skillRestrictionNames
} from "./chunk-IMV5DBIP.js";
import {
  findProviderByCredentials,
  resolveMetadataKey
} from "./chunk-TLS6QN2S.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/ui/utils/compression-text.ts
init_esbuild_shims();
var formatCompressionTokenCount = /* @__PURE__ */ __name((count, isEstimated) => isEstimated ? `~${count}` : String(count), "formatCompressionTokenCount");
function getCompressionStatusText({
  isPending,
  originalTokenCount,
  newTokenCount,
  compressionStatus,
  originalTokenCountIsEstimated,
  newTokenCountIsEstimated
}) {
  if (isPending) {
    return t("Compressing chat history");
  }
  const originalTokens = originalTokenCount ?? 0;
  const newTokens = newTokenCount ?? 0;
  switch (compressionStatus) {
    case 1 /* COMPRESSED */:
      return t(
        "Chat history compressed from {{originalTokens}} to {{newTokens}} tokens.",
        {
          originalTokens: formatCompressionTokenCount(
            originalTokens,
            originalTokenCountIsEstimated
          ),
          newTokens: formatCompressionTokenCount(
            newTokens,
            newTokenCountIsEstimated
          )
        }
      );
    case 2 /* COMPRESSION_FAILED_INFLATED_TOKEN_COUNT */:
      if (originalTokens < 5e4) {
        return t("Compression was not beneficial for this history size.");
      }
      return t(
        "Chat history compression did not reduce size. This may indicate issues with the compression prompt."
      );
    case 3 /* COMPRESSION_FAILED_TOKEN_COUNT_ERROR */:
      return t(
        "Could not compress chat history due to a token counting error."
      );
    case 4 /* COMPRESSION_FAILED_EMPTY_SUMMARY */:
      return t(
        "Could not compress chat history because the compression summary was empty."
      );
    case 6 /* COMPRESSION_FAILED_OUTPUT_TRUNCATED */:
      return t(
        "Could not compress chat history because the compression summary was truncated."
      );
    case 7 /* COMPRESSION_FAILED_API_ERROR */:
      return t("Could not compress chat history due to an API error.");
    case 5 /* NOOP */:
      return "Nothing to compress.";
    default:
      return "";
  }
}
__name(getCompressionStatusText, "getCompressionStatusText");
function getCompressionFailureStatusText(options) {
  if (!isCompressionFailureStatus(options.compressionStatus)) {
    return t("Failed to compress chat history.");
  }
  return getCompressionStatusText({
    ...options,
    isPending: false
  }) || t("Failed to compress chat history.");
}
__name(getCompressionFailureStatusText, "getCompressionFailureStatusText");

// packages/cli/src/ui/utils/computeStats.ts
init_esbuild_shims();
function calculateErrorRate(metrics) {
  if (metrics.api.totalRequests === 0) {
    return 0;
  }
  return metrics.api.totalErrors / metrics.api.totalRequests * 100;
}
__name(calculateErrorRate, "calculateErrorRate");
function calculateAverageLatency(metrics) {
  if (metrics.api.totalRequests === 0) {
    return 0;
  }
  return metrics.api.totalLatencyMs / metrics.api.totalRequests;
}
__name(calculateAverageLatency, "calculateAverageLatency");
function calculateCacheHitRate(metrics) {
  if (metrics.tokens.prompt === 0) {
    return 0;
  }
  return metrics.tokens.cached / metrics.tokens.prompt * 100;
}
__name(calculateCacheHitRate, "calculateCacheHitRate");
var computeSessionStats = /* @__PURE__ */ __name((metrics) => {
  const { models, tools, files } = metrics;
  const totalApiTime = Object.values(models).reduce(
    (acc, model) => acc + model.api.totalLatencyMs,
    0
  );
  const totalToolTime = tools.totalDurationMs;
  const agentActiveTime = totalApiTime + totalToolTime;
  const apiTimePercent = agentActiveTime > 0 ? totalApiTime / agentActiveTime * 100 : 0;
  const toolTimePercent = agentActiveTime > 0 ? totalToolTime / agentActiveTime * 100 : 0;
  const totalCachedTokens = Object.values(models).reduce(
    (acc, model) => acc + model.tokens.cached,
    0
  );
  const totalPromptTokens = Object.values(models).reduce(
    (acc, model) => acc + model.tokens.prompt,
    0
  );
  const cacheEfficiency = totalPromptTokens > 0 ? totalCachedTokens / totalPromptTokens * 100 : 0;
  const totalDecisions = tools.totalDecisions.accept + tools.totalDecisions.reject + tools.totalDecisions.modify;
  const successRate = tools.totalCalls > 0 ? tools.totalSuccess / tools.totalCalls * 100 : 0;
  const agreementRate = totalDecisions > 0 ? tools.totalDecisions.accept / totalDecisions * 100 : 0;
  return {
    totalApiTime,
    totalToolTime,
    agentActiveTime,
    apiTimePercent,
    toolTimePercent,
    cacheEfficiency,
    totalDecisions,
    successRate,
    agreementRate,
    totalCachedTokens,
    totalPromptTokens,
    totalLinesAdded: files.totalLinesAdded,
    totalLinesRemoved: files.totalLinesRemoved
  };
}, "computeSessionStats");

// packages/cli/src/services/commandUtils.ts
init_esbuild_shims();
function commandRestrictionNames(cmd) {
  const names = cmd.skillDetail ? skillRestrictionNames(cmd.skillDetail) : [cmd.name.trim().toLowerCase()];
  return [
    ...names,
    // An extension workflow renamed on a collision still answers to the name
    // its extension documents.
    ...cmd.workflowName ? [cmd.workflowName.trim().toLowerCase()] : [],
    ...(cmd.altNames ?? []).map((name) => name.trim().toLowerCase())
  ];
}
__name(commandRestrictionNames, "commandRestrictionNames");
function getEffectiveSupportedModes(cmd) {
  if (cmd.supportedModes !== void 0) {
    return cmd.supportedModes;
  }
  switch (cmd.kind) {
    case "built-in" /* BUILT_IN */:
      return ["interactive"];
    case "file" /* FILE */:
    case "skill" /* SKILL */:
    case "mcp-prompt" /* MCP_PROMPT */:
      return ["interactive", "non_interactive", "acp"];
    default:
      return ["interactive"];
  }
}
__name(getEffectiveSupportedModes, "getEffectiveSupportedModes");
function filterCommandsForMode(commands, mode) {
  return commands.filter(
    (cmd) => getEffectiveSupportedModes(cmd).includes(mode)
  );
}
__name(filterCommandsForMode, "filterCommandsForMode");

// packages/cli/src/services/commandMetadata.ts
init_esbuild_shims();
function extensionOwnerLabel(owner) {
  return `${t("Extension:")} ${owner.displayName || owner.name || "unknown"}`;
}
__name(extensionOwnerLabel, "extensionOwnerLabel");
var MAX_EXTENSION_OWNER_LABEL_WIDTH = 35;
function getCommandSourceBadge(command) {
  switch (command.source) {
    case "bundled-skill":
      return "[Skill]";
    case "skill-dir-command":
      if (command.sourceDetail === "user") {
        return "[User]";
      }
      if (command.sourceDetail === "project") {
        return "[Project]";
      }
      return "[Custom]";
    case "plugin-command":
      if (command.sourceDetail !== "extension") {
        return "[Plugin]";
      }
      return command.sourceLabel ? `[${truncateToWidth(command.sourceLabel, MAX_EXTENSION_OWNER_LABEL_WIDTH)}]` : "[Extension]";
    case "mcp-prompt":
      return "[MCP]";
    case "workflow-command":
      return command.sourceDetail === "extension" && command.sourceLabel ? `[${truncateToWidth(command.sourceLabel, MAX_EXTENSION_OWNER_LABEL_WIDTH)}]` : null;
    case "builtin-command":
    default:
      return null;
  }
}
__name(getCommandSourceBadge, "getCommandSourceBadge");
function getCommandSourceGroup(command) {
  switch (command.source) {
    case "builtin-command":
      return { key: "built-in", title: "Built-in Commands", order: 0 };
    case "bundled-skill":
      return { key: "bundled-skill", title: "Bundled Skills", order: 1 };
    case "skill-dir-command":
      return { key: "custom", title: "Custom Commands", order: 2 };
    case "plugin-command":
      return { key: "plugin", title: "Plugin Commands", order: 3 };
    case "mcp-prompt":
      return { key: "mcp", title: "MCP Commands", order: 4 };
    default:
      return { key: "other", title: "Other Commands", order: 5 };
  }
}
__name(getCommandSourceGroup, "getCommandSourceGroup");
function formatSupportedModes(command) {
  const modes = getEffectiveSupportedModes(command);
  const hasInteractive = modes.includes("interactive");
  const hasNonInteractive = modes.includes("non_interactive");
  const hasAcp = modes.includes("acp");
  if (hasInteractive && hasNonInteractive && hasAcp) {
    return "[all]";
  }
  if (!hasInteractive && hasNonInteractive && hasAcp) {
    return "[headless]";
  }
  if (hasInteractive && !hasNonInteractive && !hasAcp) {
    return "[interactive]";
  }
  return modes.map((mode) => {
    switch (mode) {
      case "interactive":
        return "[i]";
      case "non_interactive":
        return "[ni]";
      case "acp":
        return "[acp]";
      default:
        return `[${mode}]`;
    }
  }).join(" ");
}
__name(formatSupportedModes, "formatSupportedModes");
function getCommandDisplayName(command, options = {}) {
  const prefix = options.prefix ?? "";
  const baseLabel = `${prefix}${command.name}`;
  if (options.matchedAlias) {
    return `${baseLabel} (alias: ${options.matchedAlias})`;
  }
  if (options.includeAliases === false) {
    return baseLabel;
  }
  const altNames = command.altNames?.filter(Boolean);
  if (!altNames || altNames.length === 0) {
    return baseLabel;
  }
  return `${baseLabel} (${altNames.join(", ")})`;
}
__name(getCommandDisplayName, "getCommandDisplayName");
function getCommandSubcommandNames(command) {
  return command.subCommands?.filter((subCommand) => !subCommand.hidden).map((subCommand) => subCommand.name) ?? [];
}
__name(getCommandSubcommandNames, "getCommandSubcommandNames");

// packages/cli/src/ui/commands/diffCommand.ts
init_esbuild_shims();
async function diffAction(context) {
  const { config } = context.services;
  if (!config) {
    return {
      type: "message",
      messageType: "error",
      content: t("Configuration not available.")
    };
  }
  if (context.executionMode === "interactive") {
    return { type: "dialog", dialog: "diff" };
  }
  const cwd = config.getWorkingDir() || config.getProjectRoot();
  if (!cwd) {
    return {
      type: "message",
      messageType: "error",
      content: t("Could not determine current working directory.")
    };
  }
  let result;
  try {
    result = await fetchGitDiff(cwd);
  } catch (error) {
    return {
      type: "message",
      messageType: "error",
      content: `${t("Failed to compute git diff stats")}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  if (!result) {
    return {
      type: "message",
      messageType: "info",
      content: t(
        "No diff available. Either this is not a git repository, HEAD is missing, or a merge/rebase/cherry-pick/revert is in progress."
      )
    };
  }
  if (result.stats.filesCount === 0) {
    return {
      type: "message",
      messageType: "info",
      content: t("Clean working tree \u2014 no changes against HEAD.")
    };
  }
  const model = buildDiffRenderModel(result);
  return {
    type: "message",
    messageType: "info",
    content: renderDiffModelText(model)
  };
}
__name(diffAction, "diffAction");
function buildDiffRenderModel(result) {
  const rows = [];
  for (const [filename, s] of result.perFileStats) {
    rows.push(toRow(filename, s));
  }
  const hiddenCount = Math.max(0, result.stats.filesCount - rows.length);
  return {
    filesCount: result.stats.filesCount,
    linesAdded: result.stats.linesAdded,
    linesRemoved: result.stats.linesRemoved,
    rows,
    hiddenCount
  };
}
__name(buildDiffRenderModel, "buildDiffRenderModel");
function toRow(filename, s) {
  if (s.isBinary) {
    return {
      filename,
      oldPath: s.oldPath,
      isBinary: true,
      isUntracked: Boolean(s.isUntracked),
      isDeleted: Boolean(s.isDeleted),
      truncated: false
    };
  }
  return {
    filename,
    oldPath: s.oldPath,
    added: s.added,
    removed: s.isUntracked ? 0 : s.removed,
    isBinary: false,
    isUntracked: Boolean(s.isUntracked),
    isDeleted: Boolean(s.isDeleted),
    truncated: Boolean(s.truncated)
  };
}
__name(toRow, "toRow");
function computeDiffColumnWidths(rows) {
  let maxAdded = 0;
  let maxRemoved = 0;
  for (const r of rows) {
    if (r.isBinary) continue;
    if ((r.added ?? 0) > maxAdded) maxAdded = r.added ?? 0;
    if ((r.removed ?? 0) > maxRemoved) maxRemoved = r.removed ?? 0;
  }
  const addWidth = String(maxAdded).length;
  const remWidth = String(maxRemoved).length;
  const statColumnWidth = 1 + addWidth + 1 + 1 + remWidth;
  return { addWidth, remWidth, statColumnWidth };
}
__name(computeDiffColumnWidths, "computeDiffColumnWidths");
function renderDiffModelText(model) {
  const { filesCount, linesAdded, linesRemoved, rows, hiddenCount } = model;
  const header = filesCount === 1 ? t("{{count}} file changed, +{{added}} / -{{removed}}", {
    count: String(filesCount),
    added: String(linesAdded),
    removed: String(linesRemoved)
  }) : t("{{count}} files changed, +{{added}} / -{{removed}}", {
    count: String(filesCount),
    added: String(linesAdded),
    removed: String(linesRemoved)
  });
  const lines = formatRowsText(rows);
  const capNote = hiddenCount > 0 && rows.length > 0 ? `
  ${t("\u2026and {{hidden}} more (showing first {{shown}})", {
    hidden: String(hiddenCount),
    shown: String(rows.length)
  })}` : "";
  return lines.length > 0 ? `${header}
${lines.join("\n")}${capNote}` : header;
}
__name(renderDiffModelText, "renderDiffModelText");
function formatRowsText(rows) {
  if (rows.length === 0) return [];
  const { addWidth, remWidth, statColumnWidth } = computeDiffColumnWidths(rows);
  const out = [];
  for (const r of rows) {
    const safeName = sanitizeFilenameForDisplay(r.filename);
    const displayName = r.oldPath ? `${sanitizeFilenameForDisplay(r.oldPath)} \u2192 ${safeName}` : safeName;
    if (r.isBinary) {
      const suffix2 = r.isUntracked ? ` ${t("(binary, new)")}` : r.isDeleted ? ` ${t("(binary, deleted)")}` : ` ${t("(binary)")}`;
      out.push(`  ${padMarker("~", statColumnWidth)}  ${displayName}${suffix2}`);
      continue;
    }
    const added = `+${String(r.added ?? 0).padStart(addWidth)}`;
    const removed = `-${String(r.removed ?? 0).padStart(remWidth)}`;
    let suffix = "";
    if (r.isUntracked) {
      suffix = r.truncated ? ` ${t("(new, partial)")}` : ` ${t("(new)")}`;
    } else if (r.isDeleted) {
      suffix = ` ${t("(deleted)")}`;
    }
    out.push(`  ${added} ${removed}  ${displayName}${suffix}`);
  }
  return out;
}
__name(formatRowsText, "formatRowsText");
function padMarker(marker, width) {
  if (marker.length >= width) return marker;
  return `${marker}${" ".repeat(width - marker.length)}`;
}
__name(padMarker, "padMarker");
var diffCommand = {
  name: "diff",
  get description() {
    return t("Show working-tree change stats versus HEAD");
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "non_interactive", "acp"],
  action: diffAction
};

// packages/cli/src/ui/utils/inline-math.ts
init_esbuild_shims();
var INLINE_MATH_MAX_CHARS = 1024;
var INLINE_CODE_SPAN_PATTERN_SOURCE = String.raw`(?<!\`)(?<inlineCodeFence>\`+)(?!\`).+?(?<!\`)\k<inlineCodeFence>(?!\`)`;
var INLINE_CODE_SPAN_RE = new RegExp(INLINE_CODE_SPAN_PATTERN_SOURCE, "g");
function isEscapedAt(text, index) {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}
__name(isEscapedAt, "isEscapedAt");
function isUnescapedDollarAt(text, index) {
  return text[index] === "$" && !isEscapedAt(text, index);
}
__name(isUnescapedDollarAt, "isUnescapedDollarAt");
function unescapeMarkdownDollars(text) {
  return text.replace(
    /(\\+)\$/g,
    (_match, slashes) => `${"\\".repeat(Math.floor(slashes.length / 2))}$`
  );
}
__name(unescapeMarkdownDollars, "unescapeMarkdownDollars");
function unescapeMarkdownBeforeMath(text) {
  return unescapeMarkdownDollars(`${text}$`).slice(0, -1);
}
__name(unescapeMarkdownBeforeMath, "unescapeMarkdownBeforeMath");
function readInlineMathSpan(text, index) {
  if (!isUnescapedDollarAt(text, index)) {
    return null;
  }
  const previous = text[index - 1] ?? "";
  const next = text[index + 1] ?? "";
  if (/\w/.test(previous) || isUnescapedDollarAt(text, index - 1) || !next || /[\s\d$]/.test(next)) {
    return null;
  }
  let closingIndex = index + 1;
  while (closingIndex < text.length && text[closingIndex] !== "\n" && closingIndex - index - 1 <= INLINE_MATH_MAX_CHARS && !isUnescapedDollarAt(text, closingIndex)) {
    closingIndex += 1;
  }
  if (!isUnescapedDollarAt(text, closingIndex)) {
    return null;
  }
  const content = text.slice(index + 1, closingIndex);
  const following = text[closingIndex + 1] ?? "";
  if (content.length > INLINE_MATH_MAX_CHARS || /\s$/.test(content) || /[\w$]/.test(following)) {
    return null;
  }
  return {
    content,
    index,
    raw: text.slice(index, closingIndex + 1)
  };
}
__name(readInlineMathSpan, "readInlineMathSpan");
function findNextInlineMath(text, fromIndex = 0) {
  for (let index = fromIndex; index < text.length; index += 1) {
    const span = readInlineMathSpan(text, index);
    if (span) {
      return span;
    }
  }
  return null;
}
__name(findNextInlineMath, "findNextInlineMath");
function* mergeInlineMathMatches(text, markupRegex, enableInlineMath = true) {
  markupRegex.lastIndex = 0;
  const markupMatches = text.matchAll(markupRegex);
  let nextMarkup = markupMatches.next();
  let nextMath = enableInlineMath ? findNextInlineMath(text) : null;
  let cursor = 0;
  while (!nextMarkup.done || nextMath) {
    while (!nextMarkup.done && (nextMarkup.value.index ?? 0) < cursor) {
      nextMarkup = markupMatches.next();
    }
    if (nextMath && nextMath.index < cursor) {
      nextMath = findNextInlineMath(text, cursor);
    }
    const markupIndex = nextMarkup.done ? Number.POSITIVE_INFINITY : nextMarkup.value.index ?? 0;
    const mathIndex = nextMath?.index ?? Number.POSITIVE_INFINITY;
    if (!nextMarkup.done && markupIndex <= mathIndex) {
      const match = nextMarkup.value;
      yield { kind: "markup", match };
      cursor = markupIndex + match[0].length;
      nextMarkup = markupMatches.next();
    } else if (nextMath) {
      yield { kind: "math", span: nextMath };
      cursor = mathIndex + nextMath.raw.length;
      nextMath = findNextInlineMath(text, cursor);
    }
  }
}
__name(mergeInlineMathMatches, "mergeInlineMathMatches");
function findInlineMathExpressions(text) {
  const expressions = [];
  for (const token of mergeInlineMathMatches(text, INLINE_CODE_SPAN_RE)) {
    if (token.kind === "math") {
      expressions.push(token.span.content);
    }
  }
  return expressions;
}
__name(findInlineMathExpressions, "findInlineMathExpressions");
function readInlineMathSpanAt(text, index) {
  return readInlineMathSpan(text, index)?.raw ?? null;
}
__name(readInlineMathSpanAt, "readInlineMathSpanAt");

// packages/cli/src/ui/systemInfoFields.ts
init_esbuild_shims();
function getSystemInfoFields(info) {
  const fields = [];
  addField(fields, t("Qwen Code"), formatCliVersion(info));
  addField(fields, t("Runtime"), formatRuntime(info));
  addField(fields, t("IDE Client"), info.ideClient);
  addField(fields, "LSP", info.lspStatus ?? "");
  addField(fields, t("OS"), formatOs(info));
  addField(fields, t("Auth"), formatAuth(info));
  addField(fields, t("Base URL"), formatBaseUrl(info));
  addField(fields, t("Model"), info.modelVersion);
  addField(fields, t("Fast Model"), info.fastModel || info.modelVersion);
  addField(fields, t("Session ID"), info.sessionId);
  addField(fields, t("Sandbox"), info.sandboxEnv);
  addField(fields, t("Proxy"), formatProxy(info.proxy));
  addField(fields, t("Memory Usage"), info.memoryUsage);
  return fields;
}
__name(getSystemInfoFields, "getSystemInfoFields");
function addField(fields, label, value) {
  if (value) {
    fields.push({ label, value });
  }
}
__name(addField, "addField");
function formatCliVersion(info) {
  if (!info.cliVersion) {
    return "";
  }
  if (!info.gitCommit) {
    return info.cliVersion;
  }
  return `${info.cliVersion} (${info.gitCommit})`;
}
__name(formatCliVersion, "formatCliVersion");
function formatRuntime(info) {
  if (!info.nodeVersion && !info.npmVersion) {
    return "";
  }
  const node = info.nodeVersion ? `Node.js ${info.nodeVersion}` : "";
  const npm = info.npmVersion ? `npm ${info.npmVersion}` : "";
  return joinParts([node, npm], " / ");
}
__name(formatRuntime, "formatRuntime");
function formatOs(info) {
  return joinParts(
    [info.osPlatform, info.osArch, formatOsRelease(info.osRelease)],
    " "
  ).trim();
}
__name(formatOs, "formatOs");
function formatOsRelease(release) {
  if (!release) {
    return "";
  }
  return `(${release})`;
}
__name(formatOsRelease, "formatOsRelease");
function formatAuth(info) {
  if (!info.selectedAuthType) {
    return "";
  }
  const managedProvider = findProviderByCredentials(
    info.baseUrl,
    info.apiKeyEnvKey
  );
  if (managedProvider && resolveMetadataKey(managedProvider)) {
    return t(managedProvider.label);
  }
  if (info.selectedAuthType.startsWith("oauth") || info.selectedAuthType === "qwen-oauth") {
    return "Qwen OAuth";
  }
  return `API Key - ${info.selectedAuthType}`;
}
__name(formatAuth, "formatAuth");
function formatBaseUrl(info) {
  if (!info.selectedAuthType || !info.baseUrl) {
    return "";
  }
  if (info.selectedAuthType.startsWith("oauth") || info.selectedAuthType === "qwen-oauth") {
    return "";
  }
  return info.baseUrl;
}
__name(formatBaseUrl, "formatBaseUrl");
function formatProxy(proxy) {
  if (!proxy) {
    return "no proxy";
  }
  return redactProxy(proxy);
}
__name(formatProxy, "formatProxy");
function redactProxy(proxy) {
  try {
    const url = new URL(proxy);
    if (url.username || url.password) {
      url.username = url.username ? "***" : "";
      url.password = url.password ? "***" : "";
    }
    return url.toString();
  } catch {
    return proxy.replace(/\/\/[^/]*@/, "//***@");
  }
}
__name(redactProxy, "redactProxy");
function joinParts(parts, separator) {
  return parts.filter((part) => part).join(separator);
}
__name(joinParts, "joinParts");

// packages/cli/src/utils/costCalculator.ts
init_esbuild_shims();
function calculateCost(args) {
  const { inputTokens, outputTokens, pricing } = args;
  if (!pricing) return null;
  if (pricing.inputPerMillionTokens == null && pricing.outputPerMillionTokens == null) {
    return null;
  }
  if (inputTokens <= 0 && outputTokens <= 0) {
    return null;
  }
  const inputCost = pricing.inputPerMillionTokens != null ? inputTokens / 1e6 * pricing.inputPerMillionTokens : 0;
  const outputCost = pricing.outputPerMillionTokens != null ? outputTokens / 1e6 * pricing.outputPerMillionTokens : 0;
  return inputCost + outputCost;
}
__name(calculateCost, "calculateCost");

// packages/cli/src/ui/utils/skill-level-label.ts
init_esbuild_shims();
function levelLabel(level) {
  switch (level) {
    case "project":
      return t("Project");
    case "user":
      return t("User");
    case "extension":
      return t("Extension");
    case "bundled":
      return t("Bundled");
    default: {
      const _exhaustive = level;
      return _exhaustive;
    }
  }
}
__name(levelLabel, "levelLabel");
function skillOriginLabel(skill) {
  if (skill.level === "extension") {
    return `(${extensionOwnerLabel({
      name: skill.extensionName,
      displayName: skill.extensionDisplayName
    })})`;
  }
  return `(${levelLabel(skill.level)})`;
}
__name(skillOriginLabel, "skillOriginLabel");

export {
  INLINE_CODE_SPAN_PATTERN_SOURCE,
  unescapeMarkdownDollars,
  unescapeMarkdownBeforeMath,
  mergeInlineMathMatches,
  findInlineMathExpressions,
  readInlineMathSpanAt,
  formatCompressionTokenCount,
  getCompressionStatusText,
  getCompressionFailureStatusText,
  getSystemInfoFields,
  redactProxy,
  calculateErrorRate,
  calculateAverageLatency,
  calculateCacheHitRate,
  computeSessionStats,
  calculateCost,
  commandRestrictionNames,
  getEffectiveSupportedModes,
  filterCommandsForMode,
  extensionOwnerLabel,
  MAX_EXTENSION_OWNER_LABEL_WIDTH,
  getCommandSourceBadge,
  getCommandSourceGroup,
  formatSupportedModes,
  getCommandDisplayName,
  getCommandSubcommandNames,
  levelLabel,
  skillOriginLabel,
  computeDiffColumnWidths,
  diffCommand
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
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
