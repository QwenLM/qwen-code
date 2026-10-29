/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { openNoFollow } from '../utils/no-follow-open.js';
import {
  isInternalCodeModeToolResult,
  isUserPromptSubmitContextPartText,
  projectUserTranscriptForDisplay,
  stripGeneratedAttachmentTokens,
  validateTranscriptRecord,
} from '../utils/transcript-records.js';
import type {
  ChatRecord,
  AttributionSnapshotPayload,
  SessionSourceRecordPayload,
} from '../services/chatRecordingService.js';
import { isTurnResultRecordPayload } from '../services/chatRecordingService.js';
import {
  SessionExecutionEngineAccumulator,
  type SessionExecutionEngineState,
} from '../services/session-execution-engine.js';
import { getSessionTurnRecordHint } from '../services/session-turn-state.js';
import { readFileHistorySnapshotPayload } from '../services/session-file-history-state.js';
import {
  deserializeSnapshots,
  MAX_SNAPSHOTS,
  type FileHistorySnapshot,
} from '../services/fileHistoryService.js';
import { ResumeTokenCountsAccumulator } from '../services/session-resume-token-counts.js';
import {
  parseBranchCheckpointPayload,
  type BranchToolCallIdentity,
} from '../services/branch-points.js';
import {
  normalizeGoalRecoveryRecord,
  type GoalRecoveryRecord,
} from '../goals/goal-persistence.js';
import { parseGoalStateRecordPayloadV2 } from '../goals/goal-reducer.js';
import type { GoalStateRecordPayloadV2 } from '../goals/goal-protocol.js';
import type { SessionTranscriptNavigationTurnKind } from '../services/session-transcript-reader.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import type { FileManagedSessionHistory } from './managed-session-history.js';
import { LocalManagedSessionAuthority } from './managed-session-authority.js';
import { ManagedSessionMessageProjection } from './managed-session-message-projection.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import { scanLocalManagedJournal } from './local-managed-journal-snapshot.js';
import {
  MANAGED_SESSION_LIMITS,
  ManagedSessionRecordError,
  type ManagedSessionKey,
} from './managed-session-records.js';

const debugLogger = createDebugLogger('MANAGED_TRANSCRIPT');
const CHUNK_BYTES = 64 * 1024;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function navigationDisplayText(text: string, systemPayload: unknown): string {
  const stripped = stripGeneratedAttachmentTokens(text, systemPayload);
  return isUserPromptSubmitContextPartText(stripped) ? '' : stripped;
}

export function navigationKindForRecord(
  record: ChatRecord,
): SessionTranscriptNavigationTurnKind | undefined {
  if (record.type !== 'user') return undefined;
  if (
    record.subtype === 'goal_runtime' ||
    record.subtype === 'notification' ||
    record.subtype === 'mid_turn_user_message' ||
    record.subtype === 'agent_mention' ||
    record.subtype === 'agent_message'
  ) {
    return undefined;
  }
  if (record.subtype === 'cron') {
    const payload = isObjectRecord(record.systemPayload)
      ? record.systemPayload
      : undefined;
    const displayText =
      typeof payload?.['displayText'] === 'string'
        ? navigationDisplayText(payload['displayText'], record.systemPayload)
        : '';
    return displayText.trim().length > 0 ? 'scheduled' : undefined;
  }

  const projection = projectUserTranscriptForDisplay(record);
  const displayText =
    projection.displayText === undefined
      ? undefined
      : navigationDisplayText(projection.displayText, record.systemPayload);
  const hasVisibleText =
    displayText !== undefined
      ? displayText.trim().length > 0
      : projection.parts.some(
          (part) =>
            isObjectRecord(part) &&
            typeof part['text'] === 'string' &&
            part['text'].trim().length > 0 &&
            !isUserPromptSubmitContextPartText(part['text']),
        );
  const hasVisibleAttachment =
    projection.parts.some((part) => {
      if (!isObjectRecord(part) || !isObjectRecord(part['inlineData'])) {
        return false;
      }
      const inlineData = part['inlineData'];
      return (
        typeof inlineData['data'] === 'string' &&
        typeof inlineData['mimeType'] === 'string' &&
        inlineData['mimeType'].startsWith('image/')
      );
    }) ||
    (isObjectRecord(record.systemPayload) &&
      Array.isArray(record.systemPayload['attachmentReferences']) &&
      record.systemPayload['attachmentReferences'].some(
        (reference) =>
          isObjectRecord(reference) &&
          (reference['type'] === 'image' || reference['type'] === 'resource') &&
          typeof reference['attachmentId'] === 'string' &&
          typeof reference['mimeType'] === 'string' &&
          typeof reference['size'] === 'number',
      ));
  if (!hasVisibleText && !hasVisibleAttachment) return undefined;
  return record.subtype === 'realtime_message' ? 'realtime' : 'prompt';
}

export function isAssistantPreviewCandidate(record: ChatRecord): boolean {
  return (
    record.type === 'assistant' &&
    (record.message?.parts ?? []).some(
      (part) =>
        isObjectRecord(part) &&
        part['thought'] !== true &&
        typeof part['text'] === 'string' &&
        part['text'].trim().length > 0,
    )
  );
}

function compactPreviewText(text: string, maxCodePoints: number): string {
  const compacted = text.replace(/\s+/gu, ' ').trim();
  const codePoints = Array.from(compacted);
  if (codePoints.length <= maxCodePoints) return compacted;
  return `${codePoints.slice(0, maxCodePoints - 1).join('')}…`;
}

export function projectNavigationLabel(
  record: ChatRecord,
  kind: SessionTranscriptNavigationTurnKind,
): string {
  const payload = isObjectRecord(record.systemPayload)
    ? record.systemPayload
    : undefined;
  let text = '';
  if (kind === 'scheduled') {
    if (typeof payload?.['displayText'] === 'string') {
      text = navigationDisplayText(
        payload['displayText'],
        record.systemPayload,
      );
    }
  } else {
    const projection = projectUserTranscriptForDisplay(record);
    const projectedText =
      projection.displayText === undefined
        ? projection.parts
            .flatMap((part) =>
              isObjectRecord(part) &&
              typeof part['text'] === 'string' &&
              !isUserPromptSubmitContextPartText(part['text'])
                ? [part['text']]
                : [],
            )
            .join(' ')
        : projection.displayText;
    text = navigationDisplayText(projectedText, record.systemPayload);
  }
  const label = compactPreviewText(text, 160);
  if (label.length > 0) return label;
  return kind === 'scheduled'
    ? 'Scheduled prompt'
    : kind === 'realtime'
      ? 'Realtime message'
      : 'Prompt';
}

export function projectNavigationDetail(
  record: ChatRecord,
): string | undefined {
  const detail = compactPreviewText(
    stripGeneratedAttachmentTokens(
      (record.message?.parts ?? [])
        .flatMap((part) =>
          isObjectRecord(part) &&
          part['thought'] !== true &&
          typeof part['text'] === 'string'
            ? [part['text']]
            : [],
        )
        .join(' '),
      record.systemPayload,
    ),
    240,
  );
  return detail.length > 0 ? detail : undefined;
}

export interface ManagedTranscriptSource {
  filePath: string;
  runtimeBaseDir: string;
  sessionKey: ManagedSessionKey;
  snapshotSize: number;
  fileIdentity: { dev: number; ino: number };
  lastUpdated: string;
  expectedDigest?: string;
  validateFirstRecord?: (record: ChatRecord) => boolean | Promise<boolean>;
}

export interface ManagedTranscriptEntry {
  position: number;
  sequence: number;
  uuid: string;
  parentUuid: string | null;
  type: ChatRecord['type'];
  subtype?: ChatRecord['subtype'];
  byteLength: number;
  inherited: boolean;
  navigationOrdinal?: number;
  goalBefore?: number;
}

export interface ManagedTranscriptTurn {
  turnId: string;
  replayPosition: number;
  kind: SessionTranscriptNavigationTurnKind;
  promptId?: string;
  finalAssistantRecordId?: string;
}

interface PendingBranchCall extends BranchToolCallIdentity {
  scope: number;
  position: number;
  active: boolean;
}

/** An owner-scoped disk catalog over a verified, immutable physical prefix. */
export class ManagedSessionTranscriptQuery {
  private authority!: LocalManagedSessionAuthority;
  private projection!: ManagedSessionMessageProjection;
  private catalog!: FileManagedSessionHistory;
  private readonly activeReads = new Set<Promise<unknown>>();
  private closing = false;
  private closePromise?: Promise<void>;
  private readonly engine: SessionExecutionEngineAccumulator;
  private firstLineDigest = '';
  private physicalDigest = '';
  private firstRecord!: ChatRecord;
  private physicalPending = Buffer.alloc(0);
  private sourceMetadata!: { ctimeMs: number; mtimeMs: number };
  private count = 0;
  private turns = 0;
  private visibleTurns?: number;
  private latestGoalPosition?: number;
  private sourceBoundary?: number;
  private readonly replayCounts: Array<number | undefined> = [
    undefined,
    undefined,
  ];
  private lastProjectedUuid?: string;
  private lastPhysicalRecordUuid?: string;
  private currentPrompt?: { ordinal: number; turn: ManagedTranscriptTurn };
  private currentRealtime?: { ordinal: number; turn: ManagedTranscriptTurn };
  private maxPromptTurn = 0;
  private userPrompts = 0;
  private userTurns = 0;
  private latestValidGoal?: GoalRecoveryRecord;
  private latestInvalidGoal?: GoalRecoveryRecord;
  private readonly retainedFilePrompts: string[] = [];
  private readonly fileSnapshots = new Map<string, FileHistorySnapshot>();
  readonly tokenCounts = new ResumeTokenCountsAccumulator();
  attributionSnapshot?: AttributionSnapshotPayload['snapshot'];
  source?: SessionSourceRecordPayload;
  lastAssistantModel?: string;
  titleInfo: { title?: string; source?: 'auto' | 'manual' } = {};

  private constructor(
    readonly options: ManagedTranscriptSource,
    private readonly handle: FileHandle,
  ) {
    this.engine = new SessionExecutionEngineAccumulator(
      options.sessionKey.sessionId,
    );
  }

  static async open(
    options: ManagedTranscriptSource,
  ): Promise<ManagedSessionTranscriptQuery | undefined> {
    options = Object.freeze({
      ...options,
      fileIdentity: Object.freeze({ ...options.fileIdentity }),
      sessionKey: Object.freeze({ ...options.sessionKey }),
    });
    if ((await lstat(options.filePath)).isSymbolicLink()) return undefined;
    const handle = await openNoFollow(options.filePath);
    const view: ManagedSessionTranscriptQuery =
      new ManagedSessionTranscriptQuery(options, handle);
    try {
      const stats = await handle.stat();
      view.sourceMetadata = {
        ctimeMs: stats.ctimeMs,
        mtimeMs: stats.mtimeMs,
      };
      if (!(await view.probe())) {
        await handle.close();
        return undefined;
      }
      view.require(
        stats.isFile() &&
          stats.dev === options.fileIdentity.dev &&
          stats.ino === options.fileIdentity.ino &&
          stats.size >= options.snapshotSize,
      );
      view.require(view.firstRecord !== undefined);
      if (
        options.validateFirstRecord &&
        !(await options.validateFirstRecord(view.firstRecord))
      )
        throw new ManagedSessionRecordError(
          'The first transcript record does not authorize this project.',
        );
      const resources = LocalManagedSessionResourceStore.create({
        runtimeBaseDir: options.runtimeBaseDir,
        sessionKey: options.sessionKey,
      });
      view.authority = await LocalManagedSessionAuthority.openReadOnly({
        sessionKey: options.sessionKey,
        cwd: view.firstRecord.cwd,
        version: view.firstRecord.version,
        resources,
        historyDirectory: path.join(
          options.runtimeBaseDir,
          'managed-transcript-authority',
        ),
        scan: (consume) =>
          scanLocalManagedJournal(
            {
              transcriptPath: options.filePath,
              runtimeBaseDir: options.runtimeBaseDir,
              sessionKey: options.sessionKey,
              maxBytes: options.snapshotSize,
            },
            consume,
            view.chunks(),
          ),
      });
      view.catalog = view.authority.createQueryHistory();
      view.projection = new ManagedSessionMessageProjection(
        view.authority,
        resources,
      );
      await view.build();
      const metadata = view.authority.domainRecord('session_metadata');
      if (metadata) {
        try {
          const body: unknown = JSON.parse(
            (await resources.read(metadata.recordRef)).toString('utf8'),
          );
          if (
            isObjectRecord(body) &&
            typeof body['title'] === 'string' &&
            body['title'].length > 0
          )
            view.titleInfo = {
              title: body['title'],
              ...(body['titleSource'] === 'auto' ||
              body['titleSource'] === 'manual'
                ? { source: body['titleSource'] }
                : {}),
            };
        } catch {
          /* A damaged optional title is reported as absent. */
        }
      }
      await view.assertUnchanged();
      return view;
    } catch (error) {
      await view.close();
      throw error;
    }
  }

  private async probe(): Promise<boolean> {
    const bytes = Buffer.alloc(
      Math.min(
        this.options.snapshotSize,
        2 * MANAGED_SESSION_LIMITS.maxHeaderBytes + CHUNK_BYTES,
      ),
    );
    let offset = 0;
    while (offset < bytes.length) {
      const result = await this.handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    let start = 0;
    let owner = false;
    for (let count = 0; count < 3; count++) {
      const end = bytes.indexOf(10, start);
      if (end < 0 || end >= offset)
        return owner && start < this.options.snapshotSize;
      let value: unknown;
      try {
        value = JSON.parse(bytes.subarray(start, end).toString('utf8'));
      } catch {
        return owner;
      }
      if (!isObjectRecord(value)) return owner;
      if (count === 0) {
        const validated = validateTranscriptRecord(value).record;
        if (validated) this.firstRecord = validated as ChatRecord;
        this.firstLineDigest = createHash('sha256')
          .update(bytes.subarray(start, end))
          .digest('hex');
      }
      if (value['subtype'] === 'managed_session_header_v1') {
        this.require(this.firstRecord !== undefined);
        return true;
      }
      if (value['subtype'] !== 'session_execution_engine') return owner;
      owner =
        isObjectRecord(value['systemPayload']) &&
        value['systemPayload']['engine'] === 'managed';
      start = end + 1;
    }
    return owner;
  }

  private async *chunks(): AsyncGenerator<Buffer> {
    const digest = createHash('sha256');
    let position = 0;
    let first = true;
    while (position < this.options.snapshotSize) {
      const bytes = Buffer.alloc(
        Math.min(CHUNK_BYTES, this.options.snapshotSize - position),
      );
      const { bytesRead } = await this.handle.read(
        bytes,
        0,
        bytes.length,
        position,
      );
      this.require(bytesRead > 0);
      position += bytesRead;
      const chunk = bytes.subarray(0, bytesRead);
      digest.update(chunk);
      this.physicalPending = this.physicalPending.length
        ? Buffer.concat([this.physicalPending, chunk])
        : chunk;
      let newline: number;
      while ((newline = this.physicalPending.indexOf(10)) >= 0) {
        const line = this.physicalPending.subarray(0, newline);
        if (first) {
          this.require(
            createHash('sha256').update(line).digest('hex') ===
              this.firstLineDigest,
          );
          first = false;
        }
        for (const { record } of this.engine.parseLine(
          line.toString('utf8'),
          this.options.filePath,
        ))
          if (record) this.lastPhysicalRecordUuid = record.uuid;
        this.physicalPending = this.physicalPending.subarray(newline + 1);
      }
      this.require(
        this.physicalPending.byteLength <= MANAGED_SESSION_LIMITS.maxEventBytes,
      );
      yield chunk;
    }
    this.physicalDigest = digest.digest('hex');
    if (this.options.expectedDigest)
      this.require(this.physicalDigest === this.options.expectedDigest);
    this.physicalPending = Buffer.alloc(0);
  }

  private async build(): Promise<void> {
    const entries = this.catalog.map<ManagedTranscriptEntry>('resource');
    const identities = this.catalog.map<number>('event-id');
    const navigation = this.catalog.map<ManagedTranscriptTurn>('action');
    for await (const event of this.authority.iterateEvents()) {
      const record = await this.projection.recordAt(event);
      if (!record) continue;
      this.require((await identities.get(record.uuid)) === undefined);
      const position = this.count++;
      const kind = navigationKindForRecord(record);
      const entry: ManagedTranscriptEntry = {
        position,
        sequence: event.sequence,
        uuid: record.uuid,
        parentUuid: record.parentUuid,
        type: record.type,
        ...(record.subtype ? { subtype: record.subtype } : {}),
        byteLength: Buffer.byteLength(JSON.stringify(record)),
        inherited: record.forkedFrom !== undefined,
        ...(this.latestGoalPosition === undefined
          ? {}
          : { goalBefore: this.latestGoalPosition }),
      };
      if (kind) {
        const ordinal = this.turns++;
        entry.navigationOrdinal = ordinal;
        const turn: ManagedTranscriptTurn = {
          turnId: record.uuid,
          replayPosition: position,
          kind,
          ...(record.daemonPromptId ? { promptId: record.daemonPromptId } : {}),
        };
        await navigation.set(ordinal, turn);
        if (kind === 'realtime') this.currentRealtime = { ordinal, turn };
        else {
          this.currentPrompt = { ordinal, turn };
          this.currentRealtime = undefined;
        }
      } else if (isAssistantPreviewCandidate(record)) {
        const current =
          record.subtype === 'realtime_message'
            ? this.currentRealtime
            : this.currentPrompt;
        if (current) {
          current.turn.finalAssistantRecordId = record.uuid;
          await navigation.set(current.ordinal, current.turn);
        }
      }
      if (
        record.subtype === 'turn_result' &&
        isTurnResultRecordPayload(record.systemPayload) &&
        this.currentPrompt
      ) {
        this.currentPrompt.turn.promptId ??= record.systemPayload.promptId;
        await navigation.set(
          this.currentPrompt.ordinal,
          this.currentPrompt.turn,
        );
        this.currentPrompt = undefined;
      }
      await entries.set(position, entry);
      await identities.set(record.uuid, position);
      this.lastProjectedUuid = record.uuid;
      if (record.subtype === 'goal_state') this.latestGoalPosition = position;
      if (record.subtype === 'branch_checkpoint') {
        const payload = parseBranchCheckpointPayload(record.systemPayload);
        if (payload) {
          const groups = this.catalog.map<number>('checkpoint');
          const previous = (await groups.get(payload.assistantRecordUuid)) ?? 0;
          await this.catalog
            .map<number>('hook-ordinal')
            .set(position, previous);
          await groups.set(payload.assistantRecordUuid, position + 1);
        }
      }
      if (
        record.type === 'system' &&
        record.subtype === 'session_source' &&
        isObjectRecord(record.systemPayload) &&
        record.systemPayload['sourceType'] === 'side_task'
      )
        this.sourceBoundary ??= position;
      await this.summarize(record);
    }
    this.currentPrompt = undefined;
    this.currentRealtime = undefined;
  }

  private async summarize(record: ChatRecord): Promise<void> {
    const hint = getSessionTurnRecordHint(
      record,
      this.options.sessionKey.sessionId,
    );
    this.maxPromptTurn = Math.max(this.maxPromptTurn, hint.promptTurn ?? 0);
    if (hint.countsAsUserPrompt) this.userPrompts++;
    if (hint.turnParentUuid !== undefined) this.userTurns++;
    if (hint.backgroundNotificationTaskId)
      await this.catalog
        .map<boolean>('resource-pending')
        .set(hint.backgroundNotificationTaskId, true);
    this.tokenCounts.add(record);
    const goal = normalizeGoalRecoveryRecord(record);
    if (goal) {
      if (parseGoalStateRecordPayloadV2(goal.systemPayload)) {
        this.latestValidGoal = goal;
        this.latestInvalidGoal = undefined;
      } else this.latestInvalidGoal = goal;
    }
    const payload = readFileHistorySnapshotPayload(record);
    if (payload) {
      let snapshots: FileHistorySnapshot[] | undefined;
      try {
        snapshots = deserializeSnapshots(payload.snapshots);
      } catch (error) {
        debugLogger.warn(`Skipping malformed file_history_snapshot: ${error}`);
      }
      if (snapshots) {
        const seen = this.catalog.map<boolean>('hook-once');
        for (const snapshot of snapshots) {
          if (await seen.get(snapshot.promptId)) {
            if (this.fileSnapshots.has(snapshot.promptId))
              this.fileSnapshots.set(snapshot.promptId, snapshot);
          } else {
            await seen.set(snapshot.promptId, true);
            this.retainedFilePrompts.push(snapshot.promptId);
            this.fileSnapshots.set(snapshot.promptId, snapshot);
            if (this.retainedFilePrompts.length > MAX_SNAPSHOTS)
              this.fileSnapshots.delete(this.retainedFilePrompts.shift()!);
          }
        }
      }
    }
    if (record.subtype === 'attribution_snapshot') {
      const snapshot = (
        record.systemPayload as AttributionSnapshotPayload | undefined
      )?.snapshot;
      if (snapshot && typeof snapshot === 'object')
        this.attributionSnapshot = snapshot;
    }
    if (record.type === 'system' && record.subtype === 'session_source')
      this.source = record.systemPayload as SessionSourceRecordPayload;
    if (
      record.type === 'assistant' &&
      typeof record.model === 'string' &&
      record.model.trim()
    )
      this.lastAssistantModel = record.model;
  }

  get residency() {
    return {
      authority: this.authority.residency,
      catalog: this.catalog.cacheUsage,
    };
  }

  get size(): number {
    return this.count;
  }
  get digest(): string {
    return this.physicalDigest;
  }
  get leafUuid(): string {
    return (
      this.authority.commitProof.lastCommitSequence +
      ':' +
      this.authority.commitProof.committedPrefixHash
    );
  }
  get startTime(): string {
    return this.firstRecord.timestamp;
  }
  get lastRecordUuid(): string {
    return (
      this.lastProjectedUuid ??
      this.lastPhysicalRecordUuid ??
      this.firstRecord.uuid
    );
  }
  get initialTurn(): number {
    return this.maxPromptTurn > 0 ? this.maxPromptTurn : this.userPrompts;
  }
  get userTurnCount(): number {
    return this.userTurns;
  }
  get goalRecords(): GoalRecoveryRecord[] {
    return [
      ...(this.latestValidGoal ? [this.latestValidGoal] : []),
      ...(this.latestInvalidGoal ? [this.latestInvalidGoal] : []),
    ];
  }
  get fileHistorySnapshots(): FileHistorySnapshot[] | undefined {
    return this.retainedFilePrompts.length
      ? this.retainedFilePrompts.map((id) => this.fileSnapshots.get(id)!)
      : undefined;
  }
  get executionEngine(): SessionExecutionEngineState {
    return this.engine.finish({
      filePath: this.options.filePath,
      ...this.options.fileIdentity,
      size: this.options.snapshotSize,
      lastUpdated: this.options.lastUpdated,
    });
  }

  entry(position: number): Promise<ManagedTranscriptEntry | undefined> {
    return this.use(() =>
      this.catalog.map<ManagedTranscriptEntry>('resource').get(position),
    );
  }
  position(uuid: string): Promise<number | undefined> {
    return this.use(() => this.catalog.map<number>('event-id').get(uuid));
  }
  turn(ordinal: number): Promise<ManagedTranscriptTurn | undefined> {
    return this.use(() =>
      this.catalog.map<ManagedTranscriptTurn>('action').get(ordinal),
    );
  }
  read(position: number): Promise<ChatRecord> {
    return this.use(async () => {
      const entry = await this.catalog
        .map<ManagedTranscriptEntry>('resource')
        .get(position);
      this.require(entry !== undefined);
      const event = await this.authority
        .iterateEvents(entry.sequence, entry.sequence)
        .at(0);
      this.require(event !== undefined);
      const record = await this.projection.recordAt(event);
      this.require(record !== undefined && record.uuid === entry.uuid);
      return record;
    });
  }
  modelRecords(): Promise<ChatRecord[]> {
    return this.use(() => this.projection.projectModelRecords());
  }
  async *records(from = 0, through = this.count): AsyncGenerator<ChatRecord> {
    for (let position = from; position < through; position++)
      yield await this.read(position);
  }
  hasBackgroundNotification(taskId: string): Promise<boolean> {
    return this.use(
      async () =>
        (await this.catalog.map<boolean>('resource-pending').get(taskId)) ===
        true,
    );
  }

  async replayVisible(
    position: number,
    hideInheritedHistory: boolean,
  ): Promise<boolean> {
    const entry = await this.entry(position);
    return (
      entry !== undefined &&
      position >= (this.sourceBoundary ?? 0) &&
      (!entry.inherited ||
        (!hideInheritedHistory && this.sourceBoundary === undefined))
    );
  }

  async replayGoalRecords(
    hideInheritedHistory: boolean,
  ): Promise<GoalRecoveryRecord[]> {
    let position = this.latestGoalPosition;
    let invalid: GoalRecoveryRecord | undefined;
    while (position !== undefined) {
      const entry = (await this.entry(position))!;
      if (await this.replayVisible(position, hideInheritedHistory)) {
        const record = normalizeGoalRecoveryRecord(await this.read(position));
        if (record && parseGoalStateRecordPayloadV2(record.systemPayload))
          return [record, ...(invalid ? [invalid] : [])];
        invalid ??= record;
      }
      this.require(
        entry.goalBefore === undefined || entry.goalBefore < position,
      );
      position = entry.goalBefore;
    }
    return invalid ? [invalid] : [];
  }

  async replayGoalBefore(
    position: number,
    hideInheritedHistory: boolean,
  ): Promise<GoalStateRecordPayloadV2 | undefined> {
    let goal =
      position === this.size
        ? this.latestGoalPosition
        : (await this.entry(position))?.goalBefore;
    while (goal !== undefined) {
      const entry = await this.entry(goal);
      this.require(entry !== undefined);
      if (
        entry.type === 'system' &&
        (await this.replayVisible(goal, hideInheritedHistory))
      )
        return parseGoalStateRecordPayloadV2(
          (await this.read(goal)).systemPayload,
        );
      this.require(entry.goalBefore === undefined || entry.goalBefore < goal);
      goal = entry.goalBefore;
    }
    return undefined;
  }

  async replaySize(hideInheritedHistory: boolean): Promise<number> {
    const kind = hideInheritedHistory ? 1 : 0;
    const previous = this.replayCounts[kind];
    if (previous !== undefined) return previous;
    let count = 0;
    const positions = this.catalog.map<number>('inbox');
    for (
      let position = this.sourceBoundary ?? 0;
      position < this.count;
      position++
    ) {
      const entry = (await this.entry(position))!;
      if (
        entry.inherited &&
        (hideInheritedHistory || this.sourceBoundary !== undefined)
      )
        continue;
      await this.catalog
        .map<number>('input-state')
        .set(`${kind}:${entry.uuid}`, count);
      await positions.set(`${kind}:${count++}`, position);
    }
    this.replayCounts[kind] = count;
    return count;
  }

  async replayPosition(
    uuid: string,
    hideInheritedHistory: boolean,
  ): Promise<number | undefined> {
    await this.replaySize(hideInheritedHistory);
    return this.catalog
      .map<number>('input-state')
      .get(`${hideInheritedHistory ? 1 : 0}:${uuid}`);
  }

  async visibleNavigationCount(): Promise<number> {
    if (this.visibleTurns !== undefined) return this.visibleTurns;
    let count = 0;
    const positions = this.catalog.map<number>('activation');
    for (let ordinal = 0; ordinal < this.turns; ordinal++) {
      const turn = (await this.turn(ordinal))!;
      if (await this.replayVisible(turn.replayPosition, false))
        await positions.set(count++, ordinal);
    }
    this.visibleTurns = count;
    return count;
  }

  async visibleTurn(
    ordinal: number,
  ): Promise<ManagedTranscriptTurn | undefined> {
    await this.visibleNavigationCount();
    const source = await this.catalog.map<number>('activation').get(ordinal);
    return source === undefined ? undefined : this.turn(source);
  }

  async replayEntry(
    position: number,
    hideInheritedHistory: boolean,
  ): Promise<ManagedTranscriptEntry> {
    await this.replaySize(hideInheritedHistory);
    const source = await this.catalog
      .map<number>('inbox')
      .get(`${hideInheritedHistory ? 1 : 0}:${position}`);
    this.require(source !== undefined);
    return (await this.entry(source))!;
  }

  async *visibleRecords(
    hideInheritedHistory: boolean,
  ): AsyncGenerator<ChatRecord> {
    const count = await this.replaySize(hideInheritedHistory);
    for (let position = 0; position < count; position++)
      yield await this.read(
        (await this.replayEntry(position, hideInheritedHistory)).position,
      );
  }

  async branchPoint(assistantUuid: string): Promise<string | undefined> {
    let position =
      (await this.catalog.map<number>('checkpoint').get(assistantUuid)) ?? 0;
    let result: string | undefined;
    while (position) {
      const record = await this.read(position - 1);
      if (await this.validBranch(position - 1, record)) {
        if (result !== undefined) return undefined;
        result = record.uuid;
      }
      const previous = await this.catalog
        .map<number>('hook-ordinal')
        .get(position - 1);
      this.require(previous !== undefined && previous < position);
      position = previous;
    }
    return result;
  }

  private async validBranch(
    position: number,
    record: ChatRecord,
  ): Promise<boolean> {
    const payload = parseBranchCheckpointPayload(record.systemPayload);
    if (
      !payload ||
      record.type !== 'system' ||
      record.subtype !== 'branch_checkpoint' ||
      position === 0 ||
      record.parentUuid !== (await this.entry(position - 1))?.uuid
    )
      return false;
    const start =
      payload.startExclusiveRecordUuid === null
        ? -1
        : await this.position(payload.startExclusiveRecordUuid);
    if (start === undefined || start >= position - 1) return false;
    const pending = this.catalog.map<PendingBranchCall>('hook-occurrence');
    let callOrdinal = 0;
    let assistant: string | undefined;
    let multipleAssistants = false;
    for (let index = 0; index < position; index++) {
      const current = await this.read(index);
      const parts = isInternalCodeModeToolResult(current)
        ? []
        : (current.message?.parts ?? []);
      const identity = (
        value: BranchToolCallIdentity,
      ): BranchToolCallIdentity => ({
        ...(typeof value.id === 'string' && value.id.length > 0
          ? { id: value.id }
          : {}),
        ...(typeof value.name === 'string' && value.name.length > 0
          ? { name: value.name }
          : {}),
      });
      const calls = parts.flatMap((part) =>
        part?.functionCall ? [identity(part.functionCall)] : [],
      );
      const responses = parts.flatMap((part) =>
        part?.functionResponse ? [identity(part.functionResponse)] : [],
      );
      for (const call of calls)
        await pending.set(callOrdinal++, {
          scope: position,
          position: index,
          active: true,
          ...(call.id ? { id: call.id } : {}),
          ...(call.name ? { name: call.name } : {}),
        });
      for (const response of responses) {
        const matches = async (byId: boolean): Promise<string | undefined> => {
          let candidate: string | undefined;
          let count = 0;
          let fresh: string | undefined;
          let freshCount = 0;
          for await (const [key, call] of pending) {
            if (!call.active || call.scope !== position) continue;
            if (
              byId
                ? call.id !== response.id
                : call.name !== response.name ||
                  (response.id !== undefined && call.id !== undefined)
            )
              continue;
            if (byId) return key;
            candidate = key;
            count++;
            if (call.position > start) {
              fresh = key;
              freshCount++;
            }
          }
          return count === 1 ? candidate : freshCount === 1 ? fresh : undefined;
        };
        const key = response.id
          ? ((await matches(true)) ??
            (response.name ? await matches(false) : undefined))
          : response.name
            ? await matches(false)
            : undefined;
        if (key)
          await pending.set(key, {
            ...(await pending.get(key))!,
            active: false,
          });
        else if (index > start) return false;
      }
      if (index <= start) continue;
      if (
        (current.type === 'tool_result' &&
          !isInternalCodeModeToolResult(current)) ||
        responses.length
      ) {
        assistant = undefined;
        multipleAssistants = false;
      } else if (
        current.type === 'assistant' &&
        calls.length === 0 &&
        isAssistantPreviewCandidate(current)
      ) {
        if (assistant !== undefined) multipleAssistants = true;
        assistant = current.uuid;
      }
    }
    for await (const call of pending.values())
      if (call.scope === position && call.active && call.position > start)
        return false;
    return !multipleAssistants && assistant === payload.assistantRecordUuid;
  }

  async assertUnchanged(): Promise<void> {
    const current = await lstat(this.options.filePath);
    const stats = await this.handle.stat();
    this.require(
      !current.isSymbolicLink() &&
        current.isFile() &&
        current.dev === this.options.fileIdentity.dev &&
        current.ino === this.options.fileIdentity.ino &&
        stats.size >= this.options.snapshotSize,
    );
    if (
      stats.ctimeMs !== this.sourceMetadata.ctimeMs ||
      stats.mtimeMs !== this.sourceMetadata.mtimeMs
    ) {
      const digest = createHash('sha256');
      let position = 0;
      while (position < this.options.snapshotSize) {
        const bytes = Buffer.alloc(
          Math.min(CHUNK_BYTES, this.options.snapshotSize - position),
        );
        const { bytesRead } = await this.handle.read(
          bytes,
          0,
          bytes.length,
          position,
        );
        this.require(bytesRead > 0);
        position += bytesRead;
        digest.update(bytes.subarray(0, bytesRead));
      }
      this.require(digest.digest('hex') === this.physicalDigest);
    }
  }

  private use<T>(read: () => Promise<T>): Promise<T> {
    this.require(!this.closing);
    const result = read();
    this.activeReads.add(result);
    result.then(
      () => this.activeReads.delete(result),
      () => this.activeReads.delete(result),
    );
    return result;
  }
  close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.closing = true;
      await Promise.allSettled([...this.activeReads]);
      await Promise.allSettled([
        this.authority?.close(),
        this.catalog?.close(),
        this.handle.close(),
      ]);
    })();
    return this.closePromise;
  }
  private require(condition: unknown): asserts condition {
    if (!condition)
      throw new ManagedSessionRecordError(
        'Managed transcript snapshot is unavailable or corrupt.',
      );
  }
}
