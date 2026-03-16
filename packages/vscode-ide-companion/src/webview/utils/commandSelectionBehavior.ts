/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AvailableCommand } from '@agentclientprotocol/sdk';

export type CommandSelectionAction =
  | { kind: 'execute-login' }
  | { kind: 'open-model-selector' }
  | { kind: 'insert' };

export function resolveCommandSelectionAction(
  itemId: string,
  availableCommands: ReadonlyArray<Pick<AvailableCommand, 'name'>>,
): CommandSelectionAction {
  if (itemId === 'login') {
    return { kind: 'execute-login' };
  }

  if (itemId === 'model') {
    return { kind: 'open-model-selector' };
  }

  if (availableCommands.some((command) => command.name === itemId)) {
    return { kind: 'insert' };
  }

  return { kind: 'insert' };
}
