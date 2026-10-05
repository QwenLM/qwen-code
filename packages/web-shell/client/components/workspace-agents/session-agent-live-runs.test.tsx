// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionAgentRunFrame } from '@qwen-code/sdk/daemon';
import { getTranslator, I18nProvider } from '../../i18n';
import {
  describeRun,
  SessionAgentLiveRuns,
  STALL_NOTICE_MS,
  toApprovalRequest,
} from './session-agent-live-runs';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const t = getTranslator('en');
const run = (
  over: Partial<SessionAgentRunFrame> = {},
): SessionAgentRunFrame => ({
  type: 'run',
  sessionId: 's1',
  runId: 'r1',
  author: { agentId: 'a1', name: 'reviewer', color: '#f80' },
  status: 'running',
  activityAt: 1_000,
  ...over,
});

describe('describeRun', () => {
  it('words the queue, approval, stall and failure states', () => {
    expect(
      describeRun(run({ status: 'queued', queuePosition: 3 }), 0, t),
    ).toEqual({ text: 'reviewer is queued, 2 ahead', attention: false });
    expect(
      describeRun(run({ status: 'queued', queuePosition: 1 }), 0, t).text,
    ).toBe('reviewer is queued and starts when it is free');
    expect(describeRun(run({ status: 'awaiting_approval' }), 0, t)).toEqual({
      text: 'reviewer is waiting for your approval',
      attention: true,
    });
    expect(describeRun(run(), 1_000 + STALL_NOTICE_MS, t).attention).toBe(
      true,
    );
    expect(describeRun(run({ status: 'failed' }), 0, t).attention).toBe(true);
    expect(
      describeRun(run({ status: 'completed' }), 0, t).text,
    ).toBeUndefined();
  });
});

it('maps a run permission onto the main chat approval card', () => {
  expect(
    toApprovalRequest(
      {
        requestId: 'p1',
        title: 'WriteFile: docs/a.md',
        toolName: 'write_file',
        options: [
          { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
          { optionId: 'no', name: 'Reject', kind: 'reject_once' },
        ],
      },
      'reviewer',
      t,
    ),
  ).toEqual({
    id: 'p1',
    title: 'WriteFile: docs/a.md',
    toolName: 'write_file',
    content: [],
    rawInput: { description: 'docs/a.md' },
    options: [
      { id: 'yes', label: 'Allow', kind: 'allow_once' },
      { id: 'no', label: 'Reject', kind: 'reject_once' },
    ],
  });
});

describe('SessionAgentLiveRuns', () => {
  const mounted: Array<{
    root: ReturnType<typeof createRoot>;
    node: HTMLElement;
  }> = [];
  afterEach(() => {
    for (const { root, node } of mounted) {
      act(() => root.unmount());
      node.remove();
    }
    mounted.length = 0;
  });

  function render(runs: SessionAgentRunFrame[], handlers = {}) {
    const node = document.createElement('div');
    document.body.appendChild(node);
    const root = createRoot(node);
    mounted.push({ root, node });
    const props = {
      onCancel: vi.fn().mockResolvedValue(undefined),
      onRespond: vi.fn().mockResolvedValue(undefined),
      ...handlers,
    };
    act(() =>
      root.render(
        <I18nProvider language="en">
          <SessionAgentLiveRuns runs={runs} {...props} />
        </I18nProvider>,
      ),
    );
    return { node, ...props };
  }

  it('renders each run as the agent message with its steps, tokens and a Stop', () => {
    const { node, onCancel } = render([
      run({
        outputText: 'Partial answer',
        steps: [{ id: 's1', title: 'Read: a.ts', status: 'running' }],
        totalTokens: 1500,
      }),
    ]);
    expect(node.textContent).toContain('reviewer');
    expect(node.textContent).toContain('Partial answer');
    expect(node.textContent).toContain('Read: a.ts');
    expect(node.textContent).toContain(
      `${(1500).toLocaleString()} tokens`,
    );
    const stop = [...node.querySelectorAll('button')].find(
      (button) => button.textContent === 'Stop',
    );
    act(() => stop?.click());
    expect(onCancel).toHaveBeenCalledWith('r1');
  });

  it('shows no Stop on a finished run', () => {
    const { node } = render([run({ status: 'completed', outputText: 'Done' })]);
    expect(
      [...node.querySelectorAll('button')].some(
        (button) => button.textContent === 'Stop',
      ),
    ).toBe(false);
  });

  it('puts the approval on the run, without taking focus, and sends the vote', () => {
    const before = document.activeElement;
    const { node, onRespond } = render([
      run({
        status: 'awaiting_approval',
        permission: {
          requestId: 'p1',
          title: 'Bash: npm test',
          options: [
            { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'deny', name: 'Reject', kind: 'reject_once' },
          ],
        },
      }),
    ]);
    expect(document.activeElement).toBe(before);
    // ToolApproval words the options itself ("Yes, allow once").
    const allow = [...node.querySelectorAll('button')].find((button) =>
      /allow once/i.test(button.textContent ?? ''),
    );
    expect(allow).toBeDefined();
    act(() => allow?.click());
    expect(onRespond).toHaveBeenCalledWith('r1', 'p1', 'allow');
  });
});
