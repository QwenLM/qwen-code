/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import { validateSymlinkScope } from './symlinkScope.js';

vi.mock('fs/promises');

describe('validateSymlinkScope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts a target that resolves inside baseRealPath', async () => {
    vi.mocked(fs.realpath).mockResolvedValue('/base/skills/foo');
    vi.mocked(fs.stat).mockResolvedValue({
      isDirectory: () => true,
    } as Awaited<ReturnType<typeof fs.stat>>);

    const result = await validateSymlinkScope('/base/skills/link', '/base/skills');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.realPath).toBe('/base/skills/foo');
    }
  });

  it('accepts a target nested several directories deep inside baseRealPath', async () => {
    vi.mocked(fs.realpath).mockResolvedValue('/base/skills/inner/deep/foo');
    vi.mocked(fs.stat).mockResolvedValue({
      isDirectory: () => true,
    } as Awaited<ReturnType<typeof fs.stat>>);

    const result = await validateSymlinkScope('/base/skills/link', '/base/skills');
    expect(result.ok).toBe(true);
  });

  it('rejects when realpath fails (broken symlink)', async () => {
    vi.mocked(fs.realpath).mockRejectedValue(new Error('ENOENT'));

    const result = await validateSymlinkScope('/base/skills/dangling', '/base/skills');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid');
    }
  });

  it('rejects when target escapes baseRealPath via parent traversal', async () => {
    vi.mocked(fs.realpath).mockResolvedValue('/etc/cron.d/payload');
    vi.mocked(fs.stat).mockResolvedValue({
      isDirectory: () => true,
    } as Awaited<ReturnType<typeof fs.stat>>);

    const result = await validateSymlinkScope(
      '/base/skills/escape',
      '/base/skills',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('escapes');
    }
  });

  it('rejects sibling-prefix attacks (base + suffix that does not start with sep)', async () => {
    // Without `path.relative`, a naive `realPath.startsWith(base + sep)`
    // check could still false-pass when the target is `/base/skillsX/...`
    // (sibling whose name starts with "skills"). path.relative('/base/skills',
    // '/base/skillsX/foo') = '../skillsX/foo' → first segment `..` → rejected.
    vi.mocked(fs.realpath).mockResolvedValue('/base/skillsX/foo');
    vi.mocked(fs.stat).mockResolvedValue({
      isDirectory: () => true,
    } as Awaited<ReturnType<typeof fs.stat>>);

    const result = await validateSymlinkScope(
      '/base/skills/escape',
      '/base/skills',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('escapes');
    }
  });

  it('accepts an in-base directory whose first segment starts with two dots (e.g. "..shared")', async () => {
    // Regression: `path.relative('/base', '/base/..shared/foo')` returns
    // `'..shared/foo'`. The previous `rel.startsWith('..')` containment
    // check false-rejected this legitimate in-base path. Containment
    // must be segment-aware: only a literal `..` first segment escapes.
    vi.mocked(fs.realpath).mockResolvedValue('/base/skills/..shared/foo');
    vi.mocked(fs.stat).mockResolvedValue({
      isDirectory: () => true,
    } as Awaited<ReturnType<typeof fs.stat>>);

    const result = await validateSymlinkScope(
      '/base/skills/link',
      '/base/skills',
    );
    expect(result.ok).toBe(true);
  });

  it('accepts a single-segment in-base directory whose name is "..bar"', async () => {
    // Companion to the previous case for the `rel === '..bar'` shape
    // (no trailing path component). `'..bar'.split(/[/\\]/)[0] === '..bar'`
    // which is not equal to `..`, so containment passes.
    vi.mocked(fs.realpath).mockResolvedValue('/base/skills/..bar');
    vi.mocked(fs.stat).mockResolvedValue({
      isDirectory: () => true,
    } as Awaited<ReturnType<typeof fs.stat>>);

    const result = await validateSymlinkScope(
      '/base/skills/link',
      '/base/skills',
    );
    expect(result.ok).toBe(true);
  });

  it('rejects when target exists but is a file, not a directory', async () => {
    vi.mocked(fs.realpath).mockResolvedValue('/base/skills/file');
    vi.mocked(fs.stat).mockResolvedValue({
      isDirectory: () => false,
    } as Awaited<ReturnType<typeof fs.stat>>);

    const result = await validateSymlinkScope('/base/skills/link', '/base/skills');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not-directory');
    }
  });

  it('rejects when stat fails after realpath succeeds (race / permission)', async () => {
    vi.mocked(fs.realpath).mockResolvedValue('/base/skills/foo');
    vi.mocked(fs.stat).mockRejectedValue(new Error('EACCES'));

    const result = await validateSymlinkScope('/base/skills/link', '/base/skills');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid');
    }
  });

  it('treats a target equal to baseRealPath as in-scope (degenerate but not escaping)', async () => {
    // Edge case: a symlink whose target IS the base directory itself.
    // path.relative(x, x) === '' which is neither '..' nor absolute, so
    // the helper returns ok: true. The downstream `SKILL.md` access
    // check filters this out (no manifest at the base directory level).
    vi.mocked(fs.realpath).mockResolvedValue('/base/skills');
    vi.mocked(fs.stat).mockResolvedValue({
      isDirectory: () => true,
    } as Awaited<ReturnType<typeof fs.stat>>);

    const result = await validateSymlinkScope('/base/skills/self', '/base/skills');
    expect(result.ok).toBe(true);
  });
});
