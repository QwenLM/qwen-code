/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const templatesDir = path.join(root, 'packages', 'web-templates');
const documentEntry = path.join(
  templatesDir,
  'src',
  'export-html',
  'src',
  'document-main.tsx',
);
// The build consumes the prebuilt web-shell transcript entry; without it
// the lane cannot run at all.
const prebuiltTranscript = path.join(
  root,
  'packages',
  'web-shell',
  'dist',
  'transcript.js',
);

describe('export-html import.meta guard', () => {
  // Under format:'iife' esbuild lowers import.meta to {}, so a stray
  // import.meta.env read would throw in every exported document at runtime.
  // The build tolerates exactly the guarded read inside the prebuilt
  // transcript entry and must fail on any other site.
  it('fails the build when an import.meta read lands outside the tolerated transcript entry', () => {
    if (!existsSync(prebuiltTranscript)) {
      console.warn(
        'skipping: packages/web-shell/dist/transcript.js is not built',
      );
      return;
    }
    const original = readFileSync(documentEntry, 'utf8');
    writeFileSync(
      documentEntry,
      `${original}\nglobalThis.__importMetaProbe = import.meta.url;\n`,
    );
    try {
      const result = spawnSync(
        process.execPath,
        ['src/export-html/build.mjs'],
        { cwd: templatesDir, encoding: 'utf8', timeout: 120_000 },
      );
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status).not.toBe(0);
      expect(output).toContain('unexpected import.meta use');
    } finally {
      writeFileSync(documentEntry, original);
    }
  });
});
