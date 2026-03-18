/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('imageMessageUtils browser bundle', () => {
  it('bundles without resolving node-only qwen-code-core modules', async () => {
    const entryPoint = fileURLToPath(
      new URL('./imageMessageUtils.ts', import.meta.url),
    );

    await expect(
      build({
        entryPoints: [entryPoint],
        bundle: true,
        format: 'esm',
        logLevel: 'silent',
        platform: 'browser',
        write: false,
      }),
    ).resolves.toMatchObject({
      outputFiles: expect.any(Array),
    });
  });
});
