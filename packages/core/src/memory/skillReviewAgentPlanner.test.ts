/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the #4437 fix:
 *  - `write_file` to an existing path inside the project skills root is
 *    denied (was 'allow' before — silently clobbered the prior SKILL.md).
 *  - `edit` semantics for existing auto-skills are preserved.
 *  - `buildTaskPrompt` enumerates existing skill directory names so the
 *    agent picks a fresh name on the first attempt.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import {
  AUTO_SKILL_DIR_PREFIX,
  buildTaskPrompt,
  createSkillScopedAgentConfig,
  DEFAULT_AUTO_SKILL_MAX_TURNS,
  DEFAULT_AUTO_SKILL_TIMEOUT_MS,
  listExistingSkillDirNames,
  runSkillReviewByAgent,
  SKILL_REVIEW_SYSTEM_PROMPT,
} from './skillReviewAgentPlanner.js';
import { ToolNames } from '../tools/tool-names.js';
import { runForkedAgent } from '../agents/forkedAgent.js';

vi.mock('../agents/forkedAgent.js', () => ({
  runForkedAgent: vi.fn(),
}));

const { EDIT, READ_FILE, WEB_FETCH, WRITE_FILE } = ToolNames;

/**
 * Build the scoped Config and return its non-null PermissionManager.
 * Config declares `getPermissionManager(): PermissionManager | null`, so this
 * launders the null once, with an assertion that fires loudly if
 * `createSkillScopedAgentConfig` ever stops installing one.
 */
function scopedPm(projectRoot: string, basePm?: unknown) {
  const scoped = createSkillScopedAgentConfig(
    {
      getProjectRoot: () => projectRoot,
      getPermissionManager: () => basePm,
    } as unknown as Config,
    projectRoot,
  );
  const pm = scoped.getPermissionManager();
  if (!pm) {
    throw new Error(
      'createSkillScopedAgentConfig must install a PermissionManager',
    );
  }
  return pm;
}

const skillsPath = (projectRoot: string, ...segs: string[]) =>
  path.join(projectRoot, '.qwen', 'skills', ...segs);

async function writeSkillFile(
  projectRoot: string,
  skillName: string,
  content: string,
): Promise<string> {
  const dir = skillsPath(projectRoot, skillName);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'SKILL.md');
  await fs.writeFile(filePath, content, 'utf-8');
  return filePath;
}

async function archiveSkillDir(projectRoot: string, directoryName: string) {
  await fs.mkdir(
    path.join(projectRoot, '.qwen', 'archived-skills', directoryName),
    { recursive: true },
  );
}

/** A fresh temp project root per test; returns getters for both dirs. */
function useTempProject(prefix: string) {
  const dirs = { tempDir: '', projectRoot: '' };
  beforeEach(async () => {
    dirs.tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    dirs.projectRoot = path.join(dirs.tempDir, 'project');
    await fs.mkdir(dirs.projectRoot, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(dirs.tempDir, { recursive: true, force: true });
  });
  return dirs;
}

const AUTO_SKILL = `---
name: my-skill
source: auto-skill
---

body
`;

const USER_SKILL = `---
name: my-skill
description: hand-authored
---

human body
`;

describe('skillReviewAgentPlanner — write_file collision deny (#4437)', () => {
  const dirs = useTempProject('skill-review-v2-');
  const decide = (toolName: string, filePath: string) =>
    scopedPm(dirs.projectRoot).evaluate({ toolName, filePath });

  it.each([
    [
      "denies write_file to an existing AUTO-skill path (the #4437 bug — was 'allow')",
      AUTO_SKILL,
      WRITE_FILE,
      'deny',
    ],
    [
      'denies write_file to an existing USER-skill path (already worked — kept as regression guard)',
      USER_SKILL,
      WRITE_FILE,
      'deny',
    ],
    [
      'still allows edit on an existing auto-skill (update path preserved)',
      AUTO_SKILL,
      EDIT,
      'allow',
    ],
    [
      'still denies edit on a user skill (update path safety preserved)',
      USER_SKILL,
      EDIT,
      'deny',
    ],
  ])('%s', async (_title, content, toolName, expected) => {
    const filePath = await writeSkillFile(
      dirs.projectRoot,
      'my-skill',
      content,
    );
    expect(await decide(toolName, filePath)).toBe(expected);
  });

  it('allows write_file to a fresh path that does not yet exist', async () => {
    const fresh = skillsPath(dirs.projectRoot, 'brand-new', 'SKILL.md');
    expect(await decide(WRITE_FILE, fresh)).toBe('allow');
  });

  it.each([
    [
      'denies write_file when the directory name is already archived',
      WRITE_FILE,
    ],
    ['denies edit creation when the directory name is already archived', EDIT],
  ])('%s', async (_title, toolName) => {
    await archiveSkillDir(dirs.projectRoot, 'auto-skill-retired');
    const target = skillsPath(
      dirs.projectRoot,
      'auto-skill-retired',
      'SKILL.md',
    );
    expect(await decide(toolName, target)).toBe('deny');
  });

  it('write_file deny rule message points the agent at a fresh name', async () => {
    const filePath = await writeSkillFile(
      dirs.projectRoot,
      'my-skill',
      AUTO_SKILL,
    );
    const rule = scopedPm(dirs.projectRoot).findMatchingDenyRule({
      toolName: WRITE_FILE,
      filePath,
    });
    expect(rule).toMatch(/<name>-2/);
    expect(rule).toMatch(/edit/);
  });

  it('denies write_file to a path outside the project skills root', async () => {
    // Security-boundary regression guard for the `isProjectSkillPath` false
    // branch — without it the agent could escape to anywhere reachable from
    // CWD.
    const escape = path.join(dirs.projectRoot, 'NOT-SKILLS', 'evil.md');
    expect(await decide(WRITE_FILE, escape)).toBe('deny');
  });

  it('denies write_file to a non-SKILL.md path inside the skills root', async () => {
    // Auxiliary files (NOTES.md, attachments) must not land in the skills dir:
    // SkillManager would ignore them but they'd pollute the layout. The
    // basename invariant is the hard guard for that.
    const aux = skillsPath(dirs.projectRoot, 'my-skill', 'NOTES.md');
    await fs.mkdir(path.dirname(aux), { recursive: true });
    expect(await decide(WRITE_FILE, aux)).toBe('deny');
  });

  it('denies write_file when the target traverses a symlink outside the skills root', async () => {
    // Symlink-escape regression guard for the `assertRealProjectSkillPath`
    // catch: a skill dir symlinked to /tmp would let the agent write outside
    // the project; the realpath check stops it.
    const outside = path.join(dirs.tempDir, 'outside');
    await fs.mkdir(outside, { recursive: true });
    const skillsRoot = skillsPath(dirs.projectRoot);
    await fs.mkdir(skillsRoot, { recursive: true });
    await fs.symlink(outside, path.join(skillsRoot, 'escape'));
    const target = path.join(skillsRoot, 'escape', 'SKILL.md');
    expect(await decide(WRITE_FILE, target)).toBe('deny');
  });

  it('denies write_file when the target path is a directory, not a file', async () => {
    // `fs.stat` on a directory SUCCEEDS (`isDirectory: true`), it does not
    // throw EISDIR, so this exercises path A in evaluateScopedDecision
    // (`try { await fs.stat(); return 'deny'; }`, "target exists") rather
    // than the non-ENOENT catch. WriteFileTool would later fail with EISDIR;
    // the permission layer catches it earlier.
    const dirAsFile = skillsPath(
      dirs.projectRoot,
      'is-a-directory',
      'SKILL.md',
    );
    await fs.mkdir(dirAsFile, { recursive: true });
    expect(await decide(WRITE_FILE, dirAsFile)).toBe('deny');
  });

  // The `fs.stat` catch branch in evaluateScopedDecision is defense-in-depth:
  // any non-ENOENT stat error (EACCES, ELOOP, ENAMETOOLONG, EIO) also throws
  // one step earlier from `assertRealProjectSkillPath`'s `realpath`/`lstat`,
  // which the symlink-traversal test covers. Spying on `fs.stat` from ESM is
  // blocked (https://vitest.dev/guide/browser/#limitations) and chmod-based
  // EACCES repros don't port to Windows CI, so the branch stays untested here.
});

describe('listExistingSkillDirNames', () => {
  const dirs = useTempProject('skill-list-');

  it('returns sorted directory names that contain a SKILL.md', async () => {
    await writeSkillFile(dirs.projectRoot, 'zebra', AUTO_SKILL);
    await writeSkillFile(dirs.projectRoot, 'apple', AUTO_SKILL);
    expect(await listExistingSkillDirNames(dirs.projectRoot)).toEqual([
      'apple',
      'zebra',
    ]);
  });

  it('does not treat archive-only directory names as live skills', async () => {
    await archiveSkillDir(dirs.projectRoot, 'auto-skill-retired');
    await writeSkillFile(dirs.projectRoot, 'auto-skill-live', AUTO_SKILL);
    expect(await listExistingSkillDirNames(dirs.projectRoot)).toEqual([
      'auto-skill-live',
    ]);
  });

  it('skips directories without SKILL.md so half-built dirs do not reserve names', async () => {
    await writeSkillFile(dirs.projectRoot, 'real', AUTO_SKILL);
    await fs.mkdir(skillsPath(dirs.projectRoot, 'empty'), { recursive: true });
    expect(await listExistingSkillDirNames(dirs.projectRoot)).toEqual(['real']);
  });

  it('returns [] when the skills directory does not exist', async () => {
    expect(await listExistingSkillDirNames(dirs.projectRoot)).toEqual([]);
  });

  it('includes skills whose directory is a symlink (matches skill-load.ts convention)', async () => {
    // A real skill outside the skills root, symlinked in. `skill-load.ts:31-34`
    // and `skill-manager.ts:994-997` both treat `isDirectory() ||
    // isSymbolicLink()` as a skill candidate; the enumeration mirrors that.
    const external = path.join(dirs.tempDir, 'external-skills', 'linked');
    await fs.mkdir(external, { recursive: true });
    await fs.writeFile(path.join(external, 'SKILL.md'), AUTO_SKILL, 'utf-8');
    const skillsRoot = skillsPath(dirs.projectRoot);
    await fs.mkdir(skillsRoot, { recursive: true });
    await fs.symlink(external, path.join(skillsRoot, 'linked'));
    await writeSkillFile(dirs.projectRoot, 'regular', AUTO_SKILL);
    expect(await listExistingSkillDirNames(dirs.projectRoot)).toEqual([
      'linked',
      'regular',
    ]);
  });
});

describe('buildTaskPrompt', () => {
  const dirs = useTempProject('skill-prompt-');

  it('lists existing skill names so the agent picks a non-colliding name', async () => {
    await writeSkillFile(dirs.projectRoot, 'alpha', AUTO_SKILL);
    await writeSkillFile(dirs.projectRoot, 'beta', AUTO_SKILL);
    const prompt = await buildTaskPrompt(dirs.projectRoot);
    expect(prompt).toContain('alpha');
    expect(prompt).toContain('beta');
    expect(prompt).toMatch(/Active skill directory names/i);
    // The inspection guidance must only reference tools in this run's filter
    // (read_file/write_file/edit) — not `ls`/list_directory, which is opt-in.
    expect(prompt).toContain(
      'Use `read_file` to inspect the existing skill files listed above',
    );
    expect(prompt).not.toContain('Use `ls`');
  });

  it('lists archived directory names as reserved', async () => {
    await archiveSkillDir(dirs.projectRoot, 'auto-skill-retired');
    expect(await buildTaskPrompt(dirs.projectRoot)).toContain(
      'auto-skill-retired',
    );
  });

  it.skipIf(process.platform === 'win32')(
    'excludes archived directory names carrying control bytes from the prompt',
    async () => {
      // Mirrors the curator's charset guard: a crafted archived directory name
      // with ANSI/control bytes must not reach the task prompt verbatim.
      await archiveSkillDir(dirs.projectRoot, 'auto-skill-evil\u001b[31m');
      const prompt = await buildTaskPrompt(dirs.projectRoot);
      expect(prompt).not.toContain('\u001b[31m');
    },
  );

  it('falls back to a placeholder line when no skills exist yet', async () => {
    const prompt = await buildTaskPrompt(dirs.projectRoot);
    expect(prompt).toMatch(/no skills exist yet/i);
  });

  it('displays the project skills root derived from the same projectRoot used for enumeration', async () => {
    // Regression guard for the param collapse — the displayed root and
    // the enumerated names always come from the same source.
    await writeSkillFile(dirs.projectRoot, 'real', AUTO_SKILL);
    const prompt = await buildTaskPrompt(dirs.projectRoot);
    expect(prompt).toContain(skillsPath(dirs.projectRoot));
    expect(prompt).toContain('real');
  });

  it('instructs the agent to use the auto-skill- directory prefix (#4837)', async () => {
    // `.gitignore` re-ignores `.qwen/skills/auto-skill-*/`, so new auto skills
    // must land under an `auto-skill-`-prefixed dir to stay out of version
    // control. The prompt is the soft guard that steers the agent there.
    const prompt = await buildTaskPrompt(dirs.projectRoot);
    expect(prompt).toContain(AUTO_SKILL_DIR_PREFIX);
    expect(prompt).toContain(`.qwen/skills/${AUTO_SKILL_DIR_PREFIX}<name>/`);
    expect(prompt).toMatch(/mandatory/i);
  });
});

describe('SKILL_REVIEW_SYSTEM_PROMPT', () => {
  it('requires the auto-skill- directory prefix for new skills (#4837)', () => {
    // The system prompt and buildTaskPrompt carry the prefix instruction on
    // two independent string arrays. buildTaskPrompt is asserted above; this
    // guards the parallel system-prompt line so an edit to one can't silently
    // drop the prefix mandate from the other.
    expect(SKILL_REVIEW_SYSTEM_PROMPT).toContain(AUTO_SKILL_DIR_PREFIX);
    expect(SKILL_REVIEW_SYSTEM_PROMPT).toContain(
      `.qwen/skills/${AUTO_SKILL_DIR_PREFIX}<name>/`,
    );
    expect(SKILL_REVIEW_SYSTEM_PROMPT).toMatch(/MUST use/i);
  });
});

describe('runSkillReviewByAgent limit wiring', () => {
  const dirs = useTempProject('skill-timeout-');

  beforeEach(() => {
    vi.mocked(runForkedAgent).mockReset();
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: '',
      filesTouched: [],
    });
  });

  /** Runs a review whose config reports the given memory-agent limits. */
  function review(
    limits: { timeoutMinutes?: number; maxTurns?: number } = {},
    params: { maxTurns?: number; timeoutMs?: number } = {},
  ) {
    const config = {
      getProjectRoot: () => dirs.projectRoot,
      getPermissionManager: () => undefined,
      getMemoryAgentTimeoutMinutes: vi
        .fn()
        .mockReturnValue(limits.timeoutMinutes),
      getMemoryAgentMaxTurns: vi.fn().mockReturnValue(limits.maxTurns),
    } as unknown as Config;
    return runSkillReviewByAgent({
      config,
      projectRoot: dirs.projectRoot,
      history: [],
      ...params,
    });
  }

  it.each([
    [
      'uses the configured memory agent timeout when no timeoutMs param is passed',
      { timeoutMinutes: 30 },
      {},
      { maxTimeMinutes: 30 },
    ],
    [
      'uses the configured memory agent turn limit when maxTurns is omitted',
      { maxTurns: 25 },
      {},
      { maxTurns: 25 },
    ],
    [
      'passes the zero turn-limit sentinel through to the forked agent',
      { maxTurns: 0 },
      {},
      { maxTurns: 0 },
    ],
    [
      'lets an explicit maxTurns param override the configured value',
      { maxTurns: 25 },
      { maxTurns: 3 },
      { maxTurns: 3 },
    ],
    [
      'lets an explicit timeoutMs param override the configured value',
      { timeoutMinutes: 30 },
      { timeoutMs: 60_000 },
      { maxTimeMinutes: 1 },
    ],
    [
      'falls back to the built-in default when neither is set',
      {},
      {},
      {
        maxTurns: DEFAULT_AUTO_SKILL_MAX_TURNS,
        maxTimeMinutes: DEFAULT_AUTO_SKILL_TIMEOUT_MS / 60_000,
      },
    ],
  ])('%s', async (_title, limits, params, expected) => {
    await review(limits, params);
    expect(runForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining(expected),
    );
  });

  it('passes only always-registered tools to the forked agent', async () => {
    // list_directory is disabled by default, so it must not be requested for
    // this turn-budgeted background agent — the prompt steers to read_file.
    await review();
    const call = vi.mocked(runForkedAgent).mock.calls[0]?.[0];
    expect(call?.tools).toEqual([READ_FILE, WRITE_FILE, EDIT]);
  });
});

describe('skill-scoped shim registration-gate delegation (#10075)', () => {
  const pmOver = (basePm: unknown) => scopedPm('/project', basePm);

  it('isToolDisabledByCoreToolsAllowList delegates when present, defaults to false otherwise', () => {
    const gate = vi.fn().mockReturnValue(true);
    const delegated = pmOver({ isToolDisabledByCoreToolsAllowList: gate });
    expect(delegated.isToolDisabledByCoreToolsAllowList(EDIT)).toBe(true);
    expect(gate).toHaveBeenCalledWith(EDIT);

    expect(pmOver(undefined).isToolDisabledByCoreToolsAllowList(EDIT)).toBe(
      false,
    );

    // A base PM without the method (older shape) must not throw — the
    // scheduler's own `typeof` guard relies on this returning false.
    const legacy = pmOver({ isToolEnabled: vi.fn().mockResolvedValue(true) });
    expect(legacy.isToolDisabledByCoreToolsAllowList(EDIT)).toBe(false);
  });

  it('getToolRegistrationStatus delegates when present, defaults to registered', async () => {
    // Use a non-scoped tool: read_file/ls/edit/write_file short-circuit as
    // scoped tools before the base delegation.
    const status = vi.fn().mockResolvedValue('disabled');
    const delegated = pmOver({ getToolRegistrationStatus: status });
    await expect(delegated.getToolRegistrationStatus(WEB_FETCH)).resolves.toBe(
      'disabled',
    );
    expect(status).toHaveBeenCalledWith(WEB_FETCH, undefined, undefined);

    await expect(
      pmOver(undefined).getToolRegistrationStatus(WEB_FETCH),
    ).resolves.toBe('registered');
  });

  it('isToolEnabled forwards the alias and identity channels to the base PM', async () => {
    const isToolEnabled = vi.fn().mockResolvedValue(false);
    const delegated = pmOver({ isToolEnabled });
    const identity = { serverName: 'foo:bar', serverToolName: 'a.b' };
    await expect(
      delegated.isToolEnabled(
        'mcp__foo_bar__a_b_1aofxjh',
        ['mcp__foo:bar__a.b'],
        identity,
      ),
    ).resolves.toBe(false);
    expect(isToolEnabled).toHaveBeenCalledWith(
      'mcp__foo_bar__a_b_1aofxjh',
      ['mcp__foo:bar__a.b'],
      identity,
    );
  });
});
