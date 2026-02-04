/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * This file contains helper functions for FileCommandLoader to create SlashCommand
 * objects from parsed command definitions (TOML or Markdown).
 */

import path from 'node:path';
import type {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from '../ui/commands/types.js';
import { CommandKind } from '../ui/commands/types.js';
import { DefaultArgumentProcessor } from './prompt-processors/argumentProcessor.js';
import type {
  IPromptProcessor,
  PromptPipelineContent,
} from './prompt-processors/types.js';
import {
  SHORTHAND_ARGS_PLACEHOLDER,
  SHELL_INJECTION_TRIGGER,
  AT_FILE_INJECTION_TRIGGER,
} from './prompt-processors/types.js';
import {
  ConfirmationRequiredError,
  ShellProcessor,
} from './prompt-processors/shellProcessor.js';
import { AtFileProcessor } from './prompt-processors/atFileProcessor.js';

export interface CommandDefinition {
  prompt: string;
  description?: string;
}

/**
 * Creates a SlashCommand from a parsed command definition.
 * This function is used by both TOML and Markdown command loaders.
 *
 * @param filePath The absolute path to the command file
 * @param baseDir The root command directory for name calculation
 * @param definition The parsed command definition (prompt and optional description)
 * @param extensionName Optional extension name to prefix commands with
 * @param fileExtension The file extension (e.g., '.toml' or '.md')
 * @returns A SlashCommand object
 */
export function createSlashCommandFromDefinition(
  filePath: string,
  baseDir: string,
  definition: CommandDefinition,
  extensionName: string | undefined,
  fileExtension: string,
): SlashCommand {
  const relativePathWithExt = path.relative(baseDir, filePath);
  const relativePath = relativePathWithExt.substring(
    0,
    relativePathWithExt.length - fileExtension.length,
  );
  const baseCommandName = relativePath
    .split(path.sep)
    // Sanitize each path segment to prevent ambiguity. Since ':' is our
    // namespace separator, we replace any literal colons in filenames
    // with underscores to avoid naming conflicts.
    .map((segment) => segment.replaceAll(':', '_'))
    .join(':');

  // Add extension name tag for extension commands
  const defaultDescription = `Custom command from ${path.basename(filePath)}`;
  let description = definition.description || defaultDescription;
  if (extensionName) {
    description = `[${extensionName}] ${description}`;
  }

  const processors: IPromptProcessor[] = [];
  const usesArgs = definition.prompt.includes(SHORTHAND_ARGS_PLACEHOLDER);
  const usesShellInjection = definition.prompt.includes(
    SHELL_INJECTION_TRIGGER,
  );
  const usesAtFileInjection = definition.prompt.includes(
    AT_FILE_INJECTION_TRIGGER,
  );

  // 1. @-File Injection (Security First).
  // This runs first to ensure we're not executing shell commands that
  // could dynamically generate malicious @-paths.
  if (usesAtFileInjection) {
    processors.push(new AtFileProcessor(baseCommandName));
  }

  // 2. Argument and Shell Injection.
  // This runs after file content has been safely injected.
  if (usesShellInjection || usesArgs) {
    processors.push(new ShellProcessor(baseCommandName));
  }

  // 3. Default Argument Handling.
  // Appends the raw invocation if no explicit {{args}} are used.
  if (!usesArgs) {
    processors.push(new DefaultArgumentProcessor());
  }

  return {
    name: baseCommandName,
    description,
    kind: CommandKind.FILE,
    extensionName,
    action: async (
      context: CommandContext,
      _args: string,
    ): Promise<SlashCommandActionReturn> => {
      if (!context.invocation) {
        console.error(
          `[FileCommandLoader] Critical error: Command '${baseCommandName}' was executed without invocation context.`,
        );
        return {
          type: 'submit_prompt',
          content: [{ text: definition.prompt }], // Fallback to unprocessed prompt
        };
      }

      try {
        let processedContent: PromptPipelineContent = [
          { text: definition.prompt },
        ];
        for (const processor of processors) {
          processedContent = await processor.process(processedContent, context);
        }

        return {
          type: 'submit_prompt',
          content: processedContent,
        };
      } catch (e) {
        // Check if it's our specific error type
        if (e instanceof ConfirmationRequiredError) {
          // Halt and request confirmation from the UI layer.
          return {
            type: 'confirm_shell_commands',
            commandsToConfirm: e.commandsToConfirm,
            originalInvocation: {
              raw: context.invocation.raw,
            },
          };
        }
        // Re-throw other errors to be handled by the global error handler.
        throw e;
      }
    },
  };
}
