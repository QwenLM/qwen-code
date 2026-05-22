/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fix-verification tests for issue #4437.
 *
 * Exercises the wrapping `SkillCollisionAwareWriteFileTool` end-to-end:
 * given a target path that already exists, the wrapper redirects the
 * underlying WriteFileTool to a renamed sibling so the existing file is
 * preserved.
 *
 * The key scenario the reporter cared about — an auto-skill clobbering a
 * USER skill — is covered explicitly, since the guard's rename behaviour
 * does not depend on the existing file's frontmatter.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import { WriteFileTool } from '../tools/write-file.js';
import { SkillCollisionAwareWriteFileTool } from './skillCollisionAwareWriteFile.js';
import { FileReadCache } from '../services/fileReadCache.js';
import { StandardFileSystemService } from '../services/fileSystemService.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';

// The WriteFileTool's confirmation flow constructs a GeminiClient via
// `getGeminiClient()`; mock it out so we don't pull in an LLM dependency.
vi.mock('../core/client.js');
// Telemetry loggers fire side effects; stub them.
vi.mock('../telemetry/loggers.js', () => ({
  logFileOperation: vi.fn(),
  logToolCall: vi.fn(),
}));

const USER_SKILL_BODY = `---
name: precious-user-skill
description: Hand-written by a human; must not be lost
---

This skill was authored by the user. It has NO 'source: auto-skill'.
`;

const AUTO_SKILL_BODY = `---
name: previously-auto
description: Earlier auto-skill content
source: auto-skill
extracted_at: '2026-01-01T00:00:00.000Z'
---

Earlier auto-skill body.
`;

const NEW_CONTENT_FROM_AGENT = `---
name: brand-new-skill
description: Fresh content from this review run
source: auto-skill
extracted_at: '2026-05-22T00:00:00.000Z'
---

Brand-new body; should land at the renamed slot, not overwrite.
`;

function buildConfigStub(projectRoot: string): Config {
  const fsService = new StandardFileSystemService();
  const fileReadCache = new FileReadCache();
  return {
    getTargetDir: () => projectRoot,
    getProjectRoot: () => projectRoot,
    getApprovalMode: () => ApprovalMode.YOLO,
    setApprovalMode: vi.fn(),
    getFileSystemService: () => fsService,
    getWorkspaceContext: () => createMockWorkspaceContext(projectRoot),
    getFileReadCache: () => fileReadCache,
    // Skip the prior-read TOCTOU check — the auto-skill agent never reads
    // a brand-new SKILL.md before writing it, and existence of the prior
    // file is the very signal the wrapper acts on.
    getFileReadCacheDisabled: () => true,
    getDefaultFileEncoding: () => 'utf-8',
    getDebugMode: () => false,
    getGeminiClient: vi.fn(),
    getFileHistoryService: () => ({ trackEdit: vi.fn() }),
  } as unknown as Config;
}

describe('SkillCollisionAwareWriteFileTool (issue #4437)', () => {
  let tempDir: string;
  let projectRoot: string;
  let config: Config;
  let inner: WriteFileTool;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-wrap-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    config = buildConfigStub(projectRoot);
    inner = new WriteFileTool(config);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // ─── PRIMARY FIX SCENARIO ─────────────────────────────────────────────
  // Reporter's worst case: auto-skill creation clobbers a user-authored
  // skill. After the fix, the original file is preserved and the new
  // content lands at `<name>-2/SKILL.md`.

  it('preserves a USER skill when the agent writes to its path (rename strategy)', async () => {
    const skillName = 'precious-user-skill';
    const userPath = path.join(
      projectRoot,
      '.qwen',
      'skills',
      skillName,
      'SKILL.md',
    );
    await fs.mkdir(path.dirname(userPath), { recursive: true });
    await fs.writeFile(userPath, USER_SKILL_BODY, 'utf-8');

    const tool = new SkillCollisionAwareWriteFileTool(
      inner,
      projectRoot,
      'rename',
    );
    const invocation = tool.build({
      file_path: userPath,
      content: NEW_CONTENT_FROM_AGENT,
    });
    const result = await invocation.execute(new AbortController().signal);

    expect(result.error).toBeUndefined();

    // (a) The original user file is intact.
    const preserved = await fs.readFile(userPath, 'utf-8');
    expect(preserved).toBe(USER_SKILL_BODY);

    // (b) The new skill ended up at <name>-2/SKILL.md.
    const renamedPath = path.join(
      projectRoot,
      '.qwen',
      'skills',
      `${skillName}-2`,
      'SKILL.md',
    );
    const renamedContent = await fs.readFile(renamedPath, 'utf-8');
    expect(renamedContent).toBe(NEW_CONTENT_FROM_AGENT);

    // (c) The tool result advertises the rename so the agent sees what happened.
    const llm =
      typeof result.llmContent === 'string'
        ? result.llmContent
        : JSON.stringify(result.llmContent);
    expect(llm).toMatch(/collision/i);
    expect(llm).toContain(renamedPath);
  });

  // ─── AUTO-SKILL CLOBBER ───────────────────────────────────────────────
  // Same rename behaviour applies when the existing file is itself an
  // auto-skill — i.e. one auto-skill review trying to overwrite another.

  it('preserves an existing AUTO-skill when the agent writes to its path', async () => {
    const skillName = 'previously-auto';
    const target = path.join(
      projectRoot,
      '.qwen',
      'skills',
      skillName,
      'SKILL.md',
    );
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, AUTO_SKILL_BODY, 'utf-8');

    const tool = new SkillCollisionAwareWriteFileTool(
      inner,
      projectRoot,
      'rename',
    );
    const result = await tool
      .build({ file_path: target, content: NEW_CONTENT_FROM_AGENT })
      .execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    const preserved = await fs.readFile(target, 'utf-8');
    expect(preserved).toBe(AUTO_SKILL_BODY);
    const renamed = await fs.readFile(
      path.join(projectRoot, '.qwen', 'skills', `${skillName}-2`, 'SKILL.md'),
      'utf-8',
    );
    expect(renamed).toBe(NEW_CONTENT_FROM_AGENT);
  });

  // ─── HAPPY PATH ───────────────────────────────────────────────────────
  // Writes to a non-existing path are passthrough — no rename, no log.

  it('writes directly when the target path does not exist', async () => {
    const target = path.join(
      projectRoot,
      '.qwen',
      'skills',
      'brand-new-skill',
      'SKILL.md',
    );

    const tool = new SkillCollisionAwareWriteFileTool(
      inner,
      projectRoot,
      'rename',
    );
    const result = await tool
      .build({ file_path: target, content: NEW_CONTENT_FROM_AGENT })
      .execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    const written = await fs.readFile(target, 'utf-8');
    expect(written).toBe(NEW_CONTENT_FROM_AGENT);
    const llm =
      typeof result.llmContent === 'string'
        ? result.llmContent
        : JSON.stringify(result.llmContent);
    expect(llm).not.toMatch(/collision/i);
  });

  // ─── SKIP STRATEGY ────────────────────────────────────────────────────

  it("'skip' strategy aborts the write and surfaces a structured error", async () => {
    const target = path.join(
      projectRoot,
      '.qwen',
      'skills',
      'precious',
      'SKILL.md',
    );
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, USER_SKILL_BODY, 'utf-8');

    const tool = new SkillCollisionAwareWriteFileTool(
      inner,
      projectRoot,
      'skip',
    );
    const result = await tool
      .build({ file_path: target, content: NEW_CONTENT_FROM_AGENT })
      .execute(new AbortController().signal);

    expect(result.error).toBeDefined();
    expect(result.error?.message).toMatch(/already exists/);
    // Original untouched.
    expect(await fs.readFile(target, 'utf-8')).toBe(USER_SKILL_BODY);
    // No sibling was created.
    await expect(
      fs.access(
        path.join(projectRoot, '.qwen', 'skills', 'precious-2', 'SKILL.md'),
      ),
    ).rejects.toThrow();
  });

  // ─── OVERWRITE STRATEGY ───────────────────────────────────────────────
  // Provided for users who explicitly opt back into the pre-fix behaviour.

  it("'overwrite' strategy preserves the pre-fix behaviour and clobbers the existing file", async () => {
    const target = path.join(
      projectRoot,
      '.qwen',
      'skills',
      'override-me',
      'SKILL.md',
    );
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, AUTO_SKILL_BODY, 'utf-8');

    const tool = new SkillCollisionAwareWriteFileTool(
      inner,
      projectRoot,
      'overwrite',
    );
    const result = await tool
      .build({ file_path: target, content: NEW_CONTENT_FROM_AGENT })
      .execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(await fs.readFile(target, 'utf-8')).toBe(NEW_CONTENT_FROM_AGENT);
    // No rename happened.
    await expect(
      fs.access(
        path.join(projectRoot, '.qwen', 'skills', 'override-me-2', 'SKILL.md'),
      ),
    ).rejects.toThrow();
  });
});
