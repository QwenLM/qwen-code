/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import type { Config } from '../config/config.js';
import { createMemoryPromptInput } from '../prompts/render-inputs.js';
import type { BundledSkillRegistration } from '../skills/bundled/index.js';
import { registerMemoryTypesSkill } from '../skills/bundled/memory-types.js';
import {
  buildMemoryPromptBody,
  loadAutoMemoryPrompt,
  type MemoryPromptOptions,
} from './auto-memory-prompt.js';
import {
  EXPLICIT_MEMORY_TYPES_SECTION,
  MEMORY_TYPES_SUMMARY,
  getMemoryTypesBody,
} from './memory-types.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('memory-types skill', () => {
  it('is available whenever Auto Memory is enabled without a separate gate', async () => {
    let enabled = true;
    const skills: BundledSkillRegistration[] = [];
    registerMemoryTypesSkill(
      { registerBundledSkill: (skill) => skills.push(skill) },
      { isAutoMemoryEnabled: () => enabled } as unknown as Config,
    );

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: 'memory-types',
      userInvocable: false,
      disableModelInvocation: false,
    });
    expect(skills[0].isEnabled?.()).toBe(true);
    expect(await skills[0].getBody?.()).toBe(
      EXPLICIT_MEMORY_TYPES_SECTION.join('\n'),
    );
    enabled = false;
    expect(skills[0].isEnabled?.()).toBe(false);
    enabled = true;
    expect(skills[0].isEnabled?.()).toBe(true);
  });

  const options: MemoryPromptOptions = {
    displayName: 'auto memory',
    roots: [{ scope: 'project', dir: '/tmp/memory', indexContent: '' }],
    includeIndexContent: false,
  };

  it.each(['full', 'lean'] as const)(
    'uses skill loading by default in %s without inlining the detailed body',
    (variant) => {
      const prompt = buildMemoryPromptBody(options, variant);
      expect(prompt).toContain(MEMORY_TYPES_SUMMARY.join('\n'));
      expect(prompt).toContain(
        'When you need detailed memory type definitions, invoke the `memory-types` skill',
      );
      expect(prompt).toContain('Re-load it after compaction');
      expect(prompt).not.toContain('Before creating or updating a memory');
      expect(prompt).not.toContain('<types>');
      expect(prompt).not.toContain('## How to save memories');
      expect(prompt).not.toContain('## What NOT to save in memory');
      expect(prompt).not.toContain('metadata:');
    },
  );

  it('keeps the complete type definitions in the skill body', async () => {
    const body = await getMemoryTypesBody();
    expect(body).toBe(EXPLICIT_MEMORY_TYPES_SECTION.join('\n'));
    for (const type of ['user', 'feedback', 'project', 'reference']) {
      expect(body).toContain(`<name>${type}</name>`);
    }
    expect(body).toContain('<body_structure>');
    expect(body).not.toContain('<when_to_save>');
  });

  it('reports skill for both bundles while preserving SDK-provided instructions', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'memory-types-'));
    tempDirs.push(dir);
    const config = {
      isAutoMemoryEnabled: () => true,
      isAutoMemoryUserScopeEnabled: () => false,
      storage: { getProjectMemoryTempDir: () => dir },
    } as unknown as Config;
    // Prompt construction does not probe tools, permissions, or a separate gate.
    const ctx = { config } as AgentLoopContext;
    const native = createMemoryPromptInput(ctx, 'default', 'headless')!;
    for (const bundle of ['full', 'lean'] as const) {
      expect(native.versionForBundle?.(bundle)).toBe('skill');
      expect(await native.computeForBundle(bundle)).toContain(
        'invoke the `memory-types` skill',
      );
    }

    const generated = createMemoryPromptInput(ctx, 'default', 'sdk', {
      owner: 'sdk',
      shapeKey: 1,
      promptsByBundle: { full: 'FULL SDK MEMORY', lean: 'LEAN SDK MEMORY' },
    })!;
    expect(generated.versionForBundle?.('full')).toBe('skill');
    expect(generated.versionForBundle?.('lean')).toBe('skill');
    expect(await generated.computeForBundle('full')).toBe('FULL SDK MEMORY');
    expect(await generated.computeForBundle('lean')).toBe('LEAN SDK MEMORY');

    const custom = createMemoryPromptInput(ctx, 'default', 'sdk', {
      owner: 'sdk',
      shapeKey: 2,
      prompt: 'SDK exact body',
    })!;
    for (const bundle of ['full', 'lean'] as const) {
      expect(custom.versionForBundle?.(bundle)).toBe('custom');
      expect(await custom.computeForBundle(bundle)).toBe('SDK exact body');
    }
    expect(
      createMemoryPromptInput(ctx, 'default', 'sdk', { owner: 'none' }),
    ).toBeUndefined();
  });

  it('does not inject the memory section when Auto Memory is disabled', async () => {
    const config = { isAutoMemoryEnabled: () => false } as unknown as Config;
    expect(await loadAutoMemoryPrompt(config, 'full')).toBeNull();
    expect(await loadAutoMemoryPrompt(config, 'lean')).toBeNull();
  });
});
