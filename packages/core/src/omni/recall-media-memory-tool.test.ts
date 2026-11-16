/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../config/config.js';
import { ToolNames } from '../tools/tool-names.js';
import {
  DEFAULT_OMNI_MEMORY_CONFIG,
  MediaMemoryService,
  MediaResourceRegistry,
} from '../services/media-memory/index.js';
import {
  buildMediaMemoryRecallAdvisor,
  reanchorRememberedMedia,
} from './memory-recall.js';
import {
  OmniRecallMediaMemoryTool,
  type OmniRecallMediaMemoryParams,
} from './recall-media-memory-tool.js';

describe('OmniRecallMediaMemoryTool', () => {
  let tmpDir: string;
  let registry: MediaResourceRegistry;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-recall-tool-'));
    registry = new MediaResourceRegistry();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function toolConfig(overrides?: Partial<Record<string, unknown>>): Config {
    return {
      getOmniMemoryConfig: () => DEFAULT_OMNI_MEMORY_CONFIG,
      getOmniMediaResourceRegistry: () => registry,
      storage: { getQwenDir: () => tmpDir },
      getToolRegistry: () => ({ getTool: () => undefined }),
      getOmniPolicyToolsSettings: () => undefined,
      ...overrides,
    } as unknown as Config;
  }

  const newTool = (overrides?: Partial<Record<string, unknown>>) =>
    new OmniRecallMediaMemoryTool(toolConfig(overrides));

  const recall = (params: OmniRecallMediaMemoryParams, tool = newTool()) =>
    tool.build(params).execute(new AbortController().signal);

  /** Bind session handle `n` to an image file with no persistent record. */
  const bindImage = (n: number, fileRef: string) =>
    registry.bind({
      fileId: `f${n}`,
      fileVersionId: `v${n}`,
      rootFileId: `f${n}`,
      fileRef,
      mediaType: 'image',
    }).resourceId;

  /** Record one image file into the persistent store and bind its session
   * handle, mirroring what a delivery does. */
  async function recordAndBind(): Promise<string> {
    const memory = new MediaMemoryService(path.join(tmpDir, 'omni'));
    const binding = await memory.recordFileRecognized({
      fileRef: path.join(tmpDir, 'pic.png'),
      sha256: 'a'.repeat(64),
      mediaType: 'image',
      metadata: { width: 32, height: 32 },
      sizeBytes: 1234,
      mimeType: 'image/png',
      origin: 'user',
      source: { protocol: 'local', locator: 'pic.png' },
      recognition: {
        ingestionConfigHash: '',
        detectorVersion: 'omni-sniff-ffprobe/1',
        probeStatus: 'complete',
      },
    });
    expect(binding).toBeDefined();
    return registry.bind({
      ...binding!,
      fileRef: path.join(tmpDir, 'pic.png'),
      mediaType: 'image',
    }).resourceId;
  }

  it('rejects a request naming more handles than maxFilesPerCall', () => {
    const max = DEFAULT_OMNI_MEMORY_CONFIG.recall.active.maxFilesPerCall;
    const resourceIds = Array.from({ length: max + 1 }, (_, i) => `m-${i}`);
    expect(() => newTool().build({ resourceIds, query: 'q' })).toThrow(
      /maxFilesPerCall/,
    );
  });

  it('rejects an empty resourceIds list at the schema layer', () => {
    expect(() => newTool().build({ resourceIds: [], query: 'q' })).toThrow();
  });

  it('admits a full absolute path at the schema layer (R3-7)', () => {
    // The path form passes a whole absolute path, not a ~16-char handle. An
    // over-tight maxLength would make Ajv reject the very path the annotation
    // displayed — before resolution, with no shorter id to retry. A 301-char
    // path clears the schema (maxLength 4096); RECALL then rejects it as an
    // unknown reference, not the schema layer.
    const longPath = '/' + 'x'.repeat(300);
    expect(() =>
      newTool().build({ resourceIds: [longPath], query: 'q' }),
    ).not.toThrow();
  });

  it('counts DISTINCT files, not raw references, against maxFilesPerCall (R3-9)', () => {
    // One file is addressable two ways — its 【媒体路径】 path and its
    // 【媒体资源】 handle. Naming file1 by BOTH plus file2 by handle is 3
    // references but 2 DISTINCT files, so with maxFilesPerCall: 2 it must
    // PASS. The old raw-reference count charged 3 > 2 and wrongly rejected
    // it; resolveBindings dedups per binding downstream, so the cap must
    // count the same unit.
    const file1 = path.join(tmpDir, 'one.png');
    const handle1 = bindImage(1, file1);
    const handle2 = bindImage(2, path.join(tmpDir, 'two.png'));
    const tool = newTool({
      getOmniMemoryConfig: () => ({
        ...DEFAULT_OMNI_MEMORY_CONFIG,
        recall: {
          ...DEFAULT_OMNI_MEMORY_CONFIG.recall,
          active: {
            ...DEFAULT_OMNI_MEMORY_CONFIG.recall.active,
            maxFilesPerCall: 2,
          },
        },
      }),
    });
    // [handle1, path-of-file1, handle2] = 3 references, 2 distinct files.
    expect(() =>
      tool.build({ resourceIds: [handle1, file1, handle2], query: 'q' }),
    ).not.toThrow();
    // A third DISTINCT file still trips the cap.
    const handle3 = bindImage(3, path.join(tmpDir, 'three.png'));
    expect(() =>
      tool.build({ resourceIds: [handle1, handle2, handle3], query: 'q' }),
    ).toThrow(/maxFilesPerCall/);
  });

  it('returns invalid_tool_params for a handle this session never issued', async () => {
    const result = await recall({
      resourceIds: ['media-99-deadbeef'],
      query: 'anything',
    });
    expect(result.error?.type).toBe('invalid_tool_params');
    expect(result.llmContent).toContain('unknown_resource');
  });

  it('recalls the recorded metadata entry for a bound handle', async () => {
    const resourceId = await recordAndBind();
    const result = await recall({
      resourceIds: [resourceId],
      query: 'image dimensions',
    });
    expect(result.error).toBeUndefined();
    const payload = JSON.parse(result.llmContent as string);
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0].current).toBe(true);
    expect(
      payload.entries.some(
        (e: { kind: string; content?: string }) =>
          e.kind === 'metadata' && e.content?.includes('"width":32'),
      ),
    ).toBe(true);
    // No real path anywhere in the model-visible payload (M §5.2).
    expect(result.llmContent as string).not.toContain(tmpDir);
  });

  it('degrades to a plain miss when the store has never been written', async () => {
    const resourceId = bindImage(1, path.join(tmpDir, 'ghost.png'));
    const result = await recall({ resourceIds: [resourceId], query: 'q' });
    expect(result.error).toBeUndefined();
    expect(JSON.parse(result.llmContent as string).status).toBe('miss');
  });

  it('reports media memory unavailable on a config without memory', async () => {
    const result = await recall(
      { resourceIds: ['media-1-ab'], query: 'q' },
      newTool({ getOmniMemoryConfig: () => undefined }),
    );
    expect(result.error?.type).toBe('execution_failed');
  });
});

describe('reanchorRememberedMedia', () => {
  let tmpDir: string;
  let registry: MediaResourceRegistry;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-reanchor-'));
    registry = new MediaResourceRegistry();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const cfg = (overrides?: Record<string, unknown>): Config =>
    ({
      storage: { getQwenDir: () => tmpDir },
      getOmniMemoryConfig: () => DEFAULT_OMNI_MEMORY_CONFIG,
      getOmniMediaResourceRegistry: () => registry,
      ...overrides,
    }) as unknown as Config;

  /** Record a file, then delete its bytes. */
  async function rememberThenDelete(): Promise<string> {
    const filePath = path.join(tmpDir, 'gone.mkv');
    await fs.writeFile(filePath, 'bytes');
    const memory = new MediaMemoryService(path.join(tmpDir, 'omni'));
    await memory.recordFileRecognized({
      fileRef: filePath,
      sha256: 'f'.repeat(64),
      mediaType: 'video',
      metadata: { durationMs: 1000 },
      sizeBytes: 5,
      mimeType: 'video/x-matroska',
      origin: 'user',
      source: { protocol: 'local', locator: 'gone.mkv' },
      recognition: {
        ingestionConfigHash: '',
        detectorVersion: 'omni-sniff-ffprobe/1',
        probeStatus: 'complete',
      },
    });
    await fs.rm(filePath);
    return filePath;
  }

  it('mints a handle for a remembered file whose bytes are gone', async () => {
    const filePath = await rememberThenDelete();

    const anchored = await reanchorRememberedMedia(cfg(), filePath);

    expect(anchored).toBeDefined();
    // The handle resolves like any delivered one, so recall accepts it —
    // the whole point: a deleted file's memory stays reachable instead of
    // being stranded forever.
    const binding = registry.resolve(anchored!.resourceId);
    expect(binding).toMatchObject({ fileRef: filePath, mediaType: 'video' });
    expect(anchored!.annotation).toContain('【媒体资源】gone.mkv：');
    expect(anchored!.annotation).toContain(anchored!.resourceId);
    // Never the real path — only the basename the user already typed.
    expect(anchored!.annotation).not.toContain(tmpDir);
  });

  it('returns undefined for a path memory has never seen', async () => {
    await rememberThenDelete();
    await expect(
      reanchorRememberedMedia(cfg(), path.join(tmpDir, 'stranger.mkv')),
    ).resolves.toBeUndefined();
  });

  it('returns undefined when memory is not configured', async () => {
    const filePath = await rememberThenDelete();
    const noMemory = cfg({ getOmniMemoryConfig: () => undefined });
    await expect(
      reanchorRememberedMedia(noMemory, filePath),
    ).resolves.toBeUndefined();
  });
});

describe('buildMediaMemoryRecallAdvisor', () => {
  /** An advisor over `enabled` (modelAccess on) and `registered` (present in
   * the tool registry) tools; registered defaults to the enabled set. */
  function advisorFor(enabled: string[], registered = enabled) {
    return buildMediaMemoryRecallAdvisor({
      getToolRegistry: () => ({
        getTool: (name: string) =>
          registered.includes(name) ? { name } : undefined,
      }),
      getOmniPolicyToolsSettings: () =>
        Object.fromEntries(
          enabled.map((name) => [name, { modelAccess: { enabled: true } }]),
        ),
    } as unknown as Config);
  }

  const gap = (channels: string[], reason = 'not_processed') =>
    ({ scope: {}, channels, reason }) as never;
  const videoGap = (resourceId: string, channels: string[], reason?: string) =>
    ({ resourceId, mediaType: 'video', gap: gap(channels, reason) }) as const;

  it('suggests only registered, model-accessible tools', () => {
    const advise = advisorFor(
      [ToolNames.OMNI_EXTRACT_KEYFRAMES],
      [ToolNames.OMNI_EXTRACT_KEYFRAMES, ToolNames.OMNI_EXTRACT_AUDIO],
    );
    const actions = advise(videoGap('media-1-ab', ['visual', 'speech_text']));
    // extract-audio is registered but not opened to the model; the
    // advisor must not steer the model into a gated call.
    expect(actions).toEqual([
      {
        toolName: ToolNames.OMNI_EXTRACT_KEYFRAMES,
        resourceId: 'media-1-ab',
        arguments: {},
        reason: expect.stringContaining('keyframes'),
      },
    ]);
  });

  it('never suggests a tool that is not registered in this session', () => {
    // modelAccess says what the operator ALLOWS; the tool registry says what
    // exists this turn (omni tools are absent when omni is off, ffmpeg is
    // missing, or under a tool filter). Advising an unregistered tool spends
    // the model's next turn on a "tool not found" dead end recall invented.
    const advise = advisorFor([ToolNames.OMNI_EXTRACT_KEYFRAMES], []);
    expect(advise(videoGap('media-6-ab', ['visual']))).toEqual([]);
  });

  it('suggests transcription for an audio speech_text gap', () => {
    const advise = advisorFor([ToolNames.OMNI_TRANSCRIBE_AUDIO]);
    const actions = advise({
      resourceId: 'media-2-cd',
      mediaType: 'audio',
      gap: gap(['speech_text']),
    });
    expect(actions.map((a) => a.toolName)).toEqual([
      ToolNames.OMNI_TRANSCRIBE_AUDIO,
    ]);
  });

  it('does not re-suggest audio extraction once the track exists', () => {
    // The payload that RETURNS the extracted audio still reports the video's
    // speech_text channel as open. Matching that channel made the advisor
    // suggest extracting the track again in the very same payload; the model
    // is supposed to chain to transcription instead.
    const advise = advisorFor([
      ToolNames.OMNI_EXTRACT_AUDIO,
      ToolNames.OMNI_TRANSCRIBE_AUDIO,
    ]);
    expect(advise(videoGap('media-4-aa', ['speech_text']))).toEqual([]);
    // A wholly unprocessed video still gets the extraction step.
    expect(
      advise(videoGap('media-4-aa', ['acoustic', 'speech_text'])).map(
        (a) => a.toolName,
      ),
    ).toEqual([ToolNames.OMNI_EXTRACT_AUDIO]);
  });

  it('never suggests work that cannot close a sampled-coverage gap', () => {
    // Keyframes deliberately never claim complete visual coverage, so
    // suggesting keyframe extraction against `partial_coverage` would
    // advise the same step forever.
    const advise = advisorFor([ToolNames.OMNI_EXTRACT_KEYFRAMES]);
    expect(
      advise(videoGap('media-5-bb', ['visual'], 'partial_coverage')),
    ).toEqual([]);
  });

  it('never suggests anything for an unavailable artifact', () => {
    const advise = advisorFor([ToolNames.OMNI_EXTRACT_KEYFRAMES]);
    expect(
      advise(videoGap('media-3-ef', ['visual'], 'artifact_unavailable')),
    ).toEqual([]);
  });
});
