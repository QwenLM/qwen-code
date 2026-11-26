/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Daemon-host handler for sub-session spawn requests.
 *
 * A child sends a `create-sub-session` `extMethod` request UP to the daemon (see
 * `BridgeOptions.onCreateSubSession`) — either from the `create_sub_session` tool
 * inside an agent turn, or from the ACP session's `isolated` scheduled-task
 * dispatch. This handler spawns a FRESH top-level sub-session, runs the prompt in
 * it (`spawnOrAttach` thread scope → `sendPrompt`), and RETURNS a result.
 *
 * Completion modes:
 *  - `'sent'`      — dispatch the prompt and return `{ sessionId }` immediately;
 *                    the sub-session keeps running and is idle-reaped later.
 *                    A background event-stream subscription holds the concurrency
 *                    slot until the turn finishes (or `stop()` aborts it), so the
 *                    per-caller cap stays meaningful for fire-and-forget runs.
 *                    Live Voice launchers additionally deliver a completion
 *                    notification to the parent session, triggering an automatic
 *                    follow-up turn. Other callers retain fire-and-forget behavior.
 *  - `'first-turn'`— subscribe to the sub-session's event stream, accumulate its
 *                    `agent_message_chunk` text until `turn_complete`/`turn_error`
 *                    (correlated on `promptId`), and return it. `sendPrompt`'s
 *                    promise only carries `stopReason` (no text), so the result
 *                    must come from the stream. `stop()` aborts the subscription
 *                    via a composed `AbortSignal`; the sub-session's turn itself
 *                    is NOT cancelled (sendPrompt has no abort seam) and will
 *                    complete or be idle-reaped independently.
 *
 * The sub-session is fire-and-forget w.r.t. lifecycle: it is NOT kept resident,
 * so once idle the bridge's reaper closes it; its transcript persists.
 *
 * Roster hygiene on top of that, opt-in via
 * `serve.subSessionCompletionTtlHours` (default `0` = keep forever): once a
 * sub-session's turn ends in a clean completion (`end_turn`), the completion
 * TTL starts its clock. When it expires, the launcher closes the live entry
 * (if the reaper has not already) and removes the persisted transcript/catalog
 * row that would otherwise keep the finished thread in the session list
 * forever. Removal is an allowlist: failed and cancelled turns keep their
 * diagnostic transcripts. A revived sub-session (a new prompt after completion)
 * restarts its clock from the latest activity; running sub-sessions are never
 * removal candidates. After a daemon restart the launcher re-discovers this
 * workspace's persisted sub-session rows and starts their clocks from the
 * transcript's last write — but only for rows whose last persisted turn result
 * is a clean completion (`completed`/`end_turn`): the restart path reaps only
 * what it can prove clean, and a failed, cancelled, or unclassifiable transcript
 * stays with the user. Once removed, the session is not continuable.
 */

import { randomUUID } from 'node:crypto';
import fs, { lstatSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import {
  createDebugLogger,
  SessionService,
  Storage,
  stripTerminalControlSequences,
} from '@qwen-code/qwen-code-core';
import {
  escapeXml,
  escapeXmlWithinBudget,
} from '@qwen-code/qwen-code-core/utils/xml.js';
import {
  APPROVAL_MODES,
  ApprovalMode,
} from '@qwen-code/qwen-code-core/config/approval-mode.js';
import { readWorktreeSessionStrict } from '@qwen-code/qwen-code-core/services/worktreeSessionService.js';
import { SessionNotFoundError } from '@qwen-code/acp-bridge/bridgeErrors';
import {
  ACTIVE_WORK_CLOSE_TIMEOUT_MS,
  DAEMON_INPUT_ANNOTATIONS_META_KEY,
} from '@qwen-code/acp-bridge/bridgeTypes';
import type {
  AcpSessionBridge,
  BridgeBackgroundNotification,
  BridgeSession,
  BridgeSessionExternalRecordRequest,
  BridgeSessionSummary,
} from '@qwen-code/acp-bridge/bridgeTypes';
import type {
  CreateSubSessionInfo,
  CreateSubSessionResult,
  ResolveSubSessionWorkspaceHandler,
} from '@qwen-code/acp-bridge/bridgeOptions';
import {
  isReservedStandaloneSessionSourceType,
  isScheduledTaskRunSource,
} from '@qwen-code/acp-bridge/sessionSource';
import { isWithinRoot } from '../config/path-comparison.js';
import { normalizeSessionIdForLookup } from '../config/session-id.js';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import type { StandaloneSessionService } from './conversations/standalone-session-service.js';
import {
  resolveSessionIdForRestore,
  type SessionArchiveCoordinator,
} from './server/session-archive.js';
import { createSessionOrganizationService } from './session-organization-helpers.js';
import {
  WorkspaceGenerationClosedError,
  type WorkspaceRegistry,
  type WorkspaceRuntime,
} from './workspace-registry.js';
import {
  isPortableAbsolutePath,
  resolveRegisteredWorkspaceRuntimeByPathSelector,
} from './workspace-route-runtime.js';

type StandaloneSubSessionService = Pick<
  StandaloneSessionService,
  'createChildWithInitialPrompt' | 'resume' | 'continueSession'
>;

const log = createDebugLogger('SUB_SESSION');

/** Default per-caller ceiling on concurrent in-flight sub-sessions. A
 * `first-turn` request holds a slot until its turn finishes; parallel tool
 * calls from one caller must not spawn unbounded sub-sessions. Over the cap
 * the request is rejected (surfaced as the tool's error), never silently
 * dropped. Overridable via `serve.maxConcurrentSubSessionsPerCaller`. */
export const MAX_CONCURRENT_SUB_SESSIONS_PER_CALLER = 16;

/**
 * Default ceiling on concurrent in-flight sub-sessions across ALL callers of
 * this workspace's launcher.
 *
 * The per-caller cap is keyed on `callerSessionId`, and the daemon can only
 * authenticate that id as "a session on this channel" — every session of a
 * workspace shares ONE child process, so nothing at the transport can prove
 * *which* of them issued the call. A child running attacker code could rotate
 * ids to open a fresh bucket per launch, or charge them to a sibling. This
 * bound does not depend on the id being honest: it holds whichever bucket the
 * launch is charged to. Overridable via
 * `serve.maxConcurrentSubSessionsTotal`.
 *
 * The default is kept below the bridge's default `maxSessions` (32): a finished sub-session
 * stays registered (idle) for up to `sessionIdleTimeoutMs`, so a total cap at
 * the session-table limit would make the next fan-out wave fail at bridge
 * admission instead of this cap, and starve interactive sessions of slots.
 */
export const MAX_CONCURRENT_SUB_SESSIONS_TOTAL = 24;

/** Wall-clock ceiling for `first-turn`: a hung sub-session turn must not block
 * the caller forever. On timeout we return whatever text accumulated so far. */
const FIRST_TURN_TIMEOUT_MS = 5 * 60_000;

const SENT_MODE_DISPATCH_TIMEOUT_MS = 30_000;

/** Active-time ceiling for the sent-mode background drain. Generous enough for
 * long-running sub-sessions but prevents a hung turn from permanently consuming
 * a concurrency slot (the idle reaper may not fire if the sub-session is still
 * "actively" running from the daemon's perspective). */
const SENT_MODE_DRAIN_TIMEOUT_MS = 30 * 60_000;

/** Recovery only applies while this daemon process still owns the sent-mode
 * drain. A daemon restart loses that in-memory drain, so there is no completion
 * to redeliver until sent workers themselves gain a durable job registry. */
const RECOVERED_PARENT_NOTIFICATION_TIMEOUT_MS = 30 * 60_000;

const SENT_COMPLETION_DELIVERY_RETRY_MS = 100;
const SENT_COMPLETION_DELIVERY_MAX_RETRY_MS = 30_000;

/** The rollback watchdog bounds a closeSession that already gives the agent
 * ACTIVE_WORK_CLOSE_TIMEOUT_MS to exit, so it must strictly outlast that inner
 * timeout — two equal timers can fire in either order, and the watchdog
 * winning would skip the transcript cleanup below entirely. */
const ROLLBACK_CLOSE_WATCHDOG_SLACK_MS = 5_000;

/** Cap on returned first-turn text so a runaway sub-session can't flood the
 * caller's context. Excess is dropped with a truncation marker. */
const MAX_RESULT_CHARS = 32_000;

/** Agent-side validation applies to the fully serialized model text. */
const MAX_SENT_COMPLETION_MODEL_TEXT_CHARS = 32_768;

const SENT_COMPLETION_RESULT_TRUNCATION_MARKER = '\n[…result truncated]';

/** Cap on the session display name (a label, not the full prompt). */
const MAX_NAME_LENGTH = 60;

/** How many spawned sub-session ids the depth-1 gate remembers. Far above any
 * plausible live sub-session count (`maxSessions` defaults to 32), so eviction
 * only ever discards long-reaped sessions. */
export const MAX_TRACKED_SPAWNED_SESSIONS = 1024;

/** Default completion TTL: `0` — completed sub-sessions are kept forever
 * (the pre-TTL behavior). Auto-removal is opt-in: set
 * `serve.subSessionCompletionTtlHours` to a non-zero number of hours to
 * enable it. */
export const DEFAULT_SUB_SESSION_COMPLETION_TTL_MS = 0;

/** How far back (bytes) discovery reads a transcript's tail to find the last
 * persisted turn result. Turn results are small and are appended at turn
 * settle, so a bounded tail reaches them for any realistic transcript; a tail
 * that cannot reach one yields "unclassifiable" and the row is kept. */
const TTL_DISCOVERY_TAIL_BYTES = 1024 * 1024;

/** How often the launcher looks for expired completed sub-sessions. TTL
 * precision is not user-visible at hour scale, so a five-minute cadence keeps
 * each sweep to a handful of map lookups and (at removal) file ops. */
const COMPLETION_TTL_SWEEP_INTERVAL_MS = 5 * 60_000;

/** Reads the state/stop-reason of the transcript's last persisted turn
 * result (`turn_result` system record, appended at turn settle). Returns
 * undefined when the transcript or a turn result cannot be read: discovery
 * must then treat the row as unclassifiable and keep it, so a bounded tail
 * that cannot reach the record fails toward retention, never toward removal.
 * Scans the tail window from the end; the window's first line may be a
 * fragment of an earlier record, and a fragment fails to parse and is
 * skipped. A turn start (a subtype-less `user` prompt record or a
 * `turn_attempt` system record) met before any turn result means the
 * session's last turn never settled — a revival interrupted before settle
 * leaves such a start at the tail — so the row is unclassifiable: an older
 * result must not classify it clean, or the sweep would remove a transcript
 * with an unfinished turn. */
async function lastPersistedTurnOutcome(
  service: SessionService,
  sessionId: string,
): Promise<{ state?: string; stopReason?: string } | undefined> {
  let filePath: string;
  try {
    filePath = service.getSessionTranscriptPath(sessionId);
  } catch {
    return undefined;
  }
  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return undefined;
  }
  const start = Math.max(0, size - TTL_DISCOVERY_TAIL_BYTES);
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    // EACCES after an ownership change, or the ENOENT in the stat/open
    // race: the tail cannot be read, so the row is unclassifiable — a
    // single poison row must not abort a whole discovery scan.
    return undefined;
  }
  let buffer: Buffer;
  try {
    buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
  } catch {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
  const lines = buffer.toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record !== 'object' || record === null) continue;
    const typed = record as {
      type?: unknown;
      subtype?: unknown;
      systemPayload?: unknown;
    };
    if (
      (typed.type === 'user' && typed.subtype === undefined) ||
      typed.subtype === 'turn_attempt'
    ) {
      return undefined;
    }
    if (typed.subtype !== 'turn_result') continue;
    const payload = typed.systemPayload;
    if (typeof payload !== 'object' || payload === null) continue;
    const outcome = payload as { state?: unknown; stopReason?: unknown };
    return {
      state: typeof outcome.state === 'string' ? outcome.state : undefined,
      stopReason:
        typeof outcome.stopReason === 'string' ? outcome.stopReason : undefined,
    };
  }
  return undefined;
}

export interface SubSessionLauncher {
  /** The `onCreateSubSession` callback wired into the bridge. Returns a Promise
   * the child's tool awaits. */
  launch(info: CreateSubSessionInfo): Promise<CreateSubSessionResult>;
  resolveDestination: ResolveSubSessionWorkspaceHandler;
  /**
   * Run a launch on behalf of a caller in another workspace. The caller's
   * launcher has already run the caller-side checks; this one spawns on its
   * own bridge, under its own caps.
   */
  launchForRemoteCaller(
    info: CreateSubSessionInfo,
    caller: RemoteSubSessionCaller,
  ): Promise<CreateSubSessionResult>;
  /**
   * A person's send from a session page (`POST /session/:id/sub-sessions`).
   * Always `sent`, and the person's choice of workspace is the approval. The
   * target keeps its own approval mode: the person could type the same
   * message into it directly. Reachable only from the daemon route, never
   * from the ACP child.
   */
  launchForPerson(
    request: PersonSubSessionRequest,
  ): Promise<CreateSubSessionResult>;
  /**
   * The `sent` launches this session made that the daemon reports back to
   * it, newest last. Kept in memory, a bounded number per caller.
   */
  listOutgoing(callerSessionId: string): OutgoingSubSessionTask[];
  /** Stop accepting new sub-sessions (daemon shutdown). Idempotent. */
  stop(reason?: 'workspace_stopped'): void;
}

/** A person's send: the open session is the caller. */
export interface PersonSubSessionRequest {
  callerSessionId: string;
  prompt: string;
  workspace?: string;
  sessionId?: string;
}

/** A `sent` launch whose result the daemon reports back to its caller. */
export interface OutgoingSubSessionTask {
  /** The completion's task id: the session id, or `<session>:<prompt>`. */
  id: string;
  sessionId: string;
  workspaceCwd: string;
  label: string;
  status: OutgoingSubSessionStatus;
  startTime: number;
  endTime?: number;
  /** A person sent it from the caller's page, not the caller's model. */
  byPerson: boolean;
  /** The target is waiting on a permission or a question. */
  waitingForInput: boolean;
}

export type OutgoingSubSessionStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Records a reported launch on the caller's launcher. */
interface OutgoingReport {
  readonly signal: AbortSignal;
  reserve(): () => void;
  started(
    task: Pick<
      OutgoingSubSessionTask,
      'id' | 'sessionId' | 'workspaceCwd' | 'label' | 'byPerson'
    >,
    sentRecord?: BridgeSessionExternalRecordRequest,
  ): void;
  waiting(waitingForInput: boolean): void;
  settled(status: Exclude<OutgoingSubSessionStatus, 'running'>): void;
}

type SentMessageTarget = Pick<
  OutgoingSubSessionTask,
  'id' | 'sessionId' | 'workspaceCwd' | 'label'
>;

/** What a person sent with `/send`, as a record in the caller's conversation. */
function sentMessageRecord(
  target: SentMessageTarget,
  message: string,
): BridgeSessionExternalRecordRequest {
  const open =
    `<sent-message session="${escapeXml(target.sessionId)}" workspace="${escapeXml(target.workspaceCwd)}" task-id="${escapeXml(target.id)}">` +
    'The user sent this message to another session with /send. It is not a request to you: that session will answer it, and its reply will come to you to pass on to the user.\n';
  const close = '</sent-message>';
  const body = escapeXmlWithinBudget(
    message,
    MAX_SENT_MESSAGE_TEXT_CHARS - open.length - close.length,
  );
  return {
    kind: 'agent_mention',
    recordKey: `send:${target.id}`,
    modelText: `${open}${body.text}${close}`,
    payload: {
      displayText: truncateUtf16(message, MAX_SENT_MESSAGE_TEXT_CHARS),
      mentionedAgentIds: [],
      sentTo: {
        sessionId: target.sessionId,
        workspaceCwd: target.workspaceCwd,
        title: target.label,
      },
    },
  };
}

/** Room for a `/send` message in a record (the child's cap is 65,536). */
const MAX_SENT_MESSAGE_TEXT_CHARS = 60_000;

/** Outgoing records kept per caller; the oldest settled ones go first. */
export const MAX_OUTGOING_PER_CALLER = 20;

/** What a target launcher needs to know about a caller in another workspace. */
export interface RemoteSubSessionCaller {
  /** The caller's live approval mode at admission. */
  approvalMode: ApprovalMode;
  /** A person sent this from the caller's page: keep the target's own mode. */
  byPerson?: boolean;
  assertCurrent(): void;
  /** Hand a `sent` completion to the caller, on the caller's own bridge. */
  deliverCompletion(notification: BridgeBackgroundNotification): Promise<void>;
  releaseCompletionSlot?: () => void;
  /** Records the launch on the caller's launcher. */
  report?: OutgoingReport;
  /** Who sent it, as the target's transcript names it. */
  source?: SubSessionPromptSource;
}

/** The sending session, stamped on the prompt the target receives. */
interface SubSessionPromptSource {
  type: 'source';
  sessionId: string;
  workspaceCwd: string;
  title?: string;
}

function sessionTitle(
  bridge: AcpSessionBridge,
  sessionId: string,
): string | undefined {
  try {
    return bridge.getSessionSummary(sessionId).displayName?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function promptSource(
  bridge: AcpSessionBridge,
  sessionId: string,
  workspaceCwd: string,
): SubSessionPromptSource {
  const title = sessionTitle(bridge, sessionId);
  return {
    type: 'source',
    sessionId,
    workspaceCwd,
    ...(title ? { title } : {}),
  };
}

/** How a launcher finds another registered workspace's launcher. */
export type SubSessionWorkspaceResolution =
  | {
      kind: 'found';
      launcher: SubSessionLauncher;
      workspaceId: string;
      workspaceCwd: string;
      workspaceGeneration: string;
      assertCurrent(): void;
    }
  | { kind: 'refused'; reason: string };

export interface CreateSubSessionLauncherOptions {
  getArchiveCoordinator?: () => SessionArchiveCoordinator | undefined;
  getBridge: () => AcpSessionBridge | undefined;
  getStandaloneSessionService?: () => StandaloneSubSessionService | undefined;
  boundWorkspace: string;
  runtimeBaseDir?: string;
  /** Return sent-mode completions to the parent as automatic follow-up turns.
   * Enabled only for the Live conversation runtime. */
  notifySentCompletion?: boolean;
  isolatedWorkspace?: {
    materializeDirectory(sessionId: string): Promise<string>;
    discardEmptyDirectory(sessionId: string): Promise<unknown>;
  };
  /** Per-request `first-turn` wall-clock timeout; defaults to
   * {@link FIRST_TURN_TIMEOUT_MS}. Exposed for tests. */
  firstTurnTimeoutMs?: number;
  /** Sent-mode background-drain ceiling; defaults to
   * {@link SENT_MODE_DRAIN_TIMEOUT_MS}. Exposed for tests. */
  sentModeDrainTimeoutMs?: number;
  /** Named sent-mode dispatch ceiling. Exposed for tests. */
  sentModeDispatchTimeoutMs?: number;
  /** Per-caller concurrency cap; defaults to
   * {@link MAX_CONCURRENT_SUB_SESSIONS_PER_CALLER}. */
  maxConcurrentPerCaller?: number;
  /** Workspace-wide concurrency cap; defaults to
   * {@link MAX_CONCURRENT_SUB_SESSIONS_TOTAL}. */
  maxConcurrentTotal?: number;
  /** Completion TTL for auto-removal of finished sub-sessions; defaults to
   * {@link DEFAULT_SUB_SESSION_COMPLETION_TTL_MS} (`0` = keep forever —
   * auto-removal is opt-in). */
  completionTtlMs?: number;
  /**
   * Resolve a request's `workspace` to that workspace's launcher. Absent
   * means this launcher cannot run sub-sessions in another workspace.
   */
  resolveWorkspace?: (selector: string) => SubSessionWorkspaceResolution;
  /** Whether this launcher's own workspace is trusted, read per launch. */
  isTrusted?: (bridge: AcpSessionBridge) => boolean;
}

/**
 * The daemon's index of sub-session launchers by workspace, and the two
 * readers every launcher is given: which launcher a request's `workspace`
 * names, and whether a launcher's own workspace is trusted.
 *
 * Only the registry's public list can be named, so internal and Live
 * conversation runtimes are out of reach, and only a trusted workspace can
 * be a target. Nothing falls back to another workspace.
 */
export function createSubSessionWorkspaceIndex(
  getRegistry: () => WorkspaceRegistry | undefined,
) {
  const launchers = new WeakMap<
    WorkspaceRuntime,
    { launcher: SubSessionLauncher; workspaceGeneration: string }
  >();
  const nameable = (registry: WorkspaceRegistry): string =>
    registry
      .list()
      .filter((runtime) => runtime.trusted && launchers.has(runtime))
      .map((runtime) =>
        runtime.displayName
          ? `${runtime.displayName} (${runtime.workspaceCwd})`
          : runtime.workspaceCwd,
      )
      .join(', ') || 'none';
  return {
    register(runtime: WorkspaceRuntime, launcher: SubSessionLauncher): void {
      launchers.set(runtime, { launcher, workspaceGeneration: randomUUID() });
    },
    getLauncher: (runtime: WorkspaceRuntime) =>
      launchers.get(runtime)?.launcher,
    resolve(selector: string): SubSessionWorkspaceResolution {
      const registry = getRegistry();
      if (!registry) {
        return { kind: 'refused', reason: 'Workspaces are not available yet.' };
      }
      const runtime =
        registry.getByWorkspaceId(selector) ??
        (isPortableAbsolutePath(selector)
          ? resolveRegisteredWorkspaceRuntimeByPathSelector(registry, selector)
          : undefined);
      const registered = runtime && launchers.get(runtime);
      if (!runtime || !registered) {
        return {
          kind: 'refused',
          reason: `No registered workspace matches "${selector}". Workspaces you can use: ${nameable(registry)}.`,
        };
      }
      if (!runtime.trusted) {
        return {
          kind: 'refused',
          reason: `Workspace ${runtime.workspaceCwd} is not trusted. Workspaces you can use: ${nameable(registry)}.`,
        };
      }
      return {
        kind: 'found',
        ...registered,
        workspaceId: runtime.workspaceId,
        workspaceCwd: runtime.workspaceCwd,
        assertCurrent() {
          runtime.generationGuard?.assertOpen();
          if (
            registry.getByWorkspaceCwd(runtime.workspaceCwd) !== runtime ||
            launchers.get(runtime) !== registered
          ) {
            throw new WorkspaceGenerationClosedError();
          }
        },
      };
    },
    isTrusted(workspaceCwd: string, bridge: AcpSessionBridge): boolean {
      const runtime = getRegistry()?.getByWorkspaceCwd(workspaceCwd);
      return (
        runtime?.bridge === bridge &&
        runtime.trusted &&
        runtime.generationGuard?.closed !== true
      );
    },
  };
}

function delegatedApprovalMode(
  caller: ApprovalMode,
  target: ApprovalMode,
): ApprovalMode {
  if (caller === target || caller === ApprovalMode.YOLO) return target;
  if (target === ApprovalMode.YOLO) return caller;
  // AUTO can approve shell commands that AUTO_EDIT would prompt for, and
  // leaving AUTO on the target restores its broad permission rules.
  if (
    target === ApprovalMode.AUTO ||
    (caller === ApprovalMode.AUTO && target === ApprovalMode.AUTO_EDIT)
  ) {
    throw new Error(
      `Cannot combine caller approval mode "${caller}" with target mode "${target}" for cross-workspace delegation.`,
    );
  }
  if (caller === ApprovalMode.PLAN || target === ApprovalMode.PLAN) {
    return ApprovalMode.PLAN;
  }
  return ApprovalMode.DEFAULT;
}

async function readApprovalMode(bridge: AcpSessionBridge, sessionId: string) {
  const assertCurrent = bridge.captureSessionApprovalModeGuard(sessionId);
  const status = await bridge.getSessionContextStatus(sessionId);
  assertCurrent();
  const { modes } = status.state;
  const modeId =
    typeof modes === 'object' && modes && 'currentModeId' in modes
      ? modes.currentModeId
      : undefined;
  return {
    mode: APPROVAL_MODES.find((mode) => mode === modeId),
    assertCurrent,
    canAcceptBackgroundNotifications:
      status.canAcceptBackgroundNotifications === true,
  };
}

type IsolatedWorkspace = NonNullable<
  CreateSubSessionLauncherOptions['isolatedWorkspace']
>;

/** A readable, control-char-free session name (the bridge's title guard rejects
 * control chars, silently dropping an unsanitized rename). */
// Unicode Bidi_Control marks — ALM (U+061C), LRM/RLM (U+200E/200F), the
// embedding/override set (U+202A..U+202E), and the isolates (U+2066..U+2069): a
// Trojan-Source-style reordering defense for the session list, mirroring the
// scheduled-task session namer. Built from a string (not a literal regex) so no
// invisible control chars appear in the source.
const BIDI_CONTROL_MARKS = new RegExp(
  '[\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]',
  'g',
);

function subSessionName(label: string): string {
  const cleaned = stripTerminalControlSequences(label)
    .replace(BIDI_CONTROL_MARKS, '')
    .trim()
    .replace(/\s+/g, ' ');
  if (cleaned.length <= MAX_NAME_LENGTH) return cleaned;
  let cut = MAX_NAME_LENGTH - 1;
  const boundary = cleaned.charCodeAt(cut - 1);
  if (boundary >= 0xd800 && boundary <= 0xdbff) cut -= 1;
  return `${cleaned.slice(0, cut)}…`;
}

function sentCompletionStatus(
  stopReason: string,
): 'completed' | 'failed' | 'cancelled' {
  if (stopReason === 'end_turn') return 'completed';
  if (stopReason === 'cancelled' || stopReason === 'shutdown') {
    return 'cancelled';
  }
  return 'failed';
}

function truncateCodePoints(value: string, max: number): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= max) return value;
  return `${codePoints.slice(0, Math.max(0, max - 1)).join('')}…`;
}

function truncateUtf16(value: string, max: number): string {
  if (value.length <= max) return value;
  let cut = max - 1;
  const boundary = value.charCodeAt(cut - 1);
  if (boundary >= 0xd800 && boundary <= 0xdbff) cut -= 1;
  return `${value.slice(0, cut)}…`;
}

/** How much of a person's `/send` message the reply's notification repeats. */
const MAX_PERSON_MESSAGE_CHARS = 2_000;

function buildSentCompletionNotification(
  sessionId: string,
  label: string,
  result: string,
  stopReason: string,
  workspaceCwd?: string,
  taskId = sessionId,
  /**
   * The message a person sent with `/send`. Its reply comes back as a turn
   * in which the caller's model tells the person what the target said.
   */
  personMessage?: string,
  fromSession?: BridgeBackgroundNotification['fromSession'],
  sentMessageContext?: string,
): BridgeBackgroundNotification {
  const status = sentCompletionStatus(stopReason);
  const boundedStopReason = truncateCodePoints(stopReason, 128);
  const statusText =
    status === 'completed'
      ? 'completed'
      : status === 'cancelled'
        ? 'was cancelled'
        : `failed (${boundedStopReason})`;
  const sessionUrl =
    `qwen-session://${sessionId}` +
    (workspaceCwd
      ? `?${new URLSearchParams({ workspace: workspaceCwd })}`
      : '');
  const sessionLink = `[${sessionId.slice(0, 8)}](${sessionUrl})`;
  const safeResult =
    result.trim() || `No text output (stopReason: ${stopReason}).`;
  const modelSessionId = truncateCodePoints(sessionId, 256);
  const modelLabel = truncateUtf16(label, 256);
  const modelTextPrefix = [
    '<task-notification>',
    `<task-id>${escapeXml(modelSessionId)}</task-id>`,
    `<status>${status}</status>`,
    personMessage === undefined
      ? `<summary>Sub-session &quot;${escapeXml(modelLabel)}&quot; ${escapeXml(statusText)}.</summary>`
      : `<summary>The user sent the message below to another session with /send. That session's turn ${escapeXml(statusText)}, and its reply is the result. Tell the user what it replied, in your own words, and anything they need to act on.</summary>` +
        `<message>${escapeXml(truncateCodePoints(personMessage, MAX_PERSON_MESSAGE_CHARS))}</message>`,
    // A person's reply is for the person, who has the session in the page.
    ...(personMessage === undefined
      ? [`<session-link>${escapeXml(sessionUrl)}</session-link>`]
      : []),
    '<result>',
  ].join('');
  const modelTextSuffix = '</result></task-notification>';
  const resultBudget = Math.max(
    0,
    MAX_SENT_COMPLETION_MODEL_TEXT_CHARS -
      modelTextPrefix.length -
      modelTextSuffix.length,
  );
  let preview = escapeXmlWithinBudget(safeResult, resultBudget);
  const marker = SENT_COMPLETION_RESULT_TRUNCATION_MARKER;
  if (preview.truncated && marker.length <= resultBudget) {
    preview = escapeXmlWithinBudget(safeResult, resultBudget - marker.length);
    preview.text += marker;
  }
  const modelText = `${modelTextPrefix}${preview.text}${modelTextSuffix}`;
  return {
    displayText:
      personMessage === undefined
        ? `Sub-session ${sessionLink} ${statusText}.`
        : `Session ${sessionLink} replied (${statusText}).`,
    modelText,
    taskId,
    status,
    kind: 'agent' as const,
    ...(fromSession !== undefined ? { fromSession } : {}),
    ...(sentMessageContext !== undefined ? { sentMessageContext } : {}),
    // `subSessionName` strips bidi and control marks and trims, so a name that
    // was only those characters leaves an empty label -- which the receiving
    // gate rejects as invalid params. The acceptance wait treats that as
    // retryable and gives up 30 minutes later, so the parent's completion turn
    // never runs. An absent label is valid; an empty one is not.
    ...(modelLabel.trim() ? { label: modelLabel } : {}),
  };
}

function isBackgroundNotificationForTask(
  event: { type: string; data: unknown },
  taskId: string,
): boolean {
  if (event.type !== 'session_update') return false;
  const update = (
    event.data as
      | {
          update?: {
            _meta?: {
              source?: unknown;
              backgroundTask?: { taskId?: unknown };
            };
          };
        }
      | null
      | undefined
  )?.update;
  return (
    update?._meta?.source === 'background_notification' &&
    update._meta.backgroundTask?.taskId === taskId
  );
}

async function awaitRecoveredParentNotification(
  bridge: AcpSessionBridge,
  sessionId: string,
  notification: BridgeBackgroundNotification,
  lastEventId: number,
  eventEpoch: string,
  stopSignal: AbortSignal,
): Promise<boolean> {
  const timeoutAc = new AbortController();
  const timer = setTimeout(
    () => timeoutAc.abort(),
    RECOVERED_PARENT_NOTIFICATION_TIMEOUT_MS,
  );
  if (typeof timer.unref === 'function') timer.unref();
  const signal = AbortSignal.any([stopSignal, timeoutAc.signal]);
  let observedOwnNotification = false;

  try {
    for await (const event of bridge.subscribeEvents(sessionId, {
      lastEventId,
      epoch: eventEpoch,
      signal,
    })) {
      if (isBackgroundNotificationForTask(event, notification.taskId)) {
        observedOwnNotification = true;
      } else if (
        observedOwnNotification &&
        event.type === 'background_notification_turn_complete'
      ) {
        return true;
      }
    }
  } finally {
    clearTimeout(timer);
    timeoutAc.abort();
  }

  return false;
}

async function waitForSentCompletionRetry(
  signal: AbortSignal,
  attempt: number,
): Promise<void> {
  if (signal.aborted) throw signal.reason;
  const delay = Math.min(
    SENT_COMPLETION_DELIVERY_RETRY_MS * 2 ** attempt,
    SENT_COMPLETION_DELIVERY_MAX_RETRY_MS,
  );
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function awaitSentCompletionAcceptance(
  bridge: AcpSessionBridge,
  parentSessionId: string,
  notification: BridgeBackgroundNotification,
  stopSignal: AbortSignal,
  deadline: number,
): Promise<'accepted' | 'missing'> {
  let lastError: unknown;
  let attempt = 0;
  while (!stopSignal.aborted) {
    try {
      const acknowledgement = await bridge.enqueueBackgroundNotification(
        parentSessionId,
        notification,
      );
      if (acknowledgement.accepted) return 'accepted';
    } catch (error) {
      if (error instanceof SessionNotFoundError) return 'missing';
      lastError = error;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Parent ${parentSessionId} did not durably accept completion for sub-session ${notification.taskId}.`,
        lastError === undefined ? undefined : { cause: lastError },
      );
    }
    await waitForSentCompletionRetry(stopSignal, attempt);
    attempt += 1;
  }
  throw stopSignal.reason;
}

async function deliverSentCompletion(
  bridge: AcpSessionBridge,
  boundWorkspace: string,
  parentSessionId: string,
  notification: BridgeBackgroundNotification,
  stopSignal: AbortSignal,
  isolatedWorkspace?: IsolatedWorkspace,
  standaloneService?: StandaloneSubSessionService,
): Promise<void> {
  const deadline = Date.now() + RECOVERED_PARENT_NOTIFICATION_TIMEOUT_MS;
  const initialDelivery = await awaitSentCompletionAcceptance(
    bridge,
    parentSessionId,
    notification,
    stopSignal,
    deadline,
  );
  if (initialDelivery === 'accepted') return;

  if (standaloneService) {
    await standaloneService.resume(parentSessionId);
    let ownerBridge: AcpSessionBridge | undefined;
    let ownerSessionId = '';
    let lastEventId = 0;
    let eventEpoch = '';
    const recoveredDelivery = await standaloneService.continueSession(
      parentSessionId,
      async (runtime, canonicalSessionId) => {
        ownerBridge = runtime.bridge;
        ownerSessionId = canonicalSessionId;
        lastEventId = runtime.bridge.getSessionLastEventId(canonicalSessionId);
        eventEpoch = runtime.bridge.getSessionEventEpoch(canonicalSessionId);
        return awaitSentCompletionAcceptance(
          runtime.bridge,
          canonicalSessionId,
          notification,
          stopSignal,
          deadline,
        );
      },
    );
    if (recoveredDelivery === 'missing' || !ownerBridge || !ownerSessionId) {
      throw new SessionNotFoundError(parentSessionId);
    }
    void awaitRecoveredParentNotification(
      ownerBridge,
      ownerSessionId,
      notification,
      lastEventId,
      eventEpoch,
      stopSignal,
    ).then(
      (continuationCompleted) => {
        if (!continuationCompleted && !stopSignal.aborted) {
          writeStderrLine(
            `qwen serve: restored parent ${parentSessionId} accepted completion ` +
              `for sub-session ${notification.taskId}, but its automatic continuation ` +
              `did not reach an end-turn boundary; leaving recovery attachment for ` +
              `the idle reaper`,
          );
        }
      },
      (error) => {
        if (!stopSignal.aborted) {
          writeStderrLine(
            `qwen serve: restored parent ${parentSessionId} accepted completion ` +
              `for sub-session ${notification.taskId}, but its automatic continuation ` +
              `could not be observed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );
    return;
  }

  let restoredParent: BridgeSession | undefined;
  // Materialize before restore so the first synchronous operation after the
  // bridge registers the parent can reserve its prompt queue for relocation.
  // That keeps a concurrently arriving prompt behind the cwd change.
  const isolatedCwd = isolatedWorkspace
    ? await isolatedWorkspace.materializeDirectory(parentSessionId)
    : undefined;
  let materializedDirectoryUnused = isolatedCwd !== undefined;
  try {
    restoredParent = await bridge.resumeSession({
      sessionId: parentSessionId,
      workspaceCwd: boundWorkspace,
    });
    if (isolatedCwd !== undefined) {
      if (
        restoredParent.hasActivePrompt === true &&
        restoredParent.currentCwd !== isolatedCwd
      ) {
        throw new Error(
          'Active restored parent is outside its isolated conversation directory.',
        );
      }
      if (restoredParent.hasActivePrompt === true) {
        materializedDirectoryUnused = false;
      }
      if (restoredParent.hasActivePrompt !== true) {
        // Once relocation begins, retain the directory if the bridge throws: a
        // caller-facing timeout does not cancel the queued cwd change.
        materializedDirectoryUnused = false;
        const changed = await bridge.changeSessionCwd(parentSessionId, {
          path: isolatedCwd,
          allowedRoots: [boundWorkspace],
          managedRelocation: 'live-conversation',
        });
        if (changed.newCwd !== isolatedCwd) {
          materializedDirectoryUnused = true;
          throw new Error(
            'Restored parent workspace directory relocation was rejected.',
          );
        }
        restoredParent.currentCwd = changed.newCwd;
      }
    }
    const lastEventId = bridge.getSessionLastEventId(parentSessionId);
    const eventEpoch = bridge.getSessionEventEpoch(parentSessionId);
    const recoveredDelivery = await awaitSentCompletionAcceptance(
      bridge,
      parentSessionId,
      notification,
      stopSignal,
      deadline,
    );
    if (recoveredDelivery === 'missing') {
      throw new SessionNotFoundError(parentSessionId);
    }

    // Keep the recovery registration until the ordinary idle reaper removes it.
    // `background_notification_turn_complete` is emitted just before the child
    // finishes its notification-drain cleanup, and another worker completion may
    // already be queued behind it. An immediate detach can therefore close the
    // only restored parent underneath either operation. The bridge reaper ignores
    // stale client registrations and provides the bounded cleanup path here.
    void awaitRecoveredParentNotification(
      bridge,
      parentSessionId,
      notification,
      lastEventId,
      eventEpoch,
      stopSignal,
    ).then(
      (continuationCompleted) => {
        if (!continuationCompleted && !stopSignal.aborted) {
          writeStderrLine(
            `qwen serve: restored parent ${parentSessionId} accepted completion ` +
              `for sub-session ${notification.taskId}, but its automatic continuation ` +
              `did not reach an end-turn boundary; leaving recovery attachment for ` +
              `the idle reaper`,
          );
        }
      },
      (error) => {
        if (!stopSignal.aborted) {
          writeStderrLine(
            `qwen serve: restored parent ${parentSessionId} accepted completion ` +
              `for sub-session ${notification.taskId}, but its automatic continuation ` +
              `could not be observed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );
  } catch (error) {
    let recoveredParentClosed = false;
    if (restoredParent !== undefined) {
      try {
        if (restoredParent.hasActivePrompt === true) {
          if (restoredParent.clientId) {
            await bridge.detachClient(
              restoredParent.sessionId,
              restoredParent.clientId,
            );
          }
        } else if (restoredParent.attached) {
          if (restoredParent.clientId) {
            await bridge.detachClient(
              restoredParent.sessionId,
              restoredParent.clientId,
            );
          }
        } else {
          recoveredParentClosed = await bridge.killSession(
            restoredParent.sessionId,
            { requireZeroAttaches: true },
          );
        }
      } catch {
        recoveredParentClosed = false;
      }
    }
    if (
      isolatedWorkspace &&
      isolatedCwd !== undefined &&
      (recoveredParentClosed || materializedDirectoryUnused)
    ) {
      await isolatedWorkspace
        .discardEmptyDirectory(parentSessionId)
        .catch(() => {});
    }
    throw error;
  }
}

/** Accumulate the sub-session's first-turn text from its event stream, stopping
 * at `turn_complete`/`turn_error` for `promptId` (or a wall-clock timeout, or
 * an external shutdown signal from `stop()`). */
async function awaitFirstTurn(
  bridge: AcpSessionBridge,
  sessionId: string,
  promptId: string,
  lastEventId: number,
  timeoutMs: number,
  stopSignal?: AbortSignal,
  options?: {
    /** Count only chunks stamped with this prompt's ID. */
    requirePromptId?: boolean;
    onTimeout?: () => void;
    /** Called when the session starts or stops waiting on a permission. */
    onWaitingChange?: (waiting: boolean) => void;
    pendingPermissionIds?: readonly string[];
  },
): Promise<{ result: string; stopReason: string }> {
  const ac = new AbortController();
  // `ac.signal.aborted` cannot report whether the deadline passed: the `finally`
  // below aborts unconditionally to tear the subscription down, so by the time
  // the stopReason is computed the signal is always aborted. Record the timer
  // firing separately, or a stream that closes early (bridge teardown, WS drop)
  // is misreported as a 5-minute wall-clock timeout.
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let remaining = timeoutMs;
  let startedAt = 0;
  const armTimeout = () => {
    startedAt = Date.now();
    timer = setTimeout(() => {
      timedOut = true;
      options?.onTimeout?.();
      ac.abort();
    }, remaining);
    timer.unref();
  };
  // Compose: the subscription ends on timeout OR daemon shutdown, whichever
  // fires first. Without this, stop() cannot interrupt a first-turn await and
  // shutdown hangs for up to timeoutMs (5 min default).
  const composed = stopSignal
    ? AbortSignal.any([ac.signal, stopSignal])
    : ac.signal;

  let acc = '';
  let truncated = false;
  let stopReason: string | undefined;

  const appendChunk = (text: string): void => {
    if (truncated) return;
    if (acc.length + text.length > MAX_RESULT_CHARS) {
      // Surrogate-pair-safe: if the cut lands on a high surrogate, back up
      // one code unit so we don't emit a lone leading surrogate.
      let cut = Math.max(0, MAX_RESULT_CHARS - acc.length);
      if (cut > 0) {
        const code = text.charCodeAt(cut - 1);
        if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
      }
      acc += text.slice(0, cut);
      truncated = true;
    } else {
      acc += text;
    }
  };

  const pendingPermissions = new Set(options?.pendingPermissionIds);
  if (pendingPermissions.size > 0) options?.onWaitingChange?.(true);
  else armTimeout();
  const trackPermission = (requestId: unknown, pending: boolean): void => {
    if (!options?.onWaitingChange || typeof requestId !== 'string') return;
    const before = pendingPermissions.size > 0;
    if (pending) pendingPermissions.add(requestId);
    else pendingPermissions.delete(requestId);
    const after = pendingPermissions.size > 0;
    if (before === after) return;
    if (after) {
      clearTimeout(timer);
      remaining = Math.max(0, remaining - (Date.now() - startedAt));
    } else {
      armTimeout();
    }
    options.onWaitingChange(after);
  };

  try {
    for await (const e of bridge.subscribeEvents(sessionId, {
      lastEventId,
      signal: composed,
    })) {
      if (e.type === 'permission_request') {
        trackPermission((e.data as { requestId?: unknown })?.requestId, true);
      } else if (
        e.type === 'permission_resolved' ||
        e.type === 'permission_already_resolved'
      ) {
        trackPermission((e.data as { requestId?: unknown })?.requestId, false);
      } else if (e.type === 'session_update') {
        const d = e.data as {
          update?: {
            sessionUpdate?: string;
            content?: { text?: string };
            _meta?: { source?: string };
          };
        };
        if (
          d?.update?.sessionUpdate === 'agent_message_chunk' &&
          typeof d.update.content?.text === 'string' &&
          (e.promptId === promptId ||
            (!options?.requirePromptId && e.promptId === undefined)) &&
          d.update._meta?.source !== 'background_task_completed' &&
          d.update._meta?.source !== 'background_notification' &&
          d.update._meta?.source !== 'background_notification_turn_started'
        ) {
          appendChunk(d.update.content.text);
        }
      } else if (e.type === 'turn_complete') {
        const d = e.data as { promptId?: string; stopReason?: string };
        if (d?.promptId === promptId) {
          stopReason = d.stopReason ?? 'end_turn';
          break;
        }
      } else if (e.type === 'turn_error') {
        const d = e.data as { promptId?: string; message?: string };
        if (d?.promptId === promptId) {
          stopReason = 'error';
          if (d.message && !truncated) {
            const suffix = `${acc ? '\n' : ''}[turn error] ${d.message}`;
            if (acc.length + suffix.length <= MAX_RESULT_CHARS) {
              acc += suffix;
            } else {
              truncated = true;
            }
          }
          break;
        }
      }
    }
  } finally {
    clearTimeout(timer);
    ac.abort(); // tear down the subscription on any exit
  }

  if (stopReason === undefined) {
    // Distinguish shutdown (stop() called) from timeout from bus-closure so the
    // caller can tell the difference between "daemon is going away", "the
    // sub-session turn didn't finish in time", and "the event stream ended
    // before the turn did".
    stopReason = stopSignal?.aborted
      ? 'shutdown'
      : timedOut
        ? 'timeout'
        : 'incomplete';
  }
  if (truncated) acc += '\n[…output truncated]';
  return { result: acc, stopReason };
}

export function createSubSessionLauncher(
  opts: CreateSubSessionLauncherOptions,
): SubSessionLauncher {
  const {
    getBridge,
    getArchiveCoordinator,
    getStandaloneSessionService,
    boundWorkspace,
    runtimeBaseDir,
    notifySentCompletion = false,
    isolatedWorkspace,
    resolveWorkspace,
    isTrusted,
  } = opts;
  const firstTurnTimeoutMs = opts.firstTurnTimeoutMs ?? FIRST_TURN_TIMEOUT_MS;
  const sentModeDispatchTimeoutMs =
    opts.sentModeDispatchTimeoutMs ?? SENT_MODE_DISPATCH_TIMEOUT_MS;
  const sentModeDrainTimeoutMs =
    opts.sentModeDrainTimeoutMs ?? SENT_MODE_DRAIN_TIMEOUT_MS;
  const maxConcurrentPerCaller =
    opts.maxConcurrentPerCaller ?? MAX_CONCURRENT_SUB_SESSIONS_PER_CALLER;
  // Clamped to the tracked-id set size so the in-flight population can never
  // exceed it. This bounds concurrency, not the depth-1 gate: ids leave
  // `spawnedSessionIds` only by FIFO eviction past that cap (finished ids are
  // never removed), so once cumulative spawns pass it a still-alive id can
  // still be evicted and the gate degrades to best-effort.
  const maxConcurrentTotal = Math.min(
    opts.maxConcurrentTotal ?? MAX_CONCURRENT_SUB_SESSIONS_TOTAL,
    MAX_TRACKED_SPAWNED_SESSIONS,
  );
  const completionTtlMs =
    opts.completionTtlMs ?? DEFAULT_SUB_SESSION_COMPLETION_TTL_MS;
  const inflight = new Map<string, number>();
  // Ids of the sub-sessions this launcher spawned — the depth-1 gate reads it.
  // Insertion-ordered and evicted FIFO past the cap so a long-lived daemon
  // can't accumulate ids forever; an evicted id belongs to a sub-session old
  // enough to have been idle-reaped long ago. Ids also leave when a TTL
  // removal confirms the session fully gone (live entry closed, transcript
  // gone); the gate's durable fallback (the caller's persisted parent
  // lineage) covers restored children either way.
  const spawnedSessionIds = new Set<string>();
  // Completion clocks — the completion TTL candidate source. A clean
  // completion (`end_turn`) stamps it in-process; a persisted row discovered
  // on disk (previous daemon lifetime) is seeded from its transcript's last
  // write. The sweep iterates THIS map, so FIFO eviction of the gate set
  // above never loses a clock; entries leave only when a removal confirms the
  // session gone or the user archived it.
  const completedAt = new Map<string, number>();
  // Observed terminal outcomes that are not clean completions (`error`,
  // `cancelled`, ...): the turn is over, but its diagnostic transcript is
  // kept — these ids never become removal candidates, even once their live
  // entry is idle-reaped.
  const nonCleanTerminal = new Set<string>();
  // Shared AbortController — stop() aborts it, tearing down every active
  // subscription (first-turn awaits AND sent-mode background drains). This
  // prevents shutdown from waiting up to 5 min per in-flight session.
  const stopAc = new AbortController();

  // Sum of `inflight`, tracked separately so the workspace-wide cap holds even
  // when a caller opens a fresh bucket per launch.
  let inflightTotal = 0;
  let outstandingRemoteCompletions = 0;

  const release = (key: string): void => {
    const n = (inflight.get(key) ?? 1) - 1;
    if (n <= 0) inflight.delete(key);
    else inflight.set(key, n);
    inflightTotal = Math.max(0, inflightTotal - 1);
  };

  const rememberSpawned = (sessionId: string): void => {
    spawnedSessionIds.add(sessionId);
    while (spawnedSessionIds.size > MAX_TRACKED_SPAWNED_SESSIONS) {
      const oldest = spawnedSessionIds.values().next().value;
      if (oldest === undefined) break;
      spawnedSessionIds.delete(oldest);
      // The completion clock is NOT evicted here: the sweep iterates
      // `completedAt`, so an evicted-but-completed id still gets removed
      // when its TTL fires (eviction bounds the depth-1 gate set only).
    }
  };

  /** Record a turn outcome for the completion TTL. A clean completion
   * (`end_turn`) starts the clock. An observed terminal failure (`error`,
   * `cancelled`, and any future non-success reason) keeps the diagnostic
   * transcript: removal is an allowlist, so those transcripts are never
   * candidates. The first-turn observer's undecided reportings — 'timeout'
   * (wall-clock ceiling: the turn may still be running), 'incomplete'
   * (stream closed before the turn ended), 'shutdown' (daemon going away) —
   * start nothing here; if the reaper later closes the session work-free,
   * the sweep's unobserved-completion fallback starts the clock. */
  const recordTurnOutcome = (sessionId: string, stopReason: string): void => {
    if (completionTtlMs <= 0) return;
    if (
      stopReason === 'timeout' ||
      stopReason === 'incomplete' ||
      stopReason === 'shutdown'
    ) {
      return;
    }
    if (stopReason === 'end_turn') {
      completedAt.set(sessionId, Date.now());
      return;
    }
    nonCleanTerminal.add(sessionId);
  };

  /** Remove the persisted transcript/catalog row of a sub-session, resolved
   * under the launcher's runtime base dir when it has one, so the removed row
   * is the one the disk-scan session listing reads. Returns whether the
   * transcript was removed. Shared by the TTL sweep and the launch rollbacks. */
  const removeSubSessionTranscript = async (
    sessionId: string,
  ): Promise<boolean> => {
    const removeTranscript = () =>
      new SessionService(boundWorkspace).removeSession(sessionId);
    return runtimeBaseDir
      ? await Storage.runWithResolvedRuntimeBaseDir(
          runtimeBaseDir,
          removeTranscript,
        )
      : await removeTranscript();
  };

  /** The persisted state a removal must confirm against: the transcript's
   * last write (ms) and the row's archive state. Read only on the removal
   * path, not per session per tick. `archived` is tri-state: a row whose
   * location cannot be read (`undefined`) fails toward retention — the
   * caller keeps it and its clock armed for the next sweep. */
  const persistedRemovalState = async (
    sessionId: string,
  ): Promise<{
    lastActivity?: number;
    /** `true`: the row is archived, or present in both the active and the
     * archive directories — keep it forever. `false`: the row is active or
     * absent. `undefined`: the location read failed — neither; keep and
     * retry. */
    archived: boolean | undefined;
  }> => {
    const read = async (): Promise<{
      lastActivity?: number;
      archived: boolean | undefined;
    }> => {
      const service = new SessionService(boundWorkspace);
      let archived: boolean | undefined;
      try {
        // The keep-forever guard must classify with the lifecycle
        // classifier: `getSessionLocation` cannot see an archived copy
        // whose head is empty or damaged (it returns undefined) and
        // reports a both-dirs row as a conflict the removal would then
        // destroy, archived copy included.
        const location =
          await service.getMaintainableSessionLocation(sessionId);
        archived = location !== undefined && location !== 'active';
      } catch {
        archived = undefined;
      }
      let lastActivity: number | undefined;
      try {
        lastActivity = fs.statSync(
          service.getSessionTranscriptPath(sessionId),
        ).mtimeMs;
      } catch {
        lastActivity = undefined;
      }
      return { lastActivity, archived };
    };
    try {
      return runtimeBaseDir
        ? await Storage.runWithResolvedRuntimeBaseDir(runtimeBaseDir, read)
        : await read();
    } catch {
      return { archived: undefined };
    }
  };

  /** The removal allowlist, judged on disk: the transcript's last persisted
   * turn result must be a proven clean completion, with discovery's
   * predicate. `missing` (no transcript) keeps today's path — the removal
   * is a no-op that prints nothing; `keep` (a non-clean or unclassifiable
   * tail) fails toward retention and leaves the clock armed. */
  const persistedRemovalOutcome = async (
    sessionId: string,
  ): Promise<'clean' | 'keep' | 'missing'> => {
    const check = async (): Promise<'clean' | 'keep' | 'missing'> => {
      const service = new SessionService(boundWorkspace);
      let exists = false;
      try {
        fs.statSync(service.getSessionTranscriptPath(sessionId));
        exists = true;
      } catch {
        return 'missing';
      }
      const outcome = await lastPersistedTurnOutcome(service, sessionId);
      return exists &&
        outcome?.state === 'completed' &&
        outcome?.stopReason === 'end_turn'
        ? 'clean'
        : 'keep';
    };
    return runtimeBaseDir
      ? await Storage.runWithResolvedRuntimeBaseDir(runtimeBaseDir, check)
      : await check();
  };

  /** A live entry is a removal candidate only when it is free of work: an
   * admitted prompt, running background tasks, or an active work state each
   * keep the transcript. */
  const isWorkFree = (summary: BridgeSessionSummary): boolean =>
    !summary.hasActivePrompt &&
    summary.hasRunningBackgroundTasks !== true &&
    summary.activeWorkState !== 'active';

  /** Remove a TTL-expired completed sub-session whose clock fell due at
   * `due`. The eligibility decision and the mutation are one step under the
   * session's exclusive lifecycle lane (the guard archive/delete take and
   * prompt admission shares): while it is held no prompt can be admitted, and
   * a lane already held — an in-flight admission, an archive or delete —
   * refuses the removal, which keeps the clock armed for the next sweep.
   * Under the lane the removal re-checks the persisted row first (an
   * archived row is kept forever — the single archive authority, since the
   * live summary never carries its own archived state; a location that
   * cannot be read keeps the clock armed), then "still terminal and
   * inactive" (a second attached client keeps the session live; activity
   * newer than `due` restarts the clock), conditionally closes the live
   * entry (it may already be gone — the idle reaper wins that race all the
   * time; a client attached in the gap leaves it live), re-validates that
   * no revival re-created it, and re-judges the removal allowlist on disk
   * — the transcript's last persisted turn result must still be a proven
   * clean completion, so a revival whose turn failed or never settled keeps
   * its diagnostic transcript. Only then it removes the persisted
   * transcript/catalog row, drops the session's attachment store
   * best-effort, and advances the catalog clock. Mirrors the rollback
   * cleanup of a failed launch. Any failure keeps the entry in
   * `completedAt` so the next sweep retries.
   * Terminal state: once the live entry is confirmed gone and the transcript
   * is gone (removed here or already absent), the id leaves both clocks, so a
   * later sweep cannot re-process it; the operator line prints only when this
   * call actually removed the transcript. */
  const removeExpiredSubSession = async (
    sessionId: string,
    due: number,
  ): Promise<void> => {
    const bridge = getBridge();
    if (!bridge) return;
    /** The live summary; `undefined` when the entry is gone, `null` when the
     * read failed (skip — the next sweep retries). */
    const readSummary = (): BridgeSessionSummary | undefined | null => {
      try {
        return bridge.getSessionSummary(sessionId);
      } catch (error) {
        if (error instanceof SessionNotFoundError) return undefined;
        log.debug('sub-session: TTL summary failed', sessionId, error);
        return null;
      }
    };
    const removeUnderLane = async (): Promise<void> => {
      // The single archive authority is the persisted row's location: the
      // live summary never carries its own archived state (the bridge
      // builder does not set it), so both the live and the reaped branch
      // must consult the row. A row the user archived is kept forever.
      const persisted = await persistedRemovalState(sessionId);
      if (persisted.archived === true) {
        completedAt.delete(sessionId);
        nonCleanTerminal.delete(sessionId);
        return;
      }
      if (persisted.archived === undefined) {
        return; // the location read failed: keep, clock stays armed
      }
      let summary = readSummary();
      if (summary === null) return;
      if (summary === undefined) {
        // A reaped (or discovered) transcript: activity newer than the
        // armed clock restarts it (a revived turn re-created the
        // transcript). Whether the revived turn settled clean is judged
        // again below, on disk, before any mutation.
        if (
          persisted.lastActivity !== undefined &&
          persisted.lastActivity > due
        ) {
          completedAt.set(sessionId, persisted.lastActivity);
          return;
        }
        // The read above awaited: decide on the live entry as it is now.
        summary = readSummary();
        if (summary === null) return;
      }
      if (summary !== undefined) {
        if (!isWorkFree(summary)) return;
        // The launcher itself holds one registration; a second client
        // (a reader attached from the roster) keeps the session live —
        // mirror the launcher's own rollback guard.
        if ((summary.clientCount ?? 0) > 1) return;
        const lastActivity = Date.parse(summary.updatedAt ?? summary.createdAt);
        if (Number.isFinite(lastActivity) && lastActivity > due) {
          completedAt.set(sessionId, lastActivity);
          return;
        }
      }
      // No await between the decision above and the close. Conditional:
      // a client that attached in the gap leaves the session live and the
      // re-validation below keeps its transcript with the clock armed.
      try {
        await bridge.closeSession(sessionId, undefined, {
          reason: 'sub_session_completion_ttl',
          closeIfUnheld: true,
        });
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          // Already gone (idle-reaped) — proceed to the persisted row.
        } else {
          log.debug('sub-session: TTL close failed', sessionId, error);
          return; // keep the entry armed for the next sweep
        }
      }
      // Re-validate immediately before the persisted mutation: a revival
      // that bypasses the lifecycle lane can still re-create a live entry
      // after the close, and that session must keep its transcript (the next
      // sweep restarts its clock from the fresh activity).
      if (readSummary() !== undefined) return;
      // The removal allowlist, judged on disk at removal time: a revival's
      // failed or never-settled turn is only visible there (the in-process
      // observation missed it), and its transcript is kept.
      if ((await persistedRemovalOutcome(sessionId)) === 'keep') return;
      let transcriptRemoved: boolean;
      try {
        transcriptRemoved = await removeSubSessionTranscript(sessionId);
      } catch (error) {
        log.debug(
          'sub-session: TTL transcript removal failed',
          sessionId,
          error,
        );
        return; // keep the entry armed for the next sweep
      }
      // Terminal state: the live entry is confirmed gone and the transcript
      // is gone. Leave no clock behind for the id.
      completedAt.delete(sessionId);
      spawnedSessionIds.delete(sessionId);
      nonCleanTerminal.delete(sessionId);
      if (transcriptRemoved) {
        bridge.markSessionCatalogChanged();
        writeStderrLine(
          `qwen serve: removed completed sub-session ${sessionId} from the roster ` +
            `(completion TTL ${Math.round(completionTtlMs / 60_000)}min expired)`,
        );
      }
      // A reaped orphan is never looked up again; without this the
      // attachment bytes leak from both storage roots (mirror the
      // daemon's own delete path).
      try {
        await bridge.deleteSessionAttachments(sessionId);
      } catch (error) {
        log.debug(
          'sub-session: TTL attachment removal failed',
          sessionId,
          error,
        );
      }
    };
    const coordinator = getArchiveCoordinator?.();
    try {
      await (coordinator
        ? coordinator.runExclusiveMany([sessionId], removeUnderLane)
        : removeUnderLane());
    } catch (error) {
      // The lane is held (SessionArchivingError: a prompt being admitted, an
      // archive, delete, or restore) or the daemon is draining: keep the
      // entry armed for the next sweep.
      log.debug('sub-session: TTL removal deferred', sessionId, error);
    }
  };

  /** Discover persisted sub-session transcripts once per launcher lifetime.
   * The in-memory clocks are process-local, so after a daemon restart every
   * previously completed sub-session would be orphaned — its transcript would
   * outlive the configured retention indefinitely. A one-time disk scan
   * re-arms the transcripts it can prove finished: an active catalog row whose
   * persisted creation metadata names a parent session is a sub-session (it
   * cannot be the daemon's primary session), and its last persisted turn
   * result must be a clean completion (`completed`/`end_turn`) — a failed or
   * cancelled turn keeps its diagnostic transcript, and a transcript without
   * a readable turn result, or whose last turn started but never settled, is
   * unclassifiable, so it stays with the user. An
   * armed row's TTL clock starts at the transcript's last write. Discovered
   * rows are seeded into `completedAt` only — never into `spawnedSessionIds`,
   * whose depth-1 gate must count only the live roster. A scan failure
   * re-arms the discovery for the next sweep. */
  let persistedSubSessionsDiscovered = false;
  const discoverPersistedSubSessions = async (): Promise<void> => {
    if (persistedSubSessionsDiscovered) return;
    persistedSubSessionsDiscovered = true;
    const listAll = async (): Promise<void> => {
      const service = new SessionService(boundWorkspace);
      // Tie-safe exhaustive enumeration (see listAllProjectSessionIds): the
      // paged listSessions mtime cursor silently skips sessions whose mtime
      // ties with a page's last entry, which an all-sessions sweep must
      // never do.
      const sessionIds = await service.listAllProjectSessionIds('active');
      for (const sessionId of sessionIds) {
        if (completedAt.has(sessionId)) continue;
        // Only sub-sessions are TTL candidates: the persisted creation
        // metadata names a parent session.
        const parentSessionId = await service.readParentSessionId(sessionId);
        if (parentSessionId === undefined) continue;
        // The restart path reaps only what it can prove clean.
        const outcome = await lastPersistedTurnOutcome(service, sessionId);
        if (
          outcome?.state !== 'completed' ||
          outcome?.stopReason !== 'end_turn'
        ) {
          continue;
        }
        const lastActivity = (await persistedRemovalState(sessionId))
          .lastActivity;
        if (lastActivity !== undefined) {
          completedAt.set(sessionId, lastActivity);
        }
      }
    };
    try {
      await (runtimeBaseDir
        ? Storage.runWithResolvedRuntimeBaseDir(runtimeBaseDir, listAll)
        : listAll());
    } catch (error) {
      log.debug('sub-session: TTL discovery failed', error);
      persistedSubSessionsDiscovered = false;
    }
  };

  /** One sweep over the removal candidates. The candidate set is the
   * completion clocks (`completedAt`) plus any tracked roster id that never
   * got a clock — iterating the clocks means a FIFO-evicted completedAt entry
   * is never lost, while the gate set itself keeps its cap. A live entry is
   * removable only when it is free of work: an admitted prompt, running
   * background tasks, or an active work state all keep the transcript, and a
   * post-completion send_message revival restarts the clock from the fresh
   * activity. An entry with no live summary is a reaped (or discovered)
   * transcript; its clock starts at the persisted last write, and sessions
   * whose turn ended non-clean (error, cancel, …) are kept — their diagnostic
   * transcripts are retained until the user archives or deletes them. */
  const sweepCompletedSubSessions = async (): Promise<void> => {
    if (stopAc.signal.aborted || completionTtlMs <= 0) return;
    await discoverPersistedSubSessions();
    if (stopAc.signal.aborted) return;
    const now = Date.now();
    const candidates = [
      ...completedAt.keys(),
      ...[...spawnedSessionIds].filter((id) => !completedAt.has(id)),
    ];
    for (const sessionId of candidates) {
      if (stopAc.signal.aborted) return;
      const bridge = getBridge();
      if (!bridge) return;
      let due = completedAt.get(sessionId);
      let summary: BridgeSessionSummary | undefined;
      try {
        summary = bridge.getSessionSummary(sessionId);
      } catch (error) {
        if (!(error instanceof SessionNotFoundError)) {
          log.debug('sub-session: TTL summary failed', sessionId, error);
          continue;
        }
      }
      if (summary !== undefined) {
        if (!isWorkFree(summary)) continue; // running — never remove
        // The launcher holds the first registration; a second client
        // (a reader attached from the roster) keeps the session live
        // until it detaches — the removal path checks the same baseline.
        if ((summary.clientCount ?? 0) > 1) continue;
        const lastActivity = Date.parse(summary.updatedAt ?? summary.createdAt);
        if (due !== undefined && Number.isFinite(lastActivity)) {
          if (lastActivity > due) {
            due = lastActivity;
            completedAt.set(sessionId, due);
          }
        }
        if (due === undefined) continue;
      } else {
        if (due === undefined) {
          if (nonCleanTerminal.has(sessionId)) continue;
          // No live entry and no recorded completion: either the idle
          // reaper closed a work-free session or discovery re-armed a
          // persisted transcript. The blind arm starts a clock its own
          // observer never saw, so it arms only what the disk proves
          // clean — an error, cancelled, or never-settled tail stays
          // with the user, and the removal-time check re-judges the same
          // predicate before any mutation.
          if ((await persistedRemovalOutcome(sessionId)) === 'keep') {
            nonCleanTerminal.add(sessionId);
            continue;
          }
          // Start the clock at the persisted last write (falling back to
          // now for a missing transcript) — the TTL bounds the extra
          // lifetime of turns whose completion the observer missed.
          due = (await persistedRemovalState(sessionId)).lastActivity ?? now;
          completedAt.set(sessionId, due);
        }
      }
      if (now - due < completionTtlMs) continue;
      await removeExpiredSubSession(sessionId, due);
    }
  };

  const rollbackChildSession = async (
    bridge: AcpSessionBridge,
    sessionId: string,
    opts: { removeUnusedTranscript: boolean; named: boolean },
  ): Promise<void> => {
    const isMissing = (error: unknown) =>
      error instanceof SessionNotFoundError &&
      error.code === 'session_not_found';
    const childIsClosed = () => {
      try {
        bridge.getSessionSummary(sessionId);
        return false;
      } catch (error) {
        return isMissing(error);
      }
    };
    let sessionClosed = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The launcher itself has one registration. Keep an attached child's
      // session open for any other client that joined through the catalog.
      if (opts.named && bridge.getSessionSummary(sessionId).clientCount > 1)
        return;
      await Promise.race([
        bridge.closeSession(sessionId, undefined, {
          reason: 'sub_session_rollback',
          ...(opts.named
            ? { closeIfUnheld: true }
            : { agentCloseTimeoutMs: ACTIVE_WORK_CLOSE_TIMEOUT_MS }),
        }),
        new Promise<never>((_, reject) => {
          closeTimer = setTimeout(
            () =>
              reject(
                new Error(
                  `Timed out closing rolled-back sub-session ${sessionId}`,
                ),
              ),
            ACTIVE_WORK_CLOSE_TIMEOUT_MS + ROLLBACK_CLOSE_WATCHDOG_SLACK_MS,
          );
          closeTimer.unref();
        }),
      ]);
      sessionClosed = !opts.named;
    } catch (error) {
      sessionClosed = isMissing(error);
      log.debug('sub-session: closeSession threw', sessionId, error);
    } finally {
      clearTimeout(closeTimer);
    }
    if (!sessionClosed && !opts.named) {
      try {
        await bridge.killSession(sessionId, {
          requireZeroAttaches: true,
        });
      } catch (error) {
        log.debug('sub-session: killSession threw', sessionId, error);
      }
    }
    if (!sessionClosed && opts.removeUnusedTranscript) {
      sessionClosed = childIsClosed();
    }
    if (sessionClosed && opts.removeUnusedTranscript) {
      try {
        const removeTranscript = async () => {
          const service = new SessionService(boundWorkspace);
          if (!opts.named) return service.removeSession(sessionId);
          const coordinator = getArchiveCoordinator?.();
          if (!coordinator) return false;
          const canRemove = () =>
            isTrusted?.(bridge) === true &&
            !bridge.hasSessionOrPendingRegistration(sessionId);
          return coordinator.runExclusiveMany([sessionId], async () => {
            if (!canRemove()) return false;
            return service.removeUnusedSubSession(sessionId, () => {
              if (!canRemove()) {
                throw new Error(
                  'The sub-session or its runtime changed during rollback.',
                );
              }
            });
          });
        };
        const transcriptRemoved = runtimeBaseDir
          ? await Storage.runWithResolvedRuntimeBaseDir(
              runtimeBaseDir,
              removeTranscript,
            )
          : await removeTranscript();
        if (transcriptRemoved) bridge.markSessionCatalogChanged();
      } catch (error) {
        log.debug('sub-session: transcript cleanup failed', sessionId, error);
      }
    }
  };

  /**
   * Restore an existing session in this workspace, so a follow-up prompt can
   * be queued on it. Any session but the caller itself can be named; its
   * metadata comes from the live entry or, for one that was reaped, from its
   * transcript, and the session keeps its own lineage.
   */
  const resumeExistingSession = async (
    bridge: AcpSessionBridge,
    sessionId: string,
    callerSessionId: string,
    byPerson: boolean,
  ): Promise<{
    session: BridgeSession;
    assertWorktreeReady(sessionId: string): void;
  }> => {
    if (sessionId === normalizeSessionIdForLookup(callerSessionId)) {
      throw new Error('A session cannot send a message to itself.');
    }
    const service = new SessionService(boundWorkspace, { runtimeBaseDir });
    const storedId = await resolveSessionIdForRestore(service, sessionId);
    let metadata:
      | { parentSessionId?: string; sourceType?: string; sourceId?: string }
      | undefined;
    let isLive = false;
    try {
      const live = bridge.getSessionSummary(sessionId);
      isLive = true;
      metadata = {
        ...(live.parentSessionId !== undefined
          ? { parentSessionId: live.parentSessionId }
          : {}),
        ...(live.sourceType !== undefined
          ? { sourceType: live.sourceType }
          : {}),
        ...(live.sourceId !== undefined ? { sourceId: live.sourceId } : {}),
      };
    } catch (error) {
      if (!(error instanceof SessionNotFoundError)) throw error;
      if (storedId !== undefined) {
        metadata = await service.readCreationMetadataIfReadable(
          storedId,
          'active',
        );
      }
    }
    if (!metadata) {
      if (completionTtlMs > 0) {
        // No live entry and no persisted row to resolve: the session was
        // removed. A generic "No active session" refusal sends the creator
        // (who IS the parent) hunting for "another workspace", so name the
        // setting that removes completed sub-sessions instead.
        throw new Error(
          `Session ${sessionId} is no longer available in ${boundWorkspace}. ` +
            `If it was a sub-session you created, it was removed after a clean ` +
            `completion — see \`serve.subSessionCompletionTtlHours\`: a ` +
            `completed sub-session is removed once it stays clean-completed ` +
            `for that long.`,
        );
      }
      throw new Error(
        `No active session ${sessionId} in ${boundWorkspace}.` +
          (byPerson
            ? ''
            : ' If it lives in another workspace, also pass that `workspace`.'),
      );
    }
    // A preceding turn can create or replace the sidecar without updating
    // the bridge. Recheck its identity at the guarded write.
    const sidecarVersion = (sidecarPath: string) => {
      const stat = lstatSync(sidecarPath, {
        bigint: true,
        throwIfNoEntry: false,
      });
      return stat && `${stat.dev}:${stat.ino}:${stat.ctimeNs}`;
    };
    const sidecars = [...new Set([sessionId, storedId ?? sessionId])].map(
      (id) => {
        const path = service.getWorktreeSessionPath(id);
        return { path, version: sidecarVersion(path) };
      },
    );
    const worktrees = await Promise.all(
      sidecars.map(({ path }) => readWorktreeSessionStrict(path)),
    );
    const sidecarsUnchanged = () =>
      sidecars.every(({ path, version }) => sidecarVersion(path) === version);
    if (
      !sidecarsUnchanged() ||
      worktrees.some(
        ({ state }) => state === 'invalid' || (!isLive && state === 'valid'),
      )
    ) {
      throw new Error(
        'Open the destination worktree session before sending a follow-up.',
      );
    }
    const persistedPaths = worktrees.flatMap((result) =>
      result.state === 'valid' ? [result.session.worktreePath] : [],
    );
    let checkedRoot: string | undefined;
    const assertWorktreeReady = (targetId: string) => {
      if (!sidecarsUnchanged()) {
        throw new Error(
          'The destination worktree changed. Retry the follow-up.',
        );
      }
      const { effectiveCwd, worktree } =
        bridge.getSessionExecutionSnapshot(targetId);
      const worktreePath = worktree?.path ?? persistedPaths[0] ?? checkedRoot;
      if (!worktreePath) return;
      let ready = false;
      try {
        const root = realpathSync.native(worktreePath);
        ready =
          (checkedRoot === undefined || checkedRoot === root) &&
          persistedPaths.every((path) => root === realpathSync.native(path)) &&
          isWithinRoot(realpathSync.native(effectiveCwd), root);
        if (ready) checkedRoot = root;
      } catch {
        // A path that cannot be resolved is not ready.
      }
      if (!ready) {
        throw new Error(
          'The destination session has not restored its worktree directory. Open the destination session and retry the follow-up.',
        );
      }
    };
    // Recheck live targets after reading storage. If one closed in the
    // meantime, do not let the bridge fall back to restoring it cold.
    if (isLive) assertWorktreeReady(sessionId);
    const session = await bridge.resumeSession({
      sessionId,
      workspaceCwd: boundWorkspace,
      ...metadata,
    });
    return { session, assertWorktreeReady };
  };

  const run = async (
    info: CreateSubSessionInfo,
    remote?: RemoteSubSessionCaller,
    assertLocalCurrent?: () => void,
    /** A person sent this from the caller's page (local launches). */
    byPersonLocal = false,
    localReport?: OutgoingReport,
  ): Promise<CreateSubSessionResult> => {
    // The caller's tool never saw a person's launch, so the daemon reports
    // its completion even for a new session in this workspace.
    const byPerson = byPersonLocal || remote?.byPerson === true;
    if (stopAc.signal.aborted) {
      throw new Error(
        'The daemon is shutting down; cannot create a sub-session.',
      );
    }
    const bridge = getBridge();
    if (!bridge) {
      throw new Error('Session bridge is not available.');
    }

    // `callerSessionId` is required and authenticated at the bridge
    // (`ownsSession`), so it can neither be forged nor omitted to sidestep the
    // depth gate (`assertMayDelegate`) or the per-caller cap below.
    let standalone = false;
    let standaloneService: StandaloneSubSessionService | undefined;
    if (remote) {
      // The caller lives in another workspace, and its launcher ran the
      // caller-side checks. Daemon-owned directories mean nothing there.
      if (isolatedWorkspace || getStandaloneSessionService) {
        throw new Error(
          'This workspace cannot run sub-sessions for another workspace.',
        );
      }
      remote.assertCurrent();
    } else {
      const caller = bridge.getSessionSummary(info.callerSessionId);
      standalone = isReservedStandaloneSessionSourceType(caller.sourceType);
      standaloneService = standalone
        ? getStandaloneSessionService?.()
        : undefined;
      if (standalone && !standaloneService) {
        throw new Error('Standalone session service is unavailable.');
      }
      // The depth gate stops a model delegating without end; a person's send
      // does not recurse.
      if (!byPerson) {
        assertMayDelegate(info.callerSessionId, caller.parentSessionId);
      }
      if (info.sessionId !== undefined && (standalone || isolatedWorkspace)) {
        throw new Error('This session cannot follow up a sub-session.');
      }
    }
    const followUpSessionId =
      info.sessionId === undefined
        ? undefined
        : normalizeSessionIdForLookup(info.sessionId);
    const reusing = followUpSessionId !== undefined;
    if ((byPerson || reusing) && bridge.permissionPolicy === 'consensus') {
      // The target starts before the side panel is attached, too late to
      // join the approval's fixed voter set. A follow-up also registers a
      // daemon-only client that can raise the quorum without casting a vote.
      throw new Error(
        byPerson
          ? 'This workspace uses consensus approvals and does not support /send. Open or start the destination session and send the message there.'
          : 'This workspace uses consensus approvals and does not support tool follow-ups. Open the destination session and send the message there.',
      );
    }
    const report =
      info.completion === 'sent' &&
      (notifySentCompletion || remote || reusing || byPerson)
        ? (remote?.report ?? localReport)
        : undefined;
    const localToolFollowUp = reusing && !byPerson && !remote;
    const reportsLocalCompletion =
      (reusing || byPerson) && !remote && info.completion === 'sent';
    const localCallerApproval =
      localToolFollowUp || reportsLocalCompletion
        ? await readApprovalMode(bridge, info.callerSessionId)
        : undefined;
    if (
      reportsLocalCompletion &&
      !localCallerApproval?.canAcceptBackgroundNotifications
    ) {
      // The completion comes back as a background turn, which the caller
      // can only take while it records its chat.
      throw new Error(
        'A sub-session that reports back needs chat recording in the ' +
          'caller. Use first-turn to wait for the result.',
      );
    }

    // Per-caller concurrency key. Always a real, bridge-authenticated session
    // id: an anonymous fallback (a per-launch UUID) would give every call its
    // own bucket, which is the same as having no cap at all.
    const key = info.callerSessionId;
    const current = inflight.get(key) ?? 0;
    if (current >= maxConcurrentPerCaller) {
      throw new Error(
        `Too many concurrent sub-sessions for this session ` +
          `(cap ${maxConcurrentPerCaller}); wait for one to finish.`,
      );
    }
    // Forge-proof backstop: the per-caller cap above trusts `callerSessionId`,
    // this one does not. See MAX_CONCURRENT_SUB_SESSIONS_TOTAL.
    if (inflightTotal >= maxConcurrentTotal) {
      throw new Error(
        `Too many concurrent sub-sessions in this workspace ` +
          `(cap ${maxConcurrentTotal}); wait for one to finish.`,
      );
    }
    const releaseOutgoing = report?.reserve();
    inflight.set(key, current + 1);
    inflightTotal += 1;
    // Per-acquire idempotent release: prevents double-free when an error
    // propagates through both the inner finally (first-turn path) and the
    // outer catch. Without this, each failure loosens the cap by one slot;
    // repeated failures drive the counter below the real in-flight count
    // and over-admit concurrent sub-sessions past the documented cap.
    let released = false;
    const releaseOnce = (): void => {
      if (released) return;
      released = true;
      release(key);
      releaseOutgoing?.();
    };
    // Set after a successful spawnOrAttach; if a later step fails the launch
    // we roll this session back so it isn't orphaned (the slot was consumed and
    // the prompt may have been dispatched, but launch() reports failure).
    let spawnedSession: BridgeSession | undefined;
    // A follow-up attaches a client to the session it resumes; it is released
    // once this launch is done with the session, so follow-ups do not pile up
    // attachments. Releasing the last one closes the session only once it has
    // nothing left to run, as any client's goodbye would.
    let reusedClient: { sessionId: string; clientId: string } | undefined;
    const releaseReusedClient = (): void => {
      const client = reusedClient;
      reusedClient = undefined;
      if (client === undefined) return;
      void bridge
        .detachClient(client.sessionId, client.clientId)
        .catch((error: unknown) => {
          log.debug(
            'sub-session: follow-up detach failed',
            client.sessionId,
            error,
          );
        });
    };
    let promptAdmitted = false;
    let promptDispatched = false;
    let promptWriteStarted = false;
    let queuedTurn: ReturnType<AcpSessionBridge['sendPrompt']> | undefined;
    let onPromptDispatched: (() => void) | undefined;
    const named = remote !== undefined || assertLocalCurrent !== undefined;
    const guardedSent = info.completion === 'sent' && named;
    const followUpDispatchAbort =
      reusing && info.completion === 'sent' ? new AbortController() : undefined;
    // A new session dispatches at once, so a guarded `sent` launch waits for
    // that. A follow-up may sit behind a running turn for as long as that
    // turn takes; it returns once queued, and a prompt the guards refuse when
    // its turn comes is reported as a failed completion.
    const dispatch =
      guardedSent && !reusing
        ? new Promise<void>((resolve) => {
            onPromptDispatched = () => {
              promptDispatched = true;
              resolve();
            };
          })
        : undefined;
    const dispatchAbort = dispatch ? new AbortController() : undefined;
    const dispatchSignal = dispatchAbort
      ? AbortSignal.any([stopAc.signal, dispatchAbort.signal])
      : undefined;

    const promptId = randomUUID();
    let lastEventId!: number;
    let pendingPermissionIds: readonly string[] | undefined;
    let turn!: ReturnType<AcpSessionBridge['sendPrompt']>;
    let promptAdmission: Promise<void> | undefined;
    const prepareAndQueue = async (): Promise<BridgeSession> => {
      let sub: BridgeSession;
      let assertWorktreeReady: (() => void) | undefined;
      if (followUpSessionId !== undefined) {
        const resumed = await resumeExistingSession(
          bridge,
          followUpSessionId,
          info.callerSessionId,
          byPerson,
        );
        sub = resumed.session;
        assertWorktreeReady = () => resumed.assertWorktreeReady(sub.sessionId);
        // The bridge keys the session by the id it resumed, which can differ
        // in spelling from the one the caller passed.
        if (sub.clientId !== undefined) {
          reusedClient = { sessionId: sub.sessionId, clientId: sub.clientId };
        }
      } else if (standalone) {
        const created = await standaloneService!.createChildWithInitialPrompt(
          {
            sessionId: randomUUID(),
            parentSessionId: info.callerSessionId,
            promptId,
            ...(info.sourceType ? { sourceType: info.sourceType } : {}),
            ...(info.sourceId ? { sourceId: info.sourceId } : {}),
            ...(info.model ? { modelServiceId: info.model } : {}),
          },
          info.prompt,
        );
        sub = created.session;
        lastEventId = created.initialPrompt.lastEventId;
        turn = created.initialPrompt.turn;
      } else {
        sub = await bridge.spawnOrAttach({
          workspaceCwd: boundWorkspace,
          sessionScope: 'thread', // force a fresh top-level session, never attach
          // Record the caller as the sub-session's parent so the UI can link it
          // back. Persisted into the sub-session's transcript at spawn time.
          parentSessionId: info.callerSessionId,
          ...(info.sourceType ? { sourceType: info.sourceType } : {}),
          ...(info.sourceId ? { sourceId: info.sourceId } : {}),
          ...(info.model ? { modelServiceId: info.model } : {}),
        });
      }
      // A reused session is never rolled back: it is not this launch's to close.
      if (!reusing) spawnedSession = sub;
      const sessionId = sub.sessionId;
      // Fail closed only for scheduled-task runs; every other caller keeps
      // the bridge's best-effort contract (warn and stay on the agent's
      // default model rather than tearing down the spawned session).
      if (
        !standalone &&
        isScheduledTaskRunSource(info) &&
        info.model &&
        sub.modelApplied === false
      ) {
        throw new Error(`sub-session model selection failed: ${info.model}`);
      }
      if (isolatedWorkspace && !standalone) {
        const isolatedCwd =
          await isolatedWorkspace.materializeDirectory(sessionId);
        const changed = await bridge.changeSessionCwd(sessionId, {
          path: isolatedCwd,
          allowedRoots: [boundWorkspace],
          managedRelocation: 'live-conversation',
        });
        if (changed.newCwd !== isolatedCwd) {
          throw new Error(
            'Sub-session workspace directory relocation was rejected.',
          );
        }
      }
      if (!reusing) rememberSpawned(sessionId);
      let dispatchApproval:
        | {
            assertCanDispatch(): void;
            expectedApprovalMode: ApprovalMode;
            approvalModeBeforeStart?: ApprovalMode;
          }
        | undefined;
      if (remote || localToolFollowUp) {
        let childApproval = await readApprovalMode(bridge, sessionId);
        const originalMode = childApproval.mode;
        if (originalMode === undefined) {
          throw new Error(
            'The sub-session did not report its approval mode; it was not used.',
          );
        }
        const callerMode = remote?.approvalMode ?? localCallerApproval?.mode;
        if (callerMode === undefined) {
          throw new Error(
            'The calling session did not report its approval mode.',
          );
        }
        remote?.assertCurrent();
        const mode = byPerson
          ? originalMode
          : delegatedApprovalMode(callerMode, originalMode);
        if (localToolFollowUp && mode !== originalMode) {
          throw new Error(
            `Follow-up requires a compatible approval mode. The target is in "${originalMode}", but the delegated mode is "${mode}".`,
          );
        }
        if (!reusing && mode !== originalMode) {
          const change = await bridge.setSessionApprovalMode(sessionId, mode, {
            persist: false,
          });
          if (change.mode !== mode) {
            throw new Error('The sub-session did not apply its approval mode.');
          }
          childApproval = await readApprovalMode(bridge, sessionId);
          if (childApproval.mode !== mode) {
            throw new Error(
              'The sub-session approval mode changed before dispatch.',
            );
          }
        }
        dispatchApproval = {
          assertCanDispatch() {
            assertLocalCurrent?.();
            remote?.assertCurrent();
            localCallerApproval?.assertCurrent();
            childApproval.assertCurrent();
          },
          expectedApprovalMode: mode,
          ...(reusing && mode !== originalMode
            ? { approvalModeBeforeStart: originalMode }
            : {}),
        };
        dispatchApproval.assertCanDispatch();
      }

      if (!reusing) {
        try {
          bridge.updateSessionMetadata(sessionId, {
            displayName: subSessionName(info.name ?? info.prompt),
            titleSource: 'auto',
          });
        } catch (err) {
          log.debug(
            'sub-session: updateSessionMetadata failed',
            sessionId,
            err,
          );
        }
      }

      if (!standalone) {
        assertLocalCurrent?.();
        assertWorktreeReady?.();
        if (remote && stopAc.signal.aborted) {
          throw new Error('The target workspace stopped before dispatch.');
        }
        lastEventId = bridge.getSessionLastEventId(sessionId);
        if (report) {
          pendingPermissionIds =
            bridge.getSessionPendingPermissionIds(sessionId);
        }
        let markPromptAdmitted!: () => void;
        promptAdmission = new Promise<void>((resolve) => {
          markPromptAdmitted = resolve;
        });
        const onPromptAdmitted = () => {
          promptAdmitted = true;
          markPromptAdmitted();
        };
        // A scheduled run's caller is not who sent it.
        const source = isScheduledTaskRunSource(info)
          ? undefined
          : remote
            ? remote.source
            : promptSource(bridge, info.callerSessionId, boundWorkspace);
        const assertApprovalCurrent =
          dispatchApproval?.assertCanDispatch ?? assertLocalCurrent;
        turn = bridge.sendPrompt(
          sessionId,
          {
            sessionId,
            prompt: [{ type: 'text', text: info.prompt }],
            // Names the sending session above the message in the target's
            // transcript.
            ...(source
              ? { _meta: { [DAEMON_INPUT_ANNOTATIONS_META_KEY]: [source] } }
              : {}),
          } as Parameters<AcpSessionBridge['sendPrompt']>[1],
          dispatchSignal ?? (remote || guardedSent ? stopAc.signal : undefined),
          {
            promptId,
            onPromptAdmitted,
            onPromptDispatched,
            dispatchSignal: followUpDispatchAbort?.signal ?? dispatchSignal,
            ...(named || followUpDispatchAbort
              ? {
                  onPromptWriteStarted: () => {
                    promptWriteStarted = true;
                  },
                }
              : {}),
            ...dispatchApproval,
            assertCanDispatch: assertWorktreeReady
              ? () => {
                  assertApprovalCurrent?.();
                  assertWorktreeReady();
                }
              : assertApprovalCurrent,
          },
        );
        queuedTurn = turn;
      }
      return sub;
    };

    try {
      let sub: BridgeSession;
      if (followUpSessionId === undefined) {
        sub = await prepareAndQueue();
      } else {
        const coordinator = getArchiveCoordinator?.();
        if (!coordinator) {
          throw new Error('Session archive coordinator is unavailable.');
        }
        sub = await coordinator.runSharedMany(
          [followUpSessionId],
          prepareAndQueue,
        );
      }
      const sessionId = sub.sessionId;

      // The result comes from the event stream (turn_error surfaces failures);
      // swallow the promise so it can't raise an unhandled rejection, but log
      // the error so dispatch failures are not invisible.
      void turn.catch((err) => {
        log.debug('sub-session: sendPrompt rejected', sessionId, String(err));
      });

      if (dispatch && dispatchAbort) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error(
              promptWriteStarted
                ? `Sub-session prompt dispatch timed out. Session ${sessionId} may have received the prompt.`
                : 'Sub-session prompt dispatch timed out.',
            );
            reject(error);
            dispatchAbort.abort(error);
          }, sentModeDispatchTimeoutMs);
          timer.unref();
        });
        try {
          await Promise.race([dispatch, turn, deadline]);
          if (!promptDispatched) {
            throw new Error('The sub-session prompt was not dispatched.');
          }
        } finally {
          clearTimeout(timer);
        }
      }

      if (isScheduledTaskRunSource(info) && promptAdmission) {
        await Promise.race([
          promptAdmission,
          turn.then(
            () => undefined,
            (err) =>
              Promise.reject(
                new Error(
                  `sub-session dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
                ),
              ),
          ),
        ]);
      }

      if (info.groupId) {
        try {
          const assign = () =>
            createSessionOrganizationService(
              boundWorkspace,
            ).updateSessionOrganization(sessionId, {
              groupId: info.groupId,
              color: null,
            });
          if (runtimeBaseDir) {
            await Storage.runWithResolvedRuntimeBaseDir(runtimeBaseDir, assign);
          } else {
            await assign();
          }
          bridge.markSessionCatalogChanged();
        } catch (error) {
          writeStderrLine(
            `qwen serve: scheduled-task session ${sessionId} could not be assigned to group ${info.groupId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // One session can report several completions to the same caller, and
      // the caller treats a repeated task id as one it already has.
      const completionTaskId = reusing ? `${sessionId}:${promptId}` : sessionId;

      if (info.completion === 'sent') {
        let settledStatus: Exclude<OutgoingSubSessionStatus, 'running'> =
          'cancelled';
        // A person sending to an existing session knows it by its title.
        const label =
          (byPerson && reusing ? sessionTitle(bridge, sessionId) : undefined) ??
          subSessionName(info.name ?? info.prompt);
        // A person's message goes into the caller's conversation as a record;
        // the reply comes back as a turn in which the caller's model tells the
        // person what the target said, named by where it came from.
        const notify = notifySentCompletion || remote || reusing || byPerson;
        const notificationLabel = byPerson
          ? `${basename(boundWorkspace)} · ${label}`
          : label;
        const linkWorkspace = remote || byPerson ? boundWorkspace : undefined;
        const personMessage = byPerson ? info.prompt : undefined;
        const fromSession = { sessionId, workspaceCwd: boundWorkspace };
        const task = { id: completionTaskId, ...fromSession, label, byPerson };
        const sentRecord = byPerson
          ? sentMessageRecord(task, info.prompt)
          : undefined;
        report?.started(task, sentRecord);
        // Hold the concurrency slot until the sub-session's turn finishes
        // (or the daemon shuts down via stop(), or a wall-clock ceiling is
        // reached). Without this the cap is a no-op for sent mode — the
        // fire-and-forget path returns immediately and the slot releases
        // before the sub-session has done any work, letting a looping
        // isolated task exhaust the daemon's session pool.
        const drainAc = new AbortController();
        const drainSignal = AbortSignal.any([
          stopAc.signal,
          drainAc.signal,
          ...(remote && report ? [report.signal] : []),
        ]);
        const targetStopped = () =>
          remote !== undefined && stopAc.signal.reason === 'workspace_stopped';
        void (async () => {
          try {
            let notification:
              | ReturnType<typeof buildSentCompletionNotification>
              | undefined;
            try {
              const turnError: Promise<never> = turn.then(
                () => new Promise<never>(() => {}),
                (err) =>
                  Promise.reject(
                    new Error(
                      `sub-session dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
                    ),
                  ),
              );
              const completion = await Promise.race([
                awaitFirstTurn(
                  bridge,
                  sessionId,
                  promptId,
                  lastEventId,
                  sentModeDrainTimeoutMs,
                  drainSignal,
                  {
                    requirePromptId: reusing,
                    ...(report
                      ? {
                          onWaitingChange: (waiting) => report.waiting(waiting),
                          pendingPermissionIds,
                        }
                      : {}),
                    onTimeout() {
                      // Once the ACP write starts, the prompt may reach the
                      // child. Keep FIFO ownership until its RPC settles.
                      if (!promptWriteStarted) {
                        followUpDispatchAbort?.abort(
                          new DOMException(
                            'Sub-session follow-up dispatch timed out.',
                            'TimeoutError',
                          ),
                        );
                      }
                    },
                  },
                ),
                turnError,
              ]);
              if (
                (stopAc.signal.aborted && !targetStopped()) ||
                (remote && report?.signal.aborted)
              )
                return;
              if (completion.stopReason === 'timeout') {
                writeStderrLine(
                  `qwen serve: sub-session ${sessionId} drain timed out after ` +
                    `${Math.round(sentModeDrainTimeoutMs / 60_000)}min; releasing its ` +
                    `concurrency slot (the sub-session may still be running)`,
                );
              }
              settledStatus = sentCompletionStatus(completion.stopReason);
              recordTurnOutcome(sessionId, completion.stopReason);
              if (notify) {
                notification = buildSentCompletionNotification(
                  sessionId,
                  notificationLabel,
                  completion.result,
                  completion.stopReason,
                  linkWorkspace,
                  completionTaskId,
                  personMessage,
                  fromSession,
                  sentRecord?.modelText,
                );
              }
            } catch (err) {
              // The turn's promise rejected (dispatch failure) or the event
              // stream threw — the turn is over and failed; its diagnostic
              // transcript is kept (never a removal candidate). The record
              // happens before the early returns: the daemon and its sweep
              // can outlive a disconnected report signal, and an unrecorded
              // failure would fall into the sweep's unobserved-completion
              // fallback and become a removal candidate. With the feature
              // off no sweeper exists, so nothing may be recorded.
              if (completionTtlMs > 0) nonCleanTerminal.add(sessionId);
              settledStatus = targetStopped() ? 'cancelled' : 'failed';
              if (
                (stopAc.signal.aborted && !targetStopped()) ||
                (remote && report?.signal.aborted)
              )
                return;
              if (!notify) return;
              const message = err instanceof Error ? err.message : String(err);
              notification = buildSentCompletionNotification(
                sessionId,
                notificationLabel,
                message,
                targetStopped() ? 'shutdown' : 'error',
                linkWorkspace,
                completionTaskId,
                personMessage,
                fromSession,
                sentRecord?.modelText,
              );
            } finally {
              report?.settled(settledStatus);
              if (remote) {
                drainAc.abort();
                releaseOnce();
              }
              releaseReusedClient();
            }
            if (!notification) return;
            try {
              if (remote) {
                await remote.deliverCompletion(notification);
              } else {
                await deliverSentCompletion(
                  bridge,
                  boundWorkspace,
                  info.callerSessionId,
                  notification,
                  stopAc.signal,
                  isolatedWorkspace,
                  standaloneService,
                );
              }
            } catch (notificationError) {
              if (!stopAc.signal.aborted) {
                writeStderrLine(
                  `qwen serve: sub-session ${sessionId} completion could not be returned to parent ${info.callerSessionId}: ${notificationError instanceof Error ? notificationError.message : String(notificationError)}`,
                );
              }
            }
          } finally {
            drainAc.abort();
            // Use releaseOnce (not raw release) — if spawn succeeded but the
            // outer catch also fires release, using raw release would double-
            // free the slot.
            releaseOnce();
            remote?.releaseCompletionSlot?.();
          }
        })();
        return {
          sessionId,
          ...(remote ? { workspaceCwd: boundWorkspace } : {}),
          ...(reusing ? { taskId: completionTaskId } : {}),
          ...(sub.parentSessionPersisted !== undefined
            ? { parentSessionPersisted: sub.parentSessionPersisted }
            : {}),
        };
      }

      // first-turn: hold the slot synchronously until the turn completes.
      // stopAc.signal is composed inside awaitFirstTurn so stop() aborts
      // the subscription (stopReason: 'shutdown'). Also race against the
      // sendPrompt promise — if it rejects (API 429, network timeout, auth
      // failure), turn_complete/turn_error never fire and the caller would
      // otherwise wait the full timeout.
      try {
        const turnError: Promise<never> = turn.then(
          () => new Promise<never>(() => {}), // never resolves on success
          (err) =>
            Promise.reject(
              new Error(
                `sub-session dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
              ),
            ),
        );
        const firstTurn = awaitFirstTurn(
          bridge,
          sessionId,
          promptId,
          lastEventId,
          firstTurnTimeoutMs,
          stopAc.signal,
          { requirePromptId: reusing },
        );
        const { result, stopReason } = await Promise.race([
          firstTurn,
          turnError,
        ]);
        recordTurnOutcome(sessionId, stopReason);
        return {
          sessionId,
          ...(remote ? { workspaceCwd: boundWorkspace } : {}),
          result,
          stopReason,
          ...(sub.parentSessionPersisted !== undefined
            ? { parentSessionPersisted: sub.parentSessionPersisted }
            : {}),
        };
      } finally {
        releaseOnce();
        releaseReusedClient();
      }
    } catch (err) {
      // Spawn/admission/dispatch failure — surface it as the tool's error.
      releaseOnce();
      remote?.releaseCompletionSlot?.();
      releaseReusedClient();
      // If the spawn succeeded but a later step failed (e.g. sendPrompt threw
      // synchronously), roll back the orphaned session so it doesn't leak a slot
      // in the bridge's session pool while this launch reports failure.
      if (spawnedSession !== undefined && isolatedWorkspace && !standalone) {
        const sessionId = spawnedSession.sessionId;
        let sessionClosed = false;
        try {
          if (spawnedSession.attached) {
            if (spawnedSession.clientId) {
              await bridge.detachClient(sessionId, spawnedSession.clientId);
            }
          } else {
            sessionClosed = await bridge.killSession(sessionId, {
              requireZeroAttaches: true,
            });
          }
        } catch (cleanupError) {
          log.debug(
            'sub-session: isolated session rollback failed',
            sessionId,
            cleanupError,
          );
        }
        if (sessionClosed) {
          if (!promptAdmitted) {
            try {
              const transcriptRemoved =
                await removeSubSessionTranscript(sessionId);
              if (transcriptRemoved) bridge.markSessionCatalogChanged();
            } catch (cleanupError) {
              log.debug(
                'sub-session: isolated transcript cleanup failed',
                sessionId,
                cleanupError,
              );
            }
          }
          try {
            await isolatedWorkspace.discardEmptyDirectory(sessionId);
          } catch (cleanupError) {
            log.debug(
              'sub-session: isolated workspace cleanup failed',
              sessionId,
              cleanupError,
            );
          }
        }
      } else if (spawnedSession !== undefined && !standalone) {
        const sessionId = spawnedSession.sessionId;
        const timedOut = dispatchAbort?.signal.aborted === true;
        const removeUnusedTranscript = named
          ? !promptWriteStarted && !promptDispatched
          : !promptAdmitted;
        const rollback = () =>
          rollbackChildSession(bridge, sessionId, {
            removeUnusedTranscript,
            named,
          });
        if (!timedOut && (!named || removeUnusedTranscript)) {
          await rollback();
        } else if (timedOut && removeUnusedTranscript && queuedTurn) {
          // Let the cancelled turn drop its queue slot before the idle close.
          void queuedTurn.then(rollback, rollback);
        }
      }
      writeStderrLine(
        `qwen serve: create_sub_session failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err instanceof Error ? err : new Error(String(err));
    }
  };

  // `unref` so the sweeper alone never keeps the daemon process alive;
  // stop() clears it. Overlapping sweeps are serialized: a removal can wait
  // out `agentCloseTimeoutMs`, and a second sweep on the same id would
  // double-close/double-remove.
  let completionTtlSweeper: ReturnType<typeof setInterval> | undefined;
  let completionTtlSweepInFlight = false;
  if (completionTtlMs > 0) {
    completionTtlSweeper = setInterval(() => {
      if (completionTtlSweepInFlight) return;
      completionTtlSweepInFlight = true;
      void sweepCompletedSubSessions().finally(() => {
        completionTtlSweepInFlight = false;
      });
    }, COMPLETION_TTL_SWEEP_INTERVAL_MS);
    if (typeof completionTtlSweeper.unref === 'function') {
      completionTtlSweeper.unref();
    }
  }

  /**
   * Depth-1 gate. Every daemon session wires a spawner, sub-sessions
   * included, and each gets its own bucket — so without this a sub-session
   * can spawn more, each of which spawns more (capⁿ), exhausting
   * `maxSessions` from one prompt. The in-memory set catches children this
   * launcher created; the persisted parent lineage catches the same child
   * after a daemon restart, and a child another workspace's launcher created.
   */
  const assertMayDelegate = (
    callerSessionId: string,
    callerParentSessionId: string | undefined,
  ): void => {
    if (
      spawnedSessionIds.has(callerSessionId) ||
      callerParentSessionId !== undefined
    ) {
      throw new Error(
        'A sub-session cannot create further sub-sessions (nesting is capped ' +
          'at one level).',
      );
    }
  };

  const getNamedTarget = (
    callerSessionId: string,
    workspace: string,
    byPerson = false,
  ) => {
    if (stopAc.signal.aborted) {
      throw new Error(
        'The daemon is shutting down; cannot create a sub-session.',
      );
    }
    const bridge = getBridge();
    if (!bridge) {
      throw new Error('Session bridge is not available.');
    }
    const caller = bridge.getSessionSummary(callerSessionId);
    if (
      isolatedWorkspace ||
      isReservedStandaloneSessionSourceType(caller.sourceType)
    ) {
      throw new Error(
        'This session cannot create sub-sessions in another workspace.',
      );
    }
    if (!byPerson) assertMayDelegate(callerSessionId, caller.parentSessionId);
    if (!resolveWorkspace) {
      throw new Error(
        'Sub-sessions in another workspace are not available here.',
      );
    }
    const assertCallerCurrent = () => {
      if (stopAc.signal.aborted || isTrusted?.(bridge) !== true) {
        throw new Error(
          'This workspace is not trusted or is no longer active, so its sessions ' +
            'cannot run sub-sessions in another workspace.',
        );
      }
    };
    assertCallerCurrent();
    const target = resolveWorkspace(workspace);
    if (target.kind === 'refused') throw new Error(target.reason);
    target.assertCurrent();
    return { bridge, target, assertCallerCurrent };
  };

  const resolveDestination: ResolveSubSessionWorkspaceHandler = (
    callerSessionId,
    workspace,
  ) => {
    const { target } = getNamedTarget(callerSessionId, workspace);
    return {
      workspaceId: target.workspaceId,
      workspaceCwd: target.workspaceCwd,
      workspaceGeneration: target.workspaceGeneration,
      sameWorkspace: target.launcher === launcher,
    };
  };

  // Reported `sent` launches per caller, for the caller's task list.
  const outgoing = new Map<string, OutgoingSubSessionTask[]>();
  const activeOutgoing = new Map<string, number>();
  const outgoingChanged = (callerSessionId: string) => {
    getBridge()?.publishWorkspaceEvent({
      type: 'sub_session_task_changed',
      data: { sessionId: callerSessionId },
    });
  };
  const outgoingReport = (callerSessionId: string): OutgoingReport => {
    const key = normalizeSessionIdForLookup(callerSessionId);
    let record: OutgoingSubSessionTask | undefined;
    return {
      signal: stopAc.signal,
      reserve() {
        const count = activeOutgoing.get(key) ?? 0;
        if (count >= MAX_OUTGOING_PER_CALLER) {
          throw new Error(
            `Too many outgoing sub-sessions for this session (cap ${MAX_OUTGOING_PER_CALLER}); wait for one to finish.`,
          );
        }
        activeOutgoing.set(key, count + 1);
        return () => {
          const active = activeOutgoing.get(key)!;
          if (active === 1) activeOutgoing.delete(key);
          else activeOutgoing.set(key, active - 1);
        };
      },
      started(task, sentRecord) {
        if (sentRecord !== undefined) {
          getBridge()
            ?.appendExternalRecord(callerSessionId, sentRecord)
            .catch((error: unknown) => {
              writeStderrLine(
                `qwen serve: could not record a /send message in session ${callerSessionId}: ${error instanceof Error ? error.message : String(error)}`,
              );
            });
        }
        record = {
          ...task,
          status: 'running',
          startTime: Date.now(),
          waitingForInput: false,
        };
        const list = [...(outgoing.get(key) ?? []), record];
        if (list.length > MAX_OUTGOING_PER_CALLER) {
          const settled = list.findIndex((entry) => entry.status !== 'running');
          if (settled !== -1) list.splice(settled, 1);
        }
        outgoing.set(key, list);
        outgoingChanged(callerSessionId);
      },
      waiting(waitingForInput) {
        if (!record || record.status !== 'running') return;
        if (record.waitingForInput === waitingForInput) return;
        record.waitingForInput = waitingForInput;
        outgoingChanged(callerSessionId);
      },
      settled(status) {
        if (!record || record.status !== 'running') return;
        record.status = status;
        record.endTime = Date.now();
        record.waitingForInput = false;
        outgoingChanged(callerSessionId);
      },
    };
  };
  const listOutgoing = (callerSessionId: string) =>
    (outgoing.get(normalizeSessionIdForLookup(callerSessionId)) ?? []).map(
      (task) => ({ ...task }),
    );

  const launchAs = async (
    info: CreateSubSessionInfo,
    byPerson: boolean,
  ): Promise<CreateSubSessionResult> => {
    const {
      workspace,
      workspaceGeneration,
      requiresYolo,
      requiresAutoMode,
      ...local
    } = info;
    const report = outgoingReport(info.callerSessionId);
    if (workspace === undefined)
      return run(local, undefined, undefined, byPerson, report);
    const { bridge, target, assertCallerCurrent } = getNamedTarget(
      info.callerSessionId,
      workspace,
      byPerson,
    );
    if (
      !workspaceGeneration ||
      target.workspaceGeneration !== workspaceGeneration
    ) {
      throw new Error('The workspace target changed. Request approval again.');
    }
    const isLocal = target.launcher === launcher;
    const callerApproval =
      !isLocal || requiresYolo || requiresAutoMode
        ? await readApprovalMode(bridge, info.callerSessionId)
        : undefined;
    if (requiresYolo && callerApproval?.mode !== ApprovalMode.YOLO) {
      throw new Error('A named workspace requires one-time approval.');
    }
    if (requiresAutoMode && callerApproval?.mode !== ApprovalMode.AUTO) {
      throw new Error('A named workspace requires one-time approval.');
    }
    const assertTargetCurrent = () => {
      assertCallerCurrent();
      target.assertCurrent();
      if (!byPerson) callerApproval?.assertCurrent();
    };
    if (isLocal) {
      return run(local, undefined, assertTargetCurrent, byPerson, report);
    }
    if (callerApproval?.mode === undefined) {
      throw new Error(
        'This session did not report its approval mode, so it cannot run ' +
          'sub-sessions in another workspace.',
      );
    }
    let releaseCompletionSlot: (() => void) | undefined;
    if (local.completion === 'sent') {
      if (!callerApproval.canAcceptBackgroundNotifications) {
        throw new Error(
          'Cross-workspace sent completion requires chat recording in the caller. Use first-turn to wait for the result.',
        );
      }
      if (outstandingRemoteCompletions >= maxConcurrentTotal) {
        throw new Error(
          `Too many pending cross-workspace completions in this workspace (cap ${maxConcurrentTotal}); wait for one to finish.`,
        );
      }
      outstandingRemoteCompletions += 1;
      releaseCompletionSlot = () => {
        if (!releaseCompletionSlot) return;
        releaseCompletionSlot = undefined;
        outstandingRemoteCompletions -= 1;
      };
    }
    try {
      return await target.launcher.launchForRemoteCaller(local, {
        approvalMode: callerApproval.mode,
        ...(byPerson ? { byPerson: true } : {}),
        assertCurrent: assertTargetCurrent,
        deliverCompletion: async (notification) => {
          assertCallerCurrent();
          await deliverSentCompletion(
            bridge,
            boundWorkspace,
            info.callerSessionId,
            notification,
            stopAc.signal,
          );
        },
        ...(releaseCompletionSlot ? { releaseCompletionSlot } : {}),
        report,
        source: promptSource(bridge, info.callerSessionId, boundWorkspace),
      });
    } catch (error) {
      releaseCompletionSlot?.();
      throw error;
    }
  };

  const launch = (info: CreateSubSessionInfo) => launchAs(info, false);

  const launchForPerson = async (
    request: PersonSubSessionRequest,
  ): Promise<CreateSubSessionResult> => {
    const { callerSessionId, prompt, workspace, sessionId } = request;
    // Resolved in the same request: the person picked this workspace.
    const workspaceGeneration =
      workspace === undefined
        ? undefined
        : getNamedTarget(callerSessionId, workspace, true).target
            .workspaceGeneration;
    return launchAs(
      {
        prompt,
        completion: 'sent',
        callerSessionId,
        ...(workspace !== undefined ? { workspace, workspaceGeneration } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
      },
      true,
    );
  };

  const launcher: SubSessionLauncher = {
    launch,
    launchForPerson,
    listOutgoing,
    resolveDestination,
    launchForRemoteCaller: (info, caller) => run(info, caller),
    stop: (reason) => {
      stopAc.abort(reason); // tears down every active subscription → releases slots
      if (completionTtlSweeper !== undefined) {
        clearInterval(completionTtlSweeper);
        completionTtlSweeper = undefined;
      }
    },
  };
  return launcher;
}
