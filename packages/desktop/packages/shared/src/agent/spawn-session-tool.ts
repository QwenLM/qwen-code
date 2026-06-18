/**
 * Spawn Session Tool (spawn_session)
 *
 * Session-scoped tool that enables the main agent to create independent sessions
 * with configurable connection, model, sources, and an initial prompt.
 *
 * Two modes:
 * - help=true: Returns available connections, models, and sources
 * - Default: Creates a session and sends the prompt (fire-and-forget)
 */

import { z } from 'zod';
import type { SpawnSessionResult, SpawnSessionHelpResult } from './base-agent.ts';
import { localTool } from '../mcp/local-tools.ts';

export type SpawnSessionFn = (input: Record<string, unknown>) => Promise<SpawnSessionResult | SpawnSessionHelpResult>;

// Tool result type - matches what the SDK expects
type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function errorResponse(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

export interface SpawnSessionToolOptions {
  sessionId: string;
  /**
   * Lazy resolver for the spawn session callback.
   * Called at execution time to get the current callback from the session registry.
   */
  getSpawnSessionFn: () => SpawnSessionFn | undefined;
}

export function createSpawnSessionTool(options: SpawnSessionToolOptions) {
  return localTool(
    'spawn_session',
    `Create a new session that runs independently with its own prompt, connection, model, and sources.

Use this to delegate tasks to parallel sessions — research, analysis, drafts, or any work that benefits from separate context.

Call with help=true first to discover available connections, models, and sources.
When spawning, the 'prompt' parameter is required.

Optional overrides: model, llmConnection, permissionMode, thinkingLevel, enabledSourceSlugs, labels, workingDirectory. Omitted fields inherit from the spawning session or the workspace default.

thinkingLevel is silently ignored on non-reasoning models (e.g. gpt-4o, gemini-2.5-flash) — the SDK drops the reasoning param rather than erroring.

The spawned session appears in the session list and runs fire-and-forget.
Only use 'attachments' for existing file paths on disk — the tool reads them automatically.`,
    {
      help: z.boolean().optional()
        .describe('If true, returns available connections, models, and sources instead of creating a session'),
      prompt: z.string().optional()
        .describe('Instructions for the new session (required when not in help mode)'),
      name: z.string().optional()
        .describe('Session name'),
      llmConnection: z.string().optional()
        .describe('Connection slug (e.g., "qwen-code")'),
      model: z.string().optional()
        .describe('Model ID override'),
      enabledSourceSlugs: z.array(z.string()).optional()
        .describe('Source slugs to enable in the new session'),
      permissionMode: z.enum(['allow-all', 'safe', 'ask', 'auto-edit']).optional()
        .describe('Permission mode for the new session'),
      thinkingLevel: z.enum(['off', 'low', 'medium', 'high', 'xhigh', 'max']).optional()
        .describe('Reasoning level for the new session. Silently ignored on non-reasoning models (e.g. gpt-4o, gemini-2.5-flash). Omit to inherit the workspace default.'),
      labels: z.array(z.string()).optional()
        .describe('Labels for the new session'),
      workingDirectory: z.string().optional()
        .describe('Working directory for the new session'),
      attachments: z.array(z.object({
        path: z.string().describe('Absolute file path on disk'),
        name: z.string().optional().describe('Display name (defaults to file basename)'),
      })).optional()
        .describe('Files to include with the prompt'),
    },
    async (args) => {
      const spawnFn = options.getSpawnSessionFn();
      if (!spawnFn) {
        return errorResponse('spawn_session is not available in this context.');
      }

      try {
        const result = await spawnFn(args as Record<string, unknown>);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        if (error instanceof Error) {
          return errorResponse(`spawn_session failed: ${error.message}`);
        }
        throw error;
      }
    }
  );
}
