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
});

// NOTE: the dialog's post-load states (dirty counts, Remove label
// variants, probe-error banner) are covered by the E2E Group E suite
// in docs/e2e-tests/worktree-phase-c.md. Mocking execFile + driving
// React state transitions through ink-testing-library is brittle for
// this dialog because the useEffect awaits two Promises and ink's
// re-render scheduling didn't fire reliably from the test harness; the
// E2E run exercises the actual git subprocesses end-to-end.
