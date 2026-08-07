/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MCPServerConfig } from '../config/config.js';
import type { ExtensionConfig } from './extensionManager.js';
import {
  buildQwenExtensionFromPlugin,
  normalizeClaudeMcpServer,
  resolvePluginRelativeFile,
  type ClaudePluginConfig,
} from './claude-converter.js';
import { realPathWithin } from './gemini-converter.js';
import { EXTENSIONS_CONFIG_FILENAME } from './variables.js';
import { stripAnsiAndControl } from '../utils/textUtils.js';

export const QODER_PLUGIN_MANIFEST = '.qoder-plugin/plugin.json';

type QoderPluginConfig = Omit<ClaudePluginConfig, 'version'> & {
  version?: string;
  displayName?: string;
  contextFileName?: string | string[];
};

function loadQoderConfig(extensionDir: string): QoderPluginConfig {
  const configPath = path.join(extensionDir, QODER_PLUGIN_MANIFEST);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Qoder plugin configuration not found at ${configPath}`);
  }
  if (!realPathWithin(configPath, extensionDir)) {
    throw new Error(
      `Qoder plugin configuration at ${configPath} resolves through a symlink outside the plugin`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (error) {
    throw new Error(
      stripAnsiAndControl(
        `Invalid Qoder plugin configuration at ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Invalid Qoder plugin configuration at ${configPath}: expected a JSON object`,
    );
  }

  const config = parsed as QoderPluginConfig;
  if (typeof config.name !== 'string' || config.name.length === 0) {
    throw new Error('Qoder plugin config must have name field');
  }
  return {
    ...config,
    version:
      typeof config.version === 'string' && config.version.length > 0
        ? config.version
        : '1.0.0',
  };
}

function loadMcpServersFile(
  extensionDir: string,
  relativePath: string,
  requireWrapper: boolean,
): Record<string, MCPServerConfig> | undefined {
  const mcpPath = resolvePluginRelativeFile(extensionDir, relativePath);
  if (!mcpPath || !fs.existsSync(mcpPath)) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
  } catch (error) {
    throw new Error(
      stripAnsiAndControl(
        `Invalid Qoder MCP configuration at ${mcpPath}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Invalid Qoder MCP configuration at ${mcpPath}: expected a JSON object`,
    );
  }
  const hasWrapper = Object.prototype.hasOwnProperty.call(parsed, 'mcpServers');
  const servers = hasWrapper
    ? (parsed as { mcpServers?: unknown }).mcpServers
    : requireWrapper
      ? undefined
      : parsed;
  if (
    typeof servers !== 'object' ||
    servers === null ||
    Array.isArray(servers)
  ) {
    throw new Error(
      `Invalid Qoder MCP configuration at ${mcpPath}: expected an "mcpServers" object`,
    );
  }

  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      normalizeClaudeMcpServer(server as MCPServerConfig),
    ]),
  );
}

function resolveMcpServers(
  extensionDir: string,
  configured: QoderPluginConfig['mcpServers'],
): Record<string, MCPServerConfig> | undefined {
  if (typeof configured === 'string') {
    return loadMcpServersFile(extensionDir, configured, false);
  }
  if (configured) {
    return configured;
  }
  return loadMcpServersFile(extensionDir, '.mcp.json', true);
}

function resolveContextFiles(
  extensionDir: string,
  configured: string | string[] | undefined,
): string[] | undefined {
  const configuredFiles = configured
    ? Array.isArray(configured)
      ? configured
      : [configured]
    : [];
  const contextFiles: string[] = [];
  const seen = new Set<string>();
  const addContextFile = (relativePath: string): void => {
    const resolved = resolvePluginRelativeFile(extensionDir, relativePath);
    if (!resolved || !fs.existsSync(resolved)) return;
    const normalized = path.relative(path.resolve(extensionDir), resolved);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      contextFiles.push(normalized);
    }
  };

  for (const file of configuredFiles) {
    if (typeof file === 'string') addContextFile(file);
  }
  addContextFile('system-prompt.md');
  if (contextFiles.length > 0) {
    const qwenPath = resolvePluginRelativeFile(extensionDir, 'QWEN.md');
    if (qwenPath && fs.existsSync(qwenPath)) {
      const normalized = path.relative(path.resolve(extensionDir), qwenPath);
      if (normalized && !seen.has(normalized)) {
        contextFiles.unshift(normalized);
      }
    }
  }
  return contextFiles.length > 0 ? contextFiles : undefined;
}

export async function convertQoderPlugin(
  extensionDir: string,
): Promise<{ config: ExtensionConfig; convertedDir: string }> {
  const config = loadQoderConfig(extensionDir);
  config.mcpServers = resolveMcpServers(extensionDir, config.mcpServers);
  const contextFileName = resolveContextFiles(
    extensionDir,
    config.contextFileName,
  );
  const converted = await buildQwenExtensionFromPlugin(
    extensionDir,
    config as ClaudePluginConfig,
  );
  const qwenConfig: ExtensionConfig = {
    ...converted.config,
    displayName: config.displayName,
    contextFileName,
  };
  fs.writeFileSync(
    path.join(converted.convertedDir, EXTENSIONS_CONFIG_FILENAME),
    JSON.stringify(qwenConfig, null, 2),
    'utf-8',
  );
  return { ...converted, config: qwenConfig };
}
