/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 把 `initialize` 声明的 SDK hook 注册为运行时 hook，回调经 `runHookCallback`
 * 反向请求到宿主执行。
 *
 * 只报「跑哪个 hook（具名参数）+ 带什么数据」，不构造帧：subtype、`callback_id`
 * 与 request_id 关联归宿主。这是反向 RPC，与出站 hook 生命周期帧（hook_started /
 * hook_progress / hook_response）是两条通道，不受 `allHookEventsEnabled` 闸门影响。
 *
 * 取消：`options.signal` 原样透传，缺省时由宿主回落到会话级信号。
 */

import {
  ConfigSource,
  HookEventName,
  HookType,
  runLogger,
  validateHookOutput,
  type Config,
  type HookInput,
  type HookOutput,
} from '@qwen-code/core';
import type { ThreadHostRequests } from '../contract/hostContext.js';
import type { ThreadSessionDeclarations } from '../contract/threadSessionTypes.js';

interface HostHookRegistration {
  eventName: HookEventName;
  matcher?: string;
  timeout?: number;
  callbackIds: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toHookEventName(eventName: string): HookEventName | undefined {
  return Object.values(HookEventName).includes(eventName as HookEventName)
    ? (eventName as HookEventName)
    : undefined;
}

/** PreToolUse / PostToolUse 这类带工具调用的事件才有 tool_use_id，透传给 SDK 做关联。 */
function getHookToolUseId(input: HookInput): string | undefined {
  const record = input as unknown as Record<string, unknown>;
  const toolUseId = record['tool_use_id'];
  return typeof toolUseId === 'string' && toolUseId.length > 0
    ? toolUseId
    : undefined;
}

function normalizeHostHookOutput(
  response: unknown,
  sessionId: string,
): HookOutput | undefined {
  if (!isRecord(response)) {
    return undefined;
  }
  const validation = validateHookOutput(response);
  if (!validation.success) {
    runLogger.warn(
      `[thread-session] Ignoring invalid SDK hook output (session ${sessionId}): ${validation.error}`,
    );
    return undefined;
  }
  return validation.output;
}

function extractHostHookRegistrations(
  declarations: ThreadSessionDeclarations,
): HostHookRegistration[] {
  const rawHooks = declarations.hooks;
  if (!isRecord(rawHooks)) return [];

  const registrations: HostHookRegistration[] = [];
  for (const [rawEventName, rawDefinitions] of Object.entries(rawHooks)) {
    const eventName = toHookEventName(rawEventName);
    if (!eventName || !Array.isArray(rawDefinitions)) {
      continue;
    }

    for (const rawDefinition of rawDefinitions) {
      if (!isRecord(rawDefinition)) {
        continue;
      }

      const rawCallbackIds = rawDefinition['hookCallbackIds'];
      if (!Array.isArray(rawCallbackIds)) {
        continue;
      }

      const callbackIds = rawCallbackIds.filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      );
      if (callbackIds.length === 0) {
        continue;
      }

      const rawMatcher = rawDefinition['matcher'];
      const rawTimeout = rawDefinition['timeout'];
      registrations.push({
        eventName,
        callbackIds,
        ...(typeof rawMatcher === 'string' ? { matcher: rawMatcher } : {}),
        ...(typeof rawTimeout === 'number' &&
        Number.isFinite(rawTimeout) &&
        rawTimeout >= 0
          ? { timeout: rawTimeout }
          : {}),
      });
    }
  }

  return registrations;
}

export interface RegisterHostHooksParams {
  readonly config: Config;
  readonly sessionId: string;
  /** `initialize` 的中立声明袋；只读 `hooks` 一个字段。 */
  readonly declarations: ThreadSessionDeclarations;
  /** 宿主反向请求通道；由会话提供，新会话直接转发 host.requests.runHookCallback。 */
  readonly runHookCallback: ThreadHostRequests['runHookCallback'];
}

/**
 * 把 SDK 在 `initialize` 里声明的 hook 注册进本会话的 hook 系统。必须在构造回包
 * 之前调用，本轮 SessionStart 之后的事件才能命中；没有 `hooks` 字段时为空操作。
 */
export function registerHostHooks(params: RegisterHostHooksParams): void {
  const { config, sessionId, declarations, runHookCallback } = params;
  const registrations = extractHostHookRegistrations(declarations);
  if (registrations.length === 0) return;

  const hookSystem = config.getHookSystem?.();
  if (!hookSystem) {
    runLogger.warn(
      '[thread-session] SDK hooks received but hookSystem is unavailable — skipping registration.',
      { sessionId },
    );
    return;
  }

  for (const registration of registrations) {
    for (const callbackId of registration.callbackIds) {
      hookSystem.registerHook(
        {
          type: HookType.Runtime,
          // 名字里带 callbackId：同一个事件挂多个 SDK hook 时不能互相覆盖。
          name: `sdk:${registration.eventName}:${callbackId}`,
          timeout: registration.timeout,
          source: ConfigSource.Runtime,
          statusMessage: `SDK ${registration.eventName} hook`,
          action: async (input, options) => {
            const toolUseId = getHookToolUseId(input);
            // hook 负载（input）刻意不打：里面是工具参数正文。
            runLogger.log('[thread-session] SDK hook callback firing', {
              sessionId,
              eventName: registration.eventName,
              callbackId,
              ...(toolUseId ? { toolUseId } : {}),
            });
            // hook 的身份（callbackId）走具名参数，负载只带数据；subtype 与
            // callback_id 字段名由宿主补。
            const response = await runHookCallback(
              callbackId,
              {
                input,
                ...(toolUseId ? { tool_use_id: toolUseId } : {}),
              },
              { signal: options?.signal },
            );
            return normalizeHostHookOutput(response, sessionId);
          },
        },
        registration.eventName,
        {
          matcher: registration.matcher,
          source: ConfigSource.Runtime,
        },
      );
    }
  }

  const registeredCount = registrations.reduce(
    (n, r) => n + r.callbackIds.length,
    0,
  );
  runLogger.log(
    `[thread-session] Registered ${registeredCount} SDK hook callback(s).`,
    { sessionId },
  );

  // 文件监听器初始化早于 SDK hook 注册，那时还没有 FileChanged matcher，可能没启动；
  // 注册完补一次刷新。
  hookSystem.refreshFileWatcher?.();
}
