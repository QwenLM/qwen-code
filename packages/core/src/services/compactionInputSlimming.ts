/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';
import type { ChatCompressionSettings } from '../config/config.js';
import type { InputModalities } from '../core/contentGenerator.js';
import { ToolNames } from '../tools/tool-names.js';
import {
  AUTO_MEMORY_SNAPSHOT_METADATA,
  isWrappedSystemReminderPart,
  SYSTEM_REMINDER_CLOSE,
  SYSTEM_REMINDER_OPEN,
} from '../core/environmentContext.js';
import { isUserPromptSubmitContextPartText } from '../utils/transcript-records.js';
import {
  escapeSystemReminderTags,
  escapeUserMessageTags,
} from '../utils/xml.js';
import {
  ATTACHMENT_PROCESSING_FAILURE_NOTICE,
  EXTENSION_HEADER_PREFIX,
  isTypedPrompt,
  MCP_RESOURCE_HEADER_PREFIX,
  MCP_RESOURCE_NOTE_HEADER_PREFIX,
  MCP_SERVER_HEADER_PREFIX,
  opensAttachedContent,
  REFERENCED_SESSION_HEADER_PREFIX,
} from '../utils/attached-content.js';

/**
 * Prepares `historyToCompress` for the side-query summary model by
 * stripping inline media. `inlineData` / `fileData` parts are replaced
 * with a short `[image: <mime>]` / `[document: <mime>]` placeholder —
 * the summary model usually cannot interpret raw base64 anyway, and
 * shipping the bytes inflates the side-query payload.
 *
 * The function never mutates the input; it returns a fresh `Content[]`
 * (or the identity-equal input when no changes were made).
 */

export const DEFAULT_IMAGE_TOKEN_ESTIMATE = 1600;

/**
 * Generic char/token conversion factor (claude-code's canonical heuristic).
 * Exported so adjacent estimators (`tokenEstimation.ts`'s `CHARS_PER_TOKEN`)
 * stay programmatically linked — if this ever moves, both sites move
 * together rather than drifting silently.
 */
export const TOKEN_TO_CHAR_RATIO = 4;
const DEFAULT_MIME = 'application/octet-stream';

/**
 * Strip characters that could break out of the placeholder envelope or
 * inject prompt-shaped content into the summary side-query. MCP tools
 * surface `mimeType` from arbitrary servers; an adversarial server
 * could craft something like `image/png]\n\n[SYSTEM: …` and have it
 * appear verbatim in the slimmed prompt.
 */
export function sanitizeMimeForPlaceholder(mime: string): string {
  return mime
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[[\]]/g, '')
    .trim()
    .slice(0, 128);
}

/**
 * Placeholder templates. Centralized so the slimming module, the
 * char-counter, and any future consumer agree on the exact wire format
 * the summary model will see.
 */
const imagePlaceholder = (mime: string): string =>
  `[image: ${sanitizeMimeForPlaceholder(mime)}]`;
const documentPlaceholder = (mime: string): string =>
  `[document: ${sanitizeMimeForPlaceholder(mime)}]`;

export interface ResolvedSlimmingConfig {
  imageTokenEstimate: number;
}

/**
 * Resolves slimming-related knobs in priority order: env > settings >
 * default. Invalid (non-finite or out-of-range) values fall through to
 * the next source.
 */
export function resolveSlimmingConfig(
  settings: ChatCompressionSettings | undefined,
): ResolvedSlimmingConfig {
  return {
    imageTokenEstimate: resolveNumber(
      process.env['QWEN_IMAGE_TOKEN_ESTIMATE'],
      settings?.imageTokenEstimate,
      DEFAULT_IMAGE_TOKEN_ESTIMATE,
      { minInclusive: 1 },
    ),
  };
}

function resolveNumber(
  envValue: string | undefined,
  settingsValue: number | undefined,
  defaultValue: number,
  {
    integer = false,
    minInclusive,
  }: { integer?: boolean; minInclusive: number },
): number {
  const isValid = (value: number) =>
    Number.isFinite(value) &&
    (!integer || Number.isSafeInteger(value)) &&
    value >= minInclusive;

  if (envValue !== undefined && envValue !== '') {
    const trimmed = envValue.trim();
    if (integer && !/^\d+$/.test(trimmed)) {
      return settingsValue !== undefined && isValid(settingsValue)
        ? settingsValue
        : defaultValue;
    }
    const parsed = Number(trimmed);
    if (isValid(parsed)) {
      return parsed;
    }
  }
  if (settingsValue !== undefined && isValid(settingsValue)) {
    return settingsValue;
  }
  return defaultValue;
}

export const DEFAULT_MAX_RECENT_FILES = 5;
export const DEFAULT_MAX_RECENT_IMAGES = 3;
export const DEFAULT_SCREENSHOT_TRIGGER_ENABLED = true;
export const DEFAULT_SCREENSHOT_TRIGGER_THRESHOLD = 20;
export const DEFAULT_IMAGE_PAYLOAD_THRESHOLD = 20;

export interface ResolvedCompactionTuning {
  /** Recent files restored after compaction (0 = restore none). */
  maxRecentFiles: number;
  /** Recent images restored after compaction (0 = restore none). */
  maxRecentImages: number;
  /** Whether tool-image accumulation can trigger auto-compaction. */
  enableScreenshotTrigger: boolean;
  /** Tool-image count at or above which the trigger fires (≥ 1). */
  screenshotTriggerThreshold: number;
  /**
   * Inline image count at or above which historical image payloads
   * are replaced with text references and only recent images are
   * reattached. Below this threshold images stay in-place untouched.
   */
  imagePayloadThreshold: number;
}

/**
 * Resolves the post-compact retention + screenshot-trigger knobs in
 * priority order env > settings > default. Count-like fields require
 * integer values because downstream collectors compare against integer
 * lengths.
 *
 * The screenshot trigger counts only images nested in
 * `functionResponse.parts` (tool results). Compaction replaces those with
 * the summary, and the surviving images are re-embedded as TOP-LEVEL parts
 * in the restoration block — which the counter ignores. So compaction
 * always resets the tool-image count to ~0 and the trigger cannot
 * immediately re-fire, independent of `maxRecentImages`.
 */
export function resolveCompactionTuning(
  settings: ChatCompressionSettings | undefined,
): ResolvedCompactionTuning {
  return {
    maxRecentFiles: resolveNumber(
      process.env['QWEN_COMPACT_MAX_RECENT_FILES'],
      settings?.maxRecentFilesToRetain,
      DEFAULT_MAX_RECENT_FILES,
      { integer: true, minInclusive: 0 },
    ),
    maxRecentImages: resolveNumber(
      process.env['QWEN_COMPACT_MAX_RECENT_IMAGES'],
      settings?.maxRecentImagesToRetain,
      DEFAULT_MAX_RECENT_IMAGES,
      { integer: true, minInclusive: 0 },
    ),
    enableScreenshotTrigger: resolveBoolean(
      process.env['QWEN_COMPACT_SCREENSHOT_TRIGGER'],
      settings?.enableScreenshotTrigger,
      DEFAULT_SCREENSHOT_TRIGGER_ENABLED,
    ),
    screenshotTriggerThreshold: resolveNumber(
      process.env['QWEN_COMPACT_SCREENSHOT_THRESHOLD'],
      settings?.screenshotTriggerThreshold,
      DEFAULT_SCREENSHOT_TRIGGER_THRESHOLD,
      { integer: true, minInclusive: 1 },
    ),
    imagePayloadThreshold: resolveNumber(
      process.env['QWEN_IMAGE_PAYLOAD_THRESHOLD'],
      settings?.imagePayloadThreshold,
      DEFAULT_IMAGE_PAYLOAD_THRESHOLD,
      { integer: true, minInclusive: 1 },
    ),
  };
}

/**
 * Resolves a boolean knob in priority order env > settings > default.
 * Accepts `1`/`true` and `0`/`false` (case-sensitive, matching the
 * existing `getEmitToolUseSummaries` convention); any other env string
 * is ignored so a typo falls through rather than silently flipping the
 * flag.
 */
function resolveBoolean(
  envValue: string | undefined,
  settingsValue: boolean | undefined,
  defaultValue: boolean,
): boolean {
  if (envValue === '1' || envValue === 'true') return true;
  if (envValue === '0' || envValue === 'false') return false;
  if (typeof settingsValue === 'boolean') return settingsValue;
  return defaultValue;
}

/**
 * Approximate char count for a single `Part`, used by
 * `estimateContentChars` and by the slimming module's own budget
 * accounting. Binary parts get a fixed budget (in chars) derived from
 * the configured token estimate; this keeps base64 payloads from
 * skewing compression size estimation or token-budget math.
 */
export function estimatePartChars(
  part: Part,
  imageTokenEstimate: number,
): number {
  if (part.inlineData || part.fileData) {
    return imageTokenEstimate * TOKEN_TO_CHAR_RATIO;
  }
  if (typeof part.text === 'string') {
    return part.text.length;
  }
  // Tool results in qwen-code carry media on `functionResponse.parts`
  // (an extension to the @google/genai schema; see
  // `coreToolScheduler.createFunctionResponsePart`). Walk into those
  // nested parts so a base64 image attached to a `read_file` result
  // isn't billed as ~350K chars by `JSON.stringify`.
  if (part.functionResponse) {
    let total = 0;
    const output = part.functionResponse.response?.['output'];
    const error = part.functionResponse.response?.['error'];
    if (typeof output === 'string') {
      total += output.length;
    } else if (typeof error === 'string') {
      total += error.length;
    }
    const nested = getFunctionResponseParts(part);
    if (nested) {
      for (const inner of nested) {
        total += estimatePartChars(inner, imageTokenEstimate);
      }
    }
    // Add a small fixed floor for the wrapper metadata (id, name) so a
    // pure media-only response isn't reported as just the image budget.
    return total + 64;
  }
  return JSON.stringify(part ?? {}).length;
}

/**
 * Returns the nested-parts array from a `functionResponse`, if present.
 * qwen-code attaches media here (see
 * `coreToolScheduler.createFunctionResponsePart`); the standard
 * `@google/genai` FunctionResponse type does not declare it.
 *
 * Exported so post-compact image extraction/counting walks the SAME
 * carrier the slimmer strips — otherwise the two disagree on where tool
 * media lives and screenshots silently vanish from restoration.
 */
export function getFunctionResponseParts(part: Part): Part[] | undefined {
  const fr = part.functionResponse as { parts?: unknown } | undefined;
  return Array.isArray(fr?.parts) ? (fr.parts as Part[]) : undefined;
}

export function estimateContentChars(
  content: Content,
  imageTokenEstimate: number,
): number {
  if (!content.parts) return 0;
  let total = 0;
  for (const part of content.parts) {
    total += estimatePartChars(part, imageTokenEstimate);
  }
  return total;
}

interface SlimResult {
  slimmedHistory: Content[];
  stats: SlimStats;
}

/** Appended to text payloads truncated by `maxTextChars`. */
export const SLIM_TEXT_TRUNCATION_MARKER = '\n[...truncated for compaction]';

export interface SlimOptions {
  /**
   * When set, text payloads larger than this (top-level `text` parts,
   * tool-result `output`/`error` strings, and `functionCall` string args)
   * are truncated to this many characters plus an elision marker. Used when
   * a compaction is triggered by an HTTP 413 request-body overflow: the
   * side-query must fit under the same gateway byte limit as the request
   * that was rejected (#10380). Regular (token-driven) compactions pass
   * nothing and keep text intact.
   */
  maxTextChars?: number;
  /**
   * Leaves the text the user typed out of `maxTextChars`, up to
   * PRESERVED_USER_TEXT_MAX_CHARS, so a compaction side-query reduced to fit
   * its window still shows the summarizer what the user asked for. Tool
   * results ride user turns as `functionResponse` parts and are still
   * truncated, as is content attached on the user's behalf (@-mentioned
   * files, MCP resources, referenced sessions): every part but the marked
   * prompt, or, in a turn with no mark, everything from the first part that
   * opens such content to the end of the turn.
   */
  preserveUserText?: boolean;
}

/**
 * Longest text the user typed that `preserveUserText` keeps whole. Past it,
 * a single pasted message could outgrow the window, and no reduction would
 * ever bring the side-query under it.
 */
export const PRESERVED_USER_TEXT_MAX_CHARS = 32_000;

interface SlimStats {
  imagesStripped: number;
  documentsStripped: number;
  textPartsTruncated: number;
}

/**
 * Strip inline media from compaction input. The returned array has the
 * same length and ordering as the input; identity-equal when nothing
 * changed.
 */
export function slimCompactionInput(
  history: Content[],
  supportedModalities?: InputModalities,
  options?: SlimOptions,
): SlimResult {
  const stats: SlimStats = {
    imagesStripped: 0,
    documentsStripped: 0,
    textPartsTruncated: 0,
  };
  let anyChange = false;

  const slimmed = history.map((content) => {
    if (!content.parts || content.parts.length === 0) return content;
    const typed =
      options?.preserveUserText === true && content.role === 'user'
        ? typedPartFlags(content.parts)
        : undefined;

    let touched = false;
    const newParts: Part[] = content.parts.map((part, index) => {
      const replacement =
        typed?.[index] &&
        isUserTextPart(part) &&
        !isWrappedSystemReminderPart(part)
          ? capTypedText(part, stats)
          : transformPart(part, stats, supportedModalities, options);
      if (replacement !== part) {
        touched = true;
        return replacement;
      }
      return part;
    });

    if (!touched) return content;
    anyChange = true;
    return { ...content, parts: newParts };
  });

  return {
    slimmedHistory: anyChange ? slimmed : history,
    stats,
  };
}

function transformPart(
  part: Part,
  stats: SlimStats,
  supportedModalities?: InputModalities,
  options?: SlimOptions,
): Part {
  if (part.inlineData) {
    if (
      supportsMimeType(part.inlineData.mimeType, supportedModalities) === true
    ) {
      return part;
    }
    return mediaPlaceholderPart(part.inlineData.mimeType, stats);
  }
  if (part.fileData) {
    if (
      supportsMimeType(part.fileData.mimeType, supportedModalities) === true
    ) {
      return part;
    }
    return mediaPlaceholderPart(part.fileData.mimeType, stats);
  }
  // Walk into functionResponse.parts (qwen-code's nested-media carrier
  // for tool results — see `coreToolScheduler.createFunctionResponsePart`).
  // Without this, base64 images returned by read_file et al. leak into
  // the side-query payload.
  let nextPart: Part = part;
  const nested = getFunctionResponseParts(part);
  if (nested) {
    let touched = false;
    const newNested = nested.map((inner) => {
      const replacement = transformPart(
        inner,
        stats,
        supportedModalities,
        options,
      );
      if (replacement !== inner) {
        touched = true;
      }
      return replacement;
    });
    if (touched) {
      nextPart = {
        ...part,
        functionResponse: {
          ...part.functionResponse!,
          parts: newNested,
        } as Part['functionResponse'],
      };
    }
  }
  // Truncate oversized tool-result text on the payload-overflow compaction
  // path so the side-query itself fits under the gateway byte limit that
  // rejected the main request (#10380). Mirrors `estimatePartChars`, which
  // bills exactly these carriers for tool results.
  const maxTextChars = options?.maxTextChars;
  const fr = nextPart.functionResponse;
  if (maxTextChars !== undefined && fr?.response) {
    const response = fr.response;
    let touched = false;
    const newResponse: Record<string, unknown> = { ...response };
    for (const key of ['output', 'error'] as const) {
      const value = response[key];
      if (typeof value === 'string' && value.length > maxTextChars) {
        newResponse[key] = truncateTextForSlimming(value, maxTextChars);
        stats.textPartsTruncated++;
        touched = true;
      }
    }
    if (touched) {
      nextPart = {
        ...nextPart,
        functionResponse: {
          ...fr,
          response: newResponse,
        } as Part['functionResponse'],
      };
    }
  }
  // Truncate oversized string args on the payload-overflow path as well:
  // `write_file`/`edit` carry entire file contents in
  // `functionCall.args.content`, and `estimatePartChars` bills them through
  // the JSON.stringify fallthrough — left untouched they ride into the
  // side-query at full size (#10380). Bridge calls carry those same args one
  // level deeper under `tool_call.arguments`, so walk that envelope too.
  const fc = nextPart.functionCall;
  if (maxTextChars !== undefined && fc?.args) {
    const args = fc.args;
    let argsTouched = false;
    const newArgs: Record<string, unknown> = { ...args };
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string' && value.length > maxTextChars) {
        newArgs[key] = truncateTextForSlimming(value, maxTextChars);
        stats.textPartsTruncated++;
        argsTouched = true;
      }
    }
    const bridgedArgs = args['arguments'];
    if (
      fc.name === ToolNames.TOOL_CALL &&
      typeof bridgedArgs === 'object' &&
      bridgedArgs !== null &&
      !Array.isArray(bridgedArgs)
    ) {
      let bridgedArgsTouched = false;
      const newBridgedArgs: Record<string, unknown> = { ...bridgedArgs };
      for (const [key, value] of Object.entries(bridgedArgs)) {
        if (typeof value === 'string' && value.length > maxTextChars) {
          newBridgedArgs[key] = truncateTextForSlimming(value, maxTextChars);
          stats.textPartsTruncated++;
          bridgedArgsTouched = true;
        }
      }
      if (bridgedArgsTouched) {
        newArgs['arguments'] = newBridgedArgs;
        argsTouched = true;
      }
    }
    if (argsTouched) {
      nextPart = {
        ...nextPart,
        functionCall: { ...fc, args: newArgs },
      };
    }
  }
  if (
    maxTextChars !== undefined &&
    typeof nextPart.text === 'string' &&
    nextPart.text.length > maxTextChars
  ) {
    stats.textPartsTruncated++;
    // Cut like other text, a reminder would lose its closing tag and read as
    // open over the text after it, so its body is cut and the tag closed
    // again.
    if (isWrappedSystemReminderPart(nextPart)) {
      return {
        ...nextPart,
        text: truncateReminderForSlimming(nextPart.text, maxTextChars),
      };
    }
    // Spread rather than rebuilding a bare `{ text }` so sibling properties
    // (`thought`, `thoughtSignature`, ...) survive truncation — the converter
    // pipeline keys reasoning parts off those flags (#10380).
    return {
      ...nextPart,
      text: truncateTextForSlimming(nextPart.text, maxTextChars),
    };
  }
  return nextPart;
}

function truncateReminderForSlimming(
  value: string,
  maxTextChars: number,
): string {
  const body = value.trimEnd().slice(0, -SYSTEM_REMINDER_CLOSE.length);
  return `${truncateTextForSlimming(body, maxTextChars)}\n${SYSTEM_REMINDER_CLOSE}`;
}

function truncateTextForSlimming(value: string, maxTextChars: number): string {
  let end = maxTextChars;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end--;
  }
  return value.slice(0, end) + SLIM_TEXT_TRUNCATION_MARKER;
}

/** Longest quote of a single user message in a condensed side-query. */
export const CONDENSED_USER_MESSAGE_MAX_CHARS = 8_000;
/**
 * Longest quote of the oldest user message. After an earlier compaction it
 * holds that compaction's summary, the densest record of everything before.
 */
export const CONDENSED_FIRST_MESSAGE_MAX_CHARS = 32_000;
/** Longest condensed block in a side-query: its note and every quote. */
export const CONDENSED_USER_MESSAGES_MAX_CHARS = 64_000;
/**
 * Least of the oldest and of the newest user message a condensed block
 * quotes, or the whole message when shorter. A block that cannot hold that
 * much no longer says what the conversation set out to do or what the user
 * asked last, so the reduction is refused instead (#9455).
 */
export const CONDENSED_MESSAGE_MIN_CHARS = 2_000;
/** Room first set aside for the condensed block's leading note. */
const CONDENSED_NOTE_RESERVE_CHARS = 512;
/**
 * Text cap for the kept turns when they would leave the quotes less than
 * their minimum. Files and images those turns touched are restored after
 * compaction, so their tool output is the cheapest thing to give up.
 */
const KEPT_TURN_TEXT_CAP_CHARS = 500;
const QUOTE_OPEN = '<user_message>\n';
const QUOTE_CLOSE = '\n</user_message>';
const QUOTE_WRAPPER_CHARS = QUOTE_OPEN.length + QUOTE_CLOSE.length;
const QUOTE_SEPARATOR = '\n\n';
const QUOTE_ELISION = `${SLIM_TEXT_TRUNCATION_MARKER}\n`;

/**
 * Shrinks a compaction side-query that cannot fit its window to at most
 * `maxChars`: the newest turns stay, and everything older becomes one user
 * message quoting what the user said there. Assistant replies and tool
 * traffic are dropped first because the user's words are the only record of
 * what was asked. The oldest and the newest of those messages are always
 * quoted, shortened in the middle when long, and the kept turns' text is
 * capped before either falls below CONDENSED_MESSAGE_MIN_CHARS. The kept
 * turns start on a model turn, so no function call is separated from its
 * response and the roles keep alternating after the quote block. When even
 * the capped kept turns leave the quotes no room, as a wide parallel tool
 * batch can, no turn is kept and every user message is quoted instead.
 * Undefined when no model turn can start the kept turns, or when `maxChars`
 * cannot hold the quotes' minimum.
 */
export function condenseToUserMessages(
  history: Content[],
  maxChars: number,
  imageTokenEstimate: number = DEFAULT_IMAGE_TOKEN_ESTIMATE,
): Content[] | undefined {
  // The kept turns are first chosen to leave the quotes a quarter of the room
  // (a share of characters, not a chars-to-tokens conversion), up to the total
  // cap; the quotes then take whatever the kept turns actually leave.
  const quoteBudget = Math.min(
    CONDENSED_USER_MESSAGES_MAX_CHARS,
    Math.floor(maxChars / 4),
    userMessageTexts(history).reduce(
      (sum, text, index) =>
        sum +
        quoteCost(
          quotedLength(
            text,
            index === 0
              ? CONDENSED_FIRST_MESSAGE_MAX_CHARS
              : CONDENSED_USER_MESSAGE_MAX_CHARS,
          ),
        ),
      0,
    ),
  );
  const keptBudget = maxChars - quoteBudget - CONDENSED_NOTE_RESERVE_CHARS;
  const cut = keptTurnsStart(history, keptBudget, imageTokenEstimate);
  if (cut < 1) return undefined;

  const texts = userMessageTexts(history.slice(0, cut));
  const condenseBeside = (kept: Content[]): Content[] | undefined => {
    const block = condensedBlock(
      texts,
      cut - texts.length,
      maxChars - contentChars(kept, imageTokenEstimate),
    );
    return block === undefined
      ? undefined
      : [{ role: 'user', parts: [{ text: block }] }, ...kept];
  };
  const kept = history.slice(cut);
  const quotesOnly = (): Content[] | undefined => {
    const allTexts = userMessageTexts(history);
    const block = condensedBlock(
      allTexts,
      history.length - allTexts.length,
      maxChars,
    );
    return block === undefined
      ? undefined
      : [{ role: 'user', parts: [{ text: block }] }];
  };
  return (
    (contentChars(kept, imageTokenEstimate) <= keptBudget
      ? condenseBeside(kept)
      : undefined) ??
    condenseBeside(
      slimCompactionInput(kept, undefined, {
        maxTextChars: KEPT_TURN_TEXT_CAP_CHARS,
        preserveUserText: true,
      }).slimmedHistory,
    ) ??
    quotesOnly()
  );
}

/**
 * The condensed block for `texts`, within `room` characters: a note, then
 * the oldest message, the middle ones that fit (newest first), and the
 * newest. Undefined when `room` cannot hold the oldest and the newest at
 * their minimum.
 */
function condensedBlock(
  texts: string[],
  omittedTurns: number,
  room: number,
): string | undefined {
  const note = (omittedQuotes: number, shortened: boolean) =>
    `[Earlier conversation condensed for compaction: ${omittedTurns} ` +
    `assistant and tool messages were omitted to fit the context window; ` +
    `the user's messages from that part are quoted ` +
    (shortened
      ? 'below, long ones shortened in the middle'
      : 'verbatim below') +
    (omittedQuotes
      ? `, except ${omittedQuotes} from the middle, omitted for length`
      : '') +
    `.]`;
  const [oldest, ...newer] = texts;
  if (oldest === undefined) {
    return note(0, false).length <= room ? note(0, false) : undefined;
  }
  const newest = newer.length > 0 ? newer[newer.length - 1] : undefined;
  const middle = newer.slice(0, -1);
  // The note is sized for its longest form: every middle quote omitted, and
  // a quote shortened.
  const available =
    Math.min(CONDENSED_USER_MESSAGES_MAX_CHARS, room) -
    note(middle.length, true).length;
  const minimum = (text: string) =>
    quotedLength(text, CONDENSED_MESSAGE_MIN_CHARS);
  const oldestFloor = quoteCost(minimum(oldest));
  if (
    available <
    oldestFloor + (newest === undefined ? 0 : quoteCost(minimum(newest)))
  ) {
    return undefined;
  }
  const newestQuote =
    newest === undefined
      ? undefined
      : quoteUserMessage(
          newest,
          Math.min(
            quotedLength(newest, CONDENSED_USER_MESSAGE_MAX_CHARS),
            available - oldestFloor - QUOTE_SEPARATOR.length,
          ),
        );
  const afterNewest =
    available - (newestQuote === undefined ? 0 : quoteCost(newestQuote.length));
  // The oldest message may use whatever the middle ones leave, and at least
  // half of what remains when they need more.
  const middleWants = middle.reduce(
    (sum, text) =>
      sum + quoteCost(quotedLength(text, CONDENSED_USER_MESSAGE_MAX_CHARS)),
    0,
  );
  const oldestQuote = quoteUserMessage(
    oldest,
    Math.min(
      quotedLength(oldest, CONDENSED_FIRST_MESSAGE_MAX_CHARS),
      Math.max(
        minimum(oldest),
        Math.max(Math.floor(afterNewest / 2), afterNewest - middleWants) -
          QUOTE_SEPARATOR.length,
      ),
    ),
  );
  const isShortened = (quote: string, text: string) =>
    quote.length < QUOTE_WRAPPER_CHARS + text.length;
  let shortened =
    isShortened(oldestQuote, oldest) ||
    (newestQuote !== undefined && isShortened(newestQuote, newest!));
  let left = afterNewest - quoteCost(oldestQuote.length);
  const keptMiddle: string[] = [];
  for (let i = middle.length - 1; i >= 0; i--) {
    const quote = quoteUserMessage(
      middle[i]!,
      quotedLength(middle[i]!, CONDENSED_USER_MESSAGE_MAX_CHARS),
    );
    if (quoteCost(quote.length) > left) continue;
    keptMiddle.unshift(quote);
    left -= quoteCost(quote.length);
    shortened ||= isShortened(quote, middle[i]!);
  }
  return [
    note(middle.length - keptMiddle.length, shortened),
    oldestQuote,
    ...keptMiddle,
    ...(newestQuote === undefined ? [] : [newestQuote]),
  ].join(QUOTE_SEPARATOR);
}

function keptTurnsStart(
  history: Content[],
  budgetChars: number,
  imageTokenEstimate: number,
): number {
  let used = 0;
  let start = -1;
  for (let i = history.length - 1; i >= 1; i--) {
    used += estimateContentChars(history[i]!, imageTokenEstimate);
    if (used > budgetChars) break;
    if (history[i]!.role === 'model') start = i;
  }
  if (start !== -1) return start;
  return history.findLastIndex(
    (content, index) => index >= 1 && content.role === 'model',
  );
}

// Tool results are `functionResponse` parts, not text, so a user turn that
// carries both (input steered in while tools ran) still contributes its text.
// Injected `<system-reminder>` blocks ride user turns too but are not the
// user's words; left in, they can fill a capped quote ahead of the prompt.
// Attached content is named, not quoted: it is not what the user said. Tags
// that would close a quote's envelope or open another are escaped here, before
// any quote is measured, so the budgets count the escaped text.
function userMessageTexts(history: Content[]): string[] {
  const texts: string[] = [];
  for (const content of history) {
    if (content.role !== 'user') continue;
    const parts = content.parts ?? [];
    const typed = typedPartFlags(parts);
    const typedText = parts
      .filter(
        (part, index) =>
          typed[index] &&
          isUserTextPart(part) &&
          !isWrappedSystemReminderPart(part),
      )
      .map((part) => stripLeadingSystemReminders(part.text!))
      .join('\n')
      .trim();
    // Tool traffic, reminders, hook context and the memory snapshot ride the
    // turn too, but are neither typed nor attached.
    const attached = parts.filter(
      (part, index) =>
        !typed[index] &&
        !part.functionResponse &&
        !part.functionCall &&
        !isWrappedSystemReminderPart(part) &&
        !isInjectedContext(part),
    );
    // A failed attachment is reported as such, not named as attached.
    const failures = attached.filter(isAttachmentFailureNotice);
    const text = escapeUserMessageTags(
      escapeSystemReminderTags(
        [
          typedText,
          ...failures.map(() => ATTACHMENT_PROCESSING_FAILURE_NOTICE),
          attachedContentNote(
            attached.filter((part) => !isAttachmentFailureNotice(part)),
          ),
        ]
          .filter(Boolean)
          .join('\n'),
      ),
    );
    if (text) texts.push(text);
  }
  return texts;
}

/**
 * User turns with text but no typed-prompt mark, which compaction reads by
 * position. Logged when an input is reduced, so a request path that stops
 * marking its prompt shows up.
 */
export function countUnmarkedUserTurns(history: Content[]): number {
  return history.filter(
    (content) =>
      content.role === 'user' &&
      !content.parts?.some(isTypedPrompt) &&
      (content.parts ?? []).some(
        (part) =>
          isUserTextPart(part) &&
          !isWrappedSystemReminderPart(part) &&
          !isInjectedContext(part),
      ),
  ).length;
}

/**
 * Which parts of a user turn hold what the user typed. The part marked where
 * the prompt was built (TYPED_PROMPT_METADATA) settles it: only marked parts
 * are typed, whatever the layout and whatever else rides the turn, including
 * attached content no header names. A turn with no mark (recorded before the
 * mark existed, or written by a subagent, the scheduler or a retry path that
 * does not mark) keeps the positional rule of attachedContentStart, so its
 * text is never dropped; hook context and the memory snapshot carry their own
 * markers and are never typed.
 */
function typedPartFlags(parts: Part[]): boolean[] {
  if (parts.some(isTypedPrompt)) return parts.map(isTypedPrompt);
  const attachedFrom = attachedContentStart(parts);
  return parts.map(
    (part, index) => index < attachedFrom && !isInjectedContext(part),
  );
}

/**
 * Hook context and the auto-memory snapshot ride a user turn under their own
 * markers: neither is what the user typed or something they attached.
 */
function isInjectedContext(part: Part): boolean {
  return (
    part.partMetadata?.[AUTO_MEMORY_SNAPSHOT_METADATA] === true ||
    (typeof part.text === 'string' &&
      isUserPromptSubmitContextPartText(part.text))
  );
}

/**
 * `text` without the complete `<system-reminder>` blocks at its start, which is
 * where IDE context is prepended into the prompt's own part. A tag anywhere
 * else is the user's, kept and escaped with the rest of the quote.
 */
function stripLeadingSystemReminders(text: string): string {
  let rest = text;
  for (;;) {
    const start = rest.trimStart();
    if (!start.startsWith(SYSTEM_REMINDER_OPEN)) return rest;
    const close = start.indexOf(
      SYSTEM_REMINDER_CLOSE,
      SYSTEM_REMINDER_OPEN.length,
    );
    if (close === -1) return rest;
    rest = start.slice(close + SYSTEM_REMINDER_CLOSE.length);
  }
}

function isAttachmentFailureNotice(part: Part): boolean {
  return part.text?.trim() === ATTACHMENT_PROCESSING_FAILURE_NOTICE;
}

/**
 * For a turn with no marked prompt: index of the first part that opens
 * content attached on the user's behalf, or `parts.length`. What the user
 * typed is taken to be the turn's first part, so it is never taken for
 * attached content even when it starts like a header, and everything after
 * the opening header is attached: closing markers are not trusted, since
 * `--- End of content ---` carries no nonce and a file can contain it.
 */
function attachedContentStart(parts: Part[]): number {
  const index = parts.findIndex(
    (part, i) =>
      i > 0 && typeof part.text === 'string' && opensAttachedContent(part.text),
  );
  return index === -1 ? parts.length : index;
}

/** The text the user typed, kept whole up to PRESERVED_USER_TEXT_MAX_CHARS. */
function capTypedText(part: Part, stats: SlimStats): Part {
  if (part.text!.length <= PRESERVED_USER_TEXT_MAX_CHARS) return part;
  stats.textPartsTruncated++;
  return {
    ...part,
    text: elideMiddle(part.text!, PRESERVED_USER_TEXT_MAX_CHARS),
  };
}

/**
 * Bounds on the names an attached-content note lists. The names come from
 * text an attached file can itself contain.
 */
const ATTACHED_NAMES_MAX = 8;
const ATTACHED_NAME_MAX_CHARS = 120;

/** Headers whose first line, without its dashes, names the block. */
const SELF_NAMING_HEADER_PREFIXES = [
  REFERENCED_SESSION_HEADER_PREFIX,
  MCP_RESOURCE_NOTE_HEADER_PREFIX,
  MCP_SERVER_HEADER_PREFIX,
  EXTENSION_HEADER_PREFIX,
];

/** One line naming the attached content in `parts`, or '' when none. */
function attachedContentNote(parts: Part[]): string {
  if (parts.length === 0) return '';
  const names = parts.flatMap((part) => {
    const line = part.text?.trim() ?? '';
    const file = /^Content from (.+):$/.exec(line);
    if (file) return [file[1]!];
    if (line.startsWith(MCP_RESOURCE_HEADER_PREFIX)) {
      return [
        line
          .slice(MCP_RESOURCE_HEADER_PREFIX.length)
          .replace(/\s*\[[^\]]*\]\s*---$/, ''),
      ];
    }
    if (SELF_NAMING_HEADER_PREFIXES.some((prefix) => line.startsWith(prefix))) {
      return [line.split('\n', 1)[0]!.replace(/^-+\s*|\s*-+$/g, '')];
    }
    return [];
  });
  if (names.length === 0) return '[Attached content, not quoted]';
  const listed = names.slice(0, ATTACHED_NAMES_MAX).map(plainName);
  const more = names.length - listed.length;
  return (
    `[Attached, not quoted: ${listed.join(', ')}` +
    (more > 0 ? ` and ${more} more` : '') +
    ']'
  );
}

/**
 * `name` on one line and without markup, at most ATTACHED_NAME_MAX_CHARS
 * long and never cut inside a surrogate pair: the names come from labels and
 * paths the user does not control, and the note joins the quoted text after
 * reminders were stripped from it.
 */
function plainName(name: string): string {
  const flat = name.replace(/\s+/g, ' ').replace(/[<>]/g, '').trim();
  let end = Math.min(flat.length, ATTACHED_NAME_MAX_CHARS);
  if (isHighSurrogate(flat.charCodeAt(end - 1))) end--;
  return flat.slice(0, end);
}

/** A quote of `text`, tags included, at most `maxQuoteChars` long. */
function quoteUserMessage(text: string, maxQuoteChars: number): string {
  return (
    QUOTE_OPEN +
    elideMiddle(text, maxQuoteChars - QUOTE_WRAPPER_CHARS) +
    QUOTE_CLOSE
  );
}

/** Length of the quote of `text` whose own text is capped at `cap`. */
function quotedLength(text: string, cap: number): number {
  return QUOTE_WRAPPER_CHARS + Math.min(text.length, cap);
}

/** A quote's share of the block: itself and the separator before it. */
function quoteCost(quoteChars: number): number {
  return quoteChars + QUOTE_SEPARATOR.length;
}

/**
 * `text` within `maxChars`, keeping its start and its end: a long request
 * often ends with the question being asked.
 */
function elideMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const kept = Math.max(0, maxChars - QUOTE_ELISION.length);
  let headEnd = Math.ceil(kept / 2);
  let tailStart = text.length - (kept - headEnd);
  // Never split a surrogate pair at either cut.
  if (isHighSurrogate(text.charCodeAt(headEnd - 1))) headEnd--;
  if (isLowSurrogate(text.charCodeAt(tailStart))) tailStart++;
  return text.slice(0, headEnd) + QUOTE_ELISION + text.slice(tailStart);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function contentChars(contents: Content[], imageTokenEstimate: number): number {
  return contents.reduce(
    (sum, content) => sum + estimateContentChars(content, imageTokenEstimate),
    0,
  );
}

function isUserTextPart(part: Part): boolean {
  return typeof part.text === 'string' && !part.thought;
}

function supportsMimeType(
  mimeType: string | undefined,
  modalities: InputModalities | undefined,
): boolean | undefined {
  if (!modalities) return undefined;
  const mime = mimeType ?? DEFAULT_MIME;
  if (mime.startsWith('image/')) return modalities.image;
  if (mime === 'application/pdf') return modalities.pdf;
  if (mime.startsWith('audio/')) return modalities.audio;
  if (mime.startsWith('video/')) return modalities.video;
  return false;
}

function mediaPlaceholderPart(
  mimeType: string | undefined,
  stats: SlimStats,
): Part {
  const mime = mimeType ?? DEFAULT_MIME;
  if (isNonImageMime(mime)) {
    stats.documentsStripped++;
    return { text: documentPlaceholder(mime) };
  }
  stats.imagesStripped++;
  return { text: imagePlaceholder(mime) };
}

function isNonImageMime(mime: string): boolean {
  // Anything outside image/* is rendered with the `[document: ...]`
  // placeholder. audio/video are rare on qwen-code's tool surface and
  // the placeholder is purely informational, so the conservative
  // grouping is acceptable.
  return !mime.startsWith('image/');
}
