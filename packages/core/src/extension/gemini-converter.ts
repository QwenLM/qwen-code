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
import {
  isPathWithin,
  isRegularFile,
  readExtensionManifest,
  realPathWithin,
} from './path-confinement.js';
import {
  normalizeMcpServers,
  assertMcpServersContainer,
} from './claude-converter.js';
import {
  AGENT_PLUGIN_MANIFEST,
  getAgentPluginSchemaStatus,
} from './agent-plugins-v1/manifest.js';
import { stripAnsiAndControl } from '../utils/textUtils.js';

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
  // readExtensionManifest throws on a symlink escape, unparseable body, or
  // non-object body; returns null when absent.
  const geminiConfig = readExtensionManifest(
    extensionDir,
    'gemini-extension.json',
  ) as GeminiExtensionConfig | null;
  if (!geminiConfig) {
    throw new Error(
      `Gemini extension config not found at ${stripAnsiAndControl(path.join(extensionDir, 'gemini-extension.json'))}`,
    );
  }
  // Validate required fields
  if (!geminiConfig.name || !geminiConfig.version) {
    throw new Error(
      'Gemini extension config must have name and version fields',
    );
  }

  const settings: ExtensionSetting[] | undefined = geminiConfig.settings;

  // Container must be an object (array / scalar would install zero
  // servers silently); null treated as absent.
  const validatedServers =
    geminiConfig.mcpServers == null
      ? undefined
      : assertMcpServersContainer(
          geminiConfig.mcpServers,
          'Invalid MCP configuration: mcpServers must be an object',
          geminiConfig.name,
        );
  const mcpServers = validatedServers
    ? normalizeMcpServers(
        validatedServers,
        path.join(extensionDir, 'gemini-extension.json'),
      )
    : undefined;

  // Declare hooks explicitly when the extension ships the default
  // hooks/hooks.json file, so the manifest is self-contained instead of
  // relying on the runtime's implicit default-route load. The path string is
  // kept (not expanded) so loadExtension hydrates `${extensionPath}`/variables
  // at load. existsSync + realPathWithin catches escaping symlinks;
  // isRegularFile rejects a directory named hooks/hooks.json.
  const hooksFile = path.join(extensionDir, 'hooks', 'hooks.json');
  const hooks =
    fs.existsSync(hooksFile) &&
    realPathWithin(hooksFile, extensionDir) &&
    isRegularFile(hooksFile)
      ? 'hooks/hooks.json'
      : undefined;

  // Direct field mapping
  return {
    name: geminiConfig.name,
    version: geminiConfig.version,
    mcpServers,
    contextFileName: geminiConfig.contextFileName,
    settings,
    hooks,
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

    // If the source ships a root Agent-Plugins manifest, drop it so the
    // loader cannot prefer it over the converted qwen-extension.json.
    if (getAgentPluginSchemaStatus(tmpDir) !== 'unrelated') {
      await fs.promises.rm(path.join(tmpDir, AGENT_PLUGIN_MANIFEST), {
        force: true,
      });
    }

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
 * @param confineRoot If set, any symlink whose real target escapes this
 *   directory is skipped. Defaults to `fs.realpathSync(source)` when omitted.
 *   Always pass this explicitly when `source` originates from untrusted input.
 */
export async function copyDirectory(
  source: string,
  destination: string,
  confineRoot?: string,
): Promise<void> {
  let root = confineRoot;
  if (root === undefined) {
    try {
      root = fs.realpathSync(source);
    } catch {
      root = path.resolve(source);
    }
  }
  // Normalize the source to its real path ONCE: every recursive sourcePath
  // joins a resolved parent, so the cycle guard below compares resolved-vs-
  // resolved. Without this, a copy root that itself has a symlink component
  // (macOS os.tmpdir: /var -> /private/var; a symlinked extensions dir on
  // Linux) defeats the guard and nests a duplicated tree level.
  let realSource = source;
  try {
    realSource = fs.realpathSync(source);
  } catch {
    realSource = path.resolve(source);
  }
  await copyDirectoryRecursive(realSource, destination, root, new Set(), {
    createdDirs: 0,
  });
}

// The stack-scoped cycle guard leaves mutually-interlinked directories legal
// (~e*k! copy entries for k of them), so bound the total instead of letting the
// conversion fill the disk.
const MAX_CONVERT_DIRS = 1000;

/**
 * Internal copy recursion. `stack` holds the real paths on the CURRENT
 * recursion path only (deleted on exit), so a symlink whose target is the
 * copy root, an ancestor, or a mutually-interlinked sibling is skipped
 * instead of nesting to the OS path limit — without a global visited set
 * silently dropping legitimate aliases already copied through another branch.
 */
async function copyDirectoryRecursive(
  source: string,
  destination: string,
  root: string,
  stack: Set<string>,
  budget: { createdDirs: number },
): Promise<void> {
  if (stack.has(source)) return;
  if (++budget.createdDirs > MAX_CONVERT_DIRS) {
    throw new Error('Extension package is too complex to convert');
  }
  stack.add(source);
  try {
    // Create destination directory if it doesn't exist
    if (!fs.existsSync(destination)) {
      fs.mkdirSync(destination, { recursive: true });
    }

    const entries = fs.readdirSync(source, { withFileTypes: true });

    for (const entry of entries) {
      const sourcePath = path.join(source, entry.name);
      const destPath = path.join(destination, entry.name);

      if (entry.isDirectory()) {
        await copyDirectoryRecursive(sourcePath, destPath, root, stack, budget);
      } else if (entry.isSymbolicLink()) {
        // Resolve symlink and copy the target content, but only when the target
        // stays inside the package root.
        try {
          const realPath = fs.realpathSync(sourcePath);
          if (!isPathWithin(realPath, root)) {
            debugLogger.warn(
              `Skipping symlink that escapes the package: ${stripAnsiAndControl(sourcePath)} -> ${stripAnsiAndControl(realPath)}`,
            );
            continue;
          }
          // A symlink whose real target is already on the CURRENT recursion path
          // (self-link, ancestor, mutual pair) would nest the copy forever.
          if (stack.has(realPath)) {
            debugLogger.warn(
              `Skipping symlink that points back into the copied tree: ${stripAnsiAndControl(sourcePath)} -> ${stripAnsiAndControl(realPath)}`,
            );
            continue;
          }
          const targetStat = fs.statSync(realPath);
          if (targetStat.isDirectory()) {
            await copyDirectoryRecursive(
              realPath,
              destPath,
              root,
              stack,
              budget,
            );
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
  } finally {
    stack.delete(source);
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
      const safeFile = stripAnsiAndControl(relativeFile);
      const reason = stripAnsiAndControl(
        error instanceof Error ? error.message : String(error),
      );
      debugLogger.warn(
        `Warning: Failed to convert command file ${safeFile}: ${reason}`,
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
  const obj = readExtensionManifest(extensionDir, 'gemini-extension.json');
  if (!obj) {
    return false;
  }

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
