/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '@qwen-code/cli';
import { getQwenSubscriptionPlansUrl } from '@qwen-code/core';
import {
  QwenSubscriptionPlugin,
  getUpgradeUrl,
  type QwenSubscriptionPluginDeps,
} from './subscription-plugin.js';

function context(
  selectedType: string | undefined,
  browserSuppressed = false,
): CommandContext {
  return {
    services: {
      settings: { merged: { security: { auth: { selectedType } } } },
      agentContext: {
        config: { isBrowserLaunchSuppressed: () => browserSuppressed },
      },
    },
  } as unknown as CommandContext;
}

function upgrade(deps: QwenSubscriptionPluginDeps, ctx: CommandContext) {
  const [command] = new QwenSubscriptionPlugin(deps).getSlashCommands();
  expect(command!.name).toBe('upgrade');
  return command!.action!(ctx, '');
}

describe('getUpgradeUrl', () => {
  it('adds the CLI paywall attribution to the plans page', () => {
    const url = new URL(getUpgradeUrl());
    const plans = new URL(getQwenSubscriptionPlansUrl());

    expect(url.origin + url.pathname).toBe(plans.origin + plans.pathname);
    expect(url.searchParams.get('memberPlan')).toBe('qwen_code');
    expect(url.searchParams.get('entry')).toBe('qwen_code');
    expect(url.searchParams.get('paywallScene')).toBe('cli');
  });
});

describe('/upgrade', () => {
  it.each([
    ['another auth type', 'openai', true],
    ['no auth type', undefined, true],
    ['a signed-out subscription', 'qwen-subscription', false],
  ])('points to /auth for %s', async (_label, selectedType, signedIn) => {
    const openBrowser = vi.fn();

    const result = await upgrade(
      { isSignedIn: () => signedIn, openBrowser },
      context(selectedType),
    );

    expect(result).toEqual({
      type: 'local_command_result',
      text: expect.stringContaining('Use /auth to sign in'),
    });
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it('opens the plans page for a signed-in subscriber', async () => {
    const openBrowser = vi.fn(async () => undefined);

    const result = await upgrade(
      { isSignedIn: () => true, openBrowser },
      context('qwen-subscription'),
    );

    expect(openBrowser).toHaveBeenCalledWith(getUpgradeUrl());
    expect(result).toEqual({
      type: 'local_command_result',
      text: `Qwen subscription plans: ${getUpgradeUrl()}`,
    });
  });

  it('only shows the URL when browser launch is suppressed', async () => {
    const openBrowser = vi.fn();

    const result = await upgrade(
      { isSignedIn: () => true, openBrowser },
      context('qwen-subscription', true),
    );

    expect(openBrowser).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'local_command_result',
      text: `Qwen subscription plans: ${getUpgradeUrl()}`,
    });
  });

  it('asks the user to visit the URL when the browser fails to open', async () => {
    const result = await upgrade(
      {
        isSignedIn: () => true,
        openBrowser: async () => {
          throw new Error('no browser');
        },
      },
      context('qwen-subscription'),
    );

    expect(result).toEqual({
      type: 'local_command_result',
      text: `Could not open your browser. Visit ${getUpgradeUrl()}`,
    });
  });
});
