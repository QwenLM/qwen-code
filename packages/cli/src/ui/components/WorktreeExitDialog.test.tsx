/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { WorktreeExitDialog } from './WorktreeExitDialog.js';

// Stub `node:child_process.execFile` so a render here doesn't actually
// spawn `git` against the synthetic worktreePath in props. The default
// vi.fn() never invokes the callback, which keeps the dialog in its
// loading state — perfect for asserting the initial render frame
// without depending on async useEffect resolution (which is brittle
// under ink-testing-library; see PR #4174 reviewer notes on dialog
// dirty-state coverage).
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn() };
});

// useKeypress only matters for the Escape handler, which we don't
// exercise in unit tests (it's covered by the E2E Group E suite).
vi.mock('../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));

const baseProps = {
  slug: 'test-feature',
  branch: 'worktree-test-feature',
  worktreePath: '/tmp/repo/.qwen/worktrees/test-feature',
  originalHeadCommit: 'a'.repeat(40),
  onKeep: vi.fn(),
  onRemove: vi.fn(),
  onCancel: vi.fn(),
};

describe('WorktreeExitDialog', () => {
  it('renders the loading frame before git probes resolve', () => {
    const { lastFrame } = render(<WorktreeExitDialog {...baseProps} />);
    expect(lastFrame()).toContain('Checking worktree status');
  });

  it('ranges the new-commit count from worktreeBase, not originalHeadCommit (R5-4)', async () => {
    // originalHeadCommit is the original checkout's HEAD (repo top); the
    // worktree was created at worktreeBase, which may be ahead of it. The
    // count must range from the creation base or it includes commits the
    // worktree never had (shown on a destructive Remove button).
    const { execFile } = await import('node:child_process');
    const mockExec = vi.mocked(execFile);
    mockExec.mockImplementation(((
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: null, stdout: string) => void,
    ) => {
      cb(null, '5\n');
    }) as never);
    // Drop calls recorded by earlier renders so the assertion below sees
    // only this render's probes.
    mockExec.mockClear();
    try {
      const worktreeBase = 'b'.repeat(40);
      render(<WorktreeExitDialog {...baseProps} worktreeBase={worktreeBase} />);
      // Let the mount effect issue its git probes.
      await new Promise((resolve) => setTimeout(resolve, 10));
      const revListCall = mockExec.mock.calls.find(
        (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('rev-list'),
      );
      expect(revListCall).toBeDefined();
      const args = revListCall![1] as string[];
      expect(args).toContain(`${worktreeBase}..HEAD`);
      expect(args).not.toContain(`${baseProps.originalHeadCommit}..HEAD`);
    } finally {
      mockExec.mockReset();
    }
  });
});

// NOTE: the dialog's post-load states (dirty counts, Remove label
// variants, probe-error banner) are covered by the E2E Group E suite
// in docs/e2e-tests/worktree-phase-c.md. Mocking execFile + driving
// React state transitions through ink-testing-library is brittle for
// this dialog because the useEffect awaits two Promises and ink's
// re-render scheduling didn't fire reliably from the test harness; the
// E2E run exercises the actual git subprocesses end-to-end.
