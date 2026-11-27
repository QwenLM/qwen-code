/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AttachmentData,
  AttachmentToolUseContext,
} from '../types.js';
import type { ModelStreamUserMessage } from '../../provider/modelStreamRequest.js';
import type { TranscriptAttachment } from '../../protocol/transcript/message.js';

/** Attachment instances contain transcript data; behavior stays on the prototype. */
export abstract class BaseAttachment {
  abstract readonly type: string;

  protected constructor(data: object) {
    for (const [key, value] of Object.entries(data)) {
      // Persisted fields must never replace the class discriminator or methods.
      if (key === 'type' || key === '__proto__' || key in this) continue;
      Object.defineProperty(this, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }

  abstract toUserMessages(): ModelStreamUserMessage[];

  /** Replays context effects using the message cwd, or ctx.cwd when omitted. */
  restoreAttachmentContext(
    _ctx: AttachmentToolUseContext,
    _cwd?: string,
  ): void {}

  toTranscript(): AttachmentData<this> & TranscriptAttachment {
    // The concrete class fixes the discriminator; only own data is copied.
    return { ...this } as unknown as AttachmentData<this> &
      TranscriptAttachment;
  }

  prepareForTranscript(): BaseAttachment {
    return this;
  }

  static fromTranscript<TData, TAttachment extends BaseAttachment>(
    this: new (data: TData) => TAttachment,
    data: TData,
  ): TAttachment {
    return new this(data);
  }
}
