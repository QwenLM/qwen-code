/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createDebugLogger } from './debug-log.js';
import {
  estimateTextTokenUnits,
  TOKEN_ESTIMATE_UNITS_PER_TOKEN,
} from './tokenizer.js';
import type {
  NodeReplExecOutcome,
  NodeReplImageEvent,
  NodeReplTextEvent,
} from './kernel-manager.js';

export const MAX_MODEL_TEXT_TOKENS = 10_000;
export const MAX_ERROR_CHARS = 16 * 1024;
/** Per-image decoded-byte ceiling. */
export const MAX_MODEL_IMAGE_BYTES = 4 * 1024 * 1024;
/** Aggregate ceilings so one result cannot be tens of MB of JSON on stdout. */
export const MAX_MODEL_IMAGES = 8;
export const MAX_MODEL_IMAGE_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_MODEL_TEXT_UNITS =
  MAX_MODEL_TEXT_TOKENS * TOKEN_ESTIMATE_UNITS_PER_TOKEN;

const debugLogger = createDebugLogger('NODE_REPL');

const ALLOWED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** MCP content block union we produce (text + image). */
type TextBlock = { type: 'text'; text: string };
type ImageBlock = { type: 'image'; data: string; mimeType: string };
type OutputBlock = TextBlock | ImageBlock;

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
): { ok: true; byteLength: number } | { ok: false; reason: string } {
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
  if (bytes.length > MAX_MODEL_IMAGE_BYTES) {
    return {
      ok: false,
      reason: `image exceeds ${MAX_MODEL_IMAGE_BYTES} bytes`,
    };
  }
  const sniffed = sniffMime(bytes);
  if (sniffed !== image.mimeType) {
    return {
      ok: false,
      reason: `image bytes are ${sniffed ?? 'unknown'} but declared ${image.mimeType}`,
    };
  }
  return { ok: true, byteLength: bytes.length };
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
  if (text.length <= limit) return text;
  let end = limit;
  // Never split a surrogate pair.
  const code = text.charCodeAt(end - 1);
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
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

/** Append text to the trailing text block, coalescing consecutive text. */
function pushText(blocks: OutputBlock[], text: string): void {
  if (text.length === 0) return;
  const previous = blocks.at(-1);
  if (previous && previous.type === 'text') {
    previous.text += text;
  } else {
    blocks.push({ type: 'text', text });
  }
}

/**
 * Converts a kernel execution outcome into an MCP CallToolResult:
 * text + image content blocks, with a ~10k-token text budget, base64/MIME image
 * validation, and status folded into `isError` plus a leading status text block
 * (MCP has no first-class error-type or display/model split).
 */
export function convertOutcomeToMcpResult(
  outcome: NodeReplExecOutcome,
): CallToolResult {
  const blocks: OutputBlock[] = [];
  const truncationNotice = `[node_repl text truncated near ${MAX_MODEL_TEXT_TOKENS} estimated tokens]\n`;
  const droppedImagesNotice =
    outcome.imagesDropped > 0
      ? `[${outcome.imagesDropped} image(s) dropped by the raw sanity limit]\n`
      : '';

  let errorText: string | undefined;
  let statusNotice = '';
  if (outcome.status !== 'ok') {
    const error = outcome.error ?? {
      name: 'Error',
      message: `node_repl execution ${outcome.status}`,
    };
    errorText = `${capChars(error.name, 1024)}: ${capChars(error.message, MAX_ERROR_CHARS)}`;
    if (outcome.status === 'error' && error.stack) {
      errorText += `\n${capChars(error.stack, 2048)}`;
    }
    // Preserve the 5-way status that MCP's boolean isError would otherwise lose.
    statusNotice = `[node_repl ${outcome.status}] ${errorText}\n`;
  }

  const noticeSeparators = '\n\n\n';
  // Reserve for a worst-case "images omitted" notice too, so emitting it cannot
  // push the result past the token budget (notices bypass addBudgetedText).
  const imagesOmittedNoticeReserve =
    '[999 image(s) omitted: model image budget exceeded]\n';
  const fixedNoticeUnits = estimateTextTokenUnits(
    truncationNotice +
      droppedImagesNotice +
      imagesOmittedNoticeReserve +
      noticeSeparators,
  );
  const cappedStatusNotice = capTextToTokenUnits(
    statusNotice,
    Math.max(0, MAX_MODEL_TEXT_UNITS - fixedNoticeUnits),
  );
  const reservedTextUnits =
    fixedNoticeUnits + estimateTextTokenUnits(cappedStatusNotice.text);
  let remainingTextUnits = Math.max(
    0,
    MAX_MODEL_TEXT_UNITS - reservedTextUnits,
  );
  let textWasTruncated = cappedStatusNotice.truncated;
  let validImages = 0;

  const addBudgetedText = (text: string) => {
    if (text.length === 0) return;
    if (remainingTextUnits <= 0) {
      textWasTruncated = true;
      return;
    }
    const taken = takeTextWithinTokenUnits(text, remainingTextUnits);
    pushText(blocks, taken.text);
    if (taken.complete) {
      remainingTextUnits -= taken.units;
    } else {
      // Budget is spent: saturate so later events hit the fast path instead of
      // re-running a binary search that can only yield an empty prefix.
      remainingTextUnits = 0;
      textWasTruncated = true;
    }
  };

  const pushNotice = (notice: string) => {
    if (notice.length === 0) return;
    const previous = blocks.at(-1);
    if (previous && previous.type === 'text' && !previous.text.endsWith('\n')) {
      pushText(blocks, '\n');
    }
    pushText(blocks, notice);
  };

  // The status notice leads the output so the model sees the failure first.
  pushNotice(cappedStatusNotice.text);

  let imageBytesEmitted = 0;
  let imagesOverBudget = 0;

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
    // Aggregate budget: one tool result must not become tens of MB of JSON.
    if (
      validImages >= MAX_MODEL_IMAGES ||
      imageBytesEmitted + verdict.byteLength > MAX_MODEL_IMAGE_TOTAL_BYTES
    ) {
      imagesOverBudget++;
      continue;
    }
    validImages++;
    imageBytesEmitted += verdict.byteLength;
    blocks.push({ type: 'image', data: event.data, mimeType: event.mimeType });
  }

  if (textWasTruncated || outcome.rawTextTruncated) {
    debugLogger.debug(
      `[node-repl] model text truncated (generation=${outcome.stats.generation}, pid=${outcome.stats.pid ?? 'none'}, modelBudgetTokens=${MAX_MODEL_TEXT_TOKENS}, rawTextTruncated=${outcome.rawTextTruncated})`,
    );
    pushNotice(truncationNotice);
  }
  pushNotice(droppedImagesNotice);
  if (imagesOverBudget > 0) {
    pushNotice(
      `[${imagesOverBudget} image(s) omitted: model image budget exceeded]\n`,
    );
  }

  const content: OutputBlock[] =
    blocks.length > 0
      ? blocks
      : [
          {
            type: 'text',
            text: '[node_repl ok — no output; use nodeRepl.write(value) to return a value]',
          },
        ];
  const result: CallToolResult = {
    content: content as CallToolResult['content'],
  };
  if (outcome.status !== 'ok') {
    result.isError = true;
  }
  return result;
}
