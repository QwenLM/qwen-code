/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Full-parity slash-command registry for the OpenTUI renderer (PR1 slice 5).
 *
 * Two registrations, both checked against the ORIGINAL sources:
 *
 * 1. Dialog routing — `routeDialogToOpenTui` maps every dialog kind the
 *    original commands can return (`OpenDialogActionReturn['dialog']`,
 *    ui/commands/types.ts) onto the OpenTUI dialog family, mirroring the
 *    `actions.open*` switch in ui/hooks/slashCommandProcessor.ts. The
 *    model-family dialogs all land on OpenTuiModelDialog (dialogs-model.tsx)
 *    with the mode the ink ModelDialog receives; `/resume <id>` and
 *    `/branch` are host actions (handleResume / handleBranch), never dialogs.
 *
 * 2. Command routes — one entry per built-in command module registered by
 *    services/BuiltinCommandLoader.ts (69 modules). Each entry lists the
 *    action-result kinds the command can produce and the dialogs it opens,
 *    so the OpenTUI dispatcher covers every built-in command the ink TUI
 *    does. `commands-registry.test.ts` cross-checks names, aliases, and
 *    gates against the real command objects.
 */

import type { SessionListItem } from '@qwen-code/qwen-code-core';
import type { OpenDialogActionReturn } from '../commands/types.js';
import type { ModelDialogMode } from './dialogs-model.js';

/** Every dialog kind an original slash command can request. */
export type InkDialogKind = OpenDialogActionReturn['dialog'];

/** The OpenTUI dialog a routed dialog request opens. */
export type OpenTuiDialogRequest =
  | { dialog: 'help' }
  | { dialog: 'theme' }
  | { dialog: 'editor' }
  | { dialog: 'settings' }
  | { dialog: 'statusline' }
  | { dialog: 'memory' }
  | { dialog: 'auth' }
  | { dialog: 'trust' }
  | { dialog: 'permissions' }
  | { dialog: 'approval-mode' }
  | { dialog: 'effort' }
  | { dialog: 'delete' }
  | { dialog: 'resume'; matchedSessions?: SessionListItem[] }
  | { dialog: 'branch'; name?: string }
  | { dialog: 'extensions_manage' }
  | { dialog: 'hooks' }
  | { dialog: 'mcp' }
  | { dialog: 'rewind' }
  | { dialog: 'diff' }
  | { dialog: 'stats' }
  | { dialog: 'arena'; mode: 'start' | 'select' | 'stop' | 'status' }
  | { dialog: 'subagent_create' }
  | { dialog: 'subagent_list' }
  | { dialog: 'skills_manage' }
  | {
      dialog: 'model';
      mode: ModelDialogMode;
      persistScope?: 'workspace' | 'user';
    };

/**
 * Parity of the `case 'dialog'` switch in ui/hooks/slashCommandProcessor.ts:
 * every dialog kind maps to exactly the dialog (and mode) the ink actions
 * open. Exhaustive — a new dialog kind fails the `never` check at compile
 * time.
 */
export function routeDialogToOpenTui(
  result: OpenDialogActionReturn,
): OpenTuiDialogRequest {
  const dialog = result.dialog;
  switch (dialog) {
    case 'help':
      return { dialog: 'help' };
    case 'theme':
      return { dialog: 'theme' };
    case 'editor':
      return { dialog: 'editor' };
    case 'settings':
      return { dialog: 'settings' };
    case 'statusline':
      return { dialog: 'statusline' };
    case 'memory':
      return { dialog: 'memory' };
    case 'auth':
      return { dialog: 'auth' };
    case 'trust':
      return { dialog: 'trust' };
    case 'permissions':
      return { dialog: 'permissions' };
    case 'approval-mode':
      return { dialog: 'approval-mode' };
    case 'effort':
      return { dialog: 'effort' };
    case 'delete':
      return { dialog: 'delete' };
    case 'resume':
      return result.matchedSessions
        ? { dialog: 'resume', matchedSessions: result.matchedSessions }
        : { dialog: 'resume' };
    case 'branch':
      return result.name
        ? { dialog: 'branch', name: result.name }
        : { dialog: 'branch' };
    case 'extensions_manage':
      return { dialog: 'extensions_manage' };
    case 'hooks':
      return { dialog: 'hooks' };
    case 'mcp':
      return { dialog: 'mcp' };
    case 'rewind':
      return { dialog: 'rewind' };
    case 'diff':
      return { dialog: 'diff' };
    case 'stats':
      return { dialog: 'stats' };
    case 'arena_start':
      return { dialog: 'arena', mode: 'start' };
    case 'arena_select':
      return { dialog: 'arena', mode: 'select' };
    case 'arena_stop':
      return { dialog: 'arena', mode: 'stop' };
    case 'arena_status':
      return { dialog: 'arena', mode: 'status' };
    case 'subagent_create':
      return { dialog: 'subagent_create' };
    case 'subagent_list':
      return { dialog: 'subagent_list' };
    case 'skills_manage':
      return { dialog: 'skills_manage' };
    case 'model':
      return {
        dialog: 'model',
        mode: 'primary',
        ...(result.persistScope ? { persistScope: result.persistScope } : {}),
      };
    case 'fast-model':
      return {
        dialog: 'model',
        mode: 'fast',
        ...(result.persistScope ? { persistScope: result.persistScope } : {}),
      };
    case 'voice-model':
      return {
        dialog: 'model',
        mode: 'voice',
        ...(result.persistScope ? { persistScope: result.persistScope } : {}),
      };
    case 'vision-model':
      return {
        dialog: 'model',
        mode: 'vision',
        ...(result.persistScope ? { persistScope: result.persistScope } : {}),
      };
    case 'compaction-model':
      return {
        dialog: 'model',
        mode: 'compaction',
        ...(result.persistScope ? { persistScope: result.persistScope } : {}),
      };
    case 'image-model':
      return {
        dialog: 'model',
        mode: 'image',
        ...(result.persistScope ? { persistScope: result.persistScope } : {}),
      };
    default: {
      const unhandled: never = dialog;
      throw new Error(`Unhandled slash command dialog: ${unhandled}`);
    }
  }
}

/** Action-result kinds the original commands can produce. */
export type SlashResultKind =
  | 'none'
  | 'message'
  | 'dialog'
  | 'quit'
  | 'tool'
  | 'submit_prompt'
  | 'load_history'
  | 'confirm_shell_commands'
  | 'confirm_action'
  | 'goal_control'
  | 'stream_messages';

/** Config-based gates mirrored from services/BuiltinCommandLoader.ts. */
export type CommandGate =
  | 'workflows'
  | 'managed-memory'
  | 'folder-trust'
  | 'lsp';

/** Route entry for one built-in command module. */
export interface CommandRouteSpec {
  readonly name: string;
  readonly altNames?: readonly string[];
  /** Union of result kinds across the command and its subcommands. */
  readonly results: readonly SlashResultKind[];
  /** Dialog kinds the command may open (subset of `results` ∋ 'dialog'). */
  readonly dialogs?: readonly InkDialogKind[];
  readonly gatedBy?: CommandGate;
}

/**
 * All 69 built-in command modules, one entry each, in the registration order
 * of BuiltinCommandLoader.ts. `/status` is aboutCommand's canonical name
 * ('about' is the alias); names with subcommands list the union of the whole
 * command tree.
 */
export const OPEN_TUI_COMMAND_ROUTES: readonly CommandRouteSpec[] = [
  { name: 'status', altNames: ['about'], results: ['none', 'message'] },
  {
    name: 'agents',
    results: ['dialog'],
    dialogs: ['subagent_create', 'subagent_list'],
  },
  { name: 'tasks', results: ['message'] },
  { name: 'workflows', results: ['message'], gatedBy: 'workflows' },
  {
    name: 'arena',
    results: ['dialog', 'message', 'confirm_action'],
    dialogs: ['arena_start', 'arena_select', 'arena_stop', 'arena_status'],
  },
  {
    name: 'approval-mode',
    results: ['dialog', 'message'],
    dialogs: ['approval-mode'],
  },
  { name: 'advisor', results: ['message'] },
  {
    name: 'auth',
    altNames: ['connect', 'login'],
    results: ['dialog', 'message'],
    dialogs: ['auth'],
  },
  { name: 'branch', results: ['dialog', 'message'], dialogs: ['branch'] },
  { name: 'btw', results: ['message'] },
  { name: 'fork', results: ['message'] },
  { name: 'bug', results: ['none'] },
  { name: 'cd', results: ['confirm_action', 'message'] },
  { name: 'clear', altNames: ['reset', 'new'], results: ['message'] },
  {
    name: 'compress',
    altNames: ['summarize'],
    results: ['message', 'stream_messages'],
  },
  { name: 'compress-fast', results: ['message', 'stream_messages'] },
  { name: 'config', results: ['message'] },
  { name: 'context', results: ['message'] },
  { name: 'curator', results: ['message'] },
  { name: 'copy', results: ['message'] },
  { name: 'diff', results: ['dialog', 'message'], dialogs: ['diff'] },
  { name: 'delete', results: ['dialog'], dialogs: ['delete'] },
  { name: 'docs', results: ['message'] },
  { name: 'doctor', results: ['message'] },
  { name: 'directory', altNames: ['dir'], results: ['message'] },
  { name: 'editor', results: ['dialog'], dialogs: ['editor'] },
  { name: 'effort', results: ['dialog', 'message'], dialogs: ['effort'] },
  { name: 'export', results: ['message'] },
  {
    name: 'extensions',
    results: ['dialog', 'message'],
    dialogs: ['extensions_manage'],
  },
  { name: 'help', altNames: ['?'], results: ['dialog'], dialogs: ['help'] },
  { name: 'history', results: ['message'] },
  { name: 'hooks', results: ['dialog', 'message'], dialogs: ['hooks'] },
  { name: 'ide', results: ['message'] },
  { name: 'import-config', results: ['message'] },
  { name: 'init', results: ['confirm_action', 'message', 'submit_prompt'] },
  { name: 'language', results: ['message'] },
  { name: 'learn', results: ['message', 'submit_prompt'] },
  { name: 'mcp', results: ['dialog', 'message'], dialogs: ['mcp'] },
  {
    name: 'dream',
    results: ['message', 'submit_prompt'],
    gatedBy: 'managed-memory',
  },
  { name: 'forget', results: ['message'], gatedBy: 'managed-memory' },
  {
    name: 'goal',
    results: ['goal_control', 'message', 'submit_prompt'],
  },
  { name: 'memory', results: ['dialog'], dialogs: ['memory'] },
  {
    name: 'model',
    results: ['dialog', 'message', 'submit_prompt'],
    dialogs: [
      'model',
      'fast-model',
      'voice-model',
      'vision-model',
      'compaction-model',
      'image-model',
    ],
  },
  { name: 'remember', results: ['message', 'submit_prompt'] },
  { name: 'plan', results: ['message', 'submit_prompt'] },
  { name: 'peers', results: ['message'] },
  { name: 'permissions', results: ['dialog'], dialogs: ['permissions'] },
  {
    name: 'trust',
    results: ['dialog'],
    dialogs: ['trust'],
    gatedBy: 'folder-trust',
  },
  { name: 'quit', altNames: ['exit'], results: ['quit'] },
  { name: 'recap', results: ['message'] },
  { name: 'reload-plugins', results: ['message'] },
  { name: 'rename', altNames: ['tag'], results: ['message'] },
  { name: 'restore', results: ['message', 'tool'] },
  {
    name: 'resume',
    altNames: ['continue'],
    results: ['dialog', 'message'],
    dialogs: ['resume'],
  },
  {
    name: 'rewind',
    altNames: ['rollback'],
    results: ['dialog'],
    dialogs: ['rewind'],
  },
  {
    name: 'skills',
    results: ['dialog', 'message'],
    dialogs: ['skills_manage'],
  },
  {
    name: 'stats',
    altNames: ['usage'],
    results: ['dialog', 'message'],
    dialogs: ['stats'],
  },
  { name: 'summary', results: ['message', 'stream_messages'] },
  { name: 'theme', results: ['dialog'], dialogs: ['theme'] },
  { name: 'tools', results: ['none'] },
  { name: 'settings', results: ['dialog'], dialogs: ['settings'] },
  { name: 'vim', results: ['message'] },
  { name: 'update', results: ['message'] },
  { name: 'voice', results: ['message'] },
  { name: 'setup-github', results: ['tool'] },
  { name: 'terminal-setup', results: ['message'] },
  { name: 'insight', results: ['message', 'stream_messages'] },
  {
    name: 'statusline',
    results: ['dialog', 'submit_prompt'],
    dialogs: ['statusline'],
  },
  { name: 'lsp', results: ['message'], gatedBy: 'lsp' },
];

/** Route lookup by canonical command name. */
export function commandRouteFor(name: string): CommandRouteSpec | undefined {
  return OPEN_TUI_COMMAND_ROUTES.find((route) => route.name === name);
}
