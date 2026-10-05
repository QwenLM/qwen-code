import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import { liveMessage, liveText } from '@qwen-code/qwen-live/i18n';
import type {
  SubagentTask,
  SubagentsControlResult,
  SubagentsSnapshot,
} from '@qwen-code/qwen-live/subagents';
import { SubagentsView } from '../../renderer/subagents-view.ts';
import type {
  SubagentsWindowApi,
  SubagentsWindowState,
} from '../../shared/subagents-api.ts';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const run of cleanup.splice(0).reverse()) run();
});
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

function task(overrides: Partial<SubagentTask> = {}): SubagentTask {
  return {
    id: 'task-1',
    kind: 'harness',
    title: 'Check build',
    status: 'running',
    createdAt: 1_788_790_000_000,
    updatedAt: 1_788_790_001_000,
    request: 'Run focused tests',
    activity: 'Running the tests',
    output: 'Build output',
    events: [{ at: 1_788_790_001_000, kind: 'tool', text: 'npm test' }],
    ...overrides,
  };
}

function snapshot(tasks = [task()]): SubagentsSnapshot {
  return {
    revision: 1,
    counts: {
      running: 3,
      completed: 7,
      needsAttention: 2,
      failed: 1,
      cancelled: 1,
      interrupted: 1,
    },
    tasks,
    omitted: 4,
  };
}

function setup(
  overrides: Partial<SubagentsWindowApi> = {},
  initial: Partial<SubagentsWindowState> = {},
) {
  const dom = new JSDOM('<!doctype html><main id="app"></main>');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: dom.window.document,
  });
  cleanup.push(() => {
    dom.window.close();
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  });
  const app = dom.window.document.querySelector<HTMLElement>('#app')!;
  const calls: unknown[][] = [];
  const state: SubagentsWindowState = {
    language: 'en',
    connected: true,
    mode: 'summary',
    snapshot: snapshot(),
    ...initial,
  };
  const api: SubagentsWindowApi = {
    getState: async () => state,
    onState: () => () => {},
    setHover: (value) => calls.push(['hover', value]),
    setKeyboardHeld: (value) => calls.push(['keyboard', value]),
    back: async () => {
      calls.push(['back']);
    },
    expand: async () => {
      calls.push(['expand']);
    },
    close: () => calls.push(['close']),
    openDetail: async (id) => {
      calls.push(['detail', id]);
    },
    control: async (instanceId, request) => {
      calls.push(['control', instanceId, request]);
      return {
        type: 'outcome',
        outcome: 'stopping',
        ...(request.action === 'stop' ? { taskId: request.taskId } : {}),
      };
    },
    ...overrides,
  };
  const view = new SubagentsView(app, api);
  cleanup.push(() => view.dispose());
  view.update(state);
  const get = <T extends HTMLElement = HTMLElement>(selector: string): T => {
    const node = app.querySelector<T>(selector);
    assert(node, `Missing ${selector}`);
    return node;
  };
  const update = (next: Partial<SubagentsWindowState>) => {
    Object.assign(state, next);
    view.update({ ...state });
  };
  return { dom, app, calls, view, get, update, state };
}

describe('Subagents read-only surfaces', () => {
  it('marks an unassigned backend approval without inventing an active task', () => {
    const value = snapshot([]);
    value.counts = {
      running: 0,
      completed: 0,
      needsAttention: 0,
      failed: 0,
      cancelled: 0,
      interrupted: 0,
    };
    value.pendingUnassignedPermissions = 1;
    const h = setup({}, { snapshot: value });
    assert.equal(h.get('.subagents-summary-waiting').hidden, false);
    assert.match(
      h.get('.subagents-summary').getAttribute('aria-label') ?? '',
      /0 running.*1 waiting/,
    );
    h.update({ mode: 'list' });
    assert.equal(
      h.get('.subagents-panel [data-count="needsAttention"]').textContent,
      '1',
    );
  });

  it('stops the exact selected task outside the summary page and distinguishes requested from confirmed', async () => {
    const selected = task({ id: 'harness:40', canStop: true });
    const h = setup(
      {},
      {
        mode: 'detail',
        selectedId: selected.id,
        instanceId: 'daemon-one',
        controlsAvailable: true,
        page: { snapshot: snapshot(), offset: 0, total: 40, selected },
      },
    );
    const stop = h.get<HTMLButtonElement>('.subagent-identity .subagents-stop');
    assert.equal(stop.hidden, false);
    stop.click();
    stop.click();
    await settled();
    assert.deepEqual(h.calls, [
      ['control', 'daemon-one', { action: 'stop', taskId: 'harness:40' }],
    ]);
    assert.equal(
      h.get('.subagent-identity .subagent-status').textContent,
      'Running',
    );
    assert.match(
      h.get('.subagents-feedback').textContent ?? '',
      /Waiting for the backend/,
    );
    h.update({
      page: {
        ...h.state.page!,
        selected: { ...selected, canStop: false, stopReason: 'stopping' },
      },
    });
    assert.equal(stop.disabled, true);
    assert.equal(stop.textContent, 'Stopping…');
    h.update({
      language: 'zh-CN',
      page: {
        ...h.state.page!,
        selected: {
          ...selected,
          canStop: false,
          stopReason: 'ended',
          status: 'cancelled',
        },
      },
    });
    assert.equal(stop.hidden, true);
    assert.equal(h.get('.subagents-feedback').textContent, '任务已停止。');
    assert.equal(
      h.get('.subagent-identity .subagent-status').textContent,
      '已取消',
    );
    h.get<HTMLButtonElement>('.subagents-close').click();
    assert.equal(h.calls.filter(([call]) => call === 'control').length, 1);
  });

  it('renders real pending decisions with explicit scopes, keeps focus, and sends the request handle', async () => {
    const selected = task({
      status: 'waiting',
      canStop: true,
      permissions: [
        {
          requestHandle: 'req_12',
          title: '<script>Write file outside project</script>',
          choices: [
            { decision: 'allow', scope: 'always' },
            { decision: 'deny', scope: 'once' },
          ],
        },
      ],
      permissionsOmitted: 3,
    });
    const h = setup(
      {
        control: async (instance, request) => {
          h.calls.push(['control', instance, request]);
          return {
            type: 'outcome',
            outcome: 'allowed',
            requestHandle: 'req_12',
          };
        },
      },
      {
        mode: 'detail',
        instanceId: 'daemon-one',
        controlsAvailable: true,
        selectedId: selected.id,
        page: { snapshot: snapshot([selected]), offset: 0, total: 1, selected },
      },
    );
    const allow = h.get<HTMLButtonElement>('[data-decision="allow"]');
    assert.equal(allow.textContent, 'Always allow');
    assert.equal(h.get('[data-decision="deny"]').textContent, 'Deny once');
    assert.equal(h.app.querySelector('script'), null);
    allow.focus();
    h.update({ language: 'zh-CN' });
    assert.equal(h.get('[data-decision="allow"]'), allow);
    assert.equal(document.activeElement, allow);
    assert.equal(allow.textContent, '始终允许');
    assert.match(h.get('.subagents-more-permissions').textContent ?? '', /3/);
    allow.click();
    await settled();
    assert.deepEqual(h.calls.at(-1), [
      'control',
      'daemon-one',
      { action: 'permission', requestHandle: 'req_12', decision: 'allow' },
    ]);
    assert.equal(
      h.get('.subagents-feedback').textContent,
      liveText('zh-CN', 'subagents.outcome.allowed'),
    );
    h.update({ connected: false });
    assert.equal(allow.disabled, true);
  });

  it('shows unassigned approvals separately and pages retained tasks instead of hiding active details', async () => {
    const entries = [task({ id: 'harness:33', canStop: true })];
    const h = setup(
      {},
      {
        mode: 'list',
        instanceId: 'daemon-one',
        controlsAvailable: true,
        page: {
          snapshot: snapshot(entries),
          offset: 32,
          total: 34,
          unassignedPermissions: [
            {
              requestHandle: 'req_2',
              title: 'Unassigned write',
              choices: [{ decision: 'deny', scope: 'once' }],
            },
          ],
        },
      },
    );
    assert.match(
      h.get('.subagent-unassigned').textContent ?? '',
      /Task identity unconfirmed/,
    );
    assert.equal(h.app.querySelector('[data-task-id="task-1"]'), null);
    assert.equal(h.get('.subagents-page-label').textContent, '33–33 of 34');
    const denial = h.get<HTMLButtonElement>(
      '.subagent-unassigned [data-decision="deny"]',
    );
    denial.focus();
    h.update({ language: 'zh-CN' });
    assert.equal(h.get('.subagent-unassigned [data-decision="deny"]'), denial);
    assert.equal(document.activeElement, denial);
    const next = h.get<HTMLButtonElement>(
      '.subagents-pagination button:nth-of-type(2)',
    );
    next.click();
    await settled();
    assert.deepEqual(h.calls.at(-1), [
      'control',
      'daemon-one',
      { action: 'list', offset: 33 },
    ]);
    assert.equal(h.get('.subagents-retention').hidden, true);
  });

  it('does not apply late action feedback to a replacement daemon or permanently lock controls after closing', async () => {
    let finish: (result: SubagentsControlResult) => void = () => {};
    const selected = task({ canStop: true });
    const h = setup(
      {
        control: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
      {
        mode: 'detail',
        instanceId: 'one',
        controlsAvailable: true,
        selectedId: selected.id,
        page: { snapshot: snapshot([selected]), offset: 0, total: 1, selected },
      },
    );
    h.get<HTMLButtonElement>('.subagent-identity .subagents-stop').click();
    h.update({ instanceId: 'two' });
    finish({ type: 'outcome', outcome: 'stopped' });
    await settled();
    assert.equal(h.get('.subagents-feedback').hidden, true);
    const stop = h.get<HTMLButtonElement>('.subagent-identity .subagents-stop');
    assert.equal(stop.disabled, false);
    stop.click();
    h.get<HTMLButtonElement>('.subagents-close').click();
    finish({ type: 'error', code: 'action_failed' });
    await settled();
    h.update({ mode: 'summary' });
    assert.equal(
      h.get<HTMLButtonElement>('.subagents-summary').disabled,
      false,
    );
    assert.equal(h.get('.subagents-error').hidden, true);
  });

  it('shows authoritative paired-language counts rather than counting retained tasks', async () => {
    const h = setup();
    const summary = h.get<HTMLButtonElement>('.subagents-summary');
    assert.match(summary.textContent ?? '', /Subagents/);
    assert.equal(
      summary.querySelector('[data-count="running"]')?.textContent,
      '3',
    );
    assert.equal(
      summary.querySelector('[data-count="completed"]')?.textContent,
      '7',
    );
    assert.equal(summary.querySelector('[data-count="needsAttention"]'), null);
    assert.equal(h.get('.subagents-summary-waiting').hidden, false);
    assert.equal(
      h.get('.subagents-summary-waiting').title,
      liveText('en', 'subagents.summaryWaiting', { count: 2 }),
    );
    assert.equal(
      summary.querySelector('.subagents-bot')?.getAttribute('aria-hidden'),
      'true',
    );
    assert.equal(summary.querySelector('.subagents-arrow'), null);
    assert.doesNotMatch(
      summary.textContent ?? '',
      /Running|Completed|Needs you/,
    );
    assert.equal(
      summary.getAttribute('aria-label'),
      'View subagents: 3 running, 7 completed, 2 waiting for your input.',
    );
    const running = summary.querySelector('[data-count="running"]');
    const completed = summary.querySelector('[data-count="completed"]');
    summary.click();
    await settled();
    assert.deepEqual(h.calls, [['expand']]);
    assert.equal(h.get('.subagents-panel').hidden, true);
    h.update({ language: 'zh-CN' });
    assert.equal(h.get('.subagents-summary'), summary);
    assert.equal(summary.querySelector('[data-count="running"]'), running);
    assert.equal(summary.querySelector('[data-count="completed"]'), completed);
    assert.match(summary.textContent ?? '', /子智能体/);
    assert.doesNotMatch(summary.textContent ?? '', /进行中|已完成|需关注/);
    assert.equal(
      summary.getAttribute('aria-label'),
      liveText('zh-CN', 'subagents.summaryLabel', {
        running: 3,
        completed: 7,
        waiting: 2,
      }),
    );
    assert.equal(summary.title, summary.getAttribute('aria-label'));
    assert.equal(
      summary.getAttribute('aria-label'),
      '查看子智能体：3 项进行中，7 项已完成，2 项等待你处理。',
    );
    assert.equal(h.get('.subagents-summary .running').title, '进行中: 3');
    assert.equal(h.get('.subagents-summary .completed').title, '已完成: 7');
  });

  it('pulses only for connected active summary counts and hides the waiting marker at zero', () => {
    const empty = snapshot([]);
    empty.counts = {
      running: 0,
      completed: 0,
      needsAttention: 0,
      failed: 0,
      cancelled: 0,
      interrupted: 0,
    };
    const h = setup({}, { snapshot: empty });
    const summary = h.get('.subagents-summary');
    const point = h.get('.subagents-count-symbol.running');
    assert.equal(summary.classList.contains('running-active'), false);
    assert.equal(h.get('.subagents-summary-waiting').hidden, true);
    h.update({
      snapshot: {
        ...empty,
        counts: { ...empty.counts, running: 2, needsAttention: 1 },
      },
    });
    assert.equal(summary.classList.contains('running-active'), true);
    assert.equal(h.get('.subagents-summary-waiting').hidden, false);
    h.update({ connected: false });
    assert.equal(summary.classList.contains('running-active'), false);
    assert.match(summary.title, /Disconnected/);
    h.update({ connected: true, mode: 'list' });
    assert.equal(summary.classList.contains('running-active'), false);
    h.update({ mode: 'summary' });
    assert.equal(summary.classList.contains('running-active'), true);
    h.update({ snapshot: empty });
    assert.equal(summary.classList.contains('running-active'), false);
    assert.equal(h.get('.subagents-summary-waiting').hidden, true);
    assert.equal(h.get('.subagents-count-symbol.running'), point);
  });

  it('keeps large summary numbers compact while titles, accessibility and list counts stay exact', () => {
    const value = snapshot([]);
    value.counts = {
      ...value.counts,
      running: 1_234_567,
      completed: 9_876_543,
      needsAttention: 456,
    };
    const h = setup({}, { snapshot: value });
    const running = h.get('.subagents-summary [data-count="running"]');
    const completed = h.get('.subagents-summary [data-count="completed"]');
    assert.equal(running.textContent, '999+');
    assert.equal(completed.textContent, '999+');
    assert.equal(running.title, 'Running: 1234567');
    assert.equal(completed.title, 'Completed: 9876543');
    assert.equal(
      h.get('.subagents-summary').getAttribute('aria-label'),
      liveText('en', 'subagents.summaryLabel', {
        running: 1_234_567,
        completed: 9_876_543,
        waiting: 456,
      }),
    );
    h.update({ mode: 'list', language: 'zh-CN' });
    assert.equal(
      h.get('.subagents-panel [data-count="running"]').textContent,
      '1234567',
    );
    assert.equal(
      h.get('.subagents-panel [data-count="completed"]').textContent,
      '9876543',
    );
    assert.equal(
      h.get('.subagents-panel [data-count="needsAttention"]').textContent,
      '456',
    );
  });

  it('uses a gentle 1.4 second opacity pulse and disables it for reduced motion', async () => {
    const css = await readFile(
      new URL('../../renderer/subagents.css', import.meta.url),
      'utf8',
    );
    assert.match(
      css,
      /\.subagents-summary\.running-active \.subagents-count-symbol\.running\s*\{\s*animation: subagents-running-pulse 1\.4s ease-in-out infinite;/,
    );
    assert.match(
      css,
      /@keyframes subagents-running-pulse\s*\{[\s\S]*?opacity: 0\.45;[\s\S]*?opacity: 1;/,
    );
    assert.match(
      css,
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.subagents-summary\.running-active \.subagents-count-symbol\.running\s*\{\s*animation: none;/,
    );
    assert.doesNotMatch(
      css,
      /^\.subagents-count-symbol\.running\s*\{[^}]*animation:/m,
    );
    assert.match(
      css,
      /\.subagents-summary-waiting\s*\{[^}]*position: absolute;/,
    );
  });

  it('reports pointer hover separately from keyboard focus and closes with ordered releases', () => {
    const h = setup();
    const summary = h.get<HTMLButtonElement>('.subagents-summary');
    h.app.dispatchEvent(new h.dom.window.Event('pointerenter'));
    h.app.dispatchEvent(new h.dom.window.Event('pointerleave'));
    summary.focus();
    h.app.dispatchEvent(new h.dom.window.Event('pointerleave'));
    summary.blur();
    assert.deepEqual(h.calls, [
      ['hover', true],
      ['keyboard', false],
      ['hover', false],
      ['keyboard', false],
      ['hover', false],
      ['keyboard', false],
      ['hover', false],
      ['keyboard', false],
      ['hover', false],
      ['keyboard', false],
    ]);
    document.dispatchEvent(
      new h.dom.window.KeyboardEvent('keydown', { key: 'Tab' }),
    );
    summary.focus();
    assert.deepEqual(h.calls.slice(-2), [
      ['hover', false],
      ['keyboard', true],
    ]);
    h.app.dispatchEvent(new h.dom.window.Event('pointerleave'));
    assert.deepEqual(h.calls.slice(-2), [
      ['hover', false],
      ['keyboard', true],
    ]);
    summary.dispatchEvent(
      new h.dom.window.Event('pointerdown', { bubbles: true }),
    );
    assert.deepEqual(h.calls.slice(-2), [
      ['hover', false],
      ['keyboard', false],
    ]);
    document.dispatchEvent(
      new h.dom.window.KeyboardEvent('keydown', { key: 'Escape' }),
    );
    assert.deepEqual(h.calls.slice(-3), [
      ['keyboard', false],
      ['hover', false],
      ['close'],
    ]);
  });

  it('does not retain hidden-list keyboard hover after native blur and summary reopen', () => {
    const h = setup({}, { mode: 'list' });
    document.dispatchEvent(
      new h.dom.window.KeyboardEvent('keydown', { key: 'Tab' }),
    );
    h.get<HTMLButtonElement>('.subagents-close').focus();
    assert.deepEqual(h.calls.slice(-2), [
      ['hover', false],
      ['keyboard', true],
    ]);
    h.dom.window.dispatchEvent(new h.dom.window.Event('blur'));
    assert.deepEqual(h.calls.slice(-2), [
      ['hover', false],
      ['keyboard', false],
    ]);
    h.update({ mode: 'summary' });
    h.app.dispatchEvent(new h.dom.window.Event('pointerenter'));
    h.app.dispatchEvent(new h.dom.window.Event('pointerleave'));
    assert.deepEqual(h.calls.slice(-2), [
      ['hover', false],
      ['keyboard', false],
    ]);
  });

  it('switches the same panel from summary through list and detail and uses Back without closing', async () => {
    const h = setup();
    const summary = h.get<HTMLButtonElement>('.subagents-summary');
    const panel = h.get('.subagents-panel');
    const list = h.get('.subagents-list');
    const row = h.get<HTMLButtonElement>('[data-task-id="task-1"]');
    const back = h.get<HTMLButtonElement>('.subagents-back');
    summary.click();
    await settled();
    assert.deepEqual(h.calls.at(-1), ['expand']);
    assert.equal(panel.hidden, true);
    h.update({ mode: 'list' });
    assert.equal(summary.hidden, true);
    assert.equal(panel.hidden, false);
    assert.equal(back.hidden, true);
    list.scrollTop = 41;
    row.click();
    await settled();
    assert.deepEqual(h.calls.at(-1), ['detail', 'task-1']);
    h.update({ mode: 'detail', selectedId: 'task-1' });
    assert.equal(h.get('.subagents-panel'), panel);
    assert.equal(back.hidden, false);
    assert.equal(list.hidden, true);
    assert.equal(h.get('.subagent-detail-body').hidden, false);
    back.click();
    await settled();
    assert.deepEqual(h.calls.at(-1), ['back']);
    assert.equal(h.state.mode, 'detail');
    h.update({ mode: 'list', selectedId: undefined });
    assert.equal(h.get('.subagents-panel'), panel);
    assert.equal(h.get('.subagents-list'), list);
    assert.equal(h.get('[data-task-id="task-1"]'), row);
    assert.equal(list.scrollTop, 41);
    assert.equal(back.hidden, true);
    assert.equal(
      h.calls.some(([call]) => call === 'close'),
      false,
    );
    h.get<HTMLButtonElement>('.subagents-close').click();
    assert.deepEqual(h.calls.slice(-3), [
      ['keyboard', false],
      ['hover', false],
      ['close'],
    ]);
  });

  it('allows Back from disconnected details while remote task-opening actions remain disabled', async () => {
    const h = setup(
      {},
      {
        mode: 'detail',
        selectedId: 'task-1',
        connected: false,
      },
    );
    h.get<HTMLButtonElement>('.subagents-back').click();
    await settled();
    assert.deepEqual(h.calls, [['back']]);
    h.update({ mode: 'list', selectedId: undefined });
    const row = h.get<HTMLButtonElement>('[data-task-id="task-1"]');
    assert.equal(row.disabled, true);
    row.click();
    h.update({ mode: 'summary' });
    const summary = h.get<HTMLButtonElement>('.subagents-summary');
    assert.equal(summary.disabled, true);
    summary.click();
    await settled();
    assert.deepEqual(h.calls, [['back']]);
  });

  it('keeps task rows, click identity, focus and list scroll stable across updates', async () => {
    const first = task();
    const second = task({
      id: 'task-2',
      title: 'Read docs',
      status: 'completed',
    });
    const h = setup({}, { mode: 'list', snapshot: snapshot([first, second]) });
    const list = h.get('.subagents-list');
    const row = h.get<HTMLButtonElement>('[data-task-id="task-1"]');
    list.scrollTop = 53;
    row.focus();
    h.update({
      language: 'zh-CN',
      snapshot: {
        ...snapshot([
          second,
          { ...first, status: 'waiting', activity: 'Need your input' },
        ]),
        revision: 2,
      },
    });
    assert.equal(h.get('[data-task-id="task-1"]'), row);
    assert.equal(document.activeElement, row);
    assert.equal(list.scrollTop, 53);
    assert.equal(list.firstElementChild?.firstElementChild, row);
    assert.match(row.textContent ?? '', /等待输入/);
    assert.match(row.textContent ?? '', /Need your input/);
    row.click();
    await settled();
    assert.deepEqual(h.calls.at(-1), ['detail', first.id]);
    assert.match(h.get('.subagents-other-counts').textContent ?? '', /1 失败/);
    assert.match(h.get('.subagents-retention').textContent ?? '', /4/);
    h.update({ snapshot: snapshot([second]) });
    assert.equal(h.app.querySelector('[data-task-id="task-1"]'), null);
  });

  it('renders public title, request and output as text, not markup, while localizing owned activity', () => {
    const payload =
      '<img src="https://example.com/x" onerror="alert(1)"><script>bad()</script>';
    const entry = task({
      title: payload,
      request: payload,
      output: payload.repeat(80),
      activity: liveMessage('subagents.reconnecting'),
      events: [
        { at: 1, kind: 'message', text: payload },
        { at: 2, kind: 'status', text: liveMessage('subagents.callEnded') },
      ],
      outputTruncated: true,
    });
    const h = setup(
      {},
      { mode: 'detail', selectedId: entry.id, snapshot: snapshot([entry]) },
    );
    const output = h.get('.subagent-output');
    h.update({ language: 'zh-CN' });
    assert.equal(h.get('.subagent-title').textContent, payload);
    assert.equal(h.get('.subagent-request').textContent, payload);
    assert.equal(output.textContent, payload.repeat(80));
    assert.equal(h.app.querySelector('img, script, a'), null);
    assert.equal(
      h.get('.subagent-latest').textContent,
      liveText('zh-CN', 'subagents.reconnecting'),
    );
    assert.match(h.get('.subagent-events').textContent ?? '', /语音通话已结束/);
    assert.equal(h.get('.subagent-truncated').hidden, false);
    assert.equal(h.get('.subagent-output'), output);
    assert.equal(
      h.app.querySelector('button[data-cancel], button[data-approve]'),
      null,
    );
  });

  it('keeps notification delivery distinct from task completion and preserves exact statuses', () => {
    const entry = task({
      kind: 'proactive',
      status: 'monitoring',
      triggerCount: 3,
      pendingNotifications: 2,
      notification: 'delivered',
      remainingSec: 4.2,
    });
    const h = setup(
      {},
      { mode: 'detail', selectedId: entry.id, snapshot: snapshot([entry]) },
    );
    assert.equal(
      h.get('.subagent-identity .subagent-status').textContent,
      'Monitoring',
    );
    assert.match(
      h.get('.subagent-notifications').textContent ?? '',
      /Triggers: 3/,
    );
    assert.match(
      h.get('.subagent-notifications').textContent ?? '',
      /Pending announcements: 2/,
    );
    assert.match(
      h.get('.subagent-notifications').textContent ?? '',
      /Announcement delivered/,
    );
    assert.match(
      h.get('.subagent-notifications').textContent ?? '',
      /Remaining: 5s/,
    );
    assert.equal(
      h.get('.subagent-section:last-child h2').textContent,
      'Public output',
    );
    for (const status of [
      'completed',
      'failed',
      'cancelled',
      'interrupted',
    ] as const) {
      h.update({ snapshot: snapshot([{ ...entry, status }]) });
      assert.equal(
        h.get('.subagent-identity .subagent-status').textContent,
        liveText('en', `subagents.${status}`),
      );
      assert.equal(
        h.get('.subagent-section:last-child h2').textContent,
        status === 'completed' ? 'Result' : 'Public output',
      );
    }
  });

  it('follows output and activity only from the bottom and retains content and focus on disconnect', () => {
    let entry = task();
    const h = setup(
      {},
      { mode: 'detail', selectedId: entry.id, snapshot: snapshot([entry]) },
    );
    const output = h.get('.subagent-output');
    const events = h.get('.subagent-events');
    const body = h.get('.subagent-detail-body');
    let height = 500;
    for (const node of [output, events, body]) {
      Object.defineProperty(node, 'scrollHeight', {
        configurable: true,
        get: () => height,
      });
      Object.defineProperty(node, 'clientHeight', {
        configurable: true,
        value: 100,
      });
      node.scrollTop = 80;
    }
    output.focus();
    entry = {
      ...entry,
      output: 'more output',
      events: [
        ...entry.events,
        { at: 2, kind: 'message', text: 'more activity' },
      ],
    };
    h.update({ snapshot: snapshot([entry]) });
    for (const node of [output, events, body]) assert.equal(node.scrollTop, 80);
    assert.equal(document.activeElement, output);
    for (const node of [output, events, body]) node.scrollTop = 400;
    entry = {
      ...entry,
      output: 'even more output',
      updatedAt: entry.updatedAt + 1000,
    };
    h.update({ snapshot: snapshot([entry]) });
    for (const node of [output, events, body])
      assert.equal(node.scrollTop, height);
    height = 600;
    h.update({ connected: false });
    assert.equal(h.get('.subagents-notice').hidden, false);
    assert.match(h.get('.subagents-notice').textContent ?? '', /Disconnected/);
    assert.equal(output.textContent, 'even more output');
    assert.equal(document.activeElement, output);
    h.update({
      connected: true,
      selectedId: undefined,
      snapshot: snapshot([]),
    });
    assert.equal(h.get('.subagent-detail-body').hidden, true);
    assert.match(h.get('.subagents-empty').textContent ?? '', /no longer/);
  });

  it('handles empty, unsupported and missing-task states without inventing entries', () => {
    const h = setup({}, { mode: 'list', snapshot: snapshot([]) });
    assert.equal(h.get('.subagents-empty').hidden, false);
    assert.match(
      h.get('.subagents-empty').textContent ?? '',
      /No task details/,
    );
    assert.match(
      h.get('.subagents-retention').textContent ?? '',
      /4 other tasks/,
    );
    h.update({
      snapshot: {
        ...snapshot([]),
        omitted: 0,
        counts: {
          running: 0,
          completed: 0,
          needsAttention: 0,
          failed: 0,
          cancelled: 0,
          interrupted: 0,
        },
      },
    });
    assert.match(
      h.get('.subagents-empty').textContent ?? '',
      /No subagent tasks/,
    );
    assert.equal(h.app.querySelector('[data-task-id]'), null);
    h.update({ snapshot: undefined });
    assert.match(h.get('.subagents-empty').textContent ?? '', /unavailable/);
    h.update({ mode: 'summary' });
    assert.equal(h.get<HTMLButtonElement>('.subagents-summary').disabled, true);
    h.update({ mode: 'detail', selectedId: 'unknown' });
    assert.match(h.get('.subagents-empty').textContent ?? '', /no longer/);
    h.get<HTMLButtonElement>('.subagents-close').click();
    assert.deepEqual(h.calls.at(-1), ['close']);
  });

  it('shows failed opens, suppresses duplicate actions, and does not reopen after close', async () => {
    let rejectOpen: (error: Error) => void = () => {};
    let openings = 0;
    const h = setup({
      expand: () => {
        openings++;
        return new Promise<void>((_resolve, reject) => {
          rejectOpen = reject;
        });
      },
    });
    const summary = h.get<HTMLButtonElement>('.subagents-summary');
    summary.click();
    summary.click();
    assert.equal(openings, 1);
    rejectOpen(new Error(liveMessage('subagents.openFailed')));
    await settled();
    assert.equal(summary.disabled, false);
    assert.equal(h.get('.subagents-summary-error').hidden, false);
    h.update({ language: 'zh-CN' });
    assert.equal(
      h.get('.subagents-summary-error').textContent,
      liveText('zh-CN', 'subagents.openFailed'),
    );
    summary.click();
    document.dispatchEvent(
      new h.dom.window.KeyboardEvent('keydown', { key: 'Escape' }),
    );
    rejectOpen(new Error('late failure'));
    await settled();
    assert.deepEqual(h.calls.at(-1), ['close']);
    assert.equal(h.app.textContent?.includes('late failure'), false);
  });

  it('isolates media and scripts and makes expanded-panel headers draggable without dragging controls', async () => {
    const [html, css] = await Promise.all([
      readFile(
        new URL('../../renderer/subagents.html', import.meta.url),
        'utf8',
      ),
      readFile(
        new URL('../../renderer/subagents.css', import.meta.url),
        'utf8',
      ),
    ]);
    assert.match(html, /connect-src 'none'; media-src 'none'/);
    assert.match(html, /script-src 'self'/);
    assert.match(css, /\.subagents-header\s*\{\s*-webkit-app-region: drag;/);
    assert.match(css, /button\s*\{[^}]*-webkit-app-region: no-drag;/);
    assert.match(css, /\.subagent-output\s*\{[^}]*overflow-y: auto;/);
    assert.match(css, /\.subagent-task-title\s*\{[^}]*height: 36px;/);
    assert.match(css, /\.subagent-task-activity\s*\{[^}]*height: 34px;/);
    assert.match(
      css,
      /\.subagent-task > \.subagent-status\s*\{[^}]*max-height: 36px;/,
    );
  });
});
