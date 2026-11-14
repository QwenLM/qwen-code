/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fakeToolCall,
  startFakeOpenAIServer,
  type FakeOpenAIToolCall,
} from '../fake-openai-server.js';
import {
  exitInteractive,
  fakeModelLaunchArgs,
  makeWaitFor,
} from '../helpers/gated-skill-fixture.js';
import { approveProjectHooks } from '../project-hook-approval.js';
import { IS_CONTAINER_SANDBOX, TestRig } from '../test-helper.js';

type Message = {
  role: string;
  tool_call_id?: string;
  content?: unknown;
  tool_calls?: FakeOpenAIToolCall[];
};

interface CorpusCase {
  id: string;
  content: string;
  oldString: string;
  newString: string;
  expectedCandidate: string | null;
  repairedNewString?: string;
  expectedContent?: string;
}

const corpus = JSON.parse(
  readFileSync(
    new URL(
      '../../packages/core/src/tools/fixtures/edit-recovery-cases.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as CorpusCase[];

const target =
  "function example() {\n  const value = 'original';\n  return value;\n}";
const wrongTarget = target.replace('original', 'orignal');
const replacement = target.replace('original', 'changed');
const original = `prefix one\n${target}\nsuffix one\n`;

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part: { text?: string }) => part.text ?? '').join('\n');
  }
  return JSON.stringify(content);
}

function resultFor(messages: Message[], id: string): string | undefined {
  const result = messages.find(
    (message) => message.role === 'tool' && message.tool_call_id === id,
  );
  return result ? contentText(result.content) : undefined;
}

function reference(
  text: string | undefined,
  kind: 'recovery' | 'read',
): string {
  return (
    text?.match(
      new RegExp(`${kind}_id\\s*:\\s*["']?((?:er|rd)_[a-zA-Z0-9-]+)`),
    )?.[1] ?? 'missing-reference'
  );
}

describe.skipIf(IS_CONTAINER_SANDBOX)('edit recovery through the CLI', () => {
  let rig: TestRig;
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rig?.cleanup();
  });

  async function run(
    name: string,
    content: string,
    decide: (
      messages: Message[],
      file: string,
    ) => FakeOpenAIToolCall | undefined,
    settings: Record<string, unknown> = {},
    configure?: (directory: string) => void,
  ) {
    rig = new TestRig();
    await rig.setup(name, { settings });
    const file = rig.createFile('fixture.txt', content);
    configure?.(rig.testDir!);
    const delivered = new Map<string, string>();
    const server = await startFakeOpenAIServer(({ body }) => {
      if (body['stream'] !== true) return { content: '{}' };
      const messages = (body['messages'] ?? []) as Message[];
      for (const message of messages) {
        if (message.role === 'tool' && message.tool_call_id) {
          delivered.set(message.tool_call_id, contentText(message.content));
        }
      }
      const call = decide(messages, file);
      return call ? { toolCalls: [call] } : { content: 'Recovery verified.' };
    });
    vi.stubEnv('NO_PROXY', '127.0.0.1,localhost');
    vi.stubEnv('no_proxy', '127.0.0.1,localhost');
    try {
      await rig.run(
        'Execute the deterministic edit recovery scenario.',
        ...fakeModelLaunchArgs(server),
        '--max-wall-time',
        '30s',
        '--max-tool-calls',
        '8',
      );
      const calls = server.requests
        .filter(({ body }) => body['stream'] === true)
        .flatMap(({ body }) => (body['messages'] ?? []) as Message[])
        .flatMap((message) => message.tool_calls ?? []);
      return { file, delivered, calls };
    } finally {
      await server.close();
    }
  }

  function recoveryCalls(
    messages: Message[],
    file: string,
    newString?: string,
  ): FakeOpenAIToolCall | undefined {
    if (resultFor(messages, 'call_read') === undefined) {
      return fakeToolCall('read_file', { file_path: file }, 'call_read');
    }
    if (resultFor(messages, 'call_fail') === undefined) {
      return fakeToolCall(
        'edit',
        {
          file_path: file,
          old_string: wrongTarget,
          new_string: replacement,
        },
        'call_fail',
      );
    }
    if (resultFor(messages, 'call_retry') === undefined) {
      return fakeToolCall(
        'edit',
        {
          file_path: file,
          recovery_id: reference(resultFor(messages, 'call_fail'), 'recovery'),
          ...(newString === undefined ? {} : { new_string: newString }),
        },
        'call_retry',
      );
    }
    return undefined;
  }

  it('delivers a complete no-match candidate and retries without old/new or another read', async () => {
    const { file, delivered, calls } = await run(
      'edit reference no-match retry',
      original,
      recoveryCalls,
    );
    expect(delivered.get('call_fail')).toContain(target);
    expect(reference(delivered.get('call_fail'), 'recovery')).not.toBe(
      'missing-reference',
    );
    const retries = calls.filter((call) => call.id === 'call_retry');
    expect(retries.length).toBeGreaterThan(0);
    for (const retry of retries) {
      expect(JSON.parse(retry.function.arguments)).toEqual({
        file_path: file,
        recovery_id: reference(delivered.get('call_fail'), 'recovery'),
      });
    }
    expect(new Set(calls.map((call) => call.id))).toEqual(
      new Set(['call_read', 'call_fail', 'call_retry']),
    );
    expect(readFileSync(file, 'utf8')).toBe(
      original.replace(target, replacement),
    );
  });

  it.each([
    ['override', target.replace('original', 'overridden')],
    ['deletion', ''],
  ])('honors an explicit recovery replacement: %s', async (label, next) => {
    const { file } = await run(
      `edit reference ${label}`,
      original,
      (messages, file) => recoveryCalls(messages, file, next),
    );
    expect(readFileSync(file, 'utf8')).toBe(original.replace(target, next));
  });

  it('recovers a stale ordinary edit without an intervening read', async () => {
    const changed = `${original}exterior mutation\n`;
    const { file, delivered, calls } = await run(
      'edit reference stale retry',
      original,
      (messages, file) => {
        if (resultFor(messages, 'call_read') === undefined) {
          return fakeToolCall('read_file', { file_path: file }, 'call_read');
        }
        if (resultFor(messages, 'call_fail') === undefined) {
          writeFileSync(file, changed);
          return fakeToolCall(
            'edit',
            { file_path: file, old_string: target, new_string: replacement },
            'call_fail',
          );
        }
        if (resultFor(messages, 'call_retry') === undefined) {
          return fakeToolCall(
            'edit',
            {
              file_path: file,
              recovery_id: reference(
                resultFor(messages, 'call_fail'),
                'recovery',
              ),
            },
            'call_retry',
          );
        }
        return undefined;
      },
    );
    expect(delivered.get('call_fail')).toMatch(/modified|changed|stale/i);
    expect(delivered.get('call_fail')).toContain(target);
    expect(new Set(calls.map((call) => call.id))).toEqual(
      new Set(['call_read', 'call_fail', 'call_retry']),
    );
    expect(readFileSync(file, 'utf8')).toBe(
      changed.replace(target, replacement),
    );
  });

  it('edits only the selected duplicate block from a delivered read reference', async () => {
    const content = 'header\nsame\nmiddle\nsame\nfooter\n';
    const { file, delivered } = await run(
      'edit read reference duplicate range',
      content,
      (messages, file) => {
        if (resultFor(messages, 'call_read') === undefined) {
          return fakeToolCall('read_file', { file_path: file }, 'call_read');
        }
        if (resultFor(messages, 'call_range') === undefined) {
          return fakeToolCall(
            'edit',
            {
              file_path: file,
              read_id: reference(resultFor(messages, 'call_read'), 'read'),
              start_line: 4,
              end_line: 4,
              new_string: 'changed\n',
            },
            'call_range',
          );
        }
        return undefined;
      },
    );
    expect(reference(delivered.get('call_read'), 'read')).not.toBe(
      'missing-reference',
    );
    expect(readFileSync(file, 'utf8')).toBe(
      'header\nsame\nmiddle\nchanged\nfooter\n',
    );
  });

  it('preserves raw trailing spaces and CRLF in a read-reference edit', async () => {
    const { file, delivered } = await run(
      'edit read reference raw bytes',
      '\ufeffheader\r\noriginal  \r\nfooter\r\n',
      (messages, file) => {
        if (resultFor(messages, 'call_read') === undefined) {
          return fakeToolCall('read_file', { file_path: file }, 'call_read');
        }
        if (resultFor(messages, 'call_range') === undefined) {
          return fakeToolCall(
            'edit',
            {
              file_path: file,
              read_id: reference(resultFor(messages, 'call_read'), 'read'),
              start_line: 2,
              end_line: 2,
              new_string: 'changed  \n',
            },
            'call_range',
          );
        }
        return undefined;
      },
    );
    expect(delivered.get('call_read')).toContain('original  ');
    expect(readFileSync(file, 'utf8')).toBe(
      '\ufeffheader\r\nchanged  \r\nfooter\r\n',
    );
  });

  it('rejects snapshot drift even when size and mtime are restored', async () => {
    let changed = '';
    let metadata:
      | {
          size: number;
          restoredSize: number;
          mtime: number;
          restoredMtime: number;
        }
      | undefined;
    const { file, delivered } = await run(
      'edit reference exact snapshot check',
      original,
      (messages, file) => {
        if (resultFor(messages, 'call_fail') === undefined) {
          return recoveryCalls(messages, file);
        }
        if (resultFor(messages, 'call_retry') === undefined) {
          const stats = statSync(file);
          changed = original.replace('prefix', 'PREFIX');
          writeFileSync(file, changed);
          utimesSync(file, stats.atimeMs / 1000, stats.mtimeMs / 1000);
          const restored = statSync(file);
          metadata = {
            size: stats.size,
            restoredSize: restored.size,
            mtime: stats.mtimeMs,
            restoredMtime: restored.mtimeMs,
          };
          return fakeToolCall(
            'edit',
            {
              file_path: file,
              recovery_id: reference(
                resultFor(messages, 'call_fail'),
                'recovery',
              ),
            },
            'call_retry',
          );
        }
        return undefined;
      },
    );
    expect(delivered.get('call_retry')).toMatch(
      /changed|stale|invalid|expired/i,
    );
    expect(metadata).toBeDefined();
    expect(metadata!.restoredSize).toBe(metadata!.size);
    expect(metadata!.restoredMtime).toBeCloseTo(metadata!.mtime, 2);
    expect(readFileSync(file, 'utf8')).toBe(changed);
  });

  it('materializes hook input and writes the hook replacement while keeping wire arguments compact', async () => {
    const hookReplacement = target.replace('original', 'hook-changed');
    const { file, calls } = await run(
      'edit reference hook replacement',
      original,
      recoveryCalls,
      {
        hooks: {
          PreToolUse: [
            {
              matcher: 'edit',
              hooks: [{ type: 'command', command: 'node edit-hook.mjs' }],
            },
          ],
        },
      },
      (directory) => {
        rig.createFile(
          'edit-hook.mjs',
          `import {readFileSync,appendFileSync} from 'node:fs';
const input=JSON.parse(readFileSync(0,'utf8'));
appendFileSync('hook-input.jsonl',JSON.stringify(input)+'\\n');
const args=input.tool_input;
const output=args.old_string===${JSON.stringify(target)}?{updatedInput:{...args,new_string:${JSON.stringify(hookReplacement)}}}:{};
console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',...output}}));`,
        );
        approveProjectHooks(join(directory, '.qwen-home'), directory);
      },
    );
    const hits = readFileSync(join(rig.testDir!, 'hook-input.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(
        (line) => JSON.parse(line) as { tool_input: Record<string, unknown> },
      );
    expect(hits.at(-1)?.tool_input).toMatchObject({
      file_path: file,
      old_string: target,
      new_string: replacement,
    });
    expect(hits.at(-1)?.tool_input).not.toHaveProperty('recovery_id');
    const retries = calls.filter((call) => call.id === 'call_retry');
    expect(retries.length).toBeGreaterThan(0);
    for (const retry of retries) {
      expect(JSON.parse(retry.function.arguments)).not.toHaveProperty(
        'old_string',
      );
    }
    expect(readFileSync(file, 'utf8')).toBe(
      original.replace(target, hookReplacement),
    );
  });

  it('applies edit deny rules to a read reference without writing', async () => {
    const { file, delivered } = await run(
      'edit read reference permission denial',
      original,
      (messages, file) => {
        if (resultFor(messages, 'call_read') === undefined) {
          return fakeToolCall('read_file', { file_path: file }, 'call_read');
        }
        if (resultFor(messages, 'call_denied') === undefined) {
          return fakeToolCall(
            'edit',
            {
              file_path: file,
              read_id: reference(resultFor(messages, 'call_read'), 'read'),
              start_line: 2,
              end_line: 4,
              new_string: `${replacement}\n`,
            },
            'call_denied',
          );
        }
        return undefined;
      },
      { permissions: { deny: ['Edit(fixture.txt)'] } },
    );
    expect(delivered.get('call_denied')).toMatch(/denied|declined|blocked/i);
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  it.each([
    ['case-001', 'P1'],
    ['case-005', 'P2'],
  ] as const)(
    'replays sanitized production %s through %s in the actual CLI',
    async (caseId, route) => {
      const sample = corpus.find((item) => item.id === caseId)!;
      expect(sample.expectedCandidate).toBeTruthy();
      const candidate = sample.expectedCandidate!;
      const offset = sample.content.indexOf(candidate);
      const end = offset + candidate.length;
      const startLine = sample.content.slice(0, offset).split('\n').length;
      const endLine = sample.content.slice(0, end - 1).split('\n').length;
      const lineStart =
        offset === 0 ? 0 : sample.content.lastIndexOf('\n', offset - 1) + 1;
      const newline = sample.content.indexOf('\n', end - 1);
      const lineEnd = newline < 0 ? sample.content.length : newline + 1;
      const rangeNew =
        sample.content.slice(lineStart, offset) +
        sample.repairedNewString! +
        sample.content.slice(end, lineEnd);
      const { file, delivered } = await run(
        `edit reference corpus ${caseId} ${route}`,
        sample.content,
        (messages, file) => {
          if (resultFor(messages, 'call_read') === undefined) {
            return fakeToolCall('read_file', { file_path: file }, 'call_read');
          }
          if (resultFor(messages, 'call_fail') === undefined) {
            return fakeToolCall(
              'edit',
              {
                file_path: file,
                old_string: sample.oldString,
                new_string: sample.newString,
              },
              'call_fail',
            );
          }
          if (
            route === 'P2' &&
            resultFor(messages, 'call_range_read') === undefined
          ) {
            return fakeToolCall(
              'read_file',
              {
                file_path: file,
                offset: startLine - 1,
                limit: endLine - startLine + 1,
              },
              'call_range_read',
            );
          }
          if (resultFor(messages, 'call_corpus_retry') === undefined) {
            return fakeToolCall(
              'edit',
              route === 'P1'
                ? {
                    file_path: file,
                    recovery_id: reference(
                      resultFor(messages, 'call_fail'),
                      'recovery',
                    ),
                    new_string: sample.repairedNewString!,
                  }
                : {
                    file_path: file,
                    read_id: reference(
                      resultFor(messages, 'call_range_read'),
                      'read',
                    ),
                    start_line: startLine,
                    end_line: endLine,
                    new_string: rangeNew,
                  },
              'call_corpus_retry',
            );
          }
          return undefined;
        },
      );
      expect(delivered.get('call_fail')).toMatch(/0 occurrences/);
      if (route === 'P1') {
        expect(delivered.get('call_fail')).toContain(candidate);
        expect(reference(delivered.get('call_fail'), 'recovery')).not.toBe(
          'missing-reference',
        );
      } else {
        expect(reference(delivered.get('call_range_read'), 'read')).not.toBe(
          'missing-reference',
        );
      }
      expect(readFileSync(file, 'utf8')).toBe(sample.expectedContent);
    },
  );

  it('asks for fresh human approval with the actual recovered diff', async () => {
    rig = new TestRig();
    await rig.setup('edit reference interactive approval', {
      settings: {
        hooks: {
          PreToolUse: [
            {
              matcher: 'edit',
              hooks: [{ type: 'command', command: 'node edit-approval.mjs' }],
            },
          ],
        },
      },
    });
    const file = rig.createFile('fixture.txt', original);
    rig.createFile(
      'edit-approval.mjs',
      `import {readFileSync} from 'node:fs';
const input=JSON.parse(readFileSync(0,'utf8'));
const output=input.tool_input.old_string===${JSON.stringify(target)}?{permissionDecision:'ask',permissionDecisionReason:'Review the recovered target'}:{};
console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',...output}}));`,
    );
    approveProjectHooks(join(rig.testDir!, '.qwen-home'), rig.testDir!);
    const server = await startFakeOpenAIServer(({ body }) => {
      if (body['stream'] !== true) return { content: '{}' };
      const call = recoveryCalls((body['messages'] ?? []) as Message[], file);
      return call ? { toolCalls: [call] } : { content: 'Recovery verified.' };
    });
    vi.stubEnv('NO_PROXY', '127.0.0.1,localhost');
    vi.stubEnv('no_proxy', '127.0.0.1,localhost');
    try {
      const { ptyProcess, promise } = rig.runInteractive(
        ...fakeModelLaunchArgs(server),
      );
      let output = '';
      ptyProcess.onData((chunk) => {
        output += chunk;
      });
      const waitFor = makeWaitFor(rig, () => output);
      await waitFor('the CLI to start', () =>
        output.includes('Type your message'),
      );
      const prompt = 'Recover the edit and ask me before writing.';
      ptyProcess.write(prompt);
      await waitFor('the prompt to echo', () => output.includes(prompt));
      ptyProcess.write('\r');
      await waitFor('the recovered edit approval', () =>
        output.includes('Review the recovered target'),
      );
      expect(output).toContain('original');
      expect(output).toContain('changed');
      expect(readFileSync(file, 'utf8')).toBe(original);
      ptyProcess.write('\r');
      await waitFor(
        'the approved write',
        () =>
          readFileSync(file, 'utf8') === original.replace(target, replacement),
      );
      await waitFor('the successful tool result delivery', () =>
        server.requests.some(
          ({ body }) =>
            resultFor((body['messages'] ?? []) as Message[], 'call_retry') !==
            undefined,
        ),
      );
      await exitInteractive(ptyProcess, waitFor, () => output);
      expect((await promise).exitCode).toBe(0);
    } finally {
      await server.close();
    }
  }, 360_000);
});
