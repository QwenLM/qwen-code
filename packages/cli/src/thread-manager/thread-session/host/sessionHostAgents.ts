/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 注册 `initialize` 声明的 SDK agent，落在本会话 Config 的 AgentRegistry 上。
 *
 * 注册成功后要再调一次幂等的 `config.applySessionAgent()`：`Config.initialize()`
 * 早于 SDK agent 注册，用户传的 `--agent` 那时还匹配不到。
 *
 * 解析失败与单个 agent 注册失败只 warn，不让整个 initialize 失败；显式会话 agent
 * 应用失败必须向上抛，避免回包声称成功而主会话仍用旧配置。
 */

import {
  parseAgentsFromSdkInitialize,
  runLogger,
  type Config,
} from '@qwen-code/core';
import type { ThreadSessionDeclarations } from '../contract/threadSessionTypes.js';

export interface HostAgentsParams {
  readonly config: Config;
  /** `initialize` 的中立声明袋；只读 `agents` 一个字段。 */
  readonly declarations: ThreadSessionDeclarations;
}

/** 注册 SDK 声明的 agents；`agents` 非对象或是数组时为空操作。 */
export async function registerHostAgents(
  params: HostAgentsParams,
): Promise<void> {
  const { config, declarations } = params;

  const raw = declarations.agents;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;

  const agentRegistry = config.getAgentRegistry?.();
  if (!agentRegistry) {
    runLogger.warn(
      '[thread-session] agents received but AgentRegistry unavailable — skipping.',
    );
    return;
  }

  let defs: ReturnType<typeof parseAgentsFromSdkInitialize>;
  try {
    defs = parseAgentsFromSdkInitialize(raw as Record<string, unknown>);
  } catch (error) {
    runLogger.warn(
      `[thread-session] Invalid agents payload: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  if (defs.length === 0) return;

  runLogger.log('[thread-session] registering SDK agents', {
    sessionId: config.getSessionId?.(),
    declared: defs.length,
  });

  const { registered, failed } = await agentRegistry.registerSdkAgents(defs);

  if (registered.length > 0) {
    runLogger.log(
      `[thread-session] SDK agents registered: [${registered.join(', ')}]`,
    );
    // 补偿 Config.initialize() 早于注册的那一次 applySessionAgent，幂等。
    await config.applySessionAgent();
  }
  if (failed.length > 0) {
    runLogger.warn(
      `[thread-session] SDK agents failed: [${failed.map((f) => `${f.name ?? '?'}: ${f.error}`).join('; ')}]`,
    );
  }
}
