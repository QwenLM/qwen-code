/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { SERVE_CONTROL_EXT_METHODS } from '@qwen-code/acp-bridge/status';
import {
  CommandKind,
  type NonInteractiveSlashCommandPolicy,
  type SlashCommand,
} from '../ui/commands/types.js';

export const SSH_SLASH_COMMAND_POLICY: NonInteractiveSlashCommandPolicy = {
  allowSessionReset: false,
  allowWorkspaceSettingsWrite: false,
  persistModelSelection: false,
  blockedBuiltinCommandNames: [],
};

const sshCommands = new Set(['help', 'model', 'effort', 'compress', 'context']);

export function isSshSessionCommandAllowed(
  command: Pick<SlashCommand, 'name' | 'kind'>,
): boolean {
  return command.kind === CommandKind.BUILT_IN && sshCommands.has(command.name);
}

const unsupportedSessionMethods = new Set<string>([
  SERVE_CONTROL_EXT_METHODS.sessionCd,
  SERVE_CONTROL_EXT_METHODS.sessionBranch,
  SERVE_CONTROL_EXT_METHODS.sessionSideTask,
  SERVE_CONTROL_EXT_METHODS.sessionForkAgent,
  SERVE_CONTROL_EXT_METHODS.sessionBtw,
  SERVE_CONTROL_EXT_METHODS.sessionArtifactsPersist,
  SERVE_CONTROL_EXT_METHODS.sessionRewind,
  SERVE_CONTROL_EXT_METHODS.sessionWorkflowTaskAction,
  SERVE_CONTROL_EXT_METHODS.sessionMcpRuntimeAdd,
  SERVE_CONTROL_EXT_METHODS.sessionMcpRuntimeRemove,
  SERVE_CONTROL_EXT_METHODS.sessionLanguage,
  SERVE_CONTROL_EXT_METHODS.sessionManagedConversationBindingCommit,
  SERVE_CONTROL_EXT_METHODS.sessionManagedConversationBindingRelease,
  'rewindSession',
]);

export function isSshWorkspaceExtMethodAllowed(method: string): boolean {
  return !(
    method.startsWith('qwen/control/workspace/') ||
    method.startsWith('qwen/skills/') ||
    method.startsWith('qwen/session/sources/') ||
    (method.startsWith('qwen/settings/') &&
      method !== 'qwen/settings/getCore') ||
    unsupportedSessionMethods.has(method)
  );
}
