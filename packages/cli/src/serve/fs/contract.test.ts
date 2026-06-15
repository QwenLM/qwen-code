/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fsp, realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { WorkspaceContext } from '@qwen-code/qwen-code-core';
import { canonicalizeWorkspace, resolveWithinWorkspace } from './paths.js';
// `isFsError` is a runtime guard called below — must stay a value
// import. `FsError` is type-only here (typed `catch` variable); same
// for `FsErrorKind`. The eslint-disable mirrors the workspaceFileSystem.ts
// fix and exists because the auto-fix at commit 7b0db4c3a promoted the
// whole line to `import type`, erasing `isFsError` at runtime and
// failing 11 tests in this file alone.

import { isFsError, type FsError, type FsErrorKind } from './errors.js';

/**
 * Kinds the boundary throws to indicate the path is *outside the
 * workspace*. `path_not_found` is intentionally NOT here: it's a
 * separate "exists?" decision, and `WorkspaceContext` returns
 * `true` ("would be in workspace if it existed") for missing files
 * — a legitimate semantic mismatch the contract doesn't try to
 * unify.
 */
const OUT_OF_WORKSPACE_KINDS: ReadonlySet<FsErrorKind> = new Set([
  'path_outside_workspace',
  'symlink_escape',
]);

/**
 * #4175 PR 18 contract test (commit 8 of plan).
 *
 * The serve boundary's `resolveWithinWorkspace` and the existing
 * `WorkspaceContext.isPathWithinWorkspace` (which routes through a
 * cached `fs.realpathSync`) live in different packages and have
 * independent code paths. This corpus pins their agreement so a
 * future refactor of either side has a one-shot signal that
 * canonicalization has drifted.
 *
 * Concretely we assert:
 *   1. For paths the boundary admits, `WorkspaceContext` agrees the
 *      path is inside the workspace.
 *   2. For paths the boundary rejects with `path_outside_workspace`
 *      or `symlink_escape`, `WorkspaceContext` agrees the path is
 *      outside.
 *   3. The canonical form `resolveWithinWorkspace` returns matches
 *      `realpathSync.native` (the "ground truth" the boundary's
 *      ENOENT-tolerant code path falls back to via `path.resolve`).
 *
 * The corpus is intentionally small but covers the dimensions that
 * tend to disagree on edge cases: symlinks pointing in/out, ENOENT
 * paths, case-different inputs on case-insensitive filesystems,
 * and `..` traversal.
 */

interface CorpusCase {
  name: string;
  /** Setup hook; receives the workspace path and may create files/symlinks. */
  setup?: (workspace: string, scratch: string) => Promise<void>;
  /** Path passed to both APIs. */
  input: (workspace: string, scratch: string) => string;
  /**
   * Whether we expect the path to be inside the workspace.
   * `'existence-mismatch'` flags cases where the boundary rejects
   * with `path_not_found` but `WorkspaceContext` says "would-be
   * inside" — by design the two APIs answer different questions.
   */
  expectInside: boolean | 'existence-mismatch';
  /** Intent for `resolveWithinWorkspace`. */
  intent: 'read' | 'write' | 'list' | 'glob' | 'stat';
  /**
   * If set, only run on these platforms. Used for case-mismatch
   * (macOS/win) and symlink-on-Windows cases that may need admin.
   */
  onlyPlatforms?: NodeJS.Platform[];
}

const CORPUS: CorpusCase[] = [
  {
    name: 'plain file inside workspace',
    setup: async (ws) => {
      await fsp.writeFile(path.join(ws, 'a.txt'), 'a');
    },
    input: () => 'a.txt',
    expectInside: true,
    intent: 'read',
  },
  {
    name: 'nested file inside workspace',
    setup: async (ws) => {
      await fsp.mkdir(path.join(ws, 'src'));
      await fsp.writeFile(path.join(ws, 'src', 'index.ts'), '');
    },
    input: () => path.join('src', 'index.ts'),
    expectInside: true,
    intent: 'read',
  },
  {
    name: 'workspace root via "."',
    input: () => '.',
    expectInside: true,
    intent: 'list',
  },
  {
    name: '`..` traversal lands outside',
    input: () => '../escape',
    expectInside: false,
    intent: 'read',
  },
  {
    name: 'absolute path outside workspace',
    setup: async (_ws, scratch) => {
      await fsp.writeFile(path.join(scratch, 'outside.txt'), 'x');
    },
    input: (_ws, scratch) => path.join(scratch, 'outside.txt'),
    expectInside: false,
    intent: 'read',
  },
  {
    name: 'symlink inside workspace pointing out',
    setup: async (ws, scratch) => {
      const outside = path.join(scratch, 'leak-target.txt');
      await fsp.writeFile(outside, 'sensitive');
      await fsp.symlink(outside, path.join(ws, 'leak'), 'file');
    },
    input: () => 'leak',
    expectInside: false,
    intent: 'read',
  },
  {
    name: 'symlink inside workspace pointing in',
    setup: async (ws) => {
      await fsp.writeFile(path.join(ws, 'real.txt'), 'in');
      await fsp.symlink(
        path.join(ws, 'real.txt'),
        path.join(ws, 'alias'),
        'file',
      );
    },
    input: () => 'alias',
    expectInside: true,
    intent: 'read',
  },
  {
    name: 'non-existent path with write intent (ENOENT-tolerant)',
    input: () => path.join('newdir', 'leaf.txt'),
    expectInside: true,
    intent: 'write',
  },
  {
    name: 'non-existent path with read intent rejects (existence, not boundary)',
    input: () => 'never-existed.txt',
    // The boundary throws `path_not_found`, which is an existence
    // decision, not a containment decision. WorkspaceContext models
    // missing files as "would be in workspace" and returns `true`,
    // so this case asserts the asymmetry rather than the agreement.
    expectInside: 'existence-mismatch',
    intent: 'read',
  },
  {
    name: 'case-different existing file (macOS/win only)',
    onlyPlatforms: ['darwin', 'win32'],
    setup: async (ws) => {
      await fsp.writeFile(path.join(ws, 'CaseFile.TXT'), '');
    },
    input: () => 'casefile.txt',
    expectInside: true,
    intent: 'read',
  },
];

describe('contract: resolveWithinWorkspace ↔ WorkspaceContext', () => {
  let scratch: string;

  beforeAll(async () => {
    scratch = await fsp.mkdtemp(
      path.join(
        os.tmpdir(),
        `qwen-fs-contract-${randomBytes(4).toString('hex')}-`,
      ),
    );
  });

  afterAll(async () => {
    await fsp.rm(scratch, { recursive: true, force: true });
  });

  it.each(CORPUS.map((tc) => [tc.name, tc] as const))(
    '%s',
    async (_name, tc) => {
      if (tc.onlyPlatforms && !tc.onlyPlatforms.includes(process.platform)) {
        return;
      }
      const wsDir = path.join(scratch, randomBytes(4).toString('hex'));
      await fsp.mkdir(wsDir);
      const workspace = canonicalizeWorkspace(wsDir);
      if (tc.setup) await tc.setup(workspace, scratch);

      const wsCtx = new WorkspaceContext(workspace);
      const inputAbs = path.isAbsolute(tc.input(workspace, scratch))
        ? tc.input(workspace, scratch)
        : path.resolve(workspace, tc.input(workspace, scratch));
      const wsInside = wsCtx.isPathWithinWorkspace(inputAbs);

      let boundaryAccepted = true;
      let resolved: string | null = null;
      let boundaryError: FsError | null = null;
      try {
        resolved = await resolveWithinWorkspace(
          tc.input(workspace, scratch),
          workspace,
          tc.intent,
        );
      } catch (err) {
        if (!isFsError(err)) throw err;
        boundaryAccepted = false;
        boundaryError = err;
      }

      if (tc.expectInside === 'existence-mismatch') {
        expect(boundaryAccepted).toBe(false);
        expect(boundaryError?.kind).toBe('path_not_found');
        // WorkspaceContext intentionally answers a different
        // question for missing files — no equality assertion here.
      } else if (tc.expectInside === true) {
        expect(boundaryAccepted).toBe(true);
        expect(wsInside).toBe(true);
      } else {
        expect(boundaryAccepted).toBe(false);
        // The boundary rejected; only assert WorkspaceContext also
        // says "outside" when the rejection was a containment
        // decision (path_outside_workspace / symlink_escape).
        if (boundaryError && OUT_OF_WORKSPACE_KINDS.has(boundaryError.kind)) {
          expect(wsInside).toBe(false);
        }
      }

      // When both succeed, canonical forms must agree.
      if (boundaryAccepted && resolved !== null) {
        // Use realpathSync.native as ground truth when the path
        // exists; for write-intent ENOENT cases we fall back to
        // the resolved-but-not-realpathed form on the leaf.
        let groundTruth: string;
        try {
          groundTruth = realpathSync.native(inputAbs);
        } catch {
          // ENOENT — boundary used findExistingAncestor + realpath +
          // join(tail). Reproduce that here for assertion symmetry.
          let cursor = inputAbs;
          const tail: string[] = [];
          while (true) {
            try {
              await fsp.stat(cursor);
              break;
            } catch {
              tail.unshift(path.basename(cursor));
              const parent = path.dirname(cursor);
              if (parent === cursor) {
                cursor = workspace;
                break;
              }
              cursor = parent;
            }
          }
          groundTruth = tail.length
            ? path.join(realpathSync.native(cursor), ...tail)
            : realpathSync.native(cursor);
        }
        expect(resolved).toBe(groundTruth);
      }
    },
  );
});
