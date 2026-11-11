/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Lazy MCP tool catalog reminder.
 *
 * 首次（或 compact、resume 丢失基线后）发送完整目录，之后只在工具集变化时
 * 发送增删；无变化不发送。增量比完整目录还长时改发完整目录。已告知集合
 * 记录全部已发现工具（而非目录中展示的部分），并由 transcript-state 在
 * resume / fork 时从附件回放。
 * 按 Agent 注册表选择 CodeMode 脚本发现或 MCP 元工具提示。
 */

import type {
  AttachmentToolUseContext,
  AttachmentExternalContext,
} from '../types.js';
import { McpLazyToolsDeltaAttachment } from '../models/mcp-attachments.js';
import {
  buildLazyMcpCatalogText,
  buildLazyMcpDeltaText,
} from '../../tools/mcp-lazy/tool-list-text.js';
import { runLogger } from '../../utils/runLogger.js';

export function getLazyMcpReminderAttachments(
  ctx: AttachmentToolUseContext,
  externalContext?: AttachmentExternalContext,
): McpLazyToolsDeltaAttachment[] {
  const snapshot =
    externalContext?.mcpClientManager?.getLazyMcpServerSnapshot?.() ?? null;
  if (snapshot === null) return [];

  const announced = ctx.announcedLazyMcpTools;
  const current = new Set(snapshot.flatMap((server) => server.toolNames));
  const added = [...current].filter((name) => !announced.has(name)).sort();
  const removed = [...announced].filter((name) => !current.has(name)).sort();
  if (added.length === 0 && removed.length === 0) return [];

  const registry = externalContext?.toolRegistry ?? ctx.config?.getToolRegistry();
  const options = {
    codeMode: registry?.getCodeModeExposure?.() !== undefined,
  };
  const catalog = buildLazyMcpCatalogText(snapshot, options);
  const delta =
    announced.size > 0
      ? buildLazyMcpDeltaText(snapshot, added, removed, options)
      : null;
  const isInitial =
    catalog !== null && (delta === null || catalog.length <= delta.length);
  const content = isInitial ? catalog : delta;
  if (!content) return [];

  runLogger.log(
    `[MCP LazyDelta] ${isInitial ? 'catalog' : 'delta'} added=${added.length} removed=${removed.length}`,
  );
  announced.clear();
  for (const name of current) announced.add(name);

  return [
    new McpLazyToolsDeltaAttachment({
      type: 'mcp_lazy_tools_delta',
      content,
      isInitial,
      addedNames: isInitial ? [...current].sort() : added,
      removedNames: isInitial ? [] : removed,
    }),
  ];
}

/**
 * Forget the announced catalog so the next reminder re-sends it in full.
 * Called from post-compact finalization.
 */
export function resetLazyMcpReminderState(ctx: AttachmentToolUseContext): void {
  if (ctx.announcedLazyMcpTools.size === 0) return;
  runLogger.log(
    `[MCP LazyDelta] Reset — clearing ${ctx.announcedLazyMcpTools.size} announced tool(s) (post-compaction).`,
  );
  ctx.announcedLazyMcpTools.clear();
}
