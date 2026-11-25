/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { SkillDefinition } from '@qwen-code/resource';
import type { Config } from '../config/config.js';
import { buildSkillHookContext } from './skillHookContext.js';

const plugin = {
  name: 'security',
  source: 'market',
  path: '/plugins/security',
  manifest: { name: 'security', version: '1.2.3', description: 'private' },
  repository: 'market',
  sha: '1234',
};

const marketplace = {
  marketSourceId: 'sash-enterprise',
  orgId: 'org_2291',
  itemKind: 'plugin',
  marketItemId: 'plg_3c0d1e',
  displayName: '研发效能工具集',
  version: '0.3.1',
};
const empty = {
  marketSourceId: '',
  orgId: '',
  itemKind: '',
  marketItemId: '',
  displayName: '',
  version: '',
};

function configFor(skills: SkillDefinition[]): Config {
  return {
    getSkillManager: () => ({
      getSkill: (name: string) =>
        skills.find((s) => s.name.toLowerCase() === name.toLowerCase()),
    }),
    getEnabledPlugins: () => [plugin],
  } as unknown as Config;
}

describe(
  'buildSkillHookContext',
  () => {
    it(
      'reports only the requested plugin attribution fields from the loaded version',
      () => {
        const config = configFor([
          {
            name: 'security:review',
            description: '',
            body: '',
            source: 'plugin',
            location: '/plugins/security/skills/review/SKILL.md',
            skillRoot: '/plugins/security/skills/review',
            pluginName: 'security',
            pluginPath: '/plugins/security',
            pluginId: 'security@market',
            plugin: { ...marketplace },
          },
        ]);
        const payload = JSON.parse(
          JSON.stringify(
            buildSkillHookContext(
              config,
              { skill: 'SECURITY:REVIEW' },
              'model_tool',
            ),
          ),
        );
        expect(payload).toEqual({
          requested_skill_name: 'SECURITY:REVIEW',
          skill_name: 'security:review',
          skill_type: 'normal',
          activation_source: 'model_tool',
          skill_source: 'plugin',
          skill_location: '/plugins/security/skills/review/SKILL.md',
          plugin: marketplace,
        });
      }
    );

    it(
      'resolves plugin workflow ownership without requiring pluginId on the skill',
      () => {
        const skill = {
          name: 'security:audit',
          source: 'plugin',
          location: '/plugins/security/workflows/audit.js',
          skillRoot: '/artifacts',
          body: '',
          description: '',
          pluginName: 'security',
          plugin: { ...marketplace },
          workflow: {
            name: 'security:audit',
            pluginName: 'security',
            pluginPath: '/plugins/security',
            source: 'plugin',
          },
        } as SkillDefinition;
        expect(
          buildSkillHookContext(
            configFor([skill]),
            { skill: 'security:audit' },
            'slash_command',
          ),
        ).toMatchObject({
          skill_type: 'workflow',
          plugin: marketplace,
        });
      }
    );

    it(
      'does not invent a type or plugin for an unresolved skill',
      () => {
        expect(
          buildSkillHookContext(
            configFor([]),
            { skill: 'missing' },
            'selected_skills',
          ),
        ).toEqual({
          requested_skill_name: 'missing',
          activation_source: 'selected_skills',
          plugin: empty,
        });
      }
    );

    it(
      'keeps the original name but resolves attribution again after a rewrite',
      () => {
        const config = configFor([
          {
            name: 'local',
            source: 'project',
            location: '/p/.qoder/skills/local/SKILL.md',
            skillRoot: '/p/.qoder/skills/local',
            description: '',
            body: '',
          },
        ]);
        expect(
          buildSkillHookContext(
            config,
            { skill: 'local' },
            'model_tool',
            'security:review',
          ),
        ).toEqual({
          requested_skill_name: 'security:review',
          skill_name: 'local',
          skill_type: 'normal',
          activation_source: 'model_tool',
          skill_source: 'project',
          skill_location: '/p/.qoder/skills/local/SKILL.md',
          plugin: empty,
        });
      }
    );

    it(
      'uses a detached definition snapshot and never reconstructs missing metadata',
      () => {
        const skill = {
          name: 'security:review',
          source: 'plugin',
          description: '',
          body: '',
          location: '/skill',
          skillRoot: '/skill',
          plugin: { ...marketplace },
        } as SkillDefinition;
        const config = configFor([skill]);
        const context = buildSkillHookContext(
          config,
          { skill: skill.name },
          'model_tool',
        );
        context.plugin!.version = 'mutated';
        expect(skill.plugin).toEqual(marketplace);
        delete skill.plugin;
        expect(
          buildSkillHookContext(
            config,
            { skill: skill.name },
            'model_tool'
          ).plugin,
        ).toEqual(empty);
      }
    );
  }
);
