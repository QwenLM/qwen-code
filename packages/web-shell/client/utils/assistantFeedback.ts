/**
 * Persisted satisfied / not-satisfied marks for assistant answers.
 *
 * The mark is Web Shell's own UI state: the host is notified through
 * `customization.assistantFeedback.onRate`, but never feeds state back. Storage
 * is therefore best-effort and local to this browser — a failure to read or
 * write must never affect the click that just happened.
 */

import type {
  WebShellAssistantFeedbackInfo,
  WebShellAssistantFeedbackOptions,
  WebShellAssistantFeedbackUserMessage,
} from '../customization';
import type { TranscriptRenderMode } from '../transcriptRenderMode';

/**
 * Whether an assistant answer may carry satisfied / not-satisfied marks.
 *
 * Two conditions, both required: a session to store the mark under, and an
 * interactive rendering — read-only and document transcripts stay untouched
 * however much session context they carry.
 */
export function shouldOfferAssistantFeedback({
  renderMode,
  sessionId,
  options,
}: {
  renderMode: TranscriptRenderMode;
  sessionId?: string;
  options?: WebShellAssistantFeedbackOptions;
}): boolean {
  return (
    renderMode === 'interactive' &&
    sessionId !== undefined &&
    options !== undefined &&
    options.enabled !== false
  );
}

/**
 * Tells the host about a mark the user just made. The host is a listener, not
 * an authority: it cannot veto the mark, and a throw here must not reach the
 * click handler.
 */
export function notifyAssistantFeedback(
  handler: ((info: WebShellAssistantFeedbackInfo) => void) | undefined,
  info: WebShellAssistantFeedbackInfo,
): void {
  if (!handler) return;
  try {
    handler(info);
  } catch (error) {
    console.warn('[web-shell] assistant feedback handler threw:', error);
  }
}

export type AssistantFeedbackRating = 'up' | 'down';

/** Session id -> turn prompt id -> mark. */
export type AssistantFeedbackStore = Record<
  string,
  Record<string, AssistantFeedbackRating>
>;

export const ASSISTANT_FEEDBACK_STORAGE_KEY =
  'qwen-web-shell-assistant-feedback';

/** Sessions kept in storage; the rest age out oldest-first. */
export const MAX_ASSISTANT_FEEDBACK_SESSIONS = 10;

const editRevisions = new Map<string, number>();

function editRevisionKey(sessionId: string, turnId: string): string {
  return JSON.stringify([sessionId, turnId]);
}

export function readAssistantFeedbackEditRevision(
  sessionId: string,
  turnId: string,
): number {
  return editRevisions.get(editRevisionKey(sessionId, turnId)) ?? 0;
}

const prunedSessions = new Map<
  string,
  Record<string, AssistantFeedbackRating>
>();

/** Intended ratings of sessions not on disk (cap eviction or a failed write). */
export function readPrunedAssistantFeedbackSession(
  sessionId: string,
): Readonly<Record<string, AssistantFeedbackRating>> | undefined {
  return prunedSessions.get(sessionId);
}

export function forgetAssistantFeedbackSessionPruned(sessionId: string): void {
  prunedSessions.delete(sessionId);
}

/** Characters of the turn's prompt forwarded to the host. */
export const FEEDBACK_USER_MESSAGE_MAX_CHARS = 100;

/**
 * Summarises the turn's prompt for the host. Only the tail is kept: the end of
 * a prompt is what distinguishes it from its neighbours in a list of marks.
 */
export function describeFeedbackUserMessage(message: {
  content: string;
  images?: readonly unknown[];
  files?: readonly unknown[];
  timestamp?: number;
}): WebShellAssistantFeedbackUserMessage {
  const trimmed = message.content.trim();
  const text =
    trimmed.length > 0
      ? trimmed.slice(-FEEDBACK_USER_MESSAGE_MAX_CHARS)
      : [
          (message.images?.length ?? 0) > 0 ? '[图片]' : undefined,
          (message.files?.length ?? 0) > 0 ? '[附件]' : undefined,
        ]
          .filter((part): part is string => part !== undefined)
          .join(' ');
  return {
    text,
    ...(message.timestamp !== undefined
      ? { timestamp: message.timestamp }
      : {}),
  };
}

/**
 * The prompt that started the turn whose head message is `turnId`. A shell
 * turn's prompt is its command; anything else is reported as unknown rather
 * than guessed.
 */
export function feedbackUserMessageOf(
  messages: readonly {
    id: string;
    role: string;
    content?: string;
    command?: string;
    images?: readonly unknown[];
    files?: readonly unknown[];
    timestamp?: number;
  }[],
  turnId: string,
): WebShellAssistantFeedbackUserMessage {
  const head = messages.find((message) => message.id === turnId);
  if (!head || head.role === 'user' || head.role === 'user_shell') {
    return describeFeedbackUserMessage({
      content: head?.command ?? head?.content ?? '',
      images: head?.images,
      files: head?.files,
      timestamp: head?.timestamp,
    });
  }
  return describeFeedbackUserMessage({ content: '' });
}

const STORAGE_VERSION = 1;

const VALID_RATINGS: ReadonlySet<string> = new Set(['up', 'down']);

function isRating(value: unknown): value is AssistantFeedbackRating {
  return typeof value === 'string' && VALID_RATINGS.has(value);
}

function keepMostRecentSessions(
  store: AssistantFeedbackStore,
): AssistantFeedbackStore {
  const sessionIds = Object.keys(store);
  if (sessionIds.length <= MAX_ASSISTANT_FEEDBACK_SESSIONS) return store;
  const kept: AssistantFeedbackStore = {};
  for (const sessionId of sessionIds.slice(-MAX_ASSISTANT_FEEDBACK_SESSIONS)) {
    kept[sessionId] = store[sessionId]!;
  }
  return kept;
}

function recordEditRevisions(
  edited: ReadonlyArray<{ sessionId: string; turnId: string }>,
  kept: AssistantFeedbackStore,
): void {
  for (const { sessionId, turnId } of edited) {
    // Capacity eviction retains the revision for the snapshot restored later.
    if (!kept[sessionId]) continue;
    const key = editRevisionKey(sessionId, turnId);
    editRevisions.set(key, (editRevisions.get(key) ?? 0) + 1);
  }
}

function emptyAssistantFeedbackStore(): AssistantFeedbackStore {
  prunedSessions.clear();
  return {};
}

/**
 * Reads the persisted marks, dropping anything unrecognizable rather than
 * guessing: a hand-edited or future payload must degrade to "nothing marked".
 */
export function readAssistantFeedbackStore(): AssistantFeedbackStore {
  if (typeof window === 'undefined') return {};
  let parsed: unknown;
  try {
    const raw = window.localStorage.getItem(ASSISTANT_FEEDBACK_STORAGE_KEY);
    if (!raw) return emptyAssistantFeedbackStore();
    parsed = JSON.parse(raw);
  } catch {
    // localStorage can be unavailable in private or embedded contexts, and the
    // stored value may not be JSON at all.
    return emptyAssistantFeedbackStore();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return emptyAssistantFeedbackStore();
  }
  const { v, ...sessions } = parsed as Record<string, unknown>;
  if (v !== undefined && v !== STORAGE_VERSION) {
    return emptyAssistantFeedbackStore();
  }

  const store: AssistantFeedbackStore = {};
  for (const [sessionId, value] of Object.entries(sessions)) {
    if (
      !sessionId ||
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value)
    ) {
      continue;
    }
    const ratings: Record<string, AssistantFeedbackRating> = {};
    for (const [turnId, rating] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (turnId && isRating(rating)) ratings[turnId] = rating;
    }
    if (Object.keys(ratings).length > 0) store[sessionId] = ratings;
  }
  return Object.keys(store).length > 0
    ? keepMostRecentSessions(store)
    : emptyAssistantFeedbackStore();
}

/**
 * Persists `store`. `edited` names the turns this write actually edits, so a
 * restore of an evicted session does not advance the revisions of the turns
 * it merely re-inserts and retire other panes' still-valid queued edits.
 */
export function writeAssistantFeedbackStore(
  store: AssistantFeedbackStore,
  edited: ReadonlyArray<{ sessionId: string; turnId: string }> = [],
): boolean {
  if (typeof window === 'undefined') return false;
  const previous = readAssistantFeedbackStore();
  const kept = keepMostRecentSessions(store);
  let persisted = false;
  try {
    window.localStorage.setItem(
      ASSISTANT_FEEDBACK_STORAGE_KEY,
      JSON.stringify({ v: STORAGE_VERSION, ...kept }),
    );
    persisted = true;
  } catch (error) {
    // A full or disabled localStorage must not break the click that just
    // happened; the mark still shows for this page.
    console.warn('[web-shell] failed to persist assistant feedback:', error);
  }
  // Revisions only advance for persisted edits; a failed write leaves disk
  // unchanged, so bumping them would retire other panes' queued edits.
  if (persisted) recordEditRevisions(edited, kept);
  // Snapshots must track the intended state of every session whose content is
  // not on disk after this attempt — a session evicted at the cap, or one a
  // failed write left on disk with stale content (a cleared rating a sibling
  // pane would otherwise re-insert).
  const onDisk = persisted ? kept : previous;
  const touched = new Set(edited.map((edit) => edit.sessionId));
  for (const sessionId of new Set([
    ...Object.keys(previous),
    ...Object.keys(store),
  ])) {
    const intended = store[sessionId] ?? {};
    const landed = onDisk[sessionId];
    if (JSON.stringify(landed ?? {}) !== JSON.stringify(intended)) {
      prunedSessions.set(sessionId, { ...intended });
    } else if (touched.has(sessionId)) {
      // Only this write's own sessions may forget a snapshot on landing; an
      // unrelated pane's write must not drop another session's unlanded edit.
      prunedSessions.delete(sessionId);
    }
  }
  return persisted;
}

/**
 * Returns a new store with `promptId` marked (or cleared when `rating` is
 * null). Pure so React can run it inside a state updater.
 */
export function setAssistantFeedbackRating(
  store: AssistantFeedbackStore,
  sessionId: string,
  promptId: string,
  rating: AssistantFeedbackRating | null,
): AssistantFeedbackStore {
  if (!sessionId || !promptId) return store;
  const session = { ...(store[sessionId] ?? {}) };
  if (rating === null) delete session[promptId];
  else session[promptId] = rating;

  const next: AssistantFeedbackStore = { ...store };
  // Re-insert the session so its position tracks its last edit: pruning keeps
  // the tail of the key order, and an existing key keeps its old position.
  delete next[sessionId];
  if (Object.keys(session).length > 0) next[sessionId] = session;
  return next;
}
