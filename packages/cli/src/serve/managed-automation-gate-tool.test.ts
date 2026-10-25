/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MANAGED_AUTOMATION_GATE_TOOL,
  ManagedAutomationGateTool,
  parseManagedAutomationGateResult,
} from './managed-automation-gate-tool.js';
import { createManagedToolSet } from './managed-runtime-tool-executor.js';

describe.skipIf(process.platform === 'win32')(
  'ManagedAutomationGateTool',
  () => {
    let workspace: string;

    beforeEach(async () => {
      workspace = await mkdtemp(path.join(tmpdir(), 'qwen-gate-tool-'));
    });

    afterEach(async () => {
      await rm(workspace, { recursive: true, force: true });
    });

    const toolOf = () => {
      const tools = createManagedToolSet(workspace, 'session-gate');
      const tool = tools.tools.get(MANAGED_AUTOMATION_GATE_TOOL);
      expect(tool).toBeInstanceOf(ManagedAutomationGateTool);
      return tool as ManagedAutomationGateTool;
    };

    const run = async (gate: string) => {
      const result = await toolOf()
        .build({ gate })
        .execute(new AbortController().signal);
      return parseManagedAutomationGateResult([
        { text: result.llmContent as string },
      ]);
    };

    it('is admitted beside the worker tools and runs in the Session directory', async () => {
      expect(await run('printf "%s" "$PWD"')).toMatchObject({
        kind: 'output',
        // The shell reports the canonical path (macOS: /private/var/...).
        stdout: await realpath(workspace),
        truncated: false,
      });
    });

    it('answers the runner’s three outcomes as structured results', async () => {
      expect(await run('true')).toMatchObject({ kind: 'quiet' });
      expect(await run('printf "event: comment\\n"')).toMatchObject({
        kind: 'output',
        stdout: 'event: comment\n',
      });
      expect(await run('echo nope >&2; exit 3')).toMatchObject({
        kind: 'failed',
        detail: 'exited with code 3',
        stderr: 'nope\n',
      });
    });

    it('refuses what the gate contract refuses before running anything', () => {
      const tool = toolOf();
      expect(() => tool.build({ gate: '' })).toThrow(
        /gate must be a non-empty/,
      );
      expect(() => tool.build({ gate: 'sleep 5 &' })).toThrow(
        /must not background/,
      );
    });
  },
);

describe('parseManagedAutomationGateResult', () => {
  it('reads only a well-formed result, else null', () => {
    expect(
      parseManagedAutomationGateResult([
        { text: '{"kind":"quiet","durationMs":3}' },
      ]),
    ).toEqual({ kind: 'quiet', durationMs: 3 });
    expect(
      parseManagedAutomationGateResult([
        { text: '{"kind":"blocked","reason":"r","rule":"Monitor(x)"}' },
      ]),
    ).toEqual({ kind: 'blocked', reason: 'r', rule: 'Monitor(x)' });
    // A worker clock stepped back mid-probe: the records only take a whole,
    // non-negative count.
    expect(
      parseManagedAutomationGateResult([
        {
          text: JSON.stringify({
            kind: 'output',
            stdout: 'x',
            truncated: false,
            durationMs: -3,
          }),
        },
      ]),
    ).toEqual({ kind: 'output', stdout: 'x', truncated: false, durationMs: 0 });
    expect(
      parseManagedAutomationGateResult([
        { text: JSON.stringify({ kind: 'quiet', durationMs: 4.6 }) },
      ]),
    ).toEqual({ kind: 'quiet', durationMs: 5 });
    for (const parts of [
      [],
      [{ text: 'not json' }],
      [{ text: '[]' }],
      [{ text: '{"kind":"output"}' }],
      [{ text: '{"kind":"weird"}' }],
      [{ inlineData: {} }],
    ]) {
      expect(parseManagedAutomationGateResult(parts)).toBeNull();
    }
  });
});
