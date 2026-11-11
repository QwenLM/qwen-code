/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeSkillCandidates } from './skillResource.js';
import type { SkillDefinition } from './types.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-resource-test-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function skill(name: string, location: string, resolvedPath?: string): SkillDefinition {
  return {
    name,
    description: name,
    location,
    skillRoot: path.dirname(path.dirname(location)),
    body: name,
    source: 'project',
    ...(resolvedPath ? { resolvedPath } : {}),
  } as SkillDefinition;
}

describe('normalizeSkillCandidates', () => {
  it('keeps every same-name candidate and its directory order untouched', () => {
    const commands = skill('shared', path.join(tmpDir, 'commands/shared.md'));
    const agents = skill('shared', path.join(tmpDir, '.agents/shared/SKILL.md'));
    const configSkill = skill(
      'shared',
      path.join(tmpDir, '.qwen/shared/SKILL.md'),
    );
    const normalized = normalizeSkillCandidates(
      [commands, agents, configSkill],
      'user',
    );
    expect(normalized).toEqual([commands, agents, configSkill].map((entry) => ({
      ...entry,
      source: 'user',
    })));
    expect(normalized[2].alsoDefinedAt).toBeUndefined();
  });

  it('loads one canonical file once when several roots reach it', () => {
    const first = skill(
      'aliased',
      path.join(tmpDir, 'user/SKILL.md'),
      path.join(tmpDir, 'real/SKILL.md'),
    );
    const second = skill(
      'aliased',
      path.join(tmpDir, 'project/SKILL.md'),
      path.join(tmpDir, 'real/SKILL.md'),
    );
    const normalized = normalizeSkillCandidates([first, second], 'project');
    expect(normalized).toEqual([{ ...first, source: 'project' }]);
  });

  it('skips identical name and location registrations', () => {
    const entry = skill('same', path.join(tmpDir, 'same/SKILL.md'));
    expect(normalizeSkillCandidates([entry, entry], 'user')).toEqual([
      { ...entry, source: 'user' },
    ]);
  });

  it('copies candidates so shared contributions are never mutated', () => {
    const entry = skill('same', path.join(tmpDir, 'same/SKILL.md'));
    const normalized = normalizeSkillCandidates([entry], 'user');
    expect(entry.source).toBe('project');
    expect(normalized[0].source).toBe('user');
  });
});

it('isolates diagnostics from concurrent directory sources and the one-shot loader', async () => {
  const { loadSkillDirectorySet } = await import(
    './providers/skillProvider.js'
  );
  const { loadSkillsFromDir, drainSkillLoadErrors } = await import(
    './skillLoader.js'
  );
  const roots = [
    path.join(tmpDir, 'user'),
    path.join(tmpDir, 'project'),
    path.join(tmpDir, 'one-shot'),
  ];
  await Promise.all(
    roots.map(async (root) => {
      await fs.mkdir(root, { recursive: true });
      // A root-level SKILL.md produces a deterministic discovery warning.
      await fs.writeFile(
        path.join(root, 'SKILL.md'),
        '---\ndescription: misplaced\n---\nBody',
      );
    }),
  );
  drainSkillLoadErrors();
  const loading = roots.slice(0, 2).map((root) =>
    loadSkillDirectorySet({
      skillsDir: root,
      commandsDir: path.join(root, 'commands'),
    }),
  );
  await loadSkillsFromDir(roots[2]);
  const results = await Promise.all(loading);
  expect(results[0].loadErrors.map((error) => error.filePath)).toEqual([
    path.join(roots[0], 'SKILL.md'),
  ]);
  expect(results[1].loadErrors.map((error) => error.filePath)).toEqual([
    path.join(roots[1], 'SKILL.md'),
  ]);
  expect(drainSkillLoadErrors().map((error) => error.filePath)).toEqual([
    path.join(roots[2], 'SKILL.md'),
  ]);
});
