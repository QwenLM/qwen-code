/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';
import {
  logoutCommand,
  upgradeCommand,
} from '../commands/subscription-commands.js';
import { parseSlashCommand } from '../commands/commands.js';
import { CommandKind, type SlashCommand } from '../commands/types.js';
import { useSubscriptionCommandVisibility } from './use-subscription-command-visibility.js';

const account = vi.hoisted(() => ({
  signedIn: true,
  listeners: new Set<() => void>(),
}));
vi.mock('@qwen-code/qwen-code-core/qwen/subscription-session.js', () => ({
  QwenSubscriptionSession: class {
    isSignedIn = () => account.signedIn;
    onChange = (listener: () => void) => {
      account.listeners.add(listener);
      return () => account.listeners.delete(listener);
    };
  },
}));
beforeEach(() => {
  account.signedIn = true;
  account.listeners.clear();
});

const commands = Object.freeze([{ ...logoutCommand }, { ...upgradeCommand }]);

it('clears the cached plan when another session removes credentials without changing the model', () => {
  const setSubscriptionPlan = vi.fn();
  const config = {
    getAuthType: () => AuthType.QWEN_SUBSCRIPTION,
    onModelChange: () => () => {},
    setSubscriptionPlan,
  };
  const { result } = renderHook(() =>
    useSubscriptionCommandVisibility(commands, config),
  );
  expect(result.current).toBe(commands);
  act(() => {
    account.signedIn = false;
    account.listeners.forEach((listener) => listener());
  });
  expect(setSubscriptionPlan).toHaveBeenCalledWith(undefined);
  expect(config.getAuthType()).toBe(AuthType.QWEN_SUBSCRIPTION);
  expect(result.current).toEqual([]);
});

it('refreshes login, logout and external credential removal without a model change', () => {
  account.signedIn = false;
  const config = {
    getAuthType: () => AuthType.QWEN_SUBSCRIPTION,
    onModelChange: () => () => {},
    setSubscriptionPlan: vi.fn(),
  };
  const { result, unmount } = renderHook(() =>
    useSubscriptionCommandVisibility(commands, config),
  );
  expect(result.current).toEqual([]);
  act(() => {
    account.signedIn = true;
    account.listeners.forEach((listener) => listener());
  });
  expect(result.current).toBe(commands);
  act(() => {
    account.signedIn = false;
    account.listeners.forEach((listener) => listener());
  });
  expect(result.current).toEqual([]);
  unmount();
  expect(account.listeners.size).toBe(0);
});

it.each([
  undefined,
  AuthType.USE_OPENAI,
  AuthType.USE_OPENAI_RESPONSES,
  AuthType.USE_ANTHROPIC,
  AuthType.USE_GEMINI,
  AuthType.USE_VERTEX_AI,
  AuthType.QWEN_OAUTH,
])(
  'removes subscription entries for %s from presentation and manual dispatch',
  (authType) => {
    const config = {
      getAuthType: () => authType,
      onModelChange: () => () => {},
      setSubscriptionPlan: vi.fn(),
    };
    const { result } = renderHook(() =>
      useSubscriptionCommandVisibility(commands, config),
    );

    expect(result.current).toEqual([]);
    for (const command of commands) {
      expect(
        parseSlashCommand(`/${command.name}`, result.current).commandToExecute,
      ).toBeUndefined();
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
    setSubscriptionPlan: vi.fn(),
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
  expect(result.current).toEqual([]);

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
  for (const command of customCommands) {
    expect(
      parseSlashCommand(`/${command.name}`, result.current).commandToExecute,
    ).toBe(command);
  }
});
