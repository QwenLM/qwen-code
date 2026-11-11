/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ModelReasoningMetadata,
  ModelStreamEvent,
} from '../event/modelStreamEvent.js';
import type {
  ModelCompleteEvent,
  ModelContentBlock,
  ModelMessage,
} from '../event/modelCompleteEvent.js';
import type { ModelStreamAggregator } from './modelStreamAggregator.js';
import { isRecord } from '../../utils/markdownUtils.js';
import type {
  ModelPartialBlock,
  ModelPartialMessage,
} from './modelPartialMessage.js';

/** 聚合器内部的临时接收状态，不作为响应载荷暴露。 */
interface BlockBuffer {
  kind: ModelContentBlock['type'];
  text?: string;
  thinking?: string;
  signature?: string;
  reasoning?: ModelReasoningMetadata;
  data?: string;
  id?: string;
  name?: string;
  inputJson?: string;
  thoughtSignature?: string;
}

/**
 * The one aggregation implementation shared by every transport: feed raw
 * `ModelStreamEvent` primitives, get aggregate completion events and the
 * final `ModelMessage`. Pure state machine — no queue, no iteration; the
 * driver decides when the produced completion events reach consumers.
 */
export class DefaultModelStreamAggregator implements ModelStreamAggregator {
  private messageId = '';
  private model = '';
  private readonly blocks: ModelContentBlock[] = [];
  private readonly openBlocks = new Map<number, BlockBuffer>();
  private readonly pendingToolInputs = new Map<number, string>();
  private stopReason: ModelMessage['stopReason'];
  private usage: ModelMessage['usage'];
  private result: ModelMessage | undefined;

  process(event: ModelStreamEvent): ModelCompleteEvent[] {
    switch (event.type) {
      case 'message_start':
        this.messageId = event.message.id;
        this.model = event.message.model;
        this.usage = event.message.usage;
        return [];
      case 'content_block_start': {
        if (this.pendingToolInputs.has(event.index)) {
          throw new Error(
            'Tool block index reused before pending input was settled',
          );
        }
        const buffer: BlockBuffer = { kind: event.contentBlock.type };
        if (event.contentBlock.type === 'tool_use') {
          buffer.id = event.contentBlock.id;
          buffer.name = event.contentBlock.name;
          buffer.thoughtSignature = event.contentBlock.thoughtSignature;
        }
        if (event.contentBlock.type === 'redacted_thinking') {
          buffer.data = event.contentBlock.data;
        }
        if (
          event.contentBlock.type === 'thinking' ||
          event.contentBlock.type === 'redacted_thinking'
        ) {
          buffer.reasoning = event.contentBlock.reasoning;
        }
        this.openBlocks.set(event.index, buffer);
        return [];
      }
      case 'content_block_delta': {
        const b = this.openBlocks.get(event.index);
        if (!b) return [];
        if (this.pendingToolInputs.has(event.index)) {
          throw new Error('Tool input received after content_block_stop');
        }
        switch (event.delta.type) {
          case 'text_delta':
            b.text = (b.text ?? '') + event.delta.text;
            break;
          case 'thinking_delta':
            b.thinking = (b.thinking ?? '') + event.delta.thinking;
            break;
          case 'signature_delta':
            b.signature = (b.signature ?? '') + event.delta.signature;
            break;
          case 'input_json_delta':
            b.inputJson = (b.inputJson ?? '') + event.delta.partial_json;
            break;
          default:
            break;
        }
        return [];
      }
      case 'message_delta': {
        this.stopReason = event.delta.stopReason;
        if (event.usage) {
          // 未上报字段不擦除开始帧或先前帧的用量，明确的零值仍覆盖。
          this.usage = {
            ...this.usage,
            ...Object.fromEntries(
              Object.entries(event.usage).filter(
                ([, value]) => value !== undefined,
              ),
            ),
          };
        }
        return this.flushPendingToolInputs();
      }
      case 'content_block_stop': {
        const b = this.openBlocks.get(event.index);
        if (!b) return [];
        if (
          event.reasoning !== undefined &&
          (b.kind === 'thinking' || b.kind === 'redacted_thinking')
        ) {
          b.reasoning = event.reasoning;
        }
        const block = this.assemble(b);
        if (block.type === 'tool_use' && block.inputJson !== undefined) {
          const inputJson = closeToolInputContainers(block.inputJson);
          if (
            inputJson !== undefined &&
            (this.stopReason === undefined || this.stopReason === 'tool_use')
          ) {
            // 未确认正常终态时保留原始残片，不把断流补成可执行调用。
            this.pendingToolInputs.set(event.index, inputJson);
            return [];
          }
        }
        return [this.closeBlock(event.index, block)];
      }
      case 'message_stop': {
        const completions = this.flushPendingToolInputs();
        const message = this.getResult();
        return [...completions, { type: 'message_complete', result: message }];
      }
      default:
        return [];
    }
  }

  getResult(): ModelMessage {
    if (this.openBlocks.size > 0) {
      throw new Error('Model stream ended with unclosed content blocks');
    }
    return (this.result ??= structuredClone({
      messageId: this.messageId,
      model: this.model,
      blocks: this.blocks,
      stopReason: this.stopReason,
      usage: this.usage,
    }));
  }

  getPartialResult(): ModelPartialMessage {
    return structuredClone({
      messageId: this.messageId,
      model: this.model,
      blocks: this.blocks,
      openBlocks: new Map(
        [...this.openBlocks].map(([index, buffer]) => [
          index,
          this.assemblePartial(buffer),
        ]),
      ),
      stopReason: this.stopReason,
      usage: this.usage,
    });
  }

  /** @internal 驱动器用同一后缀补齐增量事件，保持其与完成结果一致。 */
  getPendingToolInputSuffix(index: number): string | undefined {
    const inputJson = this.pendingToolInputs.get(index);
    const raw = this.openBlocks.get(index)?.inputJson;
    return inputJson !== undefined && raw !== undefined
      ? inputJson.slice(raw.length)
      : undefined;
  }

  private flushPendingToolInputs(): ModelCompleteEvent[] {
    const completions: ModelCompleteEvent[] = [];
    if (this.stopReason !== undefined) {
      for (const [index, inputJson] of this.pendingToolInputs) {
        const buffer = this.openBlocks.get(index)!;
        const block = this.assemble(
          this.stopReason === 'tool_use' ? { ...buffer, inputJson } : buffer,
        );
        completions.push(this.closeBlock(index, block));
      }
    }
    return completions;
  }

  private closeBlock(
    index: number,
    block: ModelContentBlock,
  ): ModelCompleteEvent {
    this.blocks[index] = block;
    this.openBlocks.delete(index);
    this.pendingToolInputs.delete(index);
    return {
      type: 'content_block_complete',
      index,
      block: structuredClone(block),
    };
  }

  /** 仅投影已收到的内容，不解析未闭合工具参数，也不产生完成事件。 */
  private assemblePartial(b: BlockBuffer): ModelPartialBlock {
    switch (b.kind) {
      case 'text':
        return { type: 'text', text: b.text ?? '' };
      case 'thinking':
        return {
          type: 'thinking',
          thinking: b.thinking ?? '',
          ...(b.signature !== undefined ? { signature: b.signature } : {}),
          ...(b.reasoning !== undefined ? { reasoning: b.reasoning } : {}),
        };
      case 'redacted_thinking':
        return {
          type: 'redacted_thinking',
          data: b.data ?? '',
          ...(b.reasoning !== undefined ? { reasoning: b.reasoning } : {}),
        };
      case 'tool_use':
        return {
          type: 'tool_use',
          id: b.id ?? '',
          name: b.name ?? '',
          ...(b.inputJson !== undefined ? { inputJson: b.inputJson } : {}),
          ...(b.thoughtSignature !== undefined
            ? { thoughtSignature: b.thoughtSignature }
            : {}),
        };
      default:
        throw new Error(`Unknown content block kind: ${String(b.kind)}`);
    }
  }

  /** 仅在关块时解析工具参数，未闭合缓冲不转换为完整块。 */
  private assemble(b: BlockBuffer): ModelContentBlock {
    switch (b.kind) {
      case 'text':
        return { type: 'text', text: b.text ?? '' };
      case 'thinking':
        return {
          type: 'thinking',
          thinking: b.thinking ?? '',
          ...(b.signature !== undefined ? { signature: b.signature } : {}),
          ...(b.reasoning !== undefined ? { reasoning: b.reasoning } : {}),
        };
      case 'redacted_thinking':
        return {
          type: 'redacted_thinking',
          data: b.data ?? '',
          ...(b.reasoning !== undefined ? { reasoning: b.reasoning } : {}),
        };
      case 'tool_use': {
        let input: Record<string, unknown> = {};
        let inputJson: string | undefined;
        if (b.inputJson !== undefined && b.inputJson.trim() !== '') {
          try {
            const parsed: unknown = JSON.parse(b.inputJson);
            if (isRecord(parsed)) {
              input = parsed;
            } else {
              inputJson = b.inputJson;
            }
          } catch {
            inputJson = b.inputJson;
          }
        }
        return {
          type: 'tool_use',
          id: b.id ?? '',
          name: b.name ?? '',
          input,
          ...(inputJson !== undefined ? { inputJson } : {}),
          ...(b.thoughtSignature !== undefined
            ? { thoughtSignature: b.thoughtSignature }
            : {}),
        };
      }
      default:
        throw new Error(`Unknown content block kind: ${String(b.kind)}`);
    }
  }
}

/** 只追加容器闭合符；字符串、字段值和已有正文必须保持完整。 */
function closeToolInputContainers(raw: string): string | undefined {
  const closers: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of raw) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') closers.push('}');
    else if (char === '[') closers.push(']');
    else if (char === '}' || char === ']') {
      if (closers.pop() !== char) return undefined;
    }
  }
  if (inString || closers.length === 0) return undefined;
  const candidate = raw + closers.reverse().join('');
  try {
    if (isRecord(JSON.parse(candidate))) return candidate;
  } catch {
    // 缺少字段值、分隔符等内容时，保留原始解析失败证据。
  }
  return undefined;
}
