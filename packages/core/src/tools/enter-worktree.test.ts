/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';
import { EnterWorktreeTool } from './enter-worktree.js';
import { ExitWorktreeTool } from './exit-worktree.js';
import type { Config } from '../config/config.js';
import { GitWorktreeService } from '../services/gitWorktreeService.js';

function makeMockConfig(targetDir = '/tmp/mock-repo'): Config {
  return {
    getTargetDir: vi.fn(() => targetDir),
  } as unknown as Config;
}

describe('GitWorktreeService.validateUserWorktreeSlug', () => {
  it('accepts simple slugs', () => {
    expect(
      GitWorktreeService.validateUserWorktreeSlug('my-feature'),
    ).toBeNull();
    expect(GitWorktreeService.validateUserWorktreeSlug('foo123')).toBeNull();
    expect(
      GitWorktreeService.validateUserWorktreeSlug('foo.bar_baz-1'),
    ).toBeNull();
  });

  it('rejects empty', () => {
    expect(GitWorktreeService.validateUserWorktreeSlug('')).toMatch(
      /non-empty/i,
    );
  });

  it('rejects path-traversal patterns', () => {
    expect(
      GitWorktreeService.validateUserWorktreeSlug('../etc/passwd'),
    ).not.toBeNull();
    expect(GitWorktreeService.validateUserWorktreeSlug('a/b')).not.toBeNull();
    expect(GitWorktreeService.validateUserWorktreeSlug('foo..bar')).toMatch(
      /must not.*\.\./i,
    );
    expect(GitWorktreeService.validateUserWorktreeSlug('.hidden')).toMatch(
      /must not start/i,
    );
    expect(GitWorktreeService.validateUserWorktreeSlug('-leadingdash')).toMatch(
      /must not start/i,
    );
  });

  it('rejects disallowed characters', () => {
    expect(GitWorktreeService.validateUserWorktreeSlug('a b')).not.toBeNull();
    expect(GitWorktreeService.validateUserWorktreeSlug('a@b')).not.toBeNull();
  });

  it('rejects strings longer than 64 chars', () => {
    expect(GitWorktreeService.validateUserWorktreeSlug('a'.repeat(65))).toMatch(
      /64/,
    );
    expect(
      GitWorktreeService.validateUserWorktreeSlug('a'.repeat(64)),
    ).toBeNull();
  });

  it('reserves the `agent-` prefix for ephemeral agent worktrees', () => {
    // User-chosen `agent-` slugs that DO NOT match
    // AGENT_WORKTREE_SLUG_PATTERN (`agent-<7hex>`) are rejected so
    // they cannot live alongside the ephemeral shape and confuse the
    // sweep.
    expect(
      GitWorktreeService.validateUserWorktreeSlug('agent-feature'),
    ).toMatch(/reserved/i);
    expect(
      GitWorktreeService.validateUserWorktreeSlug('agent-1234567g'), // 8 chars, includes non-hex
    ).toMatch(/reserved/i);
    expect(
      GitWorktreeService.validateUserWorktreeSlug('agent-12345678'), // 8 hex (too long)
    ).toMatch(/reserved/i);
    // Exact `agent-<7hex>` is the shape `generateAgentWorktreeSlug`
    // produces — it must validate so AgentTool isolation can create
    // its own slugs through the same code path.
    expect(
      GitWorktreeService.validateUserWorktreeSlug('agent-aabbccd'),
    ).toBeNull();
    expect(
      GitWorktreeService.validateUserWorktreeSlug('agent-1234567'),
    ).toBeNull();
    // The standalone word "agent" or a different prefix is fine.
    expect(GitWorktreeService.validateUserWorktreeSlug('agent')).toBeNull();
    expect(GitWorktreeService.validateUserWorktreeSlug('agentic')).toBeNull();
    expect(GitWorktreeService.validateUserWorktreeSlug('my-agent')).toBeNull();
  });

  it('round-trip: every generated agent slug passes user validation', async () => {
    // Regression guard: round 5 added the prefix reservation but
    // initially used `startsWith` instead of `!matches pattern`,
    // which silently broke EVERY agent isolation invocation. This
    // test pins the contract: anything `generateAgentWorktreeSlug`
    // produces MUST round-trip through the user validator.
    const { generateAgentWorktreeSlug } = await import(
      '../services/gitWorktreeService.js'
    );
    for (let i = 0; i < 50; i++) {
      const slug = generateAgentWorktreeSlug();
      expect(GitWorktreeService.validateUserWorktreeSlug(slug)).toBeNull();
    }
  });
});

describe('generateAgentWorktreeSlug', () => {
  it('produces slugs that match AGENT_WORKTREE_SLUG_PATTERN', async () => {
    const { generateAgentWorktreeSlug, AGENT_WORKTREE_SLUG_PATTERN } =
      await import('../services/gitWorktreeService.js');
    for (let i = 0; i < 50; i++) {
      const slug = generateAgentWorktreeSlug();
      expect(slug).toMatch(AGENT_WORKTREE_SLUG_PATTERN);
    }
  });
});

describe('worktreeBranchForSlug', () => {
  it('prefixes the slug with WORKTREE_BRANCH_PREFIX', async () => {
    const { worktreeBranchForSlug, WORKTREE_BRANCH_PREFIX } = await import(
      '../services/gitWorktreeService.js'
    );
    expect(worktreeBranchForSlug('feat-x')).toBe(
      `${WORKTREE_BRANCH_PREFIX}feat-x`,
    );
    expect(worktreeBranchForSlug('agent-aabbccd')).toBe(
      `${WORKTREE_BRANCH_PREFIX}agent-aabbccd`,
    );
  });
});

describe('EnterWorktreeTool.execute', () => {
  // Real temp git repo fixtures so we exercise the actual git
  // invocations without mocking the world.
  it('refuses nested invocation from inside a worktree', async () => {
    const fs = await import('node:fs/promises');
    const pathMod = await import('node:path');
    const os = await import('node:os');
    const cwd = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'qwen-nested-'));
    // Build a path that contains the nested-marker substring.
    const nested = pathMod.join(cwd, '.qwen', 'worktrees', 'inner');
    await fs.mkdir(nested, { recursive: true });
    const cfg = {
      getTargetDir: () => nested,
      getSessionId: () => 'mock',
    } as unknown as Config;
    const tool = new EnterWorktreeTool(cfg);
    const result = await tool
      .build({ name: 'nope' })
      .execute(new AbortController().signal);
    expect(result.error?.message).toMatch(/already inside.*worktree/i);
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('fails cleanly when cwd is not a git repository', async () => {
    const fs = await import('node:fs/promises');
    const pathMod = await import('node:path');
    const os = await import('node:os');
    const cwd = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'qwen-no-git-'));
    const cfg = {
      getTargetDir: () => cwd,
      getSessionId: () => 'mock',
    } as unknown as Config;
    const tool = new EnterWorktreeTool(cfg);
    const result = await tool
      .build({ name: 'doesnt-matter' })
      .execute(new AbortController().signal);
    expect(result.error?.message).toMatch(/not a git repository/i);
    await fs.rm(cwd, { recursive: true, force: true });
  });
});

describe('session marker round-trip', () => {
  it('write then read returns the same session id', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const os = await import('node:os');
    const {
      writeWorktreeSessionMarker,
      readWorktreeSessionMarker,
      WORKTREE_SESSION_FILE,
    } = await import('../services/gitWorktreeService.js');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-wt-session-'));
    try {
      await writeWorktreeSessionMarker(tmp, 'session-abc-123');
      const got = await readWorktreeSessionMarker(tmp);
      expect(got).toBe('session-abc-123');
      const onDisk = await fs.readFile(
        path.join(tmp, WORKTREE_SESSION_FILE),
        'utf8',
      );
      expect(onDisk.trim()).toBe('session-abc-123');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('returns null when the marker file is missing', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const os = await import('node:os');
    const { readWorktreeSessionMarker } = await import(
      '../services/gitWorktreeService.js'
    );
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-wt-session-'));
    try {
      expect(await readWorktreeSessionMarker(tmp)).toBeNull();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('returns null when the marker file is empty / whitespace', async () => {
    const fs = await import('node:fs/promises');
    const pathMod = await import('node:path');
    const os = await import('node:os');
    const { readWorktreeSessionMarker, WORKTREE_SESSION_FILE } = await import(
      '../services/gitWorktreeService.js'
    );
    const tmp = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'qwen-wt-session-'));
    try {
      await fs.writeFile(
        pathMod.join(tmp, WORKTREE_SESSION_FILE),
        '   \n  \n',
        'utf8',
      );
      expect(await readWorktreeSessionMarker(tmp)).toBeNull();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('GitWorktreeService.generateAutoSlug', () => {
  it('produces a slug matching the {adj}-{noun}-{6hex} pattern', () => {
    for (let i = 0; i < 50; i++) {
      const slug = GitWorktreeService.generateAutoSlug();
      expect(slug).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{6}$/);
      expect(GitWorktreeService.validateUserWorktreeSlug(slug)).toBeNull();
    }
  });

  it('uses a strong RNG so 100 consecutive slugs are unique', () => {
    // Math.random in the prior implementation had a 1/65k chance per
    // suffix; with 100 slugs that was ~7% chance of a collision in
    // tests. The randomBytes-backed 6-hex suffix should be essentially
    // collision-free at this sample size.
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      seen.add(GitWorktreeService.generateAutoSlug());
    }
    expect(seen.size).toBe(100);
  });
});

describe('GitWorktreeService.getUserWorktreesDir / getUserWorktreePath', () => {
  it('uses .qwen/worktrees under the project root', () => {
    // Use the cwd (which exists) so simple-git's existence check passes.
    const root = process.cwd();
    const service = new GitWorktreeService(root);
    // Build expected paths via path.join so the separator matches the
    // platform — the implementation uses path.join, so on Windows the
    // separator is `\`, not `/`.
    expect(service.getUserWorktreesDir()).toBe(
      path.join(root, '.qwen', 'worktrees'),
    );
    expect(service.getUserWorktreePath('feat-x')).toBe(
      path.join(root, '.qwen', 'worktrees', 'feat-x'),
    );
  });
});

describe('EnterWorktreeTool metadata', () => {
  it('exposes the correct tool name and display name', () => {
    const tool = new EnterWorktreeTool(makeMockConfig());
    expect(tool.name).toBe('enter_worktree');
    expect(tool.displayName).toBe('EnterWorktree');
  });

  it('rejects an explicitly invalid name during validation', () => {
    const tool = new EnterWorktreeTool(makeMockConfig());
    const error = tool.validateToolParams({ name: '../../etc' });
    expect(error).not.toBeNull();
  });

  it('accepts an undefined name', () => {
    const tool = new EnterWorktreeTool(makeMockConfig());
    expect(tool.validateToolParams({})).toBeNull();
  });

  it('accepts an empty-string name (treated as auto-generate)', () => {
    // Some models pass `{ name: '' }` when the schema marks `name` as
    // optional. Validation should not reject this — `execute` falls back
    // to an auto-generated slug.
    const tool = new EnterWorktreeTool(makeMockConfig());
    expect(tool.validateToolParams({ name: '' })).toBeNull();
  });
});

describe('ExitWorktreeTool default permission', () => {
  it("returns 'ask' when action is 'remove'", async () => {
    const tool = new ExitWorktreeTool(makeMockConfig());
    const inv = tool.build({ name: 'foo', action: 'remove' });
    expect(await inv.getDefaultPermission()).toBe('ask');
  });

  it("returns 'allow' when action is 'keep'", async () => {
    const tool = new ExitWorktreeTool(makeMockConfig());
    const inv = tool.build({ name: 'foo', action: 'keep' });
    expect(await inv.getDefaultPermission()).toBe('allow');
  });
});

describe('ExitWorktreeTool metadata and validation', () => {
  it('exposes the correct tool name', () => {
    const tool = new ExitWorktreeTool(makeMockConfig());
    expect(tool.name).toBe('exit_worktree');
    expect(tool.displayName).toBe('ExitWorktree');
  });

  it('requires action to be keep or remove', () => {
    const tool = new ExitWorktreeTool(makeMockConfig());
    expect(
      tool.validateToolParams({
        name: 'foo',
        action: 'destroy' as 'keep' | 'remove',
      }),
    ).not.toBeNull();
    expect(tool.validateToolParams({ name: 'foo', action: 'keep' })).toBeNull();
    expect(
      tool.validateToolParams({ name: 'foo', action: 'remove' }),
    ).toBeNull();
  });

  it('rejects invalid name slugs', () => {
    const tool = new ExitWorktreeTool(makeMockConfig());
    expect(
      tool.validateToolParams({ name: 'a/b', action: 'remove' }),
    ).not.toBeNull();
  });
});
