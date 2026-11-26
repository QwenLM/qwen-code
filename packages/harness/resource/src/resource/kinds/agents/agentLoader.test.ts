/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadAgentsFromDirectory,
  loadAgentsFromPath,
  parseAgentMarkdown,
} from './agentLoader.js';

describe('Agent loader', () => {
  it('parses Agent frontmatter into a runtime-independent resource', async () => {
    const resource = await parseAgentMarkdown(
      '/agents/reviewer.md',
      'project',
      `---
name: reviewer
description: Reviews changes
tools: Read, Grep
disallowedTools: Write
model: inherit
temperature: 0.3
maxTurns: 7
timeoutMins: 2
effort: high
skills: review, test
background: "true"
mcpServers:
  local:
    command: node
    args: [server.js]
hooks:
  PreToolUse:
    - matcher: "*"
      hooks:
        - type: command
          command: echo
---
Review the requested changes.`,
    );

    expect(resource).toMatchObject({
      kind: 'local',
      name: 'reviewer',
      description: 'Reviews changes',
      prompt: 'Review the requested changes.',
      tools: ['Read', 'Grep'],
      disallowedTools: ['Write'],
      model: 'inherit',
      temperature: 0.3,
      maxTurns: 7,
      timeoutMins: 2,
      effort: 'high',
      skills: ['review', 'test'],
      background: true,
      metadata: {
        filePath: '/agents/reviewer.md',
        source: 'project',
      },
    });
    expect(resource.mcpServers).toEqual([
      { local: { command: 'node', args: ['server.js'] } },
    ]);
  });

  it('recurses, namespaces plugin Agents, and keeps malformed files isolated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-loader-'));
    await mkdir(join(root, 'review'), { recursive: true });
    await writeFile(
      join(root, 'review', 'agent.md'),
      '---\nname: worker\ndescription: Worker\n---\nPrompt',
    );
    await writeFile(join(root, 'broken.md'), 'not frontmatter');

    const result = await loadAgentsFromDirectory(root, {
      source: 'plugin',
      pluginName: 'demo',
    });

    expect(result.agents).toMatchObject([{ name: 'demo:review:worker' }]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].source).toBe('plugin');
  });

  it('dispatches a file or directory and ignores missing paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-path-'));
    const file = join(root, 'worker.md');
    await writeFile(
      file,
      '---\nname: worker\ndescription: Worker\n---\nPrompt',
    );

    await expect(
      loadAgentsFromPath(file, { source: 'plugin', pluginName: 'demo' }),
    ).resolves.toMatchObject({
      sourceType: 'file',
      agents: [{ name: 'demo:worker' }],
    });
    await expect(
      loadAgentsFromPath(join(root, 'missing.md'), { source: 'plugin' }),
    ).resolves.toBeUndefined();
  });

  it('defaults kind to local when omitted', async () => {
    const resource = await parseAgentMarkdown(
      '/agents/plain.md',
      'project',
      '---\nname: plain\ndescription: Plain\n---\nPrompt',
    );
    expect(resource.kind).toBe('local');
  });

  it('forwards kind: remote for host-side interpretation', async () => {
    const resource = await parseAgentMarkdown(
      '/agents/cloud.md',
      'project',
      `---
name: cloud-worker
description: Runs remotely
kind: remote
model: ultimate
timeoutMins: 30
---
Remote prompt.`,
    );
    expect(resource).toMatchObject({
      kind: 'remote',
      name: 'cloud-worker',
      model: 'ultimate',
      timeoutMins: 30,
      prompt: 'Remote prompt.',
    });
  });

  it('rejects unknown kind values', async () => {
    await expect(
      parseAgentMarkdown(
        '/agents/bad.md',
        'project',
        '---\nname: bad\ndescription: Bad\nkind: cloud\n---\nPrompt',
      ),
    ).rejects.toThrow(/kind: /);
  });
});
