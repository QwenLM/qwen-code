/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import * as fsSync from 'node:fs';
import path from 'node:path';
import toml from '@iarna/toml';
import { glob } from 'glob';
import { z } from 'zod';
import type { Config } from '@qwen-code/qwen-code-core';
import { EXTENSIONS_CONFIG_FILENAME, Storage } from '@qwen-code/qwen-code-core';
import type { ICommandLoader } from './types.js';
import {
  parseMarkdownCommand,
  MarkdownCommandDefSchema,
} from './markdown-command-parser.js';
import {
  createSlashCommandFromDefinition,
  type CommandDefinition,
} from './command-factory.js';
import type { SlashCommand } from '../ui/commands/types.js';

interface CommandDirectory {
  path: string;
  extensionName?: string;
}

/**
 * Defines the Zod schema for a command definition file. This serves as the
 * single source of truth for both validation and type inference.
 */
const TomlCommandDefSchema = z.object({
  prompt: z.string({
    required_error: "The 'prompt' field is required.",
    invalid_type_error: "The 'prompt' field must be a string.",
  }),
  description: z.string().optional(),
});

/**
 * Discovers and loads custom slash commands from .toml files in both the
 * user's global config directory and the current project's directory.
 *
 * This loader is responsible for:
 * - Recursively scanning command directories.
 * - Parsing and validating TOML files.
 * - Adapting valid definitions into executable SlashCommand objects.
 * - Handling file system errors and malformed files gracefully.
 */
export class FileCommandLoader implements ICommandLoader {
  private readonly projectRoot: string;
  private readonly folderTrustEnabled: boolean;
  private readonly folderTrust: boolean;

  constructor(private readonly config: Config | null) {
    this.folderTrustEnabled = !!config?.getFolderTrustFeature();
    this.folderTrust = !!config?.getFolderTrust();
    this.projectRoot = config?.getProjectRoot() || process.cwd();
  }

  /**
   * Loads all commands from user, project, and extension directories.
   * Returns commands in order: user → project → extensions (alphabetically).
   *
   * Order is important for conflict resolution in CommandService:
   * - User/project commands (without extensionName) use "last wins" strategy
   * - Extension commands (with extensionName) get renamed if conflicts exist
   *
   * @param signal An AbortSignal to cancel the loading process.
   * @returns A promise that resolves to an array of all loaded SlashCommands.
   */
  async loadCommands(signal: AbortSignal): Promise<SlashCommand[]> {
    const allCommands: SlashCommand[] = [];
    const globOptions = {
      nodir: true,
      dot: true,
      signal,
      follow: true,
    };

    // Load commands from each directory
    const commandDirs = this.getCommandDirectories();
    for (const dirInfo of commandDirs) {
      try {
        // Scan both .toml and .md files
        const tomlFiles = await glob('**/*.toml', {
          ...globOptions,
          cwd: dirInfo.path,
        });
        const mdFiles = await glob('**/*.md', {
          ...globOptions,
          cwd: dirInfo.path,
        });

        if (this.folderTrustEnabled && !this.folderTrust) {
          return [];
        }

        // Process TOML files
        const tomlCommandPromises = tomlFiles.map((file) =>
          this.parseAndAdaptTomlFile(
            path.join(dirInfo.path, file),
            dirInfo.path,
            dirInfo.extensionName,
          ),
        );

        // Process Markdown files
        const mdCommandPromises = mdFiles.map((file) =>
          this.parseAndAdaptMarkdownFile(
            path.join(dirInfo.path, file),
            dirInfo.path,
            dirInfo.extensionName,
          ),
        );

        const commands = (
          await Promise.all([...tomlCommandPromises, ...mdCommandPromises])
        ).filter((cmd): cmd is SlashCommand => cmd !== null);

        // Add all commands without deduplication
        allCommands.push(...commands);
      } catch (error) {
        // Ignore ENOENT (directory doesn't exist) and AbortError (operation was cancelled)
        const isEnoent = (error as NodeJS.ErrnoException).code === 'ENOENT';
        const isAbortError =
          error instanceof Error && error.name === 'AbortError';
        if (!isEnoent && !isAbortError) {
          console.error(
            `[FileCommandLoader] Error loading commands from ${dirInfo.path}:`,
            error,
          );
        }
      }
    }

    return allCommands;
  }

  /**
   * Get all command directories in order for loading.
   * User commands → Project commands → Extension commands
   * This order ensures extension commands can detect all conflicts.
   */
  private getCommandDirectories(): CommandDirectory[] {
    const dirs: CommandDirectory[] = [];

    const storage = this.config?.storage ?? new Storage(this.projectRoot);

    // 1. User commands
    dirs.push({ path: Storage.getUserCommandsDir() });

    // 2. Project commands (override user commands)
    dirs.push({ path: storage.getProjectCommandsDir() });

    // 3. Extension commands (processed last to detect all conflicts)
    if (this.config) {
      const activeExtensions = this.config
        .getExtensions()
        .filter((ext) => ext.isActive)
        .sort((a, b) => a.name.localeCompare(b.name)); // Sort alphabetically for deterministic loading

      // Collect command directories from each extension
      for (const ext of activeExtensions) {
        // Get commands paths from extension config
        const commandsPaths = this.getExtensionCommandsPaths(ext);

        for (const cmdPath of commandsPaths) {
          dirs.push({
            path: cmdPath,
            extensionName: ext.name,
          });
        }
      }
    }

    return dirs;
  }

  /**
   * Get commands paths from an extension.
   * Returns paths from config.commands if specified, otherwise defaults to 'commands' directory.
   */
  private getExtensionCommandsPaths(ext: {
    path: string;
    name: string;
  }): string[] {
    // Try to get extension config
    try {
      const configPath = path.join(ext.path, EXTENSIONS_CONFIG_FILENAME);
      if (fsSync.existsSync(configPath)) {
        const configContent = fsSync.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(configContent);

        if (config.commands) {
          const commandsArray = Array.isArray(config.commands)
            ? config.commands
            : [config.commands];

          return commandsArray
            .map((cmdPath: string) =>
              path.isAbsolute(cmdPath) ? cmdPath : path.join(ext.path, cmdPath),
            )
            .filter((cmdPath: string) => {
              try {
                return fsSync.existsSync(cmdPath);
              } catch {
                return false;
              }
            });
        }
      }
    } catch (error) {
      console.warn(`Failed to read extension config for ${ext.name}:`, error);
    }

    // Default fallback: use 'commands' directory
    const defaultPath = path.join(ext.path, 'commands');
    try {
      if (fsSync.existsSync(defaultPath)) {
        return [defaultPath];
      }
    } catch {
      // Ignore
    }

    return [];
  }

  /**
   * Parses a single .toml file and transforms it into a SlashCommand object.
   * @param filePath The absolute path to the .toml file.
   * @param baseDir The root command directory for name calculation.
   * @param extensionName Optional extension name to prefix commands with.
   * @returns A promise resolving to a SlashCommand, or null if the file is invalid.
   */
  private async parseAndAdaptTomlFile(
    filePath: string,
    baseDir: string,
    extensionName?: string,
  ): Promise<SlashCommand | null> {
    let fileContent: string;
    try {
      fileContent = await fs.readFile(filePath, 'utf-8');
    } catch (error: unknown) {
      console.error(
        `[FileCommandLoader] Failed to read file ${filePath}:`,
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }

    let parsed: unknown;
    try {
      parsed = toml.parse(fileContent);
    } catch (error: unknown) {
      console.error(
        `[FileCommandLoader] Failed to parse TOML file ${filePath}:`,
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }

    const validationResult = TomlCommandDefSchema.safeParse(parsed);

    if (!validationResult.success) {
      console.error(
        `[FileCommandLoader] Skipping invalid command file: ${filePath}. Validation errors:`,
        validationResult.error.flatten(),
      );
      return null;
    }

    const validDef = validationResult.data;

    // Use factory to create command
    return createSlashCommandFromDefinition(
      filePath,
      baseDir,
      validDef,
      extensionName,
      '.toml',
    );
  }

  /**
   * Parses a single .md file and transforms it into a SlashCommand object.
   * @param filePath The absolute path to the .md file.
   * @param baseDir The root command directory for name calculation.
   * @param extensionName Optional extension name to prefix commands with.
   * @returns A promise resolving to a SlashCommand, or null if the file is invalid.
   */
  private async parseAndAdaptMarkdownFile(
    filePath: string,
    baseDir: string,
    extensionName?: string,
  ): Promise<SlashCommand | null> {
    let fileContent: string;
    try {
      fileContent = await fs.readFile(filePath, 'utf-8');
    } catch (error: unknown) {
      console.error(
        `[FileCommandLoader] Failed to read file ${filePath}:`,
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }

    let parsed: ReturnType<typeof parseMarkdownCommand>;
    try {
      parsed = parseMarkdownCommand(fileContent);
    } catch (error: unknown) {
      console.error(
        `[FileCommandLoader] Failed to parse Markdown file ${filePath}:`,
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }

    const validationResult = MarkdownCommandDefSchema.safeParse(parsed);

    if (!validationResult.success) {
      console.error(
        `[FileCommandLoader] Skipping invalid command file: ${filePath}. Validation errors:`,
        validationResult.error.flatten(),
      );
      return null;
    }

    const validDef = validationResult.data;

    // Convert to CommandDefinition format
    const definition: CommandDefinition = {
      prompt: validDef.prompt,
      description:
        validDef.frontmatter?.description &&
        typeof validDef.frontmatter.description === 'string'
          ? validDef.frontmatter.description
          : undefined,
    };

    // Use factory to create command
    return createSlashCommandFromDefinition(
      filePath,
      baseDir,
      definition,
      extensionName,
      '.md',
    );
  }
}
