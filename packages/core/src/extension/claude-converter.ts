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
  isRegularFile,
  realPathWithin,
  readExtensionManifest,
  readExtraJsonFile,
  resolvePathWithin,
  resolvePluginRelativeFile,
} from './path-confinement.js';
import {
  parse as parseYaml,
  stringify as stringifyYaml,
} from '../utils/yaml-parser.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { normalizeContent, stripAnsiAndControl } from '../utils/textUtils.js';
import {
  AGENT_PLUGIN_MANIFEST,
  getAgentPluginSchemaStatus,
} from './agent-plugins-v1/manifest.js';

const debugLogger = createDebugLogger('CLAUDE_CONVERTER');

/** Alias for `stripAnsiAndControl` so call sites read as error-context. */
const sanitizeForError = stripAnsiAndControl;

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
  TodoWrite: 'TodoList',
  WebFetch: 'WebFetch',
  WebSearch: 'WebSearch',
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
 * Maps a single Claude `.mcp.json` server entry to Qwen's MCPServerConfig shape.
 * Claude discriminates transport with a `type` field (`http`/`sse`/`stdio`),
 * whereas Qwen keys off which field is set: `httpUrl` (streamable HTTP),
 * `url` (SSE) or `command` (stdio). A Claude `type: 'http'` entry therefore has
 * to move its `url` to `httpUrl`. Qwen reserves `type` for `'sdk'`, so any other
 * `type` value (Claude's transport discriminator) is dropped while `'sdk'` —
 * which `isSdkMcpServerConfig` depends on — is always preserved.
 */
export function normalizeClaudeMcpServer(
  raw: MCPServerConfig,
): MCPServerConfig {
  const server = raw as unknown as Record<string, unknown>;
  // stdio / already-Qwen-shaped configs pass through; only a non-sdk `type`
  // (Claude's transport discriminator) is stripped.
  if (server['command'] || server['httpUrl'] || server['tcp']) {
    if (server['type'] === undefined || server['type'] === 'sdk') {
      return raw;
    }
    const rest = { ...server };
    delete rest['type'];
    return rest as unknown as MCPServerConfig;
  }
  if (typeof server['url'] === 'string') {
    const rest = { ...server };
    delete rest['url'];
    if (rest['type'] !== 'sdk') {
      delete rest['type'];
    }
    return {
      ...rest,
      ...(server['type'] === 'http'
        ? { httpUrl: server['url'] }
        : { url: server['url'] }),
    } as unknown as MCPServerConfig;
  }
  return raw;
}

/**
 * Maps a set of MCP server entries to Qwen's MCPServerConfig shape, rejecting a
 * non-object entry with a precise error instead of a bare deref TypeError.
 * Shared across the Claude/Qoder/Gemini converters so unrelated manifests get
 * the same server-entry validation. `configPath` names the source for errors.
 * @see normalizeClaudeMcpServer for the per-server transport mapping.
 */
export function normalizeMcpServers(
  servers: Record<string, unknown>,
  configPath: string,
): Record<string, MCPServerConfig> {
  // Object.create(null) so a server literally named `__proto__` becomes a real
  // entry instead of mutating the result's prototype (a plain `{}` + assignment
  // would silently drop it).
  const normalized: Record<string, MCPServerConfig> = Object.create(null);
  for (const [name, raw] of Object.entries(servers)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(
        `Invalid MCP configuration at ${sanitizeForError(configPath)}: server entries must be JSON objects`,
      );
    }
    normalized[name] = normalizeClaudeMcpServer(raw as MCPServerConfig);
  }
  return normalized;
}

/**
 * Validates the top-level mcpServers field is an object container (not
 * array / null / scalar) and returns it narrowed for normalizeMcpServers.
 */
export function assertMcpServersContainer(
  value: unknown,
  errorMessage: string,
  serverName?: string,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(
      serverName
        ? `Invalid MCP server "${stripAnsiAndControl(serverName)}": ${errorMessage}`
        : errorMessage,
    );
  }
  return value as Record<string, unknown>;
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
      const servers = assertMcpServersContainer(
        claudeConfig.mcpServers,
        'Invalid MCP configuration: mcpServers must be an object',
        claudeConfig.name,
      );
      if (servers) {
        mcpServers = normalizeMcpServers(
          servers,
          stripAnsiAndControl(claudeConfig.name),
        );
      }
    }
  }

  // Parse hooks
  let hooks: ExtensionConfig['hooks'] | undefined;
  if (claudeConfig.hooks) {
    if (typeof claudeConfig.hooks === 'string') {
      // Keep the string path; the hook file is loaded at runtime (see loadExtension).
      hooks = claudeConfig.hooks;
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
  networkPolicy?: ExtensionInstallMetadata['networkPolicy'],
  signal?: AbortSignal,
): Promise<{
  config: ExtensionConfig;
  convertedDir: string;
  externalContent: boolean;
}> {
  signal?.throwIfAborted();
  // Step 1: Load marketplace.json. readExtensionManifest throws on a symlink
  // escape or unparseable body, and returns null when absent.
  const marketplaceConfig = readExtensionManifest(
    extensionDir,
    '.claude-plugin/marketplace.json',
  ) as ClaudeMarketplaceConfig | null;
  if (!marketplaceConfig) {
    throw new Error(
      `Marketplace configuration not found at ${path.join(extensionDir, '.claude-plugin', 'marketplace.json')}`,
    );
  }

  // Find the target plugin in marketplace. Validate the `plugins` shape
  // with the same predicate `isClaudePluginConfig` uses for the
  // classifier — without it, a single null entry in the array
  // (`[null, {name, source}]`) dereferences `null.name` and throws
  // an opaque TypeError instead of the precise "not found" error.
  if (!Array.isArray(marketplaceConfig.plugins)) {
    throw new Error(
      `Invalid marketplace.json at ${path.join(extensionDir, '.claude-plugin', 'marketplace.json')}: 'plugins' must be an array`,
    );
  }
  const marketplacePlugin = marketplaceConfig.plugins.find(
    (p) =>
      typeof p === 'object' &&
      p !== null &&
      (p as { name?: string }).name === pluginName,
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

  const { pluginSource, externalContent } = await resolvePluginSource(
    marketplacePlugin,
    extensionDir,
    pluginDir,
    networkPolicy,
    signal,
  );

  // When the source resolves to the marketplace dir itself (source "."), the
  // pluginDir was created but never used — remove the empty directory.
  if (pluginSource !== pluginDir) {
    try {
      await fs.promises.rmdir(pluginDir);
    } catch {
      // Non-empty or already removed; leave it alone.
    }
  }

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
  const safePluginJsonPath = sanitizeForError(pluginJsonPath);
  if (strict && !fs.existsSync(pluginJsonPath)) {
    throw new Error(
      `Strict mode requires plugin.json at ${safePluginJsonPath}`,
    );
  }
  // Treat a symlinked plugin.json (pointing outside the source) as absent
  // rather than reading an arbitrary host file into the merged config.
  const pluginJsonSafe =
    fs.existsSync(pluginJsonPath) &&
    realPathWithin(pluginJsonPath, pluginSource);
  if (pluginJsonSafe) {
    // readExtensionManifest throws on a symlink escape or unparseable
    // body (including a parseable-but-non-object body — `null`,
    // array, scalar). The existsSync/realPathWithin above already
    // confined symlink escapes, so the remaining throw kinds here are
    // parse-error and non-object-body. For non-strict plugins the
    // merge base tolerated these by overlaying the marketplace entry
    // via mergeClaudeConfigs; restore that contract.
    let pluginConfig: Record<string, unknown> | null = null;
    try {
      pluginConfig = readExtensionManifest(
        pluginSource,
        '.claude-plugin/plugin.json',
      );
    } catch (err) {
      if (strict) {
        throw err;
      }
      const reason = sanitizeForError(
        err instanceof Error ? err.message : String(err),
      );
      debugLogger.warn(
        `Falling back to marketplace entry for ${safePluginJsonPath}: ${reason}`,
      );
    }
    if (pluginConfig) {
      mergedConfig = mergeClaudeConfigs(
        marketplacePlugin,
        pluginConfig as unknown as ClaudePluginConfig,
      );
    } else {
      mergedConfig = marketplacePlugin as ClaudePluginConfig;
    }
  } else {
    // `existsSync` follows symlinks, so the strict check earlier in this
    // function passes when plugin.json is a symlink to an existing host file
    // — but the file is not trusted (`realPathWithin` rejected it). Strict
    // mode must fail here rather than silently fall back to the marketplace
    // entry.
    if (strict) {
      throw new Error(
        `Strict mode requires a trusted plugin.json at ${safePluginJsonPath}`,
      );
    }
    if (fs.existsSync(pluginJsonPath)) {
      debugLogger.warn(
        `Ignoring plugin.json at ${safePluginJsonPath}; it resolves through a symlink outside the plugin.`,
      );
    }
    mergedConfig = marketplacePlugin as ClaudePluginConfig;
  }

  const converted = await buildQwenExtensionFromPlugin(
    pluginSource,
    mergedConfig,
  );
  // Remove root plugin.json if the converted tree still resolves as an
  // Agent-Plugins package — it would shadow the Claude manifest at install.
  if (getAgentPluginSchemaStatus(converted.convertedDir) !== 'unrelated') {
    await fs.promises.rm(
      path.join(converted.convertedDir, AGENT_PLUGIN_MANIFEST),
      { force: true },
    );
  }
  return { ...converted, externalContent };
}

/**
 * Builds a converted Qwen extension directory from a resolved Claude plugin
 * source directory and its merged config. Shared by the marketplace-based
 * (`convertClaudePluginPackage`) and standalone (`convertClaudePluginStandalone`)
 * conversion paths.
 */
export async function buildQwenExtensionFromPlugin(
  pluginSource: string,
  mergedConfig: ClaudePluginConfig,
): Promise<{ config: ExtensionConfig; convertedDir: string }> {
  // Resolve MCP servers from a JSON file path if needed. A subsidiary file:
  // missing/unparseable/escaping values are tolerated (warn inside
  // readExtraJsonFile) rather than failing the extension. readExtraJsonFile
  // confines the path (absolute within the plugin, or relative with ../ and
  // symlink checks) the same way across converters.
  if (mergedConfig.mcpServers && typeof mergedConfig.mcpServers === 'string') {
    const mcp = readExtraJsonFile(pluginSource, mergedConfig.mcpServers);
    if (mcp) {
      mergedConfig.mcpServers = mcp as Record<string, MCPServerConfig>;
    } else {
      // Drop the reference so the downstream "MCP servers path not yet
      // supported" message in convertClaudeToQwenConfig doesn't mislead.
      debugLogger.warn(
        `Referenced MCP servers file "${sanitizeForError(mergedConfig.mcpServers)}" could not be read; dropping.`,
      );
      delete mergedConfig.mcpServers;
    }
  }

  // Confine a hooks string path to the plugin the same way as mcpServers, so
  // an absolute or `../`-laden value can't point at a file outside it. A
  // directory-valued reference (an easy authoring slip) must also be dropped –
  // it can never load and would shadow a co-shipped default hooks/hooks.json.
  if (mergedConfig.hooks && typeof mergedConfig.hooks === 'string') {
    const resolvedHooks = resolvePluginRelativeFile(
      pluginSource,
      mergedConfig.hooks,
    );
    if (!resolvedHooks || !isRegularFile(resolvedHooks)) {
      debugLogger.warn(
        `Dropping hooks path "${sanitizeForError(mergedConfig.hooks)}" that is not a usable regular file inside the plugin; the hooks reference is ignored and a co-shipped hooks/hooks.json (if present) loads instead.`,
      );
      delete mergedConfig.hooks;
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

    // A hooks string path was confined earlier, but the resource collection
    // above may have removed the file it points at (e.g. a hooks file inside
    // a skills/ folder that was selectively re-collected). Drop it when the
    // referenced file no longer ships, so the installed extension doesn't
    // advertise hooks that can never load.
    if (mergedConfig.hooks && typeof mergedConfig.hooks === 'string') {
      const hooksFilePath = path.join(tmpDir, mergedConfig.hooks);
      if (!isRegularFile(hooksFilePath)) {
        debugLogger.warn(
          `Dropping hooks path "${sanitizeForError(mergedConfig.hooks)}" whose file was removed or is not a regular file during resource collection; the hooks reference is ignored and a co-shipped hooks/hooks.json (if present) loads instead.`,
        );
        delete mergedConfig.hooks;
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
  // readExtensionManifest throws on a symlink escape, unparseable body, or
  // non-object body; returns null when absent.
  const parsedConfig = readExtensionManifest(
    extensionDir,
    '.claude-plugin/plugin.json',
  );
  if (!parsedConfig) {
    throw new Error(
      `Plugin configuration not found at ${path.join(extensionDir, '.claude-plugin', 'plugin.json')}`,
    );
  }
  const mergedConfig = parsedConfig as unknown as ClaudePluginConfig;

  if (!mergedConfig.mcpServers) {
    // .mcp.json is a subsidiary file: a missing/unparseable/escaping value is
    // tolerated (warn inside readExtraJsonFile) rather than failing the install.
    const mcp = readExtraJsonFile(extensionDir, '.mcp.json');
    if (
      mcp?.['mcpServers'] &&
      typeof mcp['mcpServers'] === 'object' &&
      !Array.isArray(mcp['mcpServers'])
    ) {
      mergedConfig.mcpServers = mcp['mcpServers'] as Record<
        string,
        MCPServerConfig
      >;
    } else if (mcp) {
      // Authoring slip: server map at top level instead of under
      // mcpServers. Debug-only warn so the "no servers imported"
      // investigation has a trail (matches the qoder converter's
      // loadMcpServersFile convention for the same typo-wrapper case).
      debugLogger.warn(
        `.mcp.json at ${sanitizeForError(path.join(extensionDir, '.mcp.json'))} has no valid "mcpServers" object; skipping.`,
      );
    }
  }

  const result = await buildQwenExtensionFromPlugin(extensionDir, mergedConfig);
  // Remove root plugin.json if the converted tree still resolves as an
  // Agent-Plugins package — it would shadow the Claude manifest at install.
  if (getAgentPluginSchemaStatus(result.convertedDir) !== 'unrelated') {
    await fs.promises.rm(
      path.join(result.convertedDir, AGENT_PLUGIN_MANIFEST),
      {
        force: true,
      },
    );
  }
  return result;
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
    // Resource paths come from an untrusted manifest; confine them to the
    // plugin so a value like "/etc/ssh" or "../../secrets" can't be copied in.
    const resolvedPath = resolvePluginRelativeFile(pluginRoot, resourcePath);
    if (!resolvedPath) continue;

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
          // A symlink inside the resource folder can point its target outside
          // the plugin; statSync would follow it and copy the host file. Skip
          // any symlink whose real target escapes the resource directory.
          const fileLstat = fs.lstatSync(srcFile);
          if (
            fileLstat.isSymbolicLink() &&
            !realPathWithin(srcFile, resolvedPath)
          ) {
            debugLogger.warn(
              `Skipping symlink that escapes the plugin: ${srcFile}`,
            );
            continue;
          }
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
 * Classifies a directory as a Claude plugin: `'marketplace'` when a plugin
 * named `pluginName` is listed, `'standalone'` when a valid plugin.json exists,
 * or `null` when neither applies. An explicitly requested pluginName that is
 * absent, or a defective plugin.json, throws the precise error.
 * @param extensionDir The extension directory to check
 * @param pluginName When provided, checks the marketplace for this plugin;
 *   otherwise probes for a standalone plugin.
 * @returns `'marketplace'`, `'standalone'`, or `null` when no Claude plugin.
 */
export function isClaudePluginConfig(
  extensionDir: string,
  pluginName?: string,
): 'standalone' | 'marketplace' | null {
  // pluginName given = user explicitly chose a plugin. Any miss is a hard
  // error (never fall through to another manifest), so collect every reason
  // and throw one precise diagnostic.
  if (pluginName) {
    const m = readExtensionManifest(
      extensionDir,
      '.claude-plugin/marketplace.json',
    );
    const reasons: string[] = [];
    if (
      m &&
      Array.isArray(m['plugins']) &&
      m['plugins'].some(
        (p) =>
          typeof p === 'object' &&
          p !== null &&
          (p as { name?: string }).name === pluginName,
      )
    ) {
      return 'marketplace';
    }
    reasons.push(
      m
        ? `marketplace.json does not list "${sanitizeForError(pluginName)}"`
        : 'marketplace.json is absent',
    );

    const p = readExtensionManifest(extensionDir, '.claude-plugin/plugin.json');
    if (p) {
      const actualName =
        typeof p['name'] === 'string' ? p['name'] : '(missing "name")';
      if (actualName === pluginName) {
        return 'standalone';
      }
      reasons.push(
        `standalone plugin.json is named "${sanitizeForError(actualName)}"`,
      );
    } else {
      reasons.push('standalone plugin.json is absent');
    }
    throw new Error(
      `Plugin "${sanitizeForError(pluginName)}" not found: ${reasons.join('; ')}`,
    );
  }
  // No pluginName = probe a single-source standalone plugin.
  const p = readExtensionManifest(extensionDir, '.claude-plugin/plugin.json');
  if (p) {
    if (typeof p['name'] !== 'string') {
      throw new Error('Invalid .claude-plugin/plugin.json: missing "name"');
    }
    return 'standalone';
  }
  return null;
}

/**
 * Resolve plugin source from marketplace plugin configuration.
 * Returns the absolute path to the plugin source directory and whether the
 * plugin content was fetched from a source external to the marketplace
 * repository (in which case the marketplace clone's commit does not describe
 * the installed content).
 */
async function resolvePluginSource(
  pluginConfig: ClaudeMarketplacePluginConfig,
  marketplaceDir: string,
  pluginDir: string,
  networkPolicy?: ExtensionInstallMetadata['networkPolicy'],
  signal?: AbortSignal,
): Promise<{ pluginSource: string; externalContent: boolean }> {
  signal?.throwIfAborted();
  const source = pluginConfig.source;

  // Handle string source (relative path or URL)
  if (typeof source === 'string') {
    // Check if it's a URL (scheme is case-insensitive, e.g. HTTPS://)
    const lowerSource = source.toLowerCase();
    if (
      lowerSource.startsWith('http://') ||
      lowerSource.startsWith('https://')
    ) {
      // Download from URL
      const installMetadata: ExtensionInstallMetadata = {
        source,
        type: 'git',
        originSource: 'Claude',
        networkPolicy,
      };
      try {
        await downloadFromGitHubRelease(installMetadata, pluginDir, signal);
      } catch {
        signal?.throwIfAborted();
        await cloneFromGit(installMetadata, pluginDir, signal);
      }
      return { pluginSource: pluginDir, externalContent: true };
    }

    // Relative path within marketplace. Confine it: a manifest source like
    // "../../../../etc/ssh" must not resolve outside the marketplace dir.
    // resolvePathWithin rejects absolute/escaping/symlink-escaping sources.
    const sourcePath = resolvePathWithin(marketplaceDir, source, (kind) =>
      kind === 'absolute'
        ? `Plugin source "${sanitizeForError(source)}" is an absolute path; only paths relative to the marketplace directory are allowed`
        : kind === 'symlink-escape'
          ? `Plugin source "${sanitizeForError(source)}" resolves through a symlink outside the marketplace directory`
          : `Plugin source "${sanitizeForError(source)}" escapes the marketplace directory`,
    );

    if (!fs.existsSync(sourcePath)) {
      throw new Error(
        `Plugin source not found at ${sanitizeForError(sourcePath)}`,
      );
    }

    // If source path equals marketplace dir (source is '.' or ''), or a
    // subdir whose symlink target IS the marketplace dir, return
    // marketplaceDir directly to avoid copying a directory into
    // itself. The lexical containment check alone misses the
    // symlink-to-root case: `fs.promises.cp` would then crash with a
    // raw SystemError because the source and the destination resolve to
    // the same path.
    const realMarketplaceDir = fs.realpathSync(marketplaceDir);
    let realSourcePath: string;
    try {
      realSourcePath = fs.realpathSync(sourcePath);
    } catch {
      realSourcePath = sourcePath;
    }
    if (
      sourcePath === path.resolve(marketplaceDir) ||
      realSourcePath === realMarketplaceDir
    ) {
      return { pluginSource: marketplaceDir, externalContent: false };
    }

    // Copy to plugin directory
    await fs.promises.cp(sourcePath, pluginDir, { recursive: true });
    return { pluginSource: pluginDir, externalContent: false };
  }

  // Handle object source (github or url)
  if (source.source === 'github') {
    const installMetadata: ExtensionInstallMetadata = {
      source: `https://github.com/${source.repo}`,
      type: 'git',
      networkPolicy,
    };
    try {
      await downloadFromGitHubRelease(installMetadata, pluginDir, signal);
    } catch {
      signal?.throwIfAborted();
      await cloneFromGit(installMetadata, pluginDir, signal);
    }
    return { pluginSource: pluginDir, externalContent: true };
  }

  if (source.source === 'url') {
    const installMetadata: ExtensionInstallMetadata = {
      source: source.url,
      type: 'git',
      networkPolicy,
    };
    try {
      await downloadFromGitHubRelease(installMetadata, pluginDir, signal);
    } catch {
      signal?.throwIfAborted();
      await cloneFromGit(installMetadata, pluginDir, signal);
    }
    return { pluginSource: pluginDir, externalContent: true };
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
      networkPolicy,
    };
    await cloneFromGit(installMetadata, pluginDir, signal);
    // `source.path` comes from an untrusted manifest. Confine it to the cloned
    // repo so a value like "../../.ssh" (or an absolute path) cannot escape.
    if (!source.path) {
      throw new Error(
        `Invalid plugin subdirectory "${sanitizeForError(String(source.path))}" for ${sanitizeForError(source.url)}`,
      );
    }
    // resolvePathWithin rejects an absolute path, a value escaping the repo
    // root, and a subdir that resolves through a symlink outside it.
    const subDir = resolvePathWithin(pluginDir, source.path, (kind) =>
      kind === 'absolute'
        ? `Invalid plugin subdirectory "${sanitizeForError(source.path)}" for ${sanitizeForError(source.url)}`
        : kind === 'symlink-escape'
          ? `Plugin subdirectory "${sanitizeForError(source.path)}" resolves through a symlink outside the repository root of ${sanitizeForError(source.url)}`
          : `Plugin subdirectory "${sanitizeForError(source.path)}" escapes the repository root of ${sanitizeForError(source.url)}`,
    );
    // Reject any value that resolves to the clone root itself, including
    // the case where the subdir's symlink target IS the root (realpath
    // collapses to pluginDir even though the lexical name is a subdir).
    if (subDir === path.resolve(pluginDir)) {
      throw new Error(
        `Invalid plugin subdirectory "${sanitizeForError(source.path)}" for ${sanitizeForError(source.url)}`,
      );
    }
    let realSubDir: string;
    try {
      realSubDir = fs.realpathSync(subDir);
    } catch {
      realSubDir = subDir;
    }
    if (realSubDir === fs.realpathSync(pluginDir)) {
      throw new Error(
        `Invalid plugin subdirectory "${sanitizeForError(source.path)}" for ${sanitizeForError(source.url)}`,
      );
    }
    if (!fs.existsSync(subDir)) {
      throw new Error(
        `Plugin subdirectory "${sanitizeForError(source.path)}" not found in ${sanitizeForError(source.url)} (ref: ${sanitizeForError(source.ref ?? source.sha ?? 'HEAD')})`,
      );
    }
    return { pluginSource: subDir, externalContent: true };
  }

  throw new Error(`Unsupported plugin source type: ${JSON.stringify(source)}`);
}
