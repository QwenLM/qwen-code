/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IS_CONTAINER_SANDBOX, TestRig } from '../test-helper.js';
import { fakeToolCall, startFakeOpenAIServer } from '../fake-openai-server.js';

interface HookRecord {
  label: string;
  input: {
    hook_event_name: string;
    session_id: string;
    agent_id?: string;
    agent_type?: string;
    tool_name?: string;
    tool_input?: { file_path?: string };
  };
}

function barrier() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release,
    async wait() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          ready.then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), 20_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// The recorder uses the host Node executable and POSIX shell quoting.
describe.skipIf(IS_CONTAINER_SANDBOX || process.platform === 'win32')(
  'subagent hook ownership',
  () => {
    const rig = new TestRig();
    afterEach(async () => {
      vi.unstubAllEnvs();
      await rig.cleanup();
    });

    it('isolates concurrent parent and sibling tool hooks while inheriting global hooks', async () => {
      await rig.setup('subagent-hook-owner');
      rig.mkdir('.qwen-home/agents');
      rig.mkdir('home');
      const log = join(rig.testDir!, 'hooks.jsonl');
      const recorder = rig.createFile(
        'record.cjs',
        `const fs = require('node:fs');
let raw = '';
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(process.argv[3], JSON.stringify({label: process.argv[2], input: JSON.parse(raw)}) + '\\n');
  console.log('{}');
});`,
      );
      const command = (label: string) =>
        [process.execPath, recorder, label, log]
          .map((part) => `'${part.replaceAll("'", "'\\''")}'`)
          .join(' ');
      const globalHook = [
        { hooks: [{ type: 'command', command: command('global') }] },
      ];
      rig.createFile(
        '.qwen-home/settings.json',
        JSON.stringify({
          $version: 4,
          hooks: { PreToolUse: globalHook, SubagentStart: globalHook },
        }),
      );
      for (const role of ['a', 'b']) {
        rig.createFile(
          `.qwen-home/agents/p01-${role}.md`,
          `---
name: p01-${role}
description: Hook owner regression agent ${role}
maxTurns: 3
tools:
  - read_file
hooks:
  PreToolUse:
    - matcher: '*'
      hooks:
        - type: command
          command: ${JSON.stringify(command(role))}
---
P01_ROLE_${role.toUpperCase()}
`,
        );
      }
      const files = Object.fromEntries(
        ['parent', 'a', 'b'].map((role) => [
          role,
          rig.createFile(`${role}.txt`, `${role} marker\n`),
        ]),
      );
      const emptySettings = rig.createFile('system.json', '{}');
      for (const [key, value] of Object.entries({
        HOME: join(rig.testDir!, 'home'),
        QWEN_HOME: join(rig.testDir!, '.qwen-home'),
        QWEN_RUNTIME_DIR: join(rig.testDir!, 'runtime'),
        QWEN_CODE_SYSTEM_SETTINGS_PATH: emptySettings,
        QWEN_CODE_SYSTEM_DEFAULTS_PATH: emptySettings,
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
      })) {
        vi.stubEnv(key, value);
      }
      const bRead = barrier();
      const aRead = barrier();
      const counts: Record<string, number> = {};
      const barrierFailures: string[] = [];
      const server = await startFakeOpenAIServer(async ({ body }) => {
        const messages = body['messages'] as Array<{
          role: string;
          content: unknown;
        }>;
        const system = messages
          .filter((m) => m.role === 'system')
          .map((m) => JSON.stringify(m.content))
          .join('\n');
        const role = system.includes('P01_ROLE_A')
          ? 'a'
          : system.includes('P01_ROLE_B')
            ? 'b'
            : 'parent';
        const turn = counts[role] ?? 0;
        counts[role] = turn + 1;
        if (role === 'parent') {
          if (turn === 0 || turn === 2) {
            const target = turn === 0 ? 'a' : 'b';
            return {
              toolCalls: [
                fakeToolCall('agent', {
                  description: `Run agent ${target}`,
                  prompt: 'Read your marker file.',
                  subagent_type: `p01-${target}`,
                  run_in_background: target === 'a',
                }),
              ],
            };
          }
          if (turn === 1)
            return {
              toolCalls: [
                fakeToolCall('read_file', { file_path: files['parent'] }),
              ],
            };
          if (!(await aRead.wait()))
            barrierFailures.push('parent awaited A read');
        } else if (turn === 0) {
          // A stays alive across the parent read and B's read. B then stays alive
          // until A has read, proving both local registrations overlap.
          if (role === 'a' && !(await bRead.wait())) {
            barrierFailures.push('A awaited B read');
            return { content: 'barrier failed' };
          }
          return {
            toolCalls: [fakeToolCall('read_file', { file_path: files[role] })],
          };
        } else if (role === 'b') {
          bRead.release();
          if (!(await aRead.wait())) barrierFailures.push('B awaited A read');
        } else {
          aRead.release();
        }
        return { content: 'P01 done' };
      });
      try {
        const stdout = await rig.run(
          'Run the hook isolation scenario.',
          '--auth-type',
          'openai',
          '--model',
          'fake-model',
          '--openai-base-url',
          server.baseUrl,
          '--openai-api-key',
          'fake-key',
          '--max-wall-time',
          '45s',
          '--output-format',
          'json',
        );
        expect(barrierFailures).toEqual([]);
        const output = JSON.parse(stdout) as Array<{
          type: string;
          subtype?: string;
          stats?: { tools: { totalSuccess: number; totalFail: number } };
        }>;
        const result = output.find((entry) => entry.type === 'result');
        expect(result?.subtype).toBe('success');
        expect(result?.stats?.tools).toMatchObject({
          totalSuccess: 5,
          totalFail: 0,
        });
        const records = readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as HookRecord);
        const starts = records.filter(
          ({ input }) => input.hook_event_name === 'SubagentStart',
        );
        expect(starts).toHaveLength(2);
        const agentIds = Object.fromEntries(
          starts.map(({ input }) => [input.agent_type, input.agent_id]),
        );
        expect(agentIds['p01-a']).toBeTruthy();
        expect(agentIds['p01-b']).toBeTruthy();
        expect(agentIds['p01-a']).not.toBe(agentIds['p01-b']);
        const reads = records.filter(
          ({ input }) => input.tool_name === 'read_file',
        );
        for (const role of ['parent', 'a', 'b']) {
          const matches = reads.filter(
            ({ input }) =>
              basename(input.tool_input?.file_path ?? '') === `${role}.txt`,
          );
          expect(matches.map(({ label }) => label).sort(), role).toEqual(
            role === 'parent' ? ['global'] : [role, 'global'].sort(),
          );
          for (const { input } of matches) {
            expect(input.agent_id).toBe(
              role === 'parent' ? undefined : agentIds[`p01-${role}`],
            );
            expect(input.session_id).toBe(starts[0].input.session_id);
          }
        }
        expect(starts[0].input.session_id).toBeTruthy();
        expect(new Set(records.map(({ input }) => input.session_id)).size).toBe(
          1,
        );
        expect(reads).toHaveLength(5);
      } finally {
        aRead.release();
        bRead.release();
        await server.close();
      }
    }, 90_000);
  },
);
