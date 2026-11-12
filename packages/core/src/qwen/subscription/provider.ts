/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SettingsService } from '@qwen-code/resource';
import { CustomClientImpl } from '../../client/customClientImpl.js';
import { createRetryingCustomInference } from '../../provider/impl/customModelInference.js';
import { CustomModelSelector } from '../../provider/impl/customModelSelector.js';
import { CustomProviderConfig } from '../../provider/impl/customProviderConfig.js';
import { ModelConfigStore } from '../../provider/impl/modelConfigStore.js';
import type { Model, ModelConfig } from '../../provider/model/model.js';
import type { ModelListOptions } from '../../provider/model/modelResolver.js';
import type { ModelSelectContext } from '../../provider/model/modelSelectContext.js';
import type { ModelSelection } from '../../provider/model/modelSelection.js';
import {
  classifyClientError,
  type ModelInferenceErrorDetail,
} from '../../provider/modelInferenceError.js';
import type { ModelProvider } from '../../provider/modelProvider.js';
import type { ModelStreamRequest } from '../../provider/modelStreamRequest.js';
import type { ModelStreamResponse } from '../../provider/modelStreamResponse.js';
import type { ModelTransport } from '../../provider/transport/modelTransport.js';
import type { ModelTransportManager } from '../../provider/transport/modelTransportManager.js';
import { OPENAI_CHAT_COMPLETIONS } from '../../provider/transport/modelProtocol.js';
import { ModelThinkingUtils } from '../../provider/utils/modelThinkingUtils.js';
import { runLogger } from '../../utils/runLogger.js';
import { createQwenSubscriptionModelResolver } from './model-resolver.js';
import {
  QWEN_SUBSCRIPTION_BASE_URL,
  QWEN_SUBSCRIPTION_PROVIDER_ID,
} from './oauth-config.js';
import {
  QWEN_SUBSCRIPTION_SIGNED_OUT_HINT,
  QwenSubscriptionSession,
} from './session.js';

const QWEN_SUBSCRIPTION_THINKING_BUDGETS: Readonly<Record<string, number>> = {
  low: 4_096,
  medium: 16_384,
  high: 32_768,
  xhigh: 32_768,
  max: 32_768,
};

/**
 * Endpoint/auth binding for the membership provider. The bearer token is a
 * rotating credential owned by the session rather than a settings key.
 */
export class QwenSubscriptionProviderConfig extends CustomProviderConfig {
  private readonly session: QwenSubscriptionSession;

  constructor(options: {
    models: readonly Model[];
    session?: QwenSubscriptionSession;
  }) {
    super({
      providerId: QWEN_SUBSCRIPTION_PROVIDER_ID,
      baseUrl: QWEN_SUBSCRIPTION_BASE_URL,
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

export interface CreateQwenSubscriptionProviderOptions {
  readonly transportManager: ModelTransportManager;
  readonly settingsService: SettingsService;
  readonly session?: QwenSubscriptionSession;
}

/**
 * Account-backed Qwen membership provider.
 *
 * Mirrors `QoderProvider`: a dedicated `ModelProvider` whose catalog comes
 * from the account (credential cache + gateway refresh) instead of user
 * settings, while reusing the shared selector, preference store and
 * inference pipeline.
 */
export class QwenSubscriptionProvider implements ModelProvider {
  readonly providerId = QWEN_SUBSCRIPTION_PROVIDER_ID;
  private readonly models: Model[] = [];
  private readonly config: QwenSubscriptionProviderConfig;
  private readonly transport: ModelTransport;
  private readonly client: CustomClientImpl;
  private readonly resolver: ReturnType<typeof createQwenSubscriptionModelResolver>;
  private readonly selector: CustomModelSelector;
  private readonly store: ModelConfigStore;
  private readonly active = new Set<ModelStreamResponse>();

  constructor(options: CreateQwenSubscriptionProviderOptions) {
    const session = options.session ?? new QwenSubscriptionSession();
    this.config = new QwenSubscriptionProviderConfig({
      models: this.models,
      session,
    });
    this.transport = options.transportManager.resolve(OPENAI_CHAT_COMPLETIONS);
    this.client = new CustomClientImpl({ customProviderConfig: this.config });
    this.resolver = createQwenSubscriptionModelResolver(session, this.models);
    this.selector = new CustomModelSelector(this.config, this);
    this.store = new ModelConfigStore({
      providerId: this.providerId,
      settingsService: options.settingsService,
      scope: 'user',
    });
  }

  start(): Promise<void> {
    this.store.start();
    // Warm the catalog in the background so session startup never waits on
    // the gateway; `listModels`/`getModel` join this in-flight fetch.
    void this.resolver.listModels().catch((error: unknown) => {
      runLogger.warn(`[qwen-subscription] initial catalog failed: ${error}`);
    });
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.store.stop();
    for (const response of this.active) void response.cancel?.();
    this.active.clear();
    return Promise.resolve();
  }

  listModels(options?: ModelListOptions): Promise<Model[]> {
    return this.resolver.listModels(options);
  }

  getModel(key: string): Promise<Model | undefined> {
    return this.resolver.getModel(key);
  }

  select(context: ModelSelectContext): Promise<ModelSelection> {
    return this.selector.select(context);
  }

  getModelConfig(model: Model): ModelConfig | undefined {
    return this.store.load(model.key);
  }

  setModelConfig(model: Model, patch: ModelConfig, persist?: boolean): boolean {
    return this.store.save(model.key, patch, persist);
  }

  inference(request: ModelStreamRequest): Promise<ModelStreamResponse> {
    const response = createRetryingCustomInference(
      this.transport,
      this.client,
      resolveQwenSubscriptionStreamRequest(request),
      (error) => this.classifyError(error),
      { firstPayloadTimeoutMs: this.config.firstPayloadTimeoutMs },
    );
    this.active.add(response);
    const cleanup = () => {
      this.active.delete(response);
    };
    void response.completed.then(cleanup, cleanup);
    return Promise.resolve(response);
  }

  /**
   * Rejected credentials surface the same recovery hint as the session, while
   * preserving 403 server business messages (e.g. model/plan access denied).
   */
  private classifyError(error: unknown): ModelInferenceErrorDetail {
    const detail = classifyClientError(error);
    if (
      detail.status === 401 ||
      (detail.kind === 'auth' && !detail.message)
    ) {
      return { ...detail, message: QWEN_SUBSCRIPTION_SIGNED_OUT_HINT };
    }
    return detail;
  }
}

/**
 * Translate abstract reasoning effort tiers into the explicit thinking budget
 * contract expected by the Qwen Subscription gateway before handing the
 * request to the generic Chat Completions transport.
 */
export function resolveQwenSubscriptionStreamRequest(
  request: ModelStreamRequest,
): ModelStreamRequest {
  const { model, config } = request.resolution;
  if (!model.capabilities.reasoning.supported) return request;
  const reasoning = config.reasoning;
  if (ModelThinkingUtils.isDisabled(config)) {
    return {
      ...request,
      resolution: {
        model,
        config: {
          ...config,
          reasoning: {
            ...(reasoning?.preserve !== undefined
              ? { preserve: reasoning.preserve }
              : {}),
            thinking: { type: 'disabled' },
          },
        },
      },
    };
  }
  const budgetTokens =
    reasoning?.thinking?.type === 'enabled'
      ? reasoning.thinking.budgetTokens
      : QWEN_SUBSCRIPTION_THINKING_BUDGETS[reasoning?.effort ?? 'medium'];
  if (budgetTokens === undefined) return request;
  return {
    ...request,
    resolution: {
      model,
      config: {
        ...config,
        reasoning: {
          ...(reasoning?.preserve !== undefined
            ? { preserve: reasoning.preserve }
            : {}),
          thinking: { type: 'enabled', budgetTokens },
        },
      },
    },
  };
}
