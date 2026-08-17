/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Sits in its own file on purpose: the startup sweep flag is process-global
// once enabled, and this file never enables it, so it can assert the
// constructor is inert by default (vitest isolates module state per file).

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Storage } from './storage.js';
import { sanitizeCwd } from '../utils/paths.js';

describe('startup sweep gating', () => {
  it('a bare Storage construction never fires the sweep', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-sweep-gate-'));
    try {
      // A bucket that would be swept if the sweep ran: keyed by a gone
      // worktree, sidecar points at it, owning repo (base) exists.
      const goneWorktree = path.join(base, 'gone-wt');
      const bucket = path.join(base, 'projects', sanitizeCwd(goneWorktree));
      fs.mkdirSync(path.join(bucket, 'chats'), { recursive: true });
      fs.writeFileSync(
        path.join(bucket, 'chats', 's.worktree.json'),
        JSON.stringify({ worktreePath: goneWorktree, originalCwd: base }),
      );

      new Storage(path.join(base, 'target'), base);
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(fs.existsSync(bucket)).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
