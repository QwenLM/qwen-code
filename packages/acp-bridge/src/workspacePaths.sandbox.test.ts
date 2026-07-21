/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalizeWorkspace } from './workspacePaths.js';

// Isolated from workspacePaths.test.ts because it mocks node:fs — the other
// file drives real filesystem fixtures.
vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs');
  return {
    ...actual,
    existsSync: (p: unknown) =>
      p === '/c/qwen-repro' ? true : actual.existsSync(p as never),
  };
});

describe('canonicalizeWorkspace inside a POSIX container sandbox (#7139)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.skipIf(process.platform === 'win32')(
    'resolves a Windows-shaped workspace to its bind-mount location',
    () => {
      vi.stubEnv('SANDBOX', 'qwen-code-sandbox-0');
      // The mount exists (mocked), realpath on it ENOENTs on this host, so
      // the fallback returns the translated absolute path — NOT the cwd
      // concatenation `path.resolve` alone would produce.
      expect(canonicalizeWorkspace('C:\\qwen-repro')).toBe('/c/qwen-repro');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'keeps Windows-shaped input untouched outside a sandbox',
    () => {
      // Explicitly clear SANDBOX: when this suite itself runs inside the
      // project's Docker sandbox the launcher sets it, and unstubAllEnvs
      // would not remove a genuinely inherited value.
      vi.stubEnv('SANDBOX', '');
      const result = canonicalizeWorkspace('C:\\qwen-repro');
      // Unsandboxed POSIX behavior is unchanged: the string resolves
      // relative to the cwd (and stays broken — which is what the
      // pre-#7139 sandbox path produced too).
      expect(result.endsWith('C:\\qwen-repro')).toBe(true);
      expect(result.startsWith('/')).toBe(true);
    },
  );
});
