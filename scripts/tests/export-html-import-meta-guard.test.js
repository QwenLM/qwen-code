/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findUnexpectedImportMeta,
  TOLERATED_TRANSCRIPT_IMPORT_META_READS,
} from '../../packages/web-templates/src/export-html/import-meta-guard.mjs';

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
const exportDist = path.join(templatesDir, 'src', 'export-html', 'dist');
const prebuiltTranscript = path.join(
  root,
  'packages',
  'web-shell',
  'dist',
  'transcript.js',
);

describe('findUnexpectedImportMeta', () => {
  const at = (file, line = 1, column = 1) => ({
    id: 'empty-import-meta',
    location: { file, line, column },
  });

  it('tolerates exactly the deliberate reads in the prebuilt transcript bundle', () => {
    const warnings = Array.from(
      { length: TOLERATED_TRANSCRIPT_IMPORT_META_READS },
      () => at('packages/web-shell/dist/transcript.js', 13513, 35),
    );
    expect(findUnexpectedImportMeta(warnings)).toEqual([]);
  });

  it('flags a fourth read arriving through the same bundle', () => {
    const warnings = Array.from(
      { length: TOLERATED_TRANSCRIPT_IMPORT_META_READS + 1 },
      () => at('packages/web-shell/dist/transcript.js', 13513, 35),
    );
    const unexpected = findUnexpectedImportMeta(warnings);
    expect(unexpected).toHaveLength(1);
    expect(unexpected[0]).toContain('beyond the tolerated reads');
  });

  it('flags reads from any other file, with line and column', () => {
    const unexpected = findUnexpectedImportMeta([
      at('src/export-html/src/document-main.tsx', 42, 7),
    ]);
    expect(unexpected).toEqual(['src/export-html/src/document-main.tsx:42:7']);
  });

  it('flags reads with no location at all', () => {
    expect(findUnexpectedImportMeta([{ id: 'empty-import-meta' }])).toEqual([
      '<unknown>',
    ]);
  });

  it('ignores other warning ids', () => {
    expect(
      findUnexpectedImportMeta([
        { id: 'duplicate-object-key', location: { file: 'x.js' } },
      ]),
    ).toEqual([]);
  });
});

// The e2e half drives the real build. build.mjs rm -rf's its dist/ up front
// and only recreates it on success, so a probe-induced throw leaves the tree
// empty — snapshot and restore it, or every passing run poisons the worktree.
const hasPrebuiltTranscript = existsSync(prebuiltTranscript);
const distSnapshot = hasPrebuiltTranscript
  ? mkdtempSync(path.join(tmpdir(), 'export-html-dist-'))
  : undefined;

function snapshotDist() {
  if (existsSync(exportDist)) {
    cpSync(exportDist, path.join(distSnapshot, 'dist'), { recursive: true });
  }
}

function restoreDist() {
  rmSync(exportDist, { recursive: true, force: true });
  const snapshot = path.join(distSnapshot, 'dist');
  if (existsSync(snapshot)) {
    cpSync(snapshot, exportDist, { recursive: true });
  }
}

afterEach(() => {
  if (distSnapshot) rmSync(distSnapshot, { recursive: true, force: true });
});

describe.skipIf(!hasPrebuiltTranscript)(
  'export-html import.meta guard (end-to-end)',
  () => {
    function runBuildWithProbe(targetFile, probeLine) {
      const original = readFileSync(targetFile, 'utf8');
      writeFileSync(targetFile, `${original}\n${probeLine}\n`);
      try {
        snapshotDist();
        return spawnSync(process.execPath, ['src/export-html/build.mjs'], {
          cwd: templatesDir,
          encoding: 'utf8',
          timeout: 120_000,
        });
      } finally {
        writeFileSync(targetFile, original);
        restoreDist();
      }
    }

    it('fails the build when an import.meta read lands in the document entry', () => {
      const result = runBuildWithProbe(
        documentEntry,
        'globalThis.__importMetaProbe = import.meta.url;',
      );
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status).not.toBe(0);
      expect(output).toContain('unexpected import.meta use');
      // The failing build must not leave the release-gated artifact wiped.
      expect(
        existsSync(path.join(exportDist, 'export-transcript-document.js')),
      ).toBe(true);
    });

    it('fails the build on a fourth import.meta read inside the prebuilt transcript bundle', () => {
      const result = runBuildWithProbe(
        prebuiltTranscript,
        'globalThis.__importMetaProbe2 = import.meta.url;',
      );
      expect(result.status).not.toBe(0);
      expect(
        existsSync(path.join(exportDist, 'export-transcript-document.js')),
      ).toBe(true);
    });
  },
);
