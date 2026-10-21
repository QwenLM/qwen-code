/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  SERVE_CONTROL_EXT_METHODS,
  SERVE_STATUS_EXT_METHODS,
} from '@qwen-code/acp-bridge/status';
import { CommandKind } from '../ui/commands/types.js';
import {
  isSshSessionCommandAllowed,
  isSshWorkspaceExtMethodAllowed,
} from './ssh-workspace-guards.js';

describe('SSH workspace guards', () => {
  it('allows reviewed session commands and rejects executable custom commands with the same name', () => {
    expect(
      isSshSessionCommandAllowed({ name: 'model', kind: CommandKind.BUILT_IN }),
    ).toBe(true);
    expect(
      isSshSessionCommandAllowed({ name: 'model', kind: CommandKind.FILE }),
    ).toBe(false);
    for (const name of [
      'cd',
      'clear',
      'status',
      'about',
      'init',
      'diff',
      'directory',
      'workflows',
      'dream',
      'fork',
      'unknown',
    ]) {
      expect(
        isSshSessionCommandAllowed({ name, kind: CommandKind.BUILT_IN }),
      ).toBe(false);
    }
  });

  it('blocks every workspace mutation and unsupported session executor', () => {
    for (const method of Object.values(SERVE_CONTROL_EXT_METHODS)) {
      if (method.startsWith('qwen/control/workspace/')) {
        expect(isSshWorkspaceExtMethodAllowed(method)).toBe(false);
      }
    }
    for (const method of [
      SERVE_CONTROL_EXT_METHODS.sessionCd,
      SERVE_CONTROL_EXT_METHODS.sessionRewind,
      SERVE_CONTROL_EXT_METHODS.sessionForkAgent,
      SERVE_CONTROL_EXT_METHODS.sessionSideTask,
      SERVE_CONTROL_EXT_METHODS.sessionMcpRuntimeAdd,
      SERVE_CONTROL_EXT_METHODS.sessionWorkflowTaskAction,
      'qwen/settings/setCoreValue',
      'qwen/settings/setMemory',
      'qwen/skills/install',
      'rewindSession',
    ])
      expect(isSshWorkspaceExtMethodAllowed(method)).toBe(false);
  });

  it('retains local session ownership, approval, history and cancellation controls', () => {
    for (const method of [
      SERVE_CONTROL_EXT_METHODS.sessionClose,
      SERVE_CONTROL_EXT_METHODS.sessionApprovalMode,
      SERVE_CONTROL_EXT_METHODS.sessionTitle,
      SERVE_CONTROL_EXT_METHODS.sessionParent,
      SERVE_CONTROL_EXT_METHODS.sessionContinue,
      SERVE_STATUS_EXT_METHODS.sessionTranscript,
      SERVE_STATUS_EXT_METHODS.sessionSupportedCommands,
      SERVE_STATUS_EXT_METHODS.channelPing,
      'qwen/settings/getCore',
      'qwen/permissions/setRules',
    ])
      expect(isSshWorkspaceExtMethodAllowed(method)).toBe(true);
  });
});
