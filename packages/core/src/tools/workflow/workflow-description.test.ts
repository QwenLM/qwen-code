/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Which shape the Workflow tool's model-visible surface takes,
 * and that every part of it agrees with that shape: the description, the
 * `script` parameter, the recorded `authoringSurface`, and the failure hint.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import type { Config } from '../../config/config.js';
import { ToolNames } from '../tool-names.js';
import {
  readWorkflowAuthoringReference,
  WORKFLOW_AUTHORING_SKILL_NAME,
} from '../../skills/workflow-authoring-skill.js';
import { buildWorkflowToolDescription, WorkflowTool } from './workflow.js';

interface RouteOptions {
  toolNames?: string[];
  deferred?: string[];
  revealed?: string[];
  disabledNames?: string[];
  disabledLevels?: string[];
}

function configFor(options: RouteOptions = {}): Config {
  const {
    toolNames = [
      ToolNames.SKILL,
      ToolNames.WORKFLOW,
      ToolNames.TOOL_SEARCH,
      ToolNames.TOOL_CALL,
    ],
    deferred = [],
    revealed = [],
    disabledNames = [],
    disabledLevels = [],
  } = options;
  return {
    getSkillManager: () => ({}),
    getToolRegistry: () => ({
      getAllToolNames: () => toolNames,
      isPermissionDeferred: (name: string) => deferred.includes(name),
      isDeferredToolRevealed: (name: string) => revealed.includes(name),
      getTool: () => undefined,
    }),
    isSkillEnabled: (skill: { name: string }) =>
      !disabledNames.includes(skill.name),
    getDisabledSkillLevels: () => new Set(disabledLevels),
  } as unknown as Config;
}

function scriptDescription(tool: WorkflowTool): string {
  return (
    tool.schema.parametersJsonSchema as {
      properties: { script: { description: string } };
    }
  ).properties.script.description;
}

const POINTER_SENTENCE = `load the \`${WORKFLOW_AUTHORING_SKILL_NAME}\` skill`;
const REFERENCE_H1 = '# Workflow authoring reference';
const OPT_IN = '**Only on an explicit request**';

describe('Workflow tool description shape', () => {
  it('points at the skill when the model can load it', () => {
    const tool = new WorkflowTool(configFor());

    expect(tool.authoringSurface).toBe('pointer');
    expect(tool.description).toContain(POINTER_SENTENCE);
    // Pointing means NOT carrying: the reference's own headings must not
    // appear, or the description would be paying for both.
    expect(tool.description).not.toContain(REFERENCE_H1);
    expect(tool.description).not.toContain('## agent() options');
    expect(scriptDescription(tool)).toContain(
      `\`${WORKFLOW_AUTHORING_SKILL_NAME}\` skill`,
    );
  });

  // The pointer is only honest if the model can follow it. Under a
  // `tools.eager` allowlist the Skill tool is one ToolSearch away, and the
  // pointer has to say so.
  it('names the ToolSearch detour when the Skill tool is deferred', () => {
    const tool = new WorkflowTool(configFor({ deferred: [ToolNames.SKILL] }));

    expect(tool.authoringSurface).toBe('pointer-via-tool-search');
    expect(tool.description).toContain(POINTER_SENTENCE);
    // The detour sentence must name the invocation half: tool_search only
    // reviews the schema (R27-1).
    expect(tool.description).toContain(
      'If the Skill tool is not in your tool list, review its schema with `tool_search` and then invoke it with `tool_call`.',
    );
  });

  // Built while the Skill tool happens to be revealed, the description is
  // still the one held after `/clear` drops that reveal, so it keeps the
  // (conditional) detour.
  it('keeps the ToolSearch detour when the Skill tool is revealed at build time', () => {
    const tool = new WorkflowTool(
      configFor({ deferred: [ToolNames.SKILL], revealed: [ToolNames.SKILL] }),
    );

    expect(tool.authoringSurface).toBe('pointer-via-tool-search');
    expect(tool.description).toContain(
      'If the Skill tool is not in your tool list, review its schema with `tool_search` and then invoke it with `tool_call`.',
    );
  });

  describe('inline', () => {
    const tool = () =>
      new WorkflowTool(configFor({ toolNames: [ToolNames.WORKFLOW] }));

    // A build that denies the Skill tool would otherwise leave the model with
    // a description telling it to load something it cannot reach, and no
    // authoring contract anywhere.
    it('carries the reference in full, after the opt-in rule', () => {
      const { description, authoringSurface } = tool();

      expect(authoringSurface).toBe('inline');
      expect(description).toContain(OPT_IN);
      expect(description).toContain(REFERENCE_H1);
      expect(description).toContain('## agent() options');
      expect(description).not.toContain(POINTER_SENTENCE);
      // The opt-in rule gates a run of up to a thousand agents; it must be
      // read before 15 KB of reference, not after. Paired with the
      // `toContain`s above so a missing needle cannot pass as -1 < n.
      expect(description.indexOf(OPT_IN)).toBeLessThan(
        description.indexOf(REFERENCE_H1),
      );
    });

    // The reference states every runtime fact in full; a second copy from the
    // runtime paragraph is how the two would come to disagree in one string.
    it('does not repeat the runtime paragraph the reference already states', () => {
      // Whitespace collapsed: the reference is hard-wrapped markdown, so a
      // sentence can straddle a line break in the raw text.
      const description = tool().description.replace(/\s+/g, ' ');

      expect(
        description.match(/fan-out near the agent cap/g) ?? [],
      ).toHaveLength(1);
      expect(description).not.toContain('**Runtime**');
      expect(description).not.toContain('journal holds one line per agent');
      // Not repeating the runtime paragraph only works if the reference really
      // states it: the inline shape reads these from SKILL.md alone.
      expect(description).toContain('Every run hands back its runId');
      expect(description).toContain('run_in_background');
    });

    // The parameter the model is about to fill sits beside the description,
    // so it must name the same place — and the inlined body's pointers at
    // other skills must be qualified, since none are loadable here.
    it('keeps the script parameter and the other-skill pointers consistent', () => {
      const instance = tool();

      expect(scriptDescription(instance)).not.toContain(
        `\`${WORKFLOW_AUTHORING_SKILL_NAME}\` skill`,
      );
      expect(scriptDescription(instance)).toContain(
        "authoring reference in this tool's description",
      );
      expect(instance.description).toContain(
        'that skill is not available here either',
      );
    });

    it('is much larger than the pointer, which is why the pointer exists', () => {
      const pointer = new WorkflowTool(configFor()).description;
      const inline = tool().description;
      const reference = readWorkflowAuthoringReference();

      expect(reference).not.toBeNull();
      expect(inline.length).toBeGreaterThan(pointer.length * 3);
      expect(inline).toContain(reference!.body.trim());
    });
  });

  // A user who turned the reference off gets neither shape: inlining would put
  // the text they removed back into every request at a higher cost.
  it.each([
    ['disabled by name', { disabledNames: [WORKFLOW_AUTHORING_SKILL_NAME] }],
    ['hidden with the bundled level', { disabledLevels: ['bundled'] }],
  ])('carries nothing about the reference when it is %s', (_case, options) => {
    const tool = new WorkflowTool(configFor(options));

    expect(tool.authoringSurface).toBe('withheld');
    expect(tool.description).toContain(OPT_IN);
    expect(tool.description).toContain('**Runtime**');
    expect(tool.description).not.toContain(REFERENCE_H1);
    expect(tool.description).not.toContain(WORKFLOW_AUTHORING_SKILL_NAME);
    expect(scriptDescription(tool)).not.toContain(
      WORKFLOW_AUTHORING_SKILL_NAME,
    );
  });

  // The hint is delivered at the moment the model is about to retry, so it has
  // to match each shape — including the two no other test executes.
  describe('failure hint', () => {
    async function failingRunText(tool: WorkflowTool): Promise<string> {
      const result = await tool
        .build({ script: 'throw new Error("boom");' })
        .execute(new AbortController().signal);
      return (result.llmContent as Array<{ text: string }>)
        .map((part) => part.text)
        .join('\n');
    }

    it('says nothing about the reference when it is withheld', async () => {
      const tool = new WorkflowTool(
        configFor({ disabledNames: [WORKFLOW_AUTHORING_SKILL_NAME] }),
        { dispatch: async () => 'unused' },
      );
      const text = await failingRunText(tool);

      expect(tool.authoringSurface).toBe('withheld');
      expect(text).toContain('Workflow failed: boom');
      expect(text).not.toContain('hint:');
      expect(text).not.toContain(WORKFLOW_AUTHORING_SKILL_NAME);
    });

    it('repeats the ToolSearch detour when the Skill tool is deferred', async () => {
      const tool = new WorkflowTool(
        configFor({ deferred: [ToolNames.SKILL] }),
        {
          dispatch: async () => 'unused',
        },
      );
      const text = await failingRunText(tool);

      expect(tool.authoringSurface).toBe('pointer-via-tool-search');
      expect(text).toContain(
        `hint: Load the \`${WORKFLOW_AUTHORING_SKILL_NAME}\` skill`,
      );
      expect(text).toContain(
        'If the Skill tool is not in your tool list, review its schema with `tool_search` and then invoke it with `tool_call`.',
      );
    });
  });

  it('falls back to the pointer when asked to inline an unreadable reference', () => {
    const description = buildWorkflowToolDescription('inline', null);

    expect(description).toContain(POINTER_SENTENCE);
    expect(description).toContain(OPT_IN);
    expect(description).not.toContain(REFERENCE_H1);
  });
});

// Both halves failing at once: no route to the skill AND no file to inline.
// The description falls back to the pointer, and the failure hint has to say
// the same thing — not send the model to a description that holds no
// reference. Real read failure, isolated in its own module graph because the
// reference is cached process-wide once read.
describe('when the reference is unreachable and unreadable', () => {
  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  it('keeps the description, the recorded shape and the hint in agreement', async () => {
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        readFileSync: ((file: unknown, ...rest: unknown[]) => {
          if (
            String(file).endsWith(
              path.join(WORKFLOW_AUTHORING_SKILL_NAME, 'SKILL.md'),
            )
          ) {
            throw new Error('ENOENT: no such file');
          }
          return (actual.readFileSync as (...args: unknown[]) => unknown)(
            file,
            ...rest,
          );
        }) as typeof actual.readFileSync,
      };
    });
    const { WorkflowTool: FreshWorkflowTool } = await import('./workflow.js');
    const tool = new FreshWorkflowTool(
      configFor({ toolNames: [ToolNames.WORKFLOW] }),
      {
        dispatch: async () => 'unused',
      },
    );

    expect(tool.authoringSurface).toBe('pointer');
    expect(tool.description).toContain(POINTER_SENTENCE);
    expect(tool.description).not.toContain(REFERENCE_H1);

    const result = await tool
      .build({ script: 'throw new Error("boom");' })
      .execute(new AbortController().signal);
    const text = (result.llmContent as Array<{ text: string }>)
      .map((part) => part.text)
      .join('\n');
    expect(text).toContain(
      `hint: Load the \`${WORKFLOW_AUTHORING_SKILL_NAME}\` skill`,
    );
    expect(text).not.toContain("this tool's description");
  });
});
