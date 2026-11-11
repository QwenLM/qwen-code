/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ModelRedactedThinkingBlock,
  ModelTextBlock,
  ModelThinkingBlock,
} from './event/modelCompleteEvent.js';
import type { ModelSelection } from './model/modelSelection.js';

/** 提示词缓存断点：缓存截止到所在块（含）的完整前缀。 */
export interface ModelCacheControl {
  readonly type: 'ephemeral';
  /** 缓存存活时长（如 '5m'、'1h'）；缺省由服务端默认。 */
  readonly ttl?: string;
}

/** 请求侧文本块：在响应文本块之上可标记缓存断点。 */
export interface ModelStreamTextBlock extends ModelTextBlock {
  readonly cacheControl?: ModelCacheControl;
}

/** 请求中的图片块，支持内联 base64 数据或 URL 引用。 */
export interface ModelImageBlock {
  readonly type: 'image';
  readonly source:
    | {
        readonly type: 'base64';
        readonly mediaType: string;
        readonly data: string;
      }
    | {
        readonly type: 'url';
        readonly url: string;
      };
  readonly cacheControl?: ModelCacheControl;
}

/** 用户输入和工具结果共用的内容块，不包含思考或工具调用。 */
export type ModelInputContentBlock = ModelStreamTextBlock | ModelImageBlock;

/** 系统内容只允许文本；数组保留文本块的顺序。 */
export type ModelStreamSystemContent = string | readonly ModelStreamTextBlock[];

/** 用户内容允许文本和图片；字符串保留纯文本调用的兼容性。 */
export type ModelStreamUserContent = string | readonly ModelInputContentBlock[];

/** assistant 历史保留文本及思考回放数据，工具调用由 toolCalls 独立承载。 */
export type ModelStreamAssistantContent =
  | string
  | ReadonlyArray<
      ModelStreamTextBlock | ModelThinkingBlock | ModelRedactedThinkingBlock
    >;

/** 工具结果允许文本和图片，调用归属由消息外层的 toolCallId 表达。 */
export type ModelStreamToolResultContent =
  | string
  | readonly ModelInputContentBlock[];

/**
 * assistant 历史消息里的一次工具调用；arguments 是 JSON 文本原样承载，
 * 契约层不解析（响应侧 ModelToolUseBlock.input 是解析后的对象，回填历史时
 * 由调用方 JSON.stringify，两方向不对称是有意的）。
 */
export interface ModelStreamToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
  /** Opaque provider data (Gemini thought signature) replayed with the call. */
  readonly thoughtSignature?: string;
}

/** 系统提示消息。 */
export interface ModelStreamSystemMessage {
  readonly role: 'system';
  readonly content: ModelStreamSystemContent;
}

/** 用户消息。 */
export interface ModelStreamUserMessage {
  readonly role: 'user';
  readonly content: ModelStreamUserContent;
}

/** assistant 消息；发起过工具调用时以 toolCalls 携带历史（协议映射为 tool_calls）。 */
export interface ModelStreamAssistantMessage {
  readonly role: 'assistant';
  readonly content: ModelStreamAssistantContent;
  readonly toolCalls?: readonly ModelStreamToolCall[];
}

/** 工具结果回填消息；协议上必须紧跟对应的 assistant tool_calls 消息。 */
export interface ModelStreamToolResultMessage {
  readonly role: 'tool';
  /** 对应 assistant.toolCalls[] 里那次的 id，协议映射时回填 tool_call_id。 */
  readonly toolCallId: string;
  readonly content: ModelStreamToolResultContent;
  /** 工具执行失败；content 为错误描述。 */
  readonly isError?: boolean;
}

export type ModelStreamMessage =
  | ModelStreamSystemMessage
  | ModelStreamUserMessage
  | ModelStreamAssistantMessage
  | ModelStreamToolResultMessage;

/** 协议无关的工具声明；parameters 是该工具入参的 JSON Schema。 */
export interface ModelStreamTool {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
}

/** 工具选择策略；具名形态表示强制调用某个工具。 */
export type ModelToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { readonly name: string };

/** 本次说什么：系统提示、对话历史与工具。 */
export interface ModelPrompt {
  readonly messages: readonly ModelStreamMessage[];
  readonly tools?: readonly ModelStreamTool[];
  /** 工具选择策略；缺省 'auto' 语义由服务端默认。 */
  readonly toolChoice?: ModelToolChoice;
}

export interface ModelExecutionControl {
  readonly signal?: AbortSignal;
}

/**
 * 一次推理调用的协议无关输入：select 的结果 + 本次对话内容 + 取消。
 *
 * 只承载协议无关的领域字段；协议映射由各 ModelTransport 实现。
 * 商业化字段（身份/路由/补丁/计费）由产品包的
 * QoderModelStreamRequest 扩展承载。
 */
export interface ModelStreamRequest {
  /** select 的结果，原样传入；config 不得再改写。 */
  readonly resolution: ModelSelection;
  readonly prompt: ModelPrompt;
  readonly control?: ModelExecutionControl;
}
