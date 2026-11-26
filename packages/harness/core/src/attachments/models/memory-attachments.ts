/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseAttachment } from './base-attachment.js';
import type { ModelStreamUserMessage } from '../../provider/modelStreamRequest.js';
import type {
  AttachmentData,
  AttachmentToolUseContext,
} from '../types.js';
import { systemReminder } from '../message-helpers.js';

/**
 * Newly discovered memory files since last turn (JIT / delta).
 * Emitted when new AGENTS.md files are discovered during file access.
 * Startup memory (global/plugin/project/local) is no longer emitted as
 * attachments — it is injected ephemerally via prependUserContext().
 */
export class RelevantMemoriesAttachment extends BaseAttachment {
  readonly type = 'relevant_memories' as const;
  declare files: Array<{
    filePath: string;
    content: string;
    memoryType: string;
  }>;

  constructor(data: AttachmentData<RelevantMemoriesAttachment>) {
    super(data);
  }

  override restoreAttachmentContext(ctx: AttachmentToolUseContext): void {
    const files = Array.isArray(this.files) ? this.files : [];
    for (const file of files) {
      if (!file || typeof file !== 'object') continue;
      if (typeof file.filePath === 'string') {
        ctx.loadedNestedMemoryPaths.add(file.filePath);
      }
    }
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    if (this.files.length === 0) return [];
    const sections = this.files
      .map((f) => `Memory: ${f.filePath}:\n\n${f.content}`)
      .join('\n\n');
    return [systemReminder(sections)];
  }
}

/**
 * Session memory snapshot from the compression pipeline.
 * Contains the markdown summary produced by the session memory background fork.
 * Uses delta logic: only emitted when the snapshot changes.
 */
/** Legacy transcript payload. Retained for reading older sessions; no runtime producer. */
export class CurrentSessionMemoryAttachment extends BaseAttachment {
  readonly type = 'current_session_memory' as const;
  /** Markdown summary produced by the session memory background fork. */
  declare snapshot: string;

  constructor(data: AttachmentData<CurrentSessionMemoryAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    return [systemReminder(this.snapshot)];
  }
}
