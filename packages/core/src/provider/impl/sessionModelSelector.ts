/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ModelSelectContext,
  CompactModelSelectContext,
} from '../model/modelSelectContext.js';
import type {
  ModelSelection,
  ModelSelectResult,
} from '../model/modelSelection.js';
import type {
  ModelSelectionPolicy,
  PrepareModelSelection,
  ReadAgentSelectionDefaults,
} from '../model/modelSelector.js';
import type { ModelResolver } from '../model/modelResolver.js';
import type { ModelConfigurator } from '../model/modelConfigurator.js';
import { effortToThinkingBudget } from '../../utils/frontmatterParsers.js';
import { mergeModelConfig } from '../model/modelConfig.js';
import { resolveModelSelectionOverride } from '../session-model.js';
import { ModelNotFoundError } from '../../utils/httpErrors.js';
import { raceWithAbortSignal } from '../../utils/abort-race.js';
import { isFatalRoutingError } from '../../routing/errors.js';
import { isCancellationError, getErrorMessage } from '../../utils/errors.js';
import { runLogger } from '../../utils/runLogger.js';
import { redactTextForDebug } from '../../qoder/log-redaction.js';

/** 会话选模协调；具体模型规则仍由所属 Provider 的 selector 执行。 */
export class SessionModelSelector {
  constructor(
    private readonly options: {
      resolver: Pick<ModelResolver, 'getModel'> &
        Pick<ModelConfigurator, 'getModelConfig'>;
      selectBase: (input: ModelSelectContext) => Promise<ModelSelection>;
      createRequestGuard?: (signal?: AbortSignal) => () => void;
      readAgentSelectionDefaults?: ReadAgentSelectionDefaults;
    },
  ) {}

  private policy?: ModelSelectionPolicy;
  private preparation?: PrepareModelSelection;

  setPolicy(policy: ModelSelectionPolicy | undefined): void {
    this.policy = policy;
  }

  setPreparation(preparation: PrepareModelSelection | undefined): void {
    this.preparation = preparation;
  }

  async select(
    input: ModelSelectContext | CompactModelSelectContext,
  ): Promise<ModelSelectResult> {
    const { signal, adjustment } = input;
    signal?.throwIfAborted();
    const reused = adjustment
      ? undefined
      : input.purpose === 'compact'
        ? (input as CompactModelSelectContext).compactSelection
        : input.purpose === 'fork' || input.purpose === 'side_question'
          ? input.parentSelection
          : undefined;
    if (reused)
      return {
        model: reused.model,
        config: reused.config,
        reusedSelection: true,
      };

    // fork 首次选模及纯配置调整不咨询宿主；Skill 换模型仍执行原策略。
    const requestSelection =
      input.request &&
      (adjustment
        ? adjustment.kind === 'skill-model'
        : input.purpose !== 'fork');
    const policy = requestSelection ? this.policy : undefined;
    // 普通 purpose-only 调用仍走基础选模；原请求级压缩才有准备和本地降级。
    const compact =
      input.purpose === 'compact' && input.request && !adjustment
        ? (input as CompactModelSelectContext)
        : undefined;
    const assertCurrent = requestSelection
      ? (this.options.createRequestGuard?.(signal) ??
        (() => signal?.throwIfAborted()))
      : () => signal?.throwIfAborted();
    const wait = async <T>(pending: Promise<T>): Promise<T> => {
      const result = await raceWithAbortSignal(pending, signal);
      assertCurrent();
      return result;
    };
    assertCurrent();
    // 请求事实和准备阶段仅属于会话 selector，不交给子 Provider 重复执行。
    const {
      request: _request,
      modelResolution: _modelResolution,
      adjustment: _adjustment,
      parentOverride: _parentOverride,
      prepareParent: _prepareParent,
      compactSelection: _compactSelection,
      ...baseContext
    } = this.selectionInput(this.agentSelectionInput(input)) as ModelSelectContext &
      Pick<
        CompactModelSelectContext,
        'parentOverride' | 'prepareParent' | 'compactSelection'
      >;
    const providerInput: ModelSelectContext = {
      ...baseContext,
      purpose:
        input.purpose === 'side_question'
          ? 'main'
          : input.purpose === 'fork'
            ? adjustment && input.request?.agentId
              ? 'task'
              : 'main'
            : input.purpose,
    };
    let parent = providerInput.parentSelection;
    let baseInput: ModelSelectContext = providerInput;
    // SDK 换模型时只延续显式配置，不把父模型展开的默认值带到新模型。
    const requestConfig = mergeModelConfig(
      providerInput.overrideSelection?.config,
      compact?.parentOverride?.config,
    );
    const selectBase = async (parentOnly = false) => {
      if (compact?.parentOverride) {
        const override = await wait(
          resolveModelSelectionOverride(
            this.options.resolver,
            compact.parentOverride.key,
            requestConfig,
          ),
        );
        parent ??= await this.selectPrepared(
          {
            ...providerInput,
            purpose: 'main',
            parentSelection: undefined,
            overrideSelection: override,
          },
          wait,
        );
      }
      // 会话偏好只参与基础选择，不作为 SDK 换模型后的显式覆盖。
      if (compact && !parent && !compact.parentOverride) {
        parent = await this.selectPrepared(
          {
            ...providerInput,
            purpose: 'main',
            parentSelection: undefined,
            overrideSelection: undefined,
          },
          wait,
        );
      }
      if (compact) {
        baseInput = {
          ...providerInput,
          parentSelection: parent,
          overrideSelection:
            compact.parentOverride && input.overrideSelection && parent
              ? {
                  model: parent.model,
                  config: input.overrideSelection.config ?? {},
                }
              : input.overrideSelection,
        };
        if (parentOnly && parent) return parent;
      }
      return this.selectPrepared(baseInput, wait);
    };

    try {
      let selection: ModelSelection | undefined;
      let baseError: unknown;
      try {
        selection = await selectBase(compact?.prepareParent);
        if (compact?.prepareParent) {
          return {
            model: selection.model,
            config: selection.config,
            preparedParentOnly: true,
          };
        }
      } catch (error) {
        assertCurrent();
        if (!policy || !isRecoverableModelMiss(error)) throw error;
        baseError = error;
      }
      const patch = policy ? await wait(policy(input, selection)) : undefined;
      const overridden =
        patch?.key !== undefined || patch?.config !== undefined;
      if (overridden) {
        if (!selection && patch.key === undefined)
          selection = await selectBase();
        const config = mergeModelConfig(requestConfig, patch.config);
        const overrideSelection =
          patch.key !== undefined
            ? { key: patch.key, config }
            : { model: selection!.model, config };
        selection = await this.selectPrepared(
          {
            ...baseInput,
            parentSelection: selection ?? baseInput.parentSelection,
            overrideSelection,
          },
          wait,
        );
      } else if (!selection && baseError) {
        // 空响应也可能已补齐目录；重试原始意图，prepareParent 的恢复需完成 compact。
        selection = await selectBase();
      }
      assertCurrent();
      if (!selection) throw baseError ?? new Error('Model selection failed.');
      return {
        model: selection.model,
        config: selection.config,
        ...(policy ? { policy: { labels: patch?.labels, overridden } } : {}),
      };
    } catch (error) {
      assertCurrent();
      if (
        !compact ||
        !parent ||
        policy ||
        isFatalRoutingError(error) ||
        isCancellationError(error, signal)
      )
        throw error;
      runLogger.warn(
        `[CompactModel] Selection failed, falling back to current model: ${redactTextForDebug(getErrorMessage(error))}`,
      );
      return {
        model: parent.model,
        config: parent.config,
        fallbackToParent: true,
      };
    }
  }

  private agentSelectionInput(input: ModelSelectContext): ModelSelectContext {
    if (
      (input.purpose !== 'task' && input.purpose !== 'fork') ||
      !input.request ||
      (input.adjustment &&
        (input.purpose === 'fork' || input.adjustment.kind !== 'skill-model'))
    )
      return input;
    const defaults = this.options.readAgentSelectionDefaults?.(
      input.request,
      input.purpose,
    );
    if (!defaults) return input;

    const parent = input.parentSelection;
    const override = input.overrideSelection;
    if (input.purpose === 'fork') {
      return {
        ...input,
        overrideSelection:
          override && ('model' in override || override.key !== undefined)
            ? override
            : { ...override, key: defaults.key },
      };
    }
    const config = mergeModelConfig(
      {
        reasoning: {
          effort:
            parent?.config.reasoning?.effort ??
            (parent
              ? this.options.resolver.getModelConfig(parent.model)?.reasoning
                  ?.effort
              : undefined),
        },
      },
      defaults.config,
      override?.config,
    );
    // 同模型沿用父对象及 owner；独立模型也保留原入口的父 effort 兜底。
    return {
      ...input,
      overrideSelection:
        override && 'model' in override
          ? { model: override.model, config }
          : {
              key:
                override?.key ??
                (defaults.key === parent?.model.key ? undefined : defaults.key),
              config,
            },
    };
  }

  private selectionInput(input: ModelSelectContext): ModelSelectContext {
    const adjustment = input.adjustment;
    const override = input.overrideSelection;
    // 跟随父模型的 Agent 可另外指定生成配置；SDK / Skill 换模型仍保留其 effort 要求。
    const inheritedConfig =
      input.purpose === 'task' &&
      input.request &&
      (!adjustment || adjustment.kind === 'skill-model') &&
      (!override ||
        (!('model' in override) &&
          override.key === undefined &&
          !override.config?.reasoning?.thinking)) &&
      input.parentSelection
        ? mergeModelConfig(
            {
              reasoning: {
                effort:
                  override?.config?.reasoning?.effort ??
                  input.parentSelection.config.reasoning?.effort ??
                  this.options.resolver.getModelConfig(
                    input.parentSelection.model,
                  )?.reasoning?.effort,
              },
            },
            override?.config,
          )
        : undefined;
    if (adjustment?.kind === 'skill-model') {
      return {
        ...input,
        parentSelection: undefined,
        overrideSelection: {
          key: adjustment.key,
          config: inheritedConfig ?? override?.config,
        },
      };
    }
    if (adjustment) {
      const current = input.modelResolution!;
      const budget =
        adjustment.kind === 'skill-effort'
          ? effortToThinkingBudget(adjustment.effort)!
          : undefined;
      return {
        ...input,
        parentSelection: current,
        overrideSelection: {
          model: current.model,
          config:
            adjustment.kind === 'output-limit'
              ? { context: { maxOutputTokens: adjustment.maxOutputTokens } }
              : {
                  reasoning: {
                    effort: adjustment.effort,
                    thinking:
                      budget === 0
                        ? { type: 'disabled' }
                        : { type: 'enabled', budgetTokens: budget! },
                  },
                },
        },
      };
    }
    if (inheritedConfig) {
      return {
        ...input,
        overrideSelection: {
          model: input.parentSelection!.model,
          config: inheritedConfig,
        },
      };
    }
    // 普通子 Agent 已带父模型对象，保留其 owner，避免同 key 重新查到其他 Provider。
    if (
      input.purpose === 'task' &&
      input.request &&
      override &&
      !('model' in override) &&
      input.parentSelection &&
      override.key === input.parentSelection.model.key
    ) {
      return {
        ...input,
        overrideSelection: {
          model: input.parentSelection.model,
          config: override.config ?? {},
        },
      };
    }
    return input;
  }

  private async selectPrepared(
    input: ModelSelectContext,
    wait: <T>(pending: Promise<T>) => Promise<T>,
  ): Promise<ModelSelection> {
    const prepared = this.preparation
      ? await wait(this.preparation(input))
      : input;
    const override = prepared.overrideSelection;
    const overrideSelection =
      override && !('model' in override) && override.key !== undefined
        ? await wait(
            resolveModelSelectionOverride(
              this.options.resolver,
              override.key,
              override.config,
            ),
          )
        : override;
    return wait(this.options.selectBase({ ...prepared, overrideSelection }));
  }
}

function isRecoverableModelMiss(error: unknown): boolean {
  const cause = isFatalRoutingError(error) ? error.cause : error;
  return cause instanceof ModelNotFoundError && cause.code === 404;
}
