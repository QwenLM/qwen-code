/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { QwenSubscriptionSession } from '@qwen-code/qwen-code-core/qwen/subscription-session.js';
import { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import {
  filterSubscriptionCommands,
  logoutCommand,
  upgradeCommand,
} from './subscription-commands.js';

const browser = vi.hoisted(() => vi.fn());
vi.mock('@qwen-code/qwen-code-core/utils/secure-browser-launcher.js', () => ({
  openBrowserSecurely: browser,
}));

let qwenDirectory: string;
beforeEach(async () => {
  qwenDirectory = await mkdtemp(path.join(os.tmpdir(), 'qwen-command-repro-'));
  vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(qwenDirectory);
  browser.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(qwenDirectory, { recursive: true, force: true });
});

it('hides account commands when the selected subscription connection has no signed-in account', async () => {
  expect(await new QwenSubscriptionSession().getUserInfo()).toBeNull();

  expect(
    filterSubscriptionCommands(
      [logoutCommand, upgradeCommand],
      AuthType.QWEN_SUBSCRIPTION,
    ),
  ).toEqual([]);
});

it('does not launch the plans page for a signed-out subscription connection', async () => {
  expect(await new QwenSubscriptionSession().getUserInfo()).toBeNull();
  const context = createMockCommandContext({
    services: {
      config: {
        getAuthType: () => AuthType.QWEN_SUBSCRIPTION,
        isBrowserLaunchSuppressed: () => false,
      },
    },
  });

  await upgradeCommand.action!(context, '');

  expect(browser).not.toHaveBeenCalled();
});

it('does not launch the plans page for another provider', async () => {
  const context = createMockCommandContext({
    services: {
      config: {
        getAuthType: () => AuthType.USE_OPENAI,
        isBrowserLaunchSuppressed: () => false,
      },
    },
  });

  await upgradeCommand.action!(context, '');

  expect(browser).not.toHaveBeenCalled();
});
