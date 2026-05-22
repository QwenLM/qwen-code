/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for `skillReviewAgentPlanner` — the planner side of the auto-skill
 * review flow. The on-disk safety net introduced for issue #4437 lives one
 * layer down (the tool wrapper) and is covered by
 * `skillCollisionAwareWriteFile.test.ts`. The cases below cover:
 *
 *   1. The scoped permission layer's behaviour, which by design only
 *      governs path scope + symlink safety — name-collision detection is
 *      explicitly delegated to the tool-layer wrapper because the
 *      permission API can deny/allow but cannot redirect a write.
 *   2. `buildTaskPrompt` includes existing skill names so the agent picks
 *      a fresh name on its first attempt (defense-in-depth above the
 *      rename safety net).
 *   3. `readSkillCollisionStrategy` round-trips the strategy via the
 *      scoped config so `runSkillReviewByAgent` can install the guard.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../config/config.js';
import {
  buildTaskPrompt,
  createSkillScopedAgentConfig,
  readSkillCollisionStrategy,
} from './skillReviewAgentPlanner.js';
import { ToolNames } from '../tools/tool-names.js';
import { getProjectSkillsRoot } from '../skills/skill-paths.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMinimalConfig(projectRoot: string): Config {
  return {
    getProjectRoot: () => projectRoot,
    getPermissionManager: () => undefined,
  } as unknown as Config;
}

async function writeSkillFile(
  projectRoot: string,
  skillName: string,
  content: string,
): Promise<string> {
  const skillDir = path.join(projectRoot, '.qwen', 'skills', skillName);
  await fs.mkdir(skillDir, { recursive: true });
  const filePath = path.join(skillDir, 'SKILL.md');
  await fs.writeFile(filePath, content, 'utf-8');
  return filePath;
}

const AUTO_SKILL_CONTENT = `---
name: my-refactoring-skill
description: How to refactor legacy code
source: auto-skill
extracted_at: '2026-01-01T00:00:00.000Z'
---

Original auto-skill body — must not be silently replaced.
`;

const NEW_AUTO_SKILL_CONTENT = `---
name: my-refactoring-skill
description: Completely different approach to refactoring
source: auto-skill
extracted_at: '2026-05-22T00:00:00.000Z'
---

Entirely new body written by a second skill-review run.
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('skillReviewAgentPlanner — permission scope (issue #4437 baseline)', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'skill-review-collision-'),
    );
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // ─── BUG REPRODUCTION ────────────────────────────────────────────────────
  // The permission layer allows write_file to an existing auto-skill path.
  // There is no collision detection — the write proceeds silently, wiping the
  // prior SKILL.md content.

  it('permission layer allows write_file to an existing auto-skill path (collision is handled by the tool wrapper instead)', async () => {
    // 1. Set up an existing auto-skill on disk.
    const skillFilePath = await writeSkillFile(
      projectRoot,
      'my-refactoring-skill',
      AUTO_SKILL_CONTENT,
    );

    // 2. Build the scoped permission manager the skill-review agent uses.
    const config = makeMinimalConfig(projectRoot);
    const scopedConfig = createSkillScopedAgentConfig(config, projectRoot);
    const pm = scopedConfig.getPermissionManager?.();
    expect(pm).toBeDefined();

    // 3. Simulate the agent calling write_file on the same path with new content.
    const decision = await pm!.evaluate({
      toolName: ToolNames.WRITE_FILE,
      filePath: skillFilePath,
    });

    // Intentional: the permission layer can only return allow/deny/ask
    // and cannot redirect a write. Rename-on-collision lives in the tool
    // wrapper installed by `runSkillReviewByAgent`. The permission layer
    // is the path-scope/symlink-safety guard and stays narrow.
    expect(decision).toBe('allow');

    // 4. Demonstrate that an actual overwrite goes through unchecked: write
    //    the new content to the same path directly (as write_file would do).
    await fs.writeFile(skillFilePath, NEW_AUTO_SKILL_CONTENT, 'utf-8');
    const written = await fs.readFile(skillFilePath, 'utf-8');

    // The original content is gone — no warning, no merge, no collision log.
    expect(written).toBe(NEW_AUTO_SKILL_CONTENT);
    expect(written).not.toContain(
      'Original auto-skill body — must not be silently replaced.',
    );
  });

  // ─── CONFIRMED SAFE CASE: user skill is blocked ──────────────────────────
  // For contrast, a user-created skill (no `source: auto-skill`) correctly
  // returns 'deny', so that case is not part of the bug.

  it('correctly denies write_file to a user-created skill (no source: auto-skill)', async () => {
    const userSkillContent = `---
name: my-refactoring-skill
description: User-authored skill
---

User-authored body — this skill has no source: auto-skill marker.
`;
    const skillFilePath = await writeSkillFile(
      projectRoot,
      'my-refactoring-skill',
      userSkillContent,
    );

    const config = makeMinimalConfig(projectRoot);
    const scopedConfig = createSkillScopedAgentConfig(config, projectRoot);
    const pm = scopedConfig.getPermissionManager?.();
    expect(pm).toBeDefined();

    const decision = await pm!.evaluate({
      toolName: ToolNames.WRITE_FILE,
      filePath: skillFilePath,
    });

    // This case IS protected — only auto-skills can be overwritten.
    expect(decision).toBe('deny');
  });

  // ─── ABSENCE OF NAME CHECK ────────────────────────────────────────────────
  // The permission layer makes no distinction between these two `write_file`
  // calls, even though one is an update and the other is a collision:
  //
  //   (A) write_file(path=skills/foo/SKILL.md, content=updated-foo-skill)
  //   (B) write_file(path=skills/foo/SKILL.md, content=completely-different-bar-skill)
  //
  // Both receive 'allow' identically — there is no name-level collision guard.

  it('permission layer cannot distinguish a same-name collision from a legitimate update — that is the wrappers job', async () => {
    const skillFilePath = await writeSkillFile(
      projectRoot,
      'foo-skill',
      `---
name: foo-skill
description: The original foo skill
source: auto-skill
extracted_at: '2026-01-01T00:00:00.000Z'
---

Original foo skill body.
`,
    );

    const config = makeMinimalConfig(projectRoot);
    const scopedConfig = createSkillScopedAgentConfig(config, projectRoot);
    const pm = scopedConfig.getPermissionManager?.();
    expect(pm).toBeDefined();

    // Case A: legitimate update — same skill name, updated content.
    const updateDecision = await pm!.evaluate({
      toolName: ToolNames.WRITE_FILE,
      filePath: skillFilePath,
    });

    // Case B: collision — different skill name, but same file path.
    // The agent could generate `name: bar-skill` in the frontmatter of this write.
    // The permission layer has no mechanism to detect this and still returns 'allow'.
    const collisionDecision = await pm!.evaluate({
      toolName: ToolNames.WRITE_FILE,
      filePath: skillFilePath,
    });

    // Both decisions are identical at the permission layer; the tool
    // wrapper (`SkillCollisionAwareWriteFileTool`) is responsible for the
    // rename-on-collision behaviour observed by the agent.
    expect(updateDecision).toBe('allow');
    expect(collisionDecision).toBe('allow');

    // Specifically, no code path in evaluateScopedDecision / hasAutoSkillSource
    // inspects the CONTENT being written or validates that the `name:` field in
    // the new content matches the skill already at that path. The only check is
    // whether the EXISTING file has `source: auto-skill` — which it does — so
    // any write content is accepted at this layer.
  });
});

describe('buildTaskPrompt — defense-in-depth skill enumeration', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-task-prompt-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('lists existing skill directory names so the agent picks a non-colliding name on the first attempt', async () => {
    await writeSkillFile(projectRoot, 'alpha-skill', 'alpha\n');
    await writeSkillFile(projectRoot, 'beta-skill', 'beta\n');

    const prompt = await buildTaskPrompt(
      getProjectSkillsRoot(projectRoot),
      projectRoot,
    );

    expect(prompt).toMatch(/Existing skills/);
    expect(prompt).toContain('alpha-skill');
    expect(prompt).toContain('beta-skill');
    // Should still steer the agent toward `edit` for updates.
    expect(prompt).toMatch(/use `edit`/i);
  });

  it('renders a "no skills exist" line when the project has no skills yet', async () => {
    const prompt = await buildTaskPrompt(
      getProjectSkillsRoot(projectRoot),
      projectRoot,
    );
    expect(prompt).toMatch(/No skills exist yet/);
  });
});

describe('readSkillCollisionStrategy', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-strategy-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('defaults to "rename" when the caller does not specify a strategy', () => {
    const scoped = createSkillScopedAgentConfig(
      makeMinimalConfig(projectRoot),
      projectRoot,
    );
    expect(readSkillCollisionStrategy(scoped)).toBe('rename');
  });

  it('round-trips a caller-supplied strategy through the scoped config', () => {
    const scoped = createSkillScopedAgentConfig(
      makeMinimalConfig(projectRoot),
      projectRoot,
      { collisionStrategy: 'skip' },
    );
    expect(readSkillCollisionStrategy(scoped)).toBe('skip');
  });
});
