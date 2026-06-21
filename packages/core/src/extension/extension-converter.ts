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
} from './claude-converter.js';
import type { ExtensionOriginSource } from '../config/config.js';

export const SUPPORTED_EXTENSION_MANIFESTS = [
  EXTENSIONS_CONFIG_FILENAME,
  'gemini-extension.json',
  '.claude-plugin/marketplace.json',
  '.claude-plugin/plugin.json',
] as const;

export async function convertGeminiOrClaudeExtension(
  extensionDir: string,
  pluginName?: string,
): Promise<{ extensionDir: string; originSource: ExtensionOriginSource }> {
  let newExtensionDir = extensionDir;
  let originSource: ExtensionOriginSource = 'QwenCode';
  const configFilePath = path.join(
    extensionDir,
    SUPPORTED_EXTENSION_MANIFESTS[0],
  );
  if (fs.existsSync(configFilePath)) {
    newExtensionDir = extensionDir;
  } else if (isGeminiExtensionConfig(extensionDir)) {
    newExtensionDir = (await convertGeminiExtensionPackage(extensionDir))
      .convertedDir;
    originSource = 'Gemini';
  } else if (pluginName) {
    newExtensionDir = (
      await convertClaudePluginPackage(extensionDir, pluginName)
    ).convertedDir;
    originSource = 'Claude';
  } else if (
    fs.existsSync(path.join(extensionDir, SUPPORTED_EXTENSION_MANIFESTS[3]))
  ) {
    newExtensionDir = (await convertClaudePluginStandalone(extensionDir))
      .convertedDir;
    originSource = 'Claude';
  }
  return { extensionDir: newExtensionDir, originSource };
}
