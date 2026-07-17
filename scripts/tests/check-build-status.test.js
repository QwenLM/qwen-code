/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('scripts/check-build-status.js', () => {
  it('writes nothing to stdout — start.js runs it in front of piped review JSON', async () => {
    // `scripts/start.js` executes this checker with `stdio: 'inherit'` before
    // every spawn, and start.js is a QWEN_CODE_CLI entry whose stdout callers
    // consume: `… review parse-args --stdin | tee plan.json` must produce a file
    // whose first line is JSON. One `console.log` here — the shape this pins
    // against — puts "Checking build status..." at the top of that file. Status
    // and warnings belong on stderr, whatever build state the checker finds.
    const { stdout } = await new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [join(root, 'scripts', 'check-build-status.js')],
        { cwd: root },
        (err, stdout, stderr) => {
          // The checker may exit non-zero on an unbuilt tree; the contract under
          // test is the stream, not the verdict.
          if (err && typeof stdout !== 'string') reject(err);
          else resolve({ stdout, stderr });
        },
      );
    });
    expect(stdout).toBe('');
  });
});
