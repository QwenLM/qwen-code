/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Rebuilds attachment-generator delta state from durable transcript entries.
 *
 * The transcript is the source of truth for previously emitted context.
 * Restoring generator state prevents resume and fork from appending a second
 * copy of context already present at an earlier message boundary.
 */

import { addLineNumbers, stripLineNumberPrefix } from '../utils/lineNumbers.js';
import { readFileWithMetadata } from '../utils/fileWriteUtils.js';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  normalizeFileStateContent,
  type FileStateCache,
  type FileState,
} from '../utils/fileStateCache.js';
import {
  resolveToolName,
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  EDIT_TOOL_NAME,
} from '../tools/tool-names.js';
import type { Message } from '../protocol/transcript/message.js';
import { isWellFormedAttachmentPayload } from '../protocol/transcript/message-utils.js';
import {
  cellContentToText,
  cellOutputToText,
  type NotebookCellSource,
} from '../utils/notebook.js';
import { restoreAttachment } from './transcript-conversion.js';
import { attachmentReadMetadata } from './restore-context-helpers.js';
import { sha1 } from '../utils/paths.js';
export { sessionStartHookOutputFingerprint } from './restore-context-helpers.js';
import type { SkillManager } from '../skills/skillManager.js';
import type {
  PostCompactRestoredFilesAttachment,
  AttachmentMessage,
  AttachmentToolUseContext,
} from './types.js';

export function restoreAttachmentTranscriptState(
  ctx: AttachmentToolUseContext,
  messages: readonly Message[],
): void {
  restoreToolFileReadState(ctx.fileReadState, messages, ctx.cwd);
  ctx.sentSkillNames.clear();
  ctx.announcedMcpInstructionServers.clear();
  ctx.announcedLazyMcpTools.clear();
  ctx.announcedAgentTypes.clear();
  ctx.announcedAgentDescriptions?.clear();
  ctx.loadedNestedMemoryPaths.clear();
  ctx.seenSessionStartHookOutputs.clear();
  ctx.lastSubagentHash = undefined;
  ctx.lastDateSeen = undefined;
  ctx.postCompactCandidates = null;
  ctx.postCompactPlanAttachment = null;
  ctx.pendingPostCompactDeltaAttachments = null;

  for (const message of messages) {
    if (message.type !== 'attachment') continue;
    const attachment = restoreAttachment(message.attachment);
    attachment?.restoreAttachmentContext(ctx, message.cwd);
  }
}

/**
 * Restores the invoked Skill body cache persisted by compaction.
 *
 * Resuming a session restores only durable activation state. It does not run
 * the Skill again, register hooks, or record a new invocation.
 */
export function restoreInvokedSkillsFromTranscript(
  skillManager: Pick<
    SkillManager,
    'activateSkill' | 'clearInvokedSkillsForAgent'
  >,
  messages: readonly Message[],
  agentId: string = 'main',
): void {
  skillManager.clearInvokedSkillsForAgent(agentId);
  for (const message of messages) {
    if (message.type !== 'attachment') continue;
    if (!isWellFormedAttachmentPayload(message.attachment)) continue;
    if (message.attachment.type !== 'invoked_skills') continue;

    const skills = message.attachment['skills'];
    if (!Array.isArray(skills)) continue;
    for (const value of skills) {
      if (!value || typeof value !== 'object') continue;
      const skill = value as Record<string, unknown>;
      if (!isString(skill['name']) || !isString(skill['content'])) {
        continue;
      }
      skillManager.activateSkill(skill['name'], skill['content'], agentId);
    }
  }
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Captures the announcement baselines that generators advance while building
 * attachments. The returned function restores them in place for paths that
 * discard those attachments before they reach history.
 */
export function snapshotAttachmentDeltaState(
  ctx: AttachmentToolUseContext,
): (delivered?: readonly AttachmentMessage[]) => void {
  const lazyMcpTools = new Set(ctx.announcedLazyMcpTools);
  const mcpInstructionServers = new Set(ctx.announcedMcpInstructionServers);
  const agentTypes = new Set(ctx.announcedAgentTypes);
  const agentDescriptions = ctx.announcedAgentDescriptions
    ? new Map(ctx.announcedAgentDescriptions)
    : undefined;
  const skillNames = new Map(
    [...ctx.sentSkillNames].map(([scope, names]) => [scope, new Set(names)]),
  );
  const skillListingFingerprints = ctx.sentSkillListingFingerprints
    ? new Map(ctx.sentSkillListingFingerprints)
    : undefined;
  const pending = ctx.pendingPostCompactDeltaAttachments;
  const deferredPostCompactDeltas = pending ? [...pending] : pending;
  return (delivered = []) => {
    const generatedAgentDescriptions = ctx.announcedAgentDescriptions
      ? new Map(ctx.announcedAgentDescriptions)
      : undefined;
    ctx.pendingPostCompactDeltaAttachments = deferredPostCompactDeltas
      ? [...deferredPostCompactDeltas]
      : deferredPostCompactDeltas;
    replaceSet(ctx.announcedLazyMcpTools, lazyMcpTools);
    replaceSet(ctx.announcedMcpInstructionServers, mcpInstructionServers);
    replaceSet(ctx.announcedAgentTypes, agentTypes);
    if (agentDescriptions) {
      ctx.announcedAgentDescriptions ??= new Map();
      ctx.announcedAgentDescriptions.clear();
      for (const [name, description] of agentDescriptions)
        ctx.announcedAgentDescriptions.set(name, description);
    } else {
      ctx.announcedAgentDescriptions?.clear();
    }
    ctx.sentSkillNames.clear();
    for (const [scope, names] of skillNames)
      ctx.sentSkillNames.set(scope, new Set(names));
    ctx.sentSkillListingFingerprints = skillListingFingerprints
      ? new Map(skillListingFingerprints)
      : undefined;

    // A batch can stop between attachments. Roll back generation, then replay
    // only the announcements accepted by the host, in their delivery order.
    const remaining = deferredPostCompactDeltas
      ? [...deferredPostCompactDeltas]
      : [];
    for (const message of delivered) {
      const attachment = restoreAttachment(message.attachment);
      if (!attachment) continue;
      const pendingIndex = remaining.findIndex((candidate) =>
        isDeepStrictEqual(
          candidate.prepareForTranscript().toTranscript(),
          message.attachment,
        ),
      );
      const wasDeferred = pendingIndex !== -1;
      if (wasDeferred) remaining.splice(pendingIndex, 1);
      switch (attachment.type) {
        case 'mcp_lazy_tools_delta':
        case 'mcp_instructions_delta':
          attachment.restoreAttachmentContext(ctx);
          break;
        case 'agent_listing_delta': {
          attachment.restoreAttachmentContext(ctx);
          const descriptions = wasDeferred
            ? agentDescriptions
            : generatedAgentDescriptions;
          ctx.announcedAgentDescriptions ??= new Map();
          if (attachment.isInitial) ctx.announcedAgentDescriptions.clear();
          for (const name of attachment.removedTypes ?? [])
            ctx.announcedAgentDescriptions.delete(name);
          for (const name of attachment.addedTypes ?? []) {
            const description = descriptions?.get(name);
            if (description !== undefined)
              ctx.announcedAgentDescriptions.set(name, description);
          }
          break;
        }
        case 'skill_listing': {
          attachment.restoreAttachmentContext(ctx);
          ctx.sentSkillListingFingerprints ??= new Map();
          ctx.sentSkillListingFingerprints.set(
            ctx.agentId ?? 'main',
            sha1(
              `${attachment.isInitial ? 'full' : 'delta'}\u0000${attachment.content}`,
            ),
          );
          break;
        }
        case 'plan_mode':
          // A fresh human-turn plan reminder supersedes the queued copy.
          for (let i = remaining.length - 1; i >= 0; i--)
            if (remaining[i].type === 'plan_mode') remaining.splice(i, 1);
          break;
        default:
          break;
      }
    }
    if (deferredPostCompactDeltas && delivered.length > 0) {
      ctx.pendingPostCompactDeltaAttachments =
        remaining.length > 0 ? remaining : null;
    }
  };
}

function replaceSet(target: Set<string>, values: Iterable<string>): void {
  target.clear();
  for (const value of values) target.add(value);
}

/** Rebuild only baselines supported by retained, successful model history. */
export function restoreToolFileReadState(
  cache: FileStateCache,
  messages: readonly Message[],
  cwd: string,
): void {
  cache.clear();
  const calls = new Map<
    string,
    { name: string; input: Record<string, unknown>; cwd?: string }
  >();
  for (const message of messages) {
    if (message.type !== 'assistant' || !Array.isArray(message.message.content))
      continue;
    for (const block of message.message.content) {
      if (
        block.type === 'tool_use' &&
        block.input &&
        typeof block.input === 'object'
      ) {
        calls.set(block.id, {
          cwd: message.cwd,
          name: resolveToolName(block.name),
          input: block.input as Record<string, unknown>,
        });
      }
    }
  }
  for (const message of messages) {
    if (
      message.type === 'attachment' &&
      isWellFormedAttachmentPayload(message.attachment)
    ) {
      if (message.attachment.type === 'post_compact_restored_files') {
        registerRestoredFileReads(
          cache,
          (message.attachment as unknown as PostCompactRestoredFilesAttachment)
            .files,
        );
      }
      const a = message.attachment as Record<string, unknown>;
      const filename = a['filename'];
      const content = a['content'];
      const mtime = a['mtime'];
      if (
        ['file', 'already_read_file', 'edited_text_file'].includes(
          String(a['type']),
        ) &&
        typeof filename === 'string' &&
        typeof content === 'string' &&
        typeof mtime === 'number' &&
        Number.isFinite(mtime)
      ) {
        const filePath = resolve(message.cwd ?? cwd, filename);
        const isReadReference = a['type'] === 'already_read_file';
        // Keep the preceding baseline, including its range and version. Old
        // standalone notices cannot prove completeness: retain a partial record
        // so they cannot enter Write's missing-record recovery branch.
        if (isReadReference && cache.has(filePath)) continue;
        cache.set(filePath, {
          content: normalizeFileStateContent(content),
          timestamp: mtime,
          ...attachmentReadMetadata(message.attachment),
        });
      }
      continue;
    }
    if (message.type !== 'user' || !Array.isArray(message.message.content))
      continue;
    const results = message.message.content.filter(
      (block) => block.type === 'tool_result',
    );
    for (const [index, result] of results.entries()) {
      if (result.is_error) continue;
      const call = calls.get(result.tool_use_id);
      if (!call) continue;
      const inputPath = call.input['file_path'];
      const inputContent = call.input['content'];
      if (typeof inputPath !== 'string') continue;
      const timestamp = Date.parse(message.timestamp);
      const payload =
        results.length > 1 && Array.isArray(message.toolUseResult)
          ? message.toolUseResult[index]
          : message.toolUseResult;
      const replacementPath = readOutputReplacementPath(
        message,
        index,
        results.length,
      );
      const resultFile =
        payload && typeof payload === 'object' && 'file' in payload
          ? payload.file
          : undefined;
      const resultPath =
        payload && typeof payload === 'object' && 'filePath' in payload
          ? payload.filePath
          : resultFile &&
              typeof resultFile === 'object' &&
              'filePath' in resultFile
            ? resultFile.filePath
            : undefined;
      const filePath = resolve(
        message.cwd ?? call.cwd ?? cwd,
        call.name === READ_FILE_TOOL_NAME && typeof replacementPath === 'string'
          ? replacementPath
          : typeof resultPath === 'string'
            ? resultPath
            : inputPath,
      );
      if (Number.isFinite(timestamp) && call.name === EDIT_TOOL_NAME) {
        try {
          const { content } = readFileWithMetadata(filePath);
          cache.set(filePath, {
            content: normalizeFileStateContent(content),
            timestamp: Math.floor(statSync(filePath).mtimeMs),
            offset: undefined,
            limit: undefined,
            contentNotInModelContext: true,
          });
        } catch {
          /* Missing historical targets are not current read baselines. */
        }
      } else if (
        Number.isFinite(timestamp) &&
        call.name === WRITE_FILE_TOOL_NAME &&
        typeof inputContent === 'string'
      ) {
        const writtenContent =
          payload && typeof payload === 'object' && 'content' in payload
            ? payload.content
            : undefined;
        const actualContent =
          typeof writtenContent === 'string' ? writtenContent : inputContent;
        cache.set(filePath, {
          content: normalizeFileStateContent(actualContent),
          timestamp,
          offset: undefined,
          limit: undefined,
          contentNotInModelContext:
            call.input['modified_by_user'] === true ||
            actualContent !== inputContent,
        });
      } else if (
        Number.isFinite(timestamp) &&
        call.name === READ_FILE_TOOL_NAME
      ) {
        const output =
          typeof result.content === 'string'
            ? result.content
            : Array.isArray(result.content)
              ? result.content
                  .filter((b) => b.type === 'text')
                  .map((b) => b.text)
                  .join('\n')
              : '';
        const state = readFileStateFromResult(
          call.input,
          payload,
          output,
          timestamp,
          replacementPath !== undefined,
        );
        if (state) cache.set(filePath, state);
      }
    }
  }
}

/**
 * Select host metadata without interpreting the hook's replacement payload.
 * Undefined means no replacement; null means malformed metadata whose path
 * cannot be trusted. Both a replacement and malformed metadata require a
 * partial baseline, so malformed history cannot become a full or missing read.
 */
export function readOutputReplacementPath(
  message: { readOutputReplacement?: unknown },
  index: number,
  count: number,
): string | null | undefined {
  let value = message.readOutputReplacement;
  if (value === undefined) return undefined;
  if (count > 1) {
    if (!Array.isArray(value) || value.length !== count) return null;
    value = value[index];
    if (value === null) return undefined;
  }
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Decode a successful Read without treating display text as a disk snapshot. */
export function readFileStateFromResult(
  input: Record<string, unknown>,
  payload: unknown,
  output: string,
  timestamp: number,
  outputReplaced = false,
): FileState | undefined {
  if (!Number.isFinite(timestamp)) return undefined;
  if (outputReplaced)
    return {
      content: '',
      timestamp,
      offset: undefined,
      limit: undefined,
      isPartialView: true,
      contentNotInModelContext: true,
    };
  const file =
    payload && typeof payload === 'object' && 'file' in payload
      ? payload.file
      : undefined;
  if (
    payload &&
    typeof payload === 'object' &&
    'type' in payload &&
    payload.type === 'notebook'
  ) {
    if (
      !file ||
      typeof file !== 'object' ||
      !('cells' in file) ||
      !Array.isArray(file.cells) ||
      !file.cells.every(
        (cell) =>
          cell &&
          typeof cell === 'object' &&
          typeof cell.cell_id === 'string' &&
          typeof cell.cellType === 'string' &&
          typeof cell.source === 'string' &&
          (cell.outputs === undefined ||
            (Array.isArray(cell.outputs) &&
              cell.outputs.every(
                (o: unknown) =>
                  o &&
                  typeof o === 'object' &&
                  'output_type' in o &&
                  typeof o.output_type === 'string' &&
                  (!('text' in o) ||
                    o.text === undefined ||
                    typeof o.text === 'string'),
              ))),
      )
    )
      return undefined;
    const cells = file.cells as NotebookCellSource[];
    const rendered = cells
      .map(
        (cell) =>
          cellContentToText(cell) +
          (cell.outputs ?? []).map(cellOutputToText).join(''),
      )
      .join('\n');
    const visible =
      output === rendered ||
      (rendered !== '' && output.endsWith('\n' + rendered));
    return {
      content: normalizeFileStateContent(JSON.stringify(cells)),
      timestamp,
      offset: 1,
      limit: undefined,
      isPartialView: !visible,
      contentNotInModelContext: !visible,
    };
  }
  const { offset: rawOffset, limit: rawLimit } = input;
  let offset = typeof rawOffset === 'number' ? rawOffset : 1;
  let limit = typeof rawLimit === 'number' ? rawLimit : undefined;
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
  )
    return undefined;
  let unverifiedRange = false;
  if (
    file &&
    typeof file === 'object' &&
    ('startLine' in file || 'numLines' in file || 'totalLines' in file)
  ) {
    const { startLine, numLines, totalLines } = file as Record<string, unknown>;
    if (
      typeof startLine === 'number' &&
      Number.isSafeInteger(startLine) &&
      startLine >= 0 &&
      typeof numLines === 'number' &&
      Number.isSafeInteger(numLines) &&
      numLines >= 0 &&
      typeof totalLines === 'number' &&
      Number.isSafeInteger(totalLines) &&
      totalLines >= 0 &&
      numLines <= Math.max(0, totalLines - Math.max(0, startLine - 1))
    ) {
      // Hooks can change the executed range without changing the model's input.
      // Preserve ordinary request limits when the result still agrees with them.
      const remaining = Math.max(0, totalLines - Math.max(0, offset - 1));
      if (
        startLine !== offset ||
        numLines !== Math.min(limit ?? remaining, remaining)
      ) {
        offset = startLine;
        limit =
          startLine <= 1 && numLines === totalLines
            ? undefined
            : Math.max(1, numLines);
      }
    } else {
      // Incomplete metadata must not turn a known record into missing-state recovery.
      unverifiedRange = true;
    }
  }
  let content =
    file &&
    typeof file === 'object' &&
    'content' in file &&
    typeof file.content === 'string'
      ? file.content
      : undefined;
  if (content === undefined) {
    // Legacy text results: accept only the tool's contiguous numbered format.
    const lines = output.split('\n');
    if (
      !lines.length ||
      !lines.every(
        (line, index) =>
          line.startsWith(`${offset + index}\t`) ||
          line.startsWith(`${offset + index}→`),
      )
    )
      return undefined;
    content = lines.map(stripLineNumberPrefix).join('\n');
  }
  const numbered = addLineNumbers({ content, startLine: offset });
  const visible =
    content === ''
      ? output.includes('file exists but the contents are empty')
      : output === numbered || output.endsWith('\n' + numbered);
  return {
    content: normalizeFileStateContent(content),
    timestamp,
    offset,
    limit,
    isPartialView:
      unverifiedRange ||
      !visible ||
      Boolean(
        file &&
          typeof file === 'object' &&
          'truncatedByTokenCap' in file &&
          file.truncatedByTokenCap === true,
      ),
    contentNotInModelContext: !visible,
  };
}

/** Only called once restored text actually joins the model's context. */
export function registerRestoredFileReads(
  cache: FileStateCache,
  files: PostCompactRestoredFilesAttachment['files'],
): void {
  if (!Array.isArray(files)) return;
  for (const file of files) {
    if (!file || typeof file !== 'object') continue;
    const metadata = file.readState;
    if (
      !metadata ||
      !Number.isFinite(metadata.timestamp) ||
      typeof file.filePath !== 'string' ||
      typeof file.content !== 'string'
    )
      continue;
    if (
      (metadata.offset !== undefined &&
        (!Number.isInteger(metadata.offset) || metadata.offset < 0)) ||
      (metadata.limit !== undefined &&
        (!Number.isInteger(metadata.limit) || metadata.limit < 1))
    )
      continue;
    cache.set(file.filePath, {
      ...metadata,
      content: normalizeFileStateContent(file.content),
      isPartialView: file.truncated || metadata.isPartialView,
      contentNotInModelContext:
        file.truncated || metadata.contentNotInModelContext,
    });
  }
}
