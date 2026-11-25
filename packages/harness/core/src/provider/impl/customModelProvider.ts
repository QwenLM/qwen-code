/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Model } from '../model/model.js';
import type { ModelConfig } from '../model/model.js';
import type { ModelProvider } from '../modelProvider.js';
import type { ModelSelection } from '../model/modelSelection.js';
import type { ModelSelectContext } from '../model/modelSelectContext.js';
import type { ModelStreamRequest } from '../modelStreamRequest.js';
import type { ModelStreamResponse } from '../modelStreamResponse.js';
import { createRetryingCustomInference } from './customModelInference.js';
import { applyPromptCachePolicy } from './customPromptCache.js';
import {
  classifyClientError,
  ModelInferenceError,
  type ModelInferenceErrorDetail,
} from '../modelInferenceError.js';
import type { SettingsService } from '@qwen-code/resource';
import type { CustomClient } from '../../client/customClient.js';
import { MALFORMED_RESPONSE_CODE } from '../../client/clientError.js';
import { isAbortErrorDeep } from '../../utils/errors.js';
import type { ModelTransport } from '../transport/modelTransport.js';
import type { ModelTransportManager } from '../transport/modelTransportManager.js';
import type { CustomProviderConfig } from './customProviderConfig.js';
import {
  ModelConfigStore,
  type ModelConfigStoreScope,
} from './modelConfigStore.js';
import { CustomModelSelector } from './customModelSelector.js';

const CUSTOM_PROVIDER_PROTOCOL_ERROR_CODE = '200006';
const CUSTOM_PROVIDER_HTTP_ERROR_CODES: Readonly<
  Partial<Record<number, string>>
> = {
  400: '200001',
  403: '200002',
  404: '200003',
  405: '200004',
  502: '200005',
};

export interface CreateCustomModelProviderOptions {
  readonly transportManager: ModelTransportManager;
  readonly config: CustomProviderConfig;
  readonly client: CustomClient;
  /** 偏好读写器由 provider 内部构造；装配点只声明它落哪层 settings。 */
  readonly settingsService: SettingsService;
  readonly scope: ModelConfigStoreScope;
  /** scope === 'project' 时必填：决定读哪个工作区目录下的 settings。 */
  readonly cwd?: string;
}

export class CustomModelProvider implements ModelProvider {
  private readonly modelTransport: ModelTransport;
  private readonly config: CustomProviderConfig;
  /** 网络执行器：连接信息构造期绑定在 client 上（实例即配置）。 */
  private readonly client: CustomClient;
  /** 选模策略：main 直通锚点，其余 purpose 查 routing 表后回落主模型。 */
  private readonly selector: CustomModelSelector;
  /** 偏好读写器：本 provider 全部模型的偏好都落它绑定的 settings scope。 */
  private readonly store: ModelConfigStore;
  private readonly active = new Set<ModelStreamResponse>();

  constructor(options: CreateCustomModelProviderOptions) {
    this.modelTransport = options.transportManager.resolve(
      options.config.protocol,
    );
    this.config = options.config;
    this.client = options.client;
    this.selector = new CustomModelSelector(options.config, this);
    this.store = new ModelConfigStore({
      providerId: this.providerId,
      settingsService: options.settingsService,
      scope: options.scope,
      cwd: options.cwd,
    });
  }

  get providerId(): string {
    return this.config.providerId;
  }

  start(): Promise<void> {
    this.store.start();
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.store.stop();
    for (const response of this.active) void response.cancel?.();
    this.active.clear();
    return Promise.resolve();
  }

  listModels(): Promise<Model[]> {
    return Promise.resolve([...this.config.models]);
  }

  select(context: ModelSelectContext): Promise<ModelSelection> {
    return this.selector.select(context);
  }

  /** 偏好按完整 Model 读写，store 仍按 model.key 管理存储条目。 */
  getModelConfig(model: Model): ModelConfig | undefined {
    return this.store.load(model.key);
  }

  setModelConfig(model: Model, patch: ModelConfig, persist?: boolean): boolean {
    return this.store.save(model.key, patch, persist);
  }

  inference(request: ModelStreamRequest): Promise<ModelStreamResponse> {
    const inference = createRetryingCustomInference(
      this.modelTransport,
      this.client,
      {
        ...request,
        prompt: applyPromptCachePolicy(
          request.prompt,
          this.config.promptCache.get(request.resolution.model.key),
        ),
      },
      (error) => this.classifyError(error),
      { firstPayloadTimeoutMs: this.config.firstPayloadTimeoutMs },
    );
    const response = this.withErrorCodes(inference);
    this.active.add(response);
    const cleanup = () => {
      this.active.delete(response);
    };
    void response.completed.then(cleanup, cleanup);
    return Promise.resolve(response);
  }

  /** 重试结束后仅包装本 Provider 的错误出口，不改变共享重试器或原始错误。 */
  private withErrorCodes(response: ModelStreamResponse): ModelStreamResponse {
    const mappedErrors = new WeakMap<
      ModelInferenceError,
      ModelInferenceError
    >();
    const mapError = (error: unknown): unknown => {
      if (!(error instanceof ModelInferenceError) || isAbortErrorDeep(error)) {
        return error;
      }
      const cached = mappedErrors.get(error);
      if (cached) return cached;
      const providerCode = error.code?.trim() ? error.code : undefined;
      const code =
        error.kind === 'protocol' &&
        (providerCode === undefined || providerCode === MALFORMED_RESPONSE_CODE)
          ? CUSTOM_PROVIDER_PROTOCOL_ERROR_CODE
          : (providerCode ??
            (error.status !== undefined
              ? CUSTOM_PROVIDER_HTTP_ERROR_CODES[error.status]
              : undefined));
      if (code === error.code) return error;
      const mapped = new ModelInferenceError(error.message, {
        ...error,
        code,
        cause: error.cause ?? error,
      });
      mappedErrors.set(error, mapped);
      return mapped;
    };
    return {
      ...response,
      completed: response.completed.catch((error: unknown) => {
        throw mapError(error);
      }),
      events: {
        async *[Symbol.asyncIterator]() {
          try {
            yield* response.events;
          } catch (error) {
            throw mapError(error);
          }
        },
      },
    };
  }

  /** 通用协议映射之外只补密钥脱敏：上游错误体可能回显请求里的 key。 */
  private classifyError(error: unknown): ModelInferenceErrorDetail {
    const detail = classifyClientError(error);
    const apiKey = this.config.apiKey;
    if (!apiKey) return detail;
    const message =
      detail.message ??
      (error instanceof Error ? error.message : String(error));
    return { ...detail, message: message.split(apiKey).join('[REDACTED]') };
  }

  getModel(key: string): Promise<Model | undefined> {
    return Promise.resolve(
      this.config.models.find((model) => model.key === key),
    );
  }
}
