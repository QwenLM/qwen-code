/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';
import {
  getErrorMessage,
  getMCPServerPrompts,
} from '@qwen-code/qwen-code-core';
import type {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from '../ui/commands/types.js';
import { CommandKind } from '../ui/commands/types.js';
import type { ICommandLoader } from './types.js';
import type { PromptArgument } from '@modelcontextprotocol/sdk/types.js';
import { t } from '../i18n/index.js';
import type {
  DynamicCommandTranslationService} from './DynamicCommandTranslationService.js';
import {
  markDynamicDescriptionSource,
} from './DynamicCommandTranslationService.js';

function getPromptDescription(
  promptName: string,
  promptDescription?: string,
  dynamicTranslationService?: DynamicCommandTranslationService,
): string {
  if (promptDescription) {
    return (
      dynamicTranslationService?.getDescription(
        CommandKind.MCP_PROMPT,
        promptDescription,
      ) ?? promptDescription
    );
  }

  return t('Invoke prompt {{name}}', { name: promptName });
}

function buildPromptHelpMessage(
  promptName: string,
  promptArgs: PromptArgument[] | undefined,
): string {
  if (!promptArgs || promptArgs.length === 0) {
    return t('Prompt "{{name}}" has no arguments.', { name: promptName });
  }

  const positionalExample = `${promptName} ${promptArgs
    .map(() => '"foo"')
    .join(' ')}`;
  const namedExample = `${promptName} ${promptArgs
    .map((arg) => `--${arg.name}="foo"`)
    .join(' ')}`;
  const lines = [
    t('Arguments for "{{name}}":', { name: promptName }),
    '',
    t(
      'You can provide arguments by name (e.g., {{namedExample}}) or by position.',
      {
        namedExample: '--argName="value"',
      },
    ),
    '',
    t('For example, {{positionalExample}} is equivalent to {{namedExample}}', {
      positionalExample,
      namedExample,
    }),
    '',
  ];

  for (const arg of promptArgs) {
    lines.push(`  --${arg.name}`);
    if (arg.description) {
      lines.push(`    ${arg.description}`);
    }
    lines.push(
      `    ${t('(required: {{required}})', {
        required: arg.required ? t('yes') : t('no'),
      })}`,
    );
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Discovers and loads executable slash commands from prompts exposed by
 * Model-Context-Protocol (MCP) servers.
 */
export class McpPromptLoader implements ICommandLoader {
  constructor(
    private readonly config: Config | null,
    private readonly dynamicTranslationService?: DynamicCommandTranslationService,
  ) {}

  /**
   * Loads all available prompts from all configured MCP servers and adapts
   * them into executable SlashCommand objects.
   *
   * @param _signal An AbortSignal (unused for this synchronous loader).
   * @returns A promise that resolves to an array of loaded SlashCommands.
   */
  loadCommands(_signal: AbortSignal): Promise<SlashCommand[]> {
    const promptCommands: SlashCommand[] = [];
    if (!this.config) {
      return Promise.resolve([]);
    }
    const mcpServers = this.config.getMcpServers() || {};
    const dynamicTranslationService = this.dynamicTranslationService;
    for (const serverName in mcpServers) {
      const prompts = getMCPServerPrompts(this.config, serverName) || [];
      for (const prompt of prompts) {
        const commandName = `${prompt.name}`;
        const newPromptCommand: SlashCommand = {
          name: commandName,
          get description() {
            return getPromptDescription(
              prompt.name,
              prompt.description,
              dynamicTranslationService,
            );
          },
          kind: CommandKind.MCP_PROMPT,
          subCommands: [
            {
              name: 'help',
              description: t('Show help for this prompt'),
              kind: CommandKind.MCP_PROMPT,
              action: async (): Promise<SlashCommandActionReturn> => ({
                  type: 'message',
                  messageType: 'info',
                  content: buildPromptHelpMessage(
                    prompt.name,
                    prompt.arguments,
                  ),
                }),
            },
          ],
          action: async (
            context: CommandContext,
            args: string,
          ): Promise<SlashCommandActionReturn> => {
            if (!this.config) {
              return {
                type: 'message',
                messageType: 'error',
                content: t('Config not loaded.'),
              };
            }

            const promptInputs = this.parseArgs(args, prompt.arguments);
            if (promptInputs instanceof Error) {
              return {
                type: 'message',
                messageType: 'error',
                content: promptInputs.message,
              };
            }

            try {
              const mcpServers = this.config.getMcpServers() || {};
              const mcpServerConfig = mcpServers[serverName];
              if (!mcpServerConfig) {
                return {
                  type: 'message',
                  messageType: 'error',
                  content: t(
                    'MCP server config not found for "{{serverName}}".',
                    {
                      serverName,
                    },
                  ),
                };
              }
              const result = await prompt.invoke(promptInputs);

              if (result['error']) {
                return {
                  type: 'message',
                  messageType: 'error',
                  content: t('Error invoking prompt: {{error}}', {
                    error: String(result['error']),
                  }),
                };
              }

              const firstMessage = result.messages?.[0];
              const content = firstMessage?.content;

              if (content?.type !== 'text') {
                return {
                  type: 'message',
                  messageType: 'error',
                  content: t(
                    'Received an empty or invalid prompt response from the server.',
                  ),
                };
              }

              return {
                type: 'submit_prompt',
                content: JSON.stringify(content.text),
              };
            } catch (error) {
              return {
                type: 'message',
                messageType: 'error',
                content: t('Error: {{error}}', {
                  error: getErrorMessage(error),
                }),
              };
            }
          },
          completion: async (
            commandContext: CommandContext,
            partialArg: string,
          ) => {
            const invocation = commandContext.invocation;
            if (!prompt || !prompt.arguments || !invocation) {
              return [];
            }
            const indexOfFirstSpace = invocation.raw.indexOf(' ') + 1;
            let promptInputs =
              indexOfFirstSpace === 0
                ? {}
                : this.parseArgs(
                    invocation.raw.substring(indexOfFirstSpace),
                    prompt.arguments,
                  );
            if (promptInputs instanceof Error) {
              promptInputs = {};
            }

            const providedArgNames = Object.keys(promptInputs);
            const unusedArguments =
              prompt.arguments
                .filter((arg) => {
                  // If this arguments is not in the prompt inputs
                  // add it to unusedArguments
                  if (!providedArgNames.includes(arg.name)) {
                    return true;
                  }

                  // The parseArgs method assigns the value
                  // at the end of the prompt as a final value
                  // The argument should still be suggested
                  // Example /add --numberOne="34" --num
                  // numberTwo would be assigned a value of --num
                  // numberTwo should still be considered unused
                  const argValue = promptInputs[arg.name];
                  return argValue === partialArg;
                })
                .map((argument) => `--${argument.name}="`) || [];

            const exactlyMatchingArgumentAtTheEnd = prompt.arguments
              .map((argument) => `--${argument.name}="`)
              .filter((flagArgument) => {
                const regex = new RegExp(`${flagArgument}[^"]*$`);
                return regex.test(invocation.raw);
              });

            if (exactlyMatchingArgumentAtTheEnd.length === 1) {
              if (exactlyMatchingArgumentAtTheEnd[0] === partialArg) {
                return [`${partialArg}"`];
              }
              if (partialArg.endsWith('"')) {
                return [partialArg];
              }
              return [`${partialArg}"`];
            }

            const matchingArguments = unusedArguments.filter((flagArgument) =>
              flagArgument.startsWith(partialArg),
            );

            return matchingArguments;
          },
        };

        if (prompt.description) {
          markDynamicDescriptionSource(
            newPromptCommand,
            CommandKind.MCP_PROMPT,
            prompt.description,
          );
        }
        promptCommands.push(newPromptCommand);
      }
    }
    return Promise.resolve(promptCommands);
  }

  /**
   * Parses the `userArgs` string representing the prompt arguments (all the text
   * after the command) into a record matching the shape of the `promptArgs`.
   *
   * @param userArgs
   * @param promptArgs
   * @returns A record of the parsed arguments
   * @visibleForTesting
   */
  parseArgs(
    userArgs: string,
    promptArgs: PromptArgument[] | undefined,
  ): Record<string, unknown> | Error {
    const argValues: { [key: string]: string } = {};
    const promptInputs: Record<string, unknown> = {};

    // arg parsing: --key="value" or --key=value
    const namedArgRegex = /--([^=]+)=(?:"((?:\\.|[^"\\])*)"|([^ ]+))/g;
    let match;
    let lastIndex = 0;
    const positionalParts: string[] = [];

    while ((match = namedArgRegex.exec(userArgs)) !== null) {
      const key = match[1];
      // Extract the quoted or unquoted argument and remove escape chars.
      const value = (match[2] ?? match[3]).replace(/\\(.)/g, '$1');
      argValues[key] = value;
      // Capture text between matches as potential positional args
      if (match.index > lastIndex) {
        positionalParts.push(userArgs.substring(lastIndex, match.index));
      }
      lastIndex = namedArgRegex.lastIndex;
    }

    // Capture any remaining text after the last named arg
    if (lastIndex < userArgs.length) {
      positionalParts.push(userArgs.substring(lastIndex));
    }

    const positionalArgsString = positionalParts.join('').trim();
    // extracts either quoted strings or non-quoted sequences of non-space characters.
    const positionalArgRegex = /(?:"((?:\\.|[^"\\])*)"|([^ ]+))/g;
    const positionalArgs: string[] = [];
    while ((match = positionalArgRegex.exec(positionalArgsString)) !== null) {
      // Extract the quoted or unquoted argument and remove escape chars.
      positionalArgs.push((match[1] ?? match[2]).replace(/\\(.)/g, '$1'));
    }

    if (!promptArgs) {
      return promptInputs;
    }
    for (const arg of promptArgs) {
      if (argValues[arg.name]) {
        promptInputs[arg.name] = argValues[arg.name];
      }
    }

    const unfilledArgs = promptArgs.filter(
      (arg) => arg.required && !promptInputs[arg.name],
    );

    if (unfilledArgs.length === 1) {
      // If we have only one unfilled arg, we don't require quotes we just
      // join all the given arguments together as if they were quoted.
      promptInputs[unfilledArgs[0].name] = positionalArgs.join(' ');
    } else {
      const missingArgs: string[] = [];
      for (let i = 0; i < unfilledArgs.length; i++) {
        if (positionalArgs.length > i) {
          promptInputs[unfilledArgs[i].name] = positionalArgs[i];
        } else {
          missingArgs.push(unfilledArgs[i].name);
        }
      }
      if (missingArgs.length > 0) {
        const missingArgNames = missingArgs
          .map((name) => `--${name}`)
          .join(', ');
        return new Error(
          t('Missing required argument(s): {{args}}', {
            args: missingArgNames,
          }),
        );
      }
    }

    return promptInputs;
  }
}
