/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { ToolNames } from '../tools/tool-names.js';
import { parseSkillContent } from './skill-load.js';
import {
  readWorkflowAuthoringReference,
  resolveWorkflowAuthoringRoute,
  resolveWorkflowAuthoringSurface,
  WORKFLOW_AUTHORING_SKILL_NAME,
} from './workflow-authoring-skill.js';

const SKILL_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'bundled',
  WORKFLOW_AUTHORING_SKILL_NAME,
  'SKILL.md',
);

interface StubOptions {
  skillManager?: boolean;
  /** `null` models a registry that cannot answer. */
  toolNames?: string[] | null;
  deferred?: string[];
  disabledNames?: string[];
  disabledLevels?: string[];
}

/**
 * A config that answers exactly the questions the route asks. `isSkillEnabled`
 * decides on the name it is handed, as the real one does, so a drift in the
 * name the production code probes turns the disabled-by-name case red.
 */
function stubConfig(options: StubOptions = {}) {
  const {
    skillManager = true,
    toolNames = [ToolNames.SKILL, ToolNames.WORKFLOW, ToolNames.TOOL_SEARCH],
    deferred = [],
    disabledNames = [],
    disabledLevels = [],
  } = options;
  const isSkillEnabled = vi.fn(
    (skill: { name: string }) => !disabledNames.includes(skill.name),
  );
  const config = {
    getSkillManager: () => (skillManager ? {} : null),
    getToolRegistry: () => ({
      getAllToolNames: () => toolNames ?? undefined,
      isPermissionDeferred: (name: string) => deferred.includes(name),
    }),
    isSkillEnabled,
    getDisabledSkillLevels: () => new Set(disabledLevels),
  } as unknown as Config;
  return { config, isSkillEnabled };
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

describe('resolveWorkflowAuthoringRoute', () => {
  it('points at the skill in an ordinary session', () => {
    const { config, isSkillEnabled } = stubConfig();

    expect(resolveWorkflowAuthoringRoute(config)).toBe('skill');
    // The name is the load-bearing field: for the bundled level the decision
    // rests entirely on whether that exact name is disabled.
    expect(isSkillEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ name: WORKFLOW_AUTHORING_SKILL_NAME }),
    );
  });

  it('is not affected by a different skill being disabled', () => {
    const { config } = stubConfig({ disabledNames: ['some-other-skill'] });
    expect(resolveWorkflowAuthoringRoute(config)).toBe('skill');
  });

  // A user who turned the reference off asked for the text to go away.
  // Inlining it would put it back into every request at a higher price.
  it.each([
    [
      'the skill is disabled by name',
      { disabledNames: [WORKFLOW_AUTHORING_SKILL_NAME] },
    ],
    ['the bundled level is disabled', { disabledLevels: ['bundled'] }],
    [
      'the skill is disabled and there is no Skill tool either',
      {
        disabledNames: [WORKFLOW_AUTHORING_SKILL_NAME],
        toolNames: [ToolNames.WORKFLOW],
      },
    ],
  ])('withholds the reference when %s', (_case, options: StubOptions) => {
    expect(resolveWorkflowAuthoringRoute(stubConfig(options).config)).toBe(
      'withheld',
    );
  });

  // No route to any skill: the reference has to travel in the description.
  it.each([
    ['skills are off entirely', { skillManager: false }],
    ['the Skill tool is not registered', { toolNames: [ToolNames.WORKFLOW] }],
    [
      'the Skill tool is deferred and nothing can reveal it',
      {
        toolNames: [ToolNames.SKILL, ToolNames.WORKFLOW],
        deferred: [ToolNames.SKILL],
      },
    ],
  ])('inlines when %s', (_case, options: StubOptions) => {
    expect(resolveWorkflowAuthoringRoute(stubConfig(options).config)).toBe(
      'inline',
    );
  });

  // A `tools.eager` allowlist that omits the Skill tool keeps its schema out
  // of the request while leaving it registered. The pointer still works, one
  // ToolSearch away, and has to say so.
  it('routes through ToolSearch when the Skill tool is deferred', () => {
    const { config } = stubConfig({ deferred: [ToolNames.SKILL] });
    expect(resolveWorkflowAuthoringRoute(config)).toBe('skill-via-tool-search');
  });

  // A config that cannot answer is not evidence of absence. Guessing "inline"
  // would put the whole reference into every request of the session; guessing
  // "skill" costs at most one failed Skill call.
  it.each([['the registry has no tool list', { toolNames: null }]])(
    'assumes the skill is reachable when %s',
    (_case, options: StubOptions) => {
      expect(resolveWorkflowAuthoringRoute(stubConfig(options).config)).toBe(
        'skill',
      );
    },
  );

  it('assumes the skill is reachable when the config throws', () => {
    const config = {
      getSkillManager: () => ({}),
      getToolRegistry: () => {
        throw new Error('registry not built yet');
      },
    } as unknown as Config;

    expect(resolveWorkflowAuthoringRoute(config)).toBe('skill');
  });
});

describe('resolveWorkflowAuthoringSurface', () => {
  it.each([
    [{}, 'pointer'],
    [{ deferred: [ToolNames.SKILL] }, 'pointer-via-tool-search'],
    [{ toolNames: [ToolNames.WORKFLOW] }, 'inline'],
    [{ disabledNames: [WORKFLOW_AUTHORING_SKILL_NAME] }, 'withheld'],
  ])('maps %o to %s', (options: StubOptions, surface) => {
    expect(resolveWorkflowAuthoringSurface(stubConfig(options).config)).toBe(
      surface,
    );
  });
});

// The real read failing, not a substituted function: a module mock of this
// file would never run its own try/catch. `node:fs` is replaced only for this
// file's path, and the module registry is reset because the reference is
// cached process-wide once read.
describe('when the bundled reference cannot be read', () => {
  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  it('degrades to no reference and a pointer, without throwing', async () => {
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        readFileSync: ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
          if (
            String(file).endsWith(
              path.join(WORKFLOW_AUTHORING_SKILL_NAME, 'SKILL.md'),
            )
          ) {
            throw new Error('EACCES: permission denied');
          }
          return (actual.readFileSync as (...args: unknown[]) => unknown)(
            file,
            ...rest,
          );
        }) as typeof actual.readFileSync,
      };
    });
    const fresh = await import('./workflow-authoring-skill.js');
    const { config } = stubConfig({ toolNames: [ToolNames.WORKFLOW] });

    expect(() => fresh.readWorkflowAuthoringReference()).not.toThrow();
    expect(fresh.readWorkflowAuthoringReference()).toBeNull();
    // No route to the skill and nothing to inline: the pointer is the only
    // text left that names the reference.
    expect(fresh.resolveWorkflowAuthoringRoute(config)).toBe('inline');
    expect(fresh.resolveWorkflowAuthoringSurface(config)).toBe('pointer');
  });
});
