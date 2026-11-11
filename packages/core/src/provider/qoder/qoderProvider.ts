/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SettingsService } from '@qwen-code/resource';
import { ClientError } from '../../client/clientError.js';
import {
  buildApiErrorDetails,
  parseApiErrorBody,
} from '../../protocol/provider/qoder-api-error.js';
import type { QoderClient } from '../../qoder/api/client/qoderClient.js';
import { createQoderModelResolver } from '../../qoder/api/model-resolver.js';
import { runLogger } from '../../utils/runLogger.js';
import type { Model, ModelConfig } from '../model/model.js';
import type {
  ModelListOptions,
  ModelResolver,
} from '../model/modelResolver.js';
import type { ModelSelectContext } from '../model/modelSelectContext.js';
import type { ModelSelection } from '../model/modelSelection.js';
import {
  classifyClientError,
  type ModelInferenceErrorClassifier,
} from '../modelInferenceError.js';
import { QODER_PROVIDER_ID, type ModelProvider } from '../modelProvider.js';
import type { ModelStreamRequest } from '../modelStreamRequest.js';
import type { ModelStreamResponse } from '../modelStreamResponse.js';
import { CustomModelSelector } from '../impl/customModelSelector.js';
import { CustomProviderConfig } from '../impl/customProviderConfig.js';
import { createRetryingCustomInference } from '../impl/customModelInference.js';
import { ModelConfigStore } from '../impl/modelConfigStore.js';
import { OPENAI_RESPONSES } from '../transport/modelProtocol.js';
import { snapshotQoderModelRequest } from './qoderModelStreamRequest.js';
import { QoderResponsesTransport } from './qoderResponsesTransport.js';

const MODEL_QUEUED_CODE = '10605';

const classifyQoderResponsesError: ModelInferenceErrorClassifier = (error) => {
  const detail = classifyClientError(error);
  if (error instanceof ClientError && error.responseBody) {
    const parsed = parseApiErrorBody(error.responseBody);
    if (parsed?.subCode === 'MODEL_PAID_CONFIRM_REQUIRED') {
      return {
        ...detail,
        kind: 'quota_exhausted',
        message: error.message,
        code: parsed.code ?? detail.code,
        qoderApiError: buildApiErrorDetails({
          statusCode: error.statusCode,
          body: error.responseBody,
        }),
      };
    }
  }
  const queueCode =
    detail.status === 403 &&
    detail.code === '403' &&
    error instanceof ClientError &&
    error.responseBody
      ? parseApiErrorBody(error.responseBody)?.code
      : detail.code;
  if (queueCode === MODEL_QUEUED_CODE) {
    return { ...detail, kind: 'rate_limited', code: queueCode };
  }
  // The gateway rejects requests over the billing group's Credits limit with
  // a business code, even when the HTTP status indicates forbidden access.
  return detail.code === '122' ? { ...detail, kind: 'quota_exhausted' } : detail;
};

export interface CreateQoderProviderOptions {
  readonly client: QoderClient;
  readonly gatewayBaseUrl: string;
  readonly settingsService: SettingsService;
}

/** Open Qoder provider: existing catalog/selection policy, explicit API attribution. */
export class QoderProvider implements ModelProvider {
  readonly providerId = QODER_PROVIDER_ID;
  private readonly client: QoderClient;
  private readonly resolver: ModelResolver;
  private readonly selector: CustomModelSelector;
  private readonly store: ModelConfigStore;
  private readonly transport = new QoderResponsesTransport();
  private readonly active = new Set<ModelStreamResponse>();

  constructor(options: CreateQoderProviderOptions) {
    this.client = options.client;
    const models: Model[] = [];
    this.resolver = createQoderModelResolver(options.client, models);
    this.store = new ModelConfigStore({
      providerId: this.providerId,
      settingsService: options.settingsService,
      scope: 'user',
    });
    // Reuse the current model-selection policy and preferences; connection and
    // authentication remain owned by the supplied QoderClient.
    this.selector = new CustomModelSelector(
      new CustomProviderConfig({
        providerId: this.providerId,
        baseUrl: options.gatewayBaseUrl,
        protocol: OPENAI_RESPONSES,
        models,
      }),
      this,
    );
  }

  async start(): Promise<void> {
    await this.client.start();
    this.store.start();
    // Warm the catalog in the background so session startup never waits on
    // the gateway; `listModels`/`getModel` join this in-flight fetch.
    void this.resolver.listModels().catch((error: unknown) => {
      runLogger.warn(`[qoder-provider] initial catalog failed: ${error}`);
    });
  }

  async stop(): Promise<void> {
    this.store.stop();
    for (const response of this.active) void response.cancel?.();
    this.active.clear();
    await this.client.stop();
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

  async inference(request: ModelStreamRequest): Promise<ModelStreamResponse> {
    const input = snapshotQoderModelRequest(request);
    const response = createRetryingCustomInference(
      this.transport,
      this.client,
      input,
      classifyQoderResponsesError,
      { canRetry: (failure) => failure.code !== MODEL_QUEUED_CODE },
    );
    this.active.add(response);
    const cleanup = () => this.active.delete(response);
    void response.completed.then(cleanup, cleanup);
    return response;
  }
}
