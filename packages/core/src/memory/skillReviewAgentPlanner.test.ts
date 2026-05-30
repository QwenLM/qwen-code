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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../config/config.js';
import {
  buildTaskPrompt,
  createSkillScopedAgentConfig,
  listExistingSkillDirNames,
} from './skillReviewAgentPlanner.js';
import { ToolNames } from '../tools/tool-names.js';

function makeMinimalConfig(projectRoot: string): Config {
  return {
    getProjectRoot: () => projectRoot,
    getPermissionManager: () => undefined,
  } as unknown as Config;
}

/**
 * Build the scoped Config and return its non-null PermissionManager.
 * `createSkillScopedAgentConfig` always installs one, but Config's
 * declared `getPermissionManager(): PermissionManager | null` forces
 * tests to launder the null at the call site — this helper does it
 * once with an assertion that fires loudly if the contract ever breaks.
 */
function scopedPm(projectRoot: string) {
  const scoped = createSkillScopedAgentConfig(
    makeMinimalConfig(projectRoot),
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

async function writeSkillFile(
  projectRoot: string,
  skillName: string,
  content: string,
): Promise<string> {
  const dir = path.join(projectRoot, '.qwen', 'skills', skillName);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'SKILL.md');
  await fs.writeFile(filePath, content, 'utf-8');
  return filePath;
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
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-review-v2-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("denies write_file to an existing AUTO-skill path (the #4437 bug — was 'allow')", async () => {
    const filePath = await writeSkillFile(projectRoot, 'my-skill', AUTO_SKILL);
    const pm = scopedPm(projectRoot);

    const decision = await pm.evaluate({
      toolName: ToolNames.WRITE_FILE,
      filePath,
    });
    expect(decision).toBe('deny');
  });

  it('denies write_file to an existing USER-skill path (already worked — kept as regression guard)', async () => {
    const filePath = await writeSkillFile(projectRoot, 'my-skill', USER_SKILL);
    const pm = scopedPm(projectRoot);

    const decision = await pm.evaluate({
      toolName: ToolNames.WRITE_FILE,
      filePath,
    });
    expect(decision).toBe('deny');
  });

  it('allows write_file to a fresh path that does not yet exist', async () => {
    const fresh = path.join(
      projectRoot,
      '.qwen',
      'skills',
      'brand-new',
      'SKILL.md',
    );
    const pm = scopedPm(projectRoot);

    const decision = await pm.evaluate({
      toolName: ToolNames.WRITE_FILE,
      filePath: fresh,
    });
    expect(decision).toBe('allow');
  });

  it('still allows edit on an existing auto-skill (update path preserved)', async () => {
    const filePath = await writeSkillFile(projectRoot, 'my-skill', AUTO_SKILL);
    const pm = scopedPm(projectRoot);

    const decision = await pm.evaluate({
      toolName: ToolNames.EDIT,
      filePath,
    });
    expect(decision).toBe('allow');
  });

  it('still denies edit on a user skill (update path safety preserved)', async () => {
    const filePath = await writeSkillFile(projectRoot, 'my-skill', USER_SKILL);
    const pm = scopedPm(projectRoot);

    const decision = await pm.evaluate({
      toolName: ToolNames.EDIT,
      filePath,
    });
    expect(decision).toBe('deny');
  });

  it('write_file deny rule message points the agent at a fresh name', async () => {
    const filePath = await writeSkillFile(projectRoot, 'my-skill', AUTO_SKILL);
    const pm = scopedPm(projectRoot);

    const rule = pm.findMatchingDenyRule({
      toolName: ToolNames.WRITE_FILE,
      filePath,
    });
    expect(rule).toMatch(/<name>-2/);
    expect(rule).toMatch(/edit/);
  });

  it('denies write_file to a path outside the project skills root', async () => {
    // Security-boundary regression guard for the `isProjectSkillPath`
    // false branch — without it the agent could escape to anywhere
    // reachable from CWD.
    const escape = path.join(projectRoot, 'NOT-SKILLS', 'evil.md');
    const pm = scopedPm(projectRoot);
    expect(
      await pm.evaluate({
        toolName: ToolNames.WRITE_FILE,
        filePath: escape,
      }),
    ).toBe('deny');
  });

  it('denies write_file to a non-SKILL.md path inside the skills root', async () => {
    // Auxiliary files (NOTES.md, attachments) must not land in the
    // skills dir — SkillManager would ignore them but they'd still
    // pollute the layout. Tightening the basename invariant is the
    // hard guard for that.
    const aux = path.join(
      projectRoot,
      '.qwen',
      'skills',
      'my-skill',
      'NOTES.md',
    );
    await fs.mkdir(path.dirname(aux), { recursive: true });
    const pm = scopedPm(projectRoot);
    expect(
      await pm.evaluate({
        toolName: ToolNames.WRITE_FILE,
        filePath: aux,
      }),
    ).toBe('deny');
  });

  it('denies write_file when the target traverses a symlink outside the skills root', async () => {
    // Symlink-escape regression guard for the `assertRealProjectSkillPath`
    // catch. A skill dir that's actually a symlink to /tmp would let the
    // agent write outside the project; the realpath check stops it.
    const outside = path.join(tempDir, 'outside');
    await fs.mkdir(outside, { recursive: true });
    const skillsRoot = path.join(projectRoot, '.qwen', 'skills');
    await fs.mkdir(skillsRoot, { recursive: true });
    await fs.symlink(outside, path.join(skillsRoot, 'escape'));
    const target = path.join(skillsRoot, 'escape', 'SKILL.md');
    const pm = scopedPm(projectRoot);
    expect(
      await pm.evaluate({
        toolName: ToolNames.WRITE_FILE,
        filePath: target,
      }),
    ).toBe('deny');
  });

  it('denies write_file when the target path is a directory, not a file', async () => {
    // `fs.stat` on a directory SUCCEEDS (returning stats with
    // `isDirectory: true`); it does not throw EISDIR. So this exercise
    // path A in evaluateScopedDecision — `try { await fs.stat(); return
    // 'deny'; }` — i.e. "target exists" rather than the non-ENOENT
    // catch. WriteFileTool would later fail with EISDIR on the actual
    // write, but the permission layer catches it earlier here.
    const dirAsFile = path.join(
      projectRoot,
      '.qwen',
      'skills',
      'is-a-directory',
      'SKILL.md',
    );
    await fs.mkdir(dirAsFile, { recursive: true });
    const pm = scopedPm(projectRoot);
    expect(
      await pm.evaluate({
        toolName: ToolNames.WRITE_FILE,
        filePath: dirAsFile,
      }),
    ).toBe('deny');
  });

  // Note on coverage of the `fs.stat` catch branch in
  // evaluateScopedDecision:
  // The branch is defense-in-depth — anything that would make `fs.stat`
  // throw a non-ENOENT error (EACCES, ELOOP, ENAMETOOLONG, EIO) also
  // throws from `assertRealProjectSkillPath`'s `realpath`/`lstat` one
  // step earlier, which is exercised by the symlink-traversal test
  // above. Spying on `fs.stat` from ESM tests is blocked
  // (https://vitest.dev/guide/browser/#limitations), and chmod-based
  // reproductions of EACCES are non-portable to Windows CI. The deny
  // contract is straightforward enough that the structural duplication
  // here is acceptable.
});

describe('listExistingSkillDirNames', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-list-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns sorted directory names that contain a SKILL.md', async () => {
    await writeSkillFile(projectRoot, 'zebra', AUTO_SKILL);
    await writeSkillFile(projectRoot, 'apple', AUTO_SKILL);
    expect(await listExistingSkillDirNames(projectRoot)).toEqual([
      'apple',
      'zebra',
    ]);
  });

  it('skips directories without SKILL.md so half-built dirs do not reserve names', async () => {
    await writeSkillFile(projectRoot, 'real', AUTO_SKILL);
    await fs.mkdir(path.join(projectRoot, '.qwen', 'skills', 'empty'), {
      recursive: true,
    });
    expect(await listExistingSkillDirNames(projectRoot)).toEqual(['real']);
  });

  it('returns [] when the skills directory does not exist', async () => {
    expect(await listExistingSkillDirNames(projectRoot)).toEqual([]);
  });

  it('includes skills whose directory is a symlink (matches skill-load.ts convention)', async () => {
    // Build a real skill outside the skills root, then symlink it in.
    // `skill-load.ts:31-34` and `skill-manager.ts:994-997` both treat
    // `isDirectory() || isSymbolicLink()` as a skill candidate; the
    // enumeration here mirrors that.
    const external = path.join(tempDir, 'external-skills', 'linked');
    await fs.mkdir(external, { recursive: true });
    await fs.writeFile(path.join(external, 'SKILL.md'), AUTO_SKILL, 'utf-8');
    const skillsRoot = path.join(projectRoot, '.qwen', 'skills');
    await fs.mkdir(skillsRoot, { recursive: true });
    await fs.symlink(external, path.join(skillsRoot, 'linked'));
    await writeSkillFile(projectRoot, 'regular', AUTO_SKILL);
    expect(await listExistingSkillDirNames(projectRoot)).toEqual([
      'linked',
      'regular',
    ]);
  });
});

describe('buildTaskPrompt', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-prompt-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('lists existing skill names so the agent picks a non-colliding name', async () => {
    await writeSkillFile(projectRoot, 'alpha', AUTO_SKILL);
    await writeSkillFile(projectRoot, 'beta', AUTO_SKILL);
    const prompt = await buildTaskPrompt(projectRoot);
    expect(prompt).toContain('alpha');
    expect(prompt).toContain('beta');
    expect(prompt).toMatch(/do NOT reuse/i);
  });

  it('falls back to a placeholder line when no skills exist yet', async () => {
    const prompt = await buildTaskPrompt(projectRoot);
    expect(prompt).toMatch(/no skills exist yet/i);
  });

  it('displays the project skills root derived from the same projectRoot used for enumeration', async () => {
    // Regression guard for the param collapse — the displayed root and
    // the enumerated names always come from the same source.
    await writeSkillFile(projectRoot, 'real', AUTO_SKILL);
    const prompt = await buildTaskPrompt(projectRoot);
    expect(prompt).toContain(path.join(projectRoot, '.qwen', 'skills'));
    expect(prompt).toContain('real');
  });
});
