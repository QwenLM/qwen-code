/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Which of the two shapes the Workflow tool description takes.
 *
 * Separate from `workflow.test.ts` because the fallback case has to make the
 * bundled reference unreadable, and a module mock is hoisted over the whole
 * file — the content assertions next door must keep running against the real
 * reference.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../config/config.js';
import { ToolNames } from '../tool-names.js';

const { referenceReadable } = vi.hoisted(() => ({
  referenceReadable: { value: true },
}));

vi.mock('../../skills/workflow-authoring-skill.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../skills/workflow-authoring-skill.js')
    >();
  return {
    ...actual,
    readWorkflowAuthoringReference: () =>
      referenceReadable.value ? actual.readWorkflowAuthoringReference() : null,
  };
});

const { WorkflowTool } = await import('./workflow.js');
const { readWorkflowAuthoringReference, WORKFLOW_AUTHORING_SKILL_NAME } =
  await import('../../skills/workflow-authoring-skill.js');

function configWithSkillTool(available: boolean): Config {
  return {
    getSkillManager: () => ({ getCachedSkills: () => null }),
    getToolRegistry: () => ({
      getAllToolNames: () =>
        available
          ? [ToolNames.SKILL, ToolNames.WORKFLOW]
          : [ToolNames.WORKFLOW],
      getTool: () => undefined,
    }),
    isSkillEnabled: () => true,
  } as unknown as Config;
}

describe('Workflow tool description shape', () => {
  beforeEach(() => {
    referenceReadable.value = true;
  });

  it('points at the skill when the model can load it', () => {
    const { description } = new WorkflowTool(configWithSkillTool(true));

    expect(description).toContain(
      `load the \`${WORKFLOW_AUTHORING_SKILL_NAME}\` skill`,
    );
    // Pointing means NOT carrying: the reference's own headings must not
    // appear, or the description would be paying for both.
    expect(description).not.toContain('# Workflow authoring reference');
    expect(description).not.toContain('## agent() options');
  });

  // A build that denies the Skill tool would otherwise leave the model with
  // a description telling it to load something it cannot reach, and no
  // authoring contract anywhere.
  it('inlines the reference when the skill cannot be loaded', () => {
    const { description } = new WorkflowTool(configWithSkillTool(false));

    expect(description).toContain('# Workflow authoring reference');
    expect(description).toContain('Default to `pipeline()`');
    expect(description).toContain('## agent() options');
    // The opt-in rule is not part of the reference and must still lead.
    expect(description).toContain('**Only on an explicit request**');
    expect(description).not.toContain(
      `load the \`${WORKFLOW_AUTHORING_SKILL_NAME}\` skill`,
    );
  });

  // Both halves failing at once — no skill to load AND no file to inline —
  // is the one case with no good answer. A dangling pointer costs one failed
  // Skill call; a description with neither leaves nothing to recover from.
  it('falls back to the pointer when the reference cannot be read', () => {
    referenceReadable.value = false;

    const { description } = new WorkflowTool(configWithSkillTool(false));

    expect(description).toContain(
      `load the \`${WORKFLOW_AUTHORING_SKILL_NAME}\` skill`,
    );
    expect(description).toContain('**Only on an explicit request**');
    expect(description).not.toContain('# Workflow authoring reference');
  });

  // The inline shape is the reason the pointer shape exists: it is several
  // times the size, on every request of the session.
  it('is much smaller when it points than when it inlines', () => {
    const pointer = new WorkflowTool(configWithSkillTool(true)).description;
    const inline = new WorkflowTool(configWithSkillTool(false)).description;
    const reference = readWorkflowAuthoringReference();

    expect(reference).not.toBeNull();
    expect(inline.length).toBeGreaterThan(pointer.length * 3);
    expect(inline).toContain(reference!.body.trim());
  });
});
