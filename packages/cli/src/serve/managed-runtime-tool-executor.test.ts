/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ManagedToolExecutor,
  relativizeGlobText,
} from './managed-runtime-tool-executor.js';
import type { ManagedToolSet } from './managed-runtime-tool-executor.js';

// The route-level fixtures cannot express these geometries (a Session root is
// always a deep unique tmpdir path), so the anchoring invariants are pinned
// against the function directly.
describe('relativizeGlobText', () => {
  it('strips the root at token starts but keeps a tail that repeats it', () => {
    // The hit carries the root string twice: once as the path prefix and once
    // as a real directory tail ('backup/srv/api' — a directory named srv
    // holding a file named api). Eating the tail is the corruption the
    // leading boundary exists to prevent.
    const text =
      'Found 1 file(s) matching "**/*" within /srv/api\n---\n/srv/api/backup/srv/api';
    expect(relativizeGlobText(text, '/srv/api')).toBe(
      'Found 1 file(s) matching "**/*" within .\n---\nbackup/srv/api',
    );
  });

  it('does not fuse a nested directory whose name repeats the root tail', () => {
    // The R2-1 shape: '/app/src/app/component.ts' must become
    // 'src/app/component.ts', never 'srccomponent.ts'.
    const text = '/app/src/app/component.ts';
    expect(relativizeGlobText(text, '/app')).toBe('src/app/component.ts');
  });

  it('keeps the echoed pattern verbatim for a root of /', () => {
    // The degenerate root is both the boundary and every path's prefix: the
    // rewrite must stand down rather than eat the pattern's separators.
    const text =
      'Found 3 file(s) matching "etc*/host*" within /\n---\netc/hosts\netc/hostname';
    expect(relativizeGlobText(text, '/')).toBe(text);
  });
});

describe('readWorkspaceContext', () => {
  it('does not promote a sibling Session file through an in-mount symlink', async () => {
    // Two Sessions share one mount. Session 1's AGENTS.md is a symlink to
    // Session 2's: its realpath stays inside the mount root, so a boundary at
    // the mount would admit the sibling's text into Session 1's instruction.
    const mount = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-mount-'));
    try {
      const session1 = path.join(mount, 'session-1');
      const session2 = path.join(mount, 'session-2');
      await fs.mkdir(session1);
      await fs.mkdir(session2);
      await fs.writeFile(path.join(session2, 'AGENTS.md'), 'sibling text');
      await fs.writeFile(path.join(session1, 'QWEN.md'), 'own text');
      await fs.symlink(
        path.join(session2, 'AGENTS.md'),
        path.join(session1, 'AGENTS.md'),
      );

      const toolSet: ManagedToolSet = {
        sessionId: 'session-1',
        directory: session1,
        workspaceRoot: mount,
        tools: new Map(),
        admitsDirectory: () => true,
      };
      const executor = new ManagedToolExecutor(async () => toolSet);
      const { files } = await executor.readWorkspaceContext('session-1');

      expect(files.map((file) => file.name)).toEqual(['QWEN.md']);
      expect(files[0]?.text).toBe('own text');
      expect(files.some((file) => file.text.includes('sibling text'))).toBe(
        false,
      );
    } finally {
      await fs.rm(mount, { recursive: true, force: true });
    }
  });
});
