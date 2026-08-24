/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Part } from '@google/genai';
import type { Config } from '../config/config.js';
import {
  finalizeToolResponses,
  type ToolResponseBudgetEntry,
} from './tool-response-finalizer.js';

describe('tool response finalization persistence', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true })),
    );
  });

  async function run(callIds: string[]) {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'tool-response-finalizer-'),
    );
    tempDirs.push(tempDir);
    let bytesWritten = 0;
    const config = {
      getToolOutputBatchBudget: () => 3,
      getToolResultBytesWritten: () => bytesWritten,
      trackToolResultBytes: (bytes: number) => {
        bytesWritten += bytes;
      },
      getTruncateToolOutputThreshold: () => 100,
      getTruncateToolOutputLines: () => 100,
      storage: {
        getToolResultsDir: () => tempDir,
        getProjectTempDir: () => tempDir,
      },
    } as unknown as Config;
    const contents = callIds.map((_, index) =>
      String.fromCharCode(97 + index).repeat(200),
    );
    const entries: ToolResponseBudgetEntry[] = callIds.map((callId, index) => ({
      callId,
      toolName: 'shell',
      responseParts: [
        {
          functionResponse: {
            id: callId,
            name: 'shell',
            response: { output: contents[index] },
          },
        } satisfies Part,
      ],
    }));

    const finalized = await finalizeToolResponses(config, entries);
    const outputFiles = finalized.flatMap(
      (entry) => entry.persistedOutputFiles ?? [],
    );
    const persistedContents = await Promise.all(
      outputFiles.map((outputFile) => fs.readFile(outputFile, 'utf8')),
    );

    return { bytesWritten, contents, outputFiles, persistedContents };
  }

  it('does not overwrite a natural suffix id when duplicate ids are persisted', async () => {
    const result = await run(['call', 'call', 'call-1']);

    expect(new Set(result.outputFiles).size).toBe(3);
    expect(result.persistedContents).toEqual(result.contents);
    expect(result.bytesWritten).toBe(600);
  });

  it('does not overwrite call ids that normalize to the same basename', async () => {
    const result = await run(['dir/call', 'call']);

    expect(new Set(result.outputFiles).size).toBe(2);
    expect(result.persistedContents).toEqual(result.contents);
    expect(result.bytesWritten).toBe(400);
  });
});
