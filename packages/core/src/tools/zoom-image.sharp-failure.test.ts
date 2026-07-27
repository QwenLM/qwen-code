/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import { ToolErrorType } from './tool-error.js';
import { ZoomImageTool } from './zoom-image.js';

// Simulate a host where sharp's native binary is missing or incompatible
// (e.g. musl Linux without @img/sharp-linuxmusl-x64): the dynamic import in
// execute() must reject and surface a recoverable tool error. Kept in its own
// file because vi.mock('sharp') is file-scoped and would break the real-sharp
// fixtures used by zoom-image.test.ts.
vi.mock('sharp', () => {
  throw new Error('sharp native binary missing');
});

describe('ZoomImageTool when sharp fails to load', () => {
  let root: string;
  let tool: ZoomImageTool;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'zoom-image-sharp-fail-'));
    const config = {
      getFileService: () => new FileDiscoveryService(root),
      getTargetDir: () => root,
      getEffectiveInputModalities: () => ({ image: true }),
    } as unknown as Config;
    tool = new ZoomImageTool(config);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns a recoverable error when the sharp module cannot be imported', async () => {
    const result = await tool
      .build({
        file_path: path.join(root, 'image.png'),
        x1: 0,
        y1: 0,
        x2: 1000,
        y2: 1000,
      })
      .execute(new AbortController().signal);

    expect(result.error).toMatchObject({
      type: ToolErrorType.READ_CONTENT_FAILURE,
    });
    expect(result.llmContent).toMatch(/sharp/i);
  });
});
