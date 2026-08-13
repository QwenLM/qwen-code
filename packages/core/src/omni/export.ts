/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import { createDebugLogger } from '../utils/debugLogger.js';
import { MediaMemoryStore } from '../services/media-memory/store.js';
import type { MediaMemorySnapshot } from '../services/media-memory/types.js';
import {
  OMNI_DISCLOSURE_TEXT_PREFIX,
  OMNI_OMISSION_TEXT_PREFIX,
  OMNI_TRANSCRIPT_TEXT_PREFIX,
  OMNI_RESOURCE_HANDLE_TEXT_PREFIX,
  parseResourceHandleText,
} from './disclosure.js';

const debugLogger = createDebugLogger('omni:export');

/**
 * Trajectory export (S6, issue #8190 / formerly #8196): one experiment
 * session as training-consumable JSONL.
 *
 * The exporter is a pure READER over two artifacts that already exist —
 * the session's chat-record JSONL and the project's `memory.json` — so it
 * adds no collection points, cannot affect runtime behavior, and works on
 * sessions recorded before it was written.
 *
 * ## Record kinds (the `kind` field of every line)
 *
 * - `turn` — one user request → model response cycle from the transcript:
 *   the request text (system reminders stripped, an injected passive
 *   recall extracted into `recall`), the media annotations the model saw
 *   (handles, disclosures, omissions, transcripts), the assistant text
 *   and its tool calls.
 * - `execution` — one policy execution from memory, with full provenance
 *   (arguments, config hash, source/output identities, reuse marker).
 * - `file` — one file version from memory: the durable identity
 *   (`fileVersionId`, `sha256`), modality, origin, and a source locator
 *   REDUCED to its safe form (URLs and managed keys verbatim; local
 *   locators are already basenames by construction — M §5.2's no-path
 *   discipline is enforced at collection time, not here).
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
    /** Parsed 【媒体记忆】 sideQuery injection, verbatim JSON when present. */
    recall?: unknown;
  };
  response: {
    text: string;
    toolCalls: Array<{
      callId?: string;
      name: string;
      /** Arguments minus reserved runtime keys (inputPath/outputDir) —
       * the same exclusion memory applies to `finalArguments`. */
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
  message?: { parts?: unknown[] };
  toolCallResult?: unknown;
}

const RECALL_REMINDER_MARKER = '【媒体记忆】';

function textOfPart(part: unknown): string | undefined {
  if (typeof part === 'string') return part;
  if (typeof part === 'object' && part !== null && 'text' in part) {
    const text = (part as { text?: unknown }).text;
    return typeof text === 'string' ? text : undefined;
  }
  return undefined;
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
  const cleanArgs =
    typeof args === 'object' && args !== null
      ? { ...(args as Record<string, unknown>) }
      : undefined;
  if (cleanArgs) {
    // Reserved runtime keys are per-invocation plumbing and may carry
    // absolute paths — the same exclusion memory's finalArguments applies.
    delete cleanArgs['inputPath'];
    delete cleanArgs['outputDir'];
  }
  return {
    ...(typeof id === 'string' ? { callId: id } : {}),
    name,
    ...(cleanArgs ? { args: cleanArgs } : {}),
  };
}

/** Split an annotation line `【…】name：payload` into its parts. */
function splitAnnotation(
  text: string,
  prefix: string,
): { name: string; payload: string } | undefined {
  if (!text.startsWith(prefix)) return undefined;
  const rest = text.slice(prefix.length);
  const sep = rest.indexOf('：');
  if (sep < 0) return undefined;
  return { name: rest.slice(0, sep), payload: rest.slice(sep + 1) };
}

/** Extract the recall reminder's JSON body, if this text part is one. */
function parseRecallReminder(text: string): unknown | undefined {
  if (!text.includes(RECALL_REMINDER_MARKER)) return undefined;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
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

/** Consume one user-part text line into the accumulating turn. Returns
 * true when the line was a media/recall annotation (not request prose). */
function consumeAnnotationLine(turn: TurnAccumulator, line: string): boolean {
  const handle = splitAnnotation(line, OMNI_RESOURCE_HANDLE_TEXT_PREFIX);
  if (handle) {
    const resourceId = parseResourceHandleText(line);
    const media = mediaFor(turn, handle.name);
    if (resourceId) media.resourceId = resourceId;
    return true;
  }
  const disclosure = splitAnnotation(line, OMNI_DISCLOSURE_TEXT_PREFIX);
  if (disclosure) {
    mediaFor(turn, disclosure.name).disclosures.push(disclosure.payload);
    return true;
  }
  const omission = splitAnnotation(line, OMNI_OMISSION_TEXT_PREFIX);
  if (omission) {
    mediaFor(turn, omission.name).omitted = omission.payload;
    return true;
  }
  const transcript = splitAnnotation(line, OMNI_TRANSCRIPT_TEXT_PREFIX);
  if (transcript) {
    mediaFor(turn, transcript.name).transcripts.push(transcript.payload);
    return true;
  }
  return false;
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

function buildTurnRecords(
  transcriptLines: TranscriptRecordView[],
): OmniTrajectoryTurnRecord[] {
  const turns: OmniTrajectoryTurnRecord[] = [];
  let sessionId = '';
  let current: TurnAccumulator | undefined;

  for (const record of transcriptLines) {
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
      for (const part of record.message?.parts ?? []) {
        const text = textOfPart(part);
        if (text === undefined) continue;
        // A recall reminder may share its part with the user's own text
        // (client.ts prepends reminders INTO the request parts) — extract
        // the payload, then keep processing what remains of the part.
        const recall = parseRecallReminder(text);
        if (recall !== undefined) current.recall = recall;
        const prose: string[] = [];
        for (const line of text.split('\n')) {
          if (!consumeAnnotationLine(current, line.trim())) prose.push(line);
        }
        const stripped = stripSystemReminders(prose.join('\n'));
        if (stripped) current.requestTexts.push(stripped);
      }
      continue;
    }
    if (!current) continue;
    if (record.type === 'assistant') {
      for (const part of record.message?.parts ?? []) {
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

function buildMemoryRecords(snapshot: MediaMemorySnapshot): MemoryRecords {
  const files: OmniTrajectoryFileRecord[] = [];
  const executions: OmniTrajectoryExecutionRecord[] = [];
  for (const version of Object.values(snapshot.versions)) {
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
  }
  for (const execution of Object.values(snapshot.executions)) {
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
  }
  return { files, executions };
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
  const records: OmniTrajectoryRecord[] = buildTurnRecords(transcriptLines);

  const store = new MediaMemoryStore(options.omniRootDir);
  const empty: MemoryRecords = { files: [], executions: [] };
  const memoryRecords = await store
    .read<MemoryRecords>(empty, (snapshot) => buildMemoryRecords(snapshot))
    .catch((err) => {
      debugLogger.debug(
        `trajectory export: memory unreadable, exporting transcript only: ` +
          `${err instanceof Error ? err.message : err}`,
      );
      return empty;
    });
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
  const records = await exportOmniTrajectory(options);
  await fs.writeFile(options.outPath, serializeOmniTrajectory(records), 'utf8');
  return { records: records.length };
}
