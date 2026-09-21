/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Discovers saved workflow scripts under `.qwen/workflows/`
 * (project) and `~/.qwen/workflows/` (user), plus the workflows active
 * extensions ship, and exposes each as a `/<name>` slash command.
 *
 * Typed in the interactive UI, the command dispatches the `workflow` tool with
 * the file's path in background mode so completion reaches the conversation;
 * the script is read at execution time, so edits take effect on the next
 * invocation. Everywhere else — headless, ACP, and the
 * model invoking the command through the Skill tool — a `{type:'tool'}` return
 * cannot run, so the command expands to a prompt asking the model to call
 * `Workflow({ name })`.
 *
 * An extension workflow whose script declares `meta.whenToUse` is listed for
 * the model, so the model can start it when a request matches that condition.
 * Every run still goes through the workflow approval.
 *
 * In a session that runs named workflows only (`tools.workflowNameOnly`) the
 * Workflow tool refuses a `scriptPath`, so the interactive command dispatches
 * the workflow by name instead.
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
import { extensionOwnerLabel } from './commandMetadata.js';

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
    // An extension workflow shows its own description; its owner is carried
    // once, by the source badge.
    const description =
      entry.source === 'extension' && entry.description
        ? entry.description
        : `Run the "${entry.name}" saved workflow (${entry.source})`;
    // Listed for the model only when a third-party author said when the
    // workflow applies. A user who consented to the extension still approves
    // every run; a workflow without the condition is left to the user.
    const modelInvocable = entry.source === 'extension' && !!entry.whenToUse;
    return {
      name: entry.name,
      description,
      ...(modelInvocable
        ? {
            modelInvocable: true,
            // Commands reach the skill listing as a name and a description,
            // so the condition rides in the description, as it does for a
            // skill entry.
            modelDescription: `${description} — ${entry.whenToUse}`,
            whenToUse: entry.whenToUse,
          }
        : {}),
      // File-derived command (all execution modes via commandUtils fallback);
      // `source` carries the distinct workflow identity for display/telemetry.
      kind: CommandKind.FILE,
      source: 'workflow-command',
      // An extension workflow names its owner, which becomes its source badge.
      sourceLabel: entry.extensionName
        ? extensionOwnerLabel({
            name: entry.extensionName,
            displayName: entry.extensionDisplayName,
          })
        : 'Workflow',
      sourceDetail: entry.source, // 'project' | 'user' | 'extension'
      // An extension workflow is an extension command. On a collision with its
      // extension's same-named skill, `CommandService` renames it to
      // `<extension>.<name>` and the skill keeps its surfaces; `workflowName`
      // keeps a denylist entry written with the documented name matching. A
      // user or project custom command of the same name still takes the slash
      // command, because `FileCommandLoader` loads after this loader.
      ...(entry.extensionName
        ? { extensionName: entry.extensionName, workflowName: entry.name }
        : {}),
      acceptsInput: true,
      argumentHint: '[json-args]',
      action: (
        context: CommandContext,
        args: string,
      ): SlashCommandActionReturn => {
        const workflowArgs = parseWorkflowArgs(args);
        if (
          context.executionMode === 'non_interactive' ||
          context.executionMode === 'acp'
        ) {
          return {
            type: 'submit_prompt',
            content: buildWorkflowInvocationPrompt(entry, workflowArgs),
          };
        }
        return {
          type: 'tool',
          toolName: ToolNames.WORKFLOW,
          toolArgs: {
            // Client-initiated tool results do not continue the model turn;
            // background runs deliver their result through the notification queue.
            run_in_background: true,
            // The tool reads the file fresh at execution time (hot reload).
            // A path keeps grants written as Workflow(scriptPath:...) working;
            // a name-only session refuses paths, so it names the workflow.
            ...(this.config?.isWorkflowNameOnly?.() === true
              ? { name: entry.name }
              : { scriptPath: entry.scriptPath }),
            ...(workflowArgs !== undefined ? { args: workflowArgs } : {}),
          },
        };
      },
    };
  }
}

/**
 * The prompt a workflow command expands to where it cannot dispatch the tool
 * itself. It names the workflow by its qualified name, not the command's: a
 * command renamed on a collision (`gcp.gcp:audit`) still runs `gcp:audit`.
 */
export function buildWorkflowInvocationPrompt(
  entry: SavedWorkflowEntry,
  workflowArgs: unknown,
): string {
  const name = JSON.stringify(entry.name);
  const call =
    workflowArgs === undefined
      ? `{ name: ${name} }`
      : `{ name: ${name}, args: ${JSON.stringify(workflowArgs)} }`;
  return [
    entry.source === 'extension'
      ? `Run the "${entry.name}" workflow.`
      : `Run the "${entry.name}" saved workflow (${entry.source}).`,
    entry.description,
    entry.whenToUse,
    `Invoke: Workflow(${call})`,
  ]
    .filter((part) => part)
    .join('\n\n');
}

/**
 * The script's `args` global from the text after the command. JSON when valid
 * (objects / arrays / numbers — matching the tool's "actual JSON value"
 * contract), else the raw string so plain text still reaches the script;
 * `undefined` when nothing was typed.
 */
function parseWorkflowArgs(raw: string): unknown {
  const trimmed = (raw ?? '').trim();
  return trimmed.length > 0 ? tryParseJson(trimmed) : undefined;
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
