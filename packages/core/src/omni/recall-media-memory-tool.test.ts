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
import { OmniRecallMediaMemoryTool } from './recall-media-memory-tool.js';

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
    const tool = new OmniRecallMediaMemoryTool(toolConfig());
    const max = DEFAULT_OMNI_MEMORY_CONFIG.recall.active.maxFilesPerCall;
    const resourceIds = Array.from({ length: max + 1 }, (_, i) => `m-${i}`);
    expect(() => tool.build({ resourceIds, query: 'q' })).toThrow(
      /maxFilesPerCall/,
    );
  });

  it('rejects an empty resourceIds list at the schema layer', () => {
    const tool = new OmniRecallMediaMemoryTool(toolConfig());
    expect(() => tool.build({ resourceIds: [], query: 'q' })).toThrow();
  });

  it('returns invalid_tool_params for a handle this session never issued', async () => {
    const tool = new OmniRecallMediaMemoryTool(toolConfig());
    const invocation = tool.build({
      resourceIds: ['media-99-deadbeef'],
      query: 'anything',
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error?.type).toBe('invalid_tool_params');
    expect(result.llmContent).toContain('unknown_resource');
  });

  it('recalls the recorded metadata entry for a bound handle', async () => {
    const resourceId = await recordAndBind();
    const tool = new OmniRecallMediaMemoryTool(toolConfig());
    const invocation = tool.build({
      resourceIds: [resourceId],
      query: 'image dimensions',
    });
    const result = await invocation.execute(new AbortController().signal);
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
    const resourceId = registry.bind({
      fileId: 'f1',
      fileVersionId: 'v1',
      rootFileId: 'f1',
      fileRef: path.join(tmpDir, 'ghost.png'),
      mediaType: 'image',
    }).resourceId;
    const tool = new OmniRecallMediaMemoryTool(toolConfig());
    const invocation = tool.build({ resourceIds: [resourceId], query: 'q' });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(JSON.parse(result.llmContent as string).status).toBe('miss');
  });

  it('reports media memory unavailable on a config without memory', async () => {
    const tool = new OmniRecallMediaMemoryTool(
      toolConfig({ getOmniMemoryConfig: () => undefined }),
    );
    const invocation = tool.build({ resourceIds: ['media-1-ab'], query: 'q' });
    const result = await invocation.execute(new AbortController().signal);
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
    // which is the whole point: the memory of a deleted file stays
    // reachable instead of being stranded forever.
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
    await expect(
      reanchorRememberedMedia(
        cfg({ getOmniMemoryConfig: () => undefined }),
        filePath,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('buildMediaMemoryRecallAdvisor', () => {
  function advisorConfig(params: {
    registered: string[];
    enabled: string[];
  }): Config {
    return {
      getToolRegistry: () => ({
        getTool: (name: string) =>
          params.registered.includes(name) ? { name } : undefined,
      }),
      getOmniPolicyToolsSettings: () =>
        Object.fromEntries(
          params.enabled.map((name) => [
            name,
            { modelAccess: { enabled: true } },
          ]),
        ),
    } as unknown as Config;
  }

  const gap = (channels: string[], reason = 'not_processed') =>
    ({ scope: {}, channels, reason }) as never;

  it('suggests only registered, model-accessible tools', () => {
    const advise = buildMediaMemoryRecallAdvisor(
      advisorConfig({
        registered: [
          ToolNames.OMNI_EXTRACT_KEYFRAMES,
          ToolNames.OMNI_EXTRACT_AUDIO,
        ],
        enabled: [ToolNames.OMNI_EXTRACT_KEYFRAMES],
      }),
    );
    const actions = advise({
      resourceId: 'media-1-ab',
      mediaType: 'video',
      gap: gap(['visual', 'speech_text']),
    });
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

  it('suggests transcription for an audio speech_text gap', () => {
    const advise = buildMediaMemoryRecallAdvisor(
      advisorConfig({
        registered: [ToolNames.OMNI_TRANSCRIBE_AUDIO],
        enabled: [ToolNames.OMNI_TRANSCRIBE_AUDIO],
      }),
    );
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
    // The payload that RETURNS the extracted audio still reports the
    // video's speech_text channel as open. Matching that channel made the
    // advisor suggest extracting the track again in the very same payload;
    // the model is supposed to chain to transcription instead.
    const advise = buildMediaMemoryRecallAdvisor(
      advisorConfig({
        registered: [
          ToolNames.OMNI_EXTRACT_AUDIO,
          ToolNames.OMNI_TRANSCRIBE_AUDIO,
        ],
        enabled: [
          ToolNames.OMNI_EXTRACT_AUDIO,
          ToolNames.OMNI_TRANSCRIBE_AUDIO,
        ],
      }),
    );
    expect(
      advise({
        resourceId: 'media-4-aa',
        mediaType: 'video',
        gap: gap(['speech_text']),
      }),
    ).toEqual([]);
    // A wholly unprocessed video still gets the extraction step.
    expect(
      advise({
        resourceId: 'media-4-aa',
        mediaType: 'video',
        gap: gap(['acoustic', 'speech_text']),
      }).map((a) => a.toolName),
    ).toEqual([ToolNames.OMNI_EXTRACT_AUDIO]);
  });

  it('never suggests work that cannot close a sampled-coverage gap', () => {
    // Keyframes deliberately never claim complete visual coverage, so
    // suggesting keyframe extraction against `partial_coverage` would
    // advise the same step forever.
    const advise = buildMediaMemoryRecallAdvisor(
      advisorConfig({
        registered: [ToolNames.OMNI_EXTRACT_KEYFRAMES],
        enabled: [ToolNames.OMNI_EXTRACT_KEYFRAMES],
      }),
    );
    expect(
      advise({
        resourceId: 'media-5-bb',
        mediaType: 'video',
        gap: gap(['visual'], 'partial_coverage'),
      }),
    ).toEqual([]);
  });

  it('never suggests anything for an unavailable artifact', () => {
    const advise = buildMediaMemoryRecallAdvisor(
      advisorConfig({
        registered: [ToolNames.OMNI_EXTRACT_KEYFRAMES],
        enabled: [ToolNames.OMNI_EXTRACT_KEYFRAMES],
      }),
    );
    expect(
      advise({
        resourceId: 'media-3-ef',
        mediaType: 'video',
        gap: gap(['visual'], 'artifact_unavailable'),
      }),
    ).toEqual([]);
  });
});
