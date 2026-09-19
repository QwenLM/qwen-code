/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MATCHER_CACHE_RESET_INTERVAL } from '@qwen-code/qwen-code-core/utils/gitIgnoreParser.js';
import { fakeToolCall } from '../fake-openai-server.js';
import { runForcedToolCallScenario, TestRig } from '../test-helper.js';

describe('Glob ignore-cache rollover', () => {
  let rig: TestRig;

  afterEach(async () => {
    await rig?.cleanup();
    if (rig?.testDir) {
      await rm(join(rig.testDir, 'scratch'), { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
  });

  it('keeps nested ignore semantics through a large real CLI traversal', async () => {
    rig = new TestRig();
    await rig.setup('glob ignore-cache rollover');
    const root = rig.testDir!;
    execFileSync('git', ['init', '--quiet', root]);
    rig.createFile('.gitignore', '*.log\nignored/\n');
    rig.createFile('.qwenignore', 'qwen-hidden/\n');
    rig.createFile('needle.txt', 'root match');

    // A sparse pattern must traverse the whole tree rather than hit Glob's
    // result-count cap. The core cache-retention suite pins the rollover bound;
    // this fixture pins ignore semantics through a real bundled-CLI traversal
    // that also spans more than one production matcher-evaluation window.
    const scratchDirectories = Math.min(
      Math.floor(MATCHER_CACHE_RESET_INTERVAL / 2) + 1,
      5_000,
    );
    for (let i = 0; i < scratchDirectories; i++) {
      rig.mkdir(`scratch/${i}/nested`);
    }
    rig.mkdir('a/nested/cache');
    rig.createFile('a/.gitignore', 'needle.txt\n!nested/needle.txt\ncache/\n');
    rig.createFile('a/needle.txt', 'ignored by the nested rule');
    rig.createFile('a/nested/needle.txt', 're-included by the nested rule');
    rig.createFile('a/nested/cache/needle.txt', 'ignored directory');
    rig.mkdir('b');
    rig.createFile('b/needle.txt', 'sibling match');
    rig.mkdir('ignored');
    rig.createFile('ignored/.gitignore', '!needle.txt\n');
    rig.createFile('ignored/needle.txt', 'cannot re-include an ignored parent');
    rig.mkdir('qwen-hidden');
    rig.createFile('qwen-hidden/needle.txt', 'ignored by .qwenignore');

    const requests = await runForcedToolCallScenario({
      rig,
      toolCall: fakeToolCall(
        'glob',
        { pattern: '**/needle.txt' },
        'cache-probe',
      ),
      prompt: 'Find needle.txt files using glob.',
      finalResponse: 'Glob traversal complete.',
    });
    const messages = requests.at(-1)?.['messages'] as
      | Array<{ role: string; tool_call_id?: string; content: unknown }>
      | undefined;
    const result = messages?.find(
      (message) =>
        message.role === 'tool' && message.tool_call_id === 'cache-probe',
    );
    expect(result).toBeDefined();
    const content = JSON.stringify(result?.content);
    expect(content).toContain('Found 3');
    for (const file of ['needle.txt', 'a/nested/needle.txt', 'b/needle.txt']) {
      expect(content).toContain(JSON.stringify(join(root, file)).slice(1, -1));
    }
    for (const file of [
      'a/needle.txt',
      'a/nested/cache/needle.txt',
      'ignored/needle.txt',
      'qwen-hidden/needle.txt',
    ]) {
      expect(content).not.toContain(
        JSON.stringify(join(root, file)).slice(1, -1),
      );
    }
  }, 180_000);
});
