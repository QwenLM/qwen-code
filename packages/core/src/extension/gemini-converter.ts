/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Converter for Gemini extensions to Qwen Code format.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { glob } from 'glob';
import type { ExtensionConfig } from './extensionManager.js';
import type { ExtensionSetting } from './extensionSettings.js';
import { ExtensionStorage } from './storage.js';
import { convertTomlToMarkdown } from '../utils/toml-to-markdown-converter.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('GEMINI_CONVERTER');

export interface GeminiExtensionConfig {
  name: string;
  version: string;
  mcpServers?: Record<string, unknown>;
  contextFileName?: string | string[];
  settings?: ExtensionSetting[];
}

/**
 * Converts a Gemini extension config to Qwen Code format.
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
 * True when `child` equals or is nested under `parent`. Both must already be
 * absolute, resolved paths. Shared containment primitive for the symlink
 * confinement guards (kept in one place so the rule can't drift between files).
 */
export function isPathWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

/**
 * True when `target` exists and its real (symlink-resolved) path stays within
 * `root`'s real path. Both sides are resolved with `fs.realpathSync` so a
 * symlink in an untrusted source cannot point a read/copy at a file outside
 * the package. Returns false for missing or broken paths.
 */
export function realPathWithin(target: string, root: string): boolean {
  try {
    return isPathWithin(fs.realpathSync(target), fs.realpathSync(root));
  } catch {
    return false;
  }
}

/**
 * Recursively copies a directory and its contents.
 * @param source Source directory path
 * @param destination Destination directory path
 * @param confineRoot If set, any symlink whose real target escapes this
 *   directory is skipped. Defaults to `fs.realpathSync(source)` when omitted.
 *   Always pass this explicitly when `source` originates from untrusted input.
 */
export async function copyDirectory(
  source: string,
  destination: string,
  confineRoot?: string,
): Promise<void> {
  // Create destination directory if it doesn't exist
  if (!fs.existsSync(destination)) {
    fs.mkdirSync(destination, { recursive: true });
  }

  // Symlinks in an (untrusted) source are dereferenced and their *target*
  // content is copied below, so a link escaping the package — e.g.
  // `skills/leak.txt -> ~/.ssh/id_rsa` — would otherwise pull host files into
  // the output. Pin a confinement root (the package's real path) on the first
  // call and thread it through recursion to reject escaping symlink targets.
  let root = confineRoot;
  if (root === undefined) {
    try {
      root = fs.realpathSync(source);
    } catch {
      root = path.resolve(source);
    }
  }

  const entries = fs.readdirSync(source, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destPath = path.join(destination, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, destPath, root);
    } else if (entry.isSymbolicLink()) {
      // Resolve symlink and copy the target content, but only when the target
      // stays inside the package root.
      try {
        const realPath = fs.realpathSync(sourcePath);
        if (!isPathWithin(realPath, root)) {
          debugLogger.warn(
            `Skipping symlink that escapes the package: ${sourcePath} -> ${realPath}`,
          );
          continue;
        }
        const targetStat = fs.statSync(realPath);
        if (targetStat.isDirectory()) {
          await copyDirectory(realPath, destPath, root);
        } else if (targetStat.isFile()) {
          fs.copyFileSync(realPath, destPath);
        }
        // Skip sockets, FIFOs, etc.
      } catch {
        // Skip broken symlinks
      }
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, destPath);
    }
    // Skip sockets, FIFOs, block devices, and character devices
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
      debugLogger.warn(
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
