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

export const SUPPORTED_EXTENSION_MANIFESTS = [
  EXTENSIONS_CONFIG_FILENAME,
  'gemini-extension.json',
  '.claude-plugin/marketplace.json',
  '.claude-plugin/plugin.json',
  QODER_PLUGIN_MANIFEST,
] as const;

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
  const configFilePath = path.join(
    extensionDir,
    SUPPORTED_EXTENSION_MANIFESTS[0],
  );
  // Native Qwen extension wins.
  if (fs.existsSync(configFilePath)) {
    signal?.throwIfAborted();
    return { extensionDir, originSource: 'QwenCode', externalContent: false };
  }
  // Try Claude first; a defective manifest is recorded and we fall back.
  let claudeError: unknown;
  try {
    const kind = isClaudePluginConfig(extensionDir, pluginName);
    if (kind === 'marketplace') {
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
    if (kind === 'standalone') {
      signal?.throwIfAborted();
      return {
        extensionDir: (await convertClaudePluginStandalone(extensionDir))
          .convertedDir,
        originSource: 'Claude',
        externalContent: false,
      };
    }
  } catch (error) {
    claudeError = error;
  }
  // Fall back to Gemini (matches the pre-merge ordering where Gemini precedes Qoder).
  if (isGeminiExtensionConfig(extensionDir)) {
    signal?.throwIfAborted();
    return {
      extensionDir: (await convertGeminiExtensionPackage(extensionDir))
        .convertedDir,
      originSource: 'Gemini',
      externalContent: false,
    };
  }
  // Fall back to Qoder.
  if (fs.existsSync(path.join(extensionDir, QODER_PLUGIN_MANIFEST))) {
    signal?.throwIfAborted();
    return {
      extensionDir: (await convertQoderPlugin(extensionDir)).convertedDir,
      originSource: 'Qoder',
      externalContent: false,
    };
  }
  // Nothing matched: surface the Claude manifest error if one occurred.
  if (claudeError) throw claudeError;
  signal?.throwIfAborted();
  return { extensionDir, originSource: 'QwenCode', externalContent: false };
}
