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
                args: {
                  resourceId: 'media-1-ab',
                  count: 8,
                  inputPath: '/secret/abs/path.mkv',
                  outputDir: '/secret/out',
                },
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
    expect(turn!.request.text).toContain('分析这部电影');
    expect(turn!.request.media).toEqual([
      {
        name: 'film.mkv',
        resourceId: 'media-1-ab',
        disclosures: ['原 1080p → 480p'],
        transcripts: [],
      },
    ]);
    // Reserved runtime keys are stripped from tool args — the transcript
    // side must not re-leak the paths memory's finalArguments excludes.
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
  });

  it('captures omissions and extracts an injected passive recall', async () => {
    await writeTranscript([
      transcriptLine({
        type: 'user',
        message: {
          parts: [
            {
              text:
                '<system-reminder>\n【媒体记忆】Recalled media memory…\n' +
                '{"status":"partial","entries":[{"entryId":"e-1"}]}\n' +
                '</system-reminder>continue please',
            },
            { text: formatOmissionText('huge.mkv', 'video exceeds limit') },
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

    expect(turn.request.recall).toEqual({
      status: 'partial',
      entries: [{ entryId: 'e-1' }],
    });
    // The reminder wrapper is NOT part of the user's request prose.
    expect(turn.request.text).toBe('continue please');
    expect(turn.request.media).toEqual([
      {
        name: 'huge.mkv',
        disclosures: [],
        omitted: 'video exceeds limit',
        transcripts: [],
      },
    ]);
  });

  it('degrades to transcript-only output when memory is unreadable', async () => {
    await fs.writeFile(path.join(omniRootDir, 'memory.json'), '{broken');
    await writeTranscript([
      transcriptLine({
        type: 'user',
        message: { parts: [{ text: 'hello' }] },
      }),
    ]);

    const records = await exportOmniTrajectory({ omniRootDir, transcriptPath });

    expect(records).toHaveLength(1);
    expect(records[0]!.kind).toBe('turn');
  });

  it('re-exports byte-identically and writes parseable JSONL', async () => {
    await seedMemory();
    await writeTranscript([
      transcriptLine({
        type: 'user',
        message: { parts: [{ text: 'q' }] },
      }),
    ]);

    const a = serializeOmniTrajectory(
      await exportOmniTrajectory({ omniRootDir, transcriptPath }),
    );
    const b = serializeOmniTrajectory(
      await exportOmniTrajectory({ omniRootDir, transcriptPath }),
    );
    expect(a).toBe(b);

    const outPath = path.join(tmpDir, 'out.jsonl');
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
});
