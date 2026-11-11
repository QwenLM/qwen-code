/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SettingsService } from '@qwen-code/resource';

import { runLogger } from '../../utils/runLogger.js';
import { ModelNotFoundError } from '../../utils/httpErrors.js';
import { FatalAuthenticationError } from '../../utils/errors.js';

import type { Model } from '../model/model.js';
import type { ModelConfig } from '../model/model.js';
import type { ModelListOptions } from '../model/modelResolver.js';
import type { ModelProvider } from '../modelProvider.js';
import type {
  ModelSelection,
  ModelSelectResult,
} from '../model/modelSelection.js';
import type {
  ModelSelectContext,
  CompactModelSelectContext,
} from '../model/modelSelectContext.js';
import type { ModelStreamRequest } from '../modelStreamRequest.js';
import type { ModelStreamResponse } from '../modelStreamResponse.js';
import {
  assertModelConfigSupported,
  mergeModelConfig,
  resolveSelectedModelConfig,
} from '../model/modelConfig.js';
import { SessionModelSelector } from './sessionModelSelector.js';
import type {
  ModelSelectionPolicy,
  PrepareModelSelection,
  ReadAgentSelectionDefaults,
} from '../model/modelSelector.js';
import { MainModelAnchor } from './mainModelAnchor.js';
import { CustomModelProvider } from './customModelProvider.js';
import { CustomClientImpl } from '../../client/customClientImpl.js';
import type { ModelTransportManager } from '../transport/modelTransportManager.js';
import { resolveModelName } from '../model/resolveModelName.js';
import {
  createCustomModelProviders,
  loadProjectCustomProviderConfigs,
} from './customModelProviderFactory.js';

export interface CreateModelProviderManagerOptions {
  readAgentSelectionDefaults?: ReadAgentSelectionDefaults;
  /** 沿用会话身份校验，selector 不持有完整 Config。 */
  createSelectionRequestGuard?: (signal?: AbortSignal) => () => void;
  /**
   * 会话级 provider（product 贡献 + user scope settings 解析的 custom）：
   * 装配方以工厂为每个会话新建一组实例，生命周期随本 manager 启停。
   * user 表示配置来源，不表示进程级单例；借用的 framework 资源不随之释放。
   */
  userProviders: readonly ModelProvider[];
  /** 项目级 provider 的传输依赖；实例由 manager 在构造期创建。 */
  modelTransportManager: ModelTransportManager;
  /** 会话 cwd：仅作锚点构造材料透传，供其求解项目级 settings。 */
  projectPath?: string;
  /** 进程级 settings 服务：供锚点与 Custom Provider 的偏好存储使用。 */
  settingsService: SettingsService;
  /** 偏好写入后回调，携带该模型写入前后的完整偏好；会话装配方据此转发变更事件。 */
  onModelConfigChange?: (
    model: Model,
    next: ModelConfig | undefined,
    previous: ModelConfig | undefined,
  ) => void;
}

/**
 * 组合 Provider，把推理任务按 ModelStreamRequest 派发给自管理的子 Provider。
 * 偏好读写按完整 Model 路由，写入前按模型能力校验。
 */
export class ModelProviderManager implements ModelProvider {
  readonly providerId = 'composite';
  private readonly selector: SessionModelSelector;

  /** 会话级 provider：随会话工厂创建，由 manager 启停。 */
  private userProviders: readonly ModelProvider[];
  /** 项目级 provider：随 manager 启停，显式刷新时替换。 */
  private localProviders: readonly ModelProvider[];
  /** 路由视图：外部贡献与内部实例按覆盖规则合并。 */
  private providers: Map<string, ModelProvider>;
  /** 主模型锚点：状态与锚定策略内聚在独立实例，manager 只转发。 */
  private readonly mainModelAnchor: MainModelAnchor;
  /** 幂等门闩：start() 只执行一次生命周期装载。 */
  private started = false;
  /** 启停按调用顺序串行，失败不阻塞下一次操作。 */
  private lifecycle: Promise<void> = Promise.resolve();
  private pendingLifecycle?: {
    operation: 'start' | 'stop' | 'refresh';
    promise: Promise<void>;
  };
  private readonly onModelConfigChange: CreateModelProviderManagerOptions['onModelConfigChange'];
  private modelAccessCheck?: (model: Model, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly options: CreateModelProviderManagerOptions) {
    this.selector = new SessionModelSelector({
      resolver: this,
      selectBase: (input) => this.selectBase(input),
      createRequestGuard: options.createSelectionRequestGuard,
      readAgentSelectionDefaults: options.readAgentSelectionDefaults,
    });
    this.onModelConfigChange = options.onModelConfigChange;
    this.userProviders = options.userProviders;
    this.mainModelAnchor = new MainModelAnchor({
      projectPath: options.projectPath,
      settingsService: options.settingsService,
    });
    this.localProviders = loadProjectCustomProviderConfigs(
      options.settingsService,
      options.projectPath,
    ).map(
      (config) =>
        new CustomModelProvider({
          config,
          transportManager: options.modelTransportManager,
          client: new CustomClientImpl({ customProviderConfig: config }),
          settingsService: options.settingsService,
          scope: 'project',
          cwd: options.projectPath ?? process.cwd(),
        }),
    );
    this.providers = mergeProviders(this.userProviders, this.localProviders);
  }

  /** 包含项目级与会话内新增的 Custom Provider，不依赖启动时的工厂快照。 */
  hasProviders(): boolean {
    return this.providers.size > 0;
  }

  /**
   * 显式应用已保存的有效配置。保留产品 provider 与主模型锚点；新实例就绪后
   * 一次性切换路由，再释放旧实例。与启停串行，避免关闭会话时漏掉新实例。
   */
  replaceCustomProviders(
    userSettings: unknown,
    projectSettings: unknown,
  ): Promise<void> {
    return this.runLifecycle('refresh', async () => {
      const { modelTransportManager, settingsService, projectPath } =
        this.options;
      const nextUser = createCustomModelProviders(
        userSettings,
        modelTransportManager,
        settingsService,
        'user',
        undefined,
      );
      const nextLocal = createCustomModelProviders(
        projectSettings,
        modelTransportManager,
        settingsService,
        'project',
        projectPath ?? process.cwd(),
      );
      const previousUser = this.userProviders.filter(
        (provider) => provider instanceof CustomModelProvider,
      );
      const previous = [...previousUser, ...this.localProviders];
      const attempted: ModelProvider[] = [];
      try {
        if (this.started) {
          for (const provider of [...nextUser, ...nextLocal]) {
            attempted.push(provider);
            await provider.start();
          }
        }
        // 同一来源、同一模型的会话偏好（含尚未持久化的值）随配置更新保留。
        for (const [next, old] of [
          [nextUser, previousUser],
          [nextLocal, this.localProviders],
        ]) {
          for (const provider of next) {
            const previousProvider = old.find(
              (entry) => entry.providerId === provider.providerId,
            );
            if (!previousProvider) continue;
            for (const model of await provider.listModels()) {
              const config = previousProvider.getModelConfig(model);
              if (config) provider.setModelConfig(model, config);
            }
          }
        }
      } catch (error) {
        const failures = await this.stopProviders(attempted);
        if (failures.length) {
          throw new AggregateError(
            [error, ...failures],
            'Custom providers refresh and rollback failed.',
            { cause: error },
          );
        }
        throw error;
      }
      const userProviders = [
        ...this.userProviders.filter(
          (provider) => !(provider instanceof CustomModelProvider),
        ),
        ...nextUser,
      ];
      this.providers = mergeProviders(userProviders, nextLocal);
      this.userProviders = userProviders;
      this.localProviders = nextLocal;
      if (this.started) {
        const failures = await this.stopProviders(previous);
        if (failures.length) {
          throw new AggregateError(
            failures,
            'Custom providers cleanup after refresh failed.',
          );
        }
      }
    });
  }

  /**
   * Registers a provider created after the session started (e.g. a sign-in
   * that happened mid-session). Replaces the previous instance with the same
   * providerId and keeps settings-driven rebuilds from dropping it.
   */
  registerAccountProvider(provider: ModelProvider): Promise<void> {
    return this.runLifecycle('refresh', async () => {
      const previous = this.userProviders.find(
        (entry) => entry.providerId === provider.providerId,
      );
      if (previous === provider) return;
      if (this.started) {
        await provider.start();
      }
      const userProviders = [
        ...this.userProviders.filter(
          (entry) => entry.providerId !== provider.providerId,
        ),
        provider,
      ];
      this.userProviders = userProviders;
      this.providers = mergeProviders(userProviders, this.localProviders);
      if (this.started && previous) {
        await previous.stop().catch((error: unknown) => {
          runLogger.warn(
            `[model-provider] stopping replaced provider ${provider.providerId} failed: ${error}`,
          );
        });
      }
    });
  }

  /**
   * 生命周期装载：启动会话级 provider 与内部项目 provider，再装载默认锚点。
   * 幂等。会话级实例由装配方按会话新建，必须由本 manager 启动，否则它们的
   * start() 装载（如偏好 hydration）永远不会执行。
   */
  start(): Promise<void> {
    return this.runLifecycle('start', async () => {
      if (this.started) return;
      const attempted: ModelProvider[] = [];
      let anchorAttempted = false;
      try {
        for (const provider of [
          ...this.userProviders,
          ...this.localProviders,
        ]) {
          attempted.push(provider);
          await provider.start();
        }
        anchorAttempted = true;
        this.mainModelAnchor.start();
        this.started = true;
      } catch (error) {
        // 失败实例也可能已分配资源；未执行启动的实例不参与回滚。
        if (anchorAttempted) this.mainModelAnchor.stop();
        const failures = await this.stopProviders(attempted);
        if (failures.length) {
          throw new AggregateError(
            [error, ...failures],
            'Model providers startup and rollback failed.',
            { cause: error },
          );
        }
        throw error;
      }
    });
  }

  /**
   * 生命周期卸载：清空锚点并逆序停掉会话级与内部项目 provider。
   */
  stop(): Promise<void> {
    return this.runLifecycle('stop', async () => {
      if (!this.started) return;
      this.started = false;
      this.mainModelAnchor.stop();
      const failures = await this.stopProviders([
        ...this.userProviders,
        ...this.localProviders,
      ]);
      if (failures.length) {
        throw new AggregateError(failures, 'Model providers shutdown failed.');
      }
    });
  }

  /** 相邻的同类启停共享结果；刷新逐次执行，保留每次设置与启停的顺序。 */
  private runLifecycle(
    operation: 'start' | 'stop' | 'refresh',
    action: () => Promise<void>,
  ): Promise<void> {
    if (
      operation !== 'refresh' &&
      this.pendingLifecycle?.operation === operation
    ) {
      return this.pendingLifecycle.promise;
    }
    const promise = this.lifecycle.then(action);
    const pending = { operation, promise };
    this.pendingLifecycle = pending;
    const settle = () => {
      if (this.pendingLifecycle === pending) this.pendingLifecycle = undefined;
    };
    // 对调用方保留原始拒绝，只让内部队列在失败后继续。
    this.lifecycle = promise.then(settle, settle);
    return promise;
  }

  /** 逐个逆序清理；某项失败也继续释放其余实例。 */
  private async stopProviders(
    providers: readonly ModelProvider[],
  ): Promise<unknown[]> {
    const failures: unknown[] = [];
    for (const provider of [...providers].reverse()) {
      try {
        await provider.stop();
      } catch (error) {
        failures.push(error);
      }
    }
    return failures;
  }

  /**
   * 统一选模：owner 恒为主模型锚定的 provider，从不跨 provider。
   * 将会话主模型传给 owner，在自己的候选池内结合偏好按 purpose 选出基础结果 →
   * 叠加调用方 config → 按所选模型能力裁剪。产出的 config 即最终值。
   */
  select(
    input: ModelSelectContext | CompactModelSelectContext,
  ): Promise<ModelSelectResult> {
    return this.selector.select(input);
  }

  setSelectionPreparation(
    preparation: PrepareModelSelection | undefined,
  ): void {
    this.selector.setPreparation(preparation);
  }

  setSelectionPolicy(policy: ModelSelectionPolicy | undefined): void {
    this.selector.setPolicy(policy);
  }

  /** 产品调用层绑定模型准入；Provider 不接收账号或权益依赖。 */
  setModelAccessCheck(
    check: ((model: Model, signal?: AbortSignal) => Promise<void>) | undefined,
  ): void {
    this.modelAccessCheck = check;
  }

  private async selectBase(input: ModelSelectContext): Promise<ModelSelection> {
    const overrideSelection = input.overrideSelection;
    const mainModel = await this.getMainModel();
    const owner = this.getProvider(mainModel.source);
    // 父选择来自其他 provider 说明会话中途切过主模型，按无父处理。
    const parentSelection =
      input.parentSelection?.model.source === mainModel.source
        ? input.parentSelection
        : undefined;
    if (
      overrideSelection &&
      'model' in overrideSelection &&
      overrideSelection.model.source !== mainModel.source
    ) {
      throw new ModelNotFoundError(
        `Model '${overrideSelection.model.key}' is outside the anchored provider '${mainModel.source}'.`,
      );
    }
    // Provider 扩展上下文原样透传；主模型取会话锚点，父选择按归属规范化。
    const context: ModelSelectContext = {
      ...input,
      mainModel,
      overrideSelection,
      parentSelection,
    };
    const selected = await owner.select(context);
    if (selected.model.source !== mainModel.source) {
      throw new ModelNotFoundError(
        `Model '${selected.model.key}' is outside the anchored provider '${mainModel.source}'.`,
      );
    }
    if (selected.model.enabled === false) {
      throw new ModelNotFoundError(
        `Model '${selected.model.key}' is disabled.`,
        403,
      );
    }
    await this.modelAccessCheck?.(selected.model, input.signal);
    return {
      model: selected.model,
      config: resolveSelectedModelConfig(
        selected.model,
        mergeModelConfig(selected.config, input.overrideSelection?.config),
      ),
    };
  }

  /** 按 Model.source 精确读取所属 provider 的偏好，不依赖主模型锚点。 */
  getModelConfig(model: Model): ModelConfig | undefined {
    return this.getProvider(model.source).getModelConfig(model);
  }

  /**
   * 合并写入偏好：按 Model 能力校验后路由到 owner，不支持的 effort /
   * contextWindow 直接抛错；persist 整体委托给 owner，manager 不感知存储实现。
   * 返回 false 只表示落盘失败，内存态已更新并已通知。
   */
  setModelConfig(model: Model, patch: ModelConfig, persist?: boolean): boolean {
    assertModelConfigSupported(model, patch);
    const provider = this.getProvider(model.source);
    const previous = provider.getModelConfig(model);
    const saved = provider.setModelConfig(model, patch, persist);
    const current = provider.getModelConfig(model);
    this.onModelConfigChange?.(model, current, previous);
    return saved;
  }

  /** 聚合目录并应用调用层准入；缓存和刷新由 Provider 管理。 */
  async listModels(options?: ModelListOptions): Promise<Model[]> {
    const models = await this.listAllModels(options);
    const check = this.modelAccessCheck;
    if (!check) return models;
    const visible = await Promise.all(models.map(async (model) => {
      try {
        await check(model);
        return [model];
      } catch {
        return [];
      }
    }));
    return visible.flat();
  }

  private async listAllModels(options?: ModelListOptions): Promise<Model[]> {
    const lists = await Promise.all(
      [...this.providers.values()].map((provider) =>
        provider.listModels(options),
      ),
    );
    return lists.flat();
  }

  /** 按 key 委派各 provider 查询，不依赖主模型锚点。 */
  async getModel(key: string): Promise<Model | undefined> {
    let authenticationError: FatalAuthenticationError | undefined;
    for (const provider of this.providers.values()) {
      let model: Model | undefined;
      try {
        model = await provider.getModel(key);
      } catch (error) {
        if (!(error instanceof FatalAuthenticationError)) throw error;
        authenticationError ??= error;
      }
      if (model !== undefined) {
        await this.modelAccessCheck?.(model);
        return model;
      }
    }
    const models = await this.listAllModels();
    const model = models.find(
      (model) => model.key.toLowerCase() === key.toLowerCase(),
    );
    if (this.modelAccessCheck) {
      // 启动展示名解析由 Config 保持原语义；先保留候选模型的准入错误，避免回退。
      const match = resolveModelName(models, key.trim());
      for (const candidate of match.model ? [match.model] : match.ambiguous ?? [])
        await this.modelAccessCheck(candidate);
    }
    if (!model && authenticationError) throw authenticationError;
    return model;
  }

  async inference(request: ModelStreamRequest): Promise<ModelStreamResponse> {
    await this.modelAccessCheck?.(request.resolution.model, request.control?.signal);
    return this.getProvider(request.resolution.model.source).inference(request);
  }

  /**
   * 锚定 mainModel：从 Model 取权威二元组（source + key）连同 persist
   * 意图透传给锚点实例；persist 的内存更新/落盘裁决内聚在锚点里。
   */
  setMainModel(model: Model, persist?: boolean): boolean {
    return this.mainModelAnchor.switchTo(
      { providerId: model.source, modelKey: model.key },
      persist,
    );
  }

  /**
   * 按 key 锚定 mainModel：用于目录里查不到对应 Model（待后端校验的透传
   * key）但仍须记住选择的场景；归属由锚点从 key 还原。过渡写面，与
   * getMainModelKey() 对称，待收敛到 setMainModel()。
   */
  setMainModelKey(modelKey: string, persist?: boolean): boolean {
    return this.mainModelAnchor.switchToKey(modelKey, persist);
  }

  /**
   * 读主模型 key：同步读锚点，不查目录。未锚定（start 前或 stop 后）返
   * 空串。过渡读面——调用方只需 key 时免去兑换，待收敛到 getMainModel()。
   */
  getMainModelKey(): string {
    return this.mainModelAnchor.current()?.modelKey ?? '';
  }

  /**
   * 读主模型完整对象：锚点定位 owner 后现查兑换；未锚定或 key 已下架/
   * 目录未就绪时抛错。
   */
  async getMainModel(): Promise<Model> {
    const current = this.mainModelAnchor.current();
    if (current === undefined) {
      throw new Error('MainModelAnchor has no main model anchored.');
    }
    const { providerId, modelKey } = current;
    const settingsHint = this.describeMainModelSettings();
    const provider = this.providers.get(providerId);
    if (provider === undefined) {
      throw new ModelNotFoundError(
        `Main model "${modelKey}" belongs to provider "${providerId}", which is not available in this session.${settingsHint} Run /auth to sign in again, or /model to choose another model.`,
        404,
      );
    }
    const model = await provider.getModel(modelKey);
    if (model === undefined) {
      throw new ModelNotFoundError(
        `Main model "${modelKey}" of provider "${providerId}" not found in its catalog.${settingsHint} Run /auth to sign in again, or /model to choose another model.`,
        404,
      );
    }
    await this.modelAccessCheck?.(model);
    return model;
  }

  /** Name the persisted settings behind a dangling main-model reference. */
  private describeMainModelSettings(): string {
    if (this.options.settingsService === undefined || this.options.projectPath === undefined) {
      return '';
    }
    try {
      const merged = this.options.settingsService.resolve({
        projectPath: this.options.projectPath,
      }).merged as {
        model?: { name?: string };
        security?: { auth?: { selectedType?: string } };
      };
      const parts: string[] = [];
      const selectedType = merged.security?.auth?.selectedType;
      if (selectedType !== undefined) {
        parts.push(`security.auth.selectedType="${selectedType}"`);
      }
      const modelName = merged.model?.name;
      if (modelName !== undefined) {
        parts.push(`model.name="${modelName}"`);
      }
      return parts.length > 0 ? ` Current settings: ${parts.join(', ')}.` : '';
    } catch {
      return '';
    }
  }

  /** 归属查表：Model.source 直接承载 owner providerId，O(1) 命中，miss 抛错。 */
  private getProvider(source: string): ModelProvider {
    const provider = this.providers.get(source);
    if (!provider) {
      throw new Error(
        `ModelProviderManager has no provider "${source}" in its child set.`,
      );
    }
    return provider;
  }
}

/** 合并顺序即覆盖方向：项目级 custom 覆盖同名的工厂 provider，但不能覆盖产品 provider。 */
function mergeProviders(
  userProviders: readonly ModelProvider[],
  localProviders: readonly ModelProvider[],
): Map<string, ModelProvider> {
  const providers = new Map<string, ModelProvider>();
  for (const provider of [...userProviders, ...localProviders]) {
    const existing = providers.get(provider.providerId);
    if (
      existing &&
      !(existing instanceof CustomModelProvider) &&
      provider instanceof CustomModelProvider
    ) {
      runLogger.warn(
        `[model-provider-manager] custom provider cannot override product provider "${provider.providerId}".`,
      );
      continue;
    }
    if (existing) {
      runLogger.warn(
        `[model-provider-manager] provider "${provider.providerId}" overrides an earlier provider of the same id.`,
      );
    }
    providers.set(provider.providerId, provider);
  }
  return providers;
}
