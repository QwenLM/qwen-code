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
  type ClaudePluginConfig,
} from './claude-converter.js';
import { isPathWithin, realPathWithin } from './gemini-converter.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { EXTENSIONS_CONFIG_FILENAME } from './variables.js';

export const QODER_PLUGIN_MANIFEST = '.qoder-plugin/plugin.json';
const debugLogger = createDebugLogger('QODER_CONVERTER');

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

  const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
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

function loadRootMcpServers(
  extensionDir: string,
): Record<string, MCPServerConfig> | undefined {
  const mcpPath = path.join(extensionDir, '.mcp.json');
  if (!fs.existsSync(mcpPath) || !realPathWithin(mcpPath, extensionDir)) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
  } catch (error) {
    debugLogger.warn(
      `Failed to parse .mcp.json at ${mcpPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (
    typeof servers !== 'object' ||
    servers === null ||
    Array.isArray(servers)
  ) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      normalizeClaudeMcpServer(server as MCPServerConfig),
    ]),
  );
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
  const hasConfiguredFiles = configuredFiles.length > 0;
  const root = path.resolve(extensionDir);
  const contextFiles = hasConfiguredFiles
    ? [
        ...new Set(
          configuredFiles.filter((file) => {
            if (typeof file !== 'string' || path.isAbsolute(file)) return false;
            const resolved = path.resolve(extensionDir, file);
            return (
              isPathWithin(resolved, root) &&
              fs.existsSync(resolved) &&
              realPathWithin(resolved, extensionDir)
            );
          }),
        ),
      ]
    : fs.existsSync(path.join(extensionDir, 'QWEN.md')) &&
        realPathWithin(path.join(extensionDir, 'QWEN.md'), extensionDir)
      ? ['QWEN.md']
      : [];
  const systemPromptPath = path.join(extensionDir, 'system-prompt.md');
  if (
    fs.existsSync(systemPromptPath) &&
    realPathWithin(systemPromptPath, extensionDir) &&
    !contextFiles.includes('system-prompt.md')
  ) {
    contextFiles.push('system-prompt.md');
  }
  return contextFiles.length > 0 ? contextFiles : undefined;
}

export async function convertQoderPlugin(
  extensionDir: string,
): Promise<{ config: ExtensionConfig; convertedDir: string }> {
  const config = loadQoderConfig(extensionDir);
  if (!config.mcpServers) {
    config.mcpServers = loadRootMcpServers(extensionDir);
  }
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
