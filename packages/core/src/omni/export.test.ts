/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MediaMemoryService } from '../services/media-memory/index.js';
import {
  formatDisclosureText,
  formatOmissionText,
  formatResourceHandleText,
  formatResourcePathText,
  formatTranscriptText,
} from './disclosure.js';
import {
  exportOmniTrajectory,
  serializeOmniTrajectory,
  writeOmniTrajectoryJsonl,
  type OmniTrajectoryExecutionRecord,
  type OmniTrajectoryFileRecord,
  type OmniTrajectoryTurnRecord,
} from './export.js';

describe('exportOmniTrajectory', () => {
  let tmpDir: string;
  let omniRootDir: string;
  let transcriptPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-export-'));
    omniRootDir = path.join(tmpDir, 'omni');
    await fs.mkdir(omniRootDir, { recursive: true });
    transcriptPath = path.join(tmpDir, 'session.jsonl');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function transcriptLine(record: Record<string, unknown>): string {
    return JSON.stringify({ sessionId: 's-1', ...record });
  }

  async function writeTranscript(lines: string[]): Promise<void> {
    await fs.writeFile(transcriptPath, lines.join('\n') + '\n', 'utf8');
  }

  /** Seed memory with one user file and one policy execution over it. */
  async function seedMemory(): Promise<void> {
    const memory = new MediaMemoryService(omniRootDir);
    const source = (await memory.recordFileRecognized({
      fileRef: '/movies/film.mkv',
      sha256: 'a'.repeat(64),
      mediaType: 'video',
      metadata: { durationMs: 5000 },
      sizeBytes: 100,
      mimeType: 'video/x-matroska',
      origin: 'user',
      source: { protocol: 'local', locator: 'film.mkv' },
      recognition: {
        ingestionConfigHash: '',
        detectorVersion: 'omni-sniff-ffprobe/1',
        probeStatus: 'complete',
      },
    }))!;
    await memory.commitPolicySucceeded({
      invocationId: 'call-42',
      source,
      executionOrigin: { kind: 'model' },
      toolName: 'omni_extract_keyframes',
      finalArguments: { count: 8 },
      omniConfigHash: 'fp-' + '1'.repeat(61),
      startedAt: '2026-08-13T00:00:00.000Z',
      completedAt: '2026-08-13T00:00:09.000Z',
      outputs: [
        {
          kind: 'media',
          objectPath: path.join(
            omniRootDir,
            'objects',
            'sha256',
            'bb',
            `${'b'.repeat(64)}.jpg`,
          ),
          sha256: 'b'.repeat(64),
          mediaType: 'image',
          metadata: { width: 1280, height: 694 },
          sizeBytes: 5,
          mimeType: 'image/jpeg',
          role: 'keyframe',
          disclosure: 'sampled 8 frames',
        },
      ],
    });
  }

  /** Seed a second, UNRELATED file — a session filter must not export it. */
  async function seedUnrelatedMemory(): Promise<void> {
    const memory = new MediaMemoryService(omniRootDir);
    await memory.recordFileRecognized({
      fileRef: '/other/unrelated.png',
      sha256: 'c'.repeat(64),
      mediaType: 'image',
      metadata: { width: 8, height: 8 },
      sizeBytes: 10,
      mimeType: 'image/png',
      origin: 'user',
      source: { protocol: 'local', locator: 'unrelated.png' },
      recognition: {
        ingestionConfigHash: '',
        detectorVersion: 'omni-sniff-ffprobe/1',
        probeStatus: 'complete',
      },
    });
  }

  it('assembles turns with media annotations and joins by identity keys', async () => {
    await seedMemory();
    await writeTranscript([
      transcriptLine({
        type: 'user',
        timestamp: '2026-08-13T00:00:00.000Z',
        message: {
          parts: [
            { text: '分析这部电影 @film.mkv' },
            { text: formatResourceHandleText('film.mkv', 'media-1-ab') },
            { text: formatDisclosureText('film.mkv', '原 1080p → 480p') },
          ],
        },
      }),
      transcriptLine({
        type: 'assistant',
        message: {
          parts: [
            { text: '我先抽取关键帧。' },
            {
              functionCall: {
                id: 'call-42',
                name: 'omni_extract_keyframes',
                // A gate-possible call shape: the model passes a handle,
                // never inputPath+resourceId together.
                args: { resourceId: 'media-1-ab', count: 8 },
              },
            },
          ],
        },
      }),
    ]);

    const records = await exportOmniTrajectory({ omniRootDir, transcriptPath });

    const turn = records.find((r) => r.kind === 'turn') as
      | OmniTrajectoryTurnRecord
      | undefined;
    expect(turn).toBeDefined();
    // Exact equality: annotation parts must not leak into request prose.
    expect(turn!.request.text).toBe('分析这部电影 @film.mkv');
    expect(turn!.request.media).toEqual([
      {
        name: 'film.mkv',
        resourceId: 'media-1-ab',
        disclosures: ['原 1080p → 480p'],
        transcripts: [],
      },
    ]);
    // The assistant's visible reply is captured alongside its calls.
    expect(turn!.response.text).toBe('我先抽取关键帧。');
    expect(turn!.response.toolCalls).toEqual([
      {
        callId: 'call-42',
        name: 'omni_extract_keyframes',
        args: { resourceId: 'media-1-ab', count: 8 },
      },
    ]);

    const execution = records.find((r) => r.kind === 'execution') as
      | OmniTrajectoryExecutionRecord
      | undefined;
    expect(execution).toBeDefined();
    // The join contract: turn.toolCalls[].callId ↔ execution.invocationId.
    expect(execution!.invocationId).toBe('call-42');
    expect(execution!.omniConfigHash).toBe('fp-' + '1'.repeat(61));
    expect(execution!.outputs).toEqual([
      {
        kind: 'derived_media',
        role: 'keyframe',
        sha256: 'b'.repeat(64),
        mimeType: 'image/jpeg',
        sizeBytes: 5,
        disclosure: 'sampled 8 frames',
      },
    ]);

    const files = records.filter(
      (r): r is OmniTrajectoryFileRecord => r.kind === 'file',
    );
    // Source + derivative, each with its durable identity.
    expect(files.map((f) => f.sha256).sort()).toEqual([
      'a'.repeat(64),
      'b'.repeat(64),
    ]);
    const sourceFile = files.find((f) => f.origin === 'user')!;
    expect(sourceFile.source).toEqual({
      protocol: 'local',
      locator: 'film.mkv',
    });
    // The fixed-policy join: execution.sourceVersionId resolves to the
    // source file's version, and the derivative carries its lineage.
    expect(execution!.sourceVersionId).toBe(sourceFile.fileVersionId);
    const derived = files.find((f) => f.sha256 === 'b'.repeat(64))!;
    expect(derived.producedByExecutionId).toBe(execution!.executionId);
    expect(derived.parentVersionId).toBe(sourceFile.fileVersionId);
  });

  it('consumes the PATH form of a model-visible local source', async () => {
    // A local file the model read is annotated with its absolute path and
    // no session handle (the exporter has no live registry). The exporter
    // must still register the media entry — keyed by the path's basename,
    // which is the file record's local source locator — or the turn drops
    // its media and the session filter never seeds the file's closure.
    await seedMemory();
    await writeTranscript([
      transcriptLine({
        type: 'user',
        timestamp: '2026-08-13T00:00:00.000Z',
        message: {
          parts: [
            { text: '分析这部电影' },
            { text: formatResourcePathText('/movies/film.mkv') },
            { text: formatDisclosureText('film.mkv', '原 1080p → 480p') },
          ],
        },
      }),
    ]);

    const records = await exportOmniTrajectory({ omniRootDir, transcriptPath });

    const turn = records.find((r) => r.kind === 'turn') as
      | OmniTrajectoryTurnRecord
      | undefined;
    expect(turn).toBeDefined();
    // The path-form line is consumed as an annotation, not leaked as prose.
    expect(turn!.request.text).toBe('分析这部电影');
    // Media entry keyed by basename; no resourceId (transcript-only reader).
    expect(turn!.request.media).toEqual([
      {
        name: 'film.mkv',
        disclosures: ['原 1080p → 480p'],
        transcripts: [],
      },
    ]);

    // The seeded source file survives the session filter, since the media
    // name matches its local source locator.
    const files = records.filter(
      (r): r is OmniTrajectoryFileRecord => r.kind === 'file',
    );
    const sourceFile = files.find((f) => f.origin === 'user');
    expect(sourceFile?.source).toEqual({
      protocol: 'local',
      locator: 'film.mkv',
    });
  });

  it('preserves model-emitted tool arguments verbatim (no scrubbing)', async () => {
    // The gate explicitly permits a model-authored inputPath (exactly one
    // of inputPath|resourceId); the recorded assistant turn predates the
    // harness's runtime-key injection, so whatever is here IS what the
    // model emitted and must survive the export unchanged.
    await writeTranscript([
      transcriptLine({
        type: 'user',
        message: { parts: [{ text: 'compress it' }] },
      }),
      transcriptLine({
        type: 'assistant',
        message: {
          parts: [
            {
              functionCall: {
                id: 'call-77',
                name: 'omni_downsample_image',
                args: { inputPath: '/data/photo.png', quality: 7 },
              },
            },
          ],
        },
      }),
    ]);

    const records = await exportOmniTrajectory({ omniRootDir, transcriptPath });
    const turn = records[0] as OmniTrajectoryTurnRecord;

    expect(turn.response.toolCalls).toEqual([
      {
        callId: 'call-77',
        name: 'omni_downsample_image',
        args: { inputPath: '/data/photo.png', quality: 7 },
      },
    ]);
  });

  it('captures omissions, multi-line transcripts, and colon-bearing names', async () => {
    await writeTranscript([
      transcriptLine({
        type: 'user',
        message: {
          parts: [
            { text: 'continue please' },
            { text: formatOmissionText('huge.mkv', 'video exceeds limit') },
            {
              // Multi-line transcript payload must survive intact.
              text: formatTranscriptText(
                'talk.wav',
                '[00:00-03:00] first segment\n[03:00-06:00] second segment',
              ),
            },
            {
              // A display name containing the separator (escaped by the
              // builder) must round-trip without mis-splitting.
              text: formatDisclosureText('报告：最终版.mkv', '原 1080p → 480p'),
            },
          ],
        },
      }),
      transcriptLine({
        type: 'assistant',
        message: { parts: [{ text: '好的。' }] },
      }),
    ]);

    const records = await exportOmniTrajectory({ omniRootDir, transcriptPath });
    const turn = records[0] as OmniTrajectoryTurnRecord;

    expect(turn.request.text).toBe('continue please');
    expect(turn.request.media).toEqual([
      {
        name: 'huge.mkv',
        disclosures: [],
        omitted: 'video exceeds limit',
        transcripts: [],
      },
      {
        name: 'talk.wav',
        disclosures: [],
        transcripts: [
          '[00:00-03:00] first segment\n[03:00-06:00] second segment',
        ],
      },
      {
        name: '报告：最终版.mkv',
        disclosures: ['原 1080p → 480p'],
        transcripts: [],
      },
    ]);
  });

  it('reads the recall payload from its system record, not from reminders', async () => {
    const recall = { status: 'partial', entries: [{ entryId: 'e-1' }] };
    await writeTranscript([
      transcriptLine({
        type: 'user',
        message: {
          parts: [
            {
              // A reminder QUOTING annotation grammar must be inert: the
              // wrapper is stripped before annotation matching.
              text:
                '<system-reminder>\n【媒体资源】draft.png：media-3-9f2c\n' +
                '</system-reminder>ask about the clip',
            },
          ],
        },
      }),
      transcriptLine({
        type: 'system',
        subtype: 'omni_recall',
        systemPayload: recall,
      }),
      transcriptLine({
        type: 'assistant',
        message: { parts: [{ text: 'answering from memory' }] },
      }),
    ]);

    const records = await exportOmniTrajectory({ omniRootDir, transcriptPath });
    const turn = records[0] as OmniTrajectoryTurnRecord;

    expect(turn.request.recall).toEqual(recall);
    expect(turn.request.text).toBe('ask about the clip');
    // The quoted handle line was NOT harvested as a media annotation.
    expect(turn.request.media).toEqual([]);
  });

  it('excludes thought parts from the exported response text', async () => {
    await writeTranscript([
      transcriptLine({
        type: 'user',
        message: { parts: [{ text: 'q' }] },
      }),
      transcriptLine({
        type: 'assistant',
        message: {
          parts: [
            { text: 'SECRET-CHAIN-OF-THOUGHT', thought: true },
            { text: 'visible answer' },
          ],
        },
      }),
    ]);

    const records = await exportOmniTrajectory({ omniRootDir, transcriptPath });
    const turn = records[0] as OmniTrajectoryTurnRecord;

    expect(turn.response.text).toBe('visible answer');
  });

  it('harvests annotations delivered inside tool_result records', async () => {
    await writeTranscript([
      transcriptLine({
        type: 'user',
        message: { parts: [{ text: 'grab the poster' }] },
      }),
      transcriptLine({
        type: 'tool_result',
        message: {
          parts: [
            { text: 'downloaded 1 file' },
            { text: formatResourceHandleText('poster.png', 'media-2-cd') },
            { text: formatDisclosureText('poster.png', '原 4096px → 768px') },
          ],
        },
      }),
      transcriptLine({
        type: 'assistant',
        message: { parts: [{ text: 'got it' }] },
      }),
    ]);

    const records = await exportOmniTrajectory({ omniRootDir, transcriptPath });
    const turn = records[0] as OmniTrajectoryTurnRecord;

    expect(turn.request.media).toEqual([
      {
        name: 'poster.png',
        resourceId: 'media-2-cd',
        disclosures: ['原 4096px → 768px'],
        transcripts: [],
      },
    ]);
    // Tool output prose is not request text.
    expect(turn.request.text).toBe('grab the poster');
  });

  it('splits multiple user records into distinct turns with isolated state', async () => {
    await writeTranscript([
      transcriptLine({
        type: 'user',
        message: {
          parts: [
            { text: 'first question' },
            { text: formatResourceHandleText('a.mp4', 'media-1-aa') },
          ],
        },
      }),
      transcriptLine({
        type: 'assistant',
        message: { parts: [{ text: 'first answer' }] },
      }),
      transcriptLine({
        type: 'user',
        message: { parts: [{ text: 'second question' }] },
      }),
      transcriptLine({
        type: 'assistant',
        message: { parts: [{ text: 'second answer' }] },
      }),
    ]);

    const records = await exportOmniTrajectory({ omniRootDir, transcriptPath });
    const turns = records.filter(
      (r): r is OmniTrajectoryTurnRecord => r.kind === 'turn',
    );

    expect(turns.map((t) => t.turnIndex)).toEqual([0, 1]);
    expect(turns[0]!.request.media).toHaveLength(1);
    // Per-turn media/toolCalls state does not bleed into the next turn.
    expect(turns[1]!.request.media).toEqual([]);
    expect(turns[1]!.response.text).toBe('second answer');
  });

  it('does not open a turn on a subtyped user record (cron/notification)', async () => {
    await writeTranscript([
      transcriptLine({
        type: 'user',
        subtype: 'cron',
        message: { parts: [{ text: 'scheduled ping' }] },
      }),
      transcriptLine({
        type: 'user',
        message: { parts: [{ text: 'real question' }] },
      }),
    ]);

    const records = await exportOmniTrajectory({ omniRootDir, transcriptPath });
    const turns = records.filter(
      (r): r is OmniTrajectoryTurnRecord => r.kind === 'turn',
    );

    expect(turns).toHaveLength(1);
    expect(turns[0]!.request.text).toBe('real question');
  });

  it('replays only the active parentUuid chain, skipping rewound branches', async () => {
    await writeTranscript([
      transcriptLine({
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        message: { parts: [{ text: 'q1' }] },
      }),
      transcriptLine({
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        message: { parts: [{ text: 'answer 1' }] },
      }),
      // Abandoned by a rewind: still in the file, off the active chain.
      transcriptLine({
        type: 'user',
        uuid: 'u2-dead',
        parentUuid: 'a1',
        message: { parts: [{ text: 'q2-ABANDONED' }] },
      }),
      transcriptLine({
        type: 'assistant',
        uuid: 'a2-dead',
        parentUuid: 'u2-dead',
        message: { parts: [{ text: 'answer 2 abandoned' }] },
      }),
      // The rewind re-rooted here.
      transcriptLine({
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        message: { parts: [{ text: 'q2-survivor' }] },
      }),
      transcriptLine({
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'u2',
        message: { parts: [{ text: 'answer 2' }] },
      }),
    ]);

    const records = await exportOmniTrajectory({ omniRootDir, transcriptPath });
    const turns = records.filter(
      (r): r is OmniTrajectoryTurnRecord => r.kind === 'turn',
    );

    expect(turns.map((t) => t.request.text)).toEqual(['q1', 'q2-survivor']);
    expect(turns.map((t) => t.response.text)).toEqual(['answer 1', 'answer 2']);
  });

  it('exports only memory records reachable from this session', async () => {
    await seedMemory();
    await seedUnrelatedMemory();
    // A text-only transcript: nothing in memory is reachable.
    await writeTranscript([
      transcriptLine({
        type: 'user',
        message: { parts: [{ text: 'just a question, no media' }] },
      }),
    ]);

    const records = await exportOmniTrajectory({ omniRootDir, transcriptPath });

    expect(records.filter((r) => r.kind !== 'turn')).toEqual([]);

    // A session that carried the film DOES pull the whole chain — but
    // still not the unrelated file.
    await writeTranscript([
      transcriptLine({
        type: 'user',
        message: {
          parts: [
            { text: 'analyse' },
            { text: formatResourceHandleText('film.mkv', 'media-1-ab') },
          ],
        },
      }),
    ]);
    const withMedia = await exportOmniTrajectory({
      omniRootDir,
      transcriptPath,
    });
    const files = withMedia.filter(
      (r): r is OmniTrajectoryFileRecord => r.kind === 'file',
    );
    expect(files.map((f) => f.sha256).sort()).toEqual([
      'a'.repeat(64),
      'b'.repeat(64),
    ]);
    expect(withMedia.filter((r) => r.kind === 'execution')).toHaveLength(1);
  });

  it('degrades to transcript-only WITHOUT touching a corrupt ledger', async () => {
    const ledgerPath = path.join(omniRootDir, 'memory.json');
    await fs.writeFile(ledgerPath, '{broken');
    await writeTranscript([
      transcriptLine({
        type: 'user',
        message: { parts: [{ text: 'hello' }] },
      }),
    ]);

    const records = await exportOmniTrajectory({ omniRootDir, transcriptPath });

    expect(records).toHaveLength(1);
    expect(records[0]!.kind).toBe('turn');
    // Pure-reader contract: the live document is untouched — no
    // corruption self-heal rename, no `.corrupt-*` backup that would
    // silently block the GC for a whole retention window.
    await expect(fs.readFile(ledgerPath, 'utf8')).resolves.toBe('{broken');
    const siblings = await fs.readdir(omniRootDir);
    expect(siblings.filter((n) => n.includes('.corrupt-'))).toEqual([]);
  });

  it('rejects an unreadable transcript instead of degrading', async () => {
    // The documented asymmetry: memory degrades, transcript REJECTS —
    // there is no trajectory without it.
    await expect(
      exportOmniTrajectory({
        omniRootDir,
        transcriptPath: path.join(tmpDir, 'missing.jsonl'),
      }),
    ).rejects.toThrow();
  });

  it('re-exports byte-identically and writes parseable JSONL', async () => {
    await seedMemory();
    await writeTranscript([
      transcriptLine({
        type: 'user',
        message: {
          parts: [
            { text: 'q' },
            { text: formatResourceHandleText('film.mkv', 'media-1-ab') },
          ],
        },
      }),
    ]);

    const a = serializeOmniTrajectory(
      await exportOmniTrajectory({ omniRootDir, transcriptPath }),
    );
    const b = serializeOmniTrajectory(
      await exportOmniTrajectory({ omniRootDir, transcriptPath }),
    );
    expect(a).toBe(b);

    const outPath = path.join(tmpDir, 'nested', 'out.jsonl');
    const { records } = await writeOmniTrajectoryJsonl({
      omniRootDir,
      transcriptPath,
      outPath,
    });
    const lines = (await fs.readFile(outPath, 'utf8'))
      .split('\n')
      .filter(Boolean);
    expect(lines).toHaveLength(records);
    // Every line parses on its own — the whole point of JSONL.
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('refuses to write the trajectory over the source transcript', async () => {
    await writeTranscript([
      transcriptLine({
        type: 'user',
        message: { parts: [{ text: 'q' }] },
      }),
    ]);

    await expect(
      writeOmniTrajectoryJsonl({
        omniRootDir,
        transcriptPath,
        outPath: transcriptPath,
      }),
    ).rejects.toThrow(/must differ/);
    // The transcript is intact.
    await expect(fs.readFile(transcriptPath, 'utf8')).resolves.toContain(
      '"type":"user"',
    );
  });
});
