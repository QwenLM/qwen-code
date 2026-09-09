import { randomUUID } from 'node:crypto';
import type {
  ChannelOutputSegmentContext,
  ChannelPermissionRequestContext,
  ChannelTaskCancellationReason,
  UserInputPresentationResult,
} from '@qwen-code/channel-base';
import {
  STATUS_CARD_TEMPLATE_ID,
  isRetryableDingtalkCardError,
  type DingtalkInteractiveCardClient,
} from './interactive-card-client.js';
import type { DingtalkCardCallbackResult } from './interactive-card-types.js';
import { escapeDingTalkMarkdown } from './markdown.js';
import { sanitizeStreamingImageMarkers } from './outbound-image.js';
import {
  isChinesePresentationLanguage,
  presentationPhaseLabel,
  type DingtalkPresentationPhase,
} from './presentation-phase.js';

const FLUSH_INTERVAL_MS = 500;
const STATUS_REFRESH_INTERVAL_MS = 1_000;
const CONTENT_SYNC_INTERVAL_SECONDS = 5;
const BREAKER_PROBE_INTERVAL_MS = 30_000;
const MAX_CONSECUTIVE_STATUS_FAILURES = 3;
const INITIAL_RETRY_INTERVAL_MS = 1_000;
const MAX_RETRY_INTERVAL_MS = 30_000;
const ACTION_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_ACTION_CARDS = 1000;
export const CONTENT_LIMIT = 20_000;
export const TRUNCATION_MARKER = '[Earlier output truncated]\n';

type StatusState = 'Running' | 'Completed' | 'Failed' | 'Stopped' | 'Cancelled';

type PermissionAction = 'allow_once' | 'allow_always' | 'reject_once';

interface PendingPermission {
  context: ChannelPermissionRequestContext;
  optionIds: Map<PermissionAction, string>;
  claimed: boolean;
  unsubscribe: () => void;
}

interface TerminalIntent {
  state: StatusState;
  content: string;
  isError: boolean;
  /** Computed once so terminal retries do not inflate the elapsed time. */
  statusLine: string;
  streamFinalizeSettled: boolean;
}

interface StatusRecord {
  context: ChannelOutputSegmentContext;
  quoteContent: string;
  segmentId: string;
  runId: string;
  sessionId: string;
  ownerId: string;
  target: { chatId: string; isGroup: boolean };
  outTrackId: string;
  content: string;
  sourcePrefix?: string;
  phase: DingtalkPresentationPhase;
  startedAt: number;
  lastStatusSecond: number;
  lastContentSyncSecond: number;
  ready: Promise<boolean>;
  /** Settles when the current creation attempt does, before any backoff. */
  creationAttempt: Promise<boolean>;
  terminal: boolean;
  streamFailed: boolean;
  streamFailureVersion: number;
  createRetryAttempt: number;
  streamRetryAttempt: number;
  terminalRetryAttempt: number;
  consecutiveStatusFailures: number;
  stopClaimed: boolean;
  forbiddenActors: Set<string>;
  lastWriteAt: number;
  contentVersion: number;
  hasPendingWrite: boolean;
  flushTimer?: ReturnType<typeof setTimeout>;
  createRetryTimer?: ReturnType<typeof setTimeout>;
  /** Resolves the pending creation backoff early so `ready` settles. */
  abandonCreation?: () => void;
  streamRetryTimer?: ReturnType<typeof setTimeout>;
  terminalRetryTimer?: ReturnType<typeof setTimeout>;
  statusTimer?: ReturnType<typeof setTimeout>;
  inFlight?: Promise<void>;
  writeChain: Promise<void>;
  terminalIntent?: TerminalIntent;
  permission?: PendingPermission;
  permissionControlsVisible?: boolean;
  permissionResultBlocks?: Array<Record<string, unknown>>;
}

export interface StatusCardControllerOptions {
  client: DingtalkInteractiveCardClient;
  cancelRun(sessionId: string, runId: string): Promise<boolean>;
  quoteContent?(segment: ChannelOutputSegmentContext): string;
  executeCommand?(
    context: ChannelOutputSegmentContext,
    command: '/new' | '/compress',
  ): Promise<void>;
  model?: string;
  language?: string;
  showModel?: boolean;
  showReasoningEffort?: boolean;
  sessionModelInfo?(
    segment: ChannelOutputSegmentContext,
  ): { model?: string; reasoningEffort?: string } | undefined;
  onError?(operation: string, error: unknown): void;
}

function boundContent(content: string): string {
  if (content.length <= CONTENT_LIMIT) return content;
  return `${TRUNCATION_MARKER}${content.slice(
    content.length - (CONTENT_LIMIT - TRUNCATION_MARKER.length),
  )}`;
}

function activeContent(
  phase: DingtalkPresentationPhase,
  content: string,
  language?: string,
  sourcePrefix?: string,
): string {
  const label = presentationPhaseLabel(phase, language);
  const sanitized = sanitizeStreamingImageMarkers(content);
  const renderedSourcePrefix =
    sourcePrefix &&
    (sanitized === sourcePrefix || sanitized.startsWith(`${sourcePrefix}\n\n`))
      ? sourcePrefix
      : undefined;
  const body = renderedSourcePrefix
    ? sanitized.slice(
        renderedSourcePrefix.length +
          (sanitized.length === renderedSourcePrefix.length ? 0 : 2),
      )
    : sanitized;
  const prefix = [label, renderedSourcePrefix].filter(Boolean).join('\n\n');
  if (!body) return prefix;

  const separator = '\n\n';
  const available = CONTENT_LIMIT - prefix.length - separator.length;
  if (body.length <= available) return `${prefix}${separator}${body}`;
  return `${prefix}${separator}${TRUNCATION_MARKER}${body.slice(
    body.length - (available - TRUNCATION_MARKER.length),
  )}`;
}

export class StatusCardController {
  private readonly recordsBySegment = new Map<string, StatusRecord>();
  private readonly recordsByOutTrack = new Map<string, StatusRecord>();
  private readonly segmentIdsByRun = new Map<string, Set<string>>();
  private readonly terminalSegmentIds = new Set<string>();
  private readonly actionCards = new Map<
    string,
    {
      context: ChannelOutputSegmentContext;
      expiresAt: number;
      claimedCommands: Set<string>;
      forbiddenActors: Set<string>;
    }
  >();
  private disposed = false;

  constructor(private readonly options: StatusCardControllerOptions) {}

  ensure(
    segment: ChannelOutputSegmentContext,
    target: { chatId: string; isGroup: boolean },
  ): void {
    if (this.disposed) return;
    if (this.terminalSegmentIds.has(segment.segmentId)) return;
    if (!this.recordsBySegment.has(segment.segmentId)) {
      this.createRecord(segment, target);
    }
  }

  replace(
    segment: ChannelOutputSegmentContext,
    target: { chatId: string; isGroup: boolean },
    content: string,
  ): void {
    if (this.disposed) return;
    if (this.terminalSegmentIds.has(segment.segmentId)) return;
    const record = this.recordsBySegment.get(segment.segmentId);
    if (!record) {
      this.createRecord(segment, target, content);
      return;
    }
    if (record.terminal) return;
    record.content = boundContent(content);
    record.contentVersion++;
    if (record.streamFailed) return;
    record.hasPendingWrite = true;
    this.scheduleFlush(record);
  }

  /**
   * Whether a created, still-running status card is displaying content for
   * this segment. Awaits the in-flight creation so a boundary decision made
   * while creation is pending does not race it. A latched stream failure
   * means the card can never show further content, so it is not live. A
   * creation that is backing off for a retry is not awaited either (see
   * `awaitDelivery`).
   */
  async isCardLive(segmentId: string): Promise<boolean> {
    if (this.disposed) return false;
    const record = this.recordsBySegment.get(segmentId);
    if (!record || record.terminal || record.streamFailed) return false;
    return this.awaitDelivery(record);
  }

  /**
   * Drain any pending snapshot so callers can treat the card's current
   * content as delivered. Returns false when there is no live record, the
   * card never became ready, or the stream failed during the drain, so the
   * caller can fall back instead of claiming delivery.
   */
  async flushPending(segmentId: string): Promise<boolean> {
    if (this.disposed) return false;
    const record = this.recordsBySegment.get(segmentId);
    if (!record || record.terminal) return false;
    if (!(await this.awaitDelivery(record))) return false;
    while (!record.terminal && !record.streamFailed) {
      if (record.flushTimer) {
        clearTimeout(record.flushTimer);
        record.flushTimer = undefined;
      }
      if (record.streamRetryTimer) {
        clearTimeout(record.streamRetryTimer);
        record.streamRetryTimer = undefined;
      }
      const failureVersion = record.streamFailureVersion;
      this.flush(record);
      await record.writeChain;
      if (record.streamFailureVersion !== failureVersion) return false;
      if (!record.hasPendingWrite) break;
    }
    return !record.terminal && !record.streamFailed;
  }

  abandon(segmentId: string): void {
    const record = this.recordsBySegment.get(segmentId);
    if (!record || record.terminal) return;
    record.terminal = true;
    record.hasPendingWrite = false;
    void record.ready.then((ready) => {
      if (!ready) return;
      void this.options.client
        .updateInstance({
          outTrackId: record.outTrackId,
          cardParamMap: {
            cardState: 'cancelled',
            headerTitle: '已取消',
            headerColor: 'grey',
            flowStatus: 3,
            hasAction: 'false',
            stop_action: 'false',
          },
        })
        .catch(() => {});
    });
    this.removeRecord(record);
  }

  /**
   * Resolves once the card is known to be delivered (or not) without waiting
   * through a creation backoff: `creationAttempt` is the failed attempt until
   * the retry actually starts, so a boundary reached mid-backoff falls back
   * to text while the retry keeps running for later output.
   */
  private async awaitDelivery(record: StatusRecord): Promise<boolean> {
    if (!(await record.creationAttempt)) return false;
    return record.ready;
  }

  private createRecord(
    segment: ChannelOutputSegmentContext,
    target: { chatId: string; isGroup: boolean },
    initialContent = '',
  ): StatusRecord {
    const outTrackId = `qwen-status-${randomUUID()}`;
    const record: StatusRecord = {
      context: segment,
      quoteContent: (this.options.quoteContent?.(segment) ?? '').slice(0, 2000),
      segmentId: segment.segmentId,
      runId: segment.runId,
      sessionId: segment.sessionId,
      ownerId: segment.owner.id,
      target,
      outTrackId,
      content: boundContent(initialContent),
      ...(segment.sourceLabel
        ? { sourcePrefix: escapeDingTalkMarkdown(segment.sourceLabel) }
        : {}),
      phase: 'thinking',
      startedAt: Date.now(),
      lastStatusSecond: 0,
      lastContentSyncSecond: 0,
      ready: Promise.resolve(false),
      creationAttempt: Promise.resolve(false),
      terminal: false,
      streamFailed: false,
      streamFailureVersion: 0,
      createRetryAttempt: 0,
      streamRetryAttempt: 0,
      terminalRetryAttempt: 0,
      consecutiveStatusFailures: 0,
      stopClaimed: false,
      forbiddenActors: new Set(),
      lastWriteAt: Date.now(),
      contentVersion: 0,
      hasPendingWrite: false,
      writeChain: Promise.resolve(),
    };
    this.recordsBySegment.set(record.segmentId, record);
    this.recordsByOutTrack.set(outTrackId, record);
    const segmentIds =
      this.segmentIdsByRun.get(record.runId) ?? new Set<string>();
    segmentIds.add(record.segmentId);
    this.segmentIdsByRun.set(record.runId, segmentIds);
    record.ready = this.create(record, target);
    void record.ready.then((ready) => {
      if (ready) this.scheduleStatusRefresh(record);
    });
    return record;
  }

  complete(
    segmentId: string,
    text: string,
    retainedContent?: (content: string) => string,
  ): Promise<boolean> {
    return this.finalize(
      segmentId,
      boundContent(text),
      'Completed',
      false,
      retainedContent,
    );
  }

  updateRunPhase(runId: string, phase: DingtalkPresentationPhase): void {
    if (this.disposed) return;
    for (const segmentId of this.segmentIdsByRun.get(runId) ?? []) {
      const record = this.recordsBySegment.get(segmentId);
      if (
        !record ||
        record.terminal ||
        record.streamFailed ||
        record.phase === phase
      ) {
        continue;
      }
      record.phase = phase;
      record.contentVersion++;
      record.hasPendingWrite = true;
      this.scheduleFlush(record);
    }
  }

  fail(segmentId: string, error: string): void {
    void this.finalize(segmentId, boundContent(error), 'Failed', true);
  }

  cancelRun(runId: string, reason: ChannelTaskCancellationReason): void {
    if (this.disposed) return;
    for (const segmentId of [...(this.segmentIdsByRun.get(runId) ?? [])]) {
      const record = this.recordsBySegment.get(segmentId);
      if (!record) continue;
      void this.finalize(
        segmentId,
        sanitizeStreamingImageMarkers(record.content),
        reason === 'cancel_command' ? 'Stopped' : 'Cancelled',
        false,
      );
    }
  }

  claimStop(outTrackId: string, actorId: string): DingtalkCardCallbackResult {
    if (this.disposed) return { kind: 'ignored', actorId };
    const record = this.recordsByOutTrack.get(outTrackId);
    if (!record || record.terminal || record.stopClaimed) {
      return { kind: 'ignored', actorId };
    }
    if (record.ownerId !== actorId) {
      if (record.forbiddenActors.has(actorId)) {
        return { kind: 'ignored' };
      }
      record.forbiddenActors.add(actorId);
      return { kind: 'forbidden', actorId, target: record.target };
    }
    record.stopClaimed = true;
    return {
      kind: 'accepted',
      execute: async () => {
        const cancelled = await this.options.cancelRun(
          record.sessionId,
          record.runId,
        );
        if (
          this.recordsByOutTrack.get(outTrackId) !== record ||
          record.terminal
        ) {
          return;
        }
        if (!cancelled) {
          record.stopClaimed = false;
          return;
        }
        this.cancelRun(record.runId, 'cancel_command');
      },
    };
  }

  claimCommand(
    outTrackId: string,
    actorId: string,
    command: '/new' | '/compress',
  ): DingtalkCardCallbackResult {
    this.pruneActionCards();
    const card = this.actionCards.get(outTrackId);
    if (
      this.disposed ||
      !card ||
      card.claimedCommands.has(command) ||
      !this.options.executeCommand
    ) {
      return { kind: 'ignored', actorId };
    }
    if (card.context.owner.id !== actorId) {
      if (card.forbiddenActors.has(actorId)) {
        return { kind: 'ignored' };
      }
      card.forbiddenActors.add(actorId);
      return {
        kind: 'forbidden',
        actorId,
        target: {
          chatId: card.context.target.chatId,
          isGroup: card.context.target.isGroup === true,
        },
      };
    }
    card.claimedCommands.add(command);
    return {
      kind: 'accepted',
      execute: async () => {
        if (this.disposed || this.actionCards.get(outTrackId) !== card) return;
        await this.options.executeCommand?.(card.context, command);
      },
    };
  }

  async presentPermission(
    segmentId: string,
    context: ChannelPermissionRequestContext,
  ): Promise<UserInputPresentationResult> {
    if (this.disposed) return { kind: 'unsupported' };
    const record = this.recordsBySegment.get(segmentId);
    if (
      !record ||
      record.terminal ||
      record.streamFailed ||
      record.runId !== context.runId ||
      record.ownerId !== context.owner.id ||
      record.permission
    ) {
      return { kind: 'unsupported' };
    }
    if (!(await this.awaitDelivery(record))) {
      return { kind: 'unsupported' };
    }
    await record.writeChain;
    const optionIds = new Map(
      context.options.map((option) => [option.kind, option.optionId]),
    );
    const permission: PendingPermission = {
      context,
      optionIds,
      claimed: false,
      unsubscribe: () => {},
    };
    record.permission = permission;
    record.permissionControlsVisible = true;
    let presentationFailed = false;
    let presentationError: unknown;
    const presentation = record.writeChain.then(async () => {
      try {
        await this.options.client.updateInstance({
          outTrackId: record.outTrackId,
          cardParamMap: {
            cardState: 'waiting',
            headerTitle: '等待确认',
            headerColor: 'orange',
            statusLine: this.statusLine(record, 'Waiting').text,
            blockList: JSON.stringify(this.permissionBlockList(context)),
            hasAction: 'false',
            stop_action: 'false',
          },
        });
      } catch (error) {
        presentationFailed = true;
        presentationError = error;
      }
    });
    record.writeChain = presentation;
    await presentation;
    if (presentationFailed) {
      record.permission = undefined;
      record.permissionControlsVisible = false;
      this.options.onError?.(
        'status card permission presentation',
        presentationError,
      );
      return { kind: 'unsupported' };
    }
    permission.unsubscribe = context.onSettled((reason) => {
      if (record.permission !== permission || permission.claimed) return;
      void this.resolvePermission(
        record,
        permission,
        reason === 'cancelled' || reason === 'run_cancelled'
          ? '授权已取消'
          : '授权已处理',
      );
    });
    return { kind: 'presented' };
  }

  claimPermission(
    outTrackId: string,
    actorId: string,
    action: PermissionAction,
  ): DingtalkCardCallbackResult {
    if (this.disposed) return { kind: 'ignored', actorId };
    const record = this.recordsByOutTrack.get(outTrackId);
    const permission = record?.permission;
    if (!record || !permission || permission.claimed || record.terminal) {
      return { kind: 'ignored', actorId };
    }
    if (record.ownerId !== actorId) {
      if (record.forbiddenActors.has(actorId)) {
        return { kind: 'ignored' };
      }
      record.forbiddenActors.add(actorId);
      return { kind: 'forbidden', actorId, target: record.target };
    }
    const optionId = permission.optionIds.get(action);
    if (!optionId) return { kind: 'ignored', actorId };
    permission.claimed = true;
    const selectedResult = {
      allow_always: '已始终允许',
      allow_once: '已本次允许',
      reject_once: '已拒绝',
    }[action];
    return {
      kind: 'accepted',
      execute: async () => {
        if (action === 'reject_once') {
          record.permissionResultBlocks = this.permissionBlockList(
            permission.context,
            selectedResult,
          );
        }
        void this.updatePermissionResult(record, permission, selectedResult);
        let accepted = false;
        try {
          accepted = await permission.context.respond({
            outcome: { outcome: 'selected', optionId },
          });
        } catch (error) {
          this.options.onError?.('status card permission response', error);
        }
        if (
          this.recordsByOutTrack.get(outTrackId) !== record ||
          record.permission !== permission
        ) {
          return;
        }
        if (!accepted && action === 'reject_once') {
          record.permissionResultBlocks = undefined;
        }
        await this.resolvePermission(
          record,
          permission,
          accepted ? selectedResult : '授权已失效',
          accepted && action === 'reject_once',
        );
      },
    };
  }

  private async resolvePermission(
    record: StatusRecord,
    permission: PendingPermission,
    result: string,
    retainInTerminal = false,
  ): Promise<void> {
    const resultBlocks = this.permissionBlockList(permission.context, result);
    if (this.disposed || record.permission !== permission) {
      return;
    }
    if (retainInTerminal) {
      record.permissionResultBlocks = resultBlocks;
    }
    permission.unsubscribe();
    record.permission = undefined;
    if (record.terminal) return;
    await this.updatePermissionResult(record, permission, result);
  }

  private async updatePermissionResult(
    record: StatusRecord,
    permission: PendingPermission,
    result: string,
  ): Promise<void> {
    const resultBlocks = this.permissionBlockList(permission.context, result);
    const update = record.writeChain
      .then(async () => {
        if (this.disposed || record.terminal) return;
        await this.options.client.updateInstance({
          outTrackId: record.outTrackId,
          cardParamMap: {
            cardState: 'running',
            headerTitle: '处理中',
            headerColor: 'blue',
            statusLine: this.statusLine(record).text,
            blockList: JSON.stringify(resultBlocks),
            hasAction: 'true',
            stop_action: 'true',
          },
        });
        record.permissionControlsVisible = false;
      })
      .catch((error) => {
        this.options.onError?.('status card permission resolution', error);
      });
    record.writeChain = update;
    await update;
  }

  private pruneActionCards(): void {
    for (const [id, card] of this.actionCards) {
      if (card.expiresAt <= Date.now()) this.actionCards.delete(id);
    }
    while (this.actionCards.size > MAX_ACTION_CARDS) {
      this.actionCards.delete(this.actionCards.keys().next().value!);
    }
  }

  private permissionBlockList(
    context: ChannelPermissionRequestContext,
    result?: string,
  ): Array<Record<string, unknown>> {
    const details = [
      '**需要授权**',
      `工具：${escapeDingTalkMarkdown(context.toolName)}`,
      escapeDingTalkMarkdown(context.action),
      ...(context.parameters
        ? [`参数：${escapeDingTalkMarkdown(context.parameters)}`]
        : []),
    ];
    const summary = {
      type: 0,
      markdown: details.map((line) => `> ${line}`).join('\n'),
      text: '',
      mediaId: '',
    };
    if (result) {
      return [
        summary,
        {
          type: 2,
          text: result,
          markdown: `> ${escapeDingTalkMarkdown(result)}`,
          mediaId: '',
        },
      ];
    }
    const actionIds: Record<PermissionAction, string> = {
      allow_always: 'btn_permission_allow_always',
      allow_once: 'btn_permission_allow_once',
      reject_once: 'btn_permission_reject',
    };
    return [
      summary,
      {
        type: 4,
        btns: context.options.map((option) => ({
          text: option.label,
          color: option.kind === 'allow_always' ? 'blue' : 'gray',
          status: 'normal',
          event: {
            type: 'sendCardRequest',
            params: { actionId: actionIds[option.kind] },
          },
        })),
        text: '',
        markdown: '',
        mediaId: '',
      },
    ];
  }

  private async create(
    record: StatusRecord,
    target: { chatId: string; isGroup: boolean },
  ): Promise<boolean> {
    for (;;) {
      let settleAttempt!: (delivered: boolean) => void;
      record.creationAttempt = new Promise<boolean>((resolve) => {
        settleAttempt = resolve;
      });
      try {
        await this.options.client.createAndDeliver({
          templateId: STATUS_CARD_TEMPLATE_ID,
          outTrackId: record.outTrackId,
          target,
          cardParamMap: {
            cardState: 'running',
            headerTitle: '处理中',
            headerColor: 'blue',
            quoteContent: record.quoteContent,
            agentName: '',
            content: activeContent(
              record.phase,
              record.content,
              this.options.language,
              record.sourcePrefix,
            ),
            flowStatus: 2,
            statusLine: this.statusLine(record).text,
            hasAction: 'true',
            stop_action: 'true',
          },
        });
        settleAttempt(true);
        break;
      } catch (error) {
        settleAttempt(false);
        this.options.onError?.('status card creation', error);
        if (
          this.disposed ||
          record.terminal ||
          !isRetryableDingtalkCardError(error)
        ) {
          return false;
        }
        if (!(await this.waitForCreationRetry(record))) return false;
      }
    }
    if (this.disposed) return false;
    if (this.recordsBySegment.get(record.segmentId) !== record) return true;

    try {
      await this.options.client.openOrUpdateStream({
        outTrackId: record.outTrackId,
        key: 'content',
        content: activeContent(
          record.phase,
          record.content,
          this.options.language,
          record.sourcePrefix,
        ),
        finalize: false,
      });
    } catch (error) {
      this.handleStreamFailure(record, error);
    }
    return true;
  }

  /**
   * Sleeps for the next creation backoff. Resolves false when finalization or
   * disposal abandons the creation so `ready` settles without waiting.
   */
  private waitForCreationRetry(record: StatusRecord): Promise<boolean> {
    const delay = this.retryDelay(record.createRetryAttempt++);
    return new Promise<boolean>((resolve) => {
      const settle = (resumed: boolean) => {
        if (record.createRetryTimer) clearTimeout(record.createRetryTimer);
        record.createRetryTimer = undefined;
        record.abandonCreation = undefined;
        resolve(resumed);
      };
      record.abandonCreation = () => settle(false);
      record.createRetryTimer = setTimeout(() => settle(true), delay);
    });
  }

  private scheduleFlush(record: StatusRecord): void {
    if (
      record.flushTimer ||
      record.streamRetryTimer ||
      record.inFlight ||
      record.terminal
    )
      return;
    const delay = Math.max(
      0,
      FLUSH_INTERVAL_MS - (Date.now() - record.lastWriteAt),
    );
    record.flushTimer = setTimeout(() => {
      record.flushTimer = undefined;
      this.flush(record);
    }, delay);
  }

  private flush(record: StatusRecord): void {
    if (
      this.disposed ||
      record.terminal ||
      record.streamFailed ||
      record.inFlight ||
      !record.hasPendingWrite
    )
      return;
    record.hasPendingWrite = false;
    let sentVersion: number | undefined;
    let contentWritten = false;
    const write = record.writeChain
      .then(async () => {
        const ready = await record.ready;
        if (!ready || record.terminal || record.streamFailed) return;
        sentVersion = record.contentVersion;
        await this.options.client.openOrUpdateStream({
          outTrackId: record.outTrackId,
          key: 'content',
          content: activeContent(
            record.phase,
            record.content,
            this.options.language,
            record.sourcePrefix,
          ),
          finalize: false,
        });
        contentWritten = true;
        record.streamRetryAttempt = 0;
        await this.updateRunningStatus(record);
      })
      .catch((error) => this.handleStreamFailure(record, error));
    const tracked = write.finally(() => {
      if (record.inFlight === tracked) {
        record.inFlight = undefined;
      }
      record.lastWriteAt = Date.now();
      if (contentWritten && record.contentVersion === sentVersion) {
        record.hasPendingWrite = false;
      }
      if (record.hasPendingWrite && record.contentVersion !== sentVersion) {
        this.scheduleFlush(record);
      }
    });
    record.inFlight = tracked;
    record.writeChain = tracked;
  }

  private async finalize(
    segmentId: string,
    content: string,
    state: Exclude<StatusState, 'Running'>,
    isError: boolean,
    retainedContent?: (content: string) => string,
  ): Promise<boolean> {
    if (this.disposed) return false;
    const record = this.recordsBySegment.get(segmentId);
    if (!record || record.terminal) return false;
    record.terminal = true;
    this.terminalSegmentIds.add(segmentId);
    while (this.terminalSegmentIds.size > 1000) {
      const oldest = this.terminalSegmentIds.values().next().value;
      if (oldest === undefined) break;
      this.terminalSegmentIds.delete(oldest);
    }
    if (record.flushTimer) clearTimeout(record.flushTimer);
    record.flushTimer = undefined;
    if (record.streamRetryTimer) clearTimeout(record.streamRetryTimer);
    record.streamRetryTimer = undefined;
    if (record.statusTimer) clearTimeout(record.statusTimer);
    record.statusTimer = undefined;
    record.hasPendingWrite = false;
    record.abandonCreation?.();
    if (!(await record.ready)) {
      this.removeRecord(record);
      return false;
    }
    await record.writeChain;
    const retained =
      content ||
      (retainedContent ? retainedContent(record.content) : record.content);
    record.terminalIntent = {
      state,
      content: boundContent(sanitizeStreamingImageMarkers(retained)),
      isError,
      statusLine: this.statusLine(record, state).text,
      streamFinalizeSettled: false,
    };
    return this.attemptFinalization(record);
  }

  private async attemptFinalization(record: StatusRecord): Promise<boolean> {
    if (this.disposed) return false;
    if (this.recordsBySegment.get(record.segmentId) !== record) return false;
    const intent = record.terminalIntent;
    if (!intent) return false;

    if (record.permissionControlsVisible) {
      try {
        await this.options.client.updateInstance({
          outTrackId: record.outTrackId,
          cardParamMap: {
            blockList: JSON.stringify([
              {
                type: 0,
                markdown: intent.content,
              },
              ...(record.permissionResultBlocks ?? []),
            ]),
            cardState: intent.state.toLowerCase(),
            headerTitle: {
              Running: '处理中',
              Completed: '已完成',
              Failed: '执行失败',
              Stopped: '已停止',
              Cancelled: '已取消',
            }[intent.state],
            headerColor:
              intent.state === 'Completed'
                ? 'green'
                : intent.isError
                  ? 'red'
                  : 'grey',
            flowStatus: 3,
            statusLine: intent.statusLine,
            hasAction: 'false',
            stop_action: 'false',
          },
        });
        record.permissionControlsVisible = false;
      } catch (error) {
        this.options.onError?.(
          'status card permission terminal cleanup',
          error,
        );
      }
    }

    if (!intent.streamFinalizeSettled) {
      try {
        await this.options.client.openOrUpdateStream({
          outTrackId: record.outTrackId,
          key: 'content',
          content: '',
          finalize: true,
          isError: intent.isError,
        });
        intent.streamFinalizeSettled = true;
      } catch (error) {
        if (!isRetryableDingtalkCardError(error)) {
          intent.streamFinalizeSettled = true;
        }
        this.options.onError?.('status card finalization', error);
      }
    }
    if (this.disposed) return false;

    try {
      await this.options.client.updateInstance({
        outTrackId: record.outTrackId,
        cardParamMap: {
          blockList: JSON.stringify([
            {
              type: 0,
              markdown: intent.content,
            },
            ...(record.permissionResultBlocks ?? []),
          ]),
          content: intent.content,
          markdown: intent.content,
          cardState: intent.state.toLowerCase(),
          headerTitle: {
            Running: '处理中',
            Completed: '已完成',
            Failed: '执行失败',
            Stopped: '已停止',
            Cancelled: '已取消',
          }[intent.state],
          headerColor:
            intent.state === 'Completed'
              ? 'green'
              : intent.isError
                ? 'red'
                : 'grey',
          copy_content: intent.content,
          flowStatus: 3,
          statusLine: intent.statusLine,
          hasAction: this.options.executeCommand ? 'true' : 'false',
          stop_action: 'false',
        },
      });
      record.content = '';
      if (this.options.executeCommand) {
        this.actionCards.set(record.outTrackId, {
          context: record.context,
          expiresAt: Date.now() + ACTION_RETENTION_MS,
          claimedCommands: new Set(),
          forbiddenActors: new Set(),
        });
        this.pruneActionCards();
      }
      this.removeRecord(record);
      return true;
    } catch (error) {
      this.options.onError?.('status card finalization', error);
      if (isRetryableDingtalkCardError(error)) {
        this.scheduleTerminalRetry(record);
        return true;
      } else {
        this.removeRecord(record);
      }
      return false;
    }
  }

  private scheduleStreamRetry(record: StatusRecord): void {
    if (
      this.disposed ||
      record.terminal ||
      record.streamFailed ||
      record.streamRetryTimer
    ) {
      return;
    }
    const delay = this.retryDelay(record.streamRetryAttempt++);
    record.streamRetryTimer = setTimeout(() => {
      record.streamRetryTimer = undefined;
      if (this.disposed || record.terminal || record.streamFailed) return;
      this.flush(record);
    }, delay);
  }

  private scheduleTerminalRetry(record: StatusRecord): void {
    if (this.disposed || !record.terminalIntent || record.terminalRetryTimer) {
      return;
    }
    const delay = this.retryDelay(record.terminalRetryAttempt++);
    record.terminalRetryTimer = setTimeout(() => {
      record.terminalRetryTimer = undefined;
      if (this.disposed) return;
      void this.attemptFinalization(record);
    }, delay);
  }

  private handleStreamFailure(record: StatusRecord, error: unknown): void {
    record.streamFailureVersion++;
    if (
      !this.disposed &&
      !record.terminal &&
      isRetryableDingtalkCardError(error)
    ) {
      record.hasPendingWrite = true;
      this.scheduleStreamRetry(record);
    } else if (!record.terminal) {
      record.streamFailed = true;
      record.hasPendingWrite = false;
      if (record.statusTimer) {
        clearTimeout(record.statusTimer);
        record.statusTimer = undefined;
      }
    }
    this.options.onError?.('status card streaming', error);
  }

  private retryDelay(attempt: number): number {
    return Math.min(
      INITIAL_RETRY_INTERVAL_MS * 2 ** Math.min(attempt, 10),
      MAX_RETRY_INTERVAL_MS,
    );
  }

  private removeRecord(record: StatusRecord): void {
    record.permission?.unsubscribe();
    record.permission = undefined;
    record.abandonCreation?.();
    if (record.flushTimer) clearTimeout(record.flushTimer);
    if (record.streamRetryTimer) clearTimeout(record.streamRetryTimer);
    if (record.terminalRetryTimer) clearTimeout(record.terminalRetryTimer);
    if (record.statusTimer) clearTimeout(record.statusTimer);
    record.flushTimer = undefined;
    record.streamRetryTimer = undefined;
    record.terminalRetryTimer = undefined;
    record.statusTimer = undefined;
    if (this.recordsBySegment.get(record.segmentId) === record) {
      this.recordsBySegment.delete(record.segmentId);
    }
    if (this.recordsByOutTrack.get(record.outTrackId) === record) {
      this.recordsByOutTrack.delete(record.outTrackId);
    }
    const segmentIds = this.segmentIdsByRun.get(record.runId);
    segmentIds?.delete(record.segmentId);
    if (segmentIds?.size === 0) {
      this.segmentIdsByRun.delete(record.runId);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const record of [...this.recordsBySegment.values()]) {
      record.terminal = true;
      record.hasPendingWrite = false;
      this.removeRecord(record);
    }
    this.terminalSegmentIds.clear();
    this.actionCards.clear();
  }

  private statusLine(
    record: StatusRecord,
    state?: Exclude<StatusState, 'Running'> | 'Waiting',
  ): { text: string; second: number } {
    const second = Math.max(
      0,
      Math.floor((Date.now() - record.startedAt) / 1000),
    );
    const showModel = this.options.showModel !== false;
    const showReasoningEffort = this.options.showReasoningEffort !== false;
    const modelInfo =
      showModel || showReasoningEffort
        ? this.options.sessionModelInfo?.(record.context)
        : undefined;
    const model = showModel
      ? (modelInfo?.model?.trim() || this.options.model?.trim())
          ?.replace(/\(openai\)$/u, '')
          .trim()
      : undefined;
    const effort = showReasoningEffort
      ? modelInfo?.reasoningEffort?.trim()
      : undefined;
    return {
      text: [
        state ? this.statusStateLabel(state) : undefined,
        model,
        effort === 'default' ? undefined : effort,
        `${second}s`,
      ]
        .filter(Boolean)
        .join(' · '),
      second,
    };
  }

  private statusStateLabel(
    state: Exclude<StatusState, 'Running'> | 'Waiting',
  ): string {
    if (!isChinesePresentationLanguage(this.options.language)) return state;
    return (
      {
        Completed: '已完成',
        Failed: '已失败',
        Stopped: '已终止',
        Cancelled: '已取消',
        Waiting: '等待确认',
      }[state] ?? state
    );
  }

  private async updateRunningStatus(record: StatusRecord): Promise<void> {
    if (this.disposed || record.terminal || record.streamFailed) return;
    const status = this.statusLine(
      record,
      record.permission ? 'Waiting' : undefined,
    );
    if (status.second === record.lastStatusSecond) return;
    const syncContent =
      status.second - record.lastContentSyncSecond >=
      CONTENT_SYNC_INTERVAL_SECONDS;
    try {
      await this.options.client.updateInstance({
        outTrackId: record.outTrackId,
        cardParamMap: {
          ...(syncContent
            ? {
                content: activeContent(
                  record.phase,
                  record.content,
                  this.options.language,
                  record.sourcePrefix,
                ),
              }
            : {}),
          statusLine: status.text,
        },
      });
      record.lastStatusSecond = status.second;
      if (syncContent) record.lastContentSyncSecond = status.second;
      record.consecutiveStatusFailures = 0;
      // A success revives the per-second chain even when only a low-frequency
      // breaker probe is scheduled.
      if (record.statusTimer) {
        clearTimeout(record.statusTimer);
        record.statusTimer = undefined;
      }
      this.scheduleStatusRefresh(record);
    } catch (error) {
      record.consecutiveStatusFailures++;
      this.options.onError?.('status card metadata', error);
    }
  }

  private scheduleStatusRefresh(
    record: StatusRecord,
    intervalMs = STATUS_REFRESH_INTERVAL_MS,
  ): void {
    if (
      this.disposed ||
      record.terminal ||
      record.streamFailed ||
      record.statusTimer
    )
      return;
    const elapsed = Math.max(0, Date.now() - record.startedAt);
    const delay = Math.max(50, intervalMs - (elapsed % intervalMs));
    record.statusTimer = setTimeout(() => {
      record.statusTimer = undefined;
      if (this.disposed || record.terminal || record.streamFailed) return;
      const refresh = record.writeChain.then(() =>
        this.updateRunningStatus(record),
      );
      record.writeChain = refresh;
      void refresh.finally(() => {
        if (
          record.consecutiveStatusFailures >= MAX_CONSECUTIVE_STATUS_FAILURES
        ) {
          // An idle card cannot revive through a flush once the breaker
          // trips, so keep a low-frequency probe instead of stopping forever.
          this.scheduleStatusRefresh(record, BREAKER_PROBE_INTERVAL_MS);
          return;
        }
        this.scheduleStatusRefresh(record);
      });
    }, delay);
  }
}
