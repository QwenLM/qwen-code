/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  SHOW_TOOL,
  startAcceptanceEnv,
  type AcceptanceEnv,
  type ChatMessage,
  type LiveModel,
  type RecordedRequest,
} from './harness.js';
import { runLiveCase } from './live-case.js';
import { renderMarkdown, type CaseResult, type CheckResult } from './report.js';
import { toolUse } from './tool-use.js';

vi.mock('./harness.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./harness.js')>()),
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
  const show: ChatMessage = {
    role: 'assistant',
    tool_calls: [{ id: 'call_1', function: { name: SHOW_TOOL } }],
  };
  const request = (messages: ChatMessage[]): RecordedRequest => ({
    messages,
    tools: [],
    main: true,
    lastUserText: '',
  });
  const toolResult = (text: string): ChatMessage => ({
    role: 'tool',
    tool_call_id: 'call_1',
    content: [{ type: 'text', text }],
  });
  const mcpError = (text: string): ChatMessage => {
    const content = [{ type: 'text', text }];
    const response = JSON.stringify([
      {
        functionResponse: {
          name: 'generated_ui_show',
          response: { error: { isError: true, content }, content },
        },
      },
    ]);
    return toolResult(
      `MCP tool 'generated_ui_show' reported tool error for function call: {"name":"generated_ui_show","args":{"title":"Handling VIEW_ERROR"}} with response: ${response}`,
    );
  };
  const viewError =
    'VIEW_ERROR: The initial calculation updates "#absent", but no element has that id. Nothing was displayed. Correct the document and call generated_ui_show again with all five fields.';

  it('counts a rejected view from an earlier session once', () => {
    const rejected = mcpError(viewError);
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

  it('ignores VIEW_ERROR in a successful title and summary', () => {
    const title = 'Recovering from VIEW_ERROR';
    const summary = `Previous result: ${viewError}`;
    const output = `${JSON.stringify({ title, summary })}\n${title}\n${summary}`;
    expect(toolUse([request([show, toolResult(output)])])).toEqual({
      calledTool: true,
      viewErrors: 0,
    });
  });

  it('ignores VIEW_ERROR in the arguments of a different tool error', () => {
    const invalid = mcpError('INVALID_DOCUMENT: Supply a complete view.');
    expect(toolUse([request([show, invalid])])).toEqual({
      calledTool: true,
      viewErrors: 0,
    });
  });
});
