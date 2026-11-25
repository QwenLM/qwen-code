/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { Config } from '../config/config.js';
import type { AggregatedHookResult } from '../hooks/hookAggregator.js';
import {
  PreToolUseHookOutput,
  type SkillActivationSource,
  type SkillHookContext,
} from '../hooks/types.js';
import { buildSkillHookContext } from './skillHookContext.js';
import { runLogger } from '../utils/runLogger.js';
import { getBusinessInfoFromContext } from '../utils/sessionIdContext.js';
import {
  captureExtensionExecution,
  captureSkillFeatureFacts,
} from '../extensions/extension-feature-builder.js';
import type { ExtensionExecutionRawRecord } from '../extensions/extension-features.js';
import type { HookRequestAttribution } from '../hooks/types.js';

/** 为不经过工具调度器的 Skill 激活补齐 Hook 和度量记录。 */
export class SkillCallLifecycle {
  readonly id = `skill-${randomUUID()}`;
  input: Record<string, unknown>;
  stage: NonNullable<SkillHookContext['failure_stage']> = 'validation';
  activated = false;
  private finished = false;
  private metadata: SkillHookContext;
  private readonly businessId?: string;
  private readonly extensionExecutionRawRecord: Partial<ExtensionExecutionRawRecord> =
    {};

  constructor(
    private readonly config: Config,
    input: Record<string, unknown>,
    source: SkillActivationSource,
    readonly options: {
      signal?: AbortSignal;
      fork?: boolean;
      businessId?: string;
    } = {},
  ) {
    this.input = { ...input };
    // 在激活入口固定所属会话轮次，异步完成时不再读取可能变化的上下文。
    this.businessId = options.businessId ?? getBusinessInfoFromContext()?.id;
    this.metadata = buildSkillHookContext(
      config,
      input,
      source
    );
    this.captureSelectionFeatures();
  }

  async pre(): Promise<string | undefined> {
    const result = await this.config
      .getHookSystem?.()
      ?.firePreToolUseEvent(
        'Skill',
        this.input,
        this.id,
        undefined,
        undefined,
        this.options.signal,
        undefined,
        this.metadata,
      );
    const output = result?.finalOutput;
    if (
      output?.shouldStopExecution() ||
      output?.getBlockingError()?.blocked ||
      output?.decision === 'ask'
    ) {
      this.finished = true;
      throw new Error(
        output.getEffectiveReason() || 'Skill call blocked by PreToolUse hook.',
      );
    }
    if (output instanceof PreToolUseHookOutput) {
      const updated = output.getModifiedToolInput();
      if (updated) this.input = { ...this.input, ...updated };
    }
    const skillName = this.input['skill'];
    const skillArgs = this.input['args'];
    if (
      typeof skillName !== 'string' ||
      !skillName.trim() ||
      (skillArgs !== undefined && typeof skillArgs !== 'string')
    ) {
      throw new Error('Invalid Skill input after PreToolUse hook.');
    }

    // Pre Hook 可以改写 Skill；归属和采集快照以改写后的实际定义为准。
    this.metadata = buildSkillHookContext(
      this.config,
      this.input,
      this.metadata.activation_source,
      this.metadata.requested_skill_name,
    );
    this.captureSelectionFeatures();
    return output?.getAdditionalContext();
  }

  markInjected(): void {
    this.activated = true;
    this.stage = 'execution';
  }

  get context(): SkillHookContext {
    return {
      ...this.metadata,
      skill_activated: this.activated,
      failure_stage: this.stage,
    };
  }

  private async attribution(
    response?: unknown,
    error?: unknown,
  ): Promise<HookRequestAttribution> {
    const attribution: HookRequestAttribution = { businessId: this.businessId };

    try {
      const eventTs = new Date().toISOString();
      Object.assign(
        this.extensionExecutionRawRecord,
        {
          toolCallId: this.id,
          toolName: 'Skill',
          toolOrigin: 'builtin',
        }
      );
      // 直接激活没有调度器计时；只有真实字符串输出才计长度，不测量状态对象的 JSON。
      const result =
        typeof response === 'string'
          ? { llmContent: response, returnDisplay: '' }
          : undefined;
      const extension = await captureExtensionExecution(
        this.config,
        'skill',
        this.extensionExecutionRawRecord,
        result,
        error,
        eventTs,
      );

      return { ...attribution, ...extension };
    } catch (captureError) {
      runLogger.debug(
        '[telemetry] synthetic Skill features omitted',
        captureError,
      );

      return attribution;
    }
  }

  private captureSelectionFeatures(): void {
    try {
      Object.assign(
        this.extensionExecutionRawRecord,
        captureSkillFeatureFacts(
          this.config
            .getSkillManager?.()
            ?.getSkill(String(this.input['skill'] ?? '')),
          this.metadata.activation_source,
        ),
      );
    } catch (captureError) {
      runLogger.debug(
        '[telemetry] synthetic Skill selection facts omitted',
        captureError,
      );
    }
  }

  async succeed(response: unknown): Promise<AggregatedHookResult | undefined> {
    if (this.finished) return;
    if (this.options.fork && this.options.signal?.aborted)
      return this.fail(new Error('Fork skill cancelled'));
    this.finished = true;
    return this.config
      .getHookSystem?.()
      ?.firePostToolUseEvent(
        'Skill',
        this.input,
        response,
        this.id,
        undefined,
        undefined,
        this.options.signal,
        undefined,
        undefined,
        { ...this.metadata, skill_activated: this.activated },
        undefined,
        await this.attribution(response),
      );
  }

  async fail(error: unknown): Promise<AggregatedHookResult | undefined> {
    if (this.finished) return;
    this.finished = true;
    const interrupted =
      this.options.fork &&
      (this.options.signal?.aborted ||
        (error instanceof Error && error.name === 'AbortError'));
    if (interrupted)
      Object.assign(
        this.extensionExecutionRawRecord,
        { status: 'cancelled' }
      );
    try {
      return await this.config
        .getHookSystem?.()
        ?.firePostToolUseFailureEvent(
          'Skill',
          this.input,
          error instanceof Error ? error.message : String(error),
          this.id,
          undefined,
          undefined,
          undefined,
          interrupted ? AbortSignal.timeout(30_000) : this.options.signal,
          undefined,
          this.context,
          this.options.fork ? interrupted === true : undefined,
          undefined,
          await this.attribution(
            undefined,
            error
          ),
        );
    } catch (hookError) {
      runLogger.debug(
        'Skill failure hook error:',
        hookError
      );
      return undefined;
    }
  }
}
