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

export async function convertGeminiOrClaudeExtension(
  extensionDir: string,
  pluginName?: string,
): Promise<{ extensionDir: string; originSource: ExtensionOriginSource }> {
  let newExtensionDir = extensionDir;
  let originSource: ExtensionOriginSource = 'QwenCode';
  const configFilePath = path.join(extensionDir, EXTENSIONS_CONFIG_FILENAME);
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
    fs.existsSync(path.join(extensionDir, '.claude-plugin', 'plugin.json'))
  ) {
    newExtensionDir = (await convertClaudePluginStandalone(extensionDir))
      .convertedDir;
    originSource = 'Claude';
  }
  return { extensionDir: newExtensionDir, originSource };
}
