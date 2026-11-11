/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Config } from '../../config/config.js';
import { getWorkflowAuthoringReference } from '../../workflows/workflow-prompts.js';
import { initBundledSkills, type BundledSkillRegistration } from './index.js';

describe('initBundledSkills', () => {
  it.each([undefined, false, true])(
    'always registers workflow authoring: %s',
    async (enabled) => {
      const registered: BundledSkillRegistration[] = [];
      const config =
        enabled === undefined
          ? undefined
          : ({
              getCurrentContextFileName: () => 'AGENTS.md',
              getAllLocalContextFileNames: () => ['AGENTS.local.md'],
              getDefaultShellToolName: () => 'Bash',
            } as unknown as Config);
      initBundledSkills(
        { registerBundledSkill: (definition) => registered.push(definition) },
        config,
      );
      const guide = registered.find(
        (skill) => skill.name === 'workflow-authoring',
      );
      expect(guide?.userInvocable).toBe(true);
      expect(await guide?.getBody?.()).toBe(getWorkflowAuthoringReference());
    },
  );
  it.each(['Bash', 'PowerShell'] as const)(
    'uses the owning Config for bundled shell grants: %s',
    (shell) => {
      const registered: BundledSkillRegistration[] = [];
      initBundledSkills(
        { registerBundledSkill: (definition) => registered.push(definition) },
        {
          getCurrentContextFileName: () => 'AGENTS.md',
          getAllLocalContextFileNames: () => ['AGENTS.local.md'],
          getDefaultShellToolName: () => shell,
          isWorkflowsEnabled: () => false,
        } as unknown as Config,
      );
      for (const name of [
        'mcp-config',
        'run',
        'verify',
        'run-skill-generator',
      ]) {
        const skill = registered.find((entry) => entry.name === name);
        expect(skill?.allowedTools).toContain(shell);
        expect(skill?.allowedTools).not.toContain(
          shell === 'Bash' ? 'PowerShell' : 'Bash',
        );
      }
    },
  );

  it('does not register the retired security-review skill', () => {
    const registered: BundledSkillRegistration[] = [];

    initBundledSkills({
      registerBundledSkill: (definition) => {
        registered.push(definition);
      },
    });

    const skillNames = registered.map((skill) => skill.name);
    expect(skillNames).toContain('simplify');
    expect(skillNames).not.toContain('security-review');
  });

  it('registers quest as user-invocable only', () => {
    const registered: BundledSkillRegistration[] = [];

    initBundledSkills({
      registerBundledSkill: (definition) => {
        registered.push(definition);
      },
    });

    const quest = registered.find((skill) => skill.name === 'quest');
    expect(quest).toMatchObject({
      userInvocable: true,
      disableModelInvocation: true,
    });
  });

  it('registers verify as user-invocable only', () => {
    const registered: BundledSkillRegistration[] = [];

    initBundledSkills({
      registerBundledSkill: (definition) => {
        registered.push(definition);
      },
    });

    const verify = registered.find((skill) => skill.name === 'verify');
    expect(verify).toMatchObject({
      userInvocable: true,
      disableModelInvocation: true,
    });
  });
});
