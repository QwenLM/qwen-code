/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createDebugLogger } from '../utils/debugLogger.js';
import type { MediaMemorySnapshot } from '../services/media-memory/types.js';
import {
  OMNI_DISCLOSURE_TEXT_PREFIX,
  OMNI_OMISSION_TEXT_PREFIX,
  OMNI_TRANSCRIPT_TEXT_PREFIX,
  OMNI_RESOURCE_HANDLE_TEXT_PREFIX,
  parseResourceHandleText,
  parseResourcePathText,
  splitAnnotationBody,
  unescapeAnnotationName,
} from './disclosure.js';

const debugLogger = createDebugLogger('omni:export');

/**
 * Trajectory export (S6, issue #8190 / formerly #8196): one experiment
 * session as training-consumable JSONL.
 *
 * The exporter is a pure READER over two artifacts that already exist —
 * the session's chat-record JSONL and the project's `memory.json` — so it
 * adds no collection points and cannot affect runtime behavior. The
 * memory ledger is read RAW (no store-side corruption self-heal: an
 * export must never rename the live document); an unreadable ledger
 * degrades the export to transcript-only records.
 *
 * ## Record kinds (the `kind` field of every line)
 *
 * - `turn` — one user request → model response cycle from the transcript:
 *   the request text (system reminders stripped), the media annotations
 *   the model saw (handles, disclosures, omissions, transcripts —
 *   harvested from user AND tool_result records), the recall payload the
 *   sideQuery injected (recorded by the runtime since this exporter
 *   shipped; older transcripts simply have no `recall`), the assistant's
 *   VISIBLE text (thought parts are excluded) and its tool calls with
 *   arguments preserved verbatim.
 * - `execution` — one policy execution from memory, with full provenance
 *   (arguments, config hash, source/output identities, reuse marker).
 * - `file` — one file version from memory: the durable identity
 *   (`fileVersionId`, `sha256`), modality, origin, and a source locator
 *   REDUCED to its safe form (URLs and managed keys verbatim; local
 *   locators are already basenames by construction — M §5.2's no-path
 *   discipline is enforced at collection time, not here).
 *
 * ## Session scope
 *
 * `memory.json` is project-wide; a single-session export includes only
 * the records reachable from THIS session's transcript: executions whose
 * `invocationId` matches a turn's tool callId, files whose display
 * locator matches a media annotation, and everything reachable from
 * those through the identity graph (source versions, produced
 * derivatives, and the executions between them) — computed as a closure,
 * so fixed-policy chains (extract-audio → transcribe) stay complete.
 *
 * ## Branches
 *
 * Chat records form a `parentUuid` chain and `/rewind` re-roots it,
 * leaving abandoned records in the append-only file. The exporter
 * replays only the ACTIVE chain (walked back from the final record) —
 * a rewound branch must not export as a genuine turn. Records without
 * uuids (hand-built fixtures, foreign transcripts) fall back to append
 * order.
 *
 * ## The join contract (deliberately explicit, not implicit)
 *
 * Model/client-origin executions join `turn.response.toolCalls[].callId`
 * ↔ `execution.invocationId` — both sides record the scheduler's callId.
 * Fixed-policy executions have no transcript-side call (they run inside
 * delivery); they join through identities instead:
 * `execution.sourceVersionId` → `file.fileVersionId`, and a turn's media
 * name matches `file.sourceLocator`'s display form. The exporter does NOT
 * fabricate a turn↔fixed-policy edge from timestamps — a wrong edge in
 * training data is worse than an explicit join key.
 *
 * Media bytes are never embedded; `sha256` is the pointer (fetch from
 * `objects/` while retention lasts). Every `execution` line carries
 * `omniConfigHash` so downstream can split trajectories by processing
 * configuration instead of mixing distributions.
 *
 * ## What is and is not scrubbed
 *
 * Transcript-side content is preserved VERBATIM — the recorded assistant
 * turn predates the gate's runtime-key injection, so its tool-call
 * arguments are exactly what the model emitted (including an `inputPath`
 * the model legitimately passed to an omni tool); scrubbing them would
 * corrupt the training signal. The memory side excludes the reserved
 * runtime keys (`inputPath`/`outputDir`/`resourceId`) from
 * `finalArguments` at collection time — before this exporter ever runs.
 * Callers publishing exports off the machine own user/model-authored
 * absolute paths (they ARE the trajectory).
 *
 * ## Known limitation
 *
 * Non-text request parts (pasted images, inline blobs) contribute no
 * annotation and are not represented in `turn.request` beyond any omni
 * annotations delivered beside them.
 */

// ─── Line shapes ──────────────────────────────────────────────────────────

export interface OmniTrajectoryMediaAnnotation {
  /** Display name from the annotation (basename or URL base). */
  name: string;
  /** Session handle, when a 【媒体资源】 annotation was present. */
  resourceId?: string;
  disclosures: string[];
  /** Omission notice text, when the transport guard withheld the bytes. */
  omitted?: string;
  /** Transcript-protocol text delivered in place of (or beside) media. */
  transcripts: string[];
}

export interface OmniTrajectoryTurnRecord {
  kind: 'turn';
  sessionId: string;
  /** 0-based index over the session's user requests. */
  turnIndex: number;
  timestamp?: string;
  request: {
    text: string;
    media: OmniTrajectoryMediaAnnotation[];
    /** The sideQuery recall payload the runtime injected (recorded as a
     * system record at injection time), verbatim JSON when present. */
    recall?: unknown;
  };
  response: {
    text: string;
    toolCalls: Array<{
      callId?: string;
      name: string;
      /** Arguments exactly as the model emitted them. */
      args?: Record<string, unknown>;
    }>;
  };
}

export interface OmniTrajectoryExecutionRecord {
  kind: 'execution';
  executionId: string;
  /** Scheduler callId for model/client calls (the turn-side join key);
   * a random invocation id for fixed-policy runs. */
  invocationId: string;
  executionOrigin: unknown;
  toolName: string;
  toolVersion?: string;
  finalArguments: Record<string, unknown>;
  omniConfigHash: string;
  sourceVersionId: string;
  rootFileId: string;
  startedAt: string;
  completedAt: string;
  /** Present when this execution reused another's outputs (M §11.3). */
  reusedExecutionId?: string;
  outputs: Array<{
    kind: string;
    role?: string;
    sha256?: string;
    mimeType?: string;
    sizeBytes?: number;
    disclosure?: string;
  }>;
}

export interface OmniTrajectoryFileRecord {
  kind: 'file';
  fileId: string;
  fileVersionId: string;
  rootFileId: string;
  sha256: string;
  mediaType: string;
  origin: string;
  sizeBytes: number;
  mimeType: string;
  source: { protocol: string; locator: string };
  producedByExecutionId?: string;
  parentVersionId?: string;
  createdAt: string;
}

export type OmniTrajectoryRecord =
  | OmniTrajectoryTurnRecord
  | OmniTrajectoryExecutionRecord
  | OmniTrajectoryFileRecord;

// ─── Transcript side ──────────────────────────────────────────────────────

/** Minimal structural view of one chat record (the exporter must not
 * import the CLI's ChatRecord type — core cannot depend on cli). */
interface TranscriptRecordView {
  sessionId?: string;
  type?: string;
  subtype?: string;
  timestamp?: string;
  uuid?: string;
  parentUuid?: string | null;
  message?: { parts?: unknown[] };
  systemPayload?: unknown;
}

function textOfPart(part: unknown): string | undefined {
  if (typeof part === 'string') return part;
  if (typeof part === 'object' && part !== null && 'text' in part) {
    const text = (part as { text?: unknown }).text;
    return typeof text === 'string' ? text : undefined;
  }
  return undefined;
}

function isThoughtPart(part: unknown): boolean {
  return (
    typeof part === 'object' &&
    part !== null &&
    (part as { thought?: unknown }).thought === true
  );
}

function functionCallOfPart(
  part: unknown,
):
  | { callId?: string; name: string; args?: Record<string, unknown> }
  | undefined {
  if (typeof part !== 'object' || part === null) return undefined;
  const fc = (part as { functionCall?: unknown }).functionCall;
  if (typeof fc !== 'object' || fc === null) return undefined;
  const { id, name, args } = fc as {
    id?: unknown;
    name?: unknown;
    args?: unknown;
  };
  if (typeof name !== 'string') return undefined;
  // Arguments are preserved verbatim: the assistant turn is recorded
  // BEFORE the gate injects runtime keys, so whatever is here is what
  // the model itself emitted — scrubbing it would delete a legitimate
  // model-authored `inputPath` and corrupt the call record.
  const cleanArgs =
    typeof args === 'object' && args !== null
      ? { ...(args as Record<string, unknown>) }
      : undefined;
  return {
    ...(typeof id === 'string' ? { callId: id } : {}),
    name,
    ...(cleanArgs ? { args: cleanArgs } : {}),
  };
}

function stripSystemReminders(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .trim();
}

interface TurnAccumulator {
  turnIndex: number;
  timestamp?: string;
  requestTexts: string[];
  media: Map<string, OmniTrajectoryMediaAnnotation>;
  recall?: unknown;
  responseTexts: string[];
  toolCalls: OmniTrajectoryTurnRecord['response']['toolCalls'];
}

function mediaFor(
  turn: TurnAccumulator,
  name: string,
): OmniTrajectoryMediaAnnotation {
  let media = turn.media.get(name);
  if (!media) {
    media = { name, disclosures: [], transcripts: [] };
    turn.media.set(name, media);
  }
  return media;
}

/**
 * Consume one text PART as a media annotation if it is one. Writers emit
 * each annotation as a standalone part (`formatDisclosureText` and
 * friends produce the whole part text), so matching at part granularity
 * keeps multi-line payloads intact and never harvests look-alike lines
 * out of surrounding prose. Returns true when the part was an
 * annotation.
 */
function consumeAnnotationPart(turn: TurnAccumulator, text: string): boolean {
  if (text.startsWith(OMNI_RESOURCE_HANDLE_TEXT_PREFIX)) {
    const resourceId = parseResourceHandleText(text);
    if (resourceId) {
      // Handle form. Name = body minus the end-anchored `：<resourceId>`
      // (the id grammar is harness-minted, so this parse never guesses at
      // the name).
      const body = text.slice(OMNI_RESOURCE_HANDLE_TEXT_PREFIX.length);
      const name = unescapeAnnotationName(
        body.slice(0, body.length - resourceId.length - 1),
      );
      mediaFor(turn, name).resourceId = resourceId;
      return true;
    }
    // Path form (model-visible local media): the annotation shows the
    // file's ABSOLUTE PATH and carries no session handle. The exporter is a
    // pure reader with no live registry (bindings never persist), so it
    // cannot recover a resourceId — but the media entry must still exist,
    // or the turn drops its media and the session filter never seeds the
    // file's memory closure. Key the entry by the path's BASENAME: the
    // file-record join is on the local source locator, and local sources
    // record `locator: displayName` (index.ts) with displayName defaulting
    // to the basename.
    const filePath = parseResourcePathText(text);
    if (filePath) {
      mediaFor(turn, path.basename(filePath));
      return true;
    }
    return false;
  }
  for (const [prefix, apply] of [
    [
      OMNI_DISCLOSURE_TEXT_PREFIX,
      (m: OmniTrajectoryMediaAnnotation, payload: string) => {
        m.disclosures.push(payload);
      },
    ],
    [
      OMNI_OMISSION_TEXT_PREFIX,
      (m: OmniTrajectoryMediaAnnotation, payload: string) => {
        m.omitted = payload;
      },
    ],
    [
      OMNI_TRANSCRIPT_TEXT_PREFIX,
      (m: OmniTrajectoryMediaAnnotation, payload: string) => {
        m.transcripts.push(payload);
      },
    ],
  ] as const) {
    if (!text.startsWith(prefix)) continue;
    const split = splitAnnotationBody(text.slice(prefix.length));
    if (!split) return false;
    apply(mediaFor(turn, split.name), split.payload);
    return true;
  }
  return false;
}

/** Harvest media annotations (and request prose, when `collectProse`)
 * from a record's text parts into the accumulating turn. */
function consumeRecordParts(
  turn: TurnAccumulator,
  record: TranscriptRecordView,
  collectProse: boolean,
): void {
  for (const part of record.message?.parts ?? []) {
    const raw = textOfPart(part);
    if (raw === undefined) continue;
    // Reminders are harness plumbing, never annotation carriers — strip
    // them BEFORE annotation matching so a reminder quoting an
    // annotation line cannot be harvested as one.
    const text = stripSystemReminders(raw);
    if (!text) continue;
    if (consumeAnnotationPart(turn, text)) continue;
    if (collectProse) turn.requestTexts.push(text);
  }
}

function finishTurn(
  turn: TurnAccumulator,
  sessionId: string,
): OmniTrajectoryTurnRecord {
  return {
    kind: 'turn',
    sessionId,
    turnIndex: turn.turnIndex,
    ...(turn.timestamp !== undefined ? { timestamp: turn.timestamp } : {}),
    request: {
      text: turn.requestTexts.join('\n'),
      media: [...turn.media.values()],
      ...(turn.recall !== undefined ? { recall: turn.recall } : {}),
    },
    response: {
      text: turn.responseTexts.join('\n'),
      toolCalls: turn.toolCalls,
    },
  };
}

/**
 * Reduce the append-only record list to the ACTIVE parentUuid chain.
 * `/rewind` re-roots the chain and leaves the abandoned records in the
 * file — replaying them would export phantom turns. Records without
 * uuids (fixtures, foreign transcripts) fall back to the full list.
 */
function activeChainRecords(
  records: TranscriptRecordView[],
): TranscriptRecordView[] {
  const byUuid = new Map<string, TranscriptRecordView>();
  for (const record of records) {
    if (typeof record.uuid === 'string') byUuid.set(record.uuid, record);
  }
  if (byUuid.size === 0) return records;
  let leaf: TranscriptRecordView | undefined;
  for (let i = records.length - 1; i >= 0; i--) {
    if (typeof records[i].uuid === 'string') {
      leaf = records[i];
      break;
    }
  }
  if (!leaf) return records;
  const active = new Set<string>();
  let current: TranscriptRecordView | undefined = leaf;
  while (current?.uuid && !active.has(current.uuid)) {
    active.add(current.uuid);
    current =
      typeof current.parentUuid === 'string'
        ? byUuid.get(current.parentUuid)
        : undefined;
  }
  // Preserve file order; keep uuid-less records (defensive: they cannot
  // be on a dead branch that rewind knows about).
  return records.filter(
    (r) => typeof r.uuid !== 'string' || active.has(r.uuid),
  );
}

function buildTurnRecords(
  transcriptLines: TranscriptRecordView[],
): OmniTrajectoryTurnRecord[] {
  const turns: OmniTrajectoryTurnRecord[] = [];
  let sessionId = '';
  let current: TurnAccumulator | undefined;

  for (const record of activeChainRecords(transcriptLines)) {
    if (typeof record.sessionId === 'string' && sessionId === '') {
      sessionId = record.sessionId;
    }
    if (record.type === 'user' && record.subtype === undefined) {
      if (current) turns.push(finishTurn(current, sessionId));
      current = {
        turnIndex: turns.length,
        ...(record.timestamp !== undefined
          ? { timestamp: record.timestamp }
          : {}),
        requestTexts: [],
        media: new Map(),
        responseTexts: [],
        toolCalls: [],
      };
      consumeRecordParts(current, record, true);
      continue;
    }
    if (!current) continue;
    if (record.type === 'system' && record.subtype === 'omni_recall') {
      current.recall = record.systemPayload;
      continue;
    }
    if (record.type === 'tool_result') {
      // Tool-delivered media carries its annotations in the tool_result
      // record's parts — harvest them; tool output prose is NOT request
      // text.
      consumeRecordParts(current, record, false);
      continue;
    }
    if (record.type === 'assistant') {
      for (const part of record.message?.parts ?? []) {
        // Thought parts are internal chain-of-thought the user never saw
        // — exporting them as "the response" would mislabel the training
        // signal.
        if (isThoughtPart(part)) continue;
        const text = textOfPart(part);
        if (text !== undefined && text.trim()) {
          current.responseTexts.push(text);
          continue;
        }
        const call = functionCallOfPart(part);
        if (call) current.toolCalls.push(call);
      }
    }
  }
  if (current) turns.push(finishTurn(current, sessionId));
  return turns;
}

// ─── Memory side ──────────────────────────────────────────────────────────

interface MemoryRecords {
  files: OmniTrajectoryFileRecord[];
  executions: OmniTrajectoryExecutionRecord[];
}

/**
 * Read the memory ledger WITHOUT the store's corruption self-heal. The
 * store backs a corrupt document up (renaming the live file) and
 * continues on empty — correct for recall, but an EXPORT must never
 * mutate the thing it reads (and the backup would silently block the GC
 * for a whole retention window). Any failure degrades to transcript-only
 * output.
 */
async function readSnapshotRaw(
  omniRootDir: string,
): Promise<MediaMemorySnapshot | undefined> {
  const filePath = path.join(omniRootDir, 'memory.json');
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return undefined; // Missing ledger: a media-less project is normal.
  }
  try {
    const parsed = JSON.parse(raw) as MediaMemorySnapshot;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      [parsed.files, parsed.versions, parsed.executions, parsed.entries].some(
        (c) => typeof c !== 'object' || c === null || Array.isArray(c),
      )
    ) {
      throw new Error('unexpected snapshot shape');
    }
    return parsed;
  } catch (err) {
    debugLogger.debug(
      `trajectory export: memory unreadable, exporting transcript only: ` +
        `${err instanceof Error ? err.message : err}`,
    );
    return undefined;
  }
}

function buildMemoryRecords(snapshot: MediaMemorySnapshot): MemoryRecords {
  const files: OmniTrajectoryFileRecord[] = [];
  const executions: OmniTrajectoryExecutionRecord[] = [];
  for (const version of Object.values(snapshot.versions)) {
    try {
      const file = snapshot.files[version.fileId];
      if (!file) continue;
      files.push({
        kind: 'file',
        fileId: version.fileId,
        fileVersionId: version.fileVersionId,
        rootFileId: file.rootFileId,
        sha256: version.sha256,
        mediaType: version.mediaType,
        origin: file.origin,
        sizeBytes: version.sizeBytes,
        mimeType: version.mimeType,
        source: version.source,
        ...(version.producedByExecutionId !== undefined
          ? { producedByExecutionId: version.producedByExecutionId }
          : {}),
        ...(version.parentVersionId !== undefined
          ? { parentVersionId: version.parentVersionId }
          : {}),
        createdAt: version.createdAt,
      });
    } catch {
      // One malformed record loses that record, not the export.
    }
  }
  for (const execution of Object.values(snapshot.executions)) {
    try {
      const outputs = execution.outputRefs.flatMap((entryId) => {
        const entry = snapshot.entries[entryId];
        if (!entry) return [];
        return [
          {
            kind: entry.kind,
            ...(entry.role !== undefined ? { role: entry.role } : {}),
            ...(entry.artifactRef?.managedId?.startsWith('sha256/')
              ? { sha256: entry.artifactRef.managedId.slice('sha256/'.length) }
              : {}),
            ...(entry.artifactRef?.mimeType !== undefined
              ? { mimeType: entry.artifactRef.mimeType }
              : {}),
            ...(entry.artifactRef?.sizeBytes !== undefined
              ? { sizeBytes: entry.artifactRef.sizeBytes }
              : {}),
            ...(entry.disclosure !== undefined
              ? { disclosure: entry.disclosure }
              : {}),
          },
        ];
      });
      executions.push({
        kind: 'execution',
        executionId: execution.executionId,
        invocationId: execution.invocationId,
        executionOrigin: execution.executionOrigin,
        toolName: execution.toolName,
        ...(execution.toolVersion !== undefined
          ? { toolVersion: execution.toolVersion }
          : {}),
        finalArguments: execution.finalArguments,
        omniConfigHash: execution.omniConfigHash,
        sourceVersionId: execution.sourceVersionId,
        rootFileId: execution.rootFileId,
        startedAt: execution.startedAt,
        completedAt: execution.completedAt,
        ...(execution.reusedExecutionId !== undefined
          ? { reusedExecutionId: execution.reusedExecutionId }
          : {}),
        outputs,
      });
    } catch {
      // Same stance: skip the malformed execution.
    }
  }
  return { files, executions };
}

/**
 * Reduce project-wide memory records to the ones reachable from this
 * session's transcript. Seeds: executions joined by callId, files whose
 * display locator matches a media annotation name. Closure: an included
 * execution pulls in its source version's file and every file it
 * produced; an included file pulls in the executions that read it and
 * the executions that produced its versions. Fixed-policy chains
 * (extract-audio → transcribe) stay complete without timestamp guessing.
 */
function filterToSession(
  memory: MemoryRecords,
  turns: OmniTrajectoryTurnRecord[],
): MemoryRecords {
  const callIds = new Set<string>();
  const mediaNames = new Set<string>();
  for (const turn of turns) {
    for (const call of turn.response.toolCalls) {
      if (call.callId) callIds.add(call.callId);
    }
    for (const media of turn.request.media) mediaNames.add(media.name);
  }

  const filesByVersion = new Map(memory.files.map((f) => [f.fileVersionId, f]));
  const versionsByFile = new Map<string, OmniTrajectoryFileRecord[]>();
  for (const f of memory.files) {
    const list = versionsByFile.get(f.fileId) ?? [];
    list.push(f);
    versionsByFile.set(f.fileId, list);
  }

  const includedFiles = new Set<string>(); // fileId
  const includedExecutions = new Set<string>(); // executionId

  const includeFile = (fileId: string | undefined): boolean => {
    if (!fileId || includedFiles.has(fileId)) return false;
    if (!versionsByFile.has(fileId)) return false;
    includedFiles.add(fileId);
    return true;
  };

  // Seeds.
  for (const f of memory.files) {
    if (mediaNames.has(f.source.locator)) includeFile(f.fileId);
  }
  for (const e of memory.executions) {
    if (callIds.has(e.invocationId)) includedExecutions.add(e.executionId);
  }

  // Closure to a fixed point.
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of memory.executions) {
      const sourceFile = filesByVersion.get(e.sourceVersionId)?.fileId;
      if (!includedExecutions.has(e.executionId)) {
        // An execution joins when it read an included file.
        if (sourceFile && includedFiles.has(sourceFile)) {
          includedExecutions.add(e.executionId);
          changed = true;
        } else {
          continue;
        }
      }
      // An included execution pulls in its source file…
      if (includeFile(sourceFile)) changed = true;
    }
    for (const f of memory.files) {
      if (includedFiles.has(f.fileId)) continue;
      // …and every file one of its versions produced.
      if (
        f.producedByExecutionId !== undefined &&
        includedExecutions.has(f.producedByExecutionId)
      ) {
        includeFile(f.fileId);
        changed = true;
      }
    }
  }

  return {
    files: memory.files.filter((f) => includedFiles.has(f.fileId)),
    executions: memory.executions.filter((e) =>
      includedExecutions.has(e.executionId),
    ),
  };
}

// ─── Entry points ─────────────────────────────────────────────────────────

export interface ExportOmniTrajectoryOptions {
  /** `.qwen/omni` root holding memory.json. */
  omniRootDir: string;
  /** Path to the session's chat-record JSONL. */
  transcriptPath: string;
}

/**
 * Build the trajectory records for one session. Turn records come first
 * (transcript order), then file records, then execution records — a
 * deterministic order so re-exports are byte-identical.
 *
 * An unreadable memory store degrades to transcript-only output with a
 * debug note (the transcript half is still valid training signal); an
 * unreadable transcript is an error — there is no trajectory without it.
 */
export async function exportOmniTrajectory(
  options: ExportOmniTrajectoryOptions,
): Promise<OmniTrajectoryRecord[]> {
  const raw = await fs.readFile(options.transcriptPath, 'utf8');
  const transcriptLines: TranscriptRecordView[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      transcriptLines.push(JSON.parse(line) as TranscriptRecordView);
    } catch {
      // One corrupt transcript line loses that line, not the export.
    }
  }
  const turns = buildTurnRecords(transcriptLines);
  const records: OmniTrajectoryRecord[] = [...turns];

  const snapshot = await readSnapshotRaw(options.omniRootDir);
  const memoryRecords = snapshot
    ? filterToSession(buildMemoryRecords(snapshot), turns)
    : { files: [], executions: [] };
  // files before executions, each sorted by id — deterministic re-export.
  records.push(
    ...memoryRecords.files.sort((a, b) =>
      a.fileVersionId.localeCompare(b.fileVersionId),
    ),
    ...memoryRecords.executions.sort((a, b) =>
      a.executionId.localeCompare(b.executionId),
    ),
  );
  return records;
}

/** Serialize to JSONL (one record per line, trailing newline). */
export function serializeOmniTrajectory(
  records: OmniTrajectoryRecord[],
): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

/** Convenience wrapper: export and write to a file. */
export async function writeOmniTrajectoryJsonl(
  options: ExportOmniTrajectoryOptions & { outPath: string },
): Promise<{ records: number }> {
  const outPath = path.resolve(options.outPath);
  if (outPath === path.resolve(options.transcriptPath)) {
    // Writing the trajectory over the raw transcript would irreversibly
    // destroy the non-reconstructible source this pipeline exists to
    // capture.
    throw new Error('trajectory outPath must differ from the transcript path');
  }
  const records = await exportOmniTrajectory(options);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, serializeOmniTrajectory(records), 'utf8');
  return { records: records.length };
}
