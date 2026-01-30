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
import { cloneFromGit, downloadFromGitHubRelease } from './github.js';
import { createHash } from 'node:crypto';
import { copyDirectory } from './gemini-converter.js';
import {
  parse as parseYaml,
  stringify as stringifyYaml,
} from '../utils/yaml-parser.js';

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
  hooks?: string;
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
  /** Hooks configuration */
  hooks?: unknown;
  /** System prompt content */
  systemPrompt?: string;
  /** subagent color */
  color?: string;
}

export type ClaudePluginSource =
  | { source: 'github'; repo: string }
  | { source: 'url'; url: string };

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
  AskUserQuestion: 'None',
  Bash: 'Shell',
  BashOutput: 'None',
  Edit: 'Edit',
  ExitPlanMode: 'ExitPlanMode',
  Glob: 'Glob',
  Grep: 'Grep',
  KillShell: 'None',
  NotebookEdit: 'None',
  Read: ['ReadFile', 'ReadManyFiles'],
  Skill: 'Skill',
  Task: 'Task',
  TodoWrite: 'TodoWrite',
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

  // Convert model to modelConfig
  if (claudeAgent.model) {
    // Map Claude model names to Qwen model config
    // Claude uses: sonnet, opus, haiku, inherit
    // We preserve the model name for now, the actual mapping will be handled at runtime
    qwenAgent['modelConfig'] = {
      model: claudeAgent.model === 'inherit' ? undefined : claudeAgent.model,
    };
  }

  // Preserve unsupported fields as-is for potential future compatibility
  // These fields are not supported by Qwen Code SubagentConfig but we keep them
  if (claudeAgent.permissionMode) {
    qwenAgent['permissionMode'] = claudeAgent.permissionMode;
  }
  if (claudeAgent.hooks) {
    qwenAgent['hooks'] = claudeAgent.hooks;
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

      // Parse frontmatter
      const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
      const match = content.match(frontmatterRegex);

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
        hooks: frontmatter['hooks'],
        color: frontmatter['color'] as string | undefined,
        systemPrompt: body.trim(),
      };

      // Convert to Qwen format
      const qwenAgent = convertClaudeAgentConfig(claudeAgent);

      // Build new frontmatter (excluding systemPrompt as it goes in body)
      const newFrontmatter: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(qwenAgent)) {
        if (key !== 'systemPrompt' && value !== undefined) {
          newFrontmatter[key] = value;
        }
      }

      // Write converted content back
      const newYaml = stringifyYaml(newFrontmatter);
      const systemPrompt = (qwenAgent['systemPrompt'] as string) || body.trim();
      const newContent = `---
${newYaml}
---

${systemPrompt}
`;

      await fs.promises.writeFile(filePath, newContent, 'utf-8');
    } catch (error) {
      console.warn(
        `[Claude Converter] Failed to convert agent file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
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
      console.warn(
        `[Claude Converter] MCP servers path not yet supported: ${claudeConfig.mcpServers}`,
      );
    } else {
      mcpServers = claudeConfig.mcpServers;
    }
  }

  // Warn about unsupported fields
  if (claudeConfig.hooks) {
    console.warn(
      `[Claude Converter] Hooks are not yet supported in ${claudeConfig.name}`,
    );
  }
  if (claudeConfig.outputStyles) {
    console.warn(
      `[Claude Converter] Output styles are not yet supported in ${claudeConfig.name}`,
    );
  }
  // Direct field mapping - commands, skills, agents will be collected as folders
  return {
    name: claudeConfig.name,
    version: claudeConfig.version,
    mcpServers,
    lspServers: claudeConfig.lspServers,
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

  if (strict) {
    const pluginJsonPath = path.join(
      pluginSource,
      '.claude-plugin',
      'plugin.json',
    );
    if (!fs.existsSync(pluginJsonPath)) {
      throw new Error(`Strict mode requires plugin.json at ${pluginJsonPath}`);
    }
    const pluginContent = fs.readFileSync(pluginJsonPath, 'utf-8');
    const pluginConfig: ClaudePluginConfig = JSON.parse(pluginContent);
    mergedConfig = mergeClaudeConfigs(marketplacePlugin, pluginConfig);
  } else {
    mergedConfig = marketplacePlugin as ClaudePluginConfig;
  }

  // Step 4: Resolve MCP servers from JSON files if needed
  if (mergedConfig.mcpServers && typeof mergedConfig.mcpServers === 'string') {
    const mcpServersPath = path.isAbsolute(mergedConfig.mcpServers)
      ? mergedConfig.mcpServers
      : path.join(pluginSource, mergedConfig.mcpServers);

    if (fs.existsSync(mcpServersPath)) {
      try {
        const mcpContent = fs.readFileSync(mcpServersPath, 'utf-8');
        mergedConfig.mcpServers = JSON.parse(mcpContent) as Record<
          string,
          MCPServerConfig
        >;
      } catch (error) {
        console.warn(
          `Failed to parse MCP servers file ${mcpServersPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // Step 5: Create temporary directory for converted extension
  const tmpDir = await ExtensionStorage.createTmpDir();

  try {
    // Step 6: Copy plugin files to temporary directory
    await copyDirectory(pluginSource, tmpDir);

    // Step 6.1: Handle commands/skills/agents folders based on configuration
    // If configuration specifies resources, only collect those
    // If configuration doesn't specify, keep the existing folder (if exists)
    const resourceConfigs = [
      { name: 'commands', config: mergedConfig.commands },
      { name: 'skills', config: mergedConfig.skills },
      { name: 'agents', config: mergedConfig.agents },
    ];

    for (const { name, config } of resourceConfigs) {
      const folderPath = path.join(tmpDir, name);
      const sourceFolderPath = path.join(pluginSource, name);

      // If config explicitly specifies resources, remove existing folder and collect only specified ones
      if (config) {
        if (fs.existsSync(folderPath)) {
          fs.rmSync(folderPath, { recursive: true, force: true });
        }
        await collectResources(config, pluginSource, folderPath);
      }
      // If config doesn't specify and source folder doesn't exist in pluginSource,
      // remove it from tmpDir (it was copied but not needed)
      else if (!fs.existsSync(sourceFolderPath) && fs.existsSync(folderPath)) {
        fs.rmSync(folderPath, { recursive: true, force: true });
      }
      // Otherwise, keep the existing folder from pluginSource (default behavior)
    }

    // Step 9.1: Convert collected agent files from Claude format to Qwen format
    const agentsDestDir = path.join(tmpDir, 'agents');
    await convertAgentFiles(agentsDestDir);

    // Step 10: Convert to Qwen format config
    const qwenConfig = convertClaudeToQwenConfig(mergedConfig);

    // Step 11: Write qwen-extension.json
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
    // Clean up temporary directory on error
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Collects resources (commands, skills, agents) to a destination folder.
 * If a resource is already in the destination folder, it will be skipped.
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
      console.warn(`Resource path not found: ${resolvedPath}`);
      continue;
    }

    const stat = fs.statSync(resolvedPath);

    if (stat.isDirectory()) {
      // If it's a directory, check if it's already the destination folder
      const dirName = path.basename(resolvedPath);
      const parentDir = path.dirname(resolvedPath);

      // If the directory is already named as the destination folder (e.g., 'commands')
      // and it's at the plugin root level, skip it
      if (dirName === destFolderName && parentDir === pluginRoot) {
        console.log(
          `Skipping ${resolvedPath} as it's already in the correct location`,
        );
        continue;
      }

      // Determine destination: preserve the directory name
      // e.g., ./skills/xlsx -> tmpDir/skills/xlsx/
      const finalDestDir = path.join(destDir, dirName);

      // Copy all files from the directory
      const files = await glob('**/*', {
        cwd: resolvedPath,
        nodir: true,
        dot: false,
      });

      for (const file of files) {
        const srcFile = path.join(resolvedPath, file);
        const destFile = path.join(finalDestDir, file);

        // Ensure parent directory exists
        const destFileDir = path.dirname(destFile);
        if (!fs.existsSync(destFileDir)) {
          fs.mkdirSync(destFileDir, { recursive: true });
        }

        fs.copyFileSync(srcFile, destFile);
      }
    } else {
      // If it's a file, check if it's already in the destination folder
      const relativePath = path.relative(pluginRoot, resolvedPath);

      // Check if the file path starts with the destination folder name
      // e.g., 'commands/test1.md' or 'commands/me/test.md' should be skipped
      const segments = relativePath.split(path.sep);
      if (segments.length > 0 && segments[0] === destFolderName) {
        console.log(
          `Skipping ${resolvedPath} as it's already in ${destFolderName}/`,
        );
        continue;
      }

      // Copy the file to destination
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
  marketplace: { marketplaceSource: string; pluginName: string },
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

  throw new Error(`Unsupported plugin source type: ${JSON.stringify(source)}`);
}
