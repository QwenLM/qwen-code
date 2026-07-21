// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

if (!document.execCommand) {
  document.execCommand = () => true;
}

interface MockTask {
  id: string;
  name: string | null;
  cron: string;
  prompt: string;
  recurring: boolean;
  enabled: boolean;
  createdAt: number;
  lastFiredAt: number | null;
  nextRunAt: number | null;
  sessionId: string | null;
  runs: Array<{
    at: number;
    kind?: 'scheduled' | 'catch-up';
    sessionId?: string;
  }>;
}

const { actions } = vi.hoisted(() => ({
  actions: {
    listScheduledTasks: vi.fn(),
    createScheduledTask: vi.fn(),
    updateScheduledTask: vi.fn(),
    runScheduledTask: vi.fn(),
    deleteScheduledTask: vi.fn(),
    loadExtensionsStatus: vi.fn(),
    loadSkillsStatus: vi.fn(),
    loadMcpStatus: vi.fn(),
  },
}));

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useWorkspaceActions: () => actions,
}));

const { ScheduledTasksDialog } = await import('./ScheduledTasksDialog');
const { I18nProvider } = await import('../../i18n');

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(
  tasks: MockTask[],
  opts: {
    onOpenSession?: (sessionId: string) => void;
    onRunPrompt?: (
      prompt: string,
      sessionId: string | null,
    ) => void | Promise<void>;
    onError?: (error: unknown, message: string) => void;
  } = {},
) {
  actions.listScheduledTasks.mockResolvedValue(tasks);
  actions.updateScheduledTask.mockResolvedValue(tasks[0]);
  actions.runScheduledTask.mockResolvedValue(tasks[0]);
  actions.loadExtensionsStatus.mockResolvedValue({
    extensions: [],
  });
  actions.loadSkillsStatus.mockResolvedValue({
    skills: [],
  });
  actions.loadMcpStatus.mockResolvedValue({
    servers: [],
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider language="en">
        <ScheduledTasksDialog
          onRunPrompt={opts.onRunPrompt ?? vi.fn()}
          onCreateViaChat={vi.fn()}
          onOpenSession={opts.onOpenSession}
          onError={opts.onError ?? vi.fn()}
        />
      </I18nProvider>,
    );
  });
  await flush();
}

// Flush the async list load (and any post-action reload) so state settles.
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(el: Element | null | undefined) {
  if (!el) throw new Error('click target not found');
  act(() => {
    el.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
  });
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  );
}

function findButtonContaining(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(label),
  );
}

// The frequency picker is the (only) <select> with a weekdays option.
function findFrequencySelect(): HTMLSelectElement | undefined {
  return Array.from(document.querySelectorAll('select')).find(
    (s) => !!s.querySelector('option[value="weekdays"]'),
  );
}

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function dispatchClipboardEvent(
  target: Element,
  type: 'copy' | 'cut',
  clipboardData: { setData: ReturnType<typeof vi.fn> },
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: clipboardData });
  act(() => {
    target.dispatchEvent(event);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

const baseTask = (over: Partial<MockTask>): MockTask => ({
  id: 't1',
  name: 'Digest',
  cron: '30 12 * * 1-5',
  prompt: 'summarize the day',
  recurring: true,
  enabled: true,
  createdAt: 1_700_000_000_000,
  lastFiredAt: null,
  nextRunAt: null,
  sessionId: null,
  runs: [],
  ...over,
});

describe('ScheduledTasksDialog editing', () => {
  it('keeps the prompt placeholder outside the editable textbox', async () => {
    await mount([]);

    click(findButton('New scheduled task'));

    const prompt = document.querySelector<HTMLElement>('[role="textbox"]');
    expect(prompt?.textContent).toBe('');
    expect(prompt?.getAttribute('aria-placeholder')).toBe(
      'What should this task do?',
    );
    expect(document.body.textContent).toContain('What should this task do?');
  });

  it('prefills the form from the task and saves via updateScheduledTask', async () => {
    await mount([baseTask({})]);

    // Open the edit form for the (only) task.
    click(document.querySelector('[aria-label="Edit"]'));

    // The cron reverses onto the structured pickers (weekdays @ 12:30) and the
    // name/prompt are prefilled — not left blank as they would be for create.
    const name = document.querySelector<HTMLInputElement>('input[type="text"]');
    const prompt = document.querySelector<HTMLElement>('[role="textbox"]');
    const frequency = findFrequencySelect();
    const time = document.querySelector<HTMLInputElement>('input[type="time"]');
    expect(name?.value).toBe('Digest');
    expect(prompt?.textContent).toBe('summarize the day');
    expect(frequency?.value).toBe('weekdays');
    expect(time?.value).toBe('12:30');

    // Saving routes through update (not create), sending only the editable
    // fields so recurring/enabled are left untouched.
    click(findButton('Save'));
    await flush();

    expect(actions.updateScheduledTask).toHaveBeenCalledWith(
      't1',
      {
        cron: '30 12 * * 1-5',
        prompt: 'summarize the day',
        name: 'Digest',
      },
      undefined,
    );
    expect(actions.createScheduledTask).not.toHaveBeenCalled();
  });

  it('renders saved prompt references as inline tags when editing', async () => {
    const promptText = '@mcp:amap-maps3 /agent-reproduce-align @ext:clickhouse';
    await mount([baseTask({ prompt: promptText })]);

    click(document.querySelector('[aria-label="Edit"]'));

    const tags = Array.from(
      document.querySelectorAll<HTMLElement>('[data-prompt-tag-serialized]'),
    );
    expect(tags.map((tag) => tag.dataset.promptTagSerialized)).toEqual([
      '@mcp:amap-maps3',
      '/agent-reproduce-align',
      '@ext:clickhouse',
    ]);
    expect(tags.map((tag) => tag.textContent)).toEqual([
      'amap-maps3',
      'agent-reproduce-align',
      'clickhouse',
    ]);

    click(findButton('Save'));
    await flush();

    expect(actions.updateScheduledTask).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({
        prompt: promptText,
      }),
      undefined,
    );
  });

  it('removes a prompt reference tag and its adjacent spacer', async () => {
    await mount([
      baseTask({ prompt: '@ext:clickhouse /review @mcp:repo-tools' }),
    ]);

    click(document.querySelector('[aria-label="Edit"]'));
    const removeButtons = document.querySelectorAll('[data-prompt-tag-remove]');
    expect(removeButtons).toHaveLength(3);

    click(removeButtons[1]);
    await flush();
    click(findButton('Save'));
    await flush();

    expect(actions.updateScheduledTask).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({
        prompt: '@ext:clickhouse @mcp:repo-tools',
      }),
      undefined,
    );
  });

  it('copies and cuts prompt references as serialized tokens', async () => {
    const promptText = '@ext:clickhouse /review @mcp:repo-tools';
    await mount([baseTask({ prompt: promptText })]);

    click(document.querySelector('[aria-label="Edit"]'));
    const prompt = document.querySelector<HTMLElement>('[role="textbox"]');
    if (!prompt) throw new Error('prompt editor not found');
    const range = document.createRange();
    range.selectNodeContents(prompt);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const copyClipboard = { setData: vi.fn() };
    dispatchClipboardEvent(prompt, 'copy', copyClipboard);
    expect(copyClipboard.setData).toHaveBeenCalledWith(
      'text/plain',
      promptText,
    );

    const cutClipboard = { setData: vi.fn() };
    dispatchClipboardEvent(prompt, 'cut', cutClipboard);
    await flush();
    expect(cutClipboard.setData).toHaveBeenCalledWith('text/plain', promptText);
    expect(prompt.textContent).toBe('');
  });

  it('does not render filesystem paths as skill tags', async () => {
    await mount([
      baseTask({ prompt: 'check /var/log and then /agent-reproduce-align' }),
    ]);

    click(document.querySelector('[aria-label="Edit"]'));

    const tags = Array.from(
      document.querySelectorAll<HTMLElement>('[data-prompt-tag-serialized]'),
    );
    expect(tags.map((tag) => tag.dataset.promptTagSerialized)).toEqual([
      '/agent-reproduce-align',
    ]);
    expect(document.querySelector('[role="textbox"]')?.textContent).toContain(
      '/var/log',
    );
  });

  it('does not hang on escaped slash-reference near-misses', async () => {
    const promptText = `check /${'\\a'.repeat(30)}/ after`;
    await mount([baseTask({ prompt: promptText })]);

    click(document.querySelector('[aria-label="Edit"]'));

    expect(document.querySelector('[role="textbox"]')?.textContent).toContain(
      promptText,
    );
  });

  it('inserts extension, skill, and MCP references into the created prompt', async () => {
    actions.createScheduledTask.mockResolvedValue(baseTask({}));

    await mount([]);

    actions.loadExtensionsStatus.mockResolvedValue({
      extensions: [
        {
          id: 'ext-1',
          name: 'alibabacloud-compute-suite',
          displayName: '\u001b[31mAlibaba Cloud\u001b[0m\u202e\u0007',
          description: '',
          version: '1.0.0',
          isActive: true,
          path: '/ext',
          capabilities: {},
        },
      ],
    });
    actions.loadSkillsStatus.mockResolvedValue({
      skills: [
        {
          kind: 'skill',
          name: 'review',
          description: 'Review code',
          level: 'project',
          modelInvocable: true,
        },
      ],
    });
    actions.loadMcpStatus.mockResolvedValue({
      servers: [
        {
          kind: 'mcp_server',
          name: 'repo-tools',
          transport: 'stdio',
          disabled: false,
          mcpStatus: 'connected',
        },
      ],
    });
    click(findButton('New scheduled task'));

    click(findButtonContaining('Extensions'));
    await flush();
    click(findButtonContaining('alibabacloud-compute-suite'));
    await flush();

    click(findButtonContaining('Skills'));
    await flush();
    click(findButtonContaining('review'));
    await flush();

    click(findButtonContaining('MCP'));
    await flush();
    click(findButtonContaining('repo-tools'));
    await flush();

    const extensionTag = document.querySelector<HTMLElement>(
      '[data-prompt-tag-serialized="@ext:alibabacloud-compute-suite"]',
    );
    expect(extensionTag?.textContent).toBe('Alibaba Cloud');
    expect(extensionTag?.dataset.promptTagSerialized).toBe(
      '@ext:alibabacloud-compute-suite',
    );

    click(findButton('Create'));
    await flush();

    expect(actions.createScheduledTask).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: '@ext:alibabacloud-compute-suite /review @mcp:repo-tools',
      }),
      undefined,
    );
  });

  it('escapes skill names when inserting references', async () => {
    actions.createScheduledTask.mockResolvedValue(baseTask({}));
    await mount([]);
    actions.loadSkillsStatus.mockResolvedValue({
      skills: [
        {
          kind: 'skill',
          name: 'review task',
          description: 'Review code',
          level: 'project',
          modelInvocable: true,
        },
      ],
    });

    click(findButton('New scheduled task'));
    click(findButtonContaining('Skills'));
    await flush();
    click(findButtonContaining('review task'));
    await flush();

    click(findButton('Create'));
    await flush();

    expect(actions.createScheduledTask).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: '/review\\ task',
      }),
      undefined,
    );
  });

  it('keeps the latest reference picker results when loads resolve out of order', async () => {
    await mount([]);
    const extensions = deferred();
    const skills = deferred();
    actions.loadExtensionsStatus.mockReturnValueOnce(extensions.promise);
    actions.loadSkillsStatus.mockReturnValueOnce(skills.promise);

    click(findButton('New scheduled task'));
    click(findButtonContaining('Extensions'));
    click(findButtonContaining('Skills'));

    skills.resolve({
      skills: [
        {
          kind: 'skill',
          name: 'review',
          description: 'Review code',
          level: 'project',
          modelInvocable: true,
        },
      ],
    });
    await flush();
    expect(findButtonContaining('review')).toBeTruthy();

    extensions.resolve({
      extensions: [
        {
          id: 'ext-1',
          name: 'alibabacloud-compute-suite',
          displayName: 'Alibaba Cloud',
          description: '',
          version: '1.0.0',
          isActive: true,
          path: '/ext',
          capabilities: {},
        },
      ],
    });
    await flush();
    expect(findButtonContaining('review')).toBeTruthy();
    expect(findButtonContaining('alibabacloud-compute-suite')).toBeUndefined();
  });

  it('drops plain text only into the prompt editor', async () => {
    await mount([]);
    click(findButton('New scheduled task'));
    const prompt = document.querySelector<HTMLElement>('[role="textbox"]');
    if (!prompt) throw new Error('prompt editor not found');
    const execCommand = vi.spyOn(document, 'execCommand').mockReturnValue(true);
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', {
      value: {
        getData: (type: string) =>
          type === 'text/plain' ? 'plain text' : '<b>html</b>',
      },
    });

    act(() => {
      prompt.dispatchEvent(drop);
    });

    expect(execCommand).toHaveBeenCalledWith('insertText', false, 'plain text');
    execCommand.mockRestore();
  });

  it('pastes plain text only into the prompt editor', async () => {
    await mount([]);
    click(findButton('New scheduled task'));
    const prompt = document.querySelector<HTMLElement>('[role="textbox"]');
    if (!prompt) throw new Error('prompt editor not found');
    const execCommand = vi.spyOn(document, 'execCommand').mockReturnValue(true);
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: {
        getData: (type: string) =>
          type === 'text/plain' ? 'plain text' : '<b>html</b>',
      },
    });

    act(() => {
      prompt.dispatchEvent(paste);
    });

    expect(execCommand).toHaveBeenCalledWith('insertText', false, 'plain text');
    execCommand.mockRestore();
  });

  it('caps contenteditable input at the scheduled-task prompt limit', async () => {
    actions.createScheduledTask.mockResolvedValue(baseTask({}));
    await mount([]);
    click(findButton('New scheduled task'));
    const prompt = document.querySelector<HTMLElement>('[role="textbox"]');
    if (!prompt) throw new Error('prompt editor not found');

    act(() => {
      prompt.textContent = 'x'.repeat(100_001);
      prompt.dispatchEvent(new InputEvent('input', { bubbles: true }));
    });
    await flush();
    click(findButton('Create'));
    await flush();

    expect(actions.createScheduledTask).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'x'.repeat(100_000),
      }),
      undefined,
    );
  });

  it('does not preserve empty contenteditable leftovers before an inserted reference', async () => {
    actions.createScheduledTask.mockResolvedValue(baseTask({}));

    await mount([]);

    actions.loadExtensionsStatus.mockResolvedValue({
      extensions: [
        {
          id: 'ext-1',
          name: 'alibabacloud-compute-suite',
          description: '',
          version: '1.0.0',
          isActive: true,
          path: '/ext',
          capabilities: {},
        },
      ],
    });
    click(findButton('New scheduled task'));

    const prompt = document.querySelector<HTMLElement>('[role="textbox"]');
    if (!prompt) throw new Error('prompt editor not found');
    act(() => {
      prompt.innerHTML = '<br>';
      prompt.dispatchEvent(new InputEvent('input', { bubbles: true }));
    });
    await flush();

    click(findButtonContaining('Extensions'));
    await flush();
    click(findButtonContaining('alibabacloud-compute-suite'));
    await flush();

    const extensionTag = prompt.querySelector<HTMLElement>(
      '[data-prompt-tag-serialized="@ext:alibabacloud-compute-suite"]',
    );
    expect(extensionTag?.textContent).toBe('alibabacloud-compute-suite');

    click(findButton('Create'));
    await flush();

    expect(actions.createScheduledTask).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: '@ext:alibabacloud-compute-suite',
      }),
      undefined,
    );
  });

  it('an unrepresentable cron lands in the custom field, losslessly', async () => {
    await mount([baseTask({ cron: '0 9 * * 1,3,5' })]); // day-of-week list

    click(document.querySelector('[aria-label="Edit"]'));
    const frequency = findFrequencySelect();
    expect(frequency?.value).toBe('custom');

    click(findButton('Save'));
    await flush();
    // The raw expression round-trips unchanged rather than being rewritten.
    expect(actions.updateScheduledTask).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ cron: '0 9 * * 1,3,5' }),
      undefined,
    );
  });
});

describe('ScheduledTasksDialog run history', () => {
  it('toggles the run list open, newest-first, tagging late fires', async () => {
    await mount([
      baseTask({
        runs: [
          { at: 1_700_000_100_000, kind: 'scheduled' },
          { at: 1_700_000_200_000, kind: 'catch-up' },
        ],
      }),
    ]);

    // Collapsed by default — no list items rendered.
    expect(document.querySelectorAll('li').length).toBe(0);
    const toggle = document.querySelector<HTMLButtonElement>(
      'button[aria-expanded]',
    );
    expect(toggle?.textContent).toBe('Run history (2)');

    click(toggle);
    const items = Array.from(document.querySelectorAll('li'));
    expect(items).toHaveLength(2);
    // Newest first: the catch-up fire (later timestamp) leads and is tagged.
    expect(items[0]!.textContent).toContain('late');
    expect(items[1]!.textContent).not.toContain('late');
  });

  it('shows no run-history toggle for a task that has never fired', async () => {
    await mount([baseTask({ runs: [] })]);
    expect(document.querySelector('button[aria-expanded]')).toBeNull();
  });
});

describe('ScheduledTasksDialog run now', () => {
  it('records the run and executes the prompt in the task’s bound session', async () => {
    const onRunPrompt = vi.fn();
    await mount([baseTask({ sessionId: 'sess-9', prompt: 'do it' })], {
      onRunPrompt,
    });
    click(document.querySelector('[aria-label="Run now"]'));
    await flush();
    // Server-side run record (updates last-run) + client run in the bound session.
    expect(actions.runScheduledTask).toHaveBeenCalledWith('t1', undefined);
    expect(onRunPrompt).toHaveBeenCalledWith('do it', 'sess-9');
  });

  it('passes a null sessionId through for an unbound task', async () => {
    const onRunPrompt = vi.fn();
    await mount([baseTask({ sessionId: null, prompt: 'legacy' })], {
      onRunPrompt,
    });
    click(document.querySelector('[aria-label="Run now"]'));
    await flush();
    expect(onRunPrompt).toHaveBeenCalledWith('legacy', null);
  });

  it('does not run a DISABLED task (button disabled, prompt never enqueued)', async () => {
    // The server /run guard only refuses the record — the prompt must not even
    // be enqueued, or a disabled task would execute unrecorded.
    const onRunPrompt = vi.fn();
    await mount([baseTask({ enabled: false, sessionId: 'sess-9' })], {
      onRunPrompt,
    });
    const btn = document.querySelector(
      '[aria-label="Run now"]',
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    click(btn); // disabled + handler guard → no-op
    await flush();
    expect(onRunPrompt).not.toHaveBeenCalled();
    expect(actions.runScheduledTask).not.toHaveBeenCalled();
  });

  it('does NOT record the run when the bound session fails to open', async () => {
    // onRunPrompt rejects (session archived/deleted): the prompt never ran, so
    // the run must not be recorded — otherwise history shows a phantom run.
    const onRunPrompt = vi.fn().mockRejectedValue(new Error('archived'));
    const onError = vi.fn();
    await mount([baseTask({ sessionId: 'sess-9', prompt: 'do it' })], {
      onRunPrompt,
      onError,
    });
    click(document.querySelector('[aria-label="Run now"]'));
    await flush();
    expect(onRunPrompt).toHaveBeenCalledWith('do it', 'sess-9');
    expect(actions.runScheduledTask).not.toHaveBeenCalled(); // no phantom record
    expect(onError).toHaveBeenCalled();
  });

  it('re-checks server state and does NOT enqueue a task disabled after load', async () => {
    // The dialog loaded the task as enabled, but another tab/API disabled it
    // since. The server-authoritative re-check must catch that BEFORE enqueuing,
    // or a disabled task's prompt runs unrecorded.
    const onRunPrompt = vi.fn();
    await mount(
      [baseTask({ enabled: true, sessionId: 'sess-9', prompt: 'do it' })],
      {
        onRunPrompt,
      },
    );
    // Server now reports it disabled (the re-check reload sees this).
    actions.listScheduledTasks.mockResolvedValue([
      baseTask({ enabled: false, sessionId: 'sess-9', prompt: 'do it' }),
    ]);
    click(document.querySelector('[aria-label="Run now"]'));
    await flush();
    expect(onRunPrompt).not.toHaveBeenCalled(); // never executed
    expect(actions.runScheduledTask).not.toHaveBeenCalled();
  });

  it('consumes a bound ONE-SHOT before enqueuing (record → enqueue)', async () => {
    // /run deletes a one-shot (its single fire). Consuming it BEFORE the run
    // means a failed enqueue leaves a recoverable "recorded but never ran", not
    // a silent double execution at the task's own slot.
    const order: string[] = [];
    const onRunPrompt = vi.fn(() => {
      order.push('enqueue');
    });
    await mount(
      [baseTask({ recurring: false, enabled: true, sessionId: 'sess-9' })],
      { onRunPrompt },
    );
    actions.runScheduledTask.mockImplementation(async () => {
      order.push('record');
      return baseTask({});
    });
    click(document.querySelector('[aria-label="Run now"]'));
    await flush();
    expect(order).toEqual(['record', 'enqueue']);
  });

  it('surfaces a consumed-but-failed error when a ONE-SHOT delivery fails', async () => {
    // The one-shot was deleted before the run; if delivery then rejects it is
    // gone AND un-run, so the error must say so — not the generic "run failed",
    // which would hide that the task no longer exists.
    const onRunPrompt = vi.fn().mockRejectedValue(new Error('switch timeout'));
    const onError = vi.fn();
    await mount(
      [
        baseTask({
          recurring: false,
          enabled: true,
          sessionId: 'sess-9',
          prompt: 'do it',
        }),
      ],
      { onRunPrompt, onError },
    );
    click(document.querySelector('[aria-label="Run now"]'));
    await flush();
    expect(actions.runScheduledTask).toHaveBeenCalledWith('t1', undefined); // consumed
    expect(onRunPrompt).toHaveBeenCalledWith('do it', 'sess-9');
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.stringContaining('never ran'),
    );
  });

  it('records a RECURRING task after enqueuing (enqueue → record)', async () => {
    const order: string[] = [];
    const onRunPrompt = vi.fn(() => {
      order.push('enqueue');
    });
    await mount(
      [baseTask({ recurring: true, enabled: true, sessionId: 'sess-9' })],
      { onRunPrompt },
    );
    actions.runScheduledTask.mockImplementation(async () => {
      order.push('record');
      return baseTask({});
    });
    click(document.querySelector('[aria-label="Run now"]'));
    await flush();
    expect(order).toEqual(['enqueue', 'record']);
  });

  it('serializes run now: a second click while one is pending is ignored', async () => {
    // Hold the first run pending (session still switching), then click again —
    // the button is disabled + the handler guards, so no second prompt/record.
    let resolveRun: (() => void) | undefined;
    const onRunPrompt = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve;
        }),
    );
    await mount([baseTask({ sessionId: 'sess-9', prompt: 'do it' })], {
      onRunPrompt,
    });
    const btn = document.querySelector('[aria-label="Run now"]');
    click(btn);
    await flush(); // first run pending → button disabled
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    click(btn); // ignored while pending
    await flush();
    expect(onRunPrompt).toHaveBeenCalledTimes(1);
    resolveRun?.();
    await flush();
    expect(actions.runScheduledTask).toHaveBeenCalledTimes(1); // one record
  });
});

describe('ScheduledTasksDialog far-future countdown', () => {
  it('clamps the reload timer so a months-away schedule cannot overflow setTimeout', async () => {
    const spy = vi.spyOn(window, 'setTimeout');
    try {
      // ~100 days out: the raw delay exceeds setTimeout's 32-bit ceiling, which
      // would fire immediately and spin a reload loop. It must be clamped.
      const farFuture = Date.now() + 100 * 86_400_000;
      await mount([baseTask({ nextRunAt: farFuture })]);
      const delays = spy.mock.calls.map((c) => Number(c[1] ?? 0));
      expect(delays.every((d) => d <= 2_147_483_647)).toBe(true);
      expect(delays).toContain(2_147_483_647); // clamped to the ceiling
    } finally {
      spy.mockRestore();
    }
  });
});

describe('ScheduledTasksDialog view-history (bound session)', () => {
  it('opens the bound session when its history control is clicked', async () => {
    const onOpenSession = vi.fn();
    await mount(
      [
        baseTask({
          sessionId: 'sess-42',
          runs: [{ at: 1_700_000_100_000, kind: 'scheduled' }],
        }),
      ],
      { onOpenSession },
    );
    // A bound task shows a "View conversation" control (with a run count) that
    // opens its session transcript — not the inline expand toggle.
    const btn = findButton('View conversation (1)');
    expect(btn).toBeDefined();
    expect(document.querySelector('button[aria-expanded]')).toBeNull();
    click(btn);
    expect(onOpenSession).toHaveBeenCalledWith('sess-42');
  });

  it('shows the view-history control even before the first run (empty state)', async () => {
    const onOpenSession = vi.fn();
    await mount([baseTask({ sessionId: 'sess-42', runs: [] })], {
      onOpenSession,
    });
    // Discoverable even with zero runs — the original "can't find history" pain.
    const btn = findButton('View conversation');
    expect(btn).toBeDefined();
    click(btn);
    expect(onOpenSession).toHaveBeenCalledWith('sess-42');
  });

  it('falls back to the inline toggle when session opening is not wired', async () => {
    // No onOpenSession (e.g. a minimal embed): a bound task with runs still gets
    // the inline timestamp list rather than a dead open button.
    await mount([
      baseTask({ sessionId: 'sess-42', runs: [{ at: 1_700_000_100_000 }] }),
    ]);
    expect(findButton('View conversation (1)')).toBeUndefined();
    expect(document.querySelector('button[aria-expanded]')).not.toBeNull();
  });
});

describe('ScheduledTasksDialog next-run countdown', () => {
  it('renders a countdown pill for a task with a next run', async () => {
    // ~3h12m in the future — the hours unit is stable across the test's few ms.
    await mount([
      baseTask({ nextRunAt: Date.now() + 3 * 3_600_000 + 12 * 60_000 }),
    ]);
    const pill = document.querySelector(
      '[data-testid="scheduled-task-next-run"]',
    );
    expect(pill).not.toBeNull();
    expect(pill!.textContent).toMatch(/3h/);
  });

  it('omits the countdown when there is no next run (disabled task)', async () => {
    await mount([baseTask({ enabled: false, nextRunAt: null })]);
    expect(
      document.querySelector('[data-testid="scheduled-task-next-run"]'),
    ).toBeNull();
  });
});

describe('ScheduledTasksDialog multi-workspace', () => {
  const WORKSPACES = [
    {
      id: 'id-main',
      cwd: '/repo/main',
      displayName: 'Main Workspace',
      primary: true,
      trusted: true,
    },
    {
      id: 'id-other',
      cwd: '/repo/other',
      displayName: 'Payments API',
      primary: false,
      trusted: true,
    },
    { id: 'id-locked', cwd: '/repo/locked', primary: false, trusted: false },
  ];

  // Fan-out mount: `listScheduledTasks(wsId)` returns each workspace's own tasks
  // (the primary is queried with undefined, secondaries with their id). The
  // dialog tags each task with its workspace and merges them. `ws` overrides the
  // registered workspaces (e.g. to make the primary untrusted).
  async function mountMulti(
    byWorkspace: Record<string, MockTask[]>,
    ws: typeof WORKSPACES = WORKSPACES,
    lockedWorkspace?: (typeof WORKSPACES)[number],
  ) {
    actions.listScheduledTasks.mockImplementation(async (wsId?: string) =>
      wsId === undefined
        ? (byWorkspace['primary'] ?? [])
        : (byWorkspace[wsId] ?? []),
    );
    actions.createScheduledTask.mockResolvedValue(baseTask({}));
    actions.updateScheduledTask.mockResolvedValue(baseTask({}));
    actions.deleteScheduledTask.mockResolvedValue(undefined);
    actions.loadExtensionsStatus.mockResolvedValue({ extensions: [] });
    actions.loadSkillsStatus.mockResolvedValue({ skills: [] });
    actions.loadMcpStatus.mockResolvedValue({ servers: [] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <I18nProvider language="en">
          <ScheduledTasksDialog
            onRunPrompt={vi.fn()}
            onCreateViaChat={vi.fn()}
            workspaces={ws}
            lockedWorkspace={lockedWorkspace}
            onError={vi.fn()}
          />
        </I18nProvider>,
      );
    });
    await flush();
  }

  const findWorkspaceSelect = () =>
    Array.from(document.querySelectorAll('select')).find((s) =>
      s.querySelector('option[value="id-other"]'),
    );

  it('aggregates trusted workspaces and badges each card by workspace', async () => {
    await mountMulti({
      primary: [baseTask({ id: 'p1', name: 'Primary task', createdAt: 1000 })],
      'id-other': [
        baseTask({ id: 's1', name: 'Second task', createdAt: 2000 }),
      ],
    });

    // Both workspaces' tasks show up together.
    expect(document.body.textContent).toContain('Primary task');
    expect(document.body.textContent).toContain('Second task');

    // The fan-out queried the primary (undefined) and the trusted secondary, but
    // NOT the untrusted one.
    expect(actions.listScheduledTasks).toHaveBeenCalledWith(undefined);
    expect(actions.listScheduledTasks).toHaveBeenCalledWith('id-other');
    expect(actions.listScheduledTasks).not.toHaveBeenCalledWith('id-locked');

    // Each card carries a workspace badge (title = cwd), labeled for display.
    const primaryBadge = document.querySelector('[title="/repo/main"]');
    const secondaryBadge = document.querySelector('[title="/repo/other"]');
    expect(primaryBadge?.textContent).toContain('Main Workspace');
    // The primary is no longer singled out with a "(primary)" tag.
    expect(primaryBadge?.textContent).not.toContain('(primary)');
    expect(secondaryBadge?.textContent).toContain('Payments API');
  });

  it('creates a task in the workspace chosen in the picker', async () => {
    await mountMulti({ primary: [], 'id-other': [] });
    click(findButton('New scheduled task'));

    // The picker offers the two trusted workspaces (untrusted excluded).
    const wsSelect = findWorkspaceSelect();
    expect(wsSelect).toBeDefined();
    expect(wsSelect!.querySelectorAll('option')).toHaveLength(2);
    // Options show each workspace label with no "(primary)" tag on the primary
    // entry (the label this PR removed). Guards the visible dropdown
    // text, which the count/value assertions above do not cover.
    expect(
      Array.from(wsSelect!.querySelectorAll('option')).map(
        (o) => o.textContent,
      ),
    ).toEqual(['Main Workspace', 'Payments API']);

    // Choose the secondary workspace.
    act(() => {
      wsSelect!.value = 'id-other';
      wsSelect!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const prompt = document.querySelector<HTMLElement>('[role="textbox"]')!;
    act(() => {
      prompt.textContent = 'do secondary work';
      prompt.dispatchEvent(new InputEvent('input', { bubbles: true }));
    });

    click(findButton('Create'));
    await flush();

    expect(actions.createScheduledTask).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'do secondary work' }),
      'id-other',
    );
  });

  it('lists and creates tasks in a locked secondary workspace', async () => {
    const secondary = WORKSPACES[1]!;
    await mountMulti(
      {
        primary: [baseTask({ id: 'p1', name: 'Primary task' })],
        'id-other': [baseTask({ id: 's1', name: 'Secondary task' })],
      },
      [secondary],
      secondary,
    );

    expect(actions.listScheduledTasks).toHaveBeenCalledWith('id-other');
    expect(actions.listScheduledTasks).not.toHaveBeenCalledWith(undefined);
    expect(document.body.textContent).toContain('Secondary task');
    expect(document.body.textContent).not.toContain('Primary task');

    click(findButton('New scheduled task'));
    expect(findWorkspaceSelect()).toBeUndefined();
    const prompt = document.querySelector<HTMLElement>('[role="textbox"]')!;
    act(() => {
      prompt.textContent = 'do locked work';
      prompt.dispatchEvent(new InputEvent('input', { bubbles: true }));
    });
    click(findButton('Create'));
    await flush();

    expect(actions.createScheduledTask).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'do locked work' }),
      'id-other',
    );
  });

  it('defaults a new task to the primary workspace', async () => {
    await mountMulti({ primary: [], 'id-other': [] });
    click(findButton('New scheduled task'));
    const prompt = document.querySelector<HTMLElement>('[role="textbox"]')!;
    act(() => {
      prompt.textContent = 'primary work';
      prompt.dispatchEvent(new InputEvent('input', { bubbles: true }));
    });
    click(findButton('Create'));
    await flush();
    // Primary → undefined workspace id (its trust-free unqualified route).
    expect(actions.createScheduledTask).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'primary work' }),
      undefined,
    );
  });

  it('threads the task’s own workspace through toggle and delete', async () => {
    await mountMulti({
      primary: [],
      'id-other': [baseTask({ id: 's1', name: 'Second task', enabled: true })],
    });

    // The secondary's task is the only card → the only toggle switch.
    click(document.querySelector('[role="switch"]'));
    await flush();
    expect(actions.updateScheduledTask).toHaveBeenCalledWith(
      's1',
      { enabled: false },
      'id-other',
    );

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    click(document.querySelector('[aria-label="Delete"]'));
    await flush();
    expect(actions.deleteScheduledTask).toHaveBeenCalledWith('s1', 'id-other');
    confirmSpy.mockRestore();
  });

  it('pins the workspace picker read-only while editing', async () => {
    await mountMulti({
      primary: [],
      'id-other': [baseTask({ id: 's1', name: 'Second task' })],
    });
    click(document.querySelector('[aria-label="Edit"]'));
    const wsSelect = findWorkspaceSelect();
    // The picker is shown (so the user sees the workspace) but disabled — a
    // PATCH can't move a task between per-workspace files.
    expect(wsSelect?.disabled).toBe(true);
  });

  it('keeps an untrusted primary in the aggregate and picker (trust-free route)', async () => {
    // Rare: folder-trust on and the primary folder not trusted. The primary is
    // still reachable via its trust-free unqualified route, so it must not drop
    // out of the list, and it must stay the selectable default in the New form
    // (otherwise the picker shows a secondary while a create still lands on the
    // primary). Secondaries stay gated on trust.
    const wsUntrustedPrimary = [
      { id: 'id-main', cwd: '/repo/main', primary: true, trusted: false },
      { id: 'id-other', cwd: '/repo/other', primary: false, trusted: true },
    ];
    await mountMulti(
      {
        primary: [baseTask({ id: 'p1', name: 'Primary task' })],
        'id-other': [baseTask({ id: 's1', name: 'Second task' })],
      },
      wsUntrustedPrimary,
    );

    // The untrusted primary is queried (via its trust-free route) and shown.
    expect(actions.listScheduledTasks).toHaveBeenCalledWith(undefined);
    expect(document.body.textContent).toContain('Primary task');

    // In the New form the primary is a selectable option and stays the default,
    // so the shown selection matches where a create actually lands.
    click(findButton('New scheduled task'));
    const wsSelect = findWorkspaceSelect()!;
    const values = Array.from(wsSelect.querySelectorAll('option')).map(
      (o) => o.value,
    );
    expect(values).toContain(''); // '' = the primary (its undefined action id)
    expect(wsSelect.value).toBe(''); // default targets the primary, no desync
  });
});
