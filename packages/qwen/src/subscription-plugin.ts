/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CommandKind,
  type AppPlugin,
  type CommandContext,
  type SlashCommand,
} from '@qwen-code/cli';
import {
  QwenSubscriptionSession,
  getQwenSubscriptionPlansUrl,
} from '@qwen-code/core';
import { AuthType } from '@qwen-code/resource';

export interface QwenSubscriptionPluginDeps {
  readonly isSignedIn?: () => boolean;
  readonly openBrowser?: (url: string) => Promise<unknown>;
}

/** Same attribution the 0.x `/upgrade` sends with the plans page. */
export function getUpgradeUrl(): string {
  const url = new URL(getQwenSubscriptionPlansUrl());
  url.searchParams.set('entry', 'qwen_code');
  url.searchParams.set('paywallScene', 'cli');
  return url.toString();
}

/** `/upgrade` opens the Qwen subscription plans for a signed-in subscriber. */
export class QwenSubscriptionPlugin implements AppPlugin {
  readonly apiVersion = 1 as const;
  readonly id = 'qwen-subscription';

  constructor(private readonly deps: QwenSubscriptionPluginDeps = {}) {}

  async initialize() {}

  async dispose() {}

  getSlashCommands(): readonly SlashCommand[] {
    return [
      {
        name: 'upgrade',
        description: 'Open Qwen subscription plans',
        kind: CommandKind.BUILT_IN,
        action: (context) => this.upgrade(context),
      },
    ];
  }

  private async upgrade(context: CommandContext) {
    const selectedType =
      context.services.settings.merged.security?.auth?.selectedType;
    const isSignedIn =
      this.deps.isSignedIn ??
      (() => new QwenSubscriptionSession().isSignedIn());
    if (selectedType !== AuthType.QWEN_SUBSCRIPTION || !isSignedIn()) {
      return info(
        'This command is only available with Qwen Subscription login. Use /auth to sign in to Qwen Subscription.',
      );
    }
    const url = getUpgradeUrl();
    const suppressed =
      context.services.agentContext?.config?.isBrowserLaunchSuppressed?.() ??
      false;
    if (!suppressed) {
      try {
        const openBrowser =
          this.deps.openBrowser ??
          (async (target: string) => (await import('open')).default(target));
        await openBrowser(url);
      } catch {
        return info(`Could not open your browser. Visit ${url}`);
      }
    }
    return info(`Qwen subscription plans: ${url}`);
  }
}

function info(text: string) {
  return { type: 'local_command_result' as const, text };
}
