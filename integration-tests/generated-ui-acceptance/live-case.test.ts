/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { AcceptanceEnv, LiveModel } from './harness.js';
import { startAcceptanceEnv } from './harness.js';
import { runLiveCase } from './live-case.js';
import { renderMarkdown, type CaseResult, type CheckResult } from './report.js';
import { toolUse } from './tool-use.js';

vi.mock('./harness.js', () => ({
  SHOW_TOOL: 'mcp__generated-ui__generated_ui_show',
  messageText: (content: string) => content,
  startAcceptanceEnv: vi.fn(),
}));

describe('live case failure isolation', () => {
  it('reports a setup failure and continues without repeating successful cases', async () => {
    const model: LiveModel = {
      label: 'test',
      baseUrl: 'http://127.0.0.1:1',
      apiKey: 'fake-key',
      model: 'fake-model',
    };
    const environments = [0, 1].map(() => ({
      mainRequests: () => [],
      close: vi.fn().mockResolvedValue(undefined),
      screenshot: vi.fn().mockResolvedValue(''),
    }));
    vi.mocked(startAcceptanceEnv)
      .mockResolvedValueOnce(environments[0] as unknown as AcceptanceEnv)
      .mockRejectedValueOnce(new Error('daemon boot timeout'))
      .mockResolvedValueOnce(environments[1] as unknown as AcceptanceEnv);
    const names = ['bill', 'checklist', 'form'];
    const drives = names.map((name) =>
      vi
        .fn<() => Promise<CheckResult[]>>()
        .mockResolvedValue([
          { id: `${name}.check`, covers: name, status: 'pass' },
        ]),
    );
    const results: CaseResult[] = [];
    for (const [index, name] of names.entries()) {
      results.push(await runLiveCase(model, name, 1, drives[index]));
    }

    expect(startAcceptanceEnv).toHaveBeenCalledTimes(3);
    expect(drives.map((drive) => drive.mock.calls.length)).toEqual([1, 0, 1]);
    expect(results.map((result) => result.case)).toEqual(names);
    expect(results[1]).toEqual({
      case: 'checklist',
      model: 'test',
      trial: 1,
      calledTool: false,
      viewErrors: 0,
      secondsToFirstCard: undefined,
      checks: [
        {
          id: 'checklist.harness',
          covers: '—',
          status: 'fail',
          detail: 'daemon boot timeout',
        },
      ],
    });
    const report = renderMarkdown(results);
    expect(report).toContain('| bill.check | bill | pass |');
    expect(report).toContain(
      '| checklist.harness | — | fail | daemon boot timeout |',
    );
    expect(report).toContain('| form.check | form | pass |');
    for (const env of environments) {
      expect(env.close).toHaveBeenCalledTimes(1);
      expect(env.screenshot).not.toHaveBeenCalled();
    }
  });
});

describe('tool use across sessions', () => {
  it('counts a rejected view from an earlier session once', () => {
    const show = {
      role: 'assistant',
      tool_calls: [
        {
          id: 'call_1',
          function: { name: 'mcp__generated-ui__generated_ui_show' },
        },
      ],
    };
    const rejected = {
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'VIEW_ERROR: the script threw',
    };
    const request = (messages: unknown[]) =>
      ({ messages, tools: [], main: true, lastUserText: '' }) as never;
    expect(
      toolUse([
        request([{ role: 'user', content: 'first session' }, show, rejected]),
        request([
          { role: 'user', content: 'first session' },
          show,
          rejected,
          { role: 'user', content: 'again' },
        ]),
        request([{ role: 'user', content: 'second session' }]),
      ]),
    ).toEqual({ calledTool: true, viewErrors: 1 });
    expect(toolUse([request([{ role: 'user', content: 'no view' }])])).toEqual({
      calledTool: false,
      viewErrors: 0,
    });
  });
});
