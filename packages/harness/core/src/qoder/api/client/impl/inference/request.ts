/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ResponseCreateParamsStreaming } from 'openai/resources/responses/responses';

import type { QoderInferenceBusiness } from '../../api/inference/inference.js';
import { QODER_SESSION_TYPE } from '../../../regions.js';

export interface QoderResponsesBodyOptions {
  readonly business?: QoderInferenceBusiness;
  readonly taskId?: string;
  readonly sourceSessionId?: string;
  readonly contextLength?: number;
}

/**
 * Qoder 网关对 Responses 请求体的裁剪规则：
 * 只保留无状态全量重放所需的字段，剔除网关不接受的采样/缓存/会话字段，
 * 并补上计费场景元数据。协议映射本身复用宿主的 Responses 请求构造器。
 */
export function prepareQoderResponsesBody(
  body: ResponseCreateParamsStreaming,
  options: QoderResponsesBodyOptions,
): ResponseCreateParamsStreaming {
  const prepared = {
    ...body,
    stream: true,
    store: false,
    metadata: {
      ...body.metadata,
      session_type: QODER_SESSION_TYPE,
      ...(options.taskId !== undefined ? { task_id: options.taskId } : {}),
      ...(options.sourceSessionId !== undefined
        ? { source_session_id: options.sourceSessionId }
        : {}),
      ...(options.business
        ? {
            business_id: options.business.id,
            business_type: options.business.type,
            ...(options.business.sub_task !== undefined
              ? { sub_task: options.business.sub_task }
              : {}),
            ...(options.business.model_key !== undefined
              ? { model_key: options.business.model_key }
              : {}),
          }
        : {}),
      ...(options.contextLength !== undefined &&
      Number.isSafeInteger(options.contextLength) &&
      options.contextLength > 0
        ? { context_length: String(options.contextLength) }
        : {}),
    },
  } as ResponseCreateParamsStreaming & Record<string, unknown>;

  delete prepared['prompt_cache_key'];
  delete prepared['prompt_cache_options'];
  delete prepared['temperature'];
  delete prepared['top_p'];
  delete prepared['service_tier'];
  delete prepared['previous_response_id'];

  // The gateway's auto/router upstream has emitted malformed parallel
  // tool-call ids for the full tool set; sequential calls avoid that shape.
  if (Array.isArray(prepared.tools) && prepared.tools.length > 0) {
    prepared.parallel_tool_calls = false;
  }

  if (prepared.truncation === 'auto') {
    delete prepared['truncation'];
  }

  if (Array.isArray(prepared.include)) {
    const include = prepared.include.filter(
      (item) => item === 'reasoning.encrypted_content',
    );
    if (include.length > 0) {
      prepared.include = include;
    } else {
      delete prepared['include'];
    }
  }

  if (prepared.text) {
    const text = { ...prepared.text };
    delete (text as { verbosity?: unknown }).verbosity;
    if (Object.keys(text).length > 0) {
      prepared.text = text;
    } else {
      delete prepared['text'];
    }
  }

  if (Array.isArray(prepared.input)) {
    prepared.input = stripPromptCacheBreakpoints(prepared.input);
  }

  if (prepared.reasoning) {
    const reasoning = { ...prepared.reasoning };
    delete reasoning.summary;
    prepared.reasoning = reasoning;
  }

  return prepared;
}

function stripPromptCacheBreakpoints(
  input: ResponseCreateParamsStreaming['input'],
): ResponseCreateParamsStreaming['input'] {
  if (!Array.isArray(input)) {
    return input;
  }
  return input.map((item) => {
    if (!item || typeof item !== 'object') {
      return item;
    }
    const copy = { ...item } as Record<string, unknown>;
    if (Array.isArray(copy['content'])) {
      copy['content'] = copy['content'].map(stripBreakpointPart);
    }
    if (Array.isArray(copy['output'])) {
      copy['output'] = copy['output'].map(stripBreakpointPart);
    }
    return copy as unknown as (typeof input)[number];
  });
}

function stripBreakpointPart(part: unknown): unknown {
  if (!part || typeof part !== 'object') {
    return part;
  }
  const copy = { ...(part as Record<string, unknown>) };
  delete copy['prompt_cache_breakpoint'];
  return copy;
}
