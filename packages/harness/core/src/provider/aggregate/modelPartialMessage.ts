/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ModelMessage,
  ModelRedactedThinkingBlock,
  ModelTextBlock,
  ModelThinkingBlock,
  ModelToolUseBlock,
} from '../event/modelCompleteEvent.js';

/** 未闭合文本块中已收到的正文，可为空字符串。 */
export type ModelPartialTextBlock = ModelTextBlock;

/** 未闭合思考块中已收到的内容，签名不保证完整。 */
export type ModelPartialThinkingBlock = ModelThinkingBlock;

/** 未闭合密文思考块中已收到的不透明内容。 */
export type ModelPartialRedactedThinkingBlock = ModelRedactedThinkingBlock;

/** 未闭合工具块；即使参数已是合法 JSON，也不代表可执行调用。 */
export type ModelPartialToolUseBlock = Omit<ModelToolUseBlock, 'input'>;

/** 对应 ModelContentBlock 的残缺内容，不依赖聚合器内部 Buffer。 */
export type ModelPartialBlock =
  | ModelPartialTextBlock
  | ModelPartialThinkingBlock
  | ModelPartialRedactedThinkingBlock
  | ModelPartialToolUseBlock;

/**
 * 流终止后的内容快照，包含已闭合完整块和未闭合残缺块，不作为事件 yield。
 * blocks 按原始 index 保存已闭合完整块，未闭合位置保留数组空位。
 * stopReason 仅保留已收到的停止原因，不表示整轮成功完成。
 */
export interface ModelPartialMessage extends ModelMessage {
  /** 以原始 index 保存未闭合块的标准残缺内容。 */
  readonly openBlocks: ReadonlyMap<number, ModelPartialBlock>;
}
