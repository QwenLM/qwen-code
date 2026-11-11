/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseAttachment } from './base-attachment.js';
import type { ModelImageBlock, ModelInputContentBlock, ModelStreamUserMessage } from '../../provider/modelStreamRequest.js';
import { restoreReadFileState } from '../restore-context-helpers.js';
import type {
  AttachmentData,
  AttachmentToolUseContext,
} from '../types.js';
import { createImageMetadataText } from '../../utils/imageReader.js';
import { READ_FILE_TOOL_NAME } from '../../tools/definitions/base-declarations.js';
import { SHELL_TOOL_NAME } from '../../tools/definitions/base-declarations.js';
import { DEFAULT_MAX_LINES_TEXT_FILE } from '../../utils/constants.js';
import { systemReminder } from '../message-helpers.js';
import { userMessage } from '../message-helpers.js';
import type { ImageDimensions } from '../../utils/imageReader.js';

/**
 * A file that was read (at-mention or from tool call).
 * Normalized as a synthetic FileReadTool use+result pair wrapped in
 * <system-reminder>.
 */
export class FileAttachment extends BaseAttachment {
  readonly type = 'file' as const;
  declare filename: string;
  declare content: string;
  declare truncated?: boolean;
  declare displayPath: string;
  /** File modification time captured when this content entered context. */
  declare mtime?: number;
  /** One-based starting line and requested line count for an explicit range. */
  declare offset?: number;
  declare limit?: number;

  constructor(data: AttachmentData<FileAttachment>) {
    super(data);
  }

  override restoreAttachmentContext(
    ctx: AttachmentToolUseContext,
    cwd?: string,
  ): void {
    restoreReadFileState(ctx, this, this.content, cwd ?? ctx.cwd);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    const pair = syntheticFileReadPair(this);
    const messages = [systemReminder(pair)];
    if (this.truncated) {
      messages.push(truncatedFileNote(this));
    }
    return messages;
  }
}

/**
 * An image file referenced via @mention.
 * Normalized as a synthetic FileReadTool use+result pair wrapped in
 * <system-reminder>.
 */
export class ImageFileAttachment extends BaseAttachment {
  readonly type = 'image_file' as const;
  declare filename: string;
  /** base64-encoded image data. */
  declare base64?: string;
  /** Uploaded image URL. */
  declare url?: string;
  /** MIME type e.g. 'image/jpeg', 'image/png'. */
  declare mediaType: string;
  declare displayPath: string;
  /** Original file size in bytes (before any compression). */
  declare originalSize: number;
  /** File modification time captured when this image entered context. */
  declare mtime?: number;
  /** Resize dimensions — present only when image was scaled down by sharp. */
  declare dimensions?: ImageDimensions;

  constructor(data: AttachmentData<ImageFileAttachment>) {
    super(data);
  }

  override restoreAttachmentContext(
    ctx: AttachmentToolUseContext,
    cwd?: string,
  ): void {
    restoreReadFileState(ctx, this, '', cwd ?? ctx.cwd);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    const imageSource = resolveImageSource(this);
    if (!imageSource) {
      return [];
    }

    // Single user message: system-reminder description + inline image block.
    const content: ModelInputContentBlock[] = [
      {
        type: 'text',
        text: `<system-reminder>\n[tool_use: ${READ_FILE_TOOL_NAME} { path: "${this.filename}" }]\n[tool_result: image attached below]\n</system-reminder>`,
      },
      {
        type: 'image',
        source: imageSource,
      },
    ];

    if (this.dimensions) {
      const metaText = createImageMetadataText(
        this.dimensions,
        this.displayPath,
      );
      if (metaText) {
        content.push({ type: 'text', text: metaText });
      }
    }

    return [{ role: 'user', content }];
  }

  override prepareForTranscript(): ImageFileAttachment {
    if (!this.url) return this;
    const { base64: _base64, ...data } = this;
    return new ImageFileAttachment(data);
  }
}

/**
 * An image file referenced explicitly by the user that could not be decoded.
 * Normalized as a model-visible explanation without an image content block.
 */
export class InvalidImageFileAttachment extends BaseAttachment {
  readonly type = 'invalid_image_file' as const;
  declare filename: string;
  declare displayPath: string;
  declare reason: string;

  constructor(data: AttachmentData<InvalidImageFileAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    return [
      userMessage(
        `The image \`${this.filename}\` was not attached because its pixel data could not be decoded completely. ` +
          `Ask the user to export the original image as a new JPEG or PNG file before trying again. ` +
          `Image processing error: ${this.reason}`,
      ),
    ];
  }
}

/**
 * A file that is already in the LLM context and hasn't changed.
 * NOT sent to the provider (normalizeAttachmentForAPI returns []).
 * Used for deduplication tracking.
 */
export class AlreadyReadFileAttachment extends BaseAttachment {
  readonly type = 'already_read_file' as const;
  declare filename: string;
  declare content: string;
  declare truncated?: boolean;
  declare displayPath: string;
  /** File modification time associated with the cached content. */
  declare mtime?: number;

  constructor(data: AttachmentData<AlreadyReadFileAttachment>) {
    super(data);
  }

  override restoreAttachmentContext(
    ctx: AttachmentToolUseContext,
    cwd?: string,
  ): void {
    restoreReadFileState(ctx, this, this.content, cwd ?? ctx.cwd);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    // Not sent — file already in context and unchanged.
    return [];
  }
}

/**
 * A file that was too large after compact and needs to be re-read.
 * Compact mode fallback when file exceeds token limit.
 * Normalized as a user message advising the model to re-read.
 */
export class CompactFileReferenceAttachment extends BaseAttachment {
  readonly type = 'compact_file_reference' as const;
  declare filename: string;
  declare displayPath: string;

  constructor(data: AttachmentData<CompactFileReferenceAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    return [
      userMessage(
        `Note: The file \`${this.filename}\` was read before context compaction. ` +
          `Please use the FileRead tool to re-read it if needed.`,
      ),
    ];
  }
}

/**
 * A large PDF file — model should use paginated FileReadTool calls.
 * Normalized as a user message with page-count constraints.
 */
export class PDFReferenceAttachment extends BaseAttachment {
  readonly type = 'pdf_reference' as const;
  declare filename: string;
  declare pageCount: number;
  declare fileSize: number;
  // bytes
  declare displayPath: string;

  constructor(data: AttachmentData<PDFReferenceAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    return [
      userMessage(
        `Note: \`${this.filename}\` is a PDF file with ${this.pageCount} pages ` +
          `(${(this.fileSize / 1024).toFixed(1)} KB). ` +
          `Please use the FileRead tool with page range parameters to read specific sections.`,
      ),
    ];
  }
}

/**
 * A small PDF file rendered as page images for @mention inline context.
 * Larger PDFs use PDFReferenceAttachment so the model can read ranges.
 */
export class PDFFileAttachment extends BaseAttachment {
  readonly type = 'pdf_file' as const;
  declare filename: string;
  declare pageCount: number;
  declare fileSize: number;
  // bytes
  declare displayPath: string;
  declare pages: Array<{
    base64?: string;
    url?: string;
    mediaType: string;
  }>;

  constructor(data: AttachmentData<PDFFileAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    return [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              `<system-reminder>\n[tool_use: ${READ_FILE_TOOL_NAME} { path: "${this.filename}" }]\n` +
              `[tool_result: PDF ${this.displayPath} (${(this.fileSize / 1024).toFixed(1)} KB, ${this.pageCount} pages) rendered as page images below]\n</system-reminder>`,
          },
          ...this.pages.flatMap((page) => {
            const source = resolveImageSource(page);
            return source ? [{ type: 'image' as const, source }] : [];
          }),
        ],
      },
    ];
  }

  override prepareForTranscript(): PDFFileAttachment {
    let changed = false;
    const pages = this.pages.map((page) => {
      if (!page.url || page.base64 === undefined) return page;
      changed = true;
      const { base64: _base64, ...rest } = page;
      return rest;
    });
    return changed ? new PDFFileAttachment({ ...this, pages }) : this;
  }
}

/**
 * A text file that was modified externally after the last read.
 * Normalized as: "Note: {file} was modified since last read..."
 */
export class EditedTextFileAttachment extends BaseAttachment {
  readonly type = 'edited_text_file' as const;
  declare filename: string;
  /** Diff snippet or modified content fragment. */
  declare snippet: string;
  declare truncationReason?: 'file' | 'budget' | 'read_limit';
  /** Full content retained in the transcript for resume change detection. */
  declare content?: string;
  /** File modification time captured after detecting the edit. */
  declare mtime?: number;

  constructor(data: AttachmentData<EditedTextFileAttachment>) {
    super(data);
  }

  override restoreAttachmentContext(
    ctx: AttachmentToolUseContext,
    cwd?: string,
  ): void {
    restoreReadFileState(ctx, this, this.content, cwd ?? ctx.cwd);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    // Also covers auto-memory MEMORY.md updates. Those files are seeded into
    // readFileState at startup, so mid-session index writes flow through the
    // ordinary changed-file attachment path instead of a memory-specific type.
    return [
      userMessage(
        `Note: The file \`${this.filename}\` was modified since it was last read.\n` +
          (this.truncationReason === 'read_limit'
            ? 'Changed content was not included because it exceeded the Read size or token limit. Use Read with offset and limit to inspect the file.'
            : `Modified content:\n${this.snippet}` +
              (this.truncationReason
                ? `\nNote: Changes were ${this.snippet ? 'truncated' : 'omitted'} because the ${this.truncationReason === 'budget' ? 'total changed-file injection budget' : 'single-file injection limit'} was reached. This is not the complete file. Use Read with offset and limit to inspect more.`
                : '')),
      ),
    ];
  }
}

/**
 * An image file that was modified externally after the last read.
 * NOT sent to the provider (UI notification only).
 */
export class EditedImageFileAttachment extends BaseAttachment {
  readonly type = 'edited_image_file' as const;
  declare filename: string;
  declare content: string;
  /** File modification time captured after detecting the edit. */
  declare mtime?: number;

  constructor(data: AttachmentData<EditedImageFileAttachment>) {
    super(data);
  }

  override restoreAttachmentContext(
    ctx: AttachmentToolUseContext,
    cwd?: string,
  ): void {
    restoreReadFileState(ctx, this, this.content, cwd ?? ctx.cwd);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    // UI notification only — not sent to provider.
    return [];
  }
}

/**
 * A directory listing (from @mention of a directory path).
 * Normalized as a synthetic Bash ls use+result pair wrapped in
 * <system-reminder>.
 */
export class DirectoryAttachment extends BaseAttachment {
  readonly type = 'directory' as const;
  declare path: string;
  /** Output of ls command. */
  declare content: string;
  declare displayPath: string;

  constructor(data: AttachmentData<DirectoryAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    return [systemReminder(syntheticDirectoryListPair(this))];
  }
}

function syntheticToolPair(
  toolName: string,
  params: string,
  content: string,
): string {
  return `[tool_use: ${toolName} { ${params} }]\n[tool_result: <content>\n${content}\n</content>]`;
}

function syntheticFileReadPair(attachment: FileAttachment): string {
  return syntheticToolPair(
    READ_FILE_TOOL_NAME,
    `path: "${attachment.filename}"` +
      (attachment.offset !== undefined
        ? `, offset: ${attachment.offset}`
        : '') +
      (attachment.limit !== undefined ? `, limit: ${attachment.limit}` : ''),
    attachment.content,
  );
}

function truncatedFileNote(attachment: FileAttachment): ModelStreamUserMessage {
  return userMessage(
    `Note: The file ${attachment.filename} was too large and has been truncated to the first ${DEFAULT_MAX_LINES_TEXT_FILE} lines. ` +
      `Don't tell the user about this truncation. Use ${READ_FILE_TOOL_NAME} to read more of the file if you need.`,
  );
}

function syntheticDirectoryListPair(attachment: DirectoryAttachment): string {
  return syntheticToolPair(
    SHELL_TOOL_NAME,
    `command: "ls -la ${attachment.path}"`,
    attachment.content,
  );
}

function resolveImageSource(item: {
  url?: string;
  base64?: string;
  mediaType: string;
}): ModelImageBlock['source'] | null {
  if (item.url) return { type: 'url', url: item.url };
  if (item.base64)
    return { type: 'base64', mediaType: item.mediaType, data: item.base64 };
  return null;
}
