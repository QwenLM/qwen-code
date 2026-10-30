/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';
import {
  logoutCommand,
  upgradeCommand,
} from '../commands/subscription-commands.js';
import { parseSlashCommand } from '../commands/commands.js';
import { CommandKind, type SlashCommand } from '../commands/types.js';
import { useSubscriptionCommandVisibility } from './use-subscription-command-visibility.js';

const commands = Object.freeze([{ ...logoutCommand }, { ...upgradeCommand }]);

it.each([
  undefined,
  AuthType.USE_OPENAI,
  AuthType.USE_OPENAI_RESPONSES,
  AuthType.USE_ANTHROPIC,
  AuthType.USE_GEMINI,
  AuthType.USE_VERTEX_AI,
  AuthType.QWEN_OAUTH,
])(
  'hides subscription entries for %s while retaining manual dispatch',
  (authType) => {
    const config = {
      getAuthType: () => authType,
      onModelChange: () => () => {},
    };
    const { result } = renderHook(() =>
      useSubscriptionCommandVisibility(commands, config),
    );

    expect(result.current.every((command) => command.hidden)).toBe(true);
    for (const command of commands) {
      expect(
        parseSlashCommand(`/${command.name}`, result.current).commandToExecute
          ?.action,
      ).toBe(command.action);
      expect(command.hidden).toBeUndefined();
    }
  },
);

it('updates on connection changes even when the model ID stays the same and unsubscribes', () => {
  let authType = AuthType.QWEN_SUBSCRIPTION;
  let notify: (model: string) => void = () => {};
  const unsubscribe = vi.fn();
  const config = {
    getAuthType: () => authType,
    onModelChange: (listener: (model: string) => void) => {
      notify = listener;
      return unsubscribe;
    },
  };
  const { result, unmount } = renderHook(() =>
    useSubscriptionCommandVisibility(commands, config),
  );
  expect(result.current).toBe(commands);

  act(() => {
    authType = AuthType.USE_OPENAI;
    notify('same-model');
  });
  expect(result.current.every((command) => command.hidden)).toBe(true);

  act(() => {
    authType = AuthType.QWEN_SUBSCRIPTION;
    notify('same-model');
  });
  expect(result.current).toBe(commands);

  unmount();
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it('preserves custom commands with the same names and unrelated hidden commands', () => {
  const customCommands: SlashCommand[] = [
    { ...logoutCommand, kind: CommandKind.FILE, action: vi.fn() },
    { ...upgradeCommand, kind: CommandKind.FILE, action: vi.fn() },
    {
      name: 'other',
      description: 'other',
      kind: CommandKind.BUILT_IN,
      hidden: true,
    },
  ];
  const { result } = renderHook(() =>
    useSubscriptionCommandVisibility(customCommands, null),
  );

  expect(result.current).toEqual(customCommands);
  expect(result.current[0]?.hidden).toBeUndefined();
  expect(result.current[1]?.hidden).toBeUndefined();
  expect(result.current[2]?.hidden).toBe(true);
});
