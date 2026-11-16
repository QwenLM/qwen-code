// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionAgentRunFrame } from '@qwen-code/sdk/daemon';
import { getTranslator, I18nProvider } from '../../i18n';
import {
  canRetryRun,
  describeRun,
  INPUT_PREVIEW_MAX_CHARS,
  SessionAgentLiveRuns,
  squadEngagements,
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
    expect(describeRun(run(), 1_000 + STALL_NOTICE_MS, t).attention).toBe(true);
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

describe('approval input preview', () => {
  const options = [
    { optionId: 'yes', name: 'Allow', kind: 'allow_once' as const },
  ];

  it('shows a shell tool its command, whichever program asked', () => {
    // Claude: Bash with JSON input.
    expect(
      toApprovalRequest(
        {
          requestId: 'p1',
          title: 'Bash: npm test',
          toolName: 'Bash',
          inputPreview: JSON.stringify({
            command: 'npm test',
            description: 'Run tests',
          }),
          options,
        },
        'claude-B',
        t,
      ),
    ).toMatchObject({
      toolKind: 'execute',
      content: [],
      rawInput: { description: 'npm test', command: 'npm test' },
    });
    // Codex: exec_command with argv.
    expect(
      toApprovalRequest(
        {
          requestId: 'p2',
          title: 'exec_command',
          toolName: 'exec_command',
          inputPreview: JSON.stringify({ command: ['git', 'status'] }),
          options,
        },
        'codex',
        t,
      ).rawInput,
    ).toEqual({ command: 'git status' });
    // A clipped preview is not JSON: shown as it came.
    expect(
      toApprovalRequest(
        {
          requestId: 'p3',
          title: 'execute',
          toolName: 'execute',
          inputPreview: '{"command":"echo hi…',
          options,
        },
        'qwen',
        t,
      ).rawInput,
    ).toEqual({ command: '{"command":"echo hi…' });
  });

  it("shows any other tool's input as indented, bounded text", () => {
    const request = toApprovalRequest(
      {
        requestId: 'p1',
        title: 'Write: docs/a.md',
        toolName: 'Write',
        inputPreview: JSON.stringify({ file_path: 'docs/a.md', content: 'x' }),
        options,
      },
      'claude-B',
      t,
    );
    expect(request.toolKind).toBeUndefined();
    expect(request.contentIsInput).toBe(true);
    expect(request.content).toEqual([
      {
        type: 'text',
        text: '{\n  "file_path": "docs/a.md",\n  "content": "x"\n}',
      },
    ]);
    expect(request.rawInput).toEqual({ description: 'docs/a.md' });

    const long = toApprovalRequest(
      {
        requestId: 'p2',
        title: 'mcp_tool',
        toolName: 'mcp_tool',
        inputPreview: 'y'.repeat(INPUT_PREVIEW_MAX_CHARS + 50),
        options,
      },
      'claude-B',
      t,
    );
    expect(long.content[0]?.text).toHaveLength(INPUT_PREVIEW_MAX_CHARS + 1);
    expect(long.content[0]?.text?.endsWith('…')).toBe(true);
  });
});

it('offers retry only on a finished run the daemon marked retryable', () => {
  expect(canRetryRun(run({ status: 'failed', retryable: true }))).toBe(true);
  expect(canRetryRun(run({ status: 'offline', retryable: true }))).toBe(true);
  // Finished before a restart, its record lost.
  expect(canRetryRun(run({ status: 'completed', retryable: true }))).toBe(true);
  expect(canRetryRun(run({ status: 'failed' }))).toBe(false);
  expect(canRetryRun(run({ status: 'offline' }))).toBe(false);
  expect(canRetryRun(run({ status: 'cancelled', retryable: true }))).toBe(
    false,
  );
  expect(canRetryRun(run({ status: 'running', retryable: true }))).toBe(false);
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
    expect(node.textContent).toContain(`${(1500).toLocaleString()} tokens`);
    // Tokens sit in the steps' muted block, as on the recorded reply, not
    // loose in the message at body size.
    const tokens = [...node.querySelectorAll('span')].find(
      (span) => span.textContent === `${(1500).toLocaleString()} tokens`,
    );
    expect(tokens?.parentElement?.querySelector('ol')).not.toBeNull();
    const stop = [...node.querySelectorAll('button')].find(
      (button) => button.textContent === 'Stop',
    );
    act(() => stop?.click());
    expect(onCancel).toHaveBeenCalledWith('r1');
  });

  it('shows an unfinished step of a stopped run as stopped, not running', () => {
    const { node } = render([
      run({
        status: 'cancelled',
        steps: [{ id: 's1', title: 'WriteFile: x.txt', status: 'running' }],
      }),
    ]);
    expect(node.querySelector('[aria-label="Stopped"]')).not.toBeNull();
    expect(node.querySelector('[aria-label="Running"]')).toBeNull();
    expect(node.querySelector('[data-running]')).toBeNull();
  });

  it('shows no Stop on a finished run', () => {
    const { node } = render([run({ status: 'completed', outputText: 'Done' })]);
    expect(
      [...node.querySelectorAll('button')].some(
        (button) => button.textContent === 'Stop',
      ),
    ).toBe(false);
  });

  it('says a finished run waits for the current reply until it is recorded', () => {
    const pending = render([
      run({ status: 'completed', outputText: 'Done', recorded: false }),
    ]);
    expect(
      pending.node.querySelector('[data-testid="agent-run-pending"]')
        ?.textContent,
    ).toBe(
      'This reply will appear in the chat when the current reply finishes.',
    );
    const others = render([
      run({ runId: 'live', status: 'running' }),
      // Retryable: no record is coming, Retry / Dismiss say what to do.
      run({
        runId: 'restarted',
        status: 'failed',
        recorded: false,
        retryable: true,
      }),
    ]);
    expect(
      others.node.querySelector('[data-testid="agent-run-pending"]'),
    ).toBeNull();
  });

  it('offers Retry and Dismiss on a retryable run, and only there', () => {
    const onRetry = vi.fn().mockResolvedValue(undefined);
    const { node } = render(
      [
        run({
          runId: 'r1',
          status: 'failed',
          recorded: false,
          retryable: true,
          error: 'daemon restarted',
        }),
        run({ runId: 'r2', status: 'failed', recorded: false }),
      ],
      { onRetry },
    );
    const retry = node.querySelectorAll('[data-testid="session-agent-retry"]');
    const dismiss = node.querySelectorAll(
      '[data-testid="session-agent-dismiss"]',
    );
    expect(retry).toHaveLength(1);
    expect(dismiss).toHaveLength(1);
    expect(
      retry[0]?.closest('[data-run-id]')?.getAttribute('data-run-id'),
    ).toBe('r1');
    expect(retry[0]?.textContent).toBe('Retry');
    expect(dismiss[0]?.textContent).toBe('Dismiss');
    act(() => (retry[0] as HTMLButtonElement).click());
    expect(onRetry).toHaveBeenCalledWith('r1');
  });

  it('offers Retry and Dismiss on a retryable offline run', () => {
    const onRetry = vi.fn().mockResolvedValue(undefined);
    const { node } = render(
      [
        run({
          status: 'offline',
          recorded: false,
          retryable: true,
          error: 'runtime went offline',
        }),
      ],
      { onRetry },
    );
    expect(node.textContent).toContain("reviewer's runtime is offline");
    expect(
      node.querySelector('[data-testid="session-agent-retry"]'),
    ).not.toBeNull();
    expect(
      node.querySelector('[data-testid="session-agent-dismiss"]'),
    ).not.toBeNull();
  });

  it('shows no reply text for output of only invisible characters', () => {
    const { node } = render([
      run({ status: 'running', outputText: '\u200B\u200B' }),
    ]);
    expect(node.textContent).not.toContain('\u200B');
    expect(node.textContent).toContain('reviewer');
  });

  it('dismisses a retryable run through the cancel route', async () => {
    const { node, onCancel } = render([
      run({ status: 'failed', recorded: false, retryable: true }),
    ]);
    // No retry handler: Dismiss alone.
    expect(
      node.querySelector('[data-testid="session-agent-retry"]'),
    ).toBeNull();
    await act(async () => {
      (
        node.querySelector(
          '[data-testid="session-agent-dismiss"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(onCancel).toHaveBeenCalledWith('r1');
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

describe('squad engagements', () => {
  const leader = run({
    runId: 'lead-1',
    status: 'queued',
    squadId: 'sq_1',
    squadName: 'crew',
    author: { agentId: 'ag_lead', name: 'lead', squadName: 'crew' },
  });
  const alice = run({
    runId: 'a-1',
    squadId: 'sq_1',
    squadName: 'crew',
    author: { agentId: 'ag_a', name: 'alice', color: '#0a0' },
  });
  const bob = run({
    runId: 'b-1',
    squadId: 'sq_1',
    author: { agentId: 'ag_b', name: 'bob' },
  });

  it('groups live runs by squad: the leader and its members', () => {
    expect(
      squadEngagements([
        alice,
        bob,
        leader,
        run({ runId: 'x', author: { agentId: 'x', name: 'solo' } }),
        run({ ...alice, runId: 'a-0', status: 'completed' }),
      ]),
    ).toEqual([
      {
        squadId: 'sq_1',
        squadName: 'crew',
        leader: 'lead',
        // alice is working again on a second ask.
        members: [
          { name: 'alice', state: 'working', color: '#0a0' },
          { name: 'bob', state: 'working' },
        ],
      },
    ]);
    // A member whose reply is being recorded has replied.
    expect(
      squadEngagements([
        leader,
        run({ ...alice, status: 'completed', recorded: false }),
      ]),
    ).toEqual([
      {
        squadId: 'sq_1',
        squadName: 'crew',
        leader: 'lead',
        members: [{ name: 'alice', state: 'replied', color: '#0a0' }],
      },
    ]);
    // A finished leader, or a member that did not complete, shows nothing.
    expect(
      squadEngagements([
        run({ ...leader, status: 'completed' }),
        run({ ...bob, status: 'failed', retryable: true, recorded: false }),
      ]),
    ).toEqual([]);
  });

  it('renders one bar per engagement above the runs: the squad tag, then each participant', () => {
    const node = document.createElement('div');
    const root = createRoot(node);
    act(() =>
      root.render(
        <I18nProvider language="en">
          <SessionAgentLiveRuns
            runs={[
              leader,
              alice,
              run({ ...bob, status: 'completed', recorded: false }),
            ]}
            onCancel={vi.fn()}
            onRespond={vi.fn()}
          />
        </I18nProvider>,
      ),
    );
    const bar = node.querySelector('[data-squad-id="sq_1"]');
    expect(bar?.getAttribute('role')).toBe('status');
    expect(bar?.getAttribute('aria-label')).toBe('Squad crew');
    // The squad's tag leads the bar; no middle dots.
    expect(bar?.firstElementChild?.getAttribute('data-squad-tag')).toBe('crew');
    expect(bar?.textContent).not.toContain('·');
    // Each participant: avatar initial, name, then its state: "deciding" for
    // the leader, a labelled spinner or check for a member.
    const entries = [...(bar?.querySelectorAll('[data-state]') ?? [])].map(
      (entry) => [
        entry.getAttribute('data-state'),
        entry.textContent,
        entry.querySelector('svg')?.getAttribute('aria-label') ?? null,
      ],
    );
    expect(entries).toEqual([
      ['deciding', 'Lleaddeciding', null],
      ['working', 'Aalice', 'working'],
      ['replied', 'Bbob', 'replied'],
    ]);
    // A member's avatar takes its agent's color, as on its replies.
    expect(
      bar?.querySelector('[data-state="working"] [data-tinted="true"]'),
    ).not.toBeNull();
    expect(
      bar?.querySelector('[data-state="replied"] [data-tinted]'),
    ).toBeNull();
    act(() =>
      root.render(
        <I18nProvider language="zh-CN">
          <SessionAgentLiveRuns
            runs={[leader]}
            onCancel={vi.fn()}
            onRespond={vi.fn()}
          />
        </I18nProvider>,
      ),
    );
    const zhBar = node.querySelector('[data-squad-id="sq_1"]');
    expect(zhBar?.textContent).toBe('crewLlead决定中');
    expect(zhBar?.querySelectorAll('[data-state]')).toHaveLength(1);
    act(() => root.unmount());
  });
});
