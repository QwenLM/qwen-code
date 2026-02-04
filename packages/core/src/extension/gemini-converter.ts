/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Converter for Gemini CLI extensions to Qwen Code format.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { glob } from 'glob';
import type { ExtensionConfig } from './extensionManager.js';
import type { ExtensionSetting } from './extensionSettings.js';
import { ExtensionStorage } from './storage.js';
import { convertTomlToMarkdown } from '../utils/toml-to-markdown-converter.js';

export interface GeminiExtensionConfig {
  name: string;
  version: string;
  mcpServers?: Record<string, unknown>;
  contextFileName?: string | string[];
  settings?: ExtensionSetting[];
}

/**
 * Converts a Gemini CLI extension config to Qwen Code format.
 * @param extensionDir Path to the Gemini extension directory
 * @returns Qwen ExtensionConfig
 */
export function convertGeminiToQwenConfig(
  extensionDir: string,
): ExtensionConfig {
  const configFilePath = path.join(extensionDir, 'gemini-extension.json');
  const configContent = fs.readFileSync(configFilePath, 'utf-8');
  const geminiConfig: GeminiExtensionConfig = JSON.parse(configContent);
  // Validate required fields
  if (!geminiConfig.name || !geminiConfig.version) {
    throw new Error(
      'Gemini extension config must have name and version fields',
    );
  }

  const settings: ExtensionSetting[] | undefined = geminiConfig.settings;

  // Direct field mapping
  return {
    name: geminiConfig.name,
    version: geminiConfig.version,
    mcpServers: geminiConfig.mcpServers as ExtensionConfig['mcpServers'],
    contextFileName: geminiConfig.contextFileName,
    settings,
  };
}

/**
 * Converts a complete Gemini extension package to Qwen Code format.
 * Creates a new temporary directory with:
 * 1. Converted qwen-extension.json
 * 2. Commands converted from TOML to MD
 * 3. All other files/folders preserved
 *
 * @param extensionDir Path to the Gemini extension directory
 * @returns Object containing converted config and the temporary directory path
 */
export async function convertGeminiExtensionPackage(
  extensionDir: string,
): Promise<{ config: ExtensionConfig; convertedDir: string }> {
  const geminiConfig = convertGeminiToQwenConfig(extensionDir);

  // Create temporary directory for converted extension
  const tmpDir = await ExtensionStorage.createTmpDir();

  try {
    // Step 1: Copy all files and directories to temporary directory
    await copyDirectory(extensionDir, tmpDir);

    // Step 2: Convert TOML commands to Markdown in commands folder
    const commandsDir = path.join(tmpDir, 'commands');
    if (fs.existsSync(commandsDir)) {
      await convertCommandsDirectory(commandsDir);
    }

    // Step 3: Create qwen-extension.json with converted config
    const qwenConfigPath = path.join(tmpDir, 'qwen-extension.json');
    fs.writeFileSync(
      qwenConfigPath,
      JSON.stringify(geminiConfig, null, 2),
      'utf-8',
    );

    return {
      config: geminiConfig,
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
 * Recursively copies a directory and its contents.
 * @param source Source directory path
 * @param destination Destination directory path
 */
export async function copyDirectory(
  source: string,
  destination: string,
): Promise<void> {
  // Create destination directory if it doesn't exist
  if (!fs.existsSync(destination)) {
    fs.mkdirSync(destination, { recursive: true });
  }

  const entries = fs.readdirSync(source, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destPath = path.join(destination, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, destPath);
    } else {
      fs.copyFileSync(sourcePath, destPath);
    }
  }
}

/**
 * Converts all TOML command files in a directory to Markdown format.
 * @param commandsDir Path to the commands directory
 */
async function convertCommandsDirectory(commandsDir: string): Promise<void> {
  // Find all .toml files in the commands directory
  const tomlFiles = await glob('**/*.toml', {
    cwd: commandsDir,
    nodir: true,
    dot: false,
  });

  // Convert each TOML file to Markdown
  for (const relativeFile of tomlFiles) {
    const tomlPath = path.join(commandsDir, relativeFile);

    try {
      // Read TOML file
      const tomlContent = fs.readFileSync(tomlPath, 'utf-8');

      // Convert to Markdown
      const markdownContent = convertTomlToMarkdown(tomlContent);

      // Generate Markdown file path (same location, .md extension)
      const markdownPath = tomlPath.replace(/\.toml$/, '.md');

      // Write Markdown file
      fs.writeFileSync(markdownPath, markdownContent, 'utf-8');

      // Delete original TOML file
      fs.unlinkSync(tomlPath);
    } catch (error) {
      console.warn(
        `Warning: Failed to convert command file ${relativeFile}: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Continue with other files even if one fails
    }
  }
}

/**
 * Checks if a config object is in Gemini format.
 * This is a heuristic check based on typical Gemini extension patterns.
 * @param config Configuration object to check
 * @returns true if config appears to be Gemini format
 */
export function isGeminiExtensionConfig(extensionDir: string) {
  const configFilePath = path.join(extensionDir, 'gemini-extension.json');
  if (!fs.existsSync(configFilePath)) {
    return false;
  }

  const configContent = fs.readFileSync(configFilePath, 'utf-8');
  const parsedConfig = JSON.parse(configContent);

  if (typeof parsedConfig !== 'object' || parsedConfig === null) {
    return false;
  }

  const obj = parsedConfig as Record<string, unknown>;

  // Must have name and version
  if (typeof obj['name'] !== 'string' || typeof obj['version'] !== 'string') {
    return false;
  }

  // Check for Gemini-specific settings format
  if (obj['settings'] && Array.isArray(obj['settings'])) {
    const firstSetting = obj['settings'][0];
    if (
      firstSetting &&
      typeof firstSetting === 'object' &&
      'envVar' in firstSetting
    ) {
      return true;
    }
  }

  // If it has Gemini-specific fields but not Qwen-specific fields, likely Gemini
  return true;
}
