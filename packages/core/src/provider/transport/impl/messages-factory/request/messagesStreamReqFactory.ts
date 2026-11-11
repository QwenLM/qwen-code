/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CacheControlEphemeral,
  ContentBlockParam,
  ImageBlockParam,
  MessageCreateParamsStreaming,
  MessageParam,
  TextBlockParam,
  ThinkingConfigParam,
  Tool,
  ToolChoice,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type {
  ModelCacheControl,
  ModelInputContentBlock,
  ModelStreamAssistantMessage,
  ModelStreamRequest,
  ModelStreamSystemContent,
  ModelStreamTool,
  ModelStreamToolResultMessage,
  ModelToolChoice,
} from '../../../../modelStreamRequest.js';
import type {
  ModelThinkingConfig,
  ReasoningEffortLevel,
} from '../../../../model/model.js';
import { ModelImageUtils } from '../../../../utils/modelImageUtils.js';
import { ModelThinkingUtils } from '../../../../utils/modelThinkingUtils.js';
import { ModelWireUtils } from '../../../../utils/modelWireUtils.js';
import { parseToolInput } from '../../../../../protocol/provider/tool-input.js';

/**
 * buildMessagesStreamReq 的字段映射台账：
 *
 * - model：resolution.model.key 直传；stream：恒 true。
 * - max_tokens：Anthropic wire 必填。取 config.maxOutputTokens ??
 *   model.limits.maxOutputTokens；两者均缺省时落 8192 兜底。
 * - system：prompt.system 字符串直传，块数组投成文本块并保留 cache_control；
 *   历史开头的 system 消息并入 system，对话中途的 system 消息跳过（wire 只
 *   接受 user/assistant，旧栈在此处抛错，本处降级为跳过）。
 * - messages：
 *   - user：文本 / 图片块，图片经 ModelImageUtils 判定，base64 → base64 源，
 *     URL → url 源，降级结果落文本块。
 *   - assistant：按原顺序回放 thinking（签名缺省落 ''，对齐旧栈）/
 *     redacted_thinking / 文本块，config.reasoning.preserve 为 false 时丢弃思考；
 *     toolCalls 随后投成 tool_use，arguments 经 parseToolInput 解析。
 *   - tool：投成 user 消息里的 tool_result，isError → is_error。
 *   - 连续同角色消息合并（tool_result 与后续 user 输入同属 user 角色），空内容
 *     消息跳过；空文本块不发送（wire 拒收空文本块）。
 *   - cacheControl → cache_control，ttl 只透传 wire 认可的 '5m' / '1h'。
 * - tools：中立声明映射为 Anthropic 形状（input_schema 承载 JSON Schema）；
 *   空表整键不落。tool_choice 仅在有工具时落键：required → any，具名 → tool。
 * - 生成参数（config.sampling）：stop → stop_sequences；temperature / top_p / top_k 直传。
 * - 思考（仅模型支持思考时落键）：显式关闭 → thinking:{type:'disabled'}；
 *   enabled → {type:'enabled', budget_tokens}；adaptive → {type:'adaptive'}；
 *   reasoning.effort（非 none）→ output_config.effort，不由预算推导档位。
 */

/** Anthropic wire 必填 max_tokens 的兜底值；待 Model 契约扩展后移除。 */
const DEFAULT_MAX_TOKENS = 8192;

/** SDK 的 effort 尚未收录 xhigh，档位按中立值域原样透传给服务端校验。 */
type MessagesStreamParams = Omit<MessageCreateParamsStreaming, 'output_config'> & {
  output_config?: { effort?: Exclude<ReasoningEffortLevel, 'none'> };
};

type MessagesRole = MessageParam['role'];

/** 把协议无关推理入参映射为 Anthropic Messages 流式请求体。 */
export function buildMessagesStreamReq(
  request: ModelStreamRequest,
): MessageCreateParamsStreaming {
  const { model, config } = request.resolution;
  const { prompt } = request;
  const sampling = config.sampling;
  const { system, messages } = buildMessagesParamList(request);
  const req: MessagesStreamParams = {
    model: ModelWireUtils.modelId(model),
    max_tokens:
      config.context?.maxOutputTokens ??
      model.limits.maxOutputTokens ??
      DEFAULT_MAX_TOKENS,
    messages,
    stream: true,
  };
  if (system !== undefined) {
    req.system = system;
  }
  const tools = buildMessagesTools(prompt.tools);
  if (tools.length > 0) {
    req.tools = tools;
    if (prompt.toolChoice !== undefined) {
      req.tool_choice = projectToolChoice(prompt.toolChoice);
    }
  }
  if (sampling?.temperature !== undefined) {
    req.temperature = sampling.temperature;
  }
  if (sampling?.stop && sampling.stop.length > 0) {
    req.stop_sequences = [...sampling.stop];
  }
  if (sampling?.topP !== undefined) {
    req.top_p = sampling.topP;
  }
  if (sampling?.topK !== undefined) {
    req.top_k = sampling.topK;
  }
  applyThinking(req, request);
  return req as MessageCreateParamsStreaming;
}

/** 思考参数只发给支持思考的模型；关闭优先于档位与思考模式。 */
function applyThinking(
  req: MessagesStreamParams,
  request: ModelStreamRequest,
): void {
  const { model, config } = request.resolution;
  if (!model.capabilities.reasoning.supported) {
    return;
  }
  if (ModelThinkingUtils.isDisabled(config)) {
    req.thinking = { type: 'disabled' };
    return;
  }
  const thinking = projectThinkingConfig(config.reasoning?.thinking);
  if (thinking) {
    req.thinking = thinking;
  }
  const effort = config.reasoning?.effort;
  if (effort !== undefined && effort !== 'none') {
    req.output_config = { effort };
  }
}

function projectThinkingConfig(
  thinking: ModelThinkingConfig | undefined,
): ThinkingConfigParam | undefined {
  switch (thinking?.type) {
    case 'enabled':
      return { type: 'enabled', budget_tokens: thinking.budgetTokens };
    case 'adaptive':
      return { type: 'adaptive' };
    default:
      return undefined;
  }
}

/** 消息投影：开头的 system 消息并入 system，其余按角色投影后合并同角色。 */
function buildMessagesParamList(request: ModelStreamRequest): {
  system: MessageCreateParamsStreaming['system'];
  messages: MessageParam[];
} {
  const { model, config } = request.resolution;
  const supportsVision = model.capabilities.vision;
  const preserveThinking = config.reasoning?.preserve !== false;
  const leadingSystem: ModelStreamSystemContent[] = [];
  const messages: Array<{ role: MessagesRole; content: ContentBlockParam[] }> =
    [];
  const pushMerged = (role: MessagesRole, content: ContentBlockParam[]) => {
    if (content.length === 0) return;
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else messages.push({ role, content });
  };

  for (const message of request.prompt.messages) {
    switch (message.role) {
      case 'system':
        if (messages.length === 0) {
          leadingSystem.push(message.content);
        }
        break;
      case 'user':
        pushMerged('user', projectInputBlocks(message.content, supportsVision));
        break;
      case 'assistant':
        pushMerged(
          'assistant',
          projectAssistantBlocks(message, preserveThinking),
        );
        break;
      case 'tool':
        // tool 消息缺 tool_call_id 是无效请求，跳过而不是发出必被拒的报文。
        if (message.toolCallId) {
          pushMerged('user', [projectToolResult(message, supportsVision)]);
        }
        break;
      default:
        break;
    }
  }
  return {
    system: mergeSystem(leadingSystem),
    messages,
  };
}

/** 纯字符串 systemPrompt 且无历史 system 时保持字符串形态，其余收敛为块数组。 */
function mergeSystem(
  leadingSystem: ModelStreamSystemContent[],
): MessageCreateParamsStreaming['system'] {
  const [first] = leadingSystem;
  if (leadingSystem.length === 1 && typeof first === 'string') {
    return first;
  }
  const blocks = leadingSystem.flatMap(projectSystemBlocks);
  return blocks.length > 0 ? blocks : undefined;
}

function projectSystemBlocks(
  content: ModelStreamSystemContent,
): TextBlockParam[] {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }
  return content
    .filter((block) => block.text)
    .map((block) => projectTextBlock(block.text, block.cacheControl));
}

/** 用户输入与工具结果共用的块投影；字符串内容落单个文本块。 */
function projectInputBlocks(
  content: string | readonly ModelInputContentBlock[],
  supportsVision: boolean,
): Array<TextBlockParam | ImageBlockParam> {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }
  const blocks: Array<TextBlockParam | ImageBlockParam> = [];
  for (const block of content) {
    if (block.type === 'text') {
      if (block.text) {
        blocks.push(projectTextBlock(block.text, block.cacheControl));
      }
      continue;
    }
    const image = ModelImageUtils.resolve(block.source, supportsVision);
    if (!image) continue;
    const cacheControl = projectCacheControl(block.cacheControl);
    if (image.type === 'text') {
      blocks.push(projectTextBlock(image.text, block.cacheControl));
    } else {
      blocks.push({
        type: 'image',
        source:
          image.type === 'base64'
            ? { type: 'base64', media_type: image.mediaType, data: image.data }
            : { type: 'url', url: image.url },
        ...(cacheControl ? { cache_control: cacheControl } : {}),
      });
    }
  }
  return blocks;
}

/** 思考与正文按原顺序回放，toolCalls 追加在末尾。 */
function projectAssistantBlocks(
  message: ModelStreamAssistantMessage,
  preserveThinking: boolean,
): ContentBlockParam[] {
  const blocks: ContentBlockParam[] = [];
  if (typeof message.content === 'string') {
    if (message.content) {
      blocks.push({ type: 'text', text: message.content });
    }
  } else {
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          if (block.text) {
            blocks.push(projectTextBlock(block.text, block.cacheControl));
          }
          break;
        case 'thinking':
          // 部分兼容服务端只给可见思考不给签名，空签名同样可被回放（对齐旧栈）。
          if (preserveThinking && (block.thinking || block.signature)) {
            blocks.push({
              type: 'thinking',
              thinking: block.thinking,
              signature: block.signature ?? '',
            });
          }
          break;
        case 'redacted_thinking':
          if (preserveThinking && block.data) {
            blocks.push({ type: 'redacted_thinking', data: block.data });
          }
          break;
        default:
          break;
      }
    }
  }
  for (const call of message.toolCalls ?? []) {
    blocks.push({
      type: 'tool_use',
      id: call.id,
      name: call.name,
      input: parseToolInput(call.arguments),
    });
  }
  return blocks;
}

/** 纯文本结果收敛为字符串，含图片时保留块数组。 */
function projectToolResult(
  message: ModelStreamToolResultMessage,
  supportsVision: boolean,
): ToolResultBlockParam {
  const content =
    typeof message.content === 'string'
      ? message.content
      : projectInputBlocks(message.content, supportsVision);
  return {
    type: 'tool_result',
    tool_use_id: message.toolCallId,
    content,
    ...(message.isError ? { is_error: true } : {}),
  };
}

function projectTextBlock(
  text: string,
  cacheControl: ModelCacheControl | undefined,
): TextBlockParam {
  const projected = projectCacheControl(cacheControl);
  return {
    type: 'text',
    text,
    ...(projected ? { cache_control: projected } : {}),
  };
}

function projectCacheControl(
  cacheControl: ModelCacheControl | undefined,
): CacheControlEphemeral | undefined {
  if (!cacheControl) return undefined;
  const { ttl } = cacheControl;
  return ttl === '5m' || ttl === '1h'
    ? { type: 'ephemeral', ttl }
    : { type: 'ephemeral' };
}

/** 工具声明映射为 Anthropic 形状；description 缺省不落键。 */
function buildMessagesTools(
  tools: readonly ModelStreamTool[] | undefined,
): Tool[] {
  return (tools ?? []).map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: {
      // JSON Schema 整体透传，wire 的 type:object 缺省兜底。
      type: 'object' as const,
      ...(tool.parameters ?? {}),
    },
  }));
}

function projectToolChoice(toolChoice: ModelToolChoice): ToolChoice {
  if (typeof toolChoice !== 'string') {
    return { type: 'tool', name: toolChoice.name };
  }
  return toolChoice === 'required' ? { type: 'any' } : { type: toolChoice };
}
