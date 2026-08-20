/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part, PartListUnion } from '@google/genai';
import { createDebugLogger } from '../../utils/debugLogger.js';
import {
  estimateTextTokenUnits,
  TOKEN_ESTIMATE_UNITS_PER_TOKEN,
} from '../../utils/request-tokenizer/textTokenizer.js';
import { ToolErrorType } from '../tool-error.js';
import { MAX_TERMINAL_IMAGE_BYTES, type ToolResult } from '../tools.js';
import type {
  NodeReplExecOutcome,
  NodeReplImageEvent,
  NodeReplTextEvent,
} from './kernel-manager.js';

export const MAX_MODEL_TEXT_TOKENS = 10_000;
export const MAX_MODEL_TEXT_CHARS = MAX_MODEL_TEXT_TOKENS * 4;
export const MAX_ERROR_CHARS = 16 * 1024;
const MAX_MODEL_TEXT_UNITS =
  MAX_MODEL_TEXT_TOKENS * TOKEN_ESTIMATE_UNITS_PER_TOKEN;

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
    const text =
      level === 'log' || level === 'info'
        ? event.text
        : `[${level}] ${event.text}`;
    return text.endsWith('\n') ? text : `${text}\n`;
  }
  if (event.kind === 'stdout' || event.kind === 'stderr') {
    const text = `[${event.kind}] ${event.text}`;
    return text.endsWith('\n') ? text : `${text}\n`;
  }
  return event.text;
}

function capChars(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function takeTextWithinTokenUnits(
  text: string,
  maxUnits: number,
): { text: string; units: number; complete: boolean } {
  if (maxUnits <= 0 || text.length === 0) {
    return { text: '', units: 0, complete: text.length === 0 };
  }
  const totalUnits = estimateTextTokenUnits(text);
  if (totalUnits <= maxUnits) {
    return { text, units: totalUnits, complete: true };
  }

  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTextTokenUnits(text.slice(0, middle)) <= maxUnits) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  if (
    low > 0 &&
    low < text.length &&
    text.charCodeAt(low - 1) >= 0xd800 &&
    text.charCodeAt(low - 1) <= 0xdbff &&
    text.charCodeAt(low) >= 0xdc00 &&
    text.charCodeAt(low) <= 0xdfff
  ) {
    low--;
  }
  const prefix = text.slice(0, low);
  return {
    text: prefix,
    units: estimateTextTokenUnits(prefix),
    complete: false,
  };
}

function capTextToTokenUnits(
  text: string,
  maxUnits: number,
): { text: string; truncated: boolean } {
  const taken = takeTextWithinTokenUnits(text, maxUnits);
  if (taken.complete) return { text: taken.text, truncated: false };
  const ellipsis = '…';
  const ellipsisUnits = estimateTextTokenUnits(ellipsis);
  if (maxUnits < ellipsisUnits) return { text: taken.text, truncated: true };
  const withRoom = takeTextWithinTokenUnits(text, maxUnits - ellipsisUnits);
  return { text: `${withRoom.text}${ellipsis}`, truncated: true };
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
  let errorText: string | undefined;
  let rawErrorNotice = '';
  if (outcome.status !== 'ok') {
    const error = outcome.error ?? {
      name: 'Error',
      message: `node_repl execution ${outcome.status}`,
    };
    errorText = `${capChars(error.name, 1024)}: ${capChars(error.message, MAX_ERROR_CHARS)}`;
    if (outcome.status === 'error' && error.stack) {
      errorText += `\n${capChars(error.stack, 2048)}`;
    }
    rawErrorNotice = `${errorText}\n`;
  }
  const noticeSeparators = '\n\n\n';
  const fixedNoticeUnits = estimateTextTokenUnits(
    truncationNotice + droppedImagesNotice + noticeSeparators,
  );
  const cappedErrorNotice = capTextToTokenUnits(
    rawErrorNotice,
    Math.max(0, MAX_MODEL_TEXT_UNITS - fixedNoticeUnits),
  );
  const errorNotice = cappedErrorNotice.text;
  const reservedTextUnits =
    fixedNoticeUnits + estimateTextTokenUnits(errorNotice);
  let remainingTextUnits = Math.max(
    0,
    MAX_MODEL_TEXT_UNITS - reservedTextUnits,
  );
  let textWasTruncated = cappedErrorNotice.truncated;
  let validImages = 0;

  const addBudgetedText = (text: string) => {
    if (text.length === 0) return;
    if (remainingTextUnits <= 0) {
      textWasTruncated = true;
      return;
    }
    const taken = takeTextWithinTokenUnits(text, remainingTextUnits);
    pushText(parts, taken.text);
    remainingTextUnits -= taken.units;
    textWasTruncated ||= !taken.complete;
  };

  const pushNotice = (notice: string) => {
    if (notice.length === 0) return;
    const previous = parts.at(-1);
    if (previous?.text !== undefined && !previous.text.endsWith('\n')) {
      pushText(parts, '\n');
    }
    pushText(parts, notice);
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
    pushNotice(truncationNotice);
  }
  pushNotice(droppedImagesNotice);
  pushNotice(errorNotice);

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
