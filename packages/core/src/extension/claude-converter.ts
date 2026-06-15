/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Converter for Claude Code plugins to Qwen Code format.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { glob } from 'glob';
import type { ExtensionConfig } from './extensionManager.js';
import { ExtensionStorage } from './storage.js';
import type {
  ExtensionInstallMetadata,
  MCPServerConfig,
} from '../config/config.js';
import type { HookEventName, HookDefinition } from '../hooks/types.js';
import { cloneFromGit, downloadFromGitHubRelease } from './github.js';
import { createHash } from 'node:crypto';
import { copyDirectory } from './gemini-converter.js';
import {
  parse as parseYaml,
  stringify as stringifyYaml,
} from '../utils/yaml-parser.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { normalizeContent } from '../utils/textUtils.js';
import { substituteHookVariables } from './variables.js';

const debugLogger = createDebugLogger('CLAUDE_CONVERTER');

export interface ClaudePluginConfig {
  name: string;
  version: string;
  description?: string;
  author?: { name?: string; email?: string; url?: string };
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  commands?: string | string[];
  agents?: string | string[];
  skills?: string | string[];
  hooks?: string | { [K in HookEventName]?: HookDefinition[] };
  mcpServers?: string | Record<string, MCPServerConfig>;
  outputStyles?: string | string[];
  lspServers?: string | Record<string, unknown>;
}

/**
 * Claude Code subagent configuration format.
 * Based on https://code.claude.com/docs/en/sub-agents
 */
export interface ClaudeAgentConfig {
  /** Unique identifier using lowercase letters and hyphens */
  name: string;
  /** When Claude should delegate to this subagent */
  description: string;
  /** Tools the subagent can use. Inherits all tools if omitted */
  tools?: string[];
  /** Tools to deny, removed from inherited or specified list */
  disallowedTools?: string[];
  /** Model to use: sonnet, opus, haiku, or inherit */
  model?: string;
  /** Permission mode: default, acceptEdits, dontAsk, bypassPermissions, or plan */
  permissionMode?: string;
  /** Skills to load into the subagent's context at startup */
  skills?: string[];
  /** Hooks configuration (CC `TKO` shape; nested per HookEventName) */
  hooks?: unknown;
  /** Per-agent MCP server overrides (CC `gS8` shape; record of server-name → spec) */
  mcpServers?: unknown;
  /** System prompt content */
  systemPrompt?: string;
  /** subagent color */
  color?: string;
}

export type ClaudePluginSource =
  | { source: 'github'; repo: string }
  | { source: 'url'; url: string }
  | {
      // A plugin that lives in a subdirectory of a git repository.
      source: 'git-subdir';
      url: string;
      path: string;
      ref?: string;
      sha?: string;
    };

export interface ClaudeMarketplacePluginConfig extends ClaudePluginConfig {
  source: string | ClaudePluginSource;
  category?: string;
  strict?: boolean;
  tags?: string[];
}

export interface ClaudeMarketplaceConfig {
  name: string;
  owner: { name: string; email: string };
  plugins: ClaudeMarketplacePluginConfig[];
  metadata?: { description?: string; version?: string; pluginRoot?: string };
}

const CLAUDE_TOOLS_MAPPING: Record<string, string | string[]> = {
  AskUserQuestion: 'AskUserQuestion',
  Bash: 'Shell',
  BashOutput: 'None',
  Edit: 'Edit',
  ExitPlanMode: 'ExitPlanMode',
  Glob: 'Glob',
  Grep: 'Grep',
  KillShell: 'None',
  NotebookEdit: 'NotebookEdit',
  Read: 'ReadFile',
  Skill: 'Skill',
  Task: 'Task',
  TodoWrite: 'TodoWrite',
  WebFetch: 'WebFetch',
  WebSearch: 'None',
  Write: 'WriteFile',
  LS: 'ListFiles',
};

const claudeBuildInToolsTransform = (tools: string[]): string[] => {
  const transformedTools: string[] = [];
  tools.forEach((tool) => {
    if (!CLAUDE_TOOLS_MAPPING[tool]) {
      transformedTools.push(tool);
    } else {
      if (CLAUDE_TOOLS_MAPPING[tool] === 'None') {
        return;
      } else if (Array.isArray(CLAUDE_TOOLS_MAPPING[tool])) {
        transformedTools.push(...CLAUDE_TOOLS_MAPPING[tool]);
      } else {
        transformedTools.push(CLAUDE_TOOLS_MAPPING[tool]);
      }
    }
  });
  return transformedTools;
};

/**
 * Parses a value that can be either a comma-separated string or an array.
 * Claude agent config can have tools like 'Glob, Grep, Read' or ['Glob', 'Grep', 'Read']
 * @param value The value to parse
 * @returns Array of strings or undefined
 */
function parseStringOrArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map(String);
  }
  if (typeof value === 'string') {
    // Split by comma and trim whitespace
    return value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return undefined;
}

/**
 * Converts a Claude agent config to Qwen Code subagent format.
 * @param claudeAgent Claude agent configuration
 * @returns Converted agent config compatible with Qwen Code SubagentConfig
 */
export function convertClaudeAgentConfig(
  claudeAgent: ClaudeAgentConfig,
): Record<string, unknown> {
  // Base config with required fields
  const qwenAgent: Record<string, unknown> = {
    name: claudeAgent.name,
    description: claudeAgent.description,
  };

  if (claudeAgent.color) {
    qwenAgent['color'] = claudeAgent.color;
  }

  // Convert system prompt if present
  if (claudeAgent.systemPrompt) {
    qwenAgent['systemPrompt'] = claudeAgent.systemPrompt;
  }

  // Convert tools using claudeBuildInToolsTransform
  if (claudeAgent.tools && claudeAgent.tools.length > 0) {
    qwenAgent['tools'] = claudeBuildInToolsTransform(claudeAgent.tools);
  }

  // Preserve Claude's top-level model selector.
  if (claudeAgent.model) {
    qwenAgent['model'] = claudeAgent.model;
  }

  // Map Claude permission mode aliases to Qwen ApprovalMode values.
  // Note: Claude's `dontAsk` denies any tool call that would prompt the user,
  // making it restrictive. We map it to `default` (which also requires approval)
  // rather than `auto-edit` (which auto-approves), preserving the restrictive
  // intent. `bypassPermissions` is the Claude mode that auto-approves everything.
  if (claudeAgent.permissionMode) {
    const claudeToQwenMode: Record<string, string> = {
      default: 'default',
      plan: 'plan',
      acceptEdits: 'auto-edit',
      dontAsk: 'default',
      bypassPermissions: 'yolo',
      auto: 'auto-edit',
    };
    const mapped =
      claudeToQwenMode[claudeAgent.permissionMode] ??
      claudeAgent.permissionMode;
    qwenAgent['approvalMode'] = mapped;
  }
  if (claudeAgent.hooks) {
    qwenAgent['hooks'] = claudeAgent.hooks;
  }
  if (claudeAgent.mcpServers) {
    qwenAgent['mcpServers'] = claudeAgent.mcpServers;
  }
  if (claudeAgent.skills && claudeAgent.skills.length > 0) {
    qwenAgent['skills'] = claudeAgent.skills;
  }
  if (claudeAgent.disallowedTools && claudeAgent.disallowedTools.length > 0) {
    qwenAgent['disallowedTools'] = claudeAgent.disallowedTools;
  }

  return qwenAgent;
}

/**
 * Converts all agent files in a directory from Claude format to Qwen format.
 * Parses the YAML frontmatter, converts the configuration, and writes back.
 * @param agentsDir Directory containing agent markdown files
 */
async function convertAgentFiles(agentsDir: string): Promise<void> {
  if (!fs.existsSync(agentsDir)) {
    return;
  }

  const files = await fs.promises.readdir(agentsDir);

  for (const file of files) {
    if (!file.endsWith('.md')) continue;

    const filePath = path.join(agentsDir, file);

    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const normalizedContent = normalizeContent(content);

      // Parse frontmatter
      const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
      const match = normalizedContent.match(frontmatterRegex);

      if (!match) {
        // No frontmatter, skip this file
        continue;
      }

      const [, frontmatterYaml, body] = match;
      const frontmatter = parseYaml(frontmatterYaml) as Record<string, unknown>;

      // Build Claude agent config from frontmatter
      // Note: Claude tools/disallowedTools/skills can be comma-separated strings like 'Glob, Grep, Read'
      const claudeAgent: ClaudeAgentConfig = {
        name: String(frontmatter['name'] || ''),
        description: String(frontmatter['description'] || ''),
        tools: parseStringOrArray(frontmatter['tools']),
        disallowedTools: parseStringOrArray(frontmatter['disallowedTools']),
        model: frontmatter['model'] as string | undefined,
        permissionMode: frontmatter['permissionMode'] as string | undefined,
        skills: parseStringOrArray(frontmatter['skills']),
        hooks: frontmatter['hooks'] as ClaudeAgentConfig['hooks'],
        mcpServers: frontmatter[
          'mcpServers'
        ] as ClaudeAgentConfig['mcpServers'],
        color: frontmatter['color'] as string | undefined,
        systemPrompt: body.trim(),
      };

      // Convert to Qwen format
      const qwenAgent = convertClaudeAgentConfig(claudeAgent);

      // Build new frontmatter (excluding systemPrompt as it goes in body).
      const newFrontmatter: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(qwenAgent)) {
        if (key !== 'systemPrompt' && value !== undefined) {
          newFrontmatter[key] = value;
        }
      }

      // Write converted content back. Trim to drop the trailing newline
      // `yaml.stringify` appends so the assembled file has the same single
      // blank line between the closing `---` and the body that
      // `subagent-manager.ts:serializeSubagent` produces — without `.trim()`
      // the converter emits an extra blank line before the closing `---`.
      const newYaml = stringifyYaml(newFrontmatter).trim();
      const systemPrompt = (qwenAgent['systemPrompt'] as string) || body.trim();
      const newContent = `---
${newYaml}
---

${systemPrompt}
`;

      await fs.promises.writeFile(filePath, newContent, 'utf-8');
    } catch (error) {
      debugLogger.warn(
        `[Claude Converter] Failed to convert agent file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * Maps Claude `.mcp.json` server entries to Qwen's MCPServerConfig shape.
 * Claude discriminates transport with a `type` field (`http`/`sse`/`stdio`),
 * whereas Qwen keys off which field is set: `httpUrl` (streamable HTTP),
 * `url` (SSE) or `command` (stdio). A Claude `type: 'http'` entry therefore
 * has to move its `url` to `httpUrl`, and the now-meaningless `type` is dropped.
 */
function normalizeClaudeMcpServers(
  servers: Record<string, MCPServerConfig>,
): Record<string, MCPServerConfig> {
  const normalized: Record<string, MCPServerConfig> = {};
  for (const [name, raw] of Object.entries(servers)) {
    const server = raw as unknown as Record<string, unknown>;
    // stdio / already-Qwen-shaped configs pass through unchanged.
    if (server['command'] || server['httpUrl'] || server['tcp']) {
      normalized[name] = raw;
      continue;
    }
    if (typeof server['url'] === 'string') {
      const rest = { ...server };
      delete rest['type'];
      delete rest['url'];
      normalized[name] = {
        ...rest,
        ...(server['type'] === 'http'
          ? { httpUrl: server['url'] }
          : { url: server['url'] }),
      } as unknown as MCPServerConfig;
      continue;
    }
    normalized[name] = raw;
  }
  return normalized;
}

/**
 * Converts a Claude plugin config to Qwen Code format.
 * @param claudeConfig Claude plugin configuration
 * @returns Qwen ExtensionConfig
 */
export function convertClaudeToQwenConfig(
  claudeConfig: ClaudePluginConfig,
): ExtensionConfig {
  // Validate required fields
  if (!claudeConfig.name) {
    throw new Error('Claude plugin config must have name field');
  }

  // Parse MCP servers
  let mcpServers: Record<string, MCPServerConfig> | undefined;
  if (claudeConfig.mcpServers) {
    if (typeof claudeConfig.mcpServers === 'string') {
      // TODO: Load from file path
      debugLogger.warn(
        `[Claude Converter] MCP servers path not yet supported: ${claudeConfig.mcpServers}`,
      );
    } else {
      mcpServers = normalizeClaudeMcpServers(claudeConfig.mcpServers);
    }
  }

  // Parse hooks
  let hooks: { [K in HookEventName]?: HookDefinition[] } | undefined;
  if (claudeConfig.hooks) {
    if (typeof claudeConfig.hooks === 'string') {
      // If it's a string, it's a file path, we handle it later in the conversion process
      // hooks will be loaded from file path in the convertClaudePluginPackage function
    } else {
      // Assume it's already in the correct format
      hooks = claudeConfig.hooks as { [K in HookEventName]?: HookDefinition[] };
    }
  } else {
    hooks = undefined;
  }

  // Warn about unsupported fields
  if (claudeConfig.outputStyles) {
    debugLogger.warn(
      `[Claude Converter] Output styles are not yet supported in ${claudeConfig.name}`,
    );
  }
  // Direct field mapping - commands, skills, agents will be collected as folders
  return {
    name: claudeConfig.name,
    version: claudeConfig.version,
    description: claudeConfig.description,
    mcpServers,
    lspServers: claudeConfig.lspServers,
    hooks, // Assign the properly typed hooks variable
  };
}

/**
 * Converts a complete Claude plugin package to Qwen Code format.
 * Creates a new temporary directory with:
 * 1. Converted qwen-extension.json
 * 2. Commands, skills, and agents collected to respective folders
 * 3. MCP servers resolved from JSON files if needed
 * 4. All other files preserved
 */
export async function convertClaudePluginPackage(
  extensionDir: string,
  pluginName: string,
): Promise<{ config: ExtensionConfig; convertedDir: string }> {
  // Step 1: Load marketplace.json
  const marketplaceJsonPath = path.join(
    extensionDir,
    '.claude-plugin',
    'marketplace.json',
  );
  if (!fs.existsSync(marketplaceJsonPath)) {
    throw new Error(
      `Marketplace configuration not found at ${marketplaceJsonPath}`,
    );
  }

  const marketplaceContent = fs.readFileSync(marketplaceJsonPath, 'utf-8');
  const marketplaceConfig: ClaudeMarketplaceConfig =
    JSON.parse(marketplaceContent);

  // Find the target plugin in marketplace
  const marketplacePlugin = marketplaceConfig.plugins.find(
    (p) => p.name === pluginName,
  );
  if (!marketplacePlugin) {
    throw new Error(`Plugin ${pluginName} not found in marketplace.json`);
  }

  // Step 2: Resolve plugin source directory based on source field
  const pluginDir = path.join(
    extensionDir,
    `plugin${createHash('sha256').update(`${extensionDir}/${pluginName}`).digest('hex')}`,
  );
  await fs.promises.mkdir(pluginDir, { recursive: true });

  const pluginSource = await resolvePluginSource(
    marketplacePlugin,
    extensionDir,
    pluginDir,
  );

  if (!fs.existsSync(pluginSource)) {
    throw new Error(`Plugin source directory not found: ${pluginSource}`);
  }

  // Step 3: Load and merge plugin.json if exists (based on strict mode)
  const strict = marketplacePlugin.strict ?? false;
  let mergedConfig: ClaudePluginConfig;

  const pluginJsonPath = path.join(
    pluginSource,
    '.claude-plugin',
    'plugin.json',
  );
  if (strict && !fs.existsSync(pluginJsonPath)) {
    throw new Error(`Strict mode requires plugin.json at ${pluginJsonPath}`);
  }
  if (fs.existsSync(pluginJsonPath)) {
    const pluginContent = fs.readFileSync(pluginJsonPath, 'utf-8');
    const pluginConfig: ClaudePluginConfig = JSON.parse(pluginContent);
    mergedConfig = mergeClaudeConfigs(marketplacePlugin, pluginConfig);
  } else {
    mergedConfig = marketplacePlugin as ClaudePluginConfig;
  }

  return buildQwenExtensionFromPlugin(pluginSource, mergedConfig);
}

/**
 * Resolves a plugin-relative file reference, refusing absolute paths or any
 * path that escapes `pluginSource`. Plugin configs come from untrusted sources
 * (arbitrary git repos / marketplaces), so an absolute or `../`-laden value
 * could otherwise make the converter read sensitive files outside the plugin.
 * Returns the confined absolute path, or null when the reference is unsafe.
 */
function resolvePluginRelativeFile(
  pluginSource: string,
  relativePath: string,
): string | null {
  if (path.isAbsolute(relativePath)) {
    debugLogger.warn(
      `Ignoring absolute path "${relativePath}" in plugin config; only paths inside the plugin are allowed.`,
    );
    return null;
  }
  const resolved = path.resolve(pluginSource, relativePath);
  const base = path.resolve(pluginSource);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    debugLogger.warn(
      `Ignoring path "${relativePath}" in plugin config; it escapes the plugin directory.`,
    );
    return null;
  }
  return resolved;
}

/**
 * Builds a converted Qwen extension directory from a resolved Claude plugin
 * source directory and its merged config. Shared by the marketplace-based
 * (`convertClaudePluginPackage`) and standalone (`convertClaudePluginStandalone`)
 * conversion paths.
 */
async function buildQwenExtensionFromPlugin(
  pluginSource: string,
  mergedConfig: ClaudePluginConfig,
): Promise<{ config: ExtensionConfig; convertedDir: string }> {
  // Resolve MCP servers from a JSON file path if needed.
  if (mergedConfig.mcpServers && typeof mergedConfig.mcpServers === 'string') {
    const mcpServersPath = resolvePluginRelativeFile(
      pluginSource,
      mergedConfig.mcpServers,
    );

    if (mcpServersPath && fs.existsSync(mcpServersPath)) {
      try {
        const mcpContent = fs.readFileSync(mcpServersPath, 'utf-8');
        mergedConfig.mcpServers = JSON.parse(mcpContent) as Record<
          string,
          MCPServerConfig
        >;
      } catch (error) {
        debugLogger.warn(
          `Failed to parse MCP servers file ${mcpServersPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  const tmpDir = await ExtensionStorage.createTmpDir();

  try {
    await copyDirectory(pluginSource, tmpDir);

    // A standalone plugin's source is a full git clone; drop VCS metadata so
    // it isn't shipped into the installed extension.
    const gitDir = path.join(tmpDir, '.git');
    if (fs.existsSync(gitDir)) {
      fs.rmSync(gitDir, { recursive: true, force: true });
    }

    // Handle commands/skills/agents folders: if the config specifies resources
    // collect only those, otherwise keep the existing folder from the source.
    const resourceConfigs = [
      { name: 'commands', config: mergedConfig.commands },
      { name: 'skills', config: mergedConfig.skills },
      { name: 'agents', config: mergedConfig.agents },
    ];

    for (const { name, config } of resourceConfigs) {
      const folderPath = path.join(tmpDir, name);
      const sourceFolderPath = path.join(pluginSource, name);

      if (config) {
        if (fs.existsSync(folderPath)) {
          fs.rmSync(folderPath, { recursive: true, force: true });
        }
        await collectResources(config, pluginSource, folderPath);
      } else if (
        !fs.existsSync(sourceFolderPath) &&
        fs.existsSync(folderPath)
      ) {
        fs.rmSync(folderPath, { recursive: true, force: true });
      }
    }

    // Handle hooks from a file path if needed.
    if (mergedConfig.hooks && typeof mergedConfig.hooks === 'string') {
      const hooksPath = resolvePluginRelativeFile(
        pluginSource,
        mergedConfig.hooks,
      );

      if (hooksPath && fs.existsSync(hooksPath)) {
        try {
          const hooksContent = fs.readFileSync(hooksPath, 'utf-8');
          const parsedHooks = JSON.parse(hooksContent);

          let hooksData;
          if (parsedHooks.hooks && typeof parsedHooks.hooks === 'object') {
            hooksData = parsedHooks.hooks as {
              [K in HookEventName]?: HookDefinition[];
            };
          } else {
            hooksData = parsedHooks as {
              [K in HookEventName]?: HookDefinition[];
            };
          }

          mergedConfig.hooks = substituteHookVariables(hooksData, pluginSource);
        } catch (error) {
          debugLogger.warn(
            `Failed to parse hooks file ${hooksPath}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    const agentsDestDir = path.join(tmpDir, 'agents');
    await convertAgentFiles(agentsDestDir);

    const qwenConfig = convertClaudeToQwenConfig(mergedConfig);

    const qwenConfigPath = path.join(tmpDir, 'qwen-extension.json');
    fs.writeFileSync(
      qwenConfigPath,
      JSON.stringify(qwenConfig, null, 2),
      'utf-8',
    );

    return {
      config: qwenConfig,
      convertedDir: tmpDir,
    };
  } catch (error) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Converts a standalone Claude plugin to Qwen Code format. A standalone plugin
 * is a repo whose root holds `.claude-plugin/plugin.json` (no marketplace.json),
 * as produced by installing a Claude Code plugin directly from a git URL.
 *
 * MCP servers declared in a root `.mcp.json` are folded into the config when
 * plugin.json does not list them itself.
 */
export async function convertClaudePluginStandalone(
  extensionDir: string,
): Promise<{ config: ExtensionConfig; convertedDir: string }> {
  const pluginJsonPath = path.join(
    extensionDir,
    '.claude-plugin',
    'plugin.json',
  );
  if (!fs.existsSync(pluginJsonPath)) {
    throw new Error(`Plugin configuration not found at ${pluginJsonPath}`);
  }

  const mergedConfig: ClaudePluginConfig = JSON.parse(
    fs.readFileSync(pluginJsonPath, 'utf-8'),
  );

  if (!mergedConfig.mcpServers) {
    const mcpJsonPath = path.join(extensionDir, '.mcp.json');
    if (fs.existsSync(mcpJsonPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
        if (
          parsed?.mcpServers &&
          typeof parsed.mcpServers === 'object' &&
          !Array.isArray(parsed.mcpServers)
        ) {
          mergedConfig.mcpServers = parsed.mcpServers as Record<
            string,
            MCPServerConfig
          >;
        } else {
          debugLogger.warn(
            `.mcp.json at ${mcpJsonPath} has no valid "mcpServers" object; skipping.`,
          );
        }
      } catch (error) {
        debugLogger.warn(
          `Failed to parse .mcp.json at ${mcpJsonPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  return buildQwenExtensionFromPlugin(extensionDir, mergedConfig);
}

/**
 * Collects resources (commands, skills, agents) to a destination folder.
 * Resources are always copied unconditionally — the caller
 * (`convertClaudePluginPackage`) clears `destDir` beforehand so it can
 * honor selective sub-entry lists.
 * @param resourcePaths String or array of resource paths
 * @param pluginRoot Root directory of the plugin
 * @param destDir Destination directory for collected resources
 */
async function collectResources(
  resourcePaths: string | string[],
  pluginRoot: string,
  destDir: string,
): Promise<void> {
  const paths = Array.isArray(resourcePaths) ? resourcePaths : [resourcePaths];

  // Create destination directory
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  // Get the destination folder name (e.g., 'commands', 'skills', 'agents')
  const destFolderName = path.basename(destDir);

  for (const resourcePath of paths) {
    const resolvedPath = path.isAbsolute(resourcePath)
      ? resourcePath
      : path.join(pluginRoot, resourcePath);

    if (!fs.existsSync(resolvedPath)) {
      debugLogger.warn(`Resource path not found: ${resolvedPath}`);
      continue;
    }

    const stat = fs.statSync(resolvedPath);

    if (stat.isDirectory()) {
      const dirName = path.basename(resolvedPath);

      // Determine destination layout.
      //
      // When the marketplace entry points at the *whole* resource folder
      // (e.g. `commands: ["./commands/"]`, deep-wiki style), the source
      // directory name matches the destination folder name and we want to
      // copy the directory's contents *flat* into destDir — otherwise we'd
      // end up with `tmpDir/commands/commands/...`.
      //
      // When the entry points at a sub-folder (e.g. `skills: ["./skills/xlsx"]`,
      // anthropics/skills style), we preserve the sub-folder name so each
      // entry lands at `tmpDir/skills/<sub>/`.
      //
      // Note: the caller (`convertClaudePluginPackage`) deletes destDir
      // before invoking us, so we always copy unconditionally; there is no
      // safe "already in the correct location" shortcut.
      const finalDestDir =
        dirName === destFolderName ? destDir : path.join(destDir, dirName);

      // Copy all files from the directory
      const files = await glob('**/*', {
        cwd: resolvedPath,
        nodir: true,
        dot: false,
      });

      for (const file of files) {
        const srcFile = path.join(resolvedPath, file);
        const destFile = path.join(finalDestDir, file);

        // Check if the source is a regular file (skip sockets, FIFOs, directories behind symlinks, etc.)
        try {
          const fileStat = fs.statSync(srcFile);
          if (!fileStat.isFile()) {
            debugLogger.debug(`Skipping non-regular file: ${srcFile}`);
            continue;
          }
        } catch {
          debugLogger.debug(`Failed to stat file, skipping: ${srcFile}`);
          continue;
        }

        // Ensure parent directory exists
        const destFileDir = path.dirname(destFile);
        if (!fs.existsSync(destFileDir)) {
          fs.mkdirSync(destFileDir, { recursive: true });
        }

        fs.copyFileSync(srcFile, destFile);
      }
    } else {
      // File entry (e.g. `agents: ["./agents/wiki-architect.md"]`).
      // Always copy — the caller has already cleared destDir, so the
      // file is missing even when the relative path looks like it's
      // "already in the destination folder".
      const fileName = path.basename(resolvedPath);
      const destFile = path.join(destDir, fileName);
      fs.copyFileSync(resolvedPath, destFile);
    }
  }
}

/**
 * Merges marketplace plugin config with the actual plugin.json config.
 * Marketplace config takes precedence for conflicting fields.
 * @param marketplacePlugin Marketplace plugin definition
 * @param pluginConfig Actual plugin.json config (optional if strict=false)
 * @returns Merged Claude plugin config
 */
export function mergeClaudeConfigs(
  marketplacePlugin: ClaudeMarketplacePluginConfig,
  pluginConfig?: ClaudePluginConfig,
): ClaudePluginConfig {
  if (!pluginConfig && marketplacePlugin.strict === true) {
    throw new Error(
      `Plugin ${marketplacePlugin.name} requires plugin.json (strict mode)`,
    );
  }

  // Start with plugin.json config (if exists)
  const merged: ClaudePluginConfig = pluginConfig
    ? { ...pluginConfig }
    : {
        name: marketplacePlugin.name,
        version: '1.0.0', // Default version if not in marketplace
      };

  // Overlay marketplace config (takes precedence)
  if (marketplacePlugin.name) merged.name = marketplacePlugin.name;
  if (marketplacePlugin.version) merged.version = marketplacePlugin.version;
  if (marketplacePlugin.description)
    merged.description = marketplacePlugin.description;
  if (marketplacePlugin.author) merged.author = marketplacePlugin.author;
  if (marketplacePlugin.homepage) merged.homepage = marketplacePlugin.homepage;
  if (marketplacePlugin.repository)
    merged.repository = marketplacePlugin.repository;
  if (marketplacePlugin.license) merged.license = marketplacePlugin.license;
  if (marketplacePlugin.keywords) merged.keywords = marketplacePlugin.keywords;
  if (marketplacePlugin.commands) merged.commands = marketplacePlugin.commands;
  if (marketplacePlugin.agents) merged.agents = marketplacePlugin.agents;
  if (marketplacePlugin.skills) merged.skills = marketplacePlugin.skills;
  if (marketplacePlugin.hooks) merged.hooks = marketplacePlugin.hooks;
  if (marketplacePlugin.mcpServers)
    merged.mcpServers = marketplacePlugin.mcpServers;
  if (marketplacePlugin.outputStyles)
    merged.outputStyles = marketplacePlugin.outputStyles;
  if (marketplacePlugin.lspServers)
    merged.lspServers = marketplacePlugin.lspServers;

  return merged;
}

/**
 * Checks if a config object is in Claude plugin format.
 * @param config Configuration object to check
 * @returns true if config appears to be Claude format
 */
export function isClaudePluginConfig(
  extensionDir: string,
  marketplace: { extensionSource: string; pluginName: string },
) {
  const marketplaceConfigFilePath = path.join(
    extensionDir,
    '.claude-plugin/marketplace.json',
  );
  if (!fs.existsSync(marketplaceConfigFilePath)) {
    return false;
  }

  const marketplaceConfigContent = fs.readFileSync(
    marketplaceConfigFilePath,
    'utf-8',
  );
  const marketplaceConfig = JSON.parse(marketplaceConfigContent);

  if (typeof marketplaceConfig !== 'object' || marketplaceConfig === null) {
    return false;
  }

  const marketplaceConfigObj = marketplaceConfig as Record<string, unknown>;

  // Must have name and owner
  if (
    typeof marketplaceConfigObj['name'] !== 'string' ||
    typeof marketplaceConfigObj['owner'] !== 'object'
  ) {
    return false;
  }

  if (!Array.isArray(marketplaceConfigObj['plugins'])) {
    return false;
  }

  const marketplacePluginObj = marketplaceConfigObj['plugins'].find(
    (plugin: ClaudeMarketplacePluginConfig) =>
      plugin.name === marketplace.pluginName,
  );

  if (!marketplacePluginObj) return false;

  return true;
}

/**
 * Resolve plugin source from marketplace plugin configuration.
 * Returns the absolute path to the plugin source directory.
 */
async function resolvePluginSource(
  pluginConfig: ClaudeMarketplacePluginConfig,
  marketplaceDir: string,
  pluginDir: string,
): Promise<string> {
  const source = pluginConfig.source;

  // Handle string source (relative path or URL)
  if (typeof source === 'string') {
    // Check if it's a URL
    if (source.startsWith('http://') || source.startsWith('https://')) {
      // Download from URL
      const installMetadata: ExtensionInstallMetadata = {
        source,
        type: 'git',
        originSource: 'Claude',
      };
      try {
        await downloadFromGitHubRelease(installMetadata, pluginDir);
      } catch {
        await cloneFromGit(installMetadata, pluginDir);
      }
      return pluginDir;
    }

    // Relative path within marketplace
    const pluginRoot = marketplaceDir;
    const sourcePath = path.join(pluginRoot, source);

    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Plugin source not found at ${sourcePath}`);
    }

    // If source path equals marketplace dir (source is '.' or ''),
    // return marketplaceDir directly to avoid copying to subdirectory of self
    if (path.resolve(sourcePath) === path.resolve(marketplaceDir)) {
      return marketplaceDir;
    }

    // Copy to plugin directory
    await fs.promises.cp(sourcePath, pluginDir, { recursive: true });
    return pluginDir;
  }

  // Handle object source (github or url)
  if (source.source === 'github') {
    const installMetadata: ExtensionInstallMetadata = {
      source: `https://github.com/${source.repo}`,
      type: 'git',
    };
    try {
      await downloadFromGitHubRelease(installMetadata, pluginDir);
    } catch {
      await cloneFromGit(installMetadata, pluginDir);
    }
    return pluginDir;
  }

  if (source.source === 'url') {
    const installMetadata: ExtensionInstallMetadata = {
      source: source.url,
      type: 'git',
    };
    try {
      await downloadFromGitHubRelease(installMetadata, pluginDir);
    } catch {
      await cloneFromGit(installMetadata, pluginDir);
    }
    return pluginDir;
  }

  if (source.source === 'git-subdir') {
    // The plugin lives in a subdirectory of a git repository. Clone the repo
    // (pinned to the provided ref/sha when present) and return the subdir.
    const installMetadata: ExtensionInstallMetadata = {
      source: source.url,
      type: 'git',
      // Prefer the immutable SHA pin when present; fall back to a named ref.
      ref: source.sha || source.ref,
      originSource: 'Claude',
    };
    await cloneFromGit(installMetadata, pluginDir);
    // `source.path` comes from an untrusted manifest. Confine it to the cloned
    // repo so a value like "../../.ssh" (or an absolute path) cannot escape.
    if (!source.path || source.path === '.' || path.isAbsolute(source.path)) {
      throw new Error(
        `Invalid plugin subdirectory "${source.path}" for ${source.url}`,
      );
    }
    const subDir = path.resolve(pluginDir, source.path);
    const repoRoot = path.resolve(pluginDir);
    if (!subDir.startsWith(repoRoot + path.sep)) {
      throw new Error(
        `Plugin subdirectory "${source.path}" escapes the repository root of ${source.url}`,
      );
    }
    if (!fs.existsSync(subDir)) {
      throw new Error(
        `Plugin subdirectory "${source.path}" not found in ${source.url} (ref: ${source.ref ?? source.sha ?? 'HEAD'})`,
      );
    }
    return subDir;
  }

  throw new Error(`Unsupported plugin source type: ${JSON.stringify(source)}`);
}
