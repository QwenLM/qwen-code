/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ResponseCreateParamsStreaming,
  ResponseFunctionCallOutputItemList,
  ResponseInputContent,
  ResponseInputItem,
  ResponseReasoningItem,
  ToolChoiceFunction,
  ToolChoiceOptions,
} from 'openai/resources/responses/responses';
import type {
  ModelInputContentBlock,
  ModelStreamAssistantMessage,
  ModelStreamRequest,
  ModelStreamSystemContent,
  ModelStreamTool,
  ModelToolChoice,
} from '../../../../modelStreamRequest.js';
import type { ModelReasoningMetadata } from '../../../../event/modelStreamEvent.js';
import {
  ModelImageUtils,
  type ModelImageProjection,
} from '../../../../utils/modelImageUtils.js';
import { ModelThinkingUtils } from '../../../../utils/modelThinkingUtils.js';
import { ModelWireUtils } from '../../../../utils/modelWireUtils.js';

/**
 * buildResponsesStreamReq 的字段映射台账：
 *
 * - model：resolution.model.key 直传；stream：恒 true。store:false +
 *   include:['reasoning.encrypted_content']：无状态全量重放，推理密文随响应
 *   取回，下一轮经 reasoning 项回放（不用 previous_response_id）。
 * - instructions：连续开头的 system 消息拼成文本，沿用顶层指令位。
 * - input：
 *   - 非前缀 system → role:'system' 消息，对话中途的 system 保留原位。
 *   - user → 单个文本收敛为字符串，否则 input_text / input_image 分片；图片经
 *     ModelImageUtils 判定，降级结果落文本分片。
 *   - assistant：按原顺序投影，思考块按 reasoning.id 合并为一条 reasoning 项
 *     （thinking 的元数据 + redacted_thinking 的密文）；无 id 或既无密文又无
 *     可见文本的思考无法回放，跳过；config.reasoning.preserve 为 false 时整体
 *     丢弃。相邻文本块以换行拼为一条 assistant 消息；toolCalls → function_call
 *     （call_id 取调用 id）。
 *   - tool → function_call_output，纯文本拼为字符串，含图片时保留分片；
 *     isError 无 wire 字段。
 * - tools：扁平 function 工具；空表整键不落。tool_choice 仅在有工具时落键，
 *   具名形态 → {type:'function', name}。
 * - 生成参数：temperature / max_output_tokens / top_p 直传；top_k 无 wire 字段，
 *   忽略（对齐旧栈，跨协议共享的偏好不让请求失败）；stop 无 wire 字段，非空
 *   时直接报错（对齐旧栈）。
 * - 思考（仅模型支持思考时落键）：档位经 ModelThinkingUtils.resolveEffort 求解
 *   （显式关闭为 none，enabled 预算推导档位）；非 none 时附 summary:'auto'
 *   取回可见摘要；adaptive 且无档位时只请求摘要。
 */

/** 把协议无关推理入参映射为 OpenAI Responses 流式请求体。 */
export function buildResponsesStreamReq(
  request: ModelStreamRequest,
): ResponseCreateParamsStreaming {
  const { model, config } = request.resolution;
  const { prompt } = request;
  const sampling = config.sampling;
  if (sampling?.stop && sampling.stop.length > 0) {
    throw new Error('OpenAI Responses 协议不支持 stop 参数。');
  }
  const leadingSystem: string[] = [];
  for (const message of prompt.messages) {
    if (message.role !== 'system') break;
    leadingSystem.push(projectSystemText(message.content));
  }
  const req: ResponseCreateParamsStreaming = {
    model: ModelWireUtils.modelId(model),
    ...(leadingSystem.length > 0
      ? { instructions: leadingSystem.join('') }
      : {}),
    input: buildResponsesInput(request, leadingSystem.length),
    stream: true,
    store: false,
    include: ['reasoning.encrypted_content'],
  };
  const tools = buildResponsesTools(prompt.tools);
  if (tools.length > 0) {
    req.tools = tools;
    if (prompt.toolChoice !== undefined) {
      req.tool_choice = projectToolChoice(prompt.toolChoice);
    }
  }
  if (sampling?.temperature !== undefined) {
    req.temperature = sampling.temperature;
  }
  if (config.context?.maxOutputTokens !== undefined) {
    req.max_output_tokens = config.context.maxOutputTokens;
  }
  if (sampling?.topP !== undefined) {
    req.top_p = sampling.topP;
  }
  applyReasoning(req, request);
  return req;
}

/** 推理参数只发给支持思考的模型；none 档位不请求摘要。 */
function applyReasoning(
  req: ResponseCreateParamsStreaming,
  request: ModelStreamRequest,
): void {
  const { model, config } = request.resolution;
  if (!model.capabilities.reasoning.supported) {
    return;
  }
  const effort = ModelThinkingUtils.resolveEffort(config);
  if (effort !== undefined) {
    req.reasoning = {
      effort,
      ...(effort !== 'none' ? { summary: 'auto' as const } : {}),
    };
  } else if (config.reasoning?.thinking?.type === 'adaptive') {
    req.reasoning = { summary: 'auto' };
  }
}

function buildResponsesInput(
  request: ModelStreamRequest,
  leadingSystemCount: number,
): ResponseInputItem[] {
  const { model, config } = request.resolution;
  const supportsVision = model.capabilities.vision;
  const preserveThinking = config.reasoning?.preserve !== false;
  const input: ResponseInputItem[] = [];
  for (const message of request.prompt.messages.slice(leadingSystemCount)) {
    switch (message.role) {
      case 'system':
        input.push({
          type: 'message',
          role: 'system',
          content: projectSystemText(message.content),
        });
        break;
      case 'user': {
        const parts = projectInputParts(message.content, supportsVision);
        input.push({
          type: 'message',
          role: 'user',
          content:
            parts.length === 1 && parts[0].type === 'input_text'
              ? parts[0].text
              : parts,
        });
        break;
      }
      case 'assistant':
        input.push(...projectAssistantItems(message, preserveThinking));
        break;
      case 'tool':
        // tool 消息缺 tool_call_id 是无效请求，跳过而不是发出必被拒的报文。
        if (message.toolCallId) {
          input.push({
            type: 'function_call_output',
            call_id: message.toolCallId,
            output: projectToolOutput(message.content, supportsVision),
          });
        }
        break;
      default:
        break;
    }
  }
  return input;
}

function projectSystemText(content: ModelStreamSystemContent): string {
  return typeof content === 'string'
    ? content
    : content.map((block) => block.text).join('');
}

/** 用户输入的分片投影；字符串内容落单个文本分片。 */
function projectInputParts(
  content: string | readonly ModelInputContentBlock[],
  supportsVision: boolean,
): ResponseInputContent[] {
  if (typeof content === 'string') {
    return [{ type: 'input_text', text: content }];
  }
  const parts: ResponseInputContent[] = [];
  for (const block of content) {
    const image = resolveImage(block, supportsVision);
    if (block.type === 'text') {
      parts.push({ type: 'input_text', text: block.text });
    } else if (image?.type === 'text') {
      parts.push({ type: 'input_text', text: image.text });
    } else if (image) {
      parts.push({
        type: 'input_image',
        image_url: ModelImageUtils.toUrl(image),
        detail: 'auto',
      });
    }
  }
  return parts;
}

/** 工具结果：纯文本拼为字符串，含图片时保留分片。 */
function projectToolOutput(
  content: string | readonly ModelInputContentBlock[],
  supportsVision: boolean,
): string | ResponseFunctionCallOutputItemList {
  if (typeof content === 'string') {
    return content;
  }
  const parts: ResponseFunctionCallOutputItemList = [];
  for (const block of content) {
    const image = resolveImage(block, supportsVision);
    if (block.type === 'text') {
      parts.push({ type: 'input_text', text: block.text });
    } else if (image?.type === 'text') {
      parts.push({ type: 'input_text', text: image.text });
    } else if (image) {
      parts.push({ type: 'input_image', image_url: ModelImageUtils.toUrl(image) });
    }
  }
  return parts.every((part) => part.type === 'input_text')
    ? parts.map((part) => part.text).join('\n')
    : parts;
}

function resolveImage(
  block: ModelInputContentBlock,
  supportsVision: boolean,
): ModelImageProjection | undefined {
  return block.type === 'image'
    ? ModelImageUtils.resolve(block.source, supportsVision)
    : undefined;
}

/** 可回放的思考记录：同一 reasoning.id 的可见部分与密文合并为一项。 */
interface ReasoningDraft {
  readonly id: string;
  thinking: string;
  metadata?: ModelReasoningMetadata;
  encrypted?: string;
}

/** 思考、正文按原顺序投影，toolCalls 追加在末尾。 */
function projectAssistantItems(
  message: ModelStreamAssistantMessage,
  preserveThinking: boolean,
): ResponseInputItem[] {
  if (typeof message.content === 'string') {
    return [
      ...(message.content ? [assistantText(message.content)] : []),
      ...projectFunctionCalls(message),
    ];
  }
  const ordered: Array<ReasoningDraft | string> = [];
  const drafts = new Map<string, ReasoningDraft>();
  let pendingText: string[] = [];
  const flushText = () => {
    const text = pendingText.join('\n');
    if (text) ordered.push(text);
    pendingText = [];
  };
  for (const block of message.content) {
    if (block.type === 'text') {
      pendingText.push(block.text);
      continue;
    }
    const id = block.reasoning?.id;
    if (!preserveThinking || !id) continue;
    let draft = drafts.get(id);
    if (!draft) {
      flushText();
      draft = { id, thinking: '' };
      drafts.set(id, draft);
      ordered.push(draft);
    }
    if (block.type === 'thinking') {
      draft.thinking += block.thinking;
      draft.metadata = { ...draft.metadata, ...block.reasoning };
    } else {
      draft.encrypted ??= block.data || undefined;
      draft.metadata = { ...block.reasoning, ...draft.metadata };
    }
  }
  flushText();

  const items: ResponseInputItem[] = [];
  for (const entry of ordered) {
    if (typeof entry === 'string') {
      items.push(assistantText(entry));
      continue;
    }
    const reasoning = projectReasoningItem(entry);
    if (reasoning) items.push(reasoning);
  }
  items.push(...projectFunctionCalls(message));
  return items;
}

/**
 * 摘要优先取元数据里的原始分段，缺省时以可见思考文本兜底；既无密文又无可见
 * 文本的记录不回放。
 */
function projectReasoningItem(
  draft: ReasoningDraft,
): ResponseReasoningItem | undefined {
  const summary: ResponseReasoningItem.Summary[] = draft.metadata?.summary
    ?.length
    ? draft.metadata.summary.map((part) => ({
        type: 'summary_text',
        text: part.text,
      }))
    : draft.thinking && !draft.metadata?.content?.length
      ? [{ type: 'summary_text', text: draft.thinking }]
      : [];
  const content = draft.metadata?.content?.map(
    (part): ResponseReasoningItem.Content => ({
      type: 'reasoning_text',
      text: part.text,
    }),
  );
  const hasVisible =
    summary.some((part) => part.text) ||
    (content ?? []).some((part) => part.text);
  if (draft.encrypted === undefined && !hasVisible) {
    return undefined;
  }
  return {
    type: 'reasoning',
    id: draft.id,
    summary,
    ...(content?.length ? { content } : {}),
    ...(draft.encrypted !== undefined
      ? { encrypted_content: draft.encrypted }
      : {}),
    ...(draft.metadata?.status ? { status: draft.metadata.status } : {}),
  };
}

function assistantText(text: string): ResponseInputItem {
  return { type: 'message', role: 'assistant', content: text };
}

function projectFunctionCalls(
  message: ModelStreamAssistantMessage,
): ResponseInputItem[] {
  return (message.toolCalls ?? []).map((call) => ({
    type: 'function_call',
    call_id: call.id,
    name: call.name,
    arguments: call.arguments || '{}',
  }));
}

/** 工具声明映射为 Responses 扁平 function 工具；wire 的 parameters 必填，
 * 缺省落空对象；description 缺省不落键。 */
function buildResponsesTools(
  tools: readonly ModelStreamTool[] | undefined,
): NonNullable<ResponseCreateParamsStreaming['tools']> {
  return (tools ?? []).map((tool) => ({
    type: 'function' as const,
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.parameters ?? { type: 'object', properties: {} },
    strict: false,
  }));
}

function projectToolChoice(
  toolChoice: ModelToolChoice,
): ToolChoiceOptions | ToolChoiceFunction {
  return typeof toolChoice === 'string'
    ? toolChoice
    : { type: 'function', name: toolChoice.name };
}
