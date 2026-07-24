/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import type { Config } from '../config/config.js';
import { processSingleFileContent } from './fileUtils.js';
import { getMediaMemory } from '../memory/media/media-memory-store.js';
import { hashFile } from './media/probe.js';

describe('processSingleFileContent: memory-first for oversized media', () => {
  let tempRootDir: string;
  let runtimeDir: string;
  let videoPath: string;
  let config: Config;
  const originalRuntime = process.env['QWEN_RUNTIME_DIR'];

  beforeEach(async () => {
    tempRootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lm-root-'));
    runtimeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lm-rt-'));
    process.env['QWEN_RUNTIME_DIR'] = runtimeDir;
    videoPath = path.join(tempRootDir, 'big.mp4');
    // 11MB dummy > the 10MB inline read limit.
    await fsp.writeFile(videoPath, Buffer.alloc(11 * 1024 * 1024, 1));
    config = { getTargetDir: () => tempRootDir } as unknown as Config;
  });

  afterEach(async () => {
    if (originalRuntime === undefined) delete process.env['QWEN_RUNTIME_DIR'];
    else process.env['QWEN_RUNTIME_DIR'] = originalRuntime;
    await fsp.rm(tempRootDir, { recursive: true, force: true });
    await fsp.rm(runtimeDir, { recursive: true, force: true });
  });

  it('points to the media tools (not a bare error) when nothing is in memory', async () => {
    const result = await processSingleFileContent(videoPath, config);
    expect(result.error).toBeUndefined();
    const text = result.llmContent as string;
    expect(text).toContain('too large to read inline');
    expect(text).toContain('NO prior understanding');
    expect(text).toContain('media_dispatch');
  });

  it('surfaces the prior understanding when the file is already in memory', async () => {
    const hash = await hashFile(videoPath);
    await getMediaMemory().put({
      hash,
      modality: 'video',
      path: videoPath,
      summary: 'a demo reel',
      body: 'The video shows five songs across multiple genres.',
      readerId: 'media-dispatch',
    });

    const result = await processSingleFileContent(videoPath, config);
    expect(result.error).toBeUndefined();
    const text = result.llmContent as string;
    expect(text).toContain('media memory already has');
    expect(text).toContain('five songs across multiple genres');
  });
});
