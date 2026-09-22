// Force strict mode and setup for ESM
"use strict";
import {
  t
} from "./chunk-POMFSBEC.js";
import {
  computeThresholds,
  estimateContextTextTokens,
  formatContextFileDisplayPath,
  getMainSessionBaseSystemPrompt
} from "./chunk-MRTRBONQ.js";
import {
  isMediaPolicyToolHiddenFromModel
} from "./chunk-MNU36NGH.js";
import {
  buildSkillLlmContent
} from "./chunk-WDVSRQIQ.js";
import {
  DiscoveredMCPTool,
  uiTelemetryService
} from "./chunk-KKGSJZWK.js";
import {
  DEFAULT_TOKEN_LIMIT
} from "./chunk-KUON6Z6R.js";
import {
  ToolNames
} from "./chunk-ERIBG3BX.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/ui/commands/contextCommand.ts
init_esbuild_shims();
import * as path from "node:path";
function currentTier(tokens, thresholds) {
  if (tokens >= thresholds.hard) return "hard";
  if (tokens >= thresholds.auto) return "auto";
  if (tokens >= thresholds.warn) return "warn";
  return "safe";
}
__name(currentTier, "currentTier");
function parseMemoryFiles(memoryContent, workingDir) {
  if (!memoryContent || memoryContent.trim().length === 0) return [];
  const results = [];
  const regex = /--- Context from: (.+?) ---\n([\s\S]*?)--- End of Context from: \1 ---/g;
  let match;
  while ((match = regex.exec(memoryContent)) !== null) {
    const filePath = match[1];
    const content = match[2];
    results.push({
      // Marker paths are relative to the session working directory (where
      // memory discovery ran, which may differ from process.cwd() in
      // ACP/daemon-served sessions); shorten home-dir files to `~/...` so
      // global memory files don't render as `../../..` chains.
      path: formatContextFileDisplayPath(
        path.resolve(workingDir, filePath),
        workingDir
      ),
      tokens: estimateContextTextTokens(content)
    });
  }
  if (results.length === 0 && memoryContent.trim().length > 0) {
    results.push({
      path: t("memory"),
      tokens: estimateContextTextTokens(memoryContent)
    });
  }
  return results;
}
__name(parseMemoryFiles, "parseMemoryFiles");
async function collectContextData(config, showDetails) {
  const modelName = config.getModel() || "unknown";
  const contentGeneratorConfig = config.getContentGeneratorConfig();
  const contextWindowSize = contentGeneratorConfig.contextWindowSize ?? DEFAULT_TOKEN_LIMIT;
  const llmClient = config.getLlmClient?.();
  const activeChat = llmClient?.isInitialized?.() ? llmClient.getChat() : void 0;
  const apiTotalTokens = activeChat ? activeChat.getLastPromptTokenCount() : uiTelemetryService.getLastPromptTokenCount();
  const apiCachedTokens = activeChat?.getLastCachedContentTokenCount?.() ?? uiTelemetryService.getLastCachedContentTokenCount();
  const systemPromptText = getMainSessionBaseSystemPrompt(config);
  const systemPromptTokens = estimateContextTextTokens(systemPromptText);
  const toolRegistry = config.getToolRegistry();
  const allTools = toolRegistry ? toolRegistry.getAllTools() : [];
  const toolDeclarations = toolRegistry ? toolRegistry.getFunctionDeclarations() : [];
  const toolsJsonStr = JSON.stringify(toolDeclarations);
  const allToolsTokens = estimateContextTextTokens(toolsJsonStr);
  const builtinTools = [];
  const mcpTools = [];
  for (const tool of allTools) {
    if (toolRegistry?.isDeferredAndHidden(tool.name)) {
      continue;
    }
    if (isMediaPolicyToolHiddenFromModel(config, tool)) {
      continue;
    }
    const toolJsonStr = JSON.stringify(tool.schema);
    const tokens = estimateContextTextTokens(toolJsonStr);
    if (tool instanceof DiscoveredMCPTool) {
      mcpTools.push({
        name: `${tool.serverName}__${tool.serverToolName || tool.name}`,
        tokens
      });
    } else if (tool.name !== ToolNames.SKILL) {
      builtinTools.push({
        name: tool.name,
        tokens
      });
    }
  }
  const memoryContent = config.getUserMemory();
  const memoryFiles = parseMemoryFiles(memoryContent, config.getWorkingDir());
  const autoMemoryPrompt = config.getAutoMemoryPrompt();
  if (autoMemoryPrompt) {
    memoryFiles.push({
      path: t("auto memory"),
      tokens: estimateContextTextTokens(autoMemoryPrompt)
    });
  }
  const memoryFilesTokens = memoryFiles.reduce((sum, f) => sum + f.tokens, 0);
  const skillTool = allTools.find((tool) => tool.name === ToolNames.SKILL);
  const skillToolDefinitionTokens = skillTool ? estimateContextTextTokens(JSON.stringify(skillTool.schema)) : 0;
  const loadedSkillNames = skillTool && "getLoadedSkillNames" in skillTool ? skillTool.getLoadedSkillNames() : /* @__PURE__ */ new Set();
  const skillManager = config.getSkillManager();
  const skillConfigs = skillManager ? await skillManager.listSkills() : [];
  const enabledSkillNames = new Set(
    skillConfigs.filter((skill) => config.isSkillEnabled(skill)).map((skill) => skill.name.toLowerCase())
  );
  let loadedBodiesTokens = 0;
  const skills = skillConfigs.map((skill) => {
    const listingTokens = estimateContextTextTokens(
      `<skill>
<name>
${skill.name}
</name>
<description>
${skill.description} (${skill.level})
</description>
<location>
${skill.level}
</location>
</skill>`
    );
    const isLoaded = loadedSkillNames.has(skill.name);
    let bodyTokens;
    if (isLoaded && skill.body) {
      const baseDir = skill.filePath ? skill.filePath.replace(/\/[^/]+$/, "") : "";
      bodyTokens = estimateContextTextTokens(
        buildSkillLlmContent(baseDir, skill.body)
      );
      loadedBodiesTokens += bodyTokens;
    }
    return {
      name: skill.name,
      tokens: listingTokens,
      loaded: isLoaded,
      bodyTokens
    };
  });
  const skillsTokens = skillToolDefinitionTokens + loadedBodiesTokens;
  const thresholds = computeThresholds(
    contextWindowSize,
    config.getAutoCompactThreshold()
  );
  const autocompactBuffer = Math.max(
    0,
    Math.round(contextWindowSize - thresholds.auto)
  );
  const rawOverhead = systemPromptTokens + allToolsTokens + memoryFilesTokens + loadedBodiesTokens;
  const hasTokenCount = apiTotalTokens > 0;
  const isEstimated = !hasTokenCount || activeChat?.isLastPromptTokenCountEstimated() === true;
  const mcpToolsTotalTokens = mcpTools.reduce(
    (sum, tool) => sum + tool.tokens,
    0
  );
  let totalTokens;
  let displaySystemPrompt;
  let displayBuiltinTools;
  let displayMcpTools;
  let displayMemoryFiles;
  let displaySkills;
  let messagesTokens;
  let freeSpace;
  let detailBuiltinTools;
  let detailMcpTools;
  let detailMemoryFiles;
  let detailSkills;
  if (!hasTokenCount) {
    totalTokens = 0;
    displaySystemPrompt = systemPromptTokens;
    displaySkills = skillsTokens;
    displayBuiltinTools = Math.max(
      0,
      allToolsTokens - skillToolDefinitionTokens - mcpToolsTotalTokens
    );
    displayMcpTools = mcpToolsTotalTokens;
    displayMemoryFiles = memoryFilesTokens;
    messagesTokens = 0;
    freeSpace = Math.max(
      0,
      contextWindowSize - rawOverhead - autocompactBuffer
    );
    detailBuiltinTools = builtinTools;
    detailMcpTools = mcpTools;
    detailMemoryFiles = memoryFiles;
    detailSkills = skills;
  } else {
    totalTokens = apiTotalTokens;
    const overheadScale = rawOverhead > totalTokens ? totalTokens / rawOverhead : 1;
    displaySystemPrompt = Math.round(systemPromptTokens * overheadScale);
    const scaledAllTools = Math.round(allToolsTokens * overheadScale);
    displayMemoryFiles = Math.round(memoryFilesTokens * overheadScale);
    displaySkills = Math.round(skillsTokens * overheadScale);
    const scaledMcpTotal = Math.round(mcpToolsTotalTokens * overheadScale);
    displayMcpTools = scaledMcpTotal;
    const scaledSkillDefinition = Math.round(
      skillToolDefinitionTokens * overheadScale
    );
    displayBuiltinTools = Math.max(
      0,
      scaledAllTools - scaledSkillDefinition - scaledMcpTotal
    );
    const scaledOverhead = displaySystemPrompt + scaledAllTools + displayMemoryFiles + Math.round(loadedBodiesTokens * overheadScale);
    if (apiCachedTokens > 0) {
      messagesTokens = Math.max(0, totalTokens - apiCachedTokens);
    } else {
      messagesTokens = Math.max(0, totalTokens - scaledOverhead);
    }
    freeSpace = Math.max(
      0,
      contextWindowSize - totalTokens - autocompactBuffer
    );
    const scaleDetail = /* @__PURE__ */ __name((items) => overheadScale < 1 ? items.map((item) => ({
      ...item,
      tokens: Math.round(item.tokens * overheadScale)
    })) : items, "scaleDetail");
    detailBuiltinTools = scaleDetail(builtinTools);
    detailMcpTools = scaleDetail(mcpTools);
    detailMemoryFiles = scaleDetail(memoryFiles);
    detailSkills = overheadScale < 1 ? skills.map((item) => ({
      ...item,
      tokens: Math.round(item.tokens * overheadScale),
      bodyTokens: item.bodyTokens ? Math.round(item.bodyTokens * overheadScale) : void 0
    })) : skills;
  }
  const tierTokens = hasTokenCount ? apiTotalTokens : rawOverhead;
  const breakdown = {
    systemPrompt: displaySystemPrompt,
    builtinTools: displayBuiltinTools,
    mcpTools: displayMcpTools,
    memoryFiles: displayMemoryFiles,
    skills: displaySkills,
    messages: messagesTokens,
    freeSpace,
    autocompactBuffer,
    thresholds,
    currentTier: currentTier(tierTokens, thresholds)
  };
  return {
    type: "context_usage" /* CONTEXT_USAGE */,
    modelName,
    totalTokens,
    contextWindowSize,
    breakdown,
    builtinTools: showDetails ? detailBuiltinTools : [],
    mcpTools: showDetails ? detailMcpTools : [],
    memoryFiles: showDetails ? detailMemoryFiles : [],
    skills: showDetails ? detailSkills.filter(
      (skill) => enabledSkillNames.has(skill.name.toLowerCase())
    ) : [],
    isEstimated,
    showDetails
  };
}
__name(collectContextData, "collectContextData");
function fmtTokens(tokens) {
  if (tokens >= 1e3) {
    return `${(tokens / 1e3).toFixed(1)}k`;
  }
  return `${tokens}`;
}
__name(fmtTokens, "fmtTokens");
function fmtCategoryRow(label, tokens, contextWindowSize, indent = "  ") {
  const percentage = contextWindowSize > 0 ? (tokens / contextWindowSize * 100).toFixed(1) : "0.0";
  const right = `${fmtTokens(tokens)} tokens (${percentage}%)`;
  const leftPart = `${indent}${label}`;
  const totalWidth = 56;
  const dots = Math.max(1, totalWidth - leftPart.length - right.length);
  return `${leftPart}${" ".repeat(dots)}${right}`;
}
__name(fmtCategoryRow, "fmtCategoryRow");
function formatNum(n) {
  return Math.round(n).toLocaleString("en-US");
}
__name(formatNum, "formatNum");
function formatContextUsageText(data) {
  const {
    modelName,
    totalTokens,
    contextWindowSize,
    breakdown,
    builtinTools,
    mcpTools,
    memoryFiles,
    skills,
    isEstimated,
    showDetails
  } = data;
  const hasTokenCount = totalTokens > 0;
  const lines = [];
  lines.push("## Context Usage");
  lines.push("");
  if (!hasTokenCount) {
    lines.push("*No API response yet. Send a message to see actual usage.*");
    lines.push("");
    lines.push("**Estimated pre-conversation overhead**");
    lines.push(
      `Model: ${modelName}  Context window: ${fmtTokens(contextWindowSize)} tokens`
    );
    lines.push("");
  } else {
    lines.push(
      `Model: ${modelName}  Context window: ${fmtTokens(contextWindowSize)} tokens`
    );
    lines.push("");
    if (isEstimated) {
      lines.push(
        "*Token usage is estimated until provider usage is received.*"
      );
      lines.push("");
    }
    lines.push(fmtCategoryRow("Used", totalTokens, contextWindowSize));
    lines.push(fmtCategoryRow("Free", breakdown.freeSpace, contextWindowSize));
    lines.push("");
    lines.push("**Compaction thresholds**");
    lines.push(
      `  Effective window:   ${formatNum(breakdown.thresholds.effectiveWindow)}  (window \u2212 ${formatNum(contextWindowSize - breakdown.thresholds.effectiveWindow)} reserve)`
    );
    lines.push(`  Warn threshold:     ${formatNum(breakdown.thresholds.warn)}`);
    lines.push(`  Auto threshold:     ${formatNum(breakdown.thresholds.auto)}`);
    lines.push(`  Hard threshold:     ${formatNum(breakdown.thresholds.hard)}`);
    lines.push(`  Current tier:       ${breakdown.currentTier}`);
    lines.push("");
    lines.push("**Usage by category**");
  }
  lines.push(
    fmtCategoryRow("System prompt", breakdown.systemPrompt, contextWindowSize)
  );
  lines.push(
    fmtCategoryRow("Built-in tools", breakdown.builtinTools, contextWindowSize)
  );
  if (breakdown.mcpTools > 0) {
    lines.push(
      fmtCategoryRow("MCP tools", breakdown.mcpTools, contextWindowSize)
    );
  }
  lines.push(
    fmtCategoryRow("Memory files", breakdown.memoryFiles, contextWindowSize)
  );
  lines.push(fmtCategoryRow("Skills", breakdown.skills, contextWindowSize));
  if (hasTokenCount) {
    lines.push(
      fmtCategoryRow("Messages", breakdown.messages, contextWindowSize)
    );
  }
  if (showDetails) {
    const sortedBuiltin = [...builtinTools].sort((a, b) => b.tokens - a.tokens);
    const sortedMcp = [...mcpTools].sort((a, b) => b.tokens - a.tokens);
    const sortedMemory = [...memoryFiles].sort((a, b) => b.tokens - a.tokens);
    const sortedSkills = [...skills].sort((a, b) => {
      if (a.loaded !== b.loaded) return a.loaded ? -1 : 1;
      return b.tokens + (b.bodyTokens ?? 0) - (a.tokens + (a.bodyTokens ?? 0));
    });
    if (sortedBuiltin.length > 0) {
      lines.push("");
      lines.push("**Built-in tools**");
      for (const tool of sortedBuiltin) {
        lines.push(
          fmtCategoryRow(tool.name, tool.tokens, contextWindowSize, "  \u2514 ")
        );
      }
    }
    if (sortedMcp.length > 0) {
      lines.push("");
      lines.push("**MCP tools**");
      for (const tool of sortedMcp) {
        lines.push(
          fmtCategoryRow(tool.name, tool.tokens, contextWindowSize, "  \u2514 ")
        );
      }
    }
    if (sortedMemory.length > 0) {
      lines.push("");
      lines.push("**Memory files**");
      for (const file of sortedMemory) {
        lines.push(
          fmtCategoryRow(file.path, file.tokens, contextWindowSize, "  \u2514 ")
        );
      }
    }
    if (sortedSkills.length > 0) {
      lines.push("");
      lines.push("**Skills**");
      for (const skill of sortedSkills) {
        const label = skill.loaded ? `${skill.name} (active)` : skill.name;
        lines.push(
          fmtCategoryRow(label, skill.tokens, contextWindowSize, "  \u2514 ")
        );
        if (skill.loaded && skill.bodyTokens && skill.bodyTokens > 0) {
          lines.push(
            fmtCategoryRow(
              "body loaded",
              skill.bodyTokens,
              contextWindowSize,
              "    \u2514 "
            )
          );
        }
      }
    }
  } else {
    lines.push("");
    lines.push("*Run /context detail for per-item breakdown.*");
  }
  return lines.join("\n");
}
__name(formatContextUsageText, "formatContextUsageText");
var contextCommand = {
  name: "context",
  get description() {
    return t(
      'Show context window usage breakdown. Use "/context detail" for per-item breakdown.'
    );
  },
  kind: "built-in" /* BUILT_IN */,
  supportedModes: ["interactive", "non_interactive", "acp"],
  action: /* @__PURE__ */ __name(async (context, args) => {
    const normalizedArgs = args?.trim().toLowerCase();
    const showDetails = normalizedArgs === "detail" || normalizedArgs === "-d";
    const executionMode = context.executionMode ?? "interactive";
    const { config } = context.services;
    if (!config) {
      if (executionMode === "interactive") {
        context.ui.addItem(
          {
            type: "error" /* ERROR */,
            text: t("Config not loaded.")
          },
          Date.now()
        );
        return;
      }
      return {
        type: "message",
        messageType: "error",
        content: t("Config not loaded.")
      };
    }
    const contextUsageItem = await collectContextData(config, showDetails);
    if (executionMode === "interactive") {
      context.ui.addItem(contextUsageItem, Date.now());
      return;
    }
    return {
      type: "message",
      messageType: "info",
      content: formatContextUsageText(contextUsageItem)
    };
  }, "action"),
  subCommands: [
    {
      name: "detail",
      get description() {
        return t("Show per-item context usage breakdown.");
      },
      kind: "built-in" /* BUILT_IN */,
      supportedModes: ["interactive", "non_interactive", "acp"],
      action: /* @__PURE__ */ __name(async (context) => {
        await contextCommand.action(context, "detail");
      }, "action")
    }
  ]
};

export {
  collectContextData,
  formatContextUsageText,
  contextCommand
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
