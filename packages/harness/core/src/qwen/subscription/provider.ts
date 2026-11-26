/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { CustomClientImpl } from '../../client/customClientImpl.js';
import type { Model } from '../../provider/model/model.js';
import type { ModelProvider } from '../../provider/modelProvider.js';
import { CustomModelProvider } from '../../provider/impl/customModelProvider.js';
import {
  registerCustomProviderComposer,
  type ComposeCustomProviderContext,
} from '../../provider/impl/customProviderComposers.js';
import { CustomProviderConfig } from '../../provider/impl/customProviderConfig.js';
import { OPENAI_CHAT_COMPLETIONS } from '../../provider/transport/modelProtocol.js';
import {
  orderSubscriptionModels,
  qwenSubscriptionModel,
} from './models.js';
import {
  QWEN_SUBSCRIPTION_BASE_URL,
  QWEN_SUBSCRIPTION_PROVIDER_ID,
} from './oauth-config.js';
import { QwenSubscriptionSession } from './session.js';

/**
 * Endpoint/auth binding for the membership provider. The bearer token is a
 * rotating credential owned by the session rather than a settings key; the
 * catalog itself is the model list persisted in `settings.providers`.
 */
export class QwenSubscriptionProviderConfig extends CustomProviderConfig {
  private readonly session: QwenSubscriptionSession;

  constructor(options: {
    models: readonly Model[];
    session?: QwenSubscriptionSession;
    baseUrl?: string;
  }) {
    super({
      providerId: QWEN_SUBSCRIPTION_PROVIDER_ID,
      baseUrl: options.baseUrl ?? QWEN_SUBSCRIPTION_BASE_URL,
      models: options.models,
      protocol: OPENAI_CHAT_COMPLETIONS,
    });
    this.session = options.session ?? new QwenSubscriptionSession();
  }

  async getBearerAsync(): Promise<string | undefined> {
    return this.session.getAccessToken();
  }

  async refreshBearer(rejectedToken?: string): Promise<string | undefined> {
    return this.session.getAccessToken(undefined, rejectedToken);
  }
}

interface SubscriptionProviderSettings {
  readonly baseUrl: string;
  readonly models: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readSubscriptionProviderSettings(
  value: unknown,
): SubscriptionProviderSettings | undefined {
  if (!isRecord(value)) return undefined;
  const baseUrl =
    readString(value['baseUrl'])?.trim() || QWEN_SUBSCRIPTION_BASE_URL;
  const rawModels = Array.isArray(value['models']) ? value['models'] : [];
  const ids: string[] = [];
  for (const item of rawModels) {
    if (!isRecord(item)) continue;
    const id = readString(item['model'])?.trim();
    if (id) ids.push(id);
  }
  if (ids.length === 0) return undefined;
  return { baseUrl, models: [...new Set(ids)] };
}

/**
 * Composes the account provider from its reserved settings entry. Without a
 * stored login nothing is built, so the entry never lists unusable models;
 * the catalog is the persisted list (refreshed by an explicit sign-in).
 */
export function composeQwenSubscriptionProvider(
  context: ComposeCustomProviderContext,
  session: QwenSubscriptionSession = new QwenSubscriptionSession(),
): ModelProvider | undefined {
  const settings = readSubscriptionProviderSettings(context.value);
  if (!settings || !session.isSignedIn()) return undefined;
  const config = new QwenSubscriptionProviderConfig({
    baseUrl: settings.baseUrl,
    models: orderSubscriptionModels(settings.models).map(qwenSubscriptionModel),
    session,
  });
  return new CustomModelProvider({
    transportManager: context.transportManager,
    config,
    client: new CustomClientImpl({ customProviderConfig: config }),
    settingsService: context.settingsService,
    scope: context.scope,
    cwd: context.cwd,
  });
}

export function registerQwenSubscriptionProviderComposer(): void {
  registerCustomProviderComposer(
    QWEN_SUBSCRIPTION_PROVIDER_ID,
    (context) => composeQwenSubscriptionProvider(context),
  );
}

registerQwenSubscriptionProviderComposer();
