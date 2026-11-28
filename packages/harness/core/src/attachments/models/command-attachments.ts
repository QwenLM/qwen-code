/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseAttachment } from './base-attachment.js';
import type { AttachmentData } from '../types.js';
import type { ModelStreamUserContent, ModelStreamUserMessage } from '../../provider/modelStreamRequest.js';
import { wrapContentByOrigin } from '../../input/origin-content-wrapping.js';
import { deriveOrigin } from '../../input/origin-content-wrapping.js';

/**
 * A command queued for the agent from an external source (SDK, /loop, Bridge).
 * Normalized as a user message containing the command text.
 *
 * 图片输入直接使用标准模型输入内容块。
 */
export class QueuedCommandAttachment extends BaseAttachment {
  readonly type = 'queued_command' as const;
  /** Command text or rich content blocks (e.g. with inlined images). */
  declare prompt: ModelStreamUserContent;
  /** UI-only preview for internal peer messages; ignored by normalization. */
  declare displaySummary?: string;
  /** UI-only teammate color; ignored by normalization. */
  declare displayColor?: string;
  /** Image paste IDs for UI rendering (not used in normalization). */
  declare imagePasteIds?: number[];
  declare source_uuid?: string;
  declare commandMode?: string;
  /** Origin metadata (serialised as string for backward compat, or MessageOrigin object). */
  declare origin?: string | import('../../input/types.js').MessageOrigin;
  declare isMeta?: boolean;
  declare isUserDecision?: boolean;

  constructor(data: AttachmentData<QueuedCommandAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    const wrapped = wrapContentByOrigin(this.prompt, deriveOrigin(this), {
      midTurn: true,
    });
    return [{
      role: 'user',
      content: typeof wrapped === 'string' ? [{ type: 'text', text: wrapped }] : wrapped,
    }];
  }
}
