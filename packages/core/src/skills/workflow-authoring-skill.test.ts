/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Config } from '../config/config.js';
import { buildSkillLlmContent } from '../tools/skill-utils.js';
import { ToolNames } from '../tools/tool-names.js';
import { parseSkillContent } from './skill-load.js';
import {
  isWorkflowAuthoringSkillAvailable,
  readWorkflowAuthoringReference,
  resolveWorkflowAuthoringAutoload,
  WORKFLOW_AUTHORING_SKILL_NAME,
} from './workflow-authoring-skill.js';

const SKILL_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'bundled',
  WORKFLOW_AUTHORING_SKILL_NAME,
  'SKILL.md',
);

/**
 * A skill-load tracker with the same surface as `SkillTool`'s, so a test can
 * assert on what the trigger registered. Structural on purpose — building a
 * real `SkillTool` needs a wired `SkillManager` and a watcher, none of which
 * this module touches.
 */
function fakeSkillTool() {
  const names = new Set<string>();
  const contents = new Set<string>();
  return {
    getLoadedSkillNames: () => names as ReadonlySet<string>,
    getLoadedSkillContents: () => contents as ReadonlySet<string>,
    markSkillLoaded: (name: string, content?: string) => {
      names.add(name);
      if (content !== undefined) contents.add(content);
    },
  };
}

interface StubOptions {
  skillManager?: boolean;
  skillTool?: ReturnType<typeof fakeSkillTool> | null;
  toolNames?: string[];
  skillEnabled?: boolean;
  /** The manager's cached bundled entry, when the test wants it consulted. */
  cachedSkills?: Array<{ name: string; body: string; filePath: string }>;
}

function stubConfig(options: StubOptions = {}): Config {
  const {
    skillManager = true,
    skillTool = fakeSkillTool(),
    toolNames = [ToolNames.SKILL, ToolNames.WORKFLOW],
    skillEnabled = true,
    cachedSkills,
  } = options;
  return {
    getSkillManager: () =>
      skillManager ? { getCachedSkills: () => cachedSkills ?? null } : null,
    getToolRegistry: () => ({
      getAllToolNames: () => toolNames,
      getTool: (name: string) =>
        name === ToolNames.SKILL ? (skillTool ?? undefined) : undefined,
    }),
    isSkillEnabled: () => skillEnabled,
  } as unknown as Config;
}

describe('readWorkflowAuthoringReference', () => {
  it('reads the bundled SKILL.md the Skill tool would load', () => {
    const parsed = parseSkillContent(
      fs.readFileSync(SKILL_PATH, 'utf8'),
      SKILL_PATH,
    );

    const reference = readWorkflowAuthoringReference();

    expect(reference?.body).toBe(parsed.body);
    expect(reference?.baseDir).toBe(path.dirname(SKILL_PATH));
  });
});

describe('isWorkflowAuthoringSkillAvailable', () => {
  it('is available in a session with skills and the Skill tool', () => {
    expect(isWorkflowAuthoringSkillAvailable(stubConfig())).toBe(true);
  });

  // Each of these is a real way to end up unable to load the skill, and each
  // one has to flip the Workflow tool into inlining the reference instead.
  it.each([
    ['skills are off entirely', { skillManager: false }],
    ['the Skill tool is not registered', { toolNames: [ToolNames.WORKFLOW] }],
    ['this skill is disabled', { skillEnabled: false }],
  ])('is unavailable when %s', (_case, options: StubOptions) => {
    expect(isWorkflowAuthoringSkillAvailable(stubConfig(options))).toBe(false);
  });

  // A config that cannot answer the question is not evidence of absence.
  // Guessing "unavailable" would inline the whole reference into every
  // request of the session; guessing "available" costs at most one failed
  // Skill call.
  it('assumes available when the config cannot answer', () => {
    const config = {
      getSkillManager: () => ({}),
      getToolRegistry: () => {
        throw new Error('registry not built yet');
      },
    } as unknown as Config;

    expect(isWorkflowAuthoringSkillAvailable(config)).toBe(true);
  });
});

describe('resolveWorkflowAuthoringAutoload', () => {
  it('hands back exactly what the Skill tool would have returned', () => {
    const reference = readWorkflowAuthoringReference()!;
    const autoload = resolveWorkflowAuthoringAutoload(stubConfig());

    expect(autoload.status).toBe('loaded');
    if (autoload.status !== 'loaded') return;
    expect(autoload.content).toBe(
      buildSkillLlmContent(reference.baseDir, reference.body),
    );
  });

  // The dedup contract: once the trigger has put the body in the turn, the
  // Skill tool has to know, or invoking the skill would append the same text
  // a second time.
  it('registers the load, and reports it as already loaded afterwards', () => {
    const skillTool = fakeSkillTool();
    const config = stubConfig({ skillTool });

    const first = resolveWorkflowAuthoringAutoload(config);
    expect(first.status).toBe('loaded');
    if (first.status !== 'loaded') return;
    // Resolving alone must not mark it: a caller that decides not to send
    // the turn would otherwise leave the session believing the model read it.
    expect(skillTool.getLoadedSkillNames().size).toBe(0);

    first.markLoaded();

    expect(
      skillTool.getLoadedSkillNames().has(WORKFLOW_AUTHORING_SKILL_NAME),
    ).toBe(true);
    expect(skillTool.getLoadedSkillContents().has(first.content)).toBe(true);
    expect(resolveWorkflowAuthoringAutoload(config).status).toBe(
      'already-loaded',
    );
  });

  // The manager's own copy is authoritative for the `(filePath, body)` pair
  // the Skill tool renders, so injection matches it even if a build ever
  // resolved the bundled directory differently from this module.
  it('prefers the skill manager cached entry', () => {
    const config = stubConfig({
      cachedSkills: [
        {
          name: WORKFLOW_AUTHORING_SKILL_NAME,
          body: 'cached body',
          filePath: '/elsewhere/workflow-authoring/SKILL.md',
        },
      ],
    });

    const autoload = resolveWorkflowAuthoringAutoload(config);

    expect(autoload.status).toBe('loaded');
    if (autoload.status !== 'loaded') return;
    expect(autoload.content).toBe(
      buildSkillLlmContent('/elsewhere/workflow-authoring', 'cached body'),
    );
  });

  it.each([
    ['the skill is unreachable', { toolNames: [ToolNames.WORKFLOW] }],
    ['the Skill tool instance is not there to track it', { skillTool: null }],
  ])('reports unavailable when %s', (_case, options: StubOptions) => {
    expect(resolveWorkflowAuthoringAutoload(stubConfig(options)).status).toBe(
      'unavailable',
    );
  });
});
