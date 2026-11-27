/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionContentPart,
  ChatCompletionContentPartText,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionToolChoiceOption,
  ChatCompletionToolMessageParam,
} from 'openai/resources/chat/completions';
import type {
  ModelCacheControl,
  ModelInputContentBlock,
  ModelStreamAssistantMessage,
  ModelStreamRequest,
  ModelStreamSystemContent,
  ModelStreamTool,
  ModelToolChoice,
} from '../../../../modelStreamRequest.js';
import { ModelImageUtils } from '../../../../utils/modelImageUtils.js';
import { ModelThinkingUtils } from '../../../../utils/modelThinkingUtils.js';
import { ModelWireUtils } from '../../../../utils/modelWireUtils.js';

/**
 * buildChatCompletionsStreamReq 的字段映射台账：
 *
 * - model：resolution.model.key 直传；stream 恒 true；stream_options.include_usage
 *   恒 true（usage 靠尾帧回传）。
 * - messages：system 消息保持原顺序（OpenAI 无顶层 system），字符串透传，
 *   非空块数组逐块保留，不因缓存断点移动而拼接。
 *   - user：字符串透传，块数组保留 text / image_url 分片；图片经
 *     ModelImageUtils 判定，非视觉模型与不支持的媒体类型降级为占位文本。
 *   - assistant：文本块以换行拼接（对齐旧栈），思考文本落 reasoning_content
 *     （DeepSeek/Qwen 系兼容扩展），config.reasoning.preserve 为 false 时不回放；
 *     toolCalls → tool_calls，有工具调用且无正文时 content 落 null。
 *   - tool：tool_call_id 回填；字符串固定投影为一个文本分片，数组逐块保留，
 *     无有效分片时保留空字符串兼容表示（SDK 类型
 *     只声明文本分片，图片分片沿旧栈透传给兼容服务端）。isError 无 wire 字段。
 * - tools：type:function + function 包裹；空表整键不落。tool_choice 仅在有工具
 *   时落键，具名形态 → {type:'function', function:{name}}。
 * - 生成参数：config.maxOutputTokens → max_tokens；sampling 的 temperature / stop /
 *   top_p 直传；top_k 是兼容扩展，同样直传。缺省整键不落。
 * - 思考（仅模型支持思考时落键，不由预算推导档位）：显式关闭 →
 *   reasoning_effort:'none' + enable_thinking:false；
 *   reasoning.effort → reasoning_effort；thinking enabled →
 *   enable_thinking:true + thinking_budget；reasoning.preserve → preserve_thinking。
 * - cache_control：块断点投影到对应分片，工具整体断点投影到最后一片，
 *   只发 {type:'ephemeral'}，不影响正文形态；
 *   是否携带断点由 provider 按模型能力决定，assistant 文本拼接后不保留断点。
 */

/** OpenAI 兼容服务端（DashScope / DeepSeek 等）认可的非标准顶层字段。 */
interface ChatCompletionsCompatParams
  extends ChatCompletionCreateParamsStreaming {
  top_k?: number;
  enable_thinking?: boolean;
  thinking_budget?: number;
  preserve_thinking?: boolean;
}

/** assistant 历史的思考文本回放字段，同属兼容扩展。 */
type ChatCompletionsAssistantMessage = ChatCompletionAssistantMessageParam & {
  reasoning_content?: string;
};

/** 把协议无关推理入参映射为 OpenAI Chat Completions 流式请求体。 */
export function buildChatCompletionsStreamReq(
  request: ModelStreamRequest,
): ChatCompletionCreateParamsStreaming {
  const { model, config } = request.resolution;
  const { prompt } = request;
  const sampling = config.sampling;
  const req: ChatCompletionsCompatParams = {
    model: ModelWireUtils.modelId(model),
    messages: buildChatCompletionsMessages(request),
    stream: true,
    stream_options: { include_usage: true },
  };
  const tools = buildChatCompletionsTools(prompt.tools);
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
    req.max_tokens = config.context.maxOutputTokens;
  }
  if (sampling?.stop && sampling.stop.length > 0) {
    req.stop = [...sampling.stop];
  }
  if (sampling?.topP !== undefined) {
    req.top_p = sampling.topP;
  }
  if (sampling?.topK !== undefined) {
    req.top_k = sampling.topK;
  }
  applyThinking(req, request);
  return req;
}

/** 思考参数只发给支持思考的模型；关闭优先于档位与预算。 */
function applyThinking(
  req: ChatCompletionsCompatParams,
  request: ModelStreamRequest,
): void {
  const { model, config } = request.resolution;
  if (!model.capabilities.reasoning.supported) {
    return;
  }
  const reasoning = config.reasoning;
  if (ModelThinkingUtils.isDisabled(config)) {
    req.reasoning_effort = 'none';
    req.enable_thinking = false;
  } else {
    if (reasoning?.effort !== undefined) {
      req.reasoning_effort = reasoning.effort;
    }
    if (reasoning?.thinking?.type === 'enabled') {
      req.enable_thinking = true;
      req.thinking_budget = reasoning.thinking.budgetTokens;
    }
  }
  if (reasoning?.preserve !== undefined) {
    req.preserve_thinking = reasoning.preserve;
  }
}

/** 消息投影：system 前置为 system 消息，其余按角色逐条投影。 */
function buildChatCompletionsMessages(
  request: ModelStreamRequest,
): ChatCompletionMessageParam[] {
  const { model, config } = request.resolution;
  const { prompt } = request;
  const supportsVision = model.capabilities.vision;
  const preserveThinking = config.reasoning?.preserve !== false;
  const messages: ChatCompletionMessageParam[] = [];
  for (const message of prompt.messages) {
    switch (message.role) {
      case 'system':
        messages.push({
          role: 'system',
          content: projectSystemContent(message.content),
        });
        break;
      case 'user': {
        messages.push({
          role: 'user',
          content:
            typeof message.content === 'string'
              ? message.content
              : projectInputParts(message.content, supportsVision),
        });
        break;
      }
      case 'assistant':
        messages.push(projectAssistantMessage(message, preserveThinking));
        break;
      case 'tool':
        // tool 消息缺 tool_call_id 是无效请求，跳过而不是发出必被拒的报文。
        if (message.toolCallId) {
          messages.push({
            role: 'tool',
            tool_call_id: message.toolCallId,
            content: projectToolContent(
              message.content,
              supportsVision,
              message.cacheControl,
            ),
          });
        }
        break;
      default:
        break;
    }
  }
  return messages;
}

function projectSystemContent(
  content: ModelStreamSystemContent,
): string | ChatCompletionContentPartText[] {
  if (typeof content === 'string') return content;
  if (content.length === 0) return '';
  return projectInputParts(content, false) as ChatCompletionContentPartText[];
}

/** 兼容扩展：OpenAI 无该字段，DashScope 等按 Anthropic 形态识别；TTL 不投影。 */
function projectCacheControl(cacheControl: ModelCacheControl | undefined): {
  cache_control?: { type: 'ephemeral' };
} {
  return cacheControl ? { cache_control: { type: 'ephemeral' } } : {};
}

/** 用户输入与工具结果共用的分片投影；字符串内容落单个文本分片。 */
function projectInputParts(
  content: string | readonly ModelInputContentBlock[],
  supportsVision: boolean,
): ChatCompletionContentPart[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  const parts: ChatCompletionContentPart[] = [];
  for (const block of content) {
    const cacheControl = projectCacheControl(block.cacheControl);
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text, ...cacheControl });
      continue;
    }
    const image = ModelImageUtils.resolve(block.source, supportsVision);
    if (!image) continue;
    parts.push(
      image.type === 'text'
        ? { type: 'text', text: image.text, ...cacheControl }
        : {
            type: 'image_url',
            image_url: { url: ModelImageUtils.toUrl(image) },
            ...cacheControl,
          },
    );
  }
  return parts;
}

function projectToolContent(
  content: string | readonly ModelInputContentBlock[],
  supportsVision: boolean,
  cacheControl: ModelCacheControl | undefined,
): ChatCompletionToolMessageParam['content'] {
  const parts = projectInputParts(content, supportsVision);
  // 此协议沿用内容分片上的缓存扩展，将整体断点投影到最后一片。
  if (cacheControl && parts.length > 0) {
    const last = parts.length - 1;
    parts[last] = { ...parts[last], ...projectCacheControl(cacheControl) };
  }
  // 工具断点依赖分片扩展：无断点时也保持同样的分片，避免改写历史前缀。
  return parts.length > 0 ? (parts as ChatCompletionContentPartText[]) : '';
}

/** 正文、思考与工具调用分别落 content / reasoning_content / tool_calls。 */
function projectAssistantMessage(
  message: ModelStreamAssistantMessage,
  preserveThinking: boolean,
): ChatCompletionsAssistantMessage {
  const texts: string[] = [];
  let reasoningContent = '';
  if (typeof message.content === 'string') {
    texts.push(message.content);
  } else {
    for (const block of message.content) {
      if (block.type === 'text') {
        texts.push(block.text);
      } else if (block.type === 'thinking' && preserveThinking) {
        reasoningContent += block.thinking;
      }
      // redacted_thinking 是其他协议的密文，Chat Completions 无回放位。
    }
  }
  const text = texts.join('\n');
  const toolCalls = message.toolCalls ?? [];
  return {
    role: 'assistant',
    content: text.length === 0 && toolCalls.length > 0 ? null : text,
    ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
    ...(toolCalls.length > 0
      ? {
          tool_calls: toolCalls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: call.arguments },
          })),
        }
      : {}),
  };
}

/** 工具声明包装为 OpenAI wire 形状；description/parameters 缺省不落键。 */
function buildChatCompletionsTools(
  tools: readonly ModelStreamTool[] | undefined,
): NonNullable<ChatCompletionCreateParamsStreaming['tools']> {
  return (tools ?? []).map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.parameters ? { parameters: tool.parameters } : {}),
    },
  }));
}

function projectToolChoice(
  toolChoice: ModelToolChoice,
): ChatCompletionToolChoiceOption {
  return typeof toolChoice === 'string'
    ? toolChoice
    : { type: 'function', function: { name: toolChoice.name } };
}
