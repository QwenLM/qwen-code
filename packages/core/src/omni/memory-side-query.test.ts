/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import {
  DEFAULT_OMNI_MEMORY_CONFIG,
  MediaMemoryService,
  MediaResourceRegistry,
} from '../services/media-memory/index.js';
import { formatResourceHandleText } from './disclosure.js';
import {
  extractRequestResourceIds,
  formatOmniMemorySideQueryReminder,
  runOmniMemorySideQuery,
} from './memory-side-query.js';

vi.mock('../utils/sideQuery.js', () => ({ runSideQuery: vi.fn() }));
import { runSideQuery } from '../utils/sideQuery.js';

const runSideQueryMock = vi.mocked(runSideQuery);

describe('omni memory sideQuery selector', () => {
  let tmpDir: string;
  let registry: MediaResourceRegistry;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-sidequery-'));
    registry = new MediaResourceRegistry();
    runSideQueryMock.mockReset();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function memoryConfig(mode: 'active' | 'sideQuery') {
    return {
      ...DEFAULT_OMNI_MEMORY_CONFIG,
      recall: { ...DEFAULT_OMNI_MEMORY_CONFIG.recall, mode },
    };
  }

  function sideQueryConfig(mode: 'active' | 'sideQuery' = 'sideQuery'): Config {
    return {
      getOmniMemoryConfig: () => memoryConfig(mode),
      getOmniMediaResourceRegistry: () => registry,
      storage: { getQwenDir: () => tmpDir },
      getToolRegistry: () => ({ getTool: () => undefined }),
      getOmniPolicyToolsSettings: () => undefined,
    } as unknown as Config;
  }

  /** Record one image into the store and bind its session handle. */
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
    return registry.bind({
      ...binding!,
      fileRef: path.join(tmpDir, 'pic.png'),
      mediaType: 'image',
    }).resourceId;
  }

  describe('extractRequestResourceIds', () => {
    it('collects issued handles from annotation lines, deduplicated', async () => {
      const resourceId = await recordAndBind();
      const parts = [
        'plain user text',
        { text: formatResourceHandleText('pic.png', resourceId) },
        {
          text:
            'context\n' +
            formatResourceHandleText('pic.png', resourceId) +
            '\nmore',
        },
      ];
      expect(extractRequestResourceIds(sideQueryConfig(), parts)).toEqual([
        resourceId,
      ]);
    });

    it('ignores handles this session never issued', () => {
      const parts = [
        { text: formatResourceHandleText('ghost.png', 'media-7-abcdef01') },
      ];
      expect(extractRequestResourceIds(sideQueryConfig(), parts)).toEqual([]);
    });
  });

  describe('runOmniMemorySideQuery', () => {
    it('is a no-op in active mode (D10 mutual exclusion)', async () => {
      const resourceId = await recordAndBind();
      const outcome = await runOmniMemorySideQuery({
        config: sideQueryConfig('active'),
        requestParts: [
          { text: formatResourceHandleText('pic.png', resourceId) },
        ],
      });
      expect(outcome).toBeNull();
      expect(runSideQueryMock).not.toHaveBeenCalled();
    });

    it('is a no-op when the request carries no handles', async () => {
      const outcome = await runOmniMemorySideQuery({
        config: sideQueryConfig(),
        requestParts: ['just text'],
      });
      expect(outcome).toBeNull();
      expect(runSideQueryMock).not.toHaveBeenCalled();
    });

    it('materializes the selector picks and formats the reminder', async () => {
      const resourceId = await recordAndBind();
      runSideQueryMock.mockImplementation((async (
        _config: unknown,
        options: { contents: Content[] },
      ) => {
        const payload = JSON.parse(
          (options.contents[0]!.parts![0] as { text: string }).text,
        );
        expect(payload.request).toContain('what size is this image');
        // Selector-visible manifest: summaries only, no paths.
        expect(JSON.stringify(payload.candidates)).not.toContain(tmpDir);
        return { entryIds: [payload.candidates[0].entryId] };
      }) as never);

      const outcome = await runOmniMemorySideQuery({
        config: sideQueryConfig(),
        requestParts: [
          'what size is this image?',
          { text: formatResourceHandleText('pic.png', resourceId) },
        ],
      });

      expect(outcome?.result).not.toBeNull();
      expect(outcome!.result!.entries).toHaveLength(1);
      expect(outcome!.result!.entries[0]!.kind).toBe('metadata');
      const reminder = formatOmniMemorySideQueryReminder(outcome!.result!);
      expect(reminder).toContain('【媒体记忆】');
      expect(reminder).toContain(outcome!.result!.entries[0]!.entryId);
      expect(reminder).not.toContain(tmpDir);
    });

    it('degrades to an empty recall with a reason when the selector fails', async () => {
      const resourceId = await recordAndBind();
      runSideQueryMock.mockRejectedValue(new Error('boom'));

      const outcome = await runOmniMemorySideQuery({
        config: sideQueryConfig(),
        requestParts: [
          { text: formatResourceHandleText('pic.png', resourceId) },
        ],
      });

      expect(outcome).toMatchObject({
        result: null,
        reason: expect.stringContaining('selector_failed'),
      });
    });

    it('treats an empty selection as nothing to inject', async () => {
      const resourceId = await recordAndBind();
      runSideQueryMock.mockResolvedValue({ entryIds: [] } as never);

      const outcome = await runOmniMemorySideQuery({
        config: sideQueryConfig(),
        requestParts: [
          { text: formatResourceHandleText('pic.png', resourceId) },
        ],
      });

      expect(outcome).toMatchObject({
        result: null,
        reason: 'selector_selected_nothing',
      });
    });

    it('skips the selector entirely when memory has no candidates', async () => {
      // Bind a handle whose version was never persisted (empty store).
      const resourceId = registry.bind({
        fileId: 'f1',
        fileVersionId: 'v1',
        rootFileId: 'f1',
        fileRef: path.join(tmpDir, 'ghost.png'),
        mediaType: 'image',
      }).resourceId;

      const outcome = await runOmniMemorySideQuery({
        config: sideQueryConfig(),
        requestParts: [
          { text: formatResourceHandleText('ghost.png', resourceId) },
        ],
      });

      expect(outcome).toMatchObject({ result: null, reason: 'no_candidates' });
      expect(runSideQueryMock).not.toHaveBeenCalled();
    });
  });
});
