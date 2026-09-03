import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Buffer } from 'node:buffer';
import {
  DWClient,
  TOPIC_CARD,
  TOPIC_ROBOT,
  EventAck,
} from 'dingtalk-stream-sdk-nodejs';
import type { DWClientDownStream } from 'dingtalk-stream-sdk-nodejs';
import {
  ChannelBase,
  isTerminalTaskLifecycleType,
  sanitizeLogText,
  sanitizePromptText,
  sanitizeSenderName,
  truncateUtf16Units,
} from '@qwen-code/channel-base';
import {
  DINGTALK_CHUNK_LIMIT,
  escapeDingTalkMarkdown,
  normalizeDingTalkMarkdown,
  extractTitle,
} from './markdown.js';
import { downloadMedia } from './media.js';
import {
  DingTalkMediaUploadError,
  findImageMarkers,
  readValidatedImage,
  replaceImageMarkers,
  uploadDingTalkImage,
} from './outbound-image.js';
import {
  FILE_UNAVAILABLE_NOTICE,
  OutboundFileProjector,
  projectFileText,
  readValidatedFile,
  safeFileName,
  uploadDingTalkFile,
  withFileUnavailableNotice,
  type ValidatedFile,
} from './outbound-file.js';
import {
  DingtalkConnectionManager,
  type DingtalkManagedSocket,
} from './DingtalkConnectionManager.js';
import {
  DingtalkCardRequestError,
  DingtalkInteractiveCardClient,
} from './interactive-card-client.js';
import {
  parseDingtalkCardActorId,
  parseDingtalkCardCallback,
  parseDingtalkInteractiveCardConfig,
  type DingtalkCardCallback,
  type DingtalkCardCallbackResult,
  type DingtalkInteractiveCardConfig,
} from './interactive-card-types.js';
import { StatusCardController } from './status-card-controller.js';
import { QuestionCardController } from './question-card-controller.js';
import { DingtalkInteractionPresenter } from './interaction-presenter.js';
import type {
  BackgroundResponseContext,
  ChannelConfig,
  ChannelBaseOptions,
  Envelope,
  ChannelAgentBridge,
  ChannelOutputSegmentContext,
  ChannelOutputSegmentEndReason,
  ChannelTaskLifecycleEvent,
  ChannelUserInputRequestContext,
  SessionTarget,
  UserInputPresentationResult,
} from '@qwen-code/channel-base';

/**
 * Raw DingTalk message data — the SDK's RobotMessage type only covers text,
 * but DingTalk sends richer payloads for richText, picture, file, etc.
 */

interface DingTalkRichTextPart {
  type?: string;
  text?: string;
  downloadCode?: string;
  atName?: string;
}

interface DingTalkMessageContent {
  text?: string;
  richText?: DingTalkRichTextPart[];
  downloadCode?: string;
  fileName?: string;
  recognition?: string;
  title?: string;
  summary?: string;
  chatRecord?: unknown;
  records?: unknown;
  messages?: unknown;
}

interface DingTalkRepliedMsg {
  msgId?: string;
  msgType?: string;
  senderId?: string;
  content?: DingTalkMessageContent;
}

interface DingTalkAtUser {
  dingtalkId?: string;
  staffId?: string;
}

interface DingTalkMessageData {
  msgId?: string;
  msgtype?: string;
  conversationType?: string;
  conversationId?: string;
  conversationTitle?: string;
  sessionWebhook?: string;
  senderId?: string;
  senderStaffId?: string;
  senderNick?: string;
  chatbotUserId?: string;
  isInAtList?: boolean;
  atUsers?: DingTalkAtUser[];
  text?: {
    content?: string;
    isReplyMsg?: boolean;
    repliedMsg?: DingTalkRepliedMsg;
  };
  quoteMessage?: {
    msgId?: string;
    senderId?: string;
    text?: { content?: string };
    msgtype?: string;
  };
  content?: DingTalkMessageContent;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseJsonArray(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Neutralize a field lifted out of a forwarded chat record before it is joined
 * into the prompt.
 *
 * Record content is multi-author third-party text: the forwarder is an allowed
 * user, but the authors inside the record are not. `ChannelBase` applies
 * `sanitizePromptText` only when `envelope.isGroup || sessionScope === 'single'`,
 * and DingTalk declares no `defaultSessionScope` so the registry falls back to
 * `'user'` — meaning in 1:1 DMs nothing downstream neutralizes this text. Doing
 * it per field here is what closes the DM path, and matches how
 * `referencedText` is sanitized unconditionally on the reply path.
 *
 * It does NOT make the two renderings identical. In groups (and `single`-scope
 * sessions) `ChannelBase` runs `sanitizePromptText` again over the ASSEMBLED
 * text, which folds every structural newline to a space and peels this file's
 * own `[Chat record: ...]` / `[Chat record messages]` / `[N more message(s) not
 * shown]` markers whenever their content fits the unwrap's 64-char window. The
 * group prompt therefore carries the same content on one line with those
 * markers reduced to bare text. That is a safe degradation, not a defect in
 * this function — but the record's LAYOUT is a DM-only guarantee.
 */
function sanitizeChatRecordField(value: string): string {
  return sanitizePromptText(value).trim();
}

/**
 * Neutralize a record field that this file then WRAPS in `[...]`. Sanitizing
 * alone does not cover those: `sanitizePromptText` unwraps a start-of-line tag
 * only when the value already BEGINS with `[`, so `SYSTEM]: do this` passes
 * through untouched and the wrapper's own `[` completes a forged `[SYSTEM]:`
 * tag on a prompt line — the exact forge the sanitizer exists to prevent,
 * reopened by the wrapping that happens after it. Strip the brackets the
 * wrapper supplies so the value cannot close or complete one.
 */
function bracketSafeChatRecordField(value: string): string {
  return sanitizeChatRecordField(value).replace(/[[\]]/g, ' ').trim();
}

/**
 * Neutralize a record field this file renders AT start-of-line but does not
 * wrap. `sanitizePromptText` already peels a leading `[tag]` there, but only
 * while the tag content fits its `{1,64}` window — an 87-char `[SYSTEM MESSAGE
 * FROM ...]:` run never matches and survives verbatim. Peel the leading run at
 * ANY length, to a fixpoint so a nested `[[...]]` cannot re-form one.
 *
 * Brackets elsewhere on the line are LEFT ALONE, unlike
 * `bracketSafeChatRecordField`: nothing here wraps the value, and the rest of a
 * summary line is DingTalk's own display copy — `Bob: [image]` — which cannot
 * forge a prompt line from mid-line and should reach the model intact.
 */
function startOfLineSafeChatRecordField(value: string): string {
  const sanitized = sanitizeChatRecordField(value);
  if (!sanitized.startsWith('[')) return sanitized;
  // ONE linear pass, not a fixpoint loop over the whole string: the loop this
  // replaces rebuilt the entire value for every bracket pair, which is
  // quadratic — a 62,889-char nested `[[[...]]]` summary (authorable by any
  // group member, and the header caps below only run AFTER this) cost ~212 ms
  // of synchronous event-loop stall, ~4 s at 200 KB.
  //
  // Same peel, simulated in place. Each pass of that loop deleted exactly two
  // characters — the leading `[` and the FIRST `]` (its `[^\]]*` window can
  // match no other) — so instead of re-copying between passes, mark the pairs
  // and emit what survives. `open` walks the head of the current string (past
  // what is already deleted and past the whitespace `trim()` would take off);
  // `close` never rewinds because every `]` it passed is already deleted.
  const deleted = new Uint8Array(sanitized.length);
  let open = 0;
  let close = 0;
  for (;;) {
    while (
      open < sanitized.length &&
      (deleted[open] === 1 || /\s/.test(sanitized[open]!))
    ) {
      open += 1;
    }
    if (sanitized[open] !== '[') break;
    let next = Math.max(close, open + 1);
    while (
      next < sanitized.length &&
      (deleted[next] === 1 || sanitized[next] !== ']')
    ) {
      next += 1;
    }
    if (next >= sanitized.length) {
      // No `]` to pair with: delete the `[` anyway. Keeping it is what lets
      // `capChatRecordLines`' ` [truncated]` marker (appended past 500 units)
      // supply the closing bracket and complete a third-party bracket span at
      // start-of-line.
      deleted[open] = 1;
      open += 1;
      // A failed scan proves no live `]` remains anywhere past this point,
      // and later scans only start further right: latch the end so the next
      // head `[` does not rescan the tail -- that made a run of unpaired `[`
      // quadratic (R11-1) in the pass this function promises is linear.
      close = next;
      continue;
    }
    deleted[open] = 1;
    deleted[next] = 1;
    open += 1;
    close = next + 1;
  }
  const parts: string[] = [];
  let cut = 0;
  for (let i = 0; i < sanitized.length; i++) {
    if (deleted[i] === 0) continue;
    if (i > cut) parts.push(sanitized.slice(cut, i));
    cut = i + 1;
  }
  parts.push(sanitized.slice(cut));
  return parts.join('').trim();
}

/**
 * Bounds on how much of a forwarded record is joined into the prompt. A merge
 * forward can carry an entire group's history, and unbounded it displaces the
 * user's actual request in the model's context window. Truncation is
 * ANNOUNCED: a tail the model cannot see is worse than one it can account for.
 */
const MAX_CHAT_RECORD_ENTRIES = 50;
const MAX_CHAT_RECORD_CHARS = 4000;
const MAX_CHAT_RECORD_LINE_CHARS = 500;
/**
 * The budget a record gets on the REPLY leg. `ChannelBase` renders
 * `envelope.referencedText` through `sanitizeQuotedText(..., 500)`, which cuts
 * at 500 code points unconditionally — so a record rendered to the 4000-char
 * budget arrives with everything past the header gone and, worse, its own
 * `[N more message(s) not shown]` announcement cut off with it, leaving a bare
 * `…`. Render to the transport's budget instead, so the announcement lands
 * INSIDE the quote. `sanitizeQuotedText` only substitutes characters (brackets
 * and newlines become spaces), so a text within this budget is never cut.
 */
const MAX_QUOTED_CHAT_RECORD_CHARS = 500;
const CHAT_RECORD_ENTRIES_LABEL = '[Chat record messages]';
const CHAT_RECORD_HEADER_LEAD = (title: string) => `[Chat record: ${title}] `;
/** `parts.join('\n\n')`. */
const CHAT_RECORD_PART_GAP = 2;

function announcedDrop(count: number): string {
  return `[${count} more message(s) not shown]`;
}

/**
 * What the announcement costs a budget worst case: its own text plus the `\n`
 * that joins it to the last kept line. `lines.length` bounds the drop count, so
 * the real announcement is never longer than the one measured here.
 */
function chatRecordAnnouncementCost(lines: string[]): number {
  return lines.length > 0 ? announcedDrop(lines.length).length + 1 : 0;
}

/**
 * @param budget Hard ceiling, in UTF-16 units, on everything returned —
 *   announcement included. UTF-16 length is an upper bound on code-point
 *   count, so a caller measuring in code points (the quote leg) is safe.
 */
function capChatRecordLines(lines: string[], budget: number): string[] {
  const kept: string[] = [];
  let dropped = 0;
  let total = 0;
  // Reserve the announcement up front rather than appending it over the top of
  // a full budget: on the quote leg the budget is small enough that the
  // overshoot is what the transport cuts, which loses exactly the sentence
  // telling the model the record is partial. `lines.length` bounds `dropped`,
  // so the reservation is never short.
  const spendable = budget - chatRecordAnnouncementCost(lines);
  // Below its own announcement there is nothing this function can say inside
  // the budget, and saying it anyway is what overflows onto the transport's
  // cut. Callers reserve the announcement (`chatRecordAnnouncementCost`), so
  // this is a floor, not a path.
  if (spendable < 0) return [];
  // Both caps STOP at the first line they reject rather than skipping it and
  // trying the next: the announcement below reads as a tail cut, so letting a
  // later shorter line slip past the size cap would drop messages out of the
  // MIDDLE of the record while telling the model the missing ones are the last
  // ones — positional reasoning over the transcript then silently skips a
  // message the model believes it has. Stopping also means no line past the cut
  // is measured or truncated, the waste the entry cap was already ordered to
  // avoid.
  for (const [index, line] of lines.entries()) {
    if (kept.length >= MAX_CHAT_RECORD_ENTRIES) {
      dropped = lines.length - index;
      break;
    }
    // Slice in UTF-16 UNITS, on code-point boundaries: `total` below, the
    // caller's `spent`, and `chatRecordAnnouncementCost` all measure `.length`,
    // so a code-point cap would let an astral-heavy line claim up to 2x the
    // units it was budgeted, while cutting mid-surrogate-pair would emit a lone
    // surrogate into the prompt. `truncateUtf16Units` returns the input
    // untouched when it already fits, so the length test is its own fast path.
    const boundedRaw = truncateUtf16Units(line, MAX_CHAT_RECORD_LINE_CHARS);
    const bounded = boundedRaw === line ? line : `${boundedRaw} [truncated]`;
    // No first-line exemption: with the per-line cap at 500 the first line
    // always fits the 4000 budget anyway, so the exemption only ever fired on
    // the quote leg's budget — where keeping a line the transport then cuts is
    // exactly the silent truncation this block exists to prevent.
    if (total + bounded.length > spendable) {
      dropped = lines.length - index;
      break;
    }
    kept.push(bounded);
    total += bounded.length + 1;
  }
  if (dropped > 0) kept.push(announcedDrop(dropped));
  return kept;
}

/**
 * The placeholder shown for a message whose body is not text. Shared by the
 * record-entry and reply-quote paths so the two cannot drift — they already had
 * (different `file` handling, different empty fallback), which described the
 * same message type two ways to the model depending on how it arrived. Callers
 * supply their own fallback for an absent/unknown msgType.
 */
function mediaTypePlaceholder(
  msgType: string | undefined,
  fileName?: unknown,
): string | undefined {
  switch (msgType) {
    case 'picture':
      return '[image]';
    case 'file': {
      // `fileName` is record content, i.e. third-party authored, and it lands
      // inside a bracket wrapper — same treatment as every other such field.
      const name = bracketSafeChatRecordField(nonEmptyString(fileName) || '');
      return `[file: ${name || 'file'}]`;
    }
    case 'audio':
      return '[audio]';
    case 'video':
      return '[video]';
    default:
      return undefined;
  }
}

function formatChatRecordEntryBody(record: Record<string, unknown>): string {
  const rawContent = record['content'];
  const content =
    rawContent && typeof rawContent === 'object'
      ? (rawContent as Record<string, unknown>)
      : undefined;
  const body =
    nonEmptyString(record['text']) ||
    nonEmptyString(rawContent) ||
    nonEmptyString(content?.['text']) ||
    nonEmptyString(record['message']) ||
    nonEmptyString(record['body']);
  if (body) return sanitizeChatRecordField(body) || '[message]';

  const msgType =
    nonEmptyString(record['msgType']) || nonEmptyString(record['msgtype']);
  const safeMsgType = msgType ? bracketSafeChatRecordField(msgType) : '';
  return (
    mediaTypePlaceholder(msgType, content?.['fileName']) ??
    // Record-specific fallback: name the type when DingTalk sends one we do
    // not model, so the model sees *something* arrived rather than a gap.
    // The name is record content like every other field here, so it is
    // neutralized before it goes inside the brackets.
    (safeMsgType ? `[${safeMsgType}]` : '[message]')
  );
}

/**
 * The content keys that actually arrived on a chat-record payload, for the
 * degraded-path diagnostic below. The payload shape is undocumented and
 * varies — this file probes three entry field names and two encodings — so
 * when DingTalk ships another variant the only thing that distinguishes "the
 * bot cannot see forwarded messages" from a bug is knowing which keys were
 * present.
 */
function describeChatRecordKeys(content?: DingTalkMessageContent): string {
  if (!content || typeof content !== 'object') return 'none';
  const keys = Object.keys(content as Record<string, unknown>);
  return keys.length > 0 ? keys.join(',') : 'none';
}

/**
 * The rendered record plus whether an entries key arrived but produced no
 * lines. That case renders a non-empty title/summary, so the empty-record
 * warning below never fires for it, yet every forwarded message is gone — the
 * degradation `describeChatRecordKeys` exists to make diagnosable.
 */
interface FormattedChatRecord {
  text: string;
  entriesDropped: boolean;
}

function formatChatRecord(
  content?: DingTalkMessageContent,
  budget: number = MAX_CHAT_RECORD_CHARS,
): FormattedChatRecord {
  const title = nonEmptyString(content?.title);
  const rawSummary = nonEmptyString(content?.summary);
  const parsedSummary = parseJsonArray(rawSummary);
  // Keep empty placeholder lines: `summaryLines` is positional and indexes
  // into `entries` for sender recovery below, so filtering here would shift
  // every later line onto the wrong entry — the exact misattribution the
  // length guard exists to prevent. `summary` is the display copy and filters
  // them; the two variables look redundant but are not. Start-of-line-safe
  // rather than merely sanitized because the lines are joined with `\n` and
  // rendered after a header, so every line after the first sits at start-of-
  // line — the privileged prompt position — and the unwrap alone cannot defend
  // it: its `{1,64}` content window can never match a longer bracketed run, so
  // an 87-char `[SYSTEM MESSAGE FROM ...]:` tag survives verbatim.
  const summaryLines: string[] = parsedSummary
    ? parsedSummary.map(
        (item) =>
          startOfLineSafeChatRecordField(nonEmptyString(item) || '') || '',
      )
    : rawSummary
        ?.split('\n')
        .map((line) =>
          startOfLineSafeChatRecordField(nonEmptyString(line) || ''),
        ) || [];
  const rawEntries =
    content?.chatRecord ?? content?.records ?? content?.messages;
  const entries = parseJsonArray(rawEntries);

  const recordLines = Array.isArray(entries)
    ? entries.flatMap((entry, index) => {
        if (typeof entry === 'string') {
          const body = nonEmptyString(entry);
          if (!body) return [];
          // Through the shared body pipeline, not a second copy of it: a
          // string entry and an object entry carrying the same text must be
          // described to the model the same way, including when the text
          // sanitizes to nothing.
          return [`Unknown: ${formatChatRecordEntryBody({ text: body })}`];
        }
        if (!entry || typeof entry !== 'object') return [];
        const record = entry as Record<string, unknown>;
        const summarySender =
          summaryLines.length === entries.length
            ? nonEmptyString(summaryLines[index]?.match(/^([^:：]+)[:：]/)?.[1])
            : undefined;
        const rawSender =
          nonEmptyString(record['senderName']) ||
          nonEmptyString(record['senderNick']) ||
          nonEmptyString(record['sender']) ||
          summarySender ||
          nonEmptyString(record['senderId']);
        // A sender lands at start-of-line immediately before `: `, the exact
        // privileged position the `[tag]:` unwrap defends — so strip the
        // brackets outright rather than relying on the unwrap alone.
        const sender =
          (rawSender && bracketSafeChatRecordField(rawSender)) || 'Unknown';
        return [`${sender}: ${formatChatRecordEntryBody(record)}`];
      })
    : [];

  // The header is record content too, and it was inside NO cap — per-line,
  // total or code-point — while `capChatRecordLines` bounded only the entry
  // lines: a 62,889-char `summary` reached the prompt intact, ~15x the total
  // this function documents, displacing the user's own request. Spend one
  // budget across header then entries, in render order, reserving what the
  // entries need to announce their own cut.
  const entriesFloor =
    recordLines.length > 0
      ? CHAT_RECORD_ENTRIES_LABEL.length +
        1 +
        chatRecordAnnouncementCost(recordLines)
      : 0;
  const headerBudget = Math.max(
    budget - CHAT_RECORD_PART_GAP - entriesFloor,
    0,
  );
  const summaryDisplayLines = summaryLines.filter(Boolean);
  // The title is wrapped in brackets below, so bracket-safety on top of
  // sanitization; `|| undefined` keeps the 'Chat record' fallback for a title
  // that was nothing but brackets or whitespace. It is one line of the record,
  // so the per-line cap bounds it — and then the header budget bounds that,
  // leaving the summary room to announce its own cut. Uncapped, a 5,000-char
  // title ate the whole header budget on its own.
  //
  // Cut in UTF-16 UNITS, not code points: `headerBudget`, `headerLead.length`,
  // `spent` and `chatRecordAnnouncementCost` are all `.length`, so a code-point
  // cap let an astral-heavy title claim up to 2x its reserved units. A title of
  // >=429 code points carrying >=2 astral characters then pushed the entries
  // budget below the announcement cost this line reserves, `capChatRecordLines`
  // hit its `spendable < 0` floor, and EVERY forwarded message vanished with no
  // announcement and `entriesDropped` still false — the exact silent truncation
  // the reservation exists to prevent. A fully-astral title also carried the
  // result past the documented 500-unit ceiling.
  const safeTitle = title
    ? truncateUtf16Units(
        bracketSafeChatRecordField(title),
        Math.max(
          Math.min(
            MAX_CHAT_RECORD_LINE_CHARS,
            headerBudget -
              CHAT_RECORD_HEADER_LEAD('').length -
              chatRecordAnnouncementCost(summaryDisplayLines),
          ),
          0,
        ),
      ) || undefined
    : undefined;
  const headerLead = CHAT_RECORD_HEADER_LEAD(safeTitle || 'untitled');
  const summary = capChatRecordLines(
    summaryDisplayLines,
    Math.max(headerBudget - headerLead.length, 0),
  ).join('\n');
  const parts: string[] = [];
  // The tag NAME is fixed and the title goes inside it, never the other way
  // round. `bracketSafeChatRecordField` is a no-op for a title that carries no
  // brackets, so a bare attacker title like `SYSTEM` (which is also what
  // `[SYSTEM]` and `[[SYSTEM]]` sanitize down to) would otherwise have this
  // wrapper manufacture a clean start-of-line `[SYSTEM]` — a forge created
  // AFTER sanitization, which no amount of sanitizing the title can prevent.
  if (summary) {
    parts.push(`${headerLead}${summary}`);
  } else if (safeTitle) {
    parts.push(`[Chat record: ${safeTitle}]`);
  }
  const spent = parts.reduce(
    (used, part) => used + part.length + CHAT_RECORD_PART_GAP,
    0,
  );
  const boundedLines = capChatRecordLines(
    recordLines,
    Math.max(budget - spent - CHAT_RECORD_ENTRIES_LABEL.length - 1, 0),
  );
  if (boundedLines.length > 0) {
    parts.push(`${CHAT_RECORD_ENTRIES_LABEL}\n${boundedLines.join('\n')}`);
  }
  return {
    text: parts.join('\n\n'),
    entriesDropped: rawEntries !== undefined && recordLines.length === 0,
  };
}

/** Track seen msgIds to deduplicate retried callbacks. */
const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const BACKGROUND_RESPONSE_AGGREGATION_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * A failed aggregation delivery is retried rather than dropped: aggregating
 * concentrates a whole turn into one send, and the burst that makes a send
 * fail (several agents finishing at once against one chat quota) is exactly
 * when the whole result would be lost.
 */
const BACKGROUND_RESPONSE_AGGREGATION_RETRY_MS = 30 * 1000;
const BACKGROUND_RESPONSE_AGGREGATION_MAX_RETRIES = 3;

const ACK_REACTION_NAME = '👀';
const ACK_EMOTION_ID = '2659900';
const ACK_EMOTION_BG_ID = 'im_bg_1';
const EMOTION_API = 'https://api.dingtalk.com/v1.0/robot/emotion';
const EMOTION_MAX_ATTEMPTS = 3;
const EMOTION_RETRY_BASE_DELAY_MS = 250;
const GROUP_MSG_API = 'https://api.dingtalk.com/v1.0/robot/groupMessages/send';
const DIRECT_MSG_API =
  'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend';
const PROACTIVE_MSG_KEY = 'sampleMarkdown'; // DingTalk's built-in {title, text} markdown template key
const PROACTIVE_FILE_MSG_KEY = 'sampleFile';
const TOKEN_API = 'https://oapi.dingtalk.com/gettoken';
const PROACTIVE_FETCH_TIMEOUT_MS = 15_000;
const ROBOT_MESSAGE_HOSTS = new Set(['api.dingtalk.com', 'oapi.dingtalk.com']);
/**
 * gettoken business errors a retry cannot fix: an invalid appkey/secret or a
 * missing app. Any other errcode (-1 system busy, 88 throttled, ...) is
 * treated as transient so card recovery keeps retrying through it.
 */
const PERMANENT_TOKEN_ERROR_CODES = new Set([
  40001, 40013, 40089, 40096, 90002, 90003,
]);
const REPLY_FETCH_TIMEOUT_MS = 15_000;

interface InboundErrorPresentation {
  status: string;
  nextStep: string;
}

function presentInboundError(error: unknown): InboundErrorPresentation {
  const parts: string[] = [];
  let status: number | undefined;

  try {
    if (error instanceof Error) {
      if (typeof error.name === 'string') parts.push(error.name);
      if (typeof error.message === 'string') parts.push(error.message);
    } else if (typeof error === 'string') {
      parts.push(error);
    }

    if (typeof error === 'object' && error !== null) {
      const record = error as Record<string, unknown>;
      if (typeof record['code'] === 'string') parts.push(record['code']);
      if (typeof record['status'] === 'number') status = record['status'];
      const body = record['body'];
      if (typeof body === 'string') {
        parts.push(body);
      } else if (typeof body === 'object' && body !== null) {
        const bodyRecord = body as Record<string, unknown>;
        for (const key of ['code', 'errorKind', 'message']) {
          if (typeof bodyRecord[key] === 'string') parts.push(bodyRecord[key]);
        }
      }
    }
  } catch {
    return {
      status: 'Processing failed',
      nextStep:
        'Try again. If it keeps failing, contact the bot administrator.',
    };
  }

  const diagnostic = parts.join(' ').slice(0, 2000).toLowerCase();
  if (
    status === 401 ||
    status === 403 ||
    /unauthor|forbidden|authentication|credential|invalid.?token/.test(
      diagnostic,
    )
  ) {
    return {
      status: 'Bot configuration error',
      nextStep: 'Contact the bot administrator.',
    };
  }
  if (
    status === 408 ||
    status === 504 ||
    /timeout|timed?\s+out|deadline/.test(diagnostic)
  ) {
    return {
      status: 'Request timed out',
      nextStep: 'Try again. For a large request, split it into smaller parts.',
    };
  }
  if (/cancel|abort/.test(diagnostic)) {
    return {
      status: 'Request was cancelled',
      nextStep: 'Send the request again if you still need it.',
    };
  }
  if (
    status === 429 ||
    /overload|rate.?limit|queue.?full|too many|busy|pending prompts full/.test(
      diagnostic,
    )
  ) {
    return {
      status: 'Service is busy',
      nextStep: 'Try again in a moment.',
    };
  }
  if (
    status === 502 ||
    status === 503 ||
    /unavailable|econn|enotfound|etimedout|network|socket|fetch failed|connection|session[_ ](?:not[ _]found|closing)|workspace[_ ]draining|transport closed/.test(
      diagnostic,
    )
  ) {
    return {
      status: 'Service is temporarily unavailable',
      nextStep:
        'Try again in a moment. If it keeps failing, contact the bot administrator.',
    };
  }
  return {
    status: 'Processing failed',
    nextStep: 'Try again. If it keeps failing, contact the bot administrator.',
  };
}

function formatInboundErrorMessage(error: unknown, reference: string): string {
  const presentation = presentInboundError(error);
  return [
    '**Unable to process this message**',
    '',
    `**Status:** ${presentation.status}`,
    `**Next step:** ${presentation.nextStep}`,
    `**Reference:** \`${reference}\``,
  ].join('\n');
}

// Extensions for generated media store names, keyed by the download's mime
// type. The agent reads stored media via `read_file`, whose type detection is
// extension-first: an extensionless name falls through to the binary content
// sampler and real image/audio/video bytes are refused.
const GENERATED_MEDIA_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'video/mp4': 'mp4',
};
const mentionTarget = Symbol('mentionTarget');
const IMAGE_INSTRUCTIONS = [
  '',
  'If you created an image file (screenshot, chart, etc.), you can send it to the user by writing:',
  '`[IMAGE: /absolute/path/to/file.png]` (without the backticks)',
  '',
  'The marker is stripped from text and the image is uploaded automatically.',
  '',
  'Only use a real image file inside the workspace or system temporary directory.',
].join('\n');
const FILE_INSTRUCTIONS = [
  '',
  'When the user explicitly asks for a completed local file, send it by writing this on its own line:',
  '`[FILE: /absolute/path/to/file]` (without the backticks)',
  '',
  'Use at most five non-empty files inside the workspace or system temporary directory.',
  'File paths containing ] are not supported.',
  'Do not claim delivery succeeded; DingTalk shows successful files separately and reports failures in the final text.',
].join('\n');

type MentionTargetEnvelope = Envelope & {
  [mentionTarget]?: string;
};

interface CardRunCorrelation {
  ownerId: string;
  target: { chatId: string; isGroup: boolean };
  sender?: { senderName: string };
}

function collectNonBotMentionIds(data: DingTalkMessageData): string[] {
  if (!Array.isArray(data.atUsers) || typeof data.chatbotUserId !== 'string') {
    return [];
  }

  const mentions = new Set<string>();
  for (const user of data.atUsers) {
    if (!user) continue;
    const dingtalkId =
      typeof user.dingtalkId === 'string' ? user.dingtalkId : undefined;
    // DingTalk Stream always sets dingtalkId for the bot entry; staffId-only bot entries are not expected.
    if (dingtalkId === data.chatbotUserId) continue;
    const staffId = typeof user.staffId === 'string' ? user.staffId : undefined;
    // Prefer staffId so the model sees the same identifier space as senderId.
    const stableId = staffId || dingtalkId;
    if (stableId) mentions.add(stableId);
  }

  return [...mentions];
}

interface DingTalkTokenResponse {
  errcode?: number;
  errmsg?: string;
  access_token?: string;
  expires_in?: number;
}

interface DingTalkDirectMessageResponse {
  flowControlledStaffIdList?: string[];
  invalidStaffIdList?: string[];
  processQueryKey?: string;
}

type DingTalkClientInternals = DWClient & {
  debug: boolean;
  onDownStream(data: unknown): void;
  onSystem(message: DWClientDownStream): void;
  onEvent(message: DWClientDownStream): void;
  onCallback(message: DWClientDownStream): void;
};

type DingtalkChannelConfig = ChannelConfig & {
  useConnectionManager?: unknown;
  interactiveCards?: unknown;
  aggregateBackgroundAgentResponses?: unknown;
};

interface BackgroundResponseAggregation {
  sessionId: string;
  target: SessionTarget;
  sourceLabel?: string;
  status: string;
  label?: string;
  parts: string[];
  timeoutTimer?: ReturnType<typeof setTimeout>;
  retryTimer?: ReturnType<typeof setTimeout>;
  turnComplete?: boolean;
  completionPartial?: boolean;
  retiring?: boolean;
  flushing?: boolean;
  delivered?: boolean;
  delivery?: BackgroundResponseDelivery;
}

interface BackgroundResponseDelivery {
  status: string;
  label?: string;
  parts: string[];
  partial: boolean;
  attempts: number;
  proactivePlan?: ProactiveTextDelivery;
}

interface ProactiveTextDelivery {
  title: string;
  chunks: string[];
  nextChunk: number;
}

class ProactiveTextDeliveryError extends Error {
  readonly retryable?: boolean;

  constructor(
    readonly plan: ProactiveTextDelivery,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    if (cause instanceof DingtalkCardRequestError) {
      this.retryable = cause.retryable;
    }
  }
}

export class DingtalkChannel extends ChannelBase {
  private client: DWClient;
  private readonly atSender: boolean;
  private connectionManager?: DingtalkConnectionManager<DWClient>;
  private seenMessages: Map<string, number> = new Map();
  private mentionTargets = new Map<string, string>();
  private sessionMentionTargets = new Map<string, string>();
  private bufferedMentionTargets = new Set<string>();
  private bufferedMentionTargetsBySession = new Map<string, Set<string>>();
  private dedupTimer?: ReturnType<typeof setInterval>;
  /** Map conversationId → latest sessionWebhook URL for sending replies. */
  private webhooks: Map<string, string> = new Map();
  private activeReactionKeys = new Set<string>();
  /** sessionId → reaction keys, so a dead session's reactions can be recalled. */
  private sessionReactionKeys = new Map<
    string,
    Map<string, { messageId: string; chatId: string }>
  >();
  /**
   * Real inbound message ids (insertion-ordered, size-capped). Unlike the
   * TTL-swept seenMessages dedup map, entries survive long queue waits, so a
   * turn that starts minutes after its message arrived still gets a reaction.
   */
  private inboundMessageIds = new Set<string>();
  /**
   * Token cache for proactive sends. The stream SDK only refreshes its token
   * on (re)connect, so a long-lived socket serves a stale one after ~2h.
   */
  private proactiveToken?: { token: string; expiresAt: number };
  private readonly interactiveCardConfig: DingtalkInteractiveCardConfig;
  private readonly aggregateBackgroundAgentResponses: boolean;
  protected readonly interactiveCardClient?: DingtalkInteractiveCardClient;
  private statusCardController?: StatusCardController;
  private questionCardController?: QuestionCardController;
  private interactionPresenter?: DingtalkInteractionPresenter;
  private readonly inboundCardOwners = new Map<string, CardRunCorrelation>();
  private readonly cardRunBySession = new Map<string, string>();
  private readonly cardRuns = new Map<string, CardRunCorrelation>();
  // Keyed by runId, not segmentId: a mid-turn segment reset (response
  // boundary, input requested) mints a fresh segment UUID but the projection
  // state must survive it, or a marker split across the reset leaks.
  private readonly fileProjectors = new Map<
    string,
    { sessionId: string; projector: OutboundFileProjector }
  >();
  private readonly blockFileProjectors = new Map<
    string,
    { projector: OutboundFileProjector; reportedMarkers: number }
  >();
  // Sessions armed for block projection by onPromptStart and disarmed when
  // the turn settles (or the session dies). A block send that finds NO
  // projector state is only legitimate as a turn's FIRST block, which always
  // lands while armed: late sends from an evicted (/clear) or dead session
  // must be dropped, because recreating state would post the tail of a
  // force-split [FILE: ...] marker verbatim.
  private readonly blockProjectionArmed = new Set<string>();
  private readonly backgroundResponseAggregations = new Map<
    string,
    BackgroundResponseAggregation
  >();

  constructor(
    name: string,
    config: ChannelConfig,
    bridge: ChannelAgentBridge,
    options?: ChannelBaseOptions,
  ) {
    super(name, config, bridge, options);

    this.atSender =
      (config as unknown as Record<string, unknown>)['atSender'] === true;
    if (!this.config.instructions) {
      this.config.instructions = [
        '## DingTalk Channel',
        '',
        'You are responding through DingTalk.',
        IMAGE_INSTRUCTIONS,
      ].join('\n');
    } else if (!this.config.instructions.includes('[IMAGE:')) {
      this.config.instructions += IMAGE_INSTRUCTIONS;
    }
    if (
      config.blockStreaming !== 'on' &&
      !this.config.instructions.includes('[FILE:')
    ) {
      this.config.instructions += FILE_INSTRUCTIONS;
    }
    this.interactiveCardConfig = parseDingtalkInteractiveCardConfig(
      (config as DingtalkChannelConfig).interactiveCards,
    );
    const rawAggregateBackgroundAgentResponses = (
      config as DingtalkChannelConfig
    ).aggregateBackgroundAgentResponses;
    if (
      rawAggregateBackgroundAgentResponses !== undefined &&
      typeof rawAggregateBackgroundAgentResponses !== 'boolean'
    ) {
      throw new Error(
        `Channel "${name}" aggregateBackgroundAgentResponses must be a boolean.`,
      );
    }
    this.aggregateBackgroundAgentResponses =
      rawAggregateBackgroundAgentResponses === true;

    if (!config.clientId || !config.clientSecret) {
      throw new Error(
        `Channel "${name}" requires clientId and clientSecret for DingTalk.`,
      );
    }

    const rawUseConnectionManager = (config as DingtalkChannelConfig)
      .useConnectionManager;
    if (
      rawUseConnectionManager !== undefined &&
      typeof rawUseConnectionManager !== 'boolean'
    ) {
      throw new Error(
        `Channel "${name}" useConnectionManager must be a boolean.`,
      );
    }
    const useConnectionManager = rawUseConnectionManager ?? true;

    this.client = this.createClient(useConnectionManager);
    if (this.interactiveCardConfig.enabled) {
      this.interactiveCardClient = new DingtalkInteractiveCardClient({
        robotCode: config.clientId,
        getAccessToken: () => this.getProactiveToken(),
        invalidateAccessToken: (token) => {
          if (this.proactiveToken?.token === token) {
            this.proactiveToken = undefined;
          }
        },
      });
      if (
        this.interactiveCardConfig.statusCard.enabled &&
        config.blockStreaming !== 'on'
      ) {
        this.statusCardController = new StatusCardController({
          client: this.interactiveCardClient,
          cancelRun: (sessionId, runId) =>
            this.requestPromptRunCancellation(sessionId, runId),
          ...(config.model ? { model: config.model } : {}),
          onError: (operation, error) => {
            process.stderr.write(
              `[DingTalk:${this.name}] ${operation} failed: ${sanitizeLogText(String(error), 300)}\n`,
            );
          },
        });
      }
      if (this.interactiveCardConfig.questionCard.enabled) {
        this.questionCardController = new QuestionCardController({
          client: this.interactiveCardClient,
          timeoutMs: this.interactiveCardConfig.questionCard.timeoutMs,
          sendFallback: (chatId, text, sourceLabel) =>
            this.sendReply(chatId, text, undefined, sourceLabel),
          reserveRunProjection: (runId) =>
            this.interactionPresenter?.reserveProjection(runId),
          onError: (operation, error) => {
            process.stderr.write(
              `[DingTalk:${this.name}] ${operation} failed: ${sanitizeLogText(String(error), 300)}\n`,
            );
          },
        });
      }
      if (this.statusCardController || this.questionCardController) {
        this.interactionPresenter = new DingtalkInteractionPresenter({
          statusCards: this.statusCardController,
          questionCards: this.questionCardController,
          ...(config.blockStreaming !== 'on'
            ? {
                sendFallback: (
                  chatId: string,
                  text: string,
                  sessionId: string,
                  sourceLabel?: string,
                ) =>
                  this.sendFallbackReply(chatId, text, sessionId, sourceLabel),
              }
            : {}),
        });
      }
    }
    if (useConnectionManager) {
      this.connectionManager = new DingtalkConnectionManager({
        initialClient: this.client,
        createClient: () => this.createClient(true),
        getSocket: (client) =>
          (client as unknown as { socket?: DingtalkManagedSocket }).socket,
        onClientChanged: (client) => {
          this.client = client;
        },
        log: (message) => {
          process.stderr.write(
            `[DingTalk:${this.name}] ${sanitizeLogText(message, 200)}\n`,
          );
        },
      });
    }
  }

  private createClient(useConnectionManager: boolean): DWClient {
    const client = new DWClient({
      clientId: this.config.clientId!,
      clientSecret: this.config.clientSecret!,
      keepAlive: !useConnectionManager,
    });
    client.config.autoReconnect = !useConnectionManager;
    this.installStructuredDownstreamHandler(client);
    this.registerMessageHandler(client);
    return client;
  }

  private installStructuredDownstreamHandler(streamClient: DWClient): void {
    const client = streamClient as DingTalkClientInternals;
    client.debug = false;
    // Keep raw SDK downstream frames off stdout; this switch mirrors the SDK
    // dispatch table and should be checked when upgrading the DingTalk SDK.
    client.onDownStream = (raw: unknown) => {
      this.onDownStream(raw, client);
    };
  }

  private registerMessageHandler(client: DWClient): void {
    client.registerCallbackListener(TOPIC_ROBOT, (msg: DWClientDownStream) => {
      client.send(msg.headers.messageId, {
        status: EventAck.SUCCESS,
        message: 'ok',
      });
      this.onMessage(msg);
    });
    if (this.interactiveCardConfig.enabled) {
      client.registerCallbackListener(TOPIC_CARD, (msg: DWClientDownStream) => {
        this.onCardCallback(client, msg);
      });
    }
  }

  private onCardCallback(client: DWClient, msg: DWClientDownStream): void {
    const callback = parseDingtalkCardCallback(msg.data);
    const actorId = callback?.actorId ?? parseDingtalkCardActorId(msg.data);
    let result: DingtalkCardCallbackResult;
    try {
      result = callback
        ? this.routeCardCallback(callback)
        : { kind: 'ignored', ...(actorId ? { actorId } : {}) };
    } catch (err) {
      process.stderr.write(
        `[DingTalk:${this.name}] card callback routing failed: ${sanitizeLogText(String(err), 200)}\n`,
      );
      result = { kind: 'ignored', ...(actorId ? { actorId } : {}) };
    }
    client.send(msg.headers.messageId, {
      status: EventAck.SUCCESS,
      message: 'ok',
    });
    if (result.kind === 'accepted') {
      void result.execute().catch((err) => {
        process.stderr.write(
          `[DingTalk:${this.name}] card callback action failed: ${sanitizeLogText(String(err), 200)}\n`,
        );
      });
    } else if (result.kind === 'forbidden') {
      void this.sendCardInteractionFeedback(
        result.actorId,
        result.target,
      ).catch((err) => {
        process.stderr.write(
          `[DingTalk:${this.name}] card interaction feedback failed: ${sanitizeLogText(String(err), 200)}\n`,
        );
      });
    }
  }

  protected routeCardCallback(
    callback: DingtalkCardCallback,
  ): DingtalkCardCallbackResult {
    if (callback.actionId === 'btn_stop') {
      return (
        this.statusCardController?.claimStop(
          callback.outTrackId,
          callback.actorId,
        ) ?? { kind: 'ignored', actorId: callback.actorId }
      );
    }
    return (
      this.questionCardController?.claim(callback) ?? {
        kind: 'ignored',
        actorId: callback.actorId,
      }
    );
  }

  private onDownStream(raw: unknown, client: DingTalkClientInternals): void {
    this.connectionManager?.noteActivity(client);
    const decoded = this.decodeDownStream(raw);
    let msg: DWClientDownStream;
    try {
      const parsed = JSON.parse(decoded.text) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        process.stderr.write(
          `[DingTalk:${this.name}] downstream parsed to non-object, ignoring.\n`,
        );
        return;
      }
      msg = parsed as DWClientDownStream;
    } catch (err) {
      process.stderr.write(
        `[DingTalk:${this.name}] Failed to parse downstream: ${sanitizeLogText(
          String(err),
          200,
        )}\n`,
      );
      return;
    }
    const headers: Record<string, unknown> =
      msg.headers && typeof msg.headers === 'object' ? msg.headers : {};
    const type = typeof msg.type === 'string' ? msg.type : '';
    const topic = typeof headers['topic'] === 'string' ? headers['topic'] : '';
    const messageId =
      typeof headers['messageId'] === 'string' ? headers['messageId'] : '';

    process.stderr.write(
      `[DingTalk:${this.name}] downstream type=${sanitizeLogText(type, 40)} topic=${sanitizeLogText(
        topic,
        80,
      )} messageId=${sanitizeLogText(messageId, 80)} bytes=${decoded.bytes}\n`,
    );

    if ((type === 'CALLBACK' || type === 'EVENT') && (!topic || !messageId)) {
      process.stderr.write(
        `[DingTalk:${this.name}] Ignoring downstream with invalid routing headers.\n`,
      );
      return;
    }

    const normalizedMsg = {
      ...msg,
      headers: { ...headers, topic, messageId },
    } as DWClientDownStream;

    switch (type) {
      case 'SYSTEM':
        this.callDownStreamHandler(client, 'onSystem', normalizedMsg);
        if (topic === 'disconnect') {
          this.connectionManager?.requestReconnect(client, 'SYSTEM disconnect');
        }
        break;
      case 'EVENT':
        this.callDownStreamHandler(client, 'onEvent', normalizedMsg);
        break;
      case 'CALLBACK':
        this.callDownStreamHandler(client, 'onCallback', normalizedMsg);
        break;
      default:
        process.stderr.write(
          `[DingTalk:${this.name}] Ignoring downstream type ${sanitizeLogText(
            type || 'unknown',
            40,
          )}.\n`,
        );
    }
  }

  private callDownStreamHandler(
    client: DingTalkClientInternals,
    method: 'onSystem' | 'onEvent' | 'onCallback',
    msg: DWClientDownStream,
  ): void {
    try {
      client[method](msg);
    } catch (err) {
      process.stderr.write(
        `[DingTalk:${this.name}] ${method} failed: ${sanitizeLogText(
          String(err),
          200,
        )}\n`,
      );
    }
  }

  private decodeDownStream(raw: unknown): { text: string; bytes: number } {
    if (typeof raw === 'string') {
      return { text: raw, bytes: Buffer.byteLength(raw) };
    }
    if (Buffer.isBuffer(raw)) {
      return { text: raw.toString('utf8'), bytes: raw.length };
    }
    if (raw instanceof Uint8Array) {
      return { text: Buffer.from(raw).toString('utf8'), bytes: raw.byteLength };
    }
    if (raw instanceof ArrayBuffer) {
      return {
        text: Buffer.from(raw).toString('utf8'),
        bytes: raw.byteLength,
      };
    }
    return { text: String(raw), bytes: Buffer.byteLength(String(raw)) };
  }

  async connect(): Promise<void> {
    if (this.connectionManager) {
      await this.connectionManager.start();
    } else {
      await this.client.connect();
    }

    // Periodically clean up dedup map
    this.dedupTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, ts] of this.seenMessages) {
        if (now - ts > DEDUP_TTL_MS) {
          this.seenMessages.delete(id);
        }
      }
    }, 60_000);

    process.stderr.write(`[DingTalk:${this.name}] Connected via stream.\n`);
  }

  /**
   * A group message with no conversationId can't be routed to a stable shared
   * session (chatId would fall back to the expiring sessionWebhook), so it is
   * dropped on ingestion. Exposed for testing the drop rule.
   */
  static isUnroutableGroupMessage(
    isGroup: boolean,
    conversationId: string | undefined,
  ): boolean {
    return isGroup && !conversationId;
  }

  private resolveSessionWebhook(chatId: string): string | undefined {
    const value = this.webhooks.get(chatId);
    if (!value) return undefined;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' &&
        url.port === '' &&
        ROBOT_MESSAGE_HOSTS.has(url.hostname)
        ? url.toString()
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async uploadOutboundFile(
    filePath: string,
  ): Promise<{ file: ValidatedFile; mediaId: string }> {
    const file = readValidatedFile(filePath, this.config.cwd);
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.getProactiveToken();
      try {
        return { file, mediaId: await uploadDingTalkFile(file, token) };
      } catch (error) {
        if (
          error instanceof DingTalkMediaUploadError &&
          error.authFailure &&
          attempt === 0
        ) {
          this.proactiveToken = undefined;
          continue;
        }
        throw error;
      }
    }
    throw new Error('DingTalk file upload returned no MediaID');
  }

  private async deliverFiles(
    paths: readonly string[],
    send: (file: ValidatedFile, mediaId: string) => Promise<void>,
    preflight?: () => void,
  ): Promise<string[]> {
    const notices: string[] = [];
    for (const filePath of paths) {
      const displayName = safeFileName(filePath);
      try {
        preflight?.();
        const { file, mediaId } = await this.uploadOutboundFile(filePath);
        await send(file, mediaId);
      } catch (error) {
        process.stderr.write(
          `[DingTalk:${this.name}] outbound file delivery failed (${sanitizeLogText(displayName, 200)}): ${sanitizeLogText(
            error instanceof Error ? error.message : String(error),
            300,
          )}\n`,
        );
        notices.push(`[File delivery failed: ${displayName}]`);
      }
    }
    return notices;
  }

  private async sendSessionFile(
    chatId: string,
    file: ValidatedFile,
    mediaId: string,
  ): Promise<void> {
    const webhook = this.resolveSessionWebhook(chatId);
    if (!webhook) throw new Error('DingTalk session webhook unavailable');

    let response: Response;
    try {
      response = await fetch(webhook, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'file',
          file: {
            mediaId,
            fileName: file.fileName,
            fileType: file.fileType,
          },
        }),
        signal: AbortSignal.timeout(REPLY_FETCH_TIMEOUT_MS),
      });
    } catch {
      throw new Error('DingTalk file delivery failed: network request failed');
    }
    const body = await response.text().catch(() => '');
    if (!response.ok) {
      throw new Error(`DingTalk file delivery failed: HTTP ${response.status}`);
    }
    if (!body.trim()) return;

    let data: Record<string, unknown>;
    try {
      const parsed = JSON.parse(body) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return;
      data = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const code = data['errcode'] ?? data['code'];
    if (code !== undefined && String(code) !== '0') {
      throw new Error(`DingTalk file delivery failed: API code ${code}`);
    }
  }

  private appendFileNotices(text: string, notices: readonly string[]): string {
    if (notices.length === 0) return text;
    const prefix = text.trimEnd();
    return `${prefix}${prefix ? '\n' : ''}${notices.join('\n')}`;
  }

  private async prepareReplyOutput(
    chatId: string,
    text: string,
    streamed?: OutboundFileProjector,
  ): Promise<string> {
    return this.prepareFileOutput(
      text,
      (file, mediaId) => this.sendSessionFile(chatId, file, mediaId),
      streamed,
      () => {
        if (!this.resolveSessionWebhook(chatId)) {
          throw new Error('DingTalk session webhook unavailable');
        }
      },
    );
  }

  private async prepareFileOutput(
    text: string,
    send: (file: ValidatedFile, mediaId: string) => Promise<void>,
    streamed?: OutboundFileProjector,
    preflight?: () => void,
  ): Promise<string> {
    const projection = projectFileText(text);
    const streamedMarkers = streamed ? streamed.result('').markerCount : 0;
    if (projection.markerCount > 0 || streamedMarkers > 0) {
      process.stderr.write(
        `[DingTalk:${this.name}] file markers projected (final=${projection.markerCount}, streamed=${streamedMarkers})\n`,
      );
    }

    if (
      this.config.blockStreaming === 'on' &&
      (projection.markerCount > 0 || streamedMarkers > 0)
    ) {
      return this.prepareOutgoingText(
        withFileUnavailableNotice(projection.text),
      );
    }

    const notices: string[] = [];
    if (projection.invalidMarkers > 0) {
      notices.push('[File delivery failed: invalid marker]');
    }
    if (projection.excessMarkers > 0) {
      notices.push('[File delivery failed: response file limit exceeded]');
    }
    if (streamedMarkers > projection.markerCount) {
      notices.push(FILE_UNAVAILABLE_NOTICE);
    }
    notices.push(
      ...(await this.deliverFiles(projection.paths, send, preflight)),
    );
    return this.prepareOutgoingText(
      this.appendFileNotices(projection.text, notices),
    );
  }

  private async prepareOutgoingText(text: string): Promise<string> {
    const markers = findImageMarkers(text);
    if (markers.length === 0) return text;

    const replacements: string[] = [];
    for (const marker of markers) {
      const fileName =
        basename(marker.path)
          .replace(/[\r\n[\]]+/g, '_')
          .slice(0, 100) || 'image';
      try {
        const image = readValidatedImage(marker.path, {
          workspaceDir: this.config.cwd,
        });
        let mediaId: string | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          const token = await this.getProactiveToken();
          try {
            mediaId = await uploadDingTalkImage(image, token);
            break;
          } catch (error) {
            if (
              error instanceof DingTalkMediaUploadError &&
              error.authFailure &&
              attempt === 0
            ) {
              this.proactiveToken = undefined;
              continue;
            }
            throw error;
          }
        }
        if (!mediaId) {
          throw new Error('DingTalk media upload returned no MediaID');
        }
        replacements.push(`![image](${mediaId})`);
      } catch (error) {
        process.stderr.write(
          `[DingTalk:${this.name}] outbound image upload failed (${sanitizeLogText(
            fileName,
            100,
          )}): ${sanitizeLogText(
            error instanceof Error ? error.message : String(error),
            300,
          )}\n`,
        );
        replacements.push(`[Image delivery failed: ${fileName}]`);
      }
    }

    return replaceImageMarkers(text, markers, replacements);
  }

  private async sendReply(
    chatId: string,
    text: string,
    atUserId?: string,
    sourceLabel?: string,
    prepared = false,
  ): Promise<void> {
    // chatId is a conversationId — resolve to the latest sessionWebhook.
    const webhook = this.webhooks.get(chatId);
    if (!webhook) {
      process.stderr.write(
        `[DingTalk:${this.name}] No webhook for chatId ${chatId}, cannot send.\n`,
      );
      return;
    }

    const outgoingText = prepared
      ? text
      : await this.prepareReplyOutput(chatId, text);
    if (!outgoingText.trim()) return;
    const mentionPrefix = atUserId ? `@${atUserId}\n\n` : '';
    const sourcePrefix =
      sourceLabel && outgoingText.trim().length > 0
        ? `${escapeDingTalkMarkdown(sourceLabel)}\n\n`
        : '';
    const contentLimit =
      DINGTALK_CHUNK_LIMIT - mentionPrefix.length - sourcePrefix.length;
    if (contentLimit <= 0) {
      throw new Error('DingTalk source label exceeds the message limit.');
    }
    const chunks = normalizeDingTalkMarkdown(outgoingText, contentLimit).map(
      (chunk, index) =>
        `${index === 0 ? mentionPrefix : ''}${sourcePrefix}${chunk}`,
    );
    const title = extractTitle(outgoingText);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const isMention = i === 0 && atUserId !== undefined;
      const body = {
        msgtype: 'markdown',
        markdown: {
          title: i === 0 ? title : `${title} (cont.)`,
          text: chunk,
        },
        ...(isMention ? { at: { atUserIds: [atUserId] } } : {}),
      };

      let resp: Response;
      try {
        resp = await fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REPLY_FETCH_TIMEOUT_MS),
        });
      } catch (err) {
        process.stderr.write(
          `[DingTalk:${this.name}] sendMessage failed: ${sanitizeLogText(
            err instanceof Error ? err.message : String(err),
            300,
          )}\n`,
        );
        throw err;
      }

      if (isMention && process.env['QWEN_CHANNEL_DEBUG_MENTIONS'] === '1') {
        const payload = (await resp
          .clone()
          .json()
          .catch(() => undefined)) as unknown;
        const response =
          payload && typeof payload === 'object'
            ? (payload as Record<string, unknown>)
            : {};
        const value = response['errcode'] ?? response['code'];
        const code =
          typeof value === 'number' || typeof value === 'string'
            ? String(value)
            : 'unknown';
        process.stderr.write(
          `[DingTalk:${this.name}] mention delivery status=${resp.status} code=${code}\n`,
        );
      }

      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        process.stderr.write(
          `[DingTalk:${this.name}] sendMessage failed: HTTP ${resp.status} ${detail}\n`,
        );
      }
    }
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    await this.sendReply(chatId, text);
  }

  protected override async sendThreadMessage(
    chatId: string,
    _threadId: string | undefined,
    text: string,
    sourceLabel?: string,
  ): Promise<void> {
    await this.sendReply(chatId, text, undefined, sourceLabel);
  }

  override supportsProactiveSend(): boolean {
    return true;
  }

  // Regular proactive paths accept only group targets; webhook tasks may use
  // DMs through the one-to-one API.
  protected override supportsProactiveTarget(target: SessionTarget): boolean {
    return (
      target.isGroup === true &&
      target.threadId === undefined &&
      this.isStableTargetId(target.chatId)
    );
  }

  protected override supportsProactiveDeliveryTarget(
    target: SessionTarget,
  ): boolean {
    return (
      typeof target.isGroup === 'boolean' &&
      target.threadId === undefined &&
      this.isStableTargetId(target.chatId)
    );
  }

  protected override supportsProactiveWebhookTarget(
    target: SessionTarget,
  ): boolean {
    return (
      typeof target.isGroup === 'boolean' &&
      target.threadId === undefined &&
      this.isStableTargetId(target.chatId)
    );
  }

  /**
   * Single-shot cold send: a failed chunk aborts the remainder (already-sent
   * chunks are not recalled) and the error surfaces in the loop's lastError.
   */
  protected override async pushProactive(
    target: SessionTarget,
    text: string,
    sourceLabel?: string,
  ): Promise<void> {
    if (!text.trim()) return;

    const plan = await this.createProactiveTextDelivery(
      target,
      text,
      sourceLabel,
    );
    if (!plan) return;
    try {
      await this.deliverProactiveText(target, plan);
    } catch (error) {
      throw new ProactiveTextDeliveryError(plan, error);
    }
  }

  private async createProactiveTextDelivery(
    target: SessionTarget,
    text: string,
    sourceLabel?: string,
  ): Promise<ProactiveTextDelivery | undefined> {
    const outgoingText = await this.prepareFileOutput(text, (file, mediaId) =>
      this.sendProactiveFile(target, file, mediaId),
    );
    if (!outgoingText.trim()) return undefined;
    const sourcePrefix = sourceLabel
      ? `${escapeDingTalkMarkdown(sourceLabel)}\n\n`
      : '';
    const contentLimit = DINGTALK_CHUNK_LIMIT - sourcePrefix.length;
    if (contentLimit <= 0) {
      throw new Error('DingTalk source label exceeds the message limit.');
    }
    const chunks = normalizeDingTalkMarkdown(outgoingText, contentLimit).map(
      (chunk) => `${sourcePrefix}${chunk}`,
    );
    return { title: extractTitle(outgoingText), chunks, nextChunk: 0 };
  }

  private async deliverProactiveText(
    target: SessionTarget,
    plan: ProactiveTextDelivery,
  ): Promise<void> {
    while (plan.nextChunk < plan.chunks.length) {
      const index = plan.nextChunk;
      await this.sendProactiveChunk(
        target,
        index === 0 ? plan.title : `${plan.title} (cont.)`,
        plan.chunks[index]!,
        `chunk ${index + 1}/${plan.chunks.length}`,
      );
      plan.nextChunk++;
    }
  }

  private async getProactiveToken(): Promise<string> {
    const cached = this.proactiveToken;
    if (cached && Date.now() < cached.expiresAt) return cached.token;

    const url = `${TOKEN_API}?appkey=${encodeURIComponent(
      this.config.clientId!,
    )}&appsecret=${encodeURIComponent(this.config.clientSecret!)}`;
    let data: DingTalkTokenResponse;
    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(PROACTIVE_FETCH_TIMEOUT_MS),
      });
      data = (await resp.json()) as DingTalkTokenResponse;
    } catch {
      process.stderr.write(
        `[DingTalk:${this.name}] access token fetch failed.\n`,
      );
      throw new Error('DingTalk access token fetch failed');
    }
    if (!data.access_token) {
      const errmsg = sanitizeLogText(String(data.errmsg ?? ''), 200);
      process.stderr.write(
        `[DingTalk:${this.name}] access token request failed: gettoken errcode=${data.errcode} ${errmsg}\n`,
      );
      throw new DingtalkCardRequestError(
        `DingTalk access token request failed: gettoken errcode=${data.errcode}${errmsg ? ` ${errmsg}` : ''}`,
        !PERMANENT_TOKEN_ERROR_CODES.has(Number(data.errcode)),
      );
    }
    this.proactiveToken = {
      token: data.access_token,
      // Refresh a minute early so a fire mid-expiry doesn't race the TTL.
      expiresAt:
        Date.now() + Math.max(60, (data.expires_in ?? 7200) - 60) * 1000,
    };
    return data.access_token;
  }

  private sendCardInteractionFeedback(
    actorId: string,
    target?: { chatId: string; isGroup: boolean },
  ): Promise<void> {
    if (target?.isGroup) {
      return this.sendProactiveChunk(
        {
          channelName: this.name,
          senderId: actorId,
          chatId: target.chatId,
          isGroup: true,
        },
        '卡片操作',
        '仅任务发起人可以操作这张卡片，本次操作未生效。',
        'card interaction feedback',
      );
    }
    return this.sendProactiveChunk(
      {
        channelName: this.name,
        senderId: actorId,
        chatId: actorId,
        isGroup: false,
      },
      '卡片操作',
      '你无权操作这张卡片，仅任务发起人可以提交或停止。',
      'card interaction feedback',
    );
  }

  private async sendProactiveChunk(
    target: SessionTarget,
    title: string,
    text: string,
    chunkLabel: string,
  ): Promise<void> {
    return this.sendProactivePayload(
      target,
      PROACTIVE_MSG_KEY,
      { title, text },
      chunkLabel,
    );
  }

  private async sendProactiveFile(
    target: SessionTarget,
    file: ValidatedFile,
    mediaId: string,
  ): Promise<void> {
    return this.sendProactivePayload(
      target,
      PROACTIVE_FILE_MSG_KEY,
      { mediaId, fileName: file.fileName, fileType: file.fileType },
      `file ${file.fileName}`,
    );
  }

  private async sendProactivePayload(
    target: SessionTarget,
    msgKey: string,
    msgParam: Record<string, string>,
    chunkLabel: string,
  ): Promise<void> {
    const targetKind = target.isGroup === true ? 'group' : 'dm';
    for (let attempt = 0; ; attempt++) {
      const token = await this.getProactiveToken();
      let resp: Response;
      try {
        const targetBody =
          target.isGroup === true
            ? { openConversationId: target.chatId }
            : { userIds: [target.chatId] };
        resp = await fetch(
          target.isGroup === true ? GROUP_MSG_API : DIRECT_MSG_API,
          {
            method: 'POST',
            headers: {
              'x-acs-dingtalk-access-token': token,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              robotCode: this.config.clientId!,
              ...targetBody,
              msgKey,
              msgParam: JSON.stringify(msgParam),
            }),
            signal: AbortSignal.timeout(PROACTIVE_FETCH_TIMEOUT_MS),
          },
        );
      } catch (err) {
        const cause = (err as { cause?: unknown }).cause;
        process.stderr.write(
          `[DingTalk:${this.name}] proactive send error (${targetKind}, ${chunkLabel}): ${err}${cause ? ` (${cause})` : ''}\n`,
        );
        throw new Error(
          `DingTalk proactive send failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (resp.status === 401 && attempt === 0) {
        // Stale or revoked token — refresh once and retry this chunk.
        this.proactiveToken = undefined;
        await resp.body?.cancel();
        continue;
      }
      if (!resp.ok) {
        const detail = sanitizeLogText(await resp.text().catch(() => ''), 300);
        process.stderr.write(
          `[DingTalk:${this.name}] proactive send failed (${targetKind}, ${chunkLabel}): HTTP ${resp.status} ${detail}\n`,
        );
        throw new Error(
          `DingTalk proactive send failed: HTTP ${resp.status}${detail ? ` ${detail}` : ''}`,
        );
      }
      if (target.isGroup === true) {
        if (msgKey !== PROACTIVE_FILE_MSG_KEY) {
          await resp.body?.cancel();
          return;
        }
        let data: Record<string, unknown>;
        try {
          const parsed = (await resp.json()) as unknown;
          data =
            parsed && typeof parsed === 'object' && !Array.isArray(parsed)
              ? (parsed as Record<string, unknown>)
              : {};
        } catch {
          throw new Error(
            'DingTalk file delivery failed: invalid JSON response',
          );
        }
        const code = data['errcode'] ?? data['code'];
        if (code !== undefined && String(code) !== '0') {
          throw new Error(`DingTalk file delivery failed: API code ${code}`);
        }
        if (
          typeof data['processQueryKey'] !== 'string' ||
          !data['processQueryKey'].trim()
        ) {
          throw new Error(
            'DingTalk file delivery failed: missing processQueryKey',
          );
        }
        return;
      }
      if (target.isGroup === false) {
        let data: DingTalkDirectMessageResponse;
        try {
          data = (await resp.json()) as DingTalkDirectMessageResponse;
        } catch {
          process.stderr.write(
            `[DingTalk:${this.name}] proactive send failed (${targetKind}, ${chunkLabel}): invalid JSON response\n`,
          );
          throw new Error(
            'DingTalk proactive send failed: invalid JSON response',
          );
        }
        if (data.invalidStaffIdList?.includes(target.chatId)) {
          process.stderr.write(
            `[DingTalk:${this.name}] proactive send failed (${targetKind}, ${chunkLabel}): invalid direct recipient\n`,
          );
          throw new Error(
            'DingTalk proactive send failed: invalid direct recipient',
          );
        }
        if (data.flowControlledStaffIdList?.includes(target.chatId)) {
          process.stderr.write(
            `[DingTalk:${this.name}] proactive send failed (${targetKind}, ${chunkLabel}): direct recipient rate limited\n`,
          );
          throw new Error(
            'DingTalk proactive send failed: direct recipient rate limited',
          );
        }
        if (
          msgKey === PROACTIVE_FILE_MSG_KEY &&
          !data.processQueryKey?.trim()
        ) {
          throw new Error(
            'DingTalk file delivery failed: missing processQueryKey',
          );
        }
        return;
      }
      await resp.body?.cancel();
      return;
    }
  }

  private getAccessToken(): string | undefined {
    return this.client.getConfig().access_token;
  }

  private async emotionApi(
    endpoint: 'reply' | 'recall',
    msgId: string,
    conversationId: string,
  ): Promise<void> {
    const robotCode = this.config.clientId;
    if (!robotCode || !msgId || !conversationId) return;
    try {
      const token = this.config.clientSecret
        ? await this.getProactiveToken()
        : this.getAccessToken();
      if (!token) return;
      for (let attempt = 0; attempt < EMOTION_MAX_ATTEMPTS; attempt++) {
        const resp = await fetch(`${EMOTION_API}/${endpoint}`, {
          method: 'POST',
          headers: {
            'x-acs-dingtalk-access-token': token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            robotCode,
            openMsgId: msgId,
            openConversationId: conversationId,
            emotionType: 2,
            emotionName: ACK_REACTION_NAME,
            textEmotion: {
              emotionId: ACK_EMOTION_ID,
              emotionName: ACK_REACTION_NAME,
              text: ACK_REACTION_NAME,
              backgroundId: ACK_EMOTION_BG_ID,
            },
          }),
        });
        if (resp.ok) return;

        const isTransient = resp.status === 429 || resp.status >= 500;
        if (isTransient && attempt < EMOTION_MAX_ATTEMPTS - 1) {
          await resp.body?.cancel();
          await new Promise((resolve) =>
            setTimeout(resolve, EMOTION_RETRY_BASE_DELAY_MS * 2 ** attempt),
          );
          continue;
        }

        const detail = sanitizeLogText(await resp.text().catch(() => ''), 500);
        process.stderr.write(
          `[DingTalk:${this.name}] emotion/${endpoint} failed after ${attempt + 1}/${EMOTION_MAX_ATTEMPTS} attempts: ${resp.status} ${detail}\n`,
        );
        return;
      }
    } catch {
      // best-effort, don't break message flow
    }
  }

  private async attachReaction(
    msgId: string,
    conversationId: string,
  ): Promise<void> {
    await this.emotionApi('reply', msgId, conversationId);
  }

  private async recallReaction(
    msgId: string,
    conversationId: string,
  ): Promise<void> {
    await this.emotionApi('recall', msgId, conversationId);
  }

  disconnect(): void {
    if (this.dedupTimer) {
      clearInterval(this.dedupTimer);
    }
    this.statusCardController?.dispose();
    this.drainBackgroundResponseAggregations();
    this.activeReactionKeys.clear();
    this.sessionReactionKeys.clear();
    if (this.connectionManager) {
      this.connectionManager.stop();
    } else {
      this.client.disconnect();
    }
    process.stderr.write(`[DingTalk:${this.name}] Disconnected.\n`);
  }

  /** Stable API targets are conversation or user IDs, never webhook URLs. */
  private isStableTargetId(chatId: string): boolean {
    return !!chatId && !/^https?:\/\//i.test(chatId);
  }

  private reactionKey(messageId: string, conversationId: string): string {
    return `${conversationId}:${messageId}`;
  }

  private rememberInboundMessageId(msgId: string): void {
    this.inboundMessageIds.delete(msgId);
    this.inboundMessageIds.add(msgId);
    if (this.inboundMessageIds.size > 1000) {
      const oldest = this.inboundMessageIds.values().next().value;
      if (oldest !== undefined) this.inboundMessageIds.delete(oldest);
    }
  }

  private logReactionFailure(action: string, err: unknown): void {
    process.stderr.write(
      `[DingTalk:${this.name}] ${action} failed: ${err instanceof Error ? err.message : err}\n`,
    );
  }

  private startReaction(
    chatId: string,
    messageId?: string,
    sessionId?: string,
  ): void {
    if (!messageId || !this.isStableTargetId(chatId)) return;
    // Loop lifecycle events carry the internal job id as messageId; the
    // emotion API only accepts ids of real inbound messages, so skip anything
    // we never saw arrive.
    if (!this.inboundMessageIds.has(messageId)) return;
    const key = this.reactionKey(messageId, chatId);
    if (this.activeReactionKeys.has(key)) return;
    this.activeReactionKeys.add(key);
    if (sessionId) {
      let keys = this.sessionReactionKeys.get(sessionId);
      if (!keys) {
        keys = new Map();
        this.sessionReactionKeys.set(sessionId, keys);
      }
      keys.set(key, { messageId, chatId });
    }
    this.attachReaction(messageId, chatId)
      .then(() => {
        if (!this.activeReactionKeys.has(key)) {
          void this.recallReaction(messageId, chatId).catch((err) => {
            this.logReactionFailure('late reaction recall', err);
          });
        }
      })
      .catch((err) => {
        this.activeReactionKeys.delete(key);
        this.logReactionFailure('reaction attach', err);
      });
  }

  private stopReaction(
    chatId: string,
    messageId?: string,
    sessionId?: string,
  ): void {
    if (!messageId || !this.isStableTargetId(chatId)) return;
    const key = this.reactionKey(messageId, chatId);
    if (sessionId) {
      const keys = this.sessionReactionKeys.get(sessionId);
      if (keys) {
        keys.delete(key);
        if (keys.size === 0) this.sessionReactionKeys.delete(sessionId);
      }
    }
    if (!this.activeReactionKeys.delete(key)) return;
    this.recallReaction(messageId, chatId).catch((err) => {
      this.logReactionFailure('reaction recall', err);
    });
  }

  /** Recall reactions left behind when a session dies without terminal lifecycle events. */
  override onSessionDied(sessionId: string): void {
    this.blockProjectionArmed.delete(sessionId);
    this.blockFileProjectors.delete(sessionId);
    for (const [runId, state] of this.fileProjectors) {
      if (state.sessionId === sessionId) this.fileProjectors.delete(runId);
    }
    const bufferedTargets = this.bufferedMentionTargetsBySession.get(sessionId);
    if (bufferedTargets) {
      this.bufferedMentionTargetsBySession.delete(sessionId);
      for (const messageId of bufferedTargets) {
        this.bufferedMentionTargets.delete(messageId);
        this.mentionTargets.delete(messageId);
      }
    }
    this.sessionMentionTargets.delete(sessionId);
    // A session dying after segments arrived but before the terminal signal is
    // precisely the case the partial-card fallback exists for; dropping the
    // buffer here would lose text the agent already produced, which the
    // pre-aggregation code always delivered on arrival.
    this.drainBackgroundResponseAggregations(sessionId);
    const cardRunId = this.cardRunBySession.get(sessionId);
    if (cardRunId) {
      this.cardRunBySession.delete(sessionId);
      this.interactionPresenter?.terminalizeRun(cardRunId, 'cancelled');
      this.cardRuns.delete(cardRunId);
    }
    const keys = this.sessionReactionKeys.get(sessionId);
    if (keys) {
      this.sessionReactionKeys.delete(sessionId);
      for (const [key, { messageId, chatId }] of keys) {
        if (this.activeReactionKeys.delete(key)) {
          void this.recallReaction(messageId, chatId).catch((err) => {
            this.logReactionFailure('session-death reaction recall', err);
          });
        }
      }
    }
    super.onSessionDied(sessionId);
  }

  protected override onSessionRetiring(sessionId: string): void {
    this.drainBackgroundResponseAggregations(sessionId);
  }

  protected override onTaskLifecycle(event: ChannelTaskLifecycleEvent): void {
    if (event.type === 'started') {
      this.startReaction(event.chatId, event.messageId, event.sessionId);
      const inboundOwner = event.messageId
        ? this.inboundCardOwners.get(event.messageId)
        : undefined;
      if (event.messageId) this.inboundCardOwners.delete(event.messageId);
      if (
        event.runId &&
        event.owner &&
        inboundOwner?.ownerId === event.owner.id
      ) {
        this.cardRuns.set(event.runId, inboundOwner);
        this.cardRunBySession.set(event.sessionId, event.runId);
        const sourceLabel = this.getResponseSourceLabel(event.sessionId);
        this.interactionPresenter?.registerRun(
          event.runId,
          event.owner.id,
          inboundOwner.target,
          event.sessionId,
          inboundOwner.sender,
          ...(sourceLabel ? [sourceLabel] : []),
        );
        this.interactionPresenter?.startStatusCard(event.runId);
      }
      return;
    }
    if (isTerminalTaskLifecycleType(event.type)) {
      if (event.messageId) this.mentionTargets.delete(event.messageId);
      this.stopReaction(event.chatId, event.messageId, event.sessionId);
      if (event.runId) {
        this.deleteFileProjectorsForRun(event.runId);
        if (event.type === 'failed') {
          this.interactionPresenter?.terminalizeRun(
            event.runId,
            'failed',
            event.error,
          );
        } else if (event.type === 'cancelled') {
          this.interactionPresenter?.terminalizeRun(
            event.runId,
            'cancelled',
            event.reason,
          );
        } else {
          this.interactionPresenter?.terminalizeRun(event.runId, 'completed');
        }
        this.cardRuns.delete(event.runId);
        if (this.cardRunBySession.get(event.sessionId) === event.runId) {
          this.cardRunBySession.delete(event.sessionId);
        }
      }
    }
  }

  protected override onPromptBufferDropped(
    _chatId: string,
    sessionId: string,
    messageIds: string[],
  ): void {
    for (const messageId of messageIds) {
      this.bufferedMentionTargets.delete(messageId);
      this.mentionTargets.delete(messageId);
      this.untrackBufferedMentionTarget(sessionId, messageId);
    }
  }

  protected override onPromptBufferDrained(
    _chatId: string,
    sessionId: string,
    messageIds: string[],
  ): void {
    for (const messageId of messageIds) {
      this.bufferedMentionTargets.delete(messageId);
      this.untrackBufferedMentionTarget(sessionId, messageId);
    }
    for (const messageId of messageIds.slice(0, -1)) {
      this.mentionTargets.delete(messageId);
    }
  }

  protected override onPromptBuffered(
    _chatId: string,
    sessionId: string,
    messageId?: string,
  ): void {
    if (messageId && this.mentionTargets.has(messageId)) {
      this.bufferedMentionTargets.add(messageId);
      let targets = this.bufferedMentionTargetsBySession.get(sessionId);
      if (!targets) {
        targets = new Set();
        this.bufferedMentionTargetsBySession.set(sessionId, targets);
      }
      targets.add(messageId);
    }
  }

  protected override onPromptStart(
    chatId: string,
    sessionId: string,
    messageId?: string,
  ): void {
    this.blockProjectionArmed.add(sessionId);
    if (messageId) {
      this.bufferedMentionTargets.delete(messageId);
      this.untrackBufferedMentionTarget(sessionId, messageId);
      const atUserId = this.mentionTargets.get(messageId);
      this.mentionTargets.delete(messageId);
      if (this.atSender && atUserId) {
        this.sessionMentionTargets.set(sessionId, atUserId);
      }
    }
    this.startReaction(chatId, messageId, sessionId);
  }

  override async handleInbound(envelope: Envelope): Promise<void> {
    if (!(await this.preflightInbound(envelope))) return;

    await this.processPreflightedInbound(envelope, async () => {
      const messageId = envelope.messageId;
      if (messageId && envelope.senderId) {
        this.inboundCardOwners.delete(messageId);
        this.inboundCardOwners.set(messageId, {
          ownerId: envelope.senderId,
          target: {
            chatId: envelope.chatId,
            isGroup: envelope.isGroup,
          },
          ...(this.atSender && envelope.isGroup
            ? {
                sender: {
                  senderName: envelope.senderName,
                },
              }
            : {}),
        });
        if (this.inboundCardOwners.size > 1000) {
          const oldest = this.inboundCardOwners.keys().next().value;
          if (oldest !== undefined) this.inboundCardOwners.delete(oldest);
        }
      }
      const atUserId = (envelope as MentionTargetEnvelope)[mentionTarget];
      if (this.atSender && messageId && atUserId) {
        this.mentionTargets.set(messageId, atUserId);
      }

      await this.processInbound(envelope);
    });
  }

  protected override async processInbound(envelope: Envelope): Promise<void> {
    const messageId = envelope.messageId;
    try {
      await super.processInbound(envelope);
    } finally {
      if (messageId && !this.bufferedMentionTargets.has(messageId)) {
        this.mentionTargets.delete(messageId);
      }
    }
  }

  private untrackBufferedMentionTarget(
    sessionId: string,
    messageId: string,
  ): void {
    const targets = this.bufferedMentionTargetsBySession.get(sessionId);
    if (!targets) return;
    targets.delete(messageId);
    if (targets.size === 0)
      this.bufferedMentionTargetsBySession.delete(sessionId);
  }

  protected override onPromptEnd(
    chatId: string,
    sessionId: string,
    messageId?: string,
  ): void {
    this.settleBlockFileProjector(chatId, sessionId);
    this.sessionMentionTargets.delete(sessionId);
    this.stopReaction(chatId, messageId, sessionId);
  }

  /**
   * Turn end is the only point where the block projector's held state can be
   * settled: ChannelBase drains the turn's queued block sends before calling
   * onPromptEnd, so everything already appended belongs to this turn. Flush
   * the held candidate bytes (a trailing `[FILE:` prefix the stream never
   * completed) before deleting the entry — a later delete-without-settle
   * would silently drop them from the delivered answer. Also disarm the
   * session: /clear eviction and session death settle WITHOUT draining the
   * turn's send chain, and any block that lands afterwards must be dropped
   * rather than recreating projector state.
   */
  private settleBlockFileProjector(chatId: string, sessionId: string): void {
    this.blockProjectionArmed.delete(sessionId);
    const state = this.blockFileProjectors.get(sessionId);
    if (!state) return;
    this.blockFileProjectors.delete(sessionId);
    const tail = state.projector.complete();
    if (!tail.trim()) return;
    // Deliberately fire-and-forget: complete() can only return a strict
    // prefix of '[FILE:' (at most 5 chars, no path bytes), so the worst case
    // is a stray fragment landing out of order with the next turn — not a
    // leak — and blocking settle on a delivery that may hang is worse.
    void this.sendReply(
      chatId,
      tail,
      undefined,
      this.getResponseSourceLabel(sessionId),
    ).catch((err) => {
      process.stderr.write(
        `[DingTalk:${this.name}] projector tail delivery failed for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    });
  }

  /** Deliver every Agent segment immediately unless aggregation is enabled. */
  override async dispatchBackgroundResponse(
    sessionId: string,
    text: string,
    context?: BackgroundResponseContext,
  ): Promise<void> {
    const target = this.router.getTarget(sessionId);
    if (
      !target ||
      target.channelName !== this.name ||
      (context !== undefined && context.kind !== 'agent')
    ) {
      return super.dispatchBackgroundResponse(sessionId, text, context);
    }

    const canAggregate =
      this.aggregateBackgroundAgentResponses &&
      context?.kind === 'agent' &&
      typeof context.turnComplete === 'boolean';
    if (!canAggregate) {
      if (text.trim().length === 0) {
        return super.dispatchBackgroundResponse(sessionId, text, context);
      }
      return super.dispatchBackgroundResponse(
        sessionId,
        this.formatBackgroundAgentResponse(text, context?.label),
        context,
      );
    }

    const key = JSON.stringify([sessionId, context.taskId]);
    let current = this.backgroundResponseAggregations.get(key);
    if (!current && text.trim().length === 0) {
      return super.dispatchBackgroundResponse(sessionId, text, context);
    }
    if (!current) {
      const delivery = await this.resolveBackgroundResponseDelivery(sessionId);
      if (!delivery || this.router.getTarget(sessionId) !== delivery.target) {
        return;
      }
      current =
        this.backgroundResponseAggregations.get(key) ??
        this.createBackgroundResponseAggregation(
          key,
          sessionId,
          context,
          delivery.target,
          delivery.sourceLabel,
        );
    }

    current.status = context.status;
    current.label = context.label ?? current.label;
    if (text.trim().length > 0) current.parts.push(text);

    if (!context.turnComplete) {
      this.scheduleBackgroundResponseAggregationFlush(key, current);
      return;
    }

    current.turnComplete = true;
    current.completionPartial = context.partial === true;
    if (current.timeoutTimer) clearTimeout(current.timeoutTimer);
    current.timeoutTimer = undefined;
    await this.flushBackgroundResponseAggregation(key, current);
  }

  private async flushBackgroundResponseAggregation(
    key: string,
    aggregation: BackgroundResponseAggregation,
  ): Promise<void> {
    if (
      this.backgroundResponseAggregations.get(key) !== aggregation ||
      aggregation.flushing
    ) {
      return;
    }
    if (aggregation.retryTimer) clearTimeout(aggregation.retryTimer);
    aggregation.retryTimer = undefined;

    let delivery = aggregation.delivery;
    if (!delivery) {
      if (aggregation.parts.length === 0) {
        this.backgroundResponseAggregations.delete(key);
        return;
      }
      if (aggregation.timeoutTimer) clearTimeout(aggregation.timeoutTimer);
      aggregation.timeoutTimer = undefined;
      delivery = {
        status: aggregation.status,
        label: aggregation.label,
        parts: aggregation.parts.splice(0),
        partial:
          aggregation.delivered === true ||
          aggregation.retiring === true ||
          aggregation.completionPartial === true ||
          aggregation.turnComplete !== true,
        attempts: 0,
      };
      aggregation.delivery = delivery;
    }

    const body = this.formatBackgroundResponseAggregation(delivery);
    aggregation.flushing = true;
    let error: unknown;
    try {
      if (delivery.proactivePlan) {
        await this.deliverProactiveText(
          aggregation.target,
          delivery.proactivePlan,
        );
      } else {
        await this.deliverBackgroundResponseToTarget(
          aggregation.sessionId,
          body,
          {
            target: aggregation.target,
            sourceLabel: aggregation.sourceLabel,
          },
        );
      }
    } catch (caught) {
      error = caught;
      if (caught instanceof ProactiveTextDeliveryError) {
        delivery.proactivePlan = caught.plan;
      }
    } finally {
      aggregation.flushing = false;
    }

    if (error === undefined) {
      aggregation.delivery = undefined;
      aggregation.delivered = true;
      if (aggregation.parts.length === 0) {
        this.backgroundResponseAggregations.delete(key);
        return;
      }
      if (aggregation.retiring || aggregation.turnComplete) {
        await this.flushBackgroundResponseAggregation(key, aggregation);
      } else {
        this.scheduleBackgroundResponseAggregationFlush(key, aggregation);
      }
      return;
    }

    delivery.attempts++;
    process.stderr.write(
      `[DingTalk:${this.name}] background response delivery failed (attempt ${delivery.attempts}): ${sanitizeLogText(error instanceof Error ? error.message : String(error), 300)}\n`,
    );
    if (delivery.attempts >= BACKGROUND_RESPONSE_AGGREGATION_MAX_RETRIES) {
      aggregation.delivery = undefined;
      if (aggregation.parts.length === 0) {
        this.backgroundResponseAggregations.delete(key);
      } else if (aggregation.retiring || aggregation.turnComplete) {
        await this.flushBackgroundResponseAggregation(key, aggregation);
      } else {
        this.scheduleBackgroundResponseAggregationFlush(key, aggregation);
      }
      return;
    }

    aggregation.retryTimer = setTimeout(() => {
      aggregation.retryTimer = undefined;
      void this.flushBackgroundResponseAggregation(key, aggregation);
    }, BACKGROUND_RESPONSE_AGGREGATION_RETRY_MS);
    aggregation.retryTimer.unref?.();
  }

  private drainBackgroundResponseAggregations(sessionId?: string): void {
    for (const [key, aggregation] of this.backgroundResponseAggregations) {
      if (sessionId !== undefined && aggregation.sessionId !== sessionId) {
        continue;
      }
      if (aggregation.timeoutTimer) clearTimeout(aggregation.timeoutTimer);
      if (aggregation.retryTimer) clearTimeout(aggregation.retryTimer);
      aggregation.timeoutTimer = undefined;
      aggregation.retryTimer = undefined;
      aggregation.retiring = true;
      aggregation.turnComplete = true;
      aggregation.completionPartial = true;
      if (!aggregation.flushing) {
        void this.flushBackgroundResponseAggregation(key, aggregation);
      }
    }
  }

  private createBackgroundResponseAggregation(
    key: string,
    sessionId: string,
    context: BackgroundResponseContext,
    target: SessionTarget,
    sourceLabel?: string,
  ): BackgroundResponseAggregation {
    const aggregation: BackgroundResponseAggregation = {
      sessionId,
      target,
      sourceLabel,
      status: context.status,
      label: context.label,
      parts: [],
    };
    this.backgroundResponseAggregations.set(key, aggregation);
    return aggregation;
  }

  private scheduleBackgroundResponseAggregationFlush(
    key: string,
    aggregation: BackgroundResponseAggregation,
  ): void {
    if (aggregation.timeoutTimer || aggregation.delivery) return;
    aggregation.timeoutTimer = setTimeout(() => {
      aggregation.timeoutTimer = undefined;
      void this.flushBackgroundResponseAggregation(key, aggregation);
    }, BACKGROUND_RESPONSE_AGGREGATION_TIMEOUT_MS);
    aggregation.timeoutTimer.unref?.();
  }

  private formatBackgroundResponseAggregation(
    delivery: Pick<
      BackgroundResponseDelivery,
      'status' | 'label' | 'parts' | 'partial'
    >,
  ): string {
    const icon =
      delivery.status === 'completed'
        ? '✅'
        : delivery.status === 'failed'
          ? '❌'
          : '⏹️';
    const label = this.formatBackgroundAgentLabel(delivery.label);
    return `## ${icon} Agent · ${label}${delivery.partial ? '（部分）' : ''}\n\n${delivery.parts.join('\n\n')}`;
  }

  private formatBackgroundAgentResponse(text: string, label?: string): string {
    return `## 🤖 Agent · ${this.formatBackgroundAgentLabel(label)}\n\n${text}`;
  }

  private formatBackgroundAgentLabel(label?: string): string {
    return escapeDingTalkMarkdown(label?.trim() || '后台任务');
  }

  /**
   * Out-of-turn one-shot sends (background responses) must not flow through
   * the session's block-streaming projector: a second sender interleaving with
   * mid-projection state can swallow the send or split a held marker.
   */
  protected override async deliverBackgroundReply(
    chatId: string,
    text: string,
    sessionId: string,
    sourceLabel?: string,
  ): Promise<void> {
    if (this.config.blockStreaming !== 'on') {
      return super.deliverBackgroundReply(chatId, text, sessionId, sourceLabel);
    }
    await this.sendReply(chatId, text, undefined, sourceLabel);
  }

  protected override async sendResponseMessage(
    chatId: string,
    text: string,
    sessionId: string,
    sourceLabel?: string,
    prepared = false,
  ): Promise<void> {
    let outgoingText = text;
    let consumesMention = true;
    if (this.config.blockStreaming === 'on') {
      const projected = this.projectBlockStreamChunk(text, sessionId);
      if (!projected.text.trim()) return;
      outgoingText = projected.text;
      // A notice-only block must not consume the prompt's mention target:
      // the @mention belongs to the block carrying the actual answer.
      consumesMention = projected.hasContent;
    }
    const atUserId =
      consumesMention && this.atSender
        ? this.sessionMentionTargets.get(sessionId)
        : undefined;
    if (atUserId) this.sessionMentionTargets.delete(sessionId);
    await this.sendReply(
      chatId,
      outgoingText,
      atUserId,
      sourceLabel ?? this.getResponseSourceLabel(sessionId),
      prepared,
    );
  }

  private projectBlockStreamChunk(
    text: string,
    sessionId: string,
  ): { text: string; hasContent: boolean } {
    let state = this.blockFileProjectors.get(sessionId);
    if (!state) {
      if (!this.blockProjectionArmed.has(sessionId)) {
        return { text: '', hasContent: false };
      }
      state = { projector: new OutboundFileProjector(), reportedMarkers: 0 };
      this.blockFileProjectors.set(sessionId, state);
    }
    const safe = state.projector.append(text);
    const hasContent = safe.trim().length > 0;
    const result = state.projector.result(safe);
    let outgoingText = safe;
    if (result.markerCount > state.reportedMarkers) {
      outgoingText = withFileUnavailableNotice(safe);
      state.reportedMarkers = result.markerCount;
      process.stderr.write(
        `[DingTalk:${this.name}] file markers redacted in block stream (session ${sessionId}, markers=${result.markerCount})\n`,
      );
    }
    return { text: outgoingText, hasContent };
  }

  private async sendFallbackReply(
    chatId: string,
    text: string,
    sessionId: string,
    sourceLabel?: string,
  ): Promise<void> {
    // Mid-run fallbacks must not consume the prompt's mention target: the
    // final answer of the same run still needs it.
    const atUserId = this.atSender
      ? this.sessionMentionTargets.get(sessionId)
      : undefined;
    await this.sendReply(chatId, text, atUserId, sourceLabel);
  }

  protected override async onResponseComplete(
    chatId: string,
    text: string,
    sessionId: string,
    segment?: ChannelOutputSegmentContext,
  ): Promise<void> {
    const streamed = segment
      ? this.fileProjectors.get(segment.runId)?.projector
      : undefined;
    if (segment) this.fileProjectors.delete(segment.runId);
    const outgoingText = await this.prepareReplyOutput(chatId, text, streamed);
    if (segment && this.interactionPresenter) {
      if (
        await this.interactionPresenter.closeOutput(
          segment.segmentId,
          outgoingText,
          'completed',
          segment,
        )
      ) {
        return;
      }
    }
    await this.sendResponseMessage(
      chatId,
      outgoingText,
      sessionId,
      segment?.sourceLabel,
      true,
    );
  }

  protected override onOutputSegmentEnd(
    _chatId: string,
    _sessionId: string,
    segment: ChannelOutputSegmentContext,
    reason: ChannelOutputSegmentEndReason,
  ): void | Promise<void> {
    if (
      reason === 'completed' ||
      reason === 'failed' ||
      reason === 'cancelled'
    ) {
      this.fileProjectors.delete(segment.runId);
    }
    if (!this.interactionPresenter) return;
    return this.interactionPresenter
      .closeOutput(segment.segmentId, '', reason, segment)
      .then(() => undefined);
  }

  protected override onResponseChunk(
    _chatId: string,
    chunk: string,
    _sessionId: string,
    segment?: ChannelOutputSegmentContext,
  ): void {
    if (!segment) return;
    let state = this.fileProjectors.get(segment.runId);
    if (!state) {
      state = {
        sessionId: segment.sessionId,
        projector: new OutboundFileProjector(),
      };
      this.fileProjectors.set(segment.runId, state);
    }
    const safe = state.projector.append(chunk);
    if (safe) this.interactionPresenter?.appendOutput(segment, safe);
  }

  private deleteFileProjectorsForRun(runId: string): void {
    this.fileProjectors.delete(runId);
  }

  protected override async presentUserInputRequest(
    context: ChannelUserInputRequestContext,
  ): Promise<UserInputPresentationResult> {
    const run = this.cardRuns.get(context.runId);
    if (!run || run.ownerId !== context.owner.id) {
      return { kind: 'unsupported' };
    }
    if (!this.questionCardController || !this.interactionPresenter) {
      return { kind: 'unsupported' };
    }
    return this.interactionPresenter.presentInput(context);
  }

  /**
   * Extract quoted/referenced message context from a reply.
   * DingTalk provides this via text.repliedMsg (newer) or quoteMessage (legacy).
   */
  private extractQuotedContext(data: DingTalkMessageData): {
    referencedText?: string;
    isReplyToBot: boolean;
    media?: {
      downloadCode: string;
      mediaType: 'image' | 'file' | 'audio' | 'video';
      fileName?: string;
    };
  } {
    // Newer format: text.repliedMsg
    if (data.text?.isReplyMsg && data.text.repliedMsg) {
      const replied = data.text.repliedMsg;
      const isReplyToBot =
        !!data.chatbotUserId && replied.senderId === data.chatbotUserId;

      // Note: DingTalk doesn't include content for interactiveCard replies
      // (bot responses sent via webhook). Only user message quotes have text.
      const text = this.summarizeRepliedContent(replied);
      const downloadCode = replied.content?.downloadCode;
      const mediaType = this.mediaTypeFromMsgType(replied.msgType);
      return {
        referencedText: text || undefined,
        isReplyToBot,
        ...(downloadCode && mediaType
          ? {
              media: {
                downloadCode,
                mediaType,
                fileName: replied.content?.fileName,
              },
            }
          : {}),
      };
    }

    // Legacy format: quoteMessage
    if (data.quoteMessage) {
      const quote = data.quoteMessage;
      const isReplyToBot =
        !!data.chatbotUserId && quote.senderId === data.chatbotUserId;
      const text = quote.text?.content?.trim();
      return { referencedText: text || undefined, isReplyToBot };
    }

    return { isReplyToBot: false };
  }

  /**
   * Warn once when a chat-record payload yields nothing to show the model.
   * Both chat-record paths degrade silently otherwise — `parseJsonArray`
   * swallows JSON errors, the top-level path falls back to `(chat record)`
   * and the replied path to an empty quote — matching this file's convention
   * of logging degraded paths (`onDownStream`, `onMessage`).
   */
  private warnEmptyChatRecord(content?: DingTalkMessageContent): void {
    process.stderr.write(
      `[DingTalk:${this.name}] chat record had no readable content ` +
        `(content keys: ${sanitizeLogText(describeChatRecordKeys(content), 200)})\n`,
    );
  }

  /**
   * The partial degradation the empty-record warning cannot see: a title or
   * summary rendered, so the result is non-empty, but the entries key that
   * arrived produced no lines at all (an object encoding such as
   * `{"list":[...]}`, a non-array, or a present-but-unusable first alias).
   * Every forwarded message is dropped and the user reports only that "the bot
   * cannot see forwarded messages"; without this line nothing in the log
   * distinguishes that from model behaviour.
   */
  private warnUnreadableChatRecordEntries(
    content?: DingTalkMessageContent,
  ): void {
    process.stderr.write(
      `[DingTalk:${this.name}] chat record summary rendered but no readable entries ` +
        `(content keys: ${sanitizeLogText(describeChatRecordKeys(content), 200)})\n`,
    );
  }

  /**
   * Build a text summary from a repliedMsg, handling text, richText, chat
   * records, and media message types with placeholders.
   */
  private summarizeRepliedContent(replied: DingTalkRepliedMsg): string {
    const msgType = replied.msgType;
    const content = replied.content;

    // Direct text content
    if (content?.text?.trim()) {
      return content.text.trim();
    }

    // RichText: concatenate text parts, placeholder for images
    if (content?.richText && Array.isArray(content.richText)) {
      const parts: string[] = [];
      for (const part of content.richText) {
        const partType = part.type || 'text';
        if (partType === 'text' && part.text) {
          parts.push(part.text);
        } else if (partType === 'picture') {
          parts.push('[image]');
        } else if (partType === 'at' && part.atName) {
          parts.push(`@${part.atName}`);
        }
      }
      const summary = parts.join('').trim();
      if (summary) return summary;
    }

    if (msgType === 'chatRecord') {
      // The quote budget, not the record budget: this text becomes
      // `envelope.referencedText`, which `ChannelBase` renders through
      // `sanitizeQuotedText(..., 500)`. Rendered to 4000 the quote arrives cut
      // at 500 with a bare `…` — announcement and all — so the model is told
      // nothing about what it is missing.
      const { text, entriesDropped } = formatChatRecord(
        content,
        MAX_QUOTED_CHAT_RECORD_CHARS,
      );
      if (!text) this.warnEmptyChatRecord(content);
      else if (entriesDropped) this.warnUnreadableChatRecordEntries(content);
      return text;
    }

    // Media type placeholders. Shared with the chat-record entry formatter so
    // the same message type is never described two ways to the model.
    return mediaTypePlaceholder(msgType, content?.fileName) ?? '';
  }

  /**
   * Map a DingTalk message type to the media type used for downloads. Shared
   * by the direct-media (`extractContent`) and quoted-media
   * (`extractQuotedContext`) paths so the mapping cannot drift between them.
   */
  private mediaTypeFromMsgType(
    msgType: string | undefined,
  ): 'image' | 'file' | 'audio' | 'video' | undefined {
    if (msgType === 'picture') return 'image';
    if (msgType === 'file' || msgType === 'audio' || msgType === 'video') {
      return msgType;
    }
    return undefined;
  }

  /**
   * Extract text and media download codes from an incoming DingTalk message.
   * Handles text, richText, chat records, picture, file, audio, and video
   * message types.
   */
  private extractContent(data: DingTalkMessageData): {
    text: string;
    downloadCodes: string[];
    mediaType?: 'image' | 'file' | 'audio' | 'video';
    fileName?: string;
    placeholder?: string;
  } {
    const msgtype = data.msgtype || 'text';

    if (msgtype === 'richText') {
      const richText = data.content?.richText;
      if (!Array.isArray(richText)) {
        return { text: '', downloadCodes: [] };
      }
      let text = '';
      const codes: string[] = [];
      for (const part of richText) {
        const partType = part.type || 'text';
        if (partType === 'text' && part.text) {
          text += part.text;
        } else if (partType === 'picture' && part.downloadCode) {
          codes.push(part.downloadCode);
        }
      }
      return {
        text: text.trim() || (codes.length > 0 ? '(image)' : ''),
        downloadCodes: codes,
        mediaType: codes.length > 0 ? 'image' : undefined,
      };
    }

    if (msgtype === 'picture') {
      const code = data.content?.downloadCode;
      return {
        text: '(image)',
        downloadCodes: code ? [code] : [],
        mediaType: this.mediaTypeFromMsgType(msgtype),
      };
    }

    if (msgtype === 'file') {
      const code = data.content?.downloadCode;
      const fileName = data.content?.fileName || undefined;
      const placeholder = `(file: ${fileName || 'file'})`;
      return {
        text: placeholder,
        downloadCodes: code ? [code] : [],
        mediaType: this.mediaTypeFromMsgType(msgtype),
        fileName,
        placeholder,
      };
    }

    if (msgtype === 'audio') {
      const code = data.content?.downloadCode;
      const recognition = data.content?.recognition;
      return {
        text: recognition || '(audio)',
        downloadCodes: code ? [code] : [],
        mediaType: this.mediaTypeFromMsgType(msgtype),
        placeholder: recognition ? undefined : '(audio)',
      };
    }

    if (msgtype === 'video') {
      const code = data.content?.downloadCode;
      return {
        text: '(video)',
        downloadCodes: code ? [code] : [],
        mediaType: this.mediaTypeFromMsgType(msgtype),
        placeholder: '(video)',
      };
    }

    if (msgtype === 'chatRecord') {
      const { text, entriesDropped } = formatChatRecord(data.content);
      if (!text) this.warnEmptyChatRecord(data.content);
      else if (entriesDropped)
        this.warnUnreadableChatRecordEntries(data.content);
      return {
        text: text || '(chat record)',
        downloadCodes: [],
      };
    }

    // Default: text message
    return { text: data.text?.content?.trim() || '', downloadCodes: [] };
  }

  /**
   * Download a media file and attach it to the envelope.
   * Images → base64 in envelope; files → saved to temp dir with path in text.
   *
   * `cleanPlaceholderText` is the placeholder `extractContent` generated for
   * this message's own media — `(audio)`, `(video)`, `(file: name)`. Only the
   * direct-media call site has one, and only that call may erase it: on the
   * quoted-media path `envelope.text` is the user's own reply, and a reply
   * that happens to read exactly like a placeholder must survive (a group
   * `@Bot (audio)` reaches here as exactly `(audio)` after mention removal).
   */
  private async attachMedia(
    envelope: Envelope,
    downloadCode: string,
    mediaType: 'image' | 'file' | 'audio' | 'video',
    fileName?: string,
    cleanPlaceholderText?: string,
  ): Promise<void> {
    let token: string;
    try {
      token = await this.getProactiveToken();
    } catch {
      process.stderr.write(
        `[DingTalk:${this.name}] Cannot download media: access token refresh failed.\n`,
      );
      return;
    }
    const robotCode = this.config.clientId;
    if (!robotCode) {
      process.stderr.write(
        `[DingTalk:${this.name}] Cannot download media: missing robotCode.\n`,
      );
      return;
    }

    const media = await downloadMedia(downloadCode, robotCode, token);
    if (!media) return;

    if (mediaType === 'image') {
      const mimeType = media.mimeType.startsWith('image/')
        ? media.mimeType
        : 'image/jpeg';
      envelope.attachments = [
        ...(envelope.attachments || []),
        {
          type: 'image',
          data: media.buffer.toString('base64'),
          mimeType,
        },
      ];
    } else {
      // Save the media to temp dir so the agent can read it.
      //
      // R1-2: these are synchronous throw sites — ENOSPC on a write of up to
      // 50 MB, ENAMETOOLONG from a quoted fileName over 255 bytes (`basename`
      // does not truncate), a TypeError from a truthy non-string fileName. An
      // escape rejects `processMessage`, whose catch sends the generic error
      // reply and never calls `handleInbound`; the msgId is already in
      // `seenMessages`, so DingTalk's retry is deduped and the user's prompt
      // is lost for good. Degrade the way a failed download already does:
      // skip the attachment, keep the text.
      let dir: string | undefined;
      let filePath: string;
      let safeName: string;
      try {
        dir = join(tmpdir(), 'channel-files', randomUUID());
        mkdirSync(dir, { recursive: true });
        safeName =
          basename(typeof fileName === 'string' ? fileName : '') ||
          `dingtalk_${mediaType}_${Date.now()}.${
            GENERATED_MEDIA_EXT[media.mimeType] ?? 'bin'
          }`;
        filePath = join(dir, safeName);
        writeFileSync(filePath, media.buffer);
      } catch (error) {
        // The store directory (and any partial file) is useless without the
        // attachment — remove it so failed stores do not accumulate in tmpdir.
        if (dir) {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            // Best effort; the degraded delivery below is the contract.
          }
        }
        process.stderr.write(
          `[DingTalk:${this.name}] Cannot store media, delivering the text without it: ${sanitizeLogText(
            error instanceof Error ? error.message : String(error),
            300,
          )}\n`,
        );
        return;
      }

      // Clean up the placeholder this message's own media produced.
      if (
        cleanPlaceholderText !== undefined &&
        envelope.text === cleanPlaceholderText
      ) {
        envelope.text = '';
      }

      envelope.attachments = [
        ...(envelope.attachments || []),
        {
          type: mediaType,
          filePath,
          mimeType: media.mimeType,
          fileName: safeName,
        },
      ];
    }
  }

  private onMessage(downstream: DWClientDownStream): void {
    try {
      const data: DingTalkMessageData =
        typeof downstream.data === 'string'
          ? JSON.parse(downstream.data)
          : (downstream.data as DingTalkMessageData);
      this.logDebugPayload('DingTalk', data);
      const dataMsgId = typeof data.msgId === 'string' ? data.msgId : undefined;
      const headerMsgId =
        typeof downstream.headers.messageId === 'string'
          ? downstream.headers.messageId
          : undefined;
      const msgId = dataMsgId || headerMsgId;

      // Dedup: DingTalk retries unACKed messages
      if (msgId && this.seenMessages.has(msgId)) {
        return;
      }
      if (msgId) {
        this.seenMessages.set(msgId, Date.now());
        this.rememberInboundMessageId(msgId);
      }

      const isGroup = data.conversationType === '2';
      const sessionWebhook =
        typeof data.sessionWebhook === 'string'
          ? data.sessionWebhook
          : undefined;
      const conversationId =
        typeof data.conversationId === 'string'
          ? data.conversationId
          : undefined;
      const conversationTitle =
        typeof data.conversationTitle === 'string'
          ? data.conversationTitle
          : undefined;
      const isMentioned = Boolean(data.isInAtList);
      const senderNick =
        typeof data.senderNick === 'string' ? data.senderNick : undefined;
      const senderStaffId =
        typeof data.senderStaffId === 'string' ? data.senderStaffId : undefined;
      const senderIdValue =
        typeof data.senderId === 'string' ? data.senderId : undefined;

      if (!sessionWebhook) {
        process.stderr.write(
          `[DingTalk:${this.name}] No sessionWebhook in message, skipping.\n`,
        );
        return;
      }

      // A group message with no conversationId can't be routed to a stable
      // session — chatId would fall back to the expiring sessionWebhook and the
      // shared-session key would churn. Drop it rather than fragment the group.
      if (DingtalkChannel.isUnroutableGroupMessage(isGroup, conversationId)) {
        // Include identifying context so an operator can tell whether one sender
        // or every group message is affected if DingTalk starts omitting
        // conversationId (API regression / edge-case message type).
        process.stderr.write(
          `[DingTalk:${this.name}] Group message has no conversationId, skipping (msgId=${
            msgId || 'unknown'
          }, sender=${sanitizeSenderName(
            senderNick || senderStaffId || 'unknown',
          )})\n`,
        );
        return;
      }

      // Cache webhook by conversationId so sendMessage can look it up
      if (conversationId) {
        this.webhooks.set(conversationId, sessionWebhook);
      }

      process.stderr.write(
        `[DingTalk:${this.name}] message msgId=${sanitizeLogText(
          msgId || 'unknown',
          80,
        )} conversationId=${sanitizeLogText(
          conversationId || '',
          120,
        )} isGroup=${isGroup} isMentioned=${isMentioned} senderNick=${sanitizeLogText(
          senderNick || '',
          80,
        )} senderStaffId=${sanitizeLogText(
          senderStaffId || '',
          80,
        )} senderId=${sanitizeLogText(senderIdValue || '', 80)}\n`,
      );

      // Extract text and media info from message
      const content = this.extractContent(data);
      let cleanText = content.text;

      // Strip first @mention (the bot) from text, keep other @mentions intact.
      // Anchor to start-of-string so @ symbols inside URLs or emails
      // (e.g. git@host:path) are not accidentally stripped (#7402).
      if (isMentioned) {
        cleanText = cleanText.replace(/^\s*@[^\s\p{Cf}]+/u, '').trim();
      }

      // Extract quoted message context
      const quoted = this.extractQuotedContext(data);

      const chatId = conversationId || sessionWebhook;

      // After stripping the bot @mention, cleanText may legitimately be empty
      // (user pinged the bot with no other text). Don't fall back to the
      // original text in that case — it would re-introduce the @mention.
      const messageText = isMentioned ? cleanText : cleanText || content.text;
      // Carry mention targets as a structured envelope field (like
      // referencedText) so ChannelBase renders the marker after prompt
      // sanitization and slash-command parsing sees the body alone.
      const mentionedMemberIds = isGroup ? collectNonBotMentionIds(data) : [];
      const senderId = senderStaffId || senderIdValue || '';
      const senderName = senderNick || senderId || 'Unknown';

      const envelope: Envelope = {
        channelName: this.name,
        senderId,
        senderName,
        chatId,
        ...(isGroup && conversationTitle
          ? { chatName: conversationTitle }
          : {}),
        text: messageText,
        ...(mentionedMemberIds.length > 0 ? { mentionedMemberIds } : {}),
        isGroup,
        isMentioned,
        isReplyToBot: quoted.isReplyToBot,
        referencedText: quoted.referencedText,
      };

      // Reactions are resolved later via the chatId passed to
      // onPromptStart/onPromptEnd — no extra bookkeeping needed.
      envelope.messageId = msgId;

      if (this.atSender && isGroup && senderStaffId) {
        (envelope as MentionTargetEnvelope)[mentionTarget] = senderStaffId;
      }

      const processMessage =
        content.downloadCodes.length > 0 || quoted.media
          ? this.prepareThenHandleInbound(envelope, async () => {
              // Download media in callback order.
              if (content.downloadCodes.length > 0 && content.mediaType) {
                for (const downloadCode of content.downloadCodes) {
                  await this.attachMedia(
                    envelope,
                    downloadCode,
                    content.mediaType,
                    content.fileName,
                    content.placeholder,
                  );
                }
              }
              if (quoted.media) {
                await this.attachMedia(
                  envelope,
                  quoted.media.downloadCode,
                  quoted.media.mediaType,
                  quoted.media.fileName,
                );
              }
            })
          : this.handleInbound(envelope);
      processMessage.catch((err) => {
        // Don't await — stream callback should return quickly
        const reference = randomUUID().slice(0, 8);
        let errorSummary = 'Unknown error';
        try {
          errorSummary =
            err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        } catch {
          // The user-facing fallback below must survive arbitrary rejections.
        }
        process.stderr.write(
          `[DingTalk:${this.name}] Error handling message ref=${reference}: ${sanitizeLogText(
            errorSummary,
            300,
          )}\n`,
        );
        const fallbackMessage = formatInboundErrorMessage(err, reference);
        const sourceLabel = this.getInboundErrorSourceLabel(envelope);
        const delivery = sourceLabel
          ? this.sendThreadMessage(
              chatId,
              envelope.threadId,
              fallbackMessage,
              sourceLabel,
            )
          : this.sendMessage(chatId, fallbackMessage);
        delivery.catch(() => {});
      });
    } catch (err) {
      process.stderr.write(
        `[DingTalk:${this.name}] Failed to parse message: ${err}\n`,
      );
    }
  }
}
