/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { HookMarketplaceMetadata } from '@qwen-code/resource';
import type { Config } from '../config/config.js';
import { captureExtensionExecution } from '../extensions/extension-feature-builder.js';
import { getBusinessInfoFromContext } from '../utils/sessionIdContext.js';
import { runLogger } from '../utils/runLogger.js';

/** 每次 inline 命令展开单独记一次执行，后续模型推理不计入这次耗时。 */
export class PluginCommandLifecycle {
  private readonly id = `plugin-command-${randomUUID()}`;
  private readonly startedAt = performance.now();
  private readonly businessId = getBusinessInfoFromContext()?.id;
  private readonly plugin: Readonly<HookMarketplaceMetadata>;
  private finished = false;

  constructor(
    private readonly config: Config,
    private readonly commandName: string,
    plugin: HookMarketplaceMetadata,
    private readonly fallbackPluginName?: string,
  ) {
    // 固定本次调用的插件归属，避免热重载改变已经开始的执行记录。
    this.plugin = Object.freeze({ ...plugin });
  }

  succeed(content: string): Promise<void> {
    return this.finish(
      content,
      undefined
    );
  }

  fail(error: unknown): Promise<void> {
    return this.finish(
      undefined,
      error
    );
  }

  private async finish(
    content: string | undefined,
    error: unknown,
  ): Promise<void> {
    if (this.finished) return;

    this.finished = true;

    // 在触发 Hook 前停止计时；同步展开不足 1 毫秒时，整数耗时为 0。
    const durationMs = Math.trunc(
      Math.max(
        0,
        performance.now() - this.startedAt
      ),
    );
    const eventTs = new Date().toISOString();

    try {
      const name =
        this.plugin.displayName?.trim() ||
        this.plugin.marketItemId?.trim() ||
        this.fallbackPluginName?.trim() ||
        'unknown';
      const failed = content === undefined;
      const explicitErrorType =
        error &&
          typeof error === 'object' &&
          'errorType' in error &&
          typeof error.errorType === 'string'
          ? error.errorType
          : '';

      // 固定字段与 features 在采集时就拆开，不向 Hook 透传原始插件元数据。
      const snapshot = await captureExtensionExecution(
        this.config,
        'plugin',
        {
          pluginName: name,
          pluginMarketplace: this.plugin,
          toolCallId: this.id,
          toolName: 'PluginCommand',
          toolOrigin: 'plugin',
          toolKind: 'other',
          durationMs,
          status: failed ? 'error' : 'success',
          errorType: explicitErrorType,
        },
        content === undefined
          ? undefined
          : { llmContent: content, returnDisplay: '' },
        error,
        eventTs,
      );

      const attribution = {
        ...snapshot,
        businessId: this.businessId,
      };
      const input = { command: this.commandName };
      const hooks = this.config.getHookSystem?.();

      // 复用原有 Post Hook 分发；匹配 PluginCommand 的用户 Hook 也会收到事件。
      if (failed) {
        await hooks?.firePostToolUseFailureEvent(
          'PluginCommand',
          input,
          error instanceof Error ? error.message : String(error),
          this.id,
          explicitErrorType || undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          attribution,
        );
      } else {
        await hooks?.firePostToolUseEvent(
          'PluginCommand',
          input,
          content,
          this.id,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          attribution,
        );
      }
    } catch (captureError) {
      // 埋点异常不能覆盖命令展开的结果或原始异常。
      runLogger.debug(
        '[metrics] plugin command observation omitted',
        captureError,
      );
    }
  }
}
