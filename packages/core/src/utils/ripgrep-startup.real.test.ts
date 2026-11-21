/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  _resetRipgrepUtilsCachesForTest,
  ensureRipgrepHealthy,
} from './ripgrepUtils.js';

describe.skipIf(process.platform === 'win32')(
  'ripgrep startup cancellation',
  () => {
    it('does not finish until a probe that ignores SIGTERM has exited', async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-startup-'));
      const command = path.join(directory, 'rg.cjs');
      const pidFile = path.join(directory, 'pid');
      fs.writeFileSync(
        command,
        `#!/usr/bin/env node
process.on('SIGTERM', () => {});
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`,
        { mode: 0o700 },
      );
      _resetRipgrepUtilsCachesForTest();
      const controller = new AbortController();
      const reason = new Error('initialization failed');
      const probe = ensureRipgrepHealthy(
        { mode: 'system', command },
        controller.signal,
      );
      const result = probe.catch((error: unknown) => error);
      let pid: number | undefined;
      try {
        await vi.waitFor(() => expect(fs.existsSync(pidFile)).toBe(true), {
          timeout: 5_000,
        });
        pid = Number(fs.readFileSync(pidFile, 'utf8'));
        expect(Number.isInteger(pid) && pid > 0).toBe(true);
        controller.abort(reason);
        expect(await result).toBe(reason);

        expect(() => process.kill(pid!, 0)).toThrow();
      } finally {
        controller.abort(reason);
        await probe.catch(() => undefined);
        _resetRipgrepUtilsCachesForTest();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }, 10_000);
  },
);
