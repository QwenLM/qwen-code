/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXTENSIONS_CONFIG_FILENAME } from './variables.js';
import {
  convertGeminiExtensionPackage,
  isGeminiExtensionConfig,
} from './gemini-converter.js';
import {
  convertClaudePluginPackage,
  convertClaudePluginStandalone,
  isClaudePluginConfig,
} from './claude-converter.js';
import {
  convertQoderPlugin,
  QODER_PLUGIN_MANIFEST,
} from './qoder-converter.js';
import type {
  ExtensionNetworkPolicy,
  ExtensionOriginSource,
} from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  AGENT_PLUGIN_SCHEMA,
  getAgentPluginSchemaStatus,
} from './agent-plugins-v1/manifest.js';

const debugLogger = createDebugLogger('Extension:converter');

export const SUPPORTED_EXTENSION_MANIFESTS = [
  EXTENSIONS_CONFIG_FILENAME,
  'gemini-extension.json',
  '.claude-plugin/marketplace.json',
  '.claude-plugin/plugin.json',
  QODER_PLUGIN_MANIFEST,
] as const;

/**
 * Detects the applicable manifest format so {@link convertCompatibleExtension}
 * can route to the right converter. A specified pluginName that is defective
 * or missing is a hard error (the user asked for a specific plugin); any other
 * detection failure is logged and we fall through to the next format.
 * @param extensionDir The extension directory to probe
 * @param pluginName When provided, a specific marketplace/standalone plugin
 * @returns The first matching manifest, or null when none applies
 */
export function detectManifest(
  extensionDir: string,
  pluginName?: string,
):
  | { source: 'Claude'; kind: 'standalone' | 'marketplace' }
  | { source: 'Gemini' }
  | { source: 'Qoder' }
  | null {
  let kind: 'standalone' | 'marketplace' | null = null;
  let converterError: unknown;
  try {
    kind = isClaudePluginConfig(extensionDir, pluginName);
  } catch (error) {
    if (pluginName) throw error;
    converterError = error;
    debugLogger.warn(
      `Claude detection failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (kind) return { source: 'Claude', kind };
  try {
    if (isGeminiExtensionConfig(extensionDir)) return { source: 'Gemini' };
  } catch (error) {
    converterError ??= error;
    debugLogger.warn(
      `Gemini detection failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (fs.existsSync(path.join(extensionDir, QODER_PLUGIN_MANIFEST))) {
    return { source: 'Qoder' };
  }
  // Native was checked before detection; reaching here with a recorded probe
  // error means no manifest matched — surface the real defect instead of the
  // install step's misleading "Configuration file not found".
  if (converterError) throw converterError;
  return null;
}

export async function convertCompatibleExtension(
  extensionDir: string,
  pluginName?: string,
  networkPolicy?: ExtensionNetworkPolicy,
  signal?: AbortSignal,
): Promise<{
  extensionDir: string;
  originSource: ExtensionOriginSource;
  externalContent: boolean;
}> {
  signal?.throwIfAborted();
  const agentPluginStatus = pluginName
    ? 'unrelated'
    : getAgentPluginSchemaStatus(extensionDir);
  if (agentPluginStatus === 'unsupported') {
    throw new Error(
      `Unsupported Agent Plugins schema. Supported schema: "${AGENT_PLUGIN_SCHEMA}".`,
    );
  } else if (agentPluginStatus === 'supported') {
    return {
      extensionDir,
      originSource: 'AgentPlugins',
      externalContent: false,
    };
  }
  const configFilePath = path.join(
    extensionDir,
    SUPPORTED_EXTENSION_MANIFESTS[0],
  );
  // Native Qwen extension wins.
  if (fs.existsSync(configFilePath)) {
    signal?.throwIfAborted();
    return { extensionDir, originSource: 'QwenCode', externalContent: false };
  }
  const detected = detectManifest(extensionDir, pluginName);
  if (!detected) {
    signal?.throwIfAborted();
    return { extensionDir, originSource: 'QwenCode', externalContent: false };
  }
  debugLogger.debug(`Converting from ${detected.source} manifest`);
  // A matched manifest that fails to convert (clone/network) propagates.
  if (detected.source === 'Claude') {
    if (detected.kind === 'marketplace') {
      signal?.throwIfAborted();
      const converted = await convertClaudePluginPackage(
        extensionDir,
        pluginName as string,
        networkPolicy,
        signal,
      );
      return {
        extensionDir: converted.convertedDir,
        originSource: 'Claude',
        externalContent: converted.externalContent,
      };
    }
    signal?.throwIfAborted();
    return {
      extensionDir: (await convertClaudePluginStandalone(extensionDir))
        .convertedDir,
      originSource: 'Claude',
      externalContent: false,
    };
  }
  if (detected.source === 'Gemini') {
    signal?.throwIfAborted();
    return {
      extensionDir: (await convertGeminiExtensionPackage(extensionDir))
        .convertedDir,
      originSource: 'Gemini',
      externalContent: false,
    };
  }
  signal?.throwIfAborted();
  return {
    extensionDir: (await convertQoderPlugin(extensionDir)).convertedDir,
    originSource: 'Qoder',
    externalContent: false,
  };
}
