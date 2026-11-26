/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getProjectWorkflowsDir,
  getUserWorkflowsDir,
} from './workflow-storage.js';
import {
  createWorkflowRegistryFromConfig,
  WorkflowRegistry,
} from './workflow-registry.js';
import {
  DEEP_RESEARCH_WORKFLOW_NAME,
  DEEP_RESEARCH_WORKFLOW_SCRIPT,
} from './workflow-builtins.js';
import { parseWorkflowScript } from './workflow-parser.js';
import { makeFakeConfig } from '../test-utils/config.js';

describe('WorkflowRegistry', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-registry-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('loads named project workflows from the original project while running in a worktree', async () => {
    const originalCwd = path.join(tmpDir, 'original');
    const worktreeCwd = path.join(tmpDir, 'worktree');
    const workflowsDir = getProjectWorkflowsDir(originalCwd);
    await fs.mkdir(workflowsDir, { recursive: true });
    await fs.mkdir(worktreeCwd);
    await fs.writeFile(
      path.join(workflowsDir, 'original-only.js'),
      'export const meta = { name: "original-only", description: "Original project workflow" };',
    );
    const config = makeFakeConfig({ targetDir: worktreeCwd, cwd: worktreeCwd });
    config.setWorktreeSettings({
      name: 'feature',
      path: worktreeCwd,
      worktreeCwd,
      originalCwd,
      baseSha: '',
      lifecycle: 'attached',
    });
    const workflow =
      await createWorkflowRegistryFromConfig(config).resolve('original-only');
    expect(workflow.scriptPath).toBe(
      path.join(workflowsDir, 'original-only.js'),
    );
    expect(config.getProjectRoot()).toBe(worktreeCwd);
  });

  it('lists project and user workflows with project priority and input schemas', async () => {
    const projectRoot = path.join(tmpDir, 'project');
    const homeDir = path.join(tmpDir, 'home');
    const projectWorkflows = getProjectWorkflowsDir(projectRoot);
    const userWorkflows = getUserWorkflowsDir(homeDir);
    await fs.mkdir(projectWorkflows, { recursive: true });
    await fs.mkdir(userWorkflows, { recursive: true });
    await fs.writeFile(
      path.join(userWorkflows, 'audit.js'),
      'export const meta = { name: "audit", description: "User audit" };',
    );
    await fs.writeFile(
      path.join(projectWorkflows, 'audit.js'),
      `export const meta = {
        name: "audit",
        description: "Project audit",
        inputSchema: {
          type: "object",
          properties: { scope: { type: "string" } },
          required: ["scope"]
        }
      };`,
    );

    const registry = new WorkflowRegistry({ projectRoot, homeDir });
    const listed = await registry.listAvailable();
    const resolved = await registry.resolve('audit');

    expect(listed.diagnostics).toEqual([
      expect.objectContaining({
        source: 'user',
        kind: 'shadowed',
        name: 'audit',
        message: expect.stringContaining('is shadowed by project'),
      }),
    ]);
    expect(listed.entries).toHaveLength(1);
    expect(listed.entries[0]).toMatchObject({
      name: 'audit',
      source: 'project',
      description: 'Project audit',
      inputSchema: {
        type: 'object',
        properties: { scope: { type: 'string' } },
        required: ['scope'],
      },
    });
    expect(resolved).toMatchObject({
      source: 'project',
    });
    expect(resolved.script).toContain('Project audit');
  });

  it('reports invalid workflow diagnostics and falls back to valid lower priority entries', async () => {
    const projectRoot = path.join(tmpDir, 'project');
    const homeDir = path.join(tmpDir, 'home');
    const projectWorkflows = getProjectWorkflowsDir(projectRoot);
    const userWorkflows = getUserWorkflowsDir(homeDir);
    await fs.mkdir(projectWorkflows, { recursive: true });
    await fs.mkdir(userWorkflows, { recursive: true });
    await fs.writeFile(
      path.join(projectWorkflows, 'audit.js'),
      'export const meta = { name: "audit" };',
    );
    await fs.writeFile(
      path.join(userWorkflows, 'audit.js'),
      'export const meta = { name: "audit", description: "User audit" };',
    );

    const registry = new WorkflowRegistry({ projectRoot, homeDir });
    const listed = await registry.listAvailable();
    const resolved = await registry.resolve('audit');

    expect(listed.entries).toEqual([
      expect.objectContaining({ name: 'audit', source: 'user' }),
    ]);
    expect(listed.diagnostics).toEqual([
      expect.objectContaining({
        source: 'project',
        message: expect.stringContaining('meta.description'),
      }),
    ]);
    expect(resolved.source).toBe('user');
  });

  it('supports namespaced plugin workflows', async () => {
    const registry = new WorkflowRegistry({
      projectRoot: tmpDir,
      homeDir: path.join(tmpDir, 'home'),
      pluginWorkflows: [
        {
          pluginName: 'quality',
          workflows: [
            {
              sourceId: 'quality:audit',
              script:
                'export const meta = { name: "audit", description: "Plugin audit" };',
            },
          ],
        },
      ],
    });

    const listed = await registry.listAvailable();
    const resolved = await registry.resolve('quality:audit');

    expect(listed.entries).toEqual([
      expect.objectContaining({
        name: 'quality:audit',
        source: 'plugin',
        pluginName: 'quality',
      }),
    ]);
    expect(resolved.source).toBe('plugin');
    expect(resolved.scriptPath).toBeUndefined();
    expect(resolved.script).toContain('Plugin audit');
  });

  it('discovers enabled plugin workflows from conventional workflows directories', async () => {
    const projectRoot = path.join(tmpDir, 'project');
    const pluginRoot = path.join(tmpDir, 'plugins', 'quality');
    const workflowsDir = path.join(pluginRoot, 'workflows');
    await fs.mkdir(workflowsDir, { recursive: true });
    await fs.writeFile(
      path.join(workflowsDir, 'audit.js'),
      'export const meta = { name: "audit", description: "Plugin workflow audit" };',
    );

    const registry = createWorkflowRegistryFromConfig({
      getSessionArtifactProjectRoot: () => projectRoot,
      getEnabledPlugins: () => [
        {
          name: 'quality',
          path: pluginRoot,
          repository: 'marketplace',
          manifest: { name: 'quality', version: '1.0.0' },
        },
      ],
    });

    const listed = await registry.listAvailable();
    const resolved = await registry.resolve('quality:audit');

    expect(listed.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'quality:audit',
          source: 'plugin',
          pluginName: 'quality',
          pluginRepository: 'marketplace',
          pluginPath: pluginRoot,
          pluginManifest: { name: 'quality', version: '1.0.0' },
          description: 'Plugin workflow audit',
        }),
        expect.objectContaining({
          name: DEEP_RESEARCH_WORKFLOW_NAME,
          source: 'built-in',
        }),
      ]),
    );
    expect(listed.entries).toHaveLength(2);
    expect(resolved).toMatchObject({
      source: 'plugin',
    });
    expect(resolved.script).toContain('Plugin workflow audit');
  });

  it('discovers plugin workflows from manifest-declared directories and single files', async () => {
    const projectRoot = path.join(tmpDir, 'project');
    const pluginRoot = path.join(tmpDir, 'plugins', 'quality');
    const manifestDir = path.join(pluginRoot, 'workflow-pack');
    const singleFile = path.join(pluginRoot, 'audit-single.js');
    await fs.mkdir(manifestDir, { recursive: true });
    await fs.writeFile(
      path.join(manifestDir, 'audit.js'),
      'export const meta = { name: "audit", description: "Manifest dir audit" };',
    );
    await fs.writeFile(
      singleFile,
      'export const meta = { name: "single", description: "Manifest file audit" };',
    );

    const registry = createWorkflowRegistryFromConfig({
      getSessionArtifactProjectRoot: () => projectRoot,
      getEnabledPlugins: () => [
        {
          name: 'quality',
          path: pluginRoot,
          repository: 'marketplace',
          workflowsPath: manifestDir,
          workflowsPaths: [singleFile],
          manifest: {
            name: 'quality',
            version: '1.0.0',
            workflowsPath: './workflow-pack',
          },
        },
      ],
    });

    const listed = await registry.listAvailable();
    expect(listed.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'quality:audit',
          pluginManifest: {
            name: 'quality',
            version: '1.0.0',
            workflowsPath: './workflow-pack',
          },
          pluginRepository: 'marketplace',
          pluginPath: pluginRoot,
        }),
        expect.objectContaining({
          name: 'quality:single',
          pluginManifest: {
            name: 'quality',
            version: '1.0.0',
            workflowsPath: './workflow-pack',
          },
          pluginRepository: 'marketplace',
          pluginPath: pluginRoot,
        }),
      ]),
    );
  });

  it('registers the built-in deep-research workflow by default from config', async () => {
    const registry = createWorkflowRegistryFromConfig({
      getSessionArtifactProjectRoot: () => path.join(tmpDir, 'project'),
    });

    const listed = await registry.listAvailable();
    const resolved = await registry.resolve(DEEP_RESEARCH_WORKFLOW_NAME);

    expect(listed.diagnostics).toEqual([]);
    expect(listed.entries).toEqual([
      expect.objectContaining({
        name: DEEP_RESEARCH_WORKFLOW_NAME,
        source: 'built-in',
        description: expect.stringContaining('Deep research harness'),
        whenToUse: expect.stringContaining('deep, multi-source'),
        phases: [
          expect.objectContaining({ title: 'Scope' }),
          expect.objectContaining({ title: 'Search' }),
          expect.objectContaining({ title: 'Fetch' }),
          expect.objectContaining({ title: 'Verify' }),
          expect.objectContaining({ title: 'Synthesize' }),
        ],
      }),
    ]);
    expect(resolved).toMatchObject({
      source: 'built-in',
    });
    expect(resolved.scriptPath).toBeUndefined();
    expect(resolved.script).toBe(DEEP_RESEARCH_WORKFLOW_SCRIPT);
    expect(parseWorkflowScript(resolved.script).meta.name).toBe(
      DEEP_RESEARCH_WORKFLOW_NAME,
    );
  });

  it('allows project workflows to shadow the built-in deep-research workflow', async () => {
    const projectRoot = path.join(tmpDir, 'project');
    const workflowsDir = getProjectWorkflowsDir(projectRoot);
    await fs.mkdir(workflowsDir, { recursive: true });
    await fs.writeFile(
      path.join(workflowsDir, 'deep-research.js'),
      'export const meta = { name: "deep-research", description: "Project research" };',
    );

    const registry = createWorkflowRegistryFromConfig({
      getSessionArtifactProjectRoot: () => projectRoot,
    });

    const listed = await registry.listAvailable();
    const resolved = await registry.resolve(DEEP_RESEARCH_WORKFLOW_NAME);

    expect(listed.entries).toEqual([
      expect.objectContaining({
        name: DEEP_RESEARCH_WORKFLOW_NAME,
        source: 'project',
        description: 'Project research',
      }),
    ]);
    expect(listed.diagnostics).toEqual([
      expect.objectContaining({
        source: 'built-in',
        kind: 'shadowed',
        name: DEEP_RESEARCH_WORKFLOW_NAME,
      }),
    ]);
    expect(resolved.source).toBe('project');
    expect(resolved.script).toContain('Project research');
  });

  it('keeps project workflows ahead of plugin and built-in workflows', async () => {
    const projectRoot = path.join(tmpDir, 'project');
    const workflowsDir = getProjectWorkflowsDir(projectRoot);
    await fs.mkdir(workflowsDir, { recursive: true });
    await fs.writeFile(
      path.join(workflowsDir, 'audit.js'),
      'export const meta = { name: "audit", description: "Project audit" };',
    );

    const registry = new WorkflowRegistry({
      projectRoot,
      pluginWorkflows: [
        {
          pluginName: 'quality',
          workflows: [
            {
              script:
                'export const meta = { name: "audit", description: "Plugin audit" };',
            },
          ],
        },
      ],
      builtInWorkflows: [
        {
          script:
            'export const meta = { name: "audit", description: "Built-in audit" };',
        },
      ],
    });

    const listed = await registry.listAvailable();
    const resolved = await registry.resolve('audit');

    expect(listed.entries[0]).toMatchObject({
      name: 'audit',
      source: 'project',
      description: 'Project audit',
    });
    expect(resolved.source).toBe('project');
    expect(resolved.script).toContain('Project audit');
  });

  it('loads filesystem workflows deterministically and reports same-source shadowing', async () => {
    const projectRoot = path.join(tmpDir, 'project');
    const workflowsDir = getProjectWorkflowsDir(projectRoot);
    await fs.mkdir(path.join(workflowsDir, 'audit-dir'), { recursive: true });
    await fs.writeFile(
      path.join(workflowsDir, 'zeta.js'),
      'export const meta = { name: "zeta", description: "Zeta" };',
    );
    await fs.writeFile(
      path.join(workflowsDir, 'audit-dir', 'index.js'),
      'export const meta = { name: "audit", description: "Audit index" };',
    );
    await fs.writeFile(
      path.join(workflowsDir, 'audit-dir', 'workflow.js'),
      'export const meta = { name: "audit", description: "Audit workflow" };',
    );

    const registry = new WorkflowRegistry({ projectRoot, homeDir: tmpDir });
    const listed = await registry.listAvailable();

    expect(listed.entries.map((entry) => entry.name)).toEqual(['audit', 'zeta']);
    expect(listed.entries[0]).toMatchObject({
      name: 'audit',
      description: 'Audit workflow',
    });
    expect(listed.diagnostics).toEqual([
      expect.objectContaining({
        source: 'project',
        kind: 'shadowed',
        name: 'audit',
        message: expect.stringContaining('is shadowed by project'),
      }),
    ]);
  });

  // The workflow script cache memoizes the parsed meta by script text, shared
  // across every registry. Per-source identity must still be applied per
  // registry, on top of that shared meta.
  it('keeps per-source identity when two registries load the same script', async () => {
    const projectRoot = path.join(tmpDir, 'project');
    const sharedDir = getProjectWorkflowsDir(projectRoot);
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.writeFile(
      path.join(sharedDir, 'audit.js'),
      'export const meta = { name: "audit", description: "Shared audit", phases: [{ title: "One" }] };',
    );

    const asProject = new WorkflowRegistry({ projectRoot, homeDir: tmpDir });
    const asPlugin = new WorkflowRegistry({
      projectRoot: path.join(tmpDir, 'elsewhere'),
      homeDir: path.join(tmpDir, 'home'),
      pluginWorkflows: [
        {
          pluginName: 'quality',
          pluginRepository: 'marketplace',
          workflows: [],
          workflowsDir: sharedDir,
        },
      ],
    });

    const projectListed = await asProject.listAvailable();
    const pluginListed = await asPlugin.listAvailable();

    expect(projectListed.entries).toEqual([
      expect.objectContaining({
        name: 'audit',
        source: 'project',
        pluginName: undefined,
      }),
    ]);
    expect(pluginListed.entries).toEqual([
      expect.objectContaining({
        name: 'quality:audit',
        source: 'plugin',
        pluginName: 'quality',
        pluginRepository: 'marketplace',
      }),
    ]);

    // Same description proves the shared memo was used; distinct entry objects
    // prove the shared meta did not leak source identity across registries.
    expect(projectListed.entries[0]?.description).toBe('Shared audit');
    expect(pluginListed.entries[0]?.description).toBe('Shared audit');
    expect(projectListed.entries[0]).not.toBe(pluginListed.entries[0]);
  });
});
