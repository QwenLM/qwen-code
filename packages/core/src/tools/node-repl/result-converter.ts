/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part, PartListUnion } from '@google/genai';
import { CHARS_PER_TOKEN } from '../../services/tokenEstimation.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import { ToolErrorType } from '../tool-error.js';
import { MAX_TERMINAL_IMAGE_BYTES, type ToolResult } from '../tools.js';
import type {
  NodeReplExecOutcome,
  NodeReplImageEvent,
  NodeReplTextEvent,
} from './kernel-manager.js';

export const MAX_MODEL_TEXT_TOKENS = 10_000;
export const MAX_MODEL_TEXT_CHARS = MAX_MODEL_TEXT_TOKENS * CHARS_PER_TOKEN;
export const MAX_META_OR_ERROR_CHARS = 16 * 1024;

const debugLogger = createDebugLogger('NODE_REPL');

const ALLOWED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function sniffMime(bytes: Buffer): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function validateImage(
  image: NodeReplImageEvent,
): { ok: true } | { ok: false; reason: string } {
  if (!ALLOWED_IMAGE_MIMES.has(image.mimeType)) {
    return { ok: false, reason: `unsupported image MIME ${image.mimeType}` };
  }
  if (
    image.data.length === 0 ||
    image.data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)
  ) {
    return { ok: false, reason: 'invalid base64 image payload' };
  }
  const bytes = Buffer.from(image.data, 'base64');
  if (bytes.length === 0) return { ok: false, reason: 'empty image payload' };
  if (bytes.length > MAX_TERMINAL_IMAGE_BYTES) {
    return {
      ok: false,
      reason: `image exceeds ${MAX_TERMINAL_IMAGE_BYTES} bytes`,
    };
  }
  const sniffed = sniffMime(bytes);
  if (sniffed !== image.mimeType) {
    return {
      ok: false,
      reason: `image bytes are ${sniffed ?? 'unknown'} but declared ${image.mimeType}`,
    };
  }
  return { ok: true };
}

function renderText(event: NodeReplTextEvent): string {
  if (event.kind === 'console') {
    const level = event.level ?? 'log';
    return level === 'log' || level === 'info'
      ? event.text
      : `[${level}] ${event.text}`;
  }
  if (event.kind === 'stdout' || event.kind === 'stderr') {
    return `[${event.kind}] ${event.text}`;
  }
  return event.text;
}

function capChars(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function pushText(parts: Part[], text: string): void {
  if (text.length === 0) return;
  const previous = parts.at(-1);
  if (previous?.text !== undefined) {
    previous.text += text;
  } else {
    parts.push({ text });
  }
}

function modelContent(parts: Part[]): PartListUnion {
  const hasNonText = parts.some((part) => part.inlineData !== undefined);
  if (hasNonText) return parts;
  return parts.map((part) => part.text ?? '').join('');
}

export function convertOutcomeToToolResult(
  outcome: NodeReplExecOutcome,
): ToolResult {
  const parts: Part[] = [];
  const truncationNotice = `[node_repl text truncated near ${MAX_MODEL_TEXT_TOKENS} estimated tokens]\n`;
  const droppedImagesNotice =
    outcome.imagesDropped > 0
      ? `[${outcome.imagesDropped} image(s) dropped by the raw sanity limit]\n`
      : '';
  let metadataNotice = '';
  if (outcome.responseMeta && Object.keys(outcome.responseMeta).length > 0) {
    let metadata = '(not JSON-serializable)';
    try {
      metadata = capChars(
        JSON.stringify(outcome.responseMeta),
        MAX_META_OR_ERROR_CHARS,
      );
    } catch {
      // Keep the fallback.
    }
    metadataNotice = `[responseMeta] ${metadata}\n`;
  }
  let errorText: string | undefined;
  let errorNotice = '';
  if (outcome.status !== 'ok') {
    const error = outcome.error ?? {
      name: 'Error',
      message: `node_repl execution ${outcome.status}`,
    };
    errorText = `${capChars(error.name, 1024)}: ${capChars(error.message, MAX_META_OR_ERROR_CHARS)}`;
    if (outcome.status === 'error' && error.stack) {
      errorText += `\n${capChars(error.stack, 2048)}`;
    }
    errorNotice = `${errorText}\n`;
  }
  const reservedTextChars =
    truncationNotice.length +
    droppedImagesNotice.length +
    metadataNotice.length +
    errorNotice.length;
  let remainingTextChars = Math.max(
    0,
    MAX_MODEL_TEXT_CHARS - reservedTextChars,
  );
  let textWasTruncated = false;
  let validImages = 0;

  const addBudgetedText = (text: string) => {
    if (text.length === 0) return;
    const withSeparator = text.endsWith('\n') ? text : `${text}\n`;
    if (remainingTextChars <= 0) {
      textWasTruncated = true;
      return;
    }
    if (withSeparator.length <= remainingTextChars) {
      pushText(parts, withSeparator);
      remainingTextChars -= withSeparator.length;
      return;
    }
    pushText(parts, withSeparator.slice(0, remainingTextChars));
    remainingTextChars = 0;
    textWasTruncated = true;
  };

  for (const event of outcome.events) {
    if (event.type === 'text') {
      addBudgetedText(renderText(event));
      continue;
    }
    const verdict = validateImage(event);
    if (!verdict.ok) {
      addBudgetedText(`[image rejected: ${verdict.reason}]`);
      continue;
    }
    validImages++;
    parts.push({
      inlineData: { mimeType: event.mimeType, data: event.data },
    });
  }

  if (textWasTruncated || outcome.rawTextTruncated) {
    debugLogger.debug(
      `[node-repl] model text truncated (generation=${outcome.stats.generation}, pid=${outcome.stats.pid ?? 'none'}, modelBudgetTokens=${MAX_MODEL_TEXT_TOKENS}, rawTextTruncated=${outcome.rawTextTruncated})`,
    );
    pushText(parts, truncationNotice);
  }
  pushText(parts, droppedImagesNotice);
  pushText(parts, metadataNotice);
  pushText(parts, errorNotice);

  if (outcome.status === 'ok' && parts.length === 0) {
    pushText(parts, '(no output)\n');
  }

  const llmContent = modelContent(parts);
  const displayText = parts
    .map((part) => part.text ?? '')
    .join('')
    .trim();
  const displaySuffix =
    validImages > 0
      ? `${displayText ? '\n' : ''}[${validImages} image(s)]`
      : '';
  const displayLimit = 8 * 1024;
  const displayTextLimit = Math.max(0, displayLimit - displaySuffix.length);
  const cappedDisplayText =
    displayText.length <= displayTextLimit
      ? displayText
      : `${displayText.slice(0, Math.max(0, displayTextLimit - 1))}…`;
  const display = `${cappedDisplayText}${displaySuffix}` || '(no output)';

  if (outcome.status === 'ok') {
    return { llmContent, returnDisplay: display };
  }
  return {
    llmContent,
    returnDisplay: `Error (${outcome.status}): ${display}`,
    error: {
      message: errorText ?? `node_repl execution ${outcome.status}`,
      type:
        outcome.status === 'timeout'
          ? ToolErrorType.EXECUTION_TIMEOUT
          : ToolErrorType.EXECUTION_FAILED,
    },
  };
}
