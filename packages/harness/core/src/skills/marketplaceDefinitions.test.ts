/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillManager } from './skillManager.js';
import type { LoadedPlugin } from '../plugins/types.js';
import { WorkflowRegistry } from '../workflows/workflow-registry.js';
import { workflowToSkill } from '../workflows/workflow-skills.js';
import type { Config } from '../config/config.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(
      root,
      { recursive: true, force: true }
    )),
  );
});
const market = {
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

describe(
  'marketplace definitions',
  () => {
    it(
      'initializes empty marketplace fields for bundled and dynamic project definitions',
      async () => {
        const manager = new SkillManager();
        await manager.discoverSkills({ emitToFeed: false });
        expect(manager.getSkill('simplify')?.plugin).toEqual(empty);
        manager.addDynamicSkills(
          '/dynamic',
          [
            {
              name: 'local',
              description: '',
              body: '',
              location: '/dynamic/SKILL.md',
              skillRoot: '/dynamic',
              plugin: { ...market },
            },
          ]
        );
        expect(manager.getSkill('local')?.plugin).toEqual(empty);
      }
    );

    it(
      'loads plugin skills and fork commands with marketplace snapshots, refreshing after reload',
      async () => {
        const root = await mkdtemp(join(
          tmpdir(),
          'market-skills-'
        ));
        roots.push(root);
        await mkdir(join(
          root,
          '.qoder'
        ));
        await mkdir(
          join(
            root,
            'skills',
            'review'
          ),
          { recursive: true }
        );
        await mkdir(join(
          root,
          'commands'
        ));
        await writeFile(
          join(
            root,
            '.qoder',
            'marketplace.json'
          ),
          JSON.stringify({ ...market, schemaVersion: 1 }),
        );
        await writeFile(
          join(
            root,
            'skills',
            'review',
            'SKILL.md'
          ),
          '---\nname: review\ndescription: review\n---\nReview',
        );
        await writeFile(
          join(
            root,
            'commands',
            'audit.md'
          ),
          '---\ndescription: audit\ncontext: fork\n---\nAudit',
        );
        const plugin = {
          name: 'demo',
          path: root,
          source: 'local',
          repository: 'local',
          manifest: { name: 'demo', version: 'wrong' },
          enabled: true,
          skillsPath: join(
            root,
            'skills'
          ),
          commandsPath: join(
            root,
            'commands'
          ),
        } as LoadedPlugin;
        const manager = new SkillManager();
        manager.setDisableBuiltinSkills(true);
        await manager.discoverSkills({ plugins: [plugin], emitToFeed: false });
        const skill = manager.getSkill('demo:review');
        expect(skill?.plugin).toEqual(market);
        expect(manager.getSkill('demo:audit')?.plugin).toEqual(market);
        await rm(join(
          root,
          '.qoder',
          'marketplace.json'
        ));
        await manager.discoverSkills({ plugins: [plugin], emitToFeed: false });
        expect(manager.getSkill('demo:review')?.plugin).toEqual(empty);
        expect(skill?.plugin).toEqual(market);
      }
    );

    it(
      'copies workflow marketplace metadata into the skill definition',
      async () => {
        const root = await mkdtemp(join(
          tmpdir(),
          'market-workflow-'
        ));
        roots.push(root);
        await mkdir(join(
          root,
          '.qoder'
        ));
        await writeFile(
          join(
            root,
            '.qoder',
            'marketplace.json'
          ),
          JSON.stringify(market),
        );
        const registry = new WorkflowRegistry({
          projectRoot: root,
          homeDir: root,
          pluginWorkflows: [
            {
              pluginName: 'demo',
              pluginPath: root,
              workflows: [
                {
                  script:
                    'export const meta = { name: "audit", description: "Audit" };',
                },
              ],
            },
          ],
        });
        const entry = (await registry.listAvailable()).entries.find(
          (e) => e.name === 'demo:audit',
        )!;
        expect(entry.plugin).toEqual(market);
        const definition = workflowToSkill(
          entry,
          {
            getSessionArtifactProjectRoot: () => root,
          } as Config
        );
        expect(definition.plugin).toEqual(market);
        definition.plugin!.version = 'mutated';
        expect(entry.plugin).toEqual(market);
      }
    );
  }
);
