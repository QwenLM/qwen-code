/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Discovers saved workflow scripts under `.qwen/workflows/`
 * (project) and `~/.qwen/workflows/` (user) and exposes each as a `/<name>`
 * slash command that dispatches the `workflow` tool with the file's path.
 * The script is read at execution time (by the tool), so edits to a saved
 * workflow take effect on the next invocation.
 *
 * Enumeration, project-over-user precedence, and the name constraint all live
 * in core's `listSavedWorkflows` — the single source of truth shared with the
 * `workflow('<name>')` in-script global. This loader only adapts the
 * discovered entries into `SlashCommand` objects.
 */

import type { Config, SavedWorkflowEntry } from '@qwen-code/qwen-code-core';
import {
  listSavedWorkflows,
  ToolNames,
  createDebugLogger,
} from '@qwen-code/qwen-code-core';
import type { ICommandLoader } from './types.js';
import type {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from '../ui/commands/types.js';
import { CommandKind } from '../ui/commands/types.js';

const debugLogger = createDebugLogger('SavedWorkflowLoader');

export class SavedWorkflowLoader implements ICommandLoader {
  constructor(private readonly config: Config | null) {}

  async loadCommands(signal: AbortSignal): Promise<SlashCommand[]> {
    if (!this.config) return [];
    // Feature gate: the `workflow` tool is only registered when the feature
    // flag is on, so without this guard the commands would dispatch a tool
    // that doesn't exist.
    if (!this.config.isWorkflowsEnabled?.()) return [];
    // Mirror FileCommandLoader: saved workflows execute project-local code, so
    // skip discovery in bare mode and in untrusted folders.
    if (this.config.getBareMode?.()) return [];
    const folderTrustEnabled = !!this.config.getFolderTrustFeature?.();
    const folderTrust = !!this.config.getFolderTrust?.();
    if (folderTrustEnabled && !folderTrust) return [];

    let entries: SavedWorkflowEntry[];
    try {
      entries = await listSavedWorkflows(this.config);
    } catch (e) {
      debugLogger.debug(`listSavedWorkflows failed: ${e}`);
      return [];
    }
    if (signal.aborted) return [];
    return entries.map((entry) => this.toCommand(entry));
  }

  private toCommand(entry: SavedWorkflowEntry): SlashCommand {
    return {
      name: entry.name,
      description: `Run the "${entry.name}" saved workflow (${entry.source})`,
      // File-derived command (all execution modes via commandUtils fallback);
      // `source` carries the distinct workflow identity for display/telemetry.
      kind: CommandKind.FILE,
      source: 'workflow-command',
      sourceLabel: 'Workflow',
      sourceDetail: entry.source, // 'project' | 'user'
      // Interactive only: the action returns a `{type:'tool'}` dispatch, which
      // the non-interactive command adapter converts to `unsupported`. Listing
      // these in headless / ACP modes would advertise a command that then fails
      // to run, so restrict them until those paths can execute a tool return.
      supportedModes: ['interactive'],
      acceptsInput: true,
      argumentHint: '[json-args]',
      action: (
        _context: CommandContext,
        args: string,
      ): SlashCommandActionReturn => {
        const toolArgs: Record<string, unknown> = {
          // The tool reads the file fresh at execution time (hot reload).
          scriptPath: entry.scriptPath,
        };
        const trimmed = (args ?? '').trim();
        if (trimmed.length > 0) {
          // Forward user-supplied text to the script's `args` global. Parse as
          // JSON when valid (objects / arrays / numbers — matching the tool's
          // "actual JSON value" contract), else pass the raw string so plain
          // text still reaches the script.
          toolArgs['args'] = tryParseJson(trimmed);
        }
        return {
          type: 'tool',
          toolName: ToolNames.WORKFLOW,
          toolArgs,
        };
      },
    };
  }
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
