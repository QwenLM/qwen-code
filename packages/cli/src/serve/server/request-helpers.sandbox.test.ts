/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _setSandboxMountExistsForTest } from '@qwen-code/acp-bridge';
import { parseOptionalWorkspaceCwd } from './request-helpers.js';

// Regression for the #7228 review finding: every workspace-ingestion path
// validates with `path.isAbsolute` BEFORE canonicalization, and on POSIX
// `isAbsolute('C:\\…')` is false — so a translation that only lives inside
// canonicalizeWorkspace never runs on the real request path. This test
// drives the real exported REST-route parser (guard included), not the
// canonicalization choke point. The mount-existence probe is stubbed via
// the acp-bridge test seam (the `/c/…` target sits at the filesystem root,
// which tests cannot create).

function mockRes(): { res: Response; status: ReturnType<typeof vi.fn> } {
  const status = vi.fn().mockReturnValue({ json: vi.fn() });
  return { res: { status } as unknown as Response, status };
}

describe('parseOptionalWorkspaceCwd inside a POSIX container sandbox (#7139)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    _setSandboxMountExistsForTest(undefined);
  });

  it.skipIf(process.platform === 'win32')(
    'accepts a Windows-shaped cwd and returns its bind-mount location',
    () => {
      vi.stubEnv('SANDBOX', 'qwen-code-sandbox-0');
      _setSandboxMountExistsForTest((p) => p === '/c/qwen-repro');
      const { res, status } = mockRes();
      const cwd = parseOptionalWorkspaceCwd(
        { cwd: 'C:\\qwen-repro' },
        '/c/qwen-repro',
        res,
      );
      expect(cwd).toBe('/c/qwen-repro');
      expect(status).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'still rejects a Windows-shaped cwd outside a sandbox',
    () => {
      const { res, status } = mockRes();
      const cwd = parseOptionalWorkspaceCwd(
        { cwd: 'C:\\qwen-repro' },
        '/tmp',
        res,
      );
      expect(cwd).toBeUndefined();
      expect(status).toHaveBeenCalledWith(400);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects when the translated mount does not exist (no invented paths)',
    () => {
      vi.stubEnv('SANDBOX', 'qwen-code-sandbox-0');
      const { res, status } = mockRes();
      const cwd = parseOptionalWorkspaceCwd(
        { cwd: 'D:\\never-mounted' },
        '/tmp',
        res,
      );
      expect(cwd).toBeUndefined();
      expect(status).toHaveBeenCalledWith(400);
    },
  );
});
