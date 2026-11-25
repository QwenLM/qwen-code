/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseAttachment } from './base-attachment.js';
import type { AttachmentData } from '../types.js';
import type { ModelStreamUserMessage } from '../../provider/modelStreamRequest.js';
import { systemReminder } from '../message-helpers.js';
import type { FileState } from '../../utils/fileStateCache.js';
import { READ_FILE_TOOL_NAME } from '../../tools/tool-names.js';
import type { FileReadResult } from '../../tools/tools.js';
import { addLineNumbers } from '../../utils/lineNumbers.js';
import type { ToolResultContentPart } from '../../tools/tool-result-message.js';

/**
 * Previously read files restored after context compaction.
 * Event-driven: drained from ctx.postCompactCandidates (one-shot per compact).
 * Ported from the disabled runPostCompactRestoreStage_DISABLED in
 * compression-v2/post-compact-finalize.ts.
 */
export class PostCompactRestoredFilesAttachment extends BaseAttachment {
  readonly type = 'post_compact_restored_files' as const;
  declare files: Array<{
    filePath: string;
    content: string;
    truncated: boolean;
    /** The file exceeded restoration limits; no file body joins the context. */
    referenceOnly?: boolean;
    /** Canonical model output and structured payload from the actual Read. */
    formattedContent?: string;
    /** Notebook Read output may contain interleaved text and images. */
    formattedParts?: ToolResultContentPart[];
    readResult?: FileReadResult;
    displayPath?: string;
    /** Metadata for the restored disk read; timestamp is the file's mtime. */
    readState?: Pick<
      FileState,
      | 'timestamp'
      | 'offset'
      | 'limit'
      | 'isPartialView'
      | 'contentNotInModelContext'
    >;
  }>;

  constructor(data: AttachmentData<PostCompactRestoredFilesAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    if (this.files.length === 0) return [];
    return this.files.flatMap((file) => {
      if (file.referenceOnly) return [systemReminder(formatRestoredFile(file))];
      if (file.formattedParts !== undefined) {
        const call = systemReminder(
          `Called the ${READ_FILE_TOOL_NAME} tool with the following input: ${JSON.stringify({ file_path: file.filePath })}`,
        );
        const parts = file.formattedParts;
        // Like a normal synthetic Read result, preserve image blocks instead
        // of JSON-encoding their base64 into model-visible text.
        const result = parts.some((part) => part.type === 'image')
          ? {
              role: 'user' as const,
              content: parts.map((part) =>
                part.type === 'text'
                  ? {
                      ...part,
                      text: `<system-reminder>\n${part.text}\n</system-reminder>`,
                    }
                  : { ...part },
              ),
            }
          : systemReminder(
              `Result of calling the ${READ_FILE_TOOL_NAME} tool:\n${JSON.stringify(parts)}`,
            );
        return [call, result];
      }
      const [call, ...result] = formatRestoredFile(file).split('\n');
      return [systemReminder(call), systemReminder(result.join('\n'))];
    });
  }
}

/** Keep the file wording separate from the unchanged attachment envelope. */
export function formatRestoredFile(
  file: Pick<
    PostCompactRestoredFilesAttachment['files'][number],
    'filePath' | 'content' | 'truncated' | 'referenceOnly' | 'formattedContent'
  >,
): string {
  if (file.referenceOnly) {
    return `Note: ${file.filePath} was read before the last conversation was summarized, but the contents are too large to include. Use ${READ_FILE_TOOL_NAME} tool if you need to access it.`;
  }
  // Legacy transcripts lack formattedContent. Fresh restores always use Read's output.
  const content =
    file.formattedContent ??
    (file.content
      ? addLineNumbers({ content: file.content, startLine: 1 })
      : '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>');
  const pair =
    `Called the ${READ_FILE_TOOL_NAME} tool with the following input: ${JSON.stringify({ file_path: file.filePath })}\n` +
    `Result of calling the ${READ_FILE_TOOL_NAME} tool:\n${content}`;
  return `${pair}${file.truncated ? '\n[Truncated]' : ''}`;
}
