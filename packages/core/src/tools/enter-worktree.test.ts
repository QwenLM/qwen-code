/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EnterWorktreeTool } from './enter-worktree.js';
import { ExitWorktreeTool } from './exit-worktree.js';
import type { Config } from '../config/config.js';
import {
  AGENT_WORKTREE_SLUG_PATTERN,
  GitWorktreeService,
  WORKTREE_BRANCH_PREFIX,
  WORKTREE_SESSION_FILE,
  generateAgentWorktreeSlug,
  readWorktreeSessionMarker,
  worktreeBranchForSlug,
  writeWorktreeSessionMarker,
} from '../services/gitWorktreeService.js';

function makeMockConfig(targetDir = '/tmp/mock-repo'): Config {
  return {
    getTargetDir: vi.fn(() => targetDir),
  } as unknown as Config;
}

const validate = (slug: string) =>
  GitWorktreeService.validateUserWorktreeSlug(slug);

/** Runs `fn` in a fresh temp dir and removes the dir afterwards. */
async function withTmpDir(prefix: string, fn: (dir: string) => Promise<void>) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await fn(tmp);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

describe('GitWorktreeService.validateUserWorktreeSlug', () => {
  it('accepts simple slugs', () => {
    expect(validate('my-feature')).toBeNull();
    expect(validate('foo123')).toBeNull();
    expect(validate('foo.bar_baz-1')).toBeNull();
  });

  it('rejects empty', () => {
    expect(validate('')).toMatch(/non-empty/i);
  });

  it('rejects path-traversal patterns', () => {
    expect(validate('../etc/passwd')).not.toBeNull();
    expect(validate('a/b')).not.toBeNull();
    expect(validate('foo..bar')).toMatch(/must not.*\.\./i);
    expect(validate('.hidden')).toMatch(/must not start/i);
    expect(validate('-leadingdash')).toMatch(/must not start/i);
  });

  it('rejects disallowed characters', () => {
    expect(validate('a b')).not.toBeNull();
    expect(validate('a@b')).not.toBeNull();
  });

  it('rejects strings longer than 64 chars', () => {
    expect(validate('a'.repeat(65))).toMatch(/64/);
    expect(validate('a'.repeat(64))).toBeNull();
  });

  it('reserves the `agent-` prefix for ephemeral agent worktrees', () => {
    // User `agent-` slugs that do not match AGENT_WORKTREE_SLUG_PATTERN
    // (`agent-<7hex>`) are rejected so they cannot sit alongside the
    // ephemeral shape and confuse the sweep.
    expect(validate('agent-feature')).toMatch(/reserved/i);
    expect(validate('agent-1234567g')).toMatch(/reserved/i); // 8 chars, non-hex
    expect(validate('agent-12345678')).toMatch(/reserved/i); // 8 hex (too long)
    // Exact `agent-<7hex>` is what `generateAgentWorktreeSlug` produces; it
    // must validate so AgentTool isolation creates slugs via the same path.
    expect(validate('agent-aabbccd')).toBeNull();
    expect(validate('agent-1234567')).toBeNull();
    // The standalone word "agent" or a different prefix is fine.
    expect(validate('agent')).toBeNull();
    expect(validate('agentic')).toBeNull();
    expect(validate('my-agent')).toBeNull();
  });

  it('round-trip: every generated agent slug passes user validation', () => {
    // Regression guard: round 5 added the prefix reservation with
    // `startsWith` instead of `!matches pattern`, which silently broke EVERY
    // agent isolation invocation. Generated slugs MUST pass the validator.
    for (let i = 0; i < 50; i++) {
      expect(validate(generateAgentWorktreeSlug())).toBeNull();
    }
  });
});

describe('generateAgentWorktreeSlug', () => {
  it('produces slugs that match AGENT_WORKTREE_SLUG_PATTERN', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateAgentWorktreeSlug()).toMatch(AGENT_WORKTREE_SLUG_PATTERN);
    }
  });
});

describe('worktreeBranchForSlug', () => {
  it('prefixes the slug with WORKTREE_BRANCH_PREFIX', () => {
    expect(worktreeBranchForSlug('feat-x')).toBe(
      `${WORKTREE_BRANCH_PREFIX}feat-x`,
    );
    expect(worktreeBranchForSlug('agent-aabbccd')).toBe(
      `${WORKTREE_BRANCH_PREFIX}agent-aabbccd`,
    );
  });
});

describe('EnterWorktreeTool.execute', () => {
  // Real temp dirs so we exercise the actual git invocations.
  const enterFrom = (targetDir: string, name: string) =>
    new EnterWorktreeTool({
      getTargetDir: () => targetDir,
      getSessionId: () => 'mock',
    } as unknown as Config)
      .build({ name })
      .execute(new AbortController().signal);

  it('refuses nested invocation from inside a worktree', async () => {
    await withTmpDir('qwen-nested-', async (cwd) => {
      // A path that contains the nested-marker substring.
      const nested = path.join(cwd, '.qwen', 'worktrees', 'inner');
      await fs.mkdir(nested, { recursive: true });
      const result = await enterFrom(nested, 'nope');
      expect(result.error?.message).toMatch(/already inside.*worktree/i);
    });
  });

  it('fails cleanly when cwd is not a git repository', async () => {
    await withTmpDir('qwen-no-git-', async (cwd) => {
      const result = await enterFrom(cwd, 'doesnt-matter');
      expect(result.error?.message).toMatch(/not a git repository/i);
    });
  });
});

describe('session marker round-trip', () => {
  it('write then read returns the same session id', async () => {
    await withTmpDir('qwen-wt-session-', async (tmp) => {
      await writeWorktreeSessionMarker(tmp, 'session-abc-123');
      expect(await readWorktreeSessionMarker(tmp)).toBe('session-abc-123');
      const onDisk = await fs.readFile(
        path.join(tmp, WORKTREE_SESSION_FILE),
        'utf8',
      );
      expect(onDisk.trim()).toBe('session-abc-123');
    });
  });

  it('returns null when the marker file is missing', async () => {
    await withTmpDir('qwen-wt-session-', async (tmp) => {
      expect(await readWorktreeSessionMarker(tmp)).toBeNull();
    });
  });

  it('returns null when the marker file is empty / whitespace', async () => {
    await withTmpDir('qwen-wt-session-', async (tmp) => {
      const file = path.join(tmp, WORKTREE_SESSION_FILE);
      await fs.writeFile(file, '   \n  \n', 'utf8');
      expect(await readWorktreeSessionMarker(tmp)).toBeNull();
    });
  });
});

describe('GitWorktreeService.generateAutoSlug', () => {
  it('produces a slug matching the {adj}-{noun}-{6hex} pattern', () => {
    for (let i = 0; i < 50; i++) {
      const slug = GitWorktreeService.generateAutoSlug();
      expect(slug).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{6}$/);
      expect(validate(slug)).toBeNull();
    }
  });

  it('uses a strong RNG so 100 consecutive slugs are unique', () => {
    // Math.random gave ~7% odds of a collision across 100 slugs (1/65k per
    // suffix); the randomBytes 6-hex suffix is essentially collision-free.
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
    // Expected paths use path.join so the separator matches the platform.
    const root = process.cwd();
    const service = new GitWorktreeService(root);
    expect(service.getUserWorktreesDir()).toBe(
      path.join(root, '.qwen', 'worktrees'),
    );
    expect(service.getUserWorktreePath('feat-x')).toBe(
      path.join(root, '.qwen', 'worktrees', 'feat-x'),
    );
  });
});

describe('EnterWorktreeTool metadata', () => {
  const tool = () => new EnterWorktreeTool(makeMockConfig());

  it('exposes the correct tool name and display name', () => {
    expect(tool().name).toBe('enter_worktree');
    expect(tool().displayName).toBe('EnterWorktree');
  });

  it('rejects an explicitly invalid name during validation', () => {
    expect(tool().validateToolParams({ name: '../../etc' })).not.toBeNull();
  });

  it('accepts an undefined name', () => {
    expect(tool().validateToolParams({})).toBeNull();
  });

  it('accepts an empty-string name (treated as auto-generate)', () => {
    // Some models pass `{ name: '' }` for the optional `name`; `execute`
    // falls back to an auto-generated slug, so validation must not reject.
    expect(tool().validateToolParams({ name: '' })).toBeNull();
  });
});

describe('ExitWorktreeTool default permission', () => {
  it.each([
    ["returns 'ask' when action is 'remove'", 'remove', 'ask'],
    ["returns 'allow' when action is 'keep'", 'keep', 'allow'],
  ] as const)('%s', async (_title, action, permission) => {
    const inv = new ExitWorktreeTool(makeMockConfig()).build({
      name: 'foo',
      action,
    });
    expect(await inv.getDefaultPermission()).toBe(permission);
  });
});

describe('ExitWorktreeTool metadata and validation', () => {
  const tool = () => new ExitWorktreeTool(makeMockConfig());

  it('exposes the correct tool name', () => {
    expect(tool().name).toBe('exit_worktree');
    expect(tool().displayName).toBe('ExitWorktree');
  });

  it('requires action to be keep or remove', () => {
    const exit = tool();
    expect(
      exit.validateToolParams({
        name: 'foo',
        action: 'destroy' as 'keep' | 'remove',
      }),
    ).not.toBeNull();
    expect(exit.validateToolParams({ name: 'foo', action: 'keep' })).toBeNull();
    expect(
      exit.validateToolParams({ name: 'foo', action: 'remove' }),
    ).toBeNull();
  });

  it('rejects invalid name slugs', () => {
    expect(
      tool().validateToolParams({ name: 'a/b', action: 'remove' }),
    ).not.toBeNull();
  });
});
