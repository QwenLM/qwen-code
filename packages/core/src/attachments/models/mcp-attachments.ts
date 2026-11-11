/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseAttachment } from './base-attachment.js';
import type { ModelStreamUserMessage } from '../../provider/modelStreamRequest.js';
import { applyNameDelta } from '../restore-context-helpers.js';
import type {
  AttachmentData,
  AttachmentToolUseContext,
} from '../types.js';
import { systemReminder } from '../message-helpers.js';
import { userMessage } from '../message-helpers.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Delta update to MCP server instructions.
 */
export class McpInstructionsDeltaAttachment extends BaseAttachment {
  readonly type = 'mcp_instructions_delta' as const;
  declare addedNames: string[];
  declare addedBlocks: string[];
  declare removedNames: string[];

  constructor(data: AttachmentData<McpInstructionsDeltaAttachment>) {
    super(data);
  }

  override restoreAttachmentContext(ctx: AttachmentToolUseContext): void {
    applyNameDelta(
      ctx.announcedMcpInstructionServers,
      this.addedNames,
      this.removedNames,
    );
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    const parts: string[] = [];
    if (this.addedBlocks.length > 0) {
      parts.push(
        `# MCP Server Instructions\n\n` +
          `The following MCP servers have provided instructions for how to use their tools and resources:\n\n` +
          this.addedBlocks.join('\n\n'),
      );
    }
    if (this.removedNames.length > 0) {
      parts.push(
        `The following MCP servers have disconnected. Their instructions above no longer apply:\n` +
          this.removedNames.join('\n'),
      );
    }
    if (parts.length === 0) return [];
    return [systemReminder(parts.join('\n\n'))];
  }
}

/**
 * Lazy MCP tool catalog: the full catalog when `isInitial`, otherwise only
 * the tools added or removed since the previous one. The name lists restore
 * the announced set on resume; `content` is the rendered reminder.
 */
export class McpLazyToolsDeltaAttachment extends BaseAttachment {
  readonly type = 'mcp_lazy_tools_delta' as const;
  declare content: string;
  declare isInitial: boolean;
  declare addedNames: string[];
  declare removedNames: string[];

  constructor(data: AttachmentData<McpLazyToolsDeltaAttachment>) {
    super(data);
  }

  override restoreAttachmentContext(ctx: AttachmentToolUseContext): void {
    if (this.isInitial === true) ctx.announcedLazyMcpTools.clear();
    applyNameDelta(
      ctx.announcedLazyMcpTools,
      this.addedNames,
      this.removedNames,
    );
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    return this.content ? [systemReminder(this.content)] : [];
  }
}

/**
 * Content from an MCP resource (via @server:uri mention).
 */
export class McpResourceAttachment extends BaseAttachment {
  readonly type = 'mcp_resource' as const;
  declare server: string;
  declare uri: string;
  declare name: string;
  declare description?: string;
  declare content: ReadResourceResult;

  constructor(data: AttachmentData<McpResourceAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    const contents = this.content.contents ?? [];
    const contentText = contents
      .map((item) => {
        if ('text' in item && typeof item.text === 'string') return item.text;
        if ('blob' in item && typeof item.blob === 'string') {
          return `[Binary content: ${item.mimeType ?? 'application/octet-stream'}]`;
        }
        return '[Unsupported resource content]';
      })
      .join('\n\n');
    return [
      userMessage(
        `MCP Resource from ${this.server} — ${this.name}` +
          ` (${this.uri})` +
          (this.description ? ` — ${this.description}` : '') +
          `:\n${contentText || '[No resource content returned]'}`,
      ),
    ];
  }
}
