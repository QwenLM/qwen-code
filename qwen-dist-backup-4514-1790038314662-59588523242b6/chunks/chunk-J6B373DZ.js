// Force strict mode and setup for ESM
"use strict";
import {
  require_source
} from "./chunk-57OAHC2Y.js";
import {
  loadSettings
} from "./chunk-DRYBBTI5.js";
import {
  getCurrentLanguage,
  t
} from "./chunk-POMFSBEC.js";
import {
  isWorkspaceTrusted
} from "./chunk-36RKQ7ZS.js";
import {
  ExtensionManager,
  getExtensionDescription,
  getExtensionDisplayName,
  require_prompts
} from "./chunk-MRTRBONQ.js";
import {
  stripAnsi
} from "./chunk-TWPJO254.js";
import {
  redactUrlCredentials
} from "./chunk-B3XJFEEH.js";
import {
  writeStdoutLine
} from "./chunk-7FA2II6K.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/commands/extensions/utils.ts
init_esbuild_shims();

// packages/cli/src/commands/extensions/consent.ts
init_esbuild_shims();
var import_chalk = __toESM(require_source(), 1);
var import_prompts = __toESM(require_prompts(), 1);
async function requestConsentNonInteractive(consentDescription) {
  writeStdoutLine(consentDescription);
  const result = await promptForConsentNonInteractive(
    t("Do you want to continue? [Y/n]: ")
  );
  return result;
}
__name(requestConsentNonInteractive, "requestConsentNonInteractive");
async function requestChoicePluginNonInteractive(marketplace) {
  const plugins = marketplace.plugins;
  if (plugins.length === 0) {
    throw new Error(t("No plugins available in this marketplace."));
  }
  const choices = plugins.map((plugin) => ({
    title: import_chalk.default.green(import_chalk.default.bold(`[${plugin.name}]`)),
    value: plugin.name
  }));
  const response = await (0, import_prompts.default)({
    type: "select",
    name: "plugin",
    message: t('Select a plugin to install from marketplace "{{name}}":', {
      name: marketplace.name
    }),
    choices,
    initial: 0
  });
  if (response.plugin === void 0) {
    throw new Error(t("Plugin selection cancelled."));
  }
  return response.plugin;
}
__name(requestChoicePluginNonInteractive, "requestChoicePluginNonInteractive");
async function requestConsentInteractive(consentDescription, addExtensionUpdateConfirmationRequest) {
  return promptForConsentInteractive(
    consentDescription + "\n\n" + t("Do you want to continue?"),
    addExtensionUpdateConfirmationRequest
  );
}
__name(requestConsentInteractive, "requestConsentInteractive");
async function promptForConsentNonInteractive(prompt) {
  const readline = await import("node:readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(["y", ""].includes(answer.trim().toLowerCase()));
    });
  });
}
__name(promptForConsentNonInteractive, "promptForConsentNonInteractive");
async function promptForConsentInteractive(prompt, addExtensionUpdateConfirmationRequest) {
  return new Promise((resolve) => {
    addExtensionUpdateConfirmationRequest({
      prompt,
      onConfirm: /* @__PURE__ */ __name((resolvedConfirmed) => {
        resolve(resolvedConfirmed);
      }, "onConfirm")
    });
  });
}
__name(promptForConsentInteractive, "promptForConsentInteractive");
function extensionConsentString(extensionConfig, commands = [], skills = [], subagents = [], originSource = "QwenCode", workflows = []) {
  const output = [];
  if (originSource !== "QwenCode" && originSource !== "AgentPlugins") {
    output.push(
      t(
        "You are installing an extension from {{originSource}}. Some features may not work perfectly with Qwen Code.",
        { originSource }
      )
    );
  }
  const mcpServerEntries = Object.entries(extensionConfig.mcpServers || {});
  const displayLabel = extensionConfig.displayName ?? extensionConfig.name;
  output.push(t('Installing extension "{{name}}".', { name: displayLabel }));
  if (typeof extensionConfig.description === "string" && extensionConfig.description) {
    output.push(stripAnsi(extensionConfig.description));
  }
  output.push(
    t(
      "**Extensions may introduce unexpected behavior. Ensure you have investigated the extension source and trust the author.**"
    )
  );
  if (mcpServerEntries.length) {
    output.push(t("This extension will run the following MCP servers:"));
    for (const [key, mcpServer] of mcpServerEntries) {
      const isLocal = !!mcpServer.command;
      const source = mcpServer.httpUrl ?? `${mcpServer.command || ""}${mcpServer.args ? " " + mcpServer.args.join(" ") : ""}`;
      output.push(
        `  * ${key} (${isLocal ? t("local") : t("remote")}): ${source}`
      );
    }
  }
  if (commands && commands.length > 0) {
    output.push(
      t("This extension will add the following commands: {{commands}}.", {
        commands: commands.join(", ")
      })
    );
  }
  if (extensionConfig.contextFileName) {
    const fileName = Array.isArray(extensionConfig.contextFileName) ? extensionConfig.contextFileName.join(", ") : extensionConfig.contextFileName;
    output.push(
      t(
        "This extension will append info to your QWEN.md context using {{fileName}}",
        { fileName }
      )
    );
  }
  if (skills.length > 0) {
    output.push(t("This extension will install the following skills:"));
    for (const skill of skills) {
      output.push(`  * ${import_chalk.default.bold(skill.name)}: ${skill.description}`);
    }
  }
  if (subagents.length > 0) {
    output.push(t("This extension will install the following subagents:"));
    for (const subagent of subagents) {
      output.push(`  * ${import_chalk.default.bold(subagent.name)}: ${subagent.description}`);
    }
  }
  if (workflows.length > 0) {
    output.push(
      t(
        "This extension will install the following workflows (JavaScript scripts that can start subagents):"
      )
    );
    for (const workflow of workflows) {
      const description = stripAnsi(workflow.description).replace(/\s+/g, " ");
      output.push(`  * ${import_chalk.default.bold(workflow.name)}: ${description}`);
    }
  }
  return output.join("\n");
}
__name(extensionConsentString, "extensionConsentString");
function changedWorkflowScripts(workflows, previousWorkflows) {
  const previousDigests = new Map(
    previousWorkflows.map((workflow) => [
      workflow.name,
      workflow.contentDigest
    ])
  );
  return workflows.filter((workflow) => {
    const previous = previousDigests.get(workflow.name);
    return previous !== void 0 && previous !== workflow.contentDigest;
  }).map((workflow) => workflow.name);
}
__name(changedWorkflowScripts, "changedWorkflowScripts");
var requestConsentOrFail = /* @__PURE__ */ __name(async (requestConsent, options) => {
  if (!options) return;
  const {
    extensionConfig,
    originSource = "QwenCode",
    commands = [],
    skills = [],
    subagents = [],
    workflows = [],
    previousExtensionConfig,
    previousCommands = [],
    previousSkills = [],
    previousSubagents = [],
    previousWorkflows = []
  } = options;
  const extensionConsent = extensionConsentString(
    extensionConfig,
    commands,
    skills,
    subagents,
    originSource,
    workflows
  );
  const changedScripts = previousExtensionConfig ? changedWorkflowScripts(workflows, previousWorkflows) : [];
  if (previousExtensionConfig) {
    const previousExtensionConsent = extensionConsentString(
      previousExtensionConfig,
      previousCommands,
      previousSkills,
      previousSubagents,
      originSource,
      previousWorkflows
    );
    if (previousExtensionConsent === extensionConsent && changedScripts.length === 0) {
      return;
    }
  }
  const consent = changedScripts.length > 0 ? `${extensionConsent}
${t(
    "These workflow scripts changed since the installed version: {{names}}.",
    { names: changedScripts.join(", ") }
  )}` : extensionConsent;
  if (!await requestConsent(consent)) {
    throw new Error(
      t('Installation cancelled for "{{name}}".', {
        name: extensionConfig.name
      })
    );
  }
}, "requestConsentOrFail");

// packages/cli/src/commands/extensions/utils.ts
var import_chalk2 = __toESM(require_source(), 1);
import * as os from "node:os";
async function getExtensionManager() {
  const workspaceDir = process.cwd();
  const extensionManager = new ExtensionManager({
    workspaceDir,
    locale: getCurrentLanguage(),
    requestConsent: requestConsentOrFail.bind(
      null,
      requestConsentNonInteractive
    ),
    requestChoicePlugin: requestChoicePluginNonInteractive,
    isWorkspaceTrusted: isWorkspaceTrusted(loadSettings(workspaceDir).merged).isTrusted ?? true
  });
  await extensionManager.refreshCache();
  return extensionManager;
}
__name(getExtensionManager, "getExtensionManager");
var EXTENSION_COMMAND_SCOPES = ["User" /* User */, "Workspace" /* Workspace */];
function extensionCommandScopesList() {
  return EXTENSION_COMMAND_SCOPES.map((s) => s.toLowerCase()).join(", ");
}
__name(extensionCommandScopesList, "extensionCommandScopesList");
function resolveExtensionCommandScope(scope) {
  if (!scope) {
    return "User" /* User */;
  }
  const normalized = scope.toLowerCase();
  const matched = EXTENSION_COMMAND_SCOPES.find(
    (candidate) => candidate.toLowerCase() === normalized
  );
  if (matched) {
    return matched;
  }
  throw new Error(
    t("Invalid scope: {{scope}}. Please use one of {{scopes}}.", {
      scope,
      scopes: extensionCommandScopesList()
    })
  );
}
__name(resolveExtensionCommandScope, "resolveExtensionCommandScope");
function extensionToOutputString(extension, extensionManager, workspaceDir, inline = false) {
  const cwd = workspaceDir;
  const userEnabled = extensionManager.isEnabled(
    extension.config.name,
    os.homedir()
  );
  const workspaceEnabled = extensionManager.isEnabled(
    extension.config.name,
    cwd
  );
  const status = workspaceEnabled ? import_chalk2.default.green("\u2713") : import_chalk2.default.red("\u2717");
  const locale = getCurrentLanguage();
  const displayLabel = getExtensionDisplayName(extension, locale);
  let output = `${inline ? "" : status} ${displayLabel} (${extension.config.version})`;
  const desc = getExtensionDescription(extension, locale);
  if (desc) {
    output += `
 ${t("Description:")} ${stripAnsi(desc)}`;
  }
  output += `
 ${t("Path:")} ${extension.path}`;
  if (extension.installMetadata) {
    output += `
 ${t("Source:")} ${redactUrlCredentials(extension.installMetadata.source)} (${t("Type:")} ${extension.installMetadata.type})`;
    if (extension.installMetadata.originSource) {
      output += `
 ${t("Origin:")} ${extension.installMetadata.originSource}`;
    }
    if (extension.installMetadata.ref) {
      output += `
 ${t("Ref:")} ${extension.installMetadata.ref}`;
    }
    if (extension.installMetadata.releaseTag) {
      output += `
 ${t("Release tag:")} ${extension.installMetadata.releaseTag}`;
    }
  }
  output += `
 ${t("Enabled (User):")} ${userEnabled}`;
  output += `
 ${t("Enabled (Workspace):")} ${workspaceEnabled}`;
  if (extension.contextFiles.length > 0) {
    output += `
 ${t("Context files:")}`;
    extension.contextFiles.forEach((contextFile) => {
      output += `
  ${contextFile}`;
    });
  }
  if (extension.commands && extension.commands.length > 0) {
    output += `
 ${t("Commands:")}`;
    extension.commands.forEach((command) => {
      output += `
  /${command}`;
    });
  }
  if (extension.skills && extension.skills.length > 0) {
    output += `
 ${t("Skills:")}`;
    extension.skills.forEach((skill) => {
      output += `
  ${skill.name}`;
    });
  }
  if (extension.agents && extension.agents.length > 0) {
    output += `
 ${t("Agents:")}`;
    extension.agents.forEach((agent) => {
      output += `
  ${agent.name}`;
    });
  }
  if (extension.workflows && extension.workflows.length > 0) {
    output += `
 ${t("Workflows:")}`;
    extension.workflows.forEach((workflow) => {
      output += `
  /${workflow.name}`;
    });
  }
  if (extension.config.mcpServers) {
    output += `
 ${t("MCP servers:")}`;
    Object.keys(extension.config.mcpServers).forEach((key) => {
      output += `
  ${key}`;
    });
  }
  return output;
}
__name(extensionToOutputString, "extensionToOutputString");

export {
  requestConsentNonInteractive,
  requestChoicePluginNonInteractive,
  requestConsentInteractive,
  requestConsentOrFail,
  getExtensionManager,
  resolveExtensionCommandScope,
  extensionToOutputString
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
