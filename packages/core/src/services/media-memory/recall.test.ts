/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_OMNI_MEMORY_CONFIG,
  MediaMemoryRecallRejection,
  MediaMemoryRecallService,
  MediaMemoryService,
  MediaResourceRegistry,
  type MediaMemoryBinding,
} from './index.js';
import type { NormalizedOmniMemoryRecall } from './config.js';

let root: string;
let moviePath: string;
let clock: number;
let service: TestMediaMemoryService;
let registry: MediaResourceRegistry;

class TestMediaMemoryService extends MediaMemoryService {
  protected override now(): string {
    return new Date(clock++).toISOString();
  }
}

const SHA_MOVIE = 'a'.repeat(64);
const SHA_MOVIE_V2 = 'b'.repeat(64);
const SHA_DEGRADED = 'c'.repeat(64);
const SHA_TRANSCRIPT = 'd'.repeat(64);
const SHA_AUDIO = 'e'.repeat(64);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-memory-recall-'));
  clock = 1_754_870_400_000;
  service = new TestMediaMemoryService(root);
  registry = new MediaResourceRegistry();
  moviePath = path.join(root, 'src', 'breaking-surface.mkv');
  await fs.mkdir(path.dirname(moviePath), { recursive: true });
  await fs.writeFile(moviePath, 'movie-bytes');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function recallConfig(
  overrides?: Partial<NormalizedOmniMemoryRecall>,
): NormalizedOmniMemoryRecall {
  return {
    ...DEFAULT_OMNI_MEMORY_CONFIG.recall,
    kinds: [...DEFAULT_OMNI_MEMORY_CONFIG.recall.kinds],
    ...overrides,
  };
}

function recallService(
  config = recallConfig(),
  options?: ConstructorParameters<typeof MediaMemoryRecallService>[3],
): MediaMemoryRecallService {
  return new MediaMemoryRecallService(root, config, registry, options);
}

async function recognizeMovie(sha256 = SHA_MOVIE): Promise<MediaMemoryBinding> {
  const commit = await service.recordFileRecognized({
    fileRef: moviePath,
    sha256,
    mediaType: 'video',
    metadata: { durationMs: 4_860_000, width: 1920, height: 1080 },
    sizeBytes: 123_456_789,
    mimeType: 'video/x-matroska',
    origin: 'user',
    source: { protocol: 'local', locator: 'breaking-surface.mkv' },
    recognition: {
      ingestionConfigHash: 'ingest-hash',
      detectorVersion: 'omni-sniff-ffprobe/1',
      probeStatus: 'complete',
    },
  });
  expect(commit).toBeDefined();
  return commit!;
}

/** Write a fake managed object and return its absolute path. */
async function writeObject(name: string): Promise<string> {
  const objectPath = path.join(root, 'objects', name);
  await fs.mkdir(path.dirname(objectPath), { recursive: true });
  await fs.writeFile(objectPath, `bytes-of-${name}`);
  return objectPath;
}

async function commitDegrade(source: MediaMemoryBinding): Promise<{
  degradedPath: string;
  binding: MediaMemoryBinding;
}> {
  const degradedPath = await writeObject('degraded.mp4');
  const commit = await service.commitPolicySucceeded({
    invocationId: 'inv-degrade',
    source,
    executionOrigin: {
      kind: 'fixed_policy',
      policyId: 'video-default',
      stage: 'preprocessing',
    },
    toolName: 'omni_degrade_video',
    toolVersion: '1',
    finalArguments: { height: 480 },
    omniConfigHash: 'hash-degrade',
    startedAt: '2026-08-11T00:00:00.000Z',
    completedAt: '2026-08-11T00:00:05.000Z',
    outputs: [
      {
        kind: 'media',
        objectPath: degradedPath,
        sha256: SHA_DEGRADED,
        mediaType: 'video',
        metadata: { durationMs: 4_860_000, width: 854, height: 480 },
        sizeBytes: 1_000_000,
        mimeType: 'video/mp4',
        role: 'degraded',
        disclosure: 'downscaled to 480p',
      },
    ],
  });
  expect(commit).toBeDefined();
  return { degradedPath, binding: commit!.mediaBindings.get(SHA_DEGRADED)! };
}

async function commitTranscript(
  source: MediaMemoryBinding,
  text = 'Two divers surface at dawn near the wreck.',
): Promise<void> {
  const objectPath = await writeObject('transcript.txt');
  const commit = await service.commitPolicySucceeded({
    invocationId: 'inv-transcribe',
    source,
    executionOrigin: { kind: 'model' },
    toolName: 'omni_transcribe',
    finalArguments: { language: 'auto' },
    omniConfigHash: 'hash-transcribe',
    startedAt: '2026-08-11T00:01:00.000Z',
    completedAt: '2026-08-11T00:01:30.000Z',
    outputs: [
      {
        kind: 'text',
        objectPath,
        sha256: SHA_TRANSCRIPT,
        mimeType: 'text/plain',
        text,
        sizeBytes: text.length,
        role: 'transcript',
      },
    ],
  });
  expect(commit).toBeDefined();
}

function bindSource(source: MediaMemoryBinding): string {
  return registry.bind({
    ...source,
    fileRef: moviePath,
    mediaType: 'video',
  }).resourceId;
}

describe('MediaMemoryRecallService — request validation', () => {
  it('rejects an empty request outright', async () => {
    await expect(
      recallService().recall({ resourceIds: [], query: 'anything' }),
    ).rejects.toThrow(MediaMemoryRecallRejection);
  });

  it('rejects the whole request on a handle this session never issued', async () => {
    const source = await recognizeMovie();
    const resourceId = bindSource(source);
    await expect(
      recallService().recall({
        resourceIds: [resourceId, 'media-9-deadbeef'],
        query: 'anything',
      }),
    ).rejects.toThrow(/not issued in this session/);
  });

  it('resolves the ABSOLUTE PATH shown for a model-visible local source', async () => {
    // A local file the model read is annotated with its path, not a handle;
    // the model passes that path to recall, which must reverse it to the
    // session binding (resolveByFileRef) and recall exactly as the handle
    // would — not reject it as unknown.
    const source = await recognizeMovie();
    await commitDegrade(source);
    await commitTranscript(source);
    bindSource(source); // binds fileRef === moviePath

    const result = await recallService().recall({
      resourceIds: [moviePath],
      query: 'what happens in the movie',
    });

    expect(result.status).toBe('hit');
    expect(result.files).toEqual([
      {
        fileId: source.fileId,
        fileVersionId: source.fileVersionId,
        current: true,
        mediaType: 'video',
      },
    ]);
  });

  it('deduplicates a handle and the path form of the same resource', async () => {
    // The handle and the path resolve to ONE binding; recall must treat the
    // pair as a single resource, not push duplicate gaps/advice for it.
    const source = await recognizeMovie();
    const resourceId = bindSource(source);
    const result = await recallService().recall({
      resourceIds: [resourceId, moviePath],
      query: 'what happens in the movie',
    });
    expect(result.files).toEqual([
      {
        fileId: source.fileId,
        fileVersionId: source.fileVersionId,
        current: true,
        mediaType: 'video',
      },
    ]);
  });

  it('still rejects an identifier that is neither a handle nor a bound path', async () => {
    const source = await recognizeMovie();
    const resourceId = bindSource(source);
    await expect(
      recallService().recall({
        resourceIds: [resourceId, '/not/a/bound/path.mkv'],
        query: 'anything',
      }),
    ).rejects.toThrow(/not issued in this session/);
  });
});

describe('MediaMemoryRecallService — full graph recall', () => {
  it('returns metadata, outputs, and executions of the current version graph', async () => {
    const source = await recognizeMovie();
    await commitDegrade(source);
    await commitTranscript(source);
    const resourceId = bindSource(source);

    const result = await recallService().recall({
      resourceIds: [resourceId],
      query: 'what happens in the movie',
    });

    expect(result.status).toBe('hit');
    expect(result.gaps).toEqual([]);
    expect(result.files).toEqual([
      {
        fileId: source.fileId,
        fileVersionId: source.fileVersionId,
        current: true,
        mediaType: 'video',
      },
    ]);

    const byKind = new Map(result.entries.map((e) => [e.kind, e]));
    expect([...byKind.keys()].sort()).toEqual([
      'derived_media',
      'execution',
      'metadata',
      'policy_result',
    ]);
    expect(result.entries).toHaveLength(5); // 2 executions

    const metadata = byKind.get('metadata')!;
    expect(metadata.content).toContain('"width":1920');
    expect(metadata.channels).toEqual(['technical_metadata']);
    expect(metadata.provenance.omniConfigHash).toBe('ingest-hash');

    const transcript = byKind.get('policy_result')!;
    expect(transcript.role).toBe('transcript');
    expect(transcript.content).toContain('surface at dawn');
    expect(transcript.channels).toEqual(['speech_text']);
    expect(transcript.evidenceRefs[0].fileVersionId).toBe(source.fileVersionId);
    expect(transcript.evidenceRefs[0].executionId).toBeDefined();
    expect(transcript.provenance.toolName).toBe('omni_transcribe');

    const derived = byKind.get('derived_media')!;
    expect(derived.disclosure).toBe('downscaled to 480p');
    expect(derived.provenance.policyId).toBe('video-default');
    expect(derived.provenance.stage).toBe('preprocessing');
    // A fresh session handle was bound for the derived artifact and never
    // leaks a path.
    expect(derived.resourceId).toBeDefined();
    const bound = registry.resolve(derived.resourceId!);
    expect(bound?.fileVersionId).toBeDefined();
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it('reaches entries parented on intermediate derivatives (audio → transcript chain)', async () => {
    const source = await recognizeMovie();
    const audioPath = await writeObject('audio.m4a');
    const audioCommit = await service.commitPolicySucceeded({
      invocationId: 'inv-extract',
      source,
      executionOrigin: {
        kind: 'fixed_policy',
        policyId: 'video-default',
        stage: 'preprocessing',
      },
      toolName: 'omni_extract_audio',
      finalArguments: {},
      omniConfigHash: 'hash-extract',
      startedAt: '2026-08-11T00:00:00.000Z',
      completedAt: '2026-08-11T00:00:02.000Z',
      outputs: [
        {
          kind: 'media',
          objectPath: audioPath,
          sha256: SHA_AUDIO,
          mediaType: 'audio',
          metadata: { durationMs: 4_860_000 },
          sizeBytes: 5_000_000,
          mimeType: 'audio/mp4',
          role: 'extracted_audio',
        },
      ],
    });
    await commitTranscript(audioCommit!.mediaBindings.get(SHA_AUDIO)!);
    const resourceId = bindSource(source);

    const result = await recallService().recall({
      resourceIds: [resourceId],
      query: 'transcript',
      kinds: ['policy_result'],
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].role).toBe('transcript');
    // Evidence points at the audio derivative it was transcribed from.
    expect(result.entries[0].evidenceRefs[0].fileVersionId).not.toBe(
      source.fileVersionId,
    );
  });
});

describe('MediaMemoryRecallService — filters, limit, ranking', () => {
  it('narrows by kinds and roles', async () => {
    const source = await recognizeMovie();
    await commitDegrade(source);
    await commitTranscript(source);
    const resourceId = bindSource(source);
    const svc = recallService();

    const kindsOnly = await svc.recall({
      resourceIds: [resourceId],
      query: 'q',
      kinds: ['derived_media'],
    });
    expect(kindsOnly.entries.map((e) => e.kind)).toEqual(['derived_media']);

    const rolesOnly = await svc.recall({
      resourceIds: [resourceId],
      query: 'q',
      roles: ['transcript'],
    });
    expect(rolesOnly.entries.map((e) => e.role)).toEqual(['transcript']);
  });

  it('ranks query-relevant entries first and applies the entry budget', async () => {
    const source = await recognizeMovie();
    await commitDegrade(source);
    await commitTranscript(source, 'The captain reads the tide tables.');
    const resourceId = bindSource(source);

    const result = await recallService().recall({
      resourceIds: [resourceId],
      query: 'tide tables transcript',
      limit: 2,
    });

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].role).toBe('transcript');
  });

  it('ranks a Chinese query by partial phrase overlap', async () => {
    // Chinese writes without separators, so splitting on them yielded ONE
    // token per phrase, scored by whole-substring containment: unless an
    // entry repeated the caller's exact phrasing, every candidate scored
    // zero and ordering silently collapsed to newest-first. Here the
    // transcript is the OLDEST entry, so newest-first would rank it last.
    const source = await recognizeMovie();
    await commitTranscript(source, '机器人独自走在海滩上，梦见了狗。');
    await commitDegrade(source);
    const resourceId = bindSource(source);

    const result = await recallService().recall({
      resourceIds: [resourceId],
      // Not a substring of the transcript — overlapping in phrasing only.
      query: '机器人在海滩梦见什么',
    });

    expect(result.entries[0].role).toBe('transcript');
  });

  it('caps request limit at the configured maxEntries', async () => {
    const source = await recognizeMovie();
    await commitDegrade(source);
    await commitTranscript(source);
    const resourceId = bindSource(source);

    const result = await recallService(recallConfig({ maxEntries: 3 })).recall({
      resourceIds: [resourceId],
      query: 'q',
      limit: 100,
    });
    expect(result.entries).toHaveLength(3);
  });

  it('bounds entry content at maxTextChars', async () => {
    const source = await recognizeMovie();
    await commitTranscript(source, 'x'.repeat(500));
    const resourceId = bindSource(source);

    const result = await recallService(
      recallConfig({ maxTextChars: 40 }),
    ).recall({ resourceIds: [resourceId], query: 'q', roles: ['transcript'] });
    expect(result.entries[0].content).toHaveLength(40);
  });

  it('never cuts a surrogate pair in half at the maxTextChars boundary', async () => {
    const source = await recognizeMovie();
    // Emoji and CJK extension characters are two UTF-16 units each, so an
    // odd budget lands mid-pair — the common case for a transcript of a
    // chat recording, not an exotic one.
    await commitTranscript(source, '🎬'.repeat(30));
    const resourceId = bindSource(source);

    const result = await recallService(
      recallConfig({ maxTextChars: 41 }),
    ).recall({ resourceIds: [resourceId], query: 'q', roles: ['transcript'] });

    // A trailing lone surrogate is not text: it cannot round-trip through
    // UTF-8, so the recall payload handed to the model carries a replacement
    // character or an encoder error where a character used to be.
    expect(result.entries[0].content).toBe('🎬'.repeat(20));
    expect(result.entries[0].contentTruncated).toBe(true);
  });
});

describe('MediaMemoryRecallService — current-version-first (§9.5)', () => {
  it('consults only the current version and hints at bound history', async () => {
    const source = await recognizeMovie();
    await commitDegrade(source);
    await commitTranscript(source);
    const staleResourceId = bindSource(source);
    const fresh = await recognizeMovie(SHA_MOVIE_V2); // content changed on disk

    const result = await recallService().recall({
      resourceIds: [staleResourceId],
      query: 'q',
    });

    // Nothing processed for the new content yet → only its metadata comes
    // back, with an explicit not_processed gap and the stale version
    // listed as history.
    expect(result.status).toBe('partial');
    expect(result.entries.map((e) => e.kind)).toEqual(['metadata']);
    expect(result.gaps).toEqual([
      {
        scope: {},
        channels: ['visual', 'acoustic', 'speech_text'],
        reason: 'not_processed',
      },
    ]);
    expect(result.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fileVersionId: fresh.fileVersionId,
          current: true,
        }),
        expect.objectContaining({
          fileVersionId: source.fileVersionId,
          current: false,
        }),
      ]),
    );
  });

  it('returns historical entries when explicitly requested', async () => {
    const source = await recognizeMovie();
    await commitTranscript(source);
    const staleResourceId = bindSource(source);
    await recognizeMovie(SHA_MOVIE_V2);

    const result = await recallService().recall({
      resourceIds: [staleResourceId],
      query: 'q',
      includeHistoricalVersions: true,
      roles: ['transcript'],
    });

    expect(result.entries.map((e) => e.role)).toEqual(['transcript']);
  });

  it('keeps gaps speaking for the current version when history is included', async () => {
    // The first content state was never processed; the file then changed on
    // disk and the NEW content got the full treatment.
    const stale = await recognizeMovie();
    const staleResourceId = bindSource(stale);
    const fresh = await recognizeMovie(SHA_MOVIE_V2);
    await commitDegrade(fresh); // visual + acoustic
    await commitTranscript(fresh); // speech_text

    const result = await recallService().recall({
      resourceIds: [staleResourceId],
      query: 'q',
      includeHistoricalVersions: true,
    });

    // History widens what memory OFFERS — both content states are listed.
    expect(result.files.map((f) => f.fileVersionId).sort()).toEqual(
      [stale.fileVersionId, fresh.fileVersionId].sort(),
    );
    expect(result.entries.filter((e) => e.kind === 'metadata')).toHaveLength(2);
    // ...and never what memory OWES. Deriving gaps from the consulted set
    // would report a superseded version's untouched channels as holes in the
    // content that exists NOW, and the advisor would then hand the model
    // follow-up calls to re-derive work that is already complete.
    expect(result.gaps).toEqual([]);
    expect(result.status).toBe('hit');
  });
});

describe('MediaMemoryRecallService — gaps and availability', () => {
  it('never lets a request filter manufacture a gap', async () => {
    const source = await recognizeMovie();
    await commitDegrade(source); // visual + acoustic
    await commitTranscript(source); // speech_text
    const resourceId = bindSource(source);
    const svc = recallService();

    const unfiltered = await svc.recall({
      resourceIds: [resourceId],
      query: 'q',
    });
    expect(unfiltered.gaps).toEqual([]);

    // Gap truth is a property of the graph, not of the question. Deriving
    // it from the filtered entry set would report the transcript's channel
    // as never processed the moment a caller asked only for metadata — and
    // the advisor would then suggest re-transcribing a film that already
    // has a transcript, at full cost, on every narrowed recall.
    const kindsOnly = await svc.recall({
      resourceIds: [resourceId],
      query: 'q',
      kinds: ['metadata'],
    });
    expect(kindsOnly.entries.map((e) => e.kind)).toEqual(['metadata']);
    expect(kindsOnly.gaps).toEqual([]);
    expect(kindsOnly.status).toBe('hit');

    // Even a filter that matches nothing at all leaves the gaps empty:
    // seeing nothing is not the same as nothing being there.
    const rolesOnly = await svc.recall({
      resourceIds: [resourceId],
      query: 'q',
      roles: ['keyframe'],
    });
    expect(rolesOnly.entries).toEqual([]);
    expect(rolesOnly.gaps).toEqual([]);
  });

  it('reports unprocessed channels as gaps (partial status)', async () => {
    const source = await recognizeMovie();
    await commitDegrade(source); // visual+acoustic covered, no transcript
    const resourceId = bindSource(source);

    const result = await recallService().recall({
      resourceIds: [resourceId],
      query: 'q',
    });

    expect(result.status).toBe('partial');
    expect(result.gaps).toEqual([
      { scope: {}, channels: ['speech_text'], reason: 'not_processed' },
    ]);
  });

  it('reports sampled-only coverage as partial_coverage', async () => {
    const source = await recognizeMovie();
    const keyframePath = await writeObject('keyframe.jpg');
    await service.commitPolicySucceeded({
      invocationId: 'inv-keyframes',
      source,
      executionOrigin: { kind: 'model' },
      toolName: 'omni_extract_keyframes',
      finalArguments: {},
      omniConfigHash: 'hash-keyframes',
      startedAt: '2026-08-11T00:00:00.000Z',
      completedAt: '2026-08-11T00:00:01.000Z',
      outputs: [
        {
          kind: 'media',
          objectPath: keyframePath,
          sha256: SHA_DEGRADED,
          mediaType: 'image',
          metadata: { width: 1920, height: 1080 },
          sizeBytes: 100_000,
          mimeType: 'image/jpeg',
          role: 'keyframe',
        },
      ],
    });
    const resourceId = bindSource(source);

    const result = await recallService().recall({
      resourceIds: [resourceId],
      query: 'q',
    });

    expect(result.gaps).toEqual(
      expect.arrayContaining([
        { scope: {}, channels: ['visual'], reason: 'partial_coverage' },
        {
          scope: {},
          channels: ['acoustic', 'speech_text'],
          reason: 'not_processed',
        },
      ]),
    );
  });

  it('flags a deleted source file as artifact_unavailable (D5)', async () => {
    const source = await recognizeMovie();
    await commitDegrade(source);
    await commitTranscript(source);
    const resourceId = bindSource(source);
    await fs.rm(moviePath);

    const result = await recallService().recall({
      resourceIds: [resourceId],
      query: 'q',
    });

    expect(result.status).toBe('partial');
    expect(result.gaps).toEqual([
      {
        scope: {},
        channels: ['visual', 'acoustic', 'speech_text'],
        reason: 'artifact_unavailable',
      },
    ]);
    // The memory itself is intact — entries still come back.
    expect(result.entries.length).toBeGreaterThan(0);
  });

  it('never emits sibling gaps or advice for a deleted source (C7)', async () => {
    // Only the audio track was ever extracted, so `visual` has no
    // evidence: the pre-fix code emitted `artifact_unavailable` AND a
    // `not_processed` sibling, and the advisor — which only filters
    // `artifact_unavailable` — then suggested keyframe extraction on a
    // handle whose file is gone (a guaranteed-to-fail turn).
    const source = await recognizeMovie();
    await commitTranscript(source);
    const resourceId = bindSource(source);
    await fs.rm(moviePath);

    const result = await recallService(recallConfig(), {
      advise: ({ resourceId: rid, gap }) =>
        gap.reason === 'artifact_unavailable'
          ? []
          : [
              {
                toolName: 'omni_extract_keyframes',
                resourceId: rid,
                arguments: {},
                reason: 'no visual evidence',
              },
            ],
    }).recall({ resourceIds: [resourceId], query: 'q' });

    expect(result.gaps).toEqual([
      {
        scope: {},
        channels: ['visual', 'acoustic', 'speech_text'],
        reason: 'artifact_unavailable',
      },
    ]);
    // Nothing can be gathered from a deleted file — no advice at all.
    expect(result.nextPolicyActions).toBeUndefined();
  });

  it('withholds the handle of a deleted derived artifact', async () => {
    const source = await recognizeMovie();
    const { degradedPath } = await commitDegrade(source);
    await commitTranscript(source);
    const resourceId = bindSource(source);
    await fs.rm(degradedPath);

    const result = await recallService().recall({
      resourceIds: [resourceId],
      query: 'q',
    });

    const derived = result.entries.find((e) => e.kind === 'derived_media')!;
    expect(derived.resourceId).toBeUndefined();
    expect(result.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'artifact_unavailable' }),
      ]),
    );
  });

  it('degrades to a miss with an unavailability gap when the graph lost the binding', async () => {
    // A handle minted in-session, but the store never saw the version
    // (e.g. memory.json was corrupt-rebuilt after binding).
    const resourceId = registry.bind({
      fileId: 'f-ghost',
      fileVersionId: 'v-ghost',
      rootFileId: 'f-ghost',
      fileRef: moviePath,
      mediaType: 'video',
    }).resourceId;

    const result = await recallService().recall({
      resourceIds: [resourceId],
      query: 'q',
    });

    expect(result.status).toBe('miss');
    expect(result.entries).toEqual([]);
    expect(result.gaps).toEqual([
      {
        scope: {},
        channels: ['visual', 'acoustic', 'speech_text'],
        reason: 'artifact_unavailable',
      },
    ]);
  });
});

describe('MediaMemoryRecallService — nextPolicyActions', () => {
  it('omits the field without an advisor and emits its suggestions with one', async () => {
    const source = await recognizeMovie();
    await commitDegrade(source); // speech_text gap
    const resourceId = bindSource(source);

    const plain = await recallService().recall({
      resourceIds: [resourceId],
      query: 'q',
    });
    expect(plain.nextPolicyActions).toBeUndefined();

    const advised = await recallService(recallConfig(), {
      advise: ({ resourceId: rid, gap }) =>
        gap.reason === 'not_processed' && gap.channels.includes('speech_text')
          ? [
              {
                toolName: 'omni_transcribe',
                resourceId: rid,
                arguments: {},
                reason: 'speech has not been transcribed',
              },
            ]
          : [],
    }).recall({ resourceIds: [resourceId], query: 'q' });

    expect(advised.nextPolicyActions).toEqual([
      {
        toolName: 'omni_transcribe',
        resourceId,
        arguments: {},
        reason: 'speech has not been transcribed',
      },
    ]);
  });
});

describe('MediaMemoryRecallService — truncation visibility', () => {
  it('says how many matched when the budget cut the list short', async () => {
    const source = await recognizeMovie();
    await commitDegrade(source);
    await commitTranscript(source);
    const resourceId = bindSource(source);

    const full = await recallService().recall({
      resourceIds: [resourceId],
      query: 'q',
    });
    // An exhaustive page carries no counter, so a reader seeing the field
    // absent knows it is looking at everything.
    expect(full.matchedEntries).toBeUndefined();
    expect(full.entries.length).toBeGreaterThan(1);

    const page = await recallService().recall({
      resourceIds: [resourceId],
      query: 'q',
      limit: 1,
    });
    expect(page.entries).toHaveLength(1);
    // A real audit concluded "no keyframes were ever extracted" from a
    // truncated page; the counter is what makes that mistake impossible.
    expect(page.matchedEntries).toBe(full.entries.length);
  });
});

describe('MediaMemoryRecallService — sideQuery manifest and selection (§9.3)', () => {
  it('summarizes candidates without full text or local paths', async () => {
    const source = await recognizeMovie();
    await commitDegrade(source);
    await commitTranscript(source);
    const resourceId = bindSource(source);
    // Bind the derived artifact's handle too, so a leak has something to
    // leak: an active recall over the same graph mints one.
    const active = await recallService().recall({
      resourceIds: [resourceId],
      query: 'q',
    });
    const derivedHandle = active.entries.find(
      (e) => e.kind === 'derived_media',
    )!.resourceId!;

    const manifest = await recallService().candidateSummaries([resourceId]);

    expect(manifest.length).toBeGreaterThanOrEqual(3);
    expect(manifest.some((c) => c.role === 'transcript')).toBe(true);
    for (const candidate of manifest) {
      expect((candidate.description ?? '').length).toBeLessThanOrEqual(200);
    }
    // Never a local path or a session handle in selector-visible data.
    // Manifest rows exist to be judged for relevance and answered with
    // entryIds; a handle there is an executable capability that skipped the
    // availability pass `finishResult` runs, so the selector prompt would
    // carry a resolvable reference to bytes nobody checked still exist.
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain(resourceId);
    expect(serialized).not.toContain(derivedHandle);
    expect(serialized).not.toMatch(/media-\d+-[0-9a-f]{8}/);
  });

  it('cuts a manifest description at 200 chars, keeping it a text prefix', async () => {
    const source = await recognizeMovie();
    // A real transcript is thousands of characters; the manifest holds up
    // to maxCandidateEntries (100) rows and is prompt for the selector
    // model, so an uncapped preview would put whole transcripts in the very
    // request whose job is to decide which transcripts to load.
    const text = 'Two divers surface at dawn near the wreck. '.repeat(20);
    await commitTranscript(source, text);
    const resourceId = bindSource(source);

    const manifest = await recallService().candidateSummaries([resourceId]);
    const transcript = manifest.find((c) => c.role === 'transcript')!;

    expect(text.length).toBeGreaterThan(200);
    expect(transcript.description).toHaveLength(200);
    // A preview is only honest if it is a prefix — a reshaped or elided
    // description would have the selector judge relevance on text memory
    // does not hold.
    expect(text.startsWith(transcript.description!)).toBe(true);
  });

  it('orders the manifest newest first, so the cap drops the oldest rows', async () => {
    const source = await recognizeMovie();
    await commitDegrade(source);
    await commitTranscript(source);
    const resourceId = bindSource(source);

    const manifest = await recallService().candidateSummaries([resourceId]);

    // Newest first: the two policy executions (recorded with 2026
    // completion times), then the transcript, the degraded derivative, and
    // finally the metadata synthesized at recognition.
    expect(
      manifest.map((c) => `${c.kind}:${c.role ?? c.producer ?? ''}`),
    ).toEqual([
      'execution:omni_transcribe',
      'execution:omni_degrade_video',
      'policy_result:transcript',
      'derived_media:degraded',
      'metadata:',
    ]);

    // Ordering is what decides which rows the cap silently withholds:
    // insertion order would hide the most recent processing — exactly the
    // knowledge most likely to answer the request — behind rows the
    // selector has no way to know were dropped.
    const capped = await recallService(
      recallConfig({
        sideQuery: {
          ...DEFAULT_OMNI_MEMORY_CONFIG.recall.sideQuery,
          maxCandidateEntries: 2,
        },
      }),
    ).candidateSummaries([resourceId]);
    expect(capped).toEqual(manifest.slice(0, 2));
  });

  it('caps the manifest at maxCandidateEntries deterministically', async () => {
    const source = await recognizeMovie();
    await commitDegrade(source);
    await commitTranscript(source);
    const resourceId = bindSource(source);
    const config = recallConfig({
      sideQuery: {
        ...DEFAULT_OMNI_MEMORY_CONFIG.recall.sideQuery,
        maxCandidateEntries: 2,
      },
    });

    const first = await recallService(config).candidateSummaries([resourceId]);
    const second = await recallService(config).candidateSummaries([resourceId]);

    expect(first).toHaveLength(2);
    expect(second).toEqual(first);
  });

  it('validates handles like recall(): an unknown handle rejects', async () => {
    await expect(
      recallService().candidateSummaries(['media-9-ffff']),
    ).rejects.toMatchObject({ reason: 'unknown_resource' });
  });

  it('materializes exactly the selected entries via the unified protocol', async () => {
    const source = await recognizeMovie();
    const { degradedPath } = await commitDegrade(source);
    await commitTranscript(source);
    const resourceId = bindSource(source);
    const svc = recallService();
    const manifest = await svc.candidateSummaries([resourceId]);
    const transcript = manifest.find((c) => c.role === 'transcript')!;
    const degraded = manifest.find((c) => c.role === 'degraded')!;

    const result = await svc.recallSelection(
      [resourceId],
      [transcript.entryId, degraded.entryId],
    );

    expect(result.entries.map((e) => e.entryId).sort()).toEqual(
      [transcript.entryId, degraded.entryId].sort(),
    );
    expect(result.status).not.toBe('miss');
    // The selected derived artifact is session-bound like an active
    // recall would bind it.
    const degradedEntry = result.entries.find(
      (e) => e.entryId === degraded.entryId,
    )!;
    expect(degradedEntry.resourceId).toBeDefined();
    expect(registry.resolve(degradedEntry.resourceId!)?.fileRef).toBe(
      degradedPath,
    );
  });

  it('materializes a repeated pick once', async () => {
    const source = await recognizeMovie();
    await commitTranscript(source);
    const resourceId = bindSource(source);
    const svc = recallService();
    const manifest = await svc.candidateSummaries([resourceId]);
    const entryId = manifest[0]!.entryId;

    const result = await svc.recallSelection([resourceId], [entryId, entryId]);

    // One pick, not two copies spending the budget on the same content.
    expect(result.entries.map((e) => e.entryId)).toEqual([entryId]);
  });

  it('rejects an entryId outside the manifest wholesale', async () => {
    const source = await recognizeMovie();
    await commitTranscript(source);
    const resourceId = bindSource(source);
    const svc = recallService();
    const manifest = await svc.candidateSummaries([resourceId]);

    await expect(
      svc.recallSelection(
        [resourceId],
        [manifest[0]!.entryId, 'entry-not-in-manifest'],
      ),
    ).rejects.toMatchObject({ reason: 'invalid_selection' });
  });

  it('rejects a real entryId that sits beyond the manifest cap', async () => {
    const source = await recognizeMovie();
    await commitDegrade(source);
    await commitTranscript(source);
    const resourceId = bindSource(source);
    const config = recallConfig({
      sideQuery: {
        ...DEFAULT_OMNI_MEMORY_CONFIG.recall.sideQuery,
        maxCandidateEntries: 2,
      },
    });
    const svc = recallService(config);
    const shown = await svc.candidateSummaries([resourceId]);
    const hidden = (await recallService().candidateSummaries([resourceId])).at(
      -1,
    )!.entryId;
    expect(shown.map((c) => c.entryId)).not.toContain(hidden);

    // The manifest IS the budget: validating against the uncapped candidate
    // set would let a selector materialize entries this turn never showed
    // it — a manifest cached from an earlier turn, or a guessed id that
    // happens to exist — quietly spending context on rows the operator's
    // cap had ruled out.
    await expect(
      svc.recallSelection([resourceId], [hidden]),
    ).rejects.toMatchObject({ reason: 'invalid_selection' });
  });

  it('rejects a selection over maxSelectedEntries wholesale', async () => {
    const source = await recognizeMovie();
    await commitDegrade(source);
    await commitTranscript(source);
    const resourceId = bindSource(source);
    const config = recallConfig({
      sideQuery: {
        ...DEFAULT_OMNI_MEMORY_CONFIG.recall.sideQuery,
        maxSelectedEntries: 1,
      },
    });
    const svc = recallService(config);
    const manifest = await svc.candidateSummaries([resourceId]);

    await expect(
      svc.recallSelection(
        [resourceId],
        manifest.slice(0, 2).map((c) => c.entryId),
      ),
    ).rejects.toMatchObject({ reason: 'invalid_selection' });
  });
});
