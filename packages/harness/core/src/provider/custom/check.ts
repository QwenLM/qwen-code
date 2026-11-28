/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SettingsService } from '@qwen-code/resource';
import { composeAbortSignals } from '../../utils/fetch.js';
import {
  createCustomModelProvider,
  customModelFromRuntime,
} from '../impl/customModelProviderFactory.js';
import { safeConfigLogText } from '../impl/customModelProviderConfigLog.js';
import { ModelInferenceError } from '../modelInferenceError.js';
import { ChatCompletionsTransport } from '../transport/impl/chatCompletionsTransport.js';
import { ResponsesTransport } from '../transport/impl/responsesTransport.js';
import { MessagesTransport } from '../transport/impl/messagesTransport.js';
import { GeminiTransport } from '../transport/impl/geminiTransport.js';
import { ModelTransportManager } from '../transport/modelTransportManager.js';
import type { CustomProviderRuntime } from './types.js';

let transports: ModelTransportManager | undefined;

/** 检查尚未保存的默认模型，不注册到会话，也不读取或写入模型偏好。 */
export async function checkCustomProviderConnection(
  runtime: CustomProviderRuntime,
  settingsService: SettingsService,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const provider = createCustomModelProvider(
    runtime,
    (transports ??= new ModelTransportManager([
      new ChatCompletionsTransport(),
      new ResponsesTransport(),
      new MessagesTransport(),
      new GeminiTransport(),
    ])),
    settingsService,
    'user',
  );
  const timeout = new AbortController();
  const timer = setTimeout(() => {
    timeout.abort(
      new DOMException('Custom Provider check timed out', 'TimeoutError'),
    );
  }, 30_000);
  timer.unref?.();
  const combined = composeAbortSignals(
    signal ? [signal, timeout.signal] : [timeout.signal],
  );
  try {
    // parser 保证默认模型存在；检查只使用候选配置，不启动偏好存储。
    const model = customModelFromRuntime(
      runtime,
      runtime.models.get(runtime.defaultModel)!,
    );
    // 不带思考参数：能力投影会给所有思考模型补 none，无法据此判断上游是否接受关闭思考。
    const resolution = await provider.select({
      purpose: 'main',
      mainModel: model,
      overrideSelection: { config: { context: { maxOutputTokens: 16 } } },
      signal: combined.signal,
    });
    const response = await provider.inference({
      resolution,
      prompt: { messages: [{ role: 'user', content: 'Reply with OK.' }] },
      control: { signal: combined.signal },
    });
    // 完整的预算耗尽终态也表示推理已调通；不把异常或未完成的流当作成功。
    await response.completed;
  } catch (error) {
    if (combined.signal.aborted) throw combined.signal.reason;
    throw redactCheckError(error, runtime.apiKey);
  } finally {
    clearTimeout(timer);
    combined.cleanup();
    await provider.stop();
  }
}

function redactCheckError(error: unknown, apiKey: string): Error {
  const redact = (value: string) => safeConfigLogText(value, [apiKey]);
  const message = redact(
    error instanceof Error ? error.message : String(error),
  );
  // 推理错误的 cause 可含原始响应和凭据，检查出口只保留可展示的诊断字段。
  if (error instanceof ModelInferenceError) {
    return new ModelInferenceError(message, {
      kind: error.kind,
      phase: error.phase,
      status: error.status,
      code: error.code === undefined ? undefined : redact(error.code),
    });
  }
  return new Error(message);
}
