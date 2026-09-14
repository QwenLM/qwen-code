import { expect, test, type Page } from '@playwright/test';
import type { ThreadDetailView } from '../components/workspace-agents/ThreadView';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';

async function openChat(page: Page, id: string, cwd: string) {
  await page.addInitScript(
    ({ id, cwd }) => {
      sessionStorage.setItem(
        'qwen:team-conversation',
        JSON.stringify({
          id,
          cwd,
          server: location.origin,
        }),
      );
    },
    { id, cwd },
  );
  await page.goto('/?language=en');
}

async function send(page: Page, text: string) {
  const editor = page.locator(
    '[data-web-shell-composer-editor]:visible .cm-content',
  );
  await editor.fill(text);
  await page.locator('[data-web-shell-composer-submit]:visible').click();
}

test('mesh shows growing replies before completion, survives reload, and replaces the preview once', async ({
  page,
}, info) => {
  const scenario = createWebShellDaemonScenario({
    capabilities: { features: ['session_events', 'agent_collaboration_v1'] },
  });
  await installMockDaemon(page, scenario, {
    baseURL: String(info.project.use.baseURL),
  });
  const thread: ThreadDetailView = {
    id: 'mesh-stream-e2e',
    title: 'Mesh streaming regression',
    body: '',
    status: 'open',
    reason: 'Waiting for a message',
    posts: [],
    runs: [],
    budget: { turnsUsed: 0, turnLimit: 12, tokensUsed: 0, tokenLimit: 10000 },
  };
  const agent = {
    id: 'ag_stream',
    name: 'stream-worker',
    enabled: true,
    status: 'offline',
    runtime: { label: 'Demo-Host', status: 'offline' },
  };
  let sent = 0;
  let releaseReply!: () => void;
  const replyGate = new Promise<void>((resolve) => {
    releaseReply = resolve;
  });
  await page.route('**/workspaces/*/agent/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/agents'))
      return route.fulfill({ json: { agents: [agent] } });
    if (pathname.endsWith('/preview'))
      return route.fulfill({ json: { targets: [] } });
    if (pathname.endsWith('/posts') && route.request().method() === 'POST') {
      const { text } = route.request().postDataJSON();
      expect(text).toBe('@stream-worker Please explain streaming.');
      sent++;
      await replyGate;
      thread.posts = [
        {
          id: 'human-1',
          sequence: 1,
          authorKind: 'human',
          authorName: 'user',
          text,
          at: Date.now(),
        },
      ];
      thread.status = 'in_progress';
      thread.runs = [
        {
          id: 'run-stream',
          agentId: agent.id,
          agentName: agent.name,
          status: 'queued',
          closeAcknowledged: false,
          trigger: 'mentioned by you',
          startedAt: Date.now(),
          progress: {
            receivedAt: Date.now(),
            activityAt: Date.now(),
            stage: 'thinking',
            detail: 'Qwen Code 正在思考',
          },
        },
      ];
      return route.fulfill({ json: { outcomes: [] } });
    }
    if (pathname.endsWith(`/threads/${thread.id}`))
      return route.fulfill({ json: thread });
    if (pathname.endsWith('/threads'))
      return route.fulfill({
        json: {
          threads: [
            {
              ...thread,
              updatedAt: Date.now(),
              liveRunCount: thread.status === 'in_progress' ? 1 : 0,
            },
          ],
        },
      });
    throw new Error(
      `Unexpected mesh request: ${route.request().method()} ${pathname}`,
    );
  });
  await openChat(page, thread.id, scenario.workspaceCwd);
  await expect(page.getByTestId('chat-context-header')).toContainText(
    thread.title,
  );
  await expect(
    page.getByRole('button', { name: '任务详情', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Task details', exact: true }),
  ).toHaveCount(0);
  await send(page, '@stream-worker Please explain streaming.');
  await expect.poll(() => sent).toBe(1);
  await expect(
    page.getByRole('status').filter({ hasText: '正在发送消息…' }),
  ).toBeVisible();
  releaseReply();
  await expect(
    page.getByRole('status').filter({ hasText: 'stream-worker 执行主机离线' }),
  ).toBeVisible();
  const activity = page.getByRole('region', {
    name: '智能体运行详情',
    exact: true,
  });
  await expect(activity).toHaveCount(0);
  await page.getByRole('button', { name: '运行详情', exact: true }).click();
  await expect(
    page.getByRole('tab', { name: '运行详情', exact: true }),
  ).toBeVisible();
  await expect(activity).toContainText('Demo-Host 离线');
  const run = thread.runs[0];
  agent.status = 'idle';
  agent.runtime.status = 'online';
  run.status = 'running';
  const initialProgress = run.progress!;
  run.progress = undefined;
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'stream-worker 等待执行端确认…' }),
  ).toBeVisible();
  await expect(activity).toContainText('等待执行端确认');
  await expect(activity).not.toContainText('暂无过程上报');
  await expect(activity).not.toContainText('思考中');
  run.progress = {
    ...initialProgress,
    stage: 'starting',
    receivedAt: Date.now(),
  };
  const starting = page.getByRole('status').filter({
    hasText: 'stream-worker 正在启动…',
  });
  await expect(starting).toBeVisible();
  await page
    .getByRole('button', { name: 'Close 运行详情', exact: true })
    .click();
  await expect(activity).toBeHidden();
  await expect(starting).toBeVisible();
  await page.getByRole('button', { name: '运行详情', exact: true }).click();
  await expect(activity).toBeVisible();
  run.progress = { ...run.progress, stage: 'resuming' };
  await expect(activity).toContainText('继续会话中');
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'stream-worker 正在继续原会话…' }),
  ).toBeVisible();
  run.progress = { ...run.progress, stage: 'thinking' };
  await expect(activity).toContainText('思考中');
  await expect(starting).toHaveCount(0);
  for (const thought of [
    'Checking the task.',
    'Checking the task. Choosing a collaborator.',
  ]) {
    run.progress = { ...run.progress!, thoughtText: thought };
    await expect(activity).toContainText(thought);
  }
  await page.reload();
  await page.getByRole('button', { name: '运行详情', exact: true }).click();
  await expect(activity).toContainText(
    'Checking the task. Choosing a collaborator.',
  );
  const transcript = page.locator('[data-web-shell-message-list]:visible');
  await page
    .getByRole('button', { name: 'Close 运行详情', exact: true })
    .click();
  for (const text of ['First fragment.', 'First fragment. Second fragment.']) {
    run.progress = {
      ...run.progress,
      receivedAt: Date.now(),
      activityAt: Date.now(),
      stage: 'responding',
      detail: '正在回复',
      outputText: text,
    };
    await expect(transcript).toContainText(text);
    expect(run.status).toBe('running');
    expect(thread.posts).toHaveLength(1);
  }
  await expect(activity).toBeHidden();
  await page.getByRole('button', { name: '运行详情', exact: true }).click();
  await page.screenshot({ path: info.outputPath('01-growing.png') });
  await page.reload();
  await page.getByRole('button', { name: '运行详情', exact: true }).click();
  await expect(transcript).toContainText('First fragment. Second fragment.');
  expect(sent).toBe(1);
  run.progress = { ...run.progress!, receivedAt: Date.now() - 25000 };
  await expect(activity).toContainText('连接中断待确认');
  await expect(transcript).toContainText('First fragment. Second fragment.');
  run.status = 'completed';
  run.closeKind = 'review';
  thread.status = 'in_review';
  thread.posts = [
    ...thread.posts,
    {
      id: 'final-1',
      sequence: 2,
      sourceRunId: run.id,
      authorKind: 'agent',
      authorName: agent.name,
      text: 'First fragment. Second fragment.',
      at: Date.now(),
    },
  ];
  await expect(
    transcript.getByText('First fragment. Second fragment.', { exact: true }),
  ).toHaveCount(1);
  await expect(page.getByRole('button', { name: '验收并完成' })).toBeVisible();
  await page.reload();
  await expect(
    transcript.getByText('First fragment. Second fragment.', { exact: true }),
  ).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('02-completed.png') });
});

test('mesh real Host streams into the browser @mesh-live', async ({
  page,
  request,
}, info) => {
  const cwd = process.env['MESH_E2E_CWD'];
  const name = process.env['MESH_E2E_AGENT'];
  test.skip(
    !cwd && !name,
    'Opt in with MESH_E2E_CWD and an existing MESH_E2E_AGENT; uses real model credits.',
  );
  expect(cwd, 'MESH_E2E_CWD is required for live mode').toBeTruthy();
  expect(name, 'MESH_E2E_AGENT is required for live mode').toBeTruthy();
  test.setTimeout(180000);
  const prefix = `/workspaces/${encodeURIComponent(cwd!)}/agent`;
  const agentsResponse = await request.get(`${prefix}/agents`);
  expect(
    agentsResponse.ok(),
    'Start a collaboration-enabled loopback daemon and connect an online Host first',
  ).toBeTruthy();
  const { agents } = await agentsResponse.json();
  expect(
    agents.some(
      (agent: { name: string; enabled: boolean; retiredAt?: number }) =>
        agent.name === name && agent.enabled && !agent.retiredAt,
    ),
  ).toBeTruthy();
  const created = await request.post(`${prefix}/threads`, {
    data: { title: `E2E live stream ${new Date().toISOString()}`, body: '' },
  });
  expect(created.ok()).toBeTruthy();
  const { id } = await created.json();
  await info.attach('created-thread', {
    body: JSON.stringify({ id, cwd }),
    contentType: 'application/json',
  });
  try {
    await openChat(page, id, cwd!);
    await page.getByRole('button', { name: '运行详情', exact: true }).click();
    await send(
      page,
      `@${name} Do not inspect or change files, run commands, or browse the web. Explain the water cycle in one plain-text paragraph of about 400 words. No Markdown, lists, numbering, headings or formatting. Stream your answer as text. If thread_review is available, you MUST then call thread_review with that answer as the summary to hand it back for review; this collaboration closing tool is explicitly allowed.`,
    );
    const transcript = page.locator('[data-web-shell-message-list]:visible');
    const replies = transcript.locator('[data-web-shell-message-row]').filter({
      has: page.locator('strong').filter({ hasText: name! }),
    });
    const samples: { elapsedMs: number; chars: number }[] = [];
    const thoughtSamples: { elapsedMs: number; chars: number }[] = [];
    const started = Date.now();
    let finalText = '';
    await expect
      .poll(
        async () => {
          const response = await request.get(`${prefix}/threads/${id}`);
          expect(response.ok()).toBeTruthy();
          const detail: ThreadDetailView = await response.json();
          const run = detail.runs[0];
          if (!run) return false;
          expect(
            ['failed', 'cancelled'].includes(run.status),
            JSON.stringify(run),
          ).toBe(false);
          const text = run.progress?.outputText ?? '';
          const thought = run.progress?.thoughtText ?? '';
          if (
            run.status === 'running' &&
            thought.length > (thoughtSamples.at(-1)?.chars ?? 0)
          ) {
            const activity = page.getByRole('region', {
              name: '智能体运行详情',
              exact: true,
            });
            await expect(activity).toContainText(thought.slice(-80));
            thoughtSamples.push({
              elapsedMs: Date.now() - started,
              chars: thought.length,
            });
            if (thoughtSamples.length === 1)
              await page.screenshot({
                path: info.outputPath('live-thinking.png'),
              });
          }
          if (
            run.status === 'running' &&
            text.length > (samples.at(-1)?.chars ?? 0)
          ) {
            await expect(replies).toContainText(text.slice(-80));
            samples.push({
              elapsedMs: Date.now() - started,
              chars: text.length,
            });
            if (samples.length === 1) {
              await page.screenshot({
                path: info.outputPath('live-growing.png'),
              });
              await page.reload();
              await expect(replies).toContainText(text.slice(-80));
            }
          }
          if (run.status !== 'completed') return false;
          const finals = detail.posts.filter(
            (post) => post.sourceRunId === run.id,
          );
          expect(finals).toHaveLength(1);
          finalText = finals[0].text;
          return true;
        },
        { timeout: 150000, intervals: [500] },
      )
      .toBe(true);
    expect(
      samples.length,
      'Must see growing browser output before completion, not just a final result',
    ).toBeGreaterThanOrEqual(2);
    await page.reload();
    await expect(replies).toContainText(finalText.slice(-80));
    await expect(replies).toHaveCount(1);
    await info.attach('live-observations', {
      body: JSON.stringify(
        { thoughts: thoughtSamples, replies: samples },
        null,
        2,
      ),
      contentType: 'application/json',
    });
    await page.screenshot({ path: info.outputPath('live-completed.png') });
  } finally {
    // Preserve this test's conversation for inspection; stop only its active work.
    const response = await request.get(`${prefix}/threads/${id}`);
    if (response.ok()) {
      const detail: ThreadDetailView = await response.json();
      for (const run of detail.runs.filter((run) =>
        ['queued', 'running'].includes(run.status),
      )) {
        const cancelled = await request.post(
          `${prefix}/threads/${id}/runs/${run.id}/cancel`,
          { data: {} },
        );
        expect(
          cancelled.ok(),
          `Could not cancel E2E run ${run.id}`,
        ).toBeTruthy();
      }
    }
  }
});
