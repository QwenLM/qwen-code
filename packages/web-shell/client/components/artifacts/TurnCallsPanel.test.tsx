// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DaemonSessionTurnIndexEntry } from '@qwen-code/sdk/daemon';
import {
  createDaemonTranscriptState,
  normalizeDaemonEvent,
  reduceDaemonTranscriptEvents,
} from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';

const {
  transcript,
  connection,
  client,
  loadCalls,
  fileActions,
  navigation,
  prompt,
} = vi.hoisted(() => ({
  transcript: { blocks: [] as unknown[] },
  connection: {
    sessionId: undefined as string | undefined,
    workspaceCwd: '/workspace',
  },
  client: {
    getSessionTurnIndexPage: vi.fn(),
    getSessionTranscriptPage: vi.fn(),
    getSessionToolCalls: vi.fn(),
    workspaceByCwd: vi.fn(),
  },
  loadCalls: vi.fn(),
  fileActions: { stat: vi.fn() },
  prompt: { status: 'idle' },
  navigation: {
    indexPages: new Map<
      number,
      { snapshot?: string; turns: DaemonSessionTurnIndexEntry[] }
    >(),
    provisionalTurns: [] as Array<{
      promptId: string;
      provisionalId: string;
      blockId?: string;
      label: string;
    }>,
  },
}));

vi.mock('./loadTurnCalls', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./loadTurnCalls')>()),
  loadTurnCalls: loadCalls,
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useTranscriptBlocks: () => transcript.blocks,
  useWorkspace: () => ({ client, status: 'connected' }),
  useConnection: () => connection,
  usePromptStatus: () => prompt.status,
  useTurnNavigationState: () => navigation,
}));

vi.mock('./useArtifactWorkspaceTarget', () => ({
  useArtifactWorkspaceTarget: () => ({ actions: fileActions }),
}));

const { TurnCallsPanel, collectTurnCallRows } = await import(
  './TurnCallsPanel'
);

const { loadTurnCalls: realLoadTurnCalls } =
  await vi.importActual<typeof import('./loadTurnCalls')>('./loadTurnCalls');

beforeEach(() => {
  client.workspaceByCwd.mockReturnValue(client);
  prompt.status = 'idle';
  navigation.indexPages.clear();
  navigation.provisionalTurns = [];
  loadCalls.mockReset().mockImplementation(realLoadTurnCalls);
  client.getSessionToolCalls.mockReset();
  client.getSessionTurnIndexPage.mockReset().mockResolvedValue({
    snapshot: 'snapshot',
    start: 0,
    totalTurns: 0,
    turns: [],
  });
});

const base = {
  kind: 'tool',
  title: '',
  status: 'completed',
  preview: {},
  clientReceivedAt: 1000,
  createdAt: 1000,
  updatedAt: 1000,
};

function toolBlock(overrides: Record<string, unknown>) {
  return { ...base, ...overrides } as never;
}

function userBlock(id: string, eventId: number) {
  return {
    id,
    kind: 'user',
    text: 'prompt',
    eventId,
    clientReceivedAt: 0,
    createdAt: 0,
    updatedAt: 0,
  } as never;
}

function shellResult(output = '', overrides: Record<string, unknown> = {}) {
  return {
    type: 'shell_result',
    version: 1,
    text: 'Legacy envelope',
    output,
    directory: '/workspace',
    exitCode: 0,
    signal: null,
    pid: 42,
    error: null,
    outcome: 'completed',
    notices: [],
    truncated: false,
    outputFiles: [],
    ...overrides,
  };
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.useRealTimers();
  connection.sessionId = undefined;
  vi.clearAllMocks();
});

function render(ui: ReactNode, language: 'en' | 'zh-CN' = 'en') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<I18nProvider language={language}>{ui}</I18nProvider>);
  });
  return container;
}

it('finds a turn whose blocks carry no promptId at all', () => {
  // Regression: the transcript stamps `promptId` on the user block but not on
  // foreground tool blocks, so selecting a turn's calls by `promptId` finds
  // nothing. The turn is selected by its leading user block instead.
  const rows = collectTurnCallRows(
    [
      userBlock('u1', 1),
      toolBlock({ id: 'b1', toolCallId: 'c1', eventId: 2 }),
      toolBlock({ id: 'b2', toolCallId: 'c2', eventId: 3 }),
    ],
    'u1',
  );
  expect(rows.map((row) => row.block.toolCallId)).toEqual(['c1', 'c2']);
});

it('keeps only the requested turn and stops at the next user block', () => {
  const rows = collectTurnCallRows(
    [
      userBlock('u1', 1),
      toolBlock({ id: 'b1', toolCallId: 'c1', eventId: 2 }),
      userBlock('u2', 3),
      toolBlock({ id: 'b2', toolCallId: 'c2', eventId: 4 }),
    ],
    'u1',
  );
  expect(rows.map((row) => row.block.toolCallId)).toEqual(['c1']);
});

it('returns nothing when the turn is not in the loaded blocks', () => {
  expect(collectTurnCallRows([userBlock('u2', 1)], 'u1')).toEqual([]);
});

it('keeps retained calls by prompt identity after their user anchor is trimmed', async () => {
  connection.sessionId = 'session';
  prompt.status = 'streaming';
  const retained = toolBlock({
    id: 'retained',
    toolCallId: 'retained',
    promptId: 'prompt-1',
    status: 'in_progress',
    rawInput: { description: 'Retained running call' },
  });
  transcript.blocks = [
    toolBlock({
      id: 'other',
      toolCallId: 'other',
      promptId: 'other-prompt',
      rawInput: { description: 'Other prompt call' },
    }),
    retained,
  ];
  loadCalls.mockResolvedValue([]);
  const selected = {
    turnId: 'evicted',
    recordId: 'record-1',
    promptId: 'prompt-1',
  };
  await act(async () => {
    render(<TurnCallsPanel {...selected} />);
  });
  expect(container?.textContent).toContain('Retained running call');
  expect(container?.textContent).not.toContain('Other prompt call');
  expect(loadCalls).not.toHaveBeenCalled();
  transcript.blocks = [
    retained,
    toolBlock({
      id: 'new',
      toolCallId: 'new',
      promptId: 'prompt-1',
      status: 'in_progress',
      rawInput: { description: 'New running call' },
    }),
  ];
  await act(async () => {
    root?.render(
      <I18nProvider language="en">
        <TurnCallsPanel {...selected} />
      </I18nProvider>,
    );
  });
  expect(container?.querySelectorAll('li')).toHaveLength(2);
  expect(container?.textContent).toContain('New running call');
  expect(loadCalls).not.toHaveBeenCalled();
  prompt.status = 'idle';
  await act(async () => {
    root?.render(
      <I18nProvider language="en">
        <TurnCallsPanel {...selected} />
      </I18nProvider>,
    );
  });
  expect(loadCalls).toHaveBeenCalledTimes(1);
  expect(loadCalls).toHaveBeenCalledWith(expect.any(Function), 'record-1');
});

it('does not mistake a reused local user id for a trimmed durable selection', async () => {
  connection.sessionId = 'session';
  prompt.status = 'streaming';
  transcript.blocks = [
    Object.assign(userBlock('user-1', 1), {
      promptId: 'new-prompt',
      sourceRecordIds: ['new-record'],
    }),
    toolBlock({
      id: 'new',
      toolCallId: 'new',
      promptId: 'new-prompt',
      status: 'in_progress',
      rawInput: { description: 'Unrelated running call' },
    }),
  ];
  loadCalls.mockResolvedValue([]);
  await act(async () => {
    render(
      <TurnCallsPanel
        turnId="user-1"
        recordId="old-record"
        promptId="old-prompt"
      />,
    );
  });
  expect(loadCalls).toHaveBeenCalledWith(expect.any(Function), 'old-record');
  expect(container?.textContent).not.toContain('Unrelated running call');
});

it('skips a background task call that lands inside the turn span', () => {
  const rows = collectTurnCallRows(
    [
      userBlock('u1', 1),
      toolBlock({
        id: 'b1',
        toolCallId: 'bg',
        eventId: 2,
        backgroundTurn: { turnId: 'task' },
      }),
      toolBlock({ id: 'b2', toolCallId: 'c1', eventId: 3 }),
    ],
    'u1',
  );
  expect(rows.map((row) => row.block.toolCallId)).toEqual(['c1']);
});

it('nests a call under the parent that made it', () => {
  const rows = collectTurnCallRows(
    [
      userBlock('u1', 1),
      toolBlock({ id: 'b1', toolCallId: 'parent', eventId: 2 }),
      toolBlock({
        id: 'b2',
        toolCallId: 'child',
        eventId: 3,
        parentToolCallId: 'parent',
      }),
      toolBlock({
        id: 'b3',
        toolCallId: 'grandchild',
        eventId: 4,
        parentToolCallId: 'child',
      }),
    ],
    'u1',
  );
  expect(rows.map((row) => row.depth)).toEqual([0, 1, 2]);
});

it.each(['background_notification', 'mid_turn_message_injected'])(
  'does not split a turn at injected user messages: %s',
  (source) => {
    const rows = collectTurnCallRows(
      [
        userBlock('u1', 1),
        toolBlock({ id: 'a', toolCallId: 'a' }),
        {
          id: 'injected',
          kind: 'user',
          text: 'more instructions',
          clientReceivedAt: 0,
          createdAt: 0,
          updatedAt: 0,
          meta: { source },
        },
        toolBlock({ id: 'b', toolCallId: 'b' }),
        userBlock('u2', 3),
        toolBlock({ id: 'c', toolCallId: 'c' }),
      ],
      'u1',
    );
    expect(rows.map((row) => row.block.toolCallId)).toEqual(['a', 'b']);
  },
);

it('starts a separate turn for each visible cron prompt and ignores empty cron chunks', () => {
  const blocks = [
    userBlock('user', 1),
    toolBlock({ id: 'manual-call', toolCallId: 'manual-call' }),
    Object.assign(userBlock('cron-1', 2), {
      text: 'First scheduled prompt',
      meta: { source: 'cron' },
    }),
    toolBlock({ id: 'cron-call-1', toolCallId: 'cron-call-1' }),
    Object.assign(userBlock('empty-cron', 3), {
      text: '',
      meta: { source: 'cron' },
    }),
    toolBlock({ id: 'cron-call-2', toolCallId: 'cron-call-2' }),
    Object.assign(userBlock('cron-2', 4), {
      text: 'Second scheduled prompt',
      meta: { source: 'cron' },
    }),
    toolBlock({ id: 'cron-call-3', toolCallId: 'cron-call-3' }),
  ];
  expect(
    collectTurnCallRows(blocks, 'user').map((row) => row.block.toolCallId),
  ).toEqual(['manual-call']);
  expect(
    collectTurnCallRows(blocks, 'cron-1').map((row) => row.block.toolCallId),
  ).toEqual(['cron-call-1', 'cron-call-2']);
  expect(
    collectTurnCallRows(blocks, 'cron-2').map((row) => row.block.toolCallId),
  ).toEqual(['cron-call-3']);
});

it('keeps invocation order when a parent receives a later completion event', () => {
  const rows = collectTurnCallRows(
    [
      userBlock('u1', 1),
      toolBlock({ id: 'parent', toolCallId: 'parent', eventId: 9 }),
      toolBlock({
        id: 'child',
        toolCallId: 'child',
        parentToolCallId: 'parent',
        eventId: 3,
      }),
      toolBlock({ id: 'next', toolCallId: 'next', eventId: 4 }),
    ],
    'u1',
  );
  expect(rows.map(({ block, depth }) => [block.toolCallId, depth])).toEqual([
    ['parent', 0],
    ['child', 1],
    ['next', 0],
  ]);
});

it('treats a call whose parent is outside the turn as top level', () => {
  const rows = collectTurnCallRows(
    [
      userBlock('u1', 1),
      toolBlock({
        id: 'b1',
        toolCallId: 'c1',
        eventId: 2,
        parentToolCallId: 'not-in-this-turn',
      }),
    ],
    'u1',
  );
  expect(rows.map((row) => row.depth)).toEqual([0]);
});

it('shows the call object with the tool name as secondary, and expands details', () => {
  transcript.blocks = [
    userBlock('u1', 1),
    toolBlock({
      id: 'b1',
      toolCallId: 'c1',
      eventId: 2,
      toolName: 'read_file',
      title: '',
      status: 'failed',
      rawInput: { file_path: 'src/orders.ts' },
      rawOutput: 'ENOENT: no such file',
    }),
  ];
  const view = render(<TurnCallsPanel turnId="u1" />);
  const header = view.querySelector('li > button');
  expect(view.textContent).toContain('src/orders.ts');
  expect(header?.textContent).toContain('ReadFile');
  const toolIcon = header?.querySelector('svg[class*="chatSummaryToolIcon"]');
  expect(toolIcon?.parentElement?.nextElementSibling?.textContent).toBe(
    'ReadFile',
  );

  expect(view.textContent).not.toContain('ENOENT');
  act(() => {
    header?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  expect(view.textContent).toContain('ENOENT');
});

it('shows short and completed durations without inventing historical timing', () => {
  transcript.blocks = [
    userBlock('u1', 1),
    ...[1350, 2000, 6000].map((updatedAt, index) =>
      toolBlock({ id: `b${index}`, toolCallId: `c${index}`, updatedAt }),
    ),
    toolBlock({
      id: 'history',
      toolCallId: 'history',
      clientReceivedAt: 0,
      createdAt: 0,
      updatedAt: 0,
    }),
    toolBlock({ id: 'pending', toolCallId: 'pending', status: 'pending' }),
  ];
  const view = render(<TurnCallsPanel turnId="u1" />);
  const rows = view.querySelectorAll('li');
  expect(
    rows[0]?.querySelector('[aria-label="Elapsed: 350ms"]'),
  ).not.toBeNull();
  expect(rows[1]?.querySelector('[aria-label="Elapsed: 1s"]')).not.toBeNull();
  expect(rows[2]?.querySelector('[aria-label="Elapsed: 5s"]')).not.toBeNull();
  expect(rows[3]?.querySelector('[aria-label="Elapsed: —"]')).not.toBeNull();
  expect(rows[4]?.querySelector('[aria-label^="Elapsed:"]')).toBeNull();
});

it.each([
  ['completed', false, true],
  ['completed', true, false],
  ['completed', false, false],
  ['in_progress', true, true],
])(
  'keeps elapsed without a tooltip unless both recorded times are complete (%s, start=%s, duration=%s)',
  (status, hasStart, hasDuration) => {
    vi.useFakeTimers();
    const start = new Date(2026, 8, 21, 10, 30, 0).getTime();
    vi.setSystemTime(start + 2000);
    transcript.blocks = [
      userBlock('u1', 1),
      toolBlock({
        id: 'b1',
        toolCallId: 'c1',
        status,
        startedAt: hasStart ? start : undefined,
        durationMs: hasDuration ? 2000 : undefined,
        clientReceivedAt: start,
        updatedAt: start + 2000,
        rawInput: { description: 'Tool details' },
      }),
    ];
    const view = render(<TurnCallsPanel turnId="u1" />, 'zh-CN');
    const elapsed = view.querySelector('[aria-label^="耗时："]')!;
    expect(elapsed).not.toBeNull();
    expect(elapsed.hasAttribute('data-slot')).toBe(false);
    act(() => {
      elapsed.dispatchEvent(new Event('pointermove', { bubbles: true }));
      vi.advanceTimersByTime(300);
    });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(
      view.querySelector('li > button')?.hasAttribute('aria-description'),
    ).toBe(false);
  },
);

it.each([
  [4000, '10:30:04.000'],
  [255, '10:30:00.255'],
])(
  'uses recorded start plus measured duration for a %dms call, not replay receipt time',
  async (durationMs, end) => {
    vi.useFakeTimers();
    const startedAt = new Date(2026, 8, 21, 10, 30, 0).getTime();
    const receivedAt = new Date(2026, 8, 21, 16, 30, 10).getTime();
    vi.setSystemTime(receivedAt);
    connection.sessionId = 'session';
    transcript.blocks = [
      Object.assign(userBlock('u1', 1), { sourceRecordIds: ['record-1'] }),
      toolBlock({
        id: 'live',
        toolCallId: 'call',
        clientReceivedAt: receivedAt,
        updatedAt: receivedAt,
      }),
    ];
    client.getSessionTurnIndexPage.mockResolvedValue({ snapshot: 'snapshot' });
    loadCalls.mockResolvedValue([
      {
        depth: 0,
        block: toolBlock({
          id: 'saved',
          toolCallId: 'call',
          clientReceivedAt: 0,
          updatedAt: 0,
          rawOutput: 'Result',
        }),
        timing: { startedAt, durationMs },
        toolStatus: 'success',
      },
    ]);
    await act(async () => {
      render(<TurnCallsPanel turnId="u1" />, 'zh-CN');
    });
    act(() => {
      container
        ?.querySelector('[aria-label^="耗时："]')
        ?.dispatchEvent(new Event('pointermove', { bubbles: true }));
      vi.advanceTimersByTime(300);
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      `开始时间：10:30:00.000结束时间：${end}`,
    );
  },
);

it('updates running time and stops when the call completes', () => {
  vi.useFakeTimers();
  vi.setSystemTime(3000);
  const running = toolBlock({
    id: 'b1',
    toolCallId: 'c1',
    status: 'in_progress',
  });
  transcript.blocks = [userBlock('u1', 1), running];
  const view = render(<TurnCallsPanel turnId="u1" />);
  expect(view.querySelector('[aria-label="Elapsed: 2s"]')).not.toBeNull();
  expect(view.querySelector('.animate-spin')).not.toBeNull();
  act(() => {
    vi.advanceTimersByTime(2000);
  });
  expect(view.querySelector('[aria-label="Elapsed: 4s"]')).not.toBeNull();
  transcript.blocks = [
    userBlock('u1', 1),
    toolBlock({ id: 'b1', toolCallId: 'c1', updatedAt: 5000 }),
  ];
  act(() => {
    root?.render(
      <I18nProvider language="en">
        <TurnCallsPanel turnId="u1" />
      </I18nProvider>,
    );
  });
  act(() => {
    vi.advanceTimersByTime(3000);
  });
  expect(view.querySelector('[aria-label="Elapsed: 4s"]')).not.toBeNull();
  expect(view.textContent).not.toContain('Running');
  expect(view.querySelector('.animate-spin')).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])(
  'shows approved invocation details while running with preparation=%s',
  (preparing) => {
    connection.sessionId = 'session';
    prompt.status = 'streaming';
    const rawInput = {
      command: 'printf approved',
      description: 'Inspect approved command',
    };
    const toolCall = {
      toolCallId: 'approved-call',
      status: 'pending',
      rawInput,
      _meta: { toolName: 'run_shell_command' },
    };
    const state = reduceDaemonTranscriptEvents(createDaemonTranscriptState(), [
      { type: 'user.text.delta', text: 'Run command', promptId: 'p1' },
      ...(preparing
        ? normalizeDaemonEvent({
            v: 1,
            type: 'session_update',
            data: {
              ...toolCall,
              sessionUpdate: 'tool_call',
              rawInput: {},
            },
          })
        : []),
      ...normalizeDaemonEvent({
        v: 1,
        type: 'permission_request',
        data: { requestId: 'permission-1', toolCall, options: [] },
      }),
      ...normalizeDaemonEvent({
        v: 1,
        type: 'permission_resolved',
        data: {
          requestId: 'permission-1',
          outcome: { outcome: 'selected', optionId: 'proceed_once' },
        },
      }),
      ...normalizeDaemonEvent({
        v: 1,
        type: 'session_update',
        data: {
          ...toolCall,
          sessionUpdate: 'tool_call_update',
          status: 'in_progress',
          _meta: { toolName: 'run_shell_command', startedAt: Date.now() },
        },
      }),
    ]);
    transcript.blocks = [...state.blocks];
    const view = render(<TurnCallsPanel turnId={state.blocks[0]!.id} />);
    expect(view.querySelectorAll('li')).toHaveLength(1);
    expect(view.textContent).toContain(rawInput.description);
    expect(view.textContent).toContain('Running');
    act(() => view.querySelector<HTMLButtonElement>('li > button')!.click());
    expect(view.querySelector('pre')?.textContent).toBe(rawInput.command);
    expect(client.getSessionToolCalls).not.toHaveBeenCalled();
  },
);

it('localizes names and prioritizes invocation descriptions over commands and titles', () => {
  transcript.blocks = [
    userBlock('u1', 1),
    toolBlock({
      id: 'shell',
      toolCallId: 'shell',
      toolName: 'run_shell_command',
      title: 'Shell: npm run format',
      rawInput: {
        command: 'npm run format',
        description: 'Format the updated design docs',
      },
      rawOutput: 'formatted',
    }),
    toolBlock({
      id: 'read',
      toolCallId: 'read',
      toolName: 'read_file',
      title: 'ReadFile: src/orders.ts',
      rawInput: { file_path: 'src/orders.ts', description: '检查订单逻辑' },
    }),
    toolBlock({
      id: 'fallback',
      toolCallId: 'fallback',
      toolName: 'read_file',
      rawInput: { file_path: 'src/fallback.ts', description: '   ' },
    }),
  ];
  const view = render(<TurnCallsPanel turnId="u1" />, 'zh-CN');
  const buttons = view.querySelectorAll<HTMLButtonElement>('li > button');
  const rows = view.querySelectorAll('li');
  expect(rows[0]?.textContent).toContain('运行命令');
  expect(rows[0]?.textContent).toContain('Format the updated design docs');
  expect(rows[0]?.textContent).not.toContain('npm run format');
  expect(rows[1]?.textContent).toContain('读取文件');
  expect(rows[1]?.textContent).toContain('检查订单逻辑');
  expect(rows[1]?.textContent).not.toContain('src/orders.ts');
  expect(rows[2]?.textContent).toContain('src/fallback.ts');
  expect(view.textContent).not.toMatch(/run_shell_command|read_file|ReadFile/);
  act(() => {
    buttons[0]?.click();
  });
  expect(view.textContent).toContain('参数');
  expect(view.textContent).toContain('npm run format');
  expect(view.textContent).toContain('formatted');
});

it('filters by localized tool names and groups MCP calls under one option', async () => {
  transcript.blocks = [
    userBlock('u1', 1),
    ...[
      'read_file',
      'read_file',
      'run_shell_command',
      'mcp__docs__lookup',
      'mcp__yuque__whoami',
    ].map((toolName, index) =>
      toolBlock({
        id: `tool-${index}`,
        toolCallId: `call-${index}`,
        toolName,
        rawOutput: 'done',
      }),
    ),
  ];
  const view = render(<TurnCallsPanel turnId="u1" />, 'zh-CN');
  const trigger = view.querySelector<HTMLButtonElement>(
    '[role="combobox"][aria-label="按工具类型筛选"]',
  )!;
  expect(trigger.dataset.slot).toBe('select-trigger');
  expect(trigger.classList.contains('ml-auto')).toBe(true);
  expect(trigger.textContent).toBe('全部工具');
  expect(view.querySelectorAll('li')).toHaveLength(5);

  async function select(label: string) {
    await act(async () => trigger.click());
    const options = [
      ...document.body.querySelectorAll<HTMLElement>('[role="option"]'),
    ];
    expect(options.map((option) => option.textContent)).toEqual([
      '全部工具',
      '读取文件',
      '运行命令',
      'MCP',
    ]);
    const option = options.find((item) => item.textContent === label)!;
    await act(async () => option.click());
  }

  await select('读取文件');
  expect(view.querySelectorAll('li')).toHaveLength(2);
  expect(
    [...view.querySelectorAll('li')].every((row) =>
      row.textContent?.includes('读取文件'),
    ),
  ).toBe(true);
  await select('MCP');
  expect(view.querySelectorAll('li')).toHaveLength(2);
  expect(view.querySelectorAll('li [data-slot="badge"]')).toHaveLength(2);
  await select('全部工具');
  expect(view.querySelectorAll('li')).toHaveLength(5);
});

it('renders JSON arguments and results as Markdown code and keeps plain output unchanged', () => {
  transcript.blocks = [
    userBlock('u1', 1),
    toolBlock({
      id: 'json',
      toolCallId: 'json',
      toolName: 'mcp__docs__lookup',
      rawInput: { query: 'orders' },
      rawOutput: '{"ok":true,"items":[1,2]}',
    }),
    toolBlock({
      id: 'plain',
      toolCallId: 'plain',
      toolName: 'run_shell_command',
      rawInput: { command: 'echo hello' },
      rawOutput: shellResult('hello {invalid JSON}'),
    }),
  ];
  const view = render(<TurnCallsPanel turnId="u1" />);
  for (const button of view.querySelectorAll<HTMLButtonElement>('li > button'))
    act(() => button.click());
  const rows = view.querySelectorAll('li');
  expect(
    view.querySelector('[role="combobox"][aria-label="Filter by tool type"]')
      ?.textContent,
  ).toBe('All tools');
  const jsonBlocks = rows[0]!.querySelectorAll('pre code');
  expect(
    [...rows[0]!.querySelectorAll('[class*="codeBlockLang"]')].map(
      (label) => label.textContent,
    ),
  ).toEqual(['json', 'json']);
  expect(jsonBlocks).toHaveLength(2);
  expect(JSON.parse(jsonBlocks[0]!.textContent!)).toEqual({ query: 'orders' });
  expect(JSON.parse(jsonBlocks[1]!.textContent!)).toEqual({
    ok: true,
    items: [1, 2],
  });
  expect(rows[1]!.querySelector('[class*="codeBlockLang"]')).toBeNull();
  expect(
    [...rows[1]!.querySelectorAll('pre')]
      .filter((pre) => !pre.closest('details'))
      .map((pre) => pre.textContent),
  ).toEqual(['echo hello', 'hello {invalid JSON}']);
});

it('renders an empty state when the turn has no calls', () => {
  transcript.blocks = [userBlock('u1', 1)];
  const view = render(<TurnCallsPanel turnId="u1" />);
  expect(view.textContent).toContain('No tool call records for this turn');
});

it('keeps long JSON arguments and results in bounded Markdown code blocks', () => {
  const payload = { value: 'x'.repeat(5000) };
  transcript.blocks = [
    userBlock('u1', 1),
    toolBlock({
      id: 'json',
      toolCallId: 'json',
      toolName: 'mcp__docs__lookup',
      rawInput: payload,
      rawOutput: JSON.stringify(payload),
    }),
    toolBlock({
      id: 'shell',
      toolCallId: 'shell',
      toolName: 'run_shell_command',
      rawInput: { command: 'echo result' },
      rawOutput: shellResult(JSON.stringify(payload)),
    }),
  ];
  const view = render(<TurnCallsPanel turnId="u1" />);
  for (const button of view.querySelectorAll<HTMLButtonElement>('li > button'))
    act(() => button.click());
  const code = [...view.querySelectorAll('pre code')];
  expect(code).toHaveLength(3);
  for (const block of code) {
    expect(block.textContent).toContain('"value":');
    expect(block.textContent?.length).toBeLessThan(4100);
    expect(block.textContent).toContain('...');
  }
});

function mockLongPromptIndex() {
  const turns = Array.from({ length: 300 }, (_, index) => ({
    ordinal: index,
    turnId: `record-${index + 1}`,
    promptId: `prompt-${index + 1}`,
    kind: 'prompt' as const,
    label: `Prompt ${index + 1}`,
  }));
  client.getSessionTurnIndexPage.mockImplementation(
    async (_sessionId: string, options: { start?: number; limit: number }) => {
      const start = options.start ?? Math.max(0, turns.length - options.limit);
      return {
        snapshot: 'frozen-index',
        start,
        totalTurns: turns.length,
        turns: turns.slice(start, start + options.limit),
      };
    },
  );
}

it('loads early prompt options when the initial index response is the tail page', async () => {
  connection.sessionId = 'session';
  transcript.blocks = [];
  mockLongPromptIndex();
  loadCalls.mockResolvedValue([]);
  await act(async () => {
    render(<TurnCallsPanel turnId="record-300" recordId="record-300" />);
  });
  await act(async () => {
    container!
      .querySelector<HTMLButtonElement>('[aria-label="Prompt"]')!
      .click();
  });
  const options = [...document.body.querySelectorAll('[role="option"]')];
  expect(options).toHaveLength(300);
  expect(options[0]?.textContent).toBe('Prompt 1');
  expect(options.at(-1)?.textContent).toBe('Prompt 300');
  expect(client.getSessionTurnIndexPage).toHaveBeenCalledWith('session', {
    snapshot: 'frozen-index',
    start: 0,
    limit: 50,
  });
});

it('restores an early prompt identity beyond the initial tail index page', async () => {
  connection.sessionId = 'session';
  transcript.blocks = [];
  mockLongPromptIndex();
  loadCalls.mockResolvedValue([]);
  await act(async () => {
    render(<TurnCallsPanel turnId="old-projection" promptId="prompt-1" />);
  });
  expect(loadCalls).toHaveBeenCalledWith(expect.any(Function), 'record-1');
  expect(client.getSessionTurnIndexPage).toHaveBeenCalledWith('session', {
    snapshot: 'frozen-index',
    start: 0,
    limit: 50,
  });
});

it.each([
  [
    'lookup',
    { kind: 'mcp_invocation', serverId: 'docs', toolName: 'lookup' },
    true,
  ],
  ['mcp__docs__lookup', { kind: 'generic' }, true],
  ['read_file', { kind: 'generic' }, false],
])(
  'labels MCP calls before the status even when collapsed: %s',
  (toolName, preview, expected) => {
    transcript.blocks = [
      userBlock('u1', 1),
      toolBlock({
        id: 'tool',
        toolCallId: 'call',
        toolName,
        preview,
        rawOutput: 'result text',
      }),
    ];
    const view = render(<TurnCallsPanel turnId="u1" />, 'zh-CN');
    const badge = view.querySelector('[data-slot="badge"]');
    expect(Boolean(badge)).toBe(expected);
    if (expected) {
      expect(badge?.textContent).toBe('MCP');
      expect(badge?.classList.contains('font-normal')).toBe(true);
      expect(badge?.classList.contains('text-[11px]')).toBe(true);
      expect(badge?.parentElement?.textContent).toBe('MCP已完成');
    }
    act(() => view.querySelector('li > button')?.click());
    expect(view.querySelector('pre')?.textContent).toBe('result text');
  },
);

it('recognizes an MCP invocation inside tool_call', () => {
  transcript.blocks = [
    userBlock('u1', 1),
    toolBlock({
      id: 'b1',
      toolCallId: 'c1',
      toolName: 'tool_call',
      rawInput: { name: 'mcp__yuque__yuque_whoami', arguments: {} },
      rawOutput: 'result',
    }),
  ];
  const view = render(<TurnCallsPanel turnId="u1" />, 'zh-CN');
  expect(view.querySelector('[data-slot="badge"]')?.textContent).toBe('MCP');
  expect(view.querySelector('li > button')?.textContent).not.toContain(
    '工具调用',
  );
});

it('uses the server start for a running call after reconnect and keeps timing on completion', async () => {
  vi.useFakeTimers();
  const start = new Date(2026, 8, 21, 10, 30, 0).getTime();
  vi.setSystemTime(start + 4000);
  const user = Object.assign(userBlock('reloaded-user', 1), {
    promptId: 'prompt-1',
  });
  transcript.blocks = [
    user,
    toolBlock({
      id: 'b1',
      toolCallId: 'c1',
      status: 'in_progress',
      startedAt: start,
      clientReceivedAt: start + 4000,
      updatedAt: start + 4000,
    }),
  ];
  const view = render(
    <TurnCallsPanel turnId="old-user-id" promptId="prompt-1" />,
    'zh-CN',
  );
  expect(view.querySelector('[aria-label="耗时：4s"]')).not.toBeNull();
  act(() => {
    view
      .querySelector('[aria-label="耗时：4s"]')
      ?.dispatchEvent(new Event('pointermove', { bubbles: true }));
    vi.advanceTimersByTime(300);
  });
  expect(
    view.querySelector('[aria-label="耗时：4s"]')?.getAttribute('data-slot'),
  ).toBeNull();
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  act(() => {
    vi.advanceTimersByTime(1700);
  });
  expect(view.querySelector('[aria-label="耗时：6s"]')).not.toBeNull();
  transcript.blocks = [
    user,
    toolBlock({
      id: 'b1',
      toolCallId: 'c1',
      startedAt: start,
      durationMs: 4500,
      clientReceivedAt: start + 4000,
      updatedAt: start + 6000,
    }),
  ];
  await act(async () => {
    root?.render(
      <I18nProvider language="zh-CN">
        <TurnCallsPanel turnId="old-user-id" promptId="prompt-1" />
      </I18nProvider>,
    );
  });
  act(() => {
    view
      .querySelector('[aria-label^="耗时："]')
      ?.dispatchEvent(new Event('pointermove', { bubbles: true }));
    vi.advanceTimersByTime(300);
  });
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
    '开始时间：10:30:00.000结束时间：10:30:04.500',
  );
});

it('separates shell command, structured output and collapsed metadata', () => {
  const command = 'printf "hello\\n"\npwd';
  const output = '  hello\n/workspace\n';
  transcript.blocks = [
    userBlock('u1', 1),
    toolBlock({
      id: 'shell',
      toolCallId: 'shell',
      toolName: 'run_shell_command',
      rawInput: { command, description: 'Check workspace', timeout: 5000 },
      rawOutput: shellResult(output, {
        notices: ['cleanup notice'],
        outputFiles: ['output.log'],
      }),
    }),
  ];
  const view = render(<TurnCallsPanel turnId="u1" />, 'zh-CN');
  act(() => view.querySelector('li > button')?.click());
  const fields = view.querySelectorAll('pre');
  expect(fields[0]?.textContent).toBe(command);
  expect(fields[1]?.textContent).toBe(output);
  expect(view.textContent).not.toContain('Legacy envelope');
  const other = view.querySelector('details');
  expect(other?.open).toBe(false);
  expect(other?.querySelector('summary')?.textContent).toBe('其他');
  expect(other?.textContent).toContain('5000');
  expect(other?.textContent).toContain('cleanup notice');
  expect(other?.textContent).toContain('output.log');
  expect(other?.textContent).toContain('exitCode');
  expect(other?.textContent).not.toContain('printf');
});

it.each([
  [shellResult(''), 'No output'],
  [shellResult('', { error: 'spawn failed', outcome: 'failed' }), 'No output'],
  [
    shellResult('not a known output', { version: 2, text: 'Future fallback' }),
    'Future fallback',
  ],
  [
    'Command: echo old\nOutput: old\nExit Code: 0',
    'Command: echo old\nOutput: old\nExit Code: 0',
  ],
  ['', 'No output'],
])(
  'keeps empty and legacy shell outputs authoritative: %j',
  (rawOutput, expected) => {
    transcript.blocks = [
      userBlock('u1', 1),
      toolBlock({
        id: 'shell',
        toolCallId: 'shell',
        toolName: 'bash',
        rawInput: { command: 'echo old' },
        rawOutput,
        content: [
          {
            type: 'content',
            content: { type: 'text', text: 'Do not show this stale content' },
          },
        ],
      }),
    ];
    const view = render(<TurnCallsPanel turnId="u1" />);
    act(() => view.querySelector('li > button')?.click());
    expect(view.querySelectorAll('pre')[1]?.textContent).toBe(expected);
  },
);

it('keeps live shell output separate from progress metadata', () => {
  transcript.blocks = [
    userBlock('u1', 1),
    toolBlock({
      id: 'shell',
      toolCallId: 'shell',
      toolName: 'shell',
      status: 'in_progress',
      rawInput: { command: 'watch-task' },
      rawOutput: {
        ansiOutput: [[{ text: 'working', fg: '#00ff00' }]],
        totalLines: 1,
        totalBytes: 7,
        timeoutMs: 5000,
      },
    }),
  ];
  const view = render(<TurnCallsPanel turnId="u1" />);
  act(() => view.querySelector('li > button')?.click());
  expect(view.querySelectorAll('pre')[1]?.textContent).toBe('working');
  expect(view.querySelector('details')?.textContent).toContain('totalLines');
  expect(view.querySelector('details')?.textContent).not.toContain(
    'ansiOutput',
  );
});

it('opens read and write files independently of row expansion', async () => {
  const onOpenFile = vi.fn();
  fileActions.stat.mockResolvedValue({ type: 'file' });
  const filePath = `src/${'long-directory/'.repeat(20)}file.ts`;
  transcript.blocks = [
    userBlock('u1', 1),
    ...['read_file', 'write_file'].map((toolName) =>
      toolBlock({
        id: toolName,
        toolCallId: toolName,
        toolName,
        rawInput: { file_path: filePath },
      }),
    ),
  ];
  await act(async () => {
    render(
      <TurnCallsPanel
        turnId="u1"
        workspaceCwd="/workspace"
        onOpenFile={onOpenFile}
      />,
      'zh-CN',
    );
  });
  const buttons = [...(container?.querySelectorAll('button') ?? [])].filter(
    (button) => button.getAttribute('aria-label') === '查看文件',
  );
  expect(buttons).toHaveLength(2);
  for (const button of buttons) {
    expect(button.textContent).toBe('');
    expect(button.querySelector('svg')).not.toBeNull();
    expect(button.parentElement?.closest('button')).toBeNull();
    await act(async () => button.click());
  }
  expect(onOpenFile).toHaveBeenCalledTimes(2);
  expect(onOpenFile).toHaveBeenLastCalledWith(
    expect.objectContaining({
      kind: 'attachment',
      workspaceCwd: '/workspace',
      workspacePath: filePath,
    }),
  );
  expect(container?.querySelector('[aria-expanded="true"]')).toBeNull();
});

it('opens agent details with the owning session and full tool result', () => {
  connection.sessionId = 'owner-session';
  const onOpenAgent = vi.fn();
  const rawOutput = { type: 'task_execution', executionId: 'agent-execution' };
  transcript.blocks = [
    userBlock('u1', 1),
    toolBlock({
      id: 'agent',
      toolCallId: 'agent-call',
      toolName: 'agent',
      subagentSessionReady: true,
      rawInput: { subagent_type: 'test-engineer', description: 'Verify UI' },
      rawOutput,
    }),
  ];
  const view = render(
    <TurnCallsPanel
      turnId="u1"
      workspaceCwd="/workspace"
      onOpenAgent={onOpenAgent}
    />,
  );
  act(() => view.querySelector('li > button')?.click());
  expect(onOpenAgent).toHaveBeenCalledWith(
    expect.objectContaining({
      callId: 'agent-call',
      rawOutput,
      subagentSessionReady: true,
    }),
    'owner-session',
    '/workspace',
  );
  expect(view.querySelector('li [aria-expanded]')).toBeNull();
});

it('renders edit and newly created file results with the message diff view', () => {
  transcript.blocks = [
    userBlock('u1', 1),
    toolBlock({
      id: 'edit',
      toolCallId: 'edit',
      toolName: 'edit',
      rawInput: { file_path: 'edited.ts' },
      rawOutput: { fileDiff: '@@ -1 +1 @@\n-old value\n+updated value' },
    }),
    toolBlock({
      id: 'write',
      toolCallId: 'write',
      toolName: 'write_file',
      rawInput: { file_path: 'new.ts' },
      content: [{ type: 'diff', path: 'new.ts', newText: 'new file content' }],
    }),
  ];
  const view = render(<TurnCallsPanel turnId="u1" />, 'zh-CN');
  expect(view.textContent).toContain('编辑文件');
  for (const button of view.querySelectorAll<HTMLButtonElement>('li > button'))
    act(() => button.click());
  expect(view.textContent).toContain('old value');
  expect(view.textContent).toContain('updated value');
  expect(view.textContent).toContain('new file content');
  expect(view.textContent).not.toContain('fileDiff');
  expect(view.querySelectorAll('[class*="codeBlockLang"]')).toHaveLength(2);
  expect(view.querySelectorAll('[class*="lineAdd"]')).toHaveLength(2);
  expect(
    view.querySelector('li')?.querySelectorAll('[class*="lineDel"]'),
  ).toHaveLength(1);
});

it('loads historical calls by record identity with recorded timing and cancellation', async () => {
  connection.sessionId = 'session';
  transcript.blocks = [userBlock('unrelated-live-user', 1)];
  client.getSessionTurnIndexPage.mockResolvedValue({ snapshot: 'snapshot' });
  loadCalls.mockResolvedValue([
    {
      kind: 'tool',
      key: 'tool:old',
      turnIndex: 1,
      depth: 0,
      block: toolBlock({
        id: 'old',
        toolCallId: 'old',
        toolName: 'run_shell_command',
        status: 'failed',
        clientReceivedAt: 0,
        updatedAt: 0,
        rawInput: { description: 'Historical call' },
        rawOutput: 'stopped',
      }),
      timing: { durationMs: 219 },
      toolStatus: 'cancelled',
    },
  ]);
  await act(async () => {
    render(
      <TurnCallsPanel turnId="history-page-1:user-1" recordId="durable-user" />,
    );
  });
  expect(loadCalls).toHaveBeenCalledWith(expect.any(Function), 'durable-user');
  expect(container?.textContent).toContain('Historical call');
  expect(container?.textContent).toContain('219ms');
  expect(container?.textContent).toContain('Cancelled');
  const cancelled = container?.querySelector(
    '.lucide-circle-slash',
  )?.parentElement;
  expect(cancelled?.textContent).toBe('Cancelled');
  expect(cancelled?.classList.contains('text-[var(--warning-color)]')).toBe(
    true,
  );
  expect(container?.querySelector('[aria-label="Failed"]')).toBeNull();
});

it('resolves a restored prompt identity through the turn index when its live block is absent', async () => {
  connection.sessionId = 'session';
  transcript.blocks = [userBlock('unrelated', 1)];
  client.getSessionTurnIndexPage.mockResolvedValue({
    snapshot: 'snapshot',
    start: 0,
    totalTurns: 1,
    turns: [{ promptId: 'prompt-1', turnId: 'record-1' }],
  });
  loadCalls.mockResolvedValue([
    {
      depth: 0,
      block: toolBlock({
        id: 'old-tool',
        toolCallId: 'old-tool',
        rawInput: { description: 'Restored selected prompt' },
      }),
      timing: { durationMs: 515 },
    },
  ]);
  await act(async () => {
    render(<TurnCallsPanel turnId="old-projection" promptId="prompt-1" />);
  });
  expect(loadCalls).toHaveBeenCalledWith(expect.any(Function), 'record-1');
  expect(container?.textContent).toContain('Restored selected prompt');
});

it('discards a historical load after switching to another turn', async () => {
  connection.sessionId = 'session';
  transcript.blocks = [];
  client.getSessionTurnIndexPage.mockResolvedValue({ snapshot: 'snapshot' });
  let finishOld: (rows: unknown[]) => void = () => {};
  loadCalls
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    )
    .mockResolvedValueOnce([]);
  await act(async () => {
    render(<TurnCallsPanel turnId="old" recordId="old-record" />);
  });
  await act(async () => {
    root?.render(
      <I18nProvider language="en">
        <TurnCallsPanel turnId="new" recordId="new-record" />
      </I18nProvider>,
    );
  });
  await act(async () => {
    finishOld([
      {
        kind: 'tool',
        key: 'old-call',
        depth: 0,
        turnIndex: 1,
        block: toolBlock({
          id: 'old-call',
          toolCallId: 'old-call',
          rawInput: { description: 'Wrong turn' },
        }),
      },
    ]);
  });
  expect(container?.textContent).not.toContain('Wrong turn');
  expect(container?.textContent).toContain('No tool call records');
});

it('preserves full recorded results and the selected turn after live history is trimmed', async () => {
  connection.sessionId = 'session';
  transcript.blocks = [
    Object.assign(userBlock('u1', 1), { sourceRecordIds: ['record-1'] }),
    toolBlock({
      id: 'live',
      toolCallId: 'call',
      updatedAt: 1250,
      rawOutput: 'Compact preview',
    }),
  ];
  client.getSessionTurnIndexPage.mockResolvedValue({ snapshot: 'snapshot' });
  loadCalls.mockResolvedValue([
    {
      depth: 0,
      block: toolBlock({
        id: 'saved',
        toolCallId: 'call',
        rawOutput: 'Full recorded output',
      }),
      timing: { durationMs: 250 },
      toolStatus: 'success',
    },
  ]);
  await act(async () => {
    render(<TurnCallsPanel turnId="u1" />);
  });
  act(() => container?.querySelector('li > button')?.click());
  expect(container?.textContent).toContain('Full recorded output');
  expect(container?.textContent).not.toContain('Compact preview');
  expect(
    container?.querySelector('li > button')?.getAttribute('aria-description'),
  ).toBeNull();
  transcript.blocks = [userBlock('later-turn', 10)];
  await act(async () => {
    root?.render(
      <I18nProvider language="en">
        <TurnCallsPanel turnId="u1" />
      </I18nProvider>,
    );
  });
  expect(container?.textContent).toContain('Full recorded output');
  expect(container?.textContent).toContain('250ms');
  expect(loadCalls).toHaveBeenCalledTimes(1);
});

function recordedCalls(recordId: string, description: string) {
  return {
    v: 1 as const,
    sessionId: 'session',
    turnId: recordId,
    events: [
      {
        v: 1 as const,
        type: 'session_update' as const,
        data: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'Recorded prompt' },
          _meta: { qwenTranscript: { sourceRecordIds: [recordId] } },
        },
      },
      {
        v: 1 as const,
        type: 'session_update' as const,
        data: {
          sessionUpdate: 'tool_call',
          toolCallId: `${recordId}-call`,
          status: 'completed',
          rawInput: { description },
          _meta: { toolName: 'read_file', startedAt: 1000, durationMs: 500 },
        },
      },
    ],
  };
}

it('uses live blocks without history requests and reads once on settlement without flashing empty', async () => {
  connection.sessionId = 'session';
  prompt.status = 'waiting';
  const user = Object.assign(userBlock('live', 1), {
    sourceRecordIds: ['record-live'],
    promptId: 'prompt-live',
  });
  transcript.blocks = [
    user,
    toolBlock({
      id: 'live-call',
      toolCallId: 'record-live-call',
      rawInput: { description: 'Live description' },
      status: 'in_progress',
    }),
  ];
  const panel = () => (
    <TurnCallsPanel
      turnId="live"
      recordId="record-live"
      promptId="prompt-live"
    />
  );
  const view = render(panel());
  expect(view.textContent).toContain('Live description');
  for (const status of ['streaming', 'waiting', 'streaming']) {
    prompt.status = status;
    transcript.blocks = [...transcript.blocks];
    await act(async () =>
      root?.render(<I18nProvider language="en">{panel()}</I18nProvider>),
    );
  }
  expect(client.getSessionToolCalls).not.toHaveBeenCalled();
  expect(client.getSessionTurnIndexPage).not.toHaveBeenCalled();
  expect(client.getSessionTranscriptPage).not.toHaveBeenCalled();
  const refresh = [...view.querySelectorAll('button')].find(
    (button) => button.textContent === 'Refresh',
  )!;
  await act(async () => refresh.click());
  expect(client.getSessionToolCalls).not.toHaveBeenCalled();
  expect(client.getSessionTranscriptPage).not.toHaveBeenCalled();
  expect(client.getSessionTurnIndexPage).toHaveBeenCalledTimes(1);
  expect(view.textContent).toContain('Live description');

  let finish!: (result: ReturnType<typeof recordedCalls>) => void;
  client.getSessionToolCalls.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  prompt.status = 'idle';
  await act(async () =>
    root?.render(<I18nProvider language="en">{panel()}</I18nProvider>),
  );
  expect(client.getSessionToolCalls.mock.calls).toEqual([
    ['session', 'record-live'],
  ]);
  expect(view.textContent).toContain('Live description');
  expect(view.querySelector('[data-web-shell-turn-calls-empty]')).toBeNull();
  await act(async () =>
    finish(recordedCalls('record-live', 'Recorded full description')),
  );
  expect(view.textContent).toContain('Recorded full description');
  expect(view.textContent).not.toContain('Live description');
  transcript.blocks = [...transcript.blocks];
  await act(async () =>
    root?.render(<I18nProvider language="en">{panel()}</I18nProvider>),
  );
  expect(client.getSessionToolCalls).toHaveBeenCalledTimes(1);
  expect(client.getSessionTranscriptPage).not.toHaveBeenCalled();
});

it('puts prompt selection before the count without All and loads only the selected historical turn', async () => {
  connection.sessionId = 'session';
  prompt.status = 'streaming';
  transcript.blocks = [
    Object.assign(userBlock('live', 1), { promptId: 'prompt-live' }),
  ];
  const turns: DaemonSessionTurnIndexEntry[] = [
    {
      turnId: 'record-2',
      promptId: 'prompt-2',
      ordinal: 2,
      kind: 'prompt',
      label: 'Second prompt',
    },
    {
      turnId: 'record-1',
      promptId: 'prompt-1',
      ordinal: 1,
      kind: 'prompt',
      label: 'First prompt',
    },
  ];
  navigation.indexPages.set(0, { turns });
  navigation.provisionalTurns = [
    {
      promptId: 'prompt-live',
      provisionalId: 'pending',
      blockId: 'live',
      label: 'Running prompt',
    },
  ];
  client.getSessionTurnIndexPage.mockResolvedValue({
    snapshot: 'snapshot',
    start: 0,
    totalTurns: 2,
    turns,
  });
  client.getSessionToolCalls.mockImplementation(
    (_sessionId: string, turnId: string) =>
      Promise.resolve(recordedCalls(turnId, `Calls for ${turnId}`)),
  );
  const onSelect = vi.fn(
    (
      turnId: string,
      recordId?: string,
      promptId?: string,
      promptLabel?: string,
    ) => {
      root?.render(
        <I18nProvider language="en">
          <TurnCallsPanel
            turnId={turnId}
            recordId={recordId}
            promptId={promptId}
            promptLabel={promptLabel}
            onSelectPrompt={onSelect}
          />
        </I18nProvider>,
      );
    },
  );
  await act(async () =>
    render(
      <TurnCallsPanel
        turnId="record-1"
        recordId="record-1"
        promptId="prompt-1"
        onSelectPrompt={onSelect}
      />,
    ),
  );
  const trigger = container!.querySelector<HTMLButtonElement>(
    '[aria-label="Prompt"]',
  )!;
  expect(trigger.textContent).toBe('First prompt');
  expect(container!.querySelectorAll('[role="combobox"]')[0]).toBe(trigger);
  expect(trigger.classList.contains('flex-1')).toBe(false);
  expect(trigger.classList.contains('max-w-64')).toBe(true);
  const promptRow = trigger.parentElement!;
  expect(promptRow.textContent).toBe('First promptRefresh');
  expect(promptRow.nextElementSibling?.textContent).toBe(
    '1 tool callsAll tools',
  );
  expect(
    promptRow
      .querySelector('.lucide-refresh-cw')
      ?.closest('button')
      ?.classList.contains('ml-auto'),
  ).toBe(true);
  expect(client.getSessionToolCalls.mock.calls).toEqual([
    ['session', 'record-1'],
  ]);
  await act(async () => trigger.click());
  const options = [
    ...document.body.querySelectorAll<HTMLElement>('[role="option"]'),
  ];
  expect(options.map((option) => option.textContent)).toEqual([
    'First prompt',
    'Second prompt',
    'Running prompt',
  ]);
  await act(async () => options[1]!.click());
  expect(onSelect).toHaveBeenCalledWith(
    'record-2',
    'record-2',
    'prompt-2',
    'Second prompt',
  );
  expect(client.getSessionToolCalls.mock.calls).toEqual([
    ['session', 'record-1'],
    ['session', 'record-2'],
  ]);
  expect(container!.textContent).toContain('Calls for record-2');
  expect(container!.textContent).not.toContain('Calls for record-1');
  await act(async () => trigger.click());
  const runningOption = [
    ...document.body.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((option) => option.textContent === 'Running prompt')!;
  await act(async () => runningOption.click());
  expect(onSelect).toHaveBeenLastCalledWith(
    'live',
    undefined,
    'prompt-live',
    'Running prompt',
  );
  expect(client.getSessionToolCalls).toHaveBeenCalledTimes(2);
  expect(client.getSessionTranscriptPage).not.toHaveBeenCalled();
});

it('keeps a provisional running prompt selectable before its user block or record arrives', async () => {
  connection.sessionId = 'session';
  prompt.status = 'waiting';
  transcript.blocks = [];
  navigation.provisionalTurns = [
    {
      promptId: 'pending-prompt',
      provisionalId: 'pending',
      label: 'Pending prompt',
    },
  ];
  const view = render(
    <TurnCallsPanel turnId="pending" promptId="pending-prompt" />,
  );
  expect(view.querySelector('[aria-label="Prompt"]')?.textContent).toBe(
    'Pending prompt',
  );
  expect(client.getSessionToolCalls).not.toHaveBeenCalled();
  expect(client.getSessionTurnIndexPage).not.toHaveBeenCalled();
});

it('discards a history response that arrives after the session changes', async () => {
  connection.sessionId = 'session';
  transcript.blocks = [];
  let finish!: (result: ReturnType<typeof recordedCalls>) => void;
  client.getSessionToolCalls.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () =>
    render(<TurnCallsPanel turnId="old" recordId="record-old" />),
  );
  connection.sessionId = 'another-session';
  client.getSessionToolCalls.mockResolvedValue(
    recordedCalls('record-new', 'New session calls'),
  );
  await act(async () =>
    root?.render(
      <I18nProvider language="en">
        <TurnCallsPanel turnId="new" recordId="record-new" />
      </I18nProvider>,
    ),
  );
  await act(async () =>
    finish(recordedCalls('record-old', 'Old session calls')),
  );
  expect(container?.textContent).toContain('New session calls');
  expect(container?.textContent).not.toContain('Old session calls');
});

it('refreshes historical calls and prompt labels once while retaining the selected prompt', async () => {
  connection.sessionId = 'session';
  transcript.blocks = [];
  client.getSessionToolCalls
    .mockResolvedValueOnce(recordedCalls('record-1', 'Initial calls'))
    .mockResolvedValueOnce(recordedCalls('record-1', 'Refreshed calls'));
  client.getSessionTurnIndexPage.mockResolvedValue({
    snapshot: 'snapshot',
    start: 0,
    totalTurns: 1,
    turns: [
      {
        turnId: 'record-1',
        promptId: 'prompt-1',
        ordinal: 1,
        kind: 'prompt',
        label: 'Updated prompt label',
      },
    ],
  });
  const cachedTurn: DaemonSessionTurnIndexEntry = {
    turnId: 'record-1',
    promptId: 'prompt-1',
    ordinal: 1,
    kind: 'prompt',
    label: 'Selected prompt',
  };
  navigation.indexPages.set(0, {
    snapshot: 'older-snapshot',
    turns: [cachedTurn],
  });
  await act(async () =>
    render(
      <TurnCallsPanel
        turnId="record-1"
        recordId="record-1"
        promptId="prompt-1"
        promptLabel="Selected prompt"
      />,
      'zh-CN',
    ),
  );
  expect(container?.textContent).toContain('共 1 次工具调用');
  expect(container?.textContent).toContain('Initial calls');
  expect(client.getSessionToolCalls).toHaveBeenCalledTimes(1);
  expect(client.getSessionTurnIndexPage).not.toHaveBeenCalled();
  const refresh = [...container!.querySelectorAll('button')].find(
    (button) => button.textContent === '刷新',
  )!;
  expect(refresh.querySelector('.lucide-refresh-cw')).not.toBeNull();
  await act(async () => refresh.click());
  expect(client.getSessionToolCalls.mock.calls).toEqual([
    ['session', 'record-1'],
    ['session', 'record-1'],
  ]);
  expect(client.getSessionTurnIndexPage).toHaveBeenCalledTimes(1);
  expect(client.getSessionTranscriptPage).not.toHaveBeenCalled();
  expect(container?.textContent).toContain('Refreshed calls');
  expect(container?.textContent).not.toContain('Initial calls');
  expect(container?.querySelector('[aria-label="提示词"]')?.textContent).toBe(
    'Updated prompt label',
  );
  navigation.indexPages.set(0, {
    snapshot: 'newer-snapshot',
    turns: [{ ...cachedTurn, label: 'New navigation label' }],
  });
  await act(async () =>
    root?.render(
      <I18nProvider language="zh-CN">
        <TurnCallsPanel
          turnId="record-1"
          recordId="record-1"
          promptId="prompt-1"
        />
      </I18nProvider>,
    ),
  );
  expect(container?.querySelector('[aria-label="提示词"]')?.textContent).toBe(
    'New navigation label',
  );
  expect(client.getSessionTurnIndexPage).toHaveBeenCalledTimes(1);
});

it('uses live calls for the selected active cron prompt without reading history', async () => {
  connection.sessionId = 'session';
  prompt.status = 'streaming';
  transcript.blocks = [
    userBlock('manual', 1),
    toolBlock({
      id: 'old-call',
      toolCallId: 'old-call',
      rawInput: { description: 'Earlier manual call' },
    }),
    Object.assign(userBlock('cron-live', 2), {
      text: 'Scheduled check',
      meta: { source: 'cron' },
      promptId: 'cron-prompt',
      sourceRecordIds: ['cron-record'],
    }),
    toolBlock({
      id: 'cron-call',
      toolCallId: 'cron-call',
      status: 'in_progress',
      rawInput: { description: 'Current scheduled call' },
    }),
    Object.assign(userBlock('empty-cron', 3), {
      text: '',
      meta: { source: 'cron' },
    }),
  ];
  await act(async () =>
    render(
      <TurnCallsPanel
        turnId="cron-live"
        recordId="cron-record"
        promptId="cron-prompt"
      />,
    ),
  );
  expect(container?.textContent).toContain('Current scheduled call');
  expect(container?.textContent).not.toContain('Earlier manual call');
  expect(client.getSessionToolCalls).not.toHaveBeenCalled();
  expect(client.getSessionTranscriptPage).not.toHaveBeenCalled();
  expect(client.getSessionTurnIndexPage).not.toHaveBeenCalled();
});

it('defers serialization until expansion and displays recorded zero duration', () => {
  const toJSON = vi.fn(() => ({ answer: 42 }));
  transcript.blocks = [
    userBlock('u1', 1),
    toolBlock({
      id: 'b1',
      toolCallId: 'c1',
      toolName: 'read_file',
      rawInput: { file_path: '/workspace/src/a.ts' },
      rawOutput: { toJSON },
      durationMs: 0,
      startedAt: 1000,
    }),
  ];
  const view = render(<TurnCallsPanel turnId="u1" />);
  expect(toJSON).not.toHaveBeenCalled();
  expect(view.textContent).toContain('0ms');
  expect(view.textContent).toContain('src/a.ts');
  expect(view.textContent).not.toContain('/workspace/src/a.ts');
  act(() => view.querySelector<HTMLButtonElement>('li > button')!.click());
  expect(toJSON).toHaveBeenCalled();
});

it('shows unresolved prompt and closed-selector refresh failures as alerts', async () => {
  connection.sessionId = 'session';
  transcript.blocks = [];
  await act(async () =>
    render(<TurnCallsPanel turnId="missing" promptId="missing" />),
  );
  expect(container?.querySelector('[role="alert"]')?.textContent).toContain(
    'Could not locate',
  );
  expect(container?.textContent).not.toContain('No tool call records');
  client.getSessionTurnIndexPage.mockRejectedValue(new Error('unavailable'));
  const refresh = [...container!.querySelectorAll('button')].find(
    (b) => b.textContent === 'Refresh',
  )!;
  await act(async () => refresh.click());
  expect(container?.querySelector('[role="alert"]')?.textContent).toContain(
    'Could not refresh the prompt list',
  );
  expect(document.querySelector('[role="listbox"]')).toBeNull();
});

it('merges admitted and indexed prompt identities and reuses the successful index', async () => {
  connection.sessionId = 'session';
  prompt.status = 'streaming';
  transcript.blocks = [Object.assign(userBlock('u1', 1), { promptId: 'p1' })];
  navigation.provisionalTurns = [
    {
      promptId: 'p1',
      provisionalId: 'live:p1',
      blockId: 'u1',
      label: 'Same prompt',
    },
  ];
  navigation.indexPages.set(0, {
    snapshot: 'before-completion',
    turns: [{ ordinal: 0, turnId: 'r1', kind: 'prompt', label: 'Same prompt' }],
  });
  client.getSessionTurnIndexPage.mockResolvedValue({
    snapshot: 's',
    start: 0,
    totalTurns: 1,
    turns: [
      {
        ordinal: 0,
        turnId: 'r1',
        promptId: 'p1',
        kind: 'prompt',
        label: 'Same prompt',
      },
    ],
  });
  const view = render(<TurnCallsPanel turnId="u1" promptId="p1" />);
  const trigger = view.querySelector<HTMLButtonElement>(
    '[aria-label="Prompt"]',
  )!;
  await act(async () => trigger.click());
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
  await act(async () =>
    document.querySelector<HTMLElement>('[role="option"]')!.click(),
  );
  await act(async () => trigger.click());
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
  expect(client.getSessionTurnIndexPage).toHaveBeenCalledTimes(1);
});

it('preserves expanded state when a call settles into a different projection block', async () => {
  connection.sessionId = 'session';
  prompt.status = 'streaming';
  transcript.blocks = [
    Object.assign(userBlock('u1', 1), {
      sourceRecordIds: ['r1'],
      promptId: 'p1',
    }),
    toolBlock({
      id: 'live-block',
      toolCallId: 'r1-call',
      rawInput: { description: 'Live' },
    }),
  ];
  const panel = () => (
    <TurnCallsPanel turnId="u1" recordId="r1" promptId="p1" />
  );
  const view = render(panel());
  act(() => view.querySelector<HTMLButtonElement>('li > button')!.click());
  client.getSessionToolCalls.mockResolvedValue(recordedCalls('r1', 'Saved'));
  prompt.status = 'idle';
  await act(async () =>
    root?.render(<I18nProvider language="en">{panel()}</I18nProvider>),
  );
  expect(view.textContent).toContain('Saved');
  expect(view.querySelector('li > button')?.getAttribute('aria-expanded')).toBe(
    'true',
  );
});

it('resets a vanished filter and does not restore it when that tool returns', async () => {
  const read = toolBlock({
    id: 'read',
    toolCallId: 'read',
    toolName: 'read_file',
    status: 'failed',
    rawOutput: 'failed',
  });
  const shell = toolBlock({
    id: 'shell',
    toolCallId: 'shell',
    toolName: 'run_shell_command',
  });
  const user = userBlock('u1', 1);
  transcript.blocks = [user, read, shell];
  const view = render(<TurnCallsPanel turnId="u1" />, 'zh-CN');
  expect(view.querySelector('li [role="img"]')).toBeNull();
  const trigger = view.querySelector<HTMLButtonElement>(
    '[aria-label="按工具类型筛选"]',
  )!;
  await act(async () => trigger.click());
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((el) => el.textContent === '读取文件')!
      .click(),
  );
  expect(view.querySelectorAll('li')).toHaveLength(1);
  transcript.blocks = [user, shell];
  await act(async () =>
    root?.render(
      <I18nProvider language="zh-CN">
        <TurnCallsPanel turnId="u1" />
      </I18nProvider>,
    ),
  );
  expect(trigger.textContent).toBe('全部工具');
  transcript.blocks = [user, read, shell];
  await act(async () =>
    root?.render(
      <I18nProvider language="zh-CN">
        <TurnCallsPanel turnId="u1" />
      </I18nProvider>,
    ),
  );
  expect(view.querySelectorAll('li')).toHaveLength(2);
  expect(trigger.textContent).toBe('全部工具');
});
