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
  isClaudePluginStandaloneConfig,
} from './claude-converter.js';
import type {
  ExtensionNetworkPolicy,
  ExtensionOriginSource,
} from '../config/config.js';

export const SUPPORTED_EXTENSION_MANIFESTS = [
  EXTENSIONS_CONFIG_FILENAME,
  'gemini-extension.json',
  '.claude-plugin/marketplace.json',
  '.claude-plugin/plugin.json',
] as const;

export async function convertGeminiOrClaudeExtension(
  extensionDir: string,
  pluginName?: string,
  networkPolicy?: ExtensionNetworkPolicy,
  signal?: AbortSignal,
): Promise<{ extensionDir: string; originSource: ExtensionOriginSource }> {
  signal?.throwIfAborted();
  let newExtensionDir = extensionDir;
  let originSource: ExtensionOriginSource = 'QwenCode';
  const configFilePath = path.join(
    extensionDir,
    SUPPORTED_EXTENSION_MANIFESTS[0],
  );
  // Prefer Claude manifests when present
  if (fs.existsSync(configFilePath)) {
    newExtensionDir = extensionDir;
  } else if (
    pluginName &&
    isClaudePluginConfig(extensionDir, { extensionSource: '', pluginName })
  ) {
    newExtensionDir = (
      await convertClaudePluginPackage(
        extensionDir,
        pluginName,
        networkPolicy,
        signal,
      )
    ).convertedDir;
    originSource = 'Claude';
  } else if (isClaudePluginStandaloneConfig(extensionDir)) {
    newExtensionDir = (await convertClaudePluginStandalone(extensionDir))
      .convertedDir;
    originSource = 'Claude';
  } else if (isGeminiExtensionConfig(extensionDir)) {
    newExtensionDir = (await convertGeminiExtensionPackage(extensionDir))
      .convertedDir;
    originSource = 'Gemini';
  }
  signal?.throwIfAborted();
  return { extensionDir: newExtensionDir, originSource };
}
