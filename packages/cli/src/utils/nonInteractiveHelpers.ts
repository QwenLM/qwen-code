/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';
import type { Part, PartListUnion } from '@google/genai';
import type {
  CLIUserMessage,
  Usage,
  ExtendedUsage,
  PermissionMode,
  CLISystemMessage,
} from '../nonInteractive/types.js';
import { CommandService } from '../services/CommandService.js';
import { BuiltinCommandLoader } from '../services/BuiltinCommandLoader.js';

/**
 * Normalizes various part list formats into a consistent Part[] array.
 *
 * @param parts - Input parts in various formats (string, Part, Part[], or null)
 * @returns Normalized array of Part objects
 */
export function normalizePartList(parts: PartListUnion | null): Part[] {
  if (!parts) {
    return [];
  }

  if (typeof parts === 'string') {
    return [{ text: parts }];
  }

  if (Array.isArray(parts)) {
    return parts.map((part) =>
      typeof part === 'string' ? { text: part } : (part as Part),
    );
  }

  return [parts as Part];
}

/**
 * Extracts user message parts from a CLI protocol message.
 *
 * @param message - User message sourced from the CLI protocol layer
 * @returns Extracted parts or null if the message lacks textual content
 */
export function extractPartsFromUserMessage(
  message: CLIUserMessage | undefined,
): PartListUnion | null {
  if (!message) {
    return null;
  }

  const content = message.message?.content;
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    const parts: Part[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object' || !('type' in block)) {
        continue;
      }
      if (block.type === 'text' && 'text' in block && block.text) {
        parts.push({ text: block.text });
      } else {
        parts.push({ text: JSON.stringify(block) });
      }
    }
    return parts.length > 0 ? parts : null;
  }

  return null;
}

/**
 * Extracts usage metadata from the Gemini client's debug responses.
 *
 * @param geminiClient - The Gemini client instance
 * @returns Usage information or undefined if not available
 */
export function extractUsageFromGeminiClient(
  geminiClient: unknown,
): Usage | undefined {
  if (
    !geminiClient ||
    typeof geminiClient !== 'object' ||
    typeof (geminiClient as { getChat?: unknown }).getChat !== 'function'
  ) {
    return undefined;
  }

  try {
    const chat = (geminiClient as { getChat: () => unknown }).getChat();
    if (
      !chat ||
      typeof chat !== 'object' ||
      typeof (chat as { getDebugResponses?: unknown }).getDebugResponses !==
        'function'
    ) {
      return undefined;
    }

    const responses = (
      chat as {
        getDebugResponses: () => Array<Record<string, unknown>>;
      }
    ).getDebugResponses();
    for (let i = responses.length - 1; i >= 0; i--) {
      const metadata = responses[i]?.['usageMetadata'] as
        | Record<string, unknown>
        | undefined;
      if (metadata) {
        const promptTokens = metadata['promptTokenCount'];
        const completionTokens = metadata['candidatesTokenCount'];
        const totalTokens = metadata['totalTokenCount'];
        const cachedTokens = metadata['cachedContentTokenCount'];

        return {
          input_tokens: typeof promptTokens === 'number' ? promptTokens : 0,
          output_tokens:
            typeof completionTokens === 'number' ? completionTokens : 0,
          total_tokens:
            typeof totalTokens === 'number' ? totalTokens : undefined,
          cache_read_input_tokens:
            typeof cachedTokens === 'number' ? cachedTokens : undefined,
        };
      }
    }
  } catch (error) {
    console.debug('Failed to extract usage metadata:', error);
  }

  return undefined;
}

/**
 * Calculates approximate cost for API usage.
 * Currently returns 0 as a placeholder - cost calculation logic can be added here.
 *
 * @param usage - Usage information from API response
 * @returns Approximate cost in USD or undefined if not calculable
 */
export function calculateApproximateCost(
  usage: Usage | ExtendedUsage | undefined,
): number | undefined {
  if (!usage) {
    return undefined;
  }
  // TODO: Implement actual cost calculation based on token counts and model pricing
  return 0;
}

/**
 * Load slash command names using CommandService
 *
 * @param config - Config instance
 * @returns Promise resolving to array of slash command names
 */
async function loadSlashCommandNames(config: Config): Promise<string[]> {
  const controller = new AbortController();
  try {
    const service = await CommandService.create(
      [new BuiltinCommandLoader(config)],
      controller.signal,
    );
    const names = new Set<string>();
    const commands = service.getCommands();
    for (const command of commands) {
      names.add(command.name);
    }
    return Array.from(names).sort();
  } catch (error) {
    if (config.getDebugMode()) {
      console.error(
        '[buildSystemMessage] Failed to load slash commands:',
        error,
      );
    }
    return [];
  } finally {
    controller.abort();
  }
}

/**
 * Build system message for SDK
 *
 * Constructs a system initialization message including tools, MCP servers,
 * and model configuration. System messages are independent of the control
 * system and are sent before every turn regardless of whether control
 * system is available.
 *
 * Note: Control capabilities are NOT included in system messages. They
 * are only included in the initialize control response, which is handled
 * separately by SystemController.
 *
 * @param config - Config instance
 * @param sessionId - Session identifier
 * @param permissionMode - Current permission/approval mode
 * @returns Promise resolving to CLISystemMessage
 */
export async function buildSystemMessage(
  config: Config,
  sessionId: string,
  permissionMode: PermissionMode,
): Promise<CLISystemMessage> {
  const toolRegistry = config.getToolRegistry();
  const tools = toolRegistry ? toolRegistry.getAllToolNames() : [];

  const mcpServers = config.getMcpServers();
  const mcpServerList = mcpServers
    ? Object.keys(mcpServers).map((name) => ({
        name,
        status: 'connected',
      }))
    : [];

  // Load slash commands
  const slashCommands = await loadSlashCommandNames(config);

  const systemMessage: CLISystemMessage = {
    type: 'system',
    subtype: 'init',
    uuid: sessionId,
    session_id: sessionId,
    cwd: config.getTargetDir(),
    tools,
    mcp_servers: mcpServerList,
    model: config.getModel(),
    permissionMode,
    slash_commands: slashCommands,
    apiKeySource: 'none',
    qwen_code_version: config.getCliVersion() || 'unknown',
    output_style: 'default',
    agents: [],
    skills: [],
    // Note: capabilities are NOT included in system messages
    // They are only in the initialize control response
  };

  return systemMessage;
}
