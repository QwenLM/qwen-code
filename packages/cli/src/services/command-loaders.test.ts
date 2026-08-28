/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { BuiltinCommandLoader } from './BuiltinCommandLoader.js';
import { BundledSkillLoader } from './BundledSkillLoader.js';
import { FileCommandLoader } from './FileCommandLoader.js';
import { McpPromptLoader } from './McpPromptLoader.js';
import { SavedWorkflowLoader } from './saved-workflow-loader.js';
import { SkillCommandLoader } from './SkillCommandLoader.js';
import type { ICommandLoader } from './types.js';
import { buildCommandLoaders } from './command-loaders.js';

function positionOf(
  loaders: ICommandLoader[],
  label: string,
  predicate: (loader: ICommandLoader) => boolean,
): number {
  const index = loaders.findIndex(predicate);
  expect(index, `no loader matched: ${label}`).toBeGreaterThanOrEqual(0);
  return index;
}

describe('buildCommandLoaders', () => {
  const loaders = buildCommandLoaders(null);

  const skillLoaders = () =>
    loaders.filter(
      (l): l is SkillCommandLoader => l instanceof SkillCommandLoader,
    );

  it('aggregates every loader exactly once per role (#9408 R1-7)', () => {
    expect(loaders.some((l) => l instanceof McpPromptLoader)).toBe(true);
    expect(loaders.some((l) => l instanceof BuiltinCommandLoader)).toBe(true);
    expect(loaders.some((l) => l instanceof BundledSkillLoader)).toBe(true);
    expect(loaders.some((l) => l instanceof SavedWorkflowLoader)).toBe(true);
    expect(loaders.some((l) => l instanceof FileCommandLoader)).toBe(true);
    expect(skillLoaders()).toHaveLength(2);
  });

  it('splits skill levels so local and extension skills load apart (#9408 R1-7)', () => {
    const levels = skillLoaders().map((l) => [...l.levels].sort());
    expect(levels).toEqual([['project', 'user'], ['extension']]);
  });

  it('loads local skills before file commands so a user command keeps its name (#9408 R1-7)', () => {
    const localSkills = positionOf(
      loaders,
      'local skill loader',
      (l) => l instanceof SkillCommandLoader && l.levels.includes('user'),
    );
    const fileCommands = positionOf(
      loaders,
      'file command loader',
      (l) => l instanceof FileCommandLoader,
    );

    // An extensionless skill never reaches the collision gate in
    // CommandService, so array order alone decides the winner. Keeping local
    // skills ahead of file commands preserves the precedence that held before
    // #9408: the user-authored command is not silently clobbered.
    expect(localSkills).toBeLessThan(fileCommands);
  });

  it('loads extension skills after file commands so the suffix branch fires (#9408 R1-7)', () => {
    const fileCommands = positionOf(
      loaders,
      'file command loader',
      (l) => l instanceof FileCommandLoader,
    );
    const extensionSkills = positionOf(
      loaders,
      'extension skill loader',
      (l) => l instanceof SkillCommandLoader && l.levels.includes('extension'),
    );

    // Extension skills do carry an `extensionName`, so a file command claiming
    // a qualified skill name must register first for CommandService to suffix
    // the skill instead of overwriting it.
    expect(extensionSkills).toBeGreaterThan(fileCommands);
  });

  it('puts the extension skill loader last of all (#9408 R1-7)', () => {
    const extensionSkills = positionOf(
      loaders,
      'extension skill loader',
      (l) => l instanceof SkillCommandLoader && l.levels.includes('extension'),
    );
    expect(extensionSkills).toBe(loaders.length - 1);
  });
});
