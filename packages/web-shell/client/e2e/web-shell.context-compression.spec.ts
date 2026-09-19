import { expect, test } from '@playwright/test';
import type { DaemonSessionContextUsageStatus } from '@qwen-code/sdk/daemon';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  turnCompleteEvent,
} from './utils/mockDaemon';

for (const theme of ['light', 'dark']) {
  test(`@smoke manual context compression refreshes live usage and preserves snapshots in ${theme}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const scenario = createWebShellDaemonScenario({
      supportedCommands: {
        availableCommands: [
          {
            name: 'compress',
            description: 'Compress context',
            input: null,
            _meta: { source: 'builtin-command' },
          },
        ],
      },
      state: {
        models: {
          currentModelId: 'qwen-test',
          availableModels: [
            { modelId: 'qwen-test', name: 'Qwen Test', contextLimit: 100_000 },
          ],
        },
      },
    });
    const daemon = await installMockDaemon(page, scenario, {
      baseURL: String(testInfo.project.use.baseURL),
    });
    let used = 64_000;
    let readFails = false;
    let reads = 0;
    const submitted: unknown[] = [];
    const reading = (detail: boolean): DaemonSessionContextUsageStatus => ({
      v: 1,
      sessionId: scenario.sessionId,
      workspaceCwd: scenario.workspaceCwd,
      formattedText: '',
      usage: {
        modelName: 'Qwen Test',
        totalTokens: used,
        contextWindowSize: 100_000,
        breakdown: {
          systemPrompt: 5_000,
          builtinTools: 5_000,
          mcpTools: 0,
          memoryFiles: 0,
          skills: 0,
          messages: used - 10_000,
          freeSpace: 90_000 - used,
          autocompactBuffer: 10_000,
        },
        builtinTools: [{ name: 'read_file', tokens: 5_000 }],
        mcpTools: [],
        memoryFiles: [],
        skills: [],
        showDetails: detail,
      },
    });
    await page.route(/\/session\/[^/]+\/context-usage(?:\?|$)/, (route) => {
      reads++;
      return readFails
        ? route.fulfill({
            status: 503,
            json: { error: 'Temporary usage read failure' },
          })
        : route.fulfill({
            json: reading(
              new URL(route.request().url()).searchParams.get('detail') ===
                'true',
            ),
          });
    });
    await page.route(/\/session\/[^/]+\/prompt$/, (route) => {
      submitted.push(route.request().postDataJSON());
      return route.fulfill({
        status: 202,
        json: { promptId: `compression-${submitted.length}`, lastEventId: 20 },
      });
    });
    await page.goto(`/session/${scenario.sessionId}?theme=${theme}`);
    await daemon.sse.waitForConnection(scenario.sessionId);
    await daemon.sendEvent(
      replayCompleteEvent({ sessionId: scenario.sessionId }),
    );
    await daemon.sendEvent({
      id: 20,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '' },
          _meta: { usage: { inputTokens: used } },
        },
      },
    });
    const ring = page.locator('[data-web-shell-context-usage]');
    await expect(ring).toHaveAttribute('aria-label', '64.0% context used');
    await ring.click();
    const historical = page
      .getByRole('group', { name: 'Context Usage', exact: true })
      .first();
    await expect(historical).toContainText('Snapshot');
    const snapshotMeter = historical.locator('[data-web-shell-context-meter]');
    await expect(snapshotMeter).toBeVisible();
    const readsBeforeCollapse = reads;
    await historical
      .getByRole('button', { name: 'Collapse', exact: true })
      .click();
    await expect(snapshotMeter).toBeHidden();
    await expect(historical).toHaveText('Context Usage Snapshot', {
      useInnerText: true,
    });
    const expandSnapshot = historical.getByRole('button', {
      name: 'Expand',
      exact: true,
    });
    await expect(expandSnapshot).toHaveAttribute('aria-expanded', 'false');
    await historical.screenshot({
      path: testInfo.outputPath(`context-snapshot-collapsed-${theme}.png`),
    });
    await expandSnapshot.press('Enter');
    await expect(snapshotMeter).toBeVisible();
    const collapseSnapshot = historical.getByRole('button', {
      name: 'Collapse',
      exact: true,
    });
    await expect(collapseSnapshot).toHaveAttribute('aria-expanded', 'true');
    await historical.screenshot({
      path: testInfo.outputPath(`context-snapshot-expanded-${theme}.png`),
    });
    await collapseSnapshot.press('Space');
    await expect(snapshotMeter).toBeHidden();
    await expandSnapshot.click();
    await expect(snapshotMeter).toBeVisible();
    expect(reads).toBe(readsBeforeCollapse);
    const editor = page.locator(
      '[data-web-shell-composer-surface] .cm-content[contenteditable="true"]',
    );
    await editor.click();
    await editor.fill('Keep this draft while compressing');
    const readsBeforeHover = reads;
    await ring.hover();
    const hover = page.locator('[data-web-shell-context-popover]');
    await expect(hover).toBeVisible();
    await expect(hover).toContainText('36,000 tokens');
    await expect(editor).toBeFocused();
    expect(reads).toBe(readsBeforeHover);
    expect(submitted).toHaveLength(0);
    await hover.hover();
    await page.mouse.move(5, 5);
    await expect(hover).not.toBeVisible();
    await expect(editor).toBeFocused();
    await ring.hover();
    await expect(hover).toBeVisible();
    await ring.focus();
    await ring.press('Escape');
    await ring.press('ArrowDown');
    const firstAction = hover.getByRole('button', {
      name: 'Compress context',
      exact: true,
    });
    const secondAction = hover.getByRole('button', {
      name: 'View details',
      exact: true,
    });
    await expect(firstAction).toBeFocused();
    await firstAction.press('Tab');
    await expect(secondAction).toBeFocused();
    await secondAction.press('Tab');
    await expect(firstAction).toBeFocused();
    await firstAction.press('Shift+Tab');
    await expect(secondAction).toBeFocused();
    await secondAction.press('Shift+Tab');
    await expect(firstAction).toBeFocused();
    expect(
      daemon.requests.filter((request) =>
        request.path.endsWith('/approval-mode'),
      ),
    ).toHaveLength(0);
    await firstAction.press('Escape');
    await editor.click();
    await expect(hover).not.toBeVisible();
    await expect(editor).toBeFocused();
    await ring.hover();
    await ring.focus();
    await ring.press('ArrowDown');
    await firstAction.press('Tab');
    await secondAction.press('Enter');
    await expect(hover).not.toBeVisible();
    await expect(ring).toBeFocused();
    await expect(
      page
        .getByRole('group', { name: 'Context Usage', exact: true })
        .filter({ hasText: 'Snapshot' }),
    ).toHaveCount(1);
    const panel = page.locator('[class*="panel"][aria-busy]');
    const feedbackColor =
      theme === 'dark' ? 'rgb(160, 160, 160)' : 'rgb(95, 98, 89)';
    const errorColor =
      theme === 'dark' ? 'rgb(252, 129, 129)' : 'rgb(192, 54, 44)';
    const compress = panel.getByRole('button', {
      name: 'Compress context',
      exact: true,
    });
    await expect(compress).toBeEnabled();
    await ring.focus();
    await ring.press('ArrowDown');
    const hoverCompress = hover.getByRole('button', {
      name: 'Compress context',
      exact: true,
    });
    await expect(hoverCompress).toBeFocused();
    await hoverCompress.press('Escape');
    await expect(hover).not.toBeVisible();
    await expect(ring).toBeFocused();
    await ring.press('ArrowDown');
    await expect(hoverCompress).toBeFocused();
    await page.evaluate(() => {
      window.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          document.body.dataset.contextHostEnter = 'true';
        }
      });
    });
    await hoverCompress.press('Enter');
    await expect(hover).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(secondAction).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(secondAction).toBeFocused();
    await hover.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('body')).not.toHaveAttribute(
      'data-context-host-enter',
      'true',
    );
    await expect.poll(() => submitted.length).toBe(1);
    expect(submitted[0]).toMatchObject({
      prompt: [{ type: 'text', text: '/compress' }],
    });
    await expect(
      panel.getByRole('button', { name: 'Compressing…', exact: true }),
    ).toBeDisabled();
    await expect(
      hover.getByRole('button', { name: 'Compressing…', exact: true }),
    ).toBeDisabled();
    await expect(
      panel.getByRole('button', { name: 'Refresh', exact: true }),
    ).toBeDisabled();
    await expect(editor).toHaveText('Keep this draft while compressing');
    await expect(panel.getByRole('status')).toHaveCSS('color', feedbackColor);
    await expect(hover.getByRole('status')).toHaveCSS('color', feedbackColor);
    await page.screenshot({
      path: testInfo.outputPath(`context-compressing-${theme}.png`),
    });
    used = 20_000;
    const readsBeforeCompletion = reads;
    // Deliberately no usage event: /compress emits text, so the completion
    // read must be responsible for reconciling the composer ring.
    await daemon.sendEvent(
      turnCompleteEvent('compression-1', {
        id: 30,
        sessionId: scenario.sessionId,
      }),
    );
    await expect(panel).toContainText(
      'Compression completed. Context usage refreshed.',
    );
    await expect(panel.getByRole('status')).toHaveCSS('color', feedbackColor);
    await expect(hover.getByRole('status')).toHaveCSS('color', feedbackColor);
    await expect.poll(() => reads).toBeGreaterThan(readsBeforeCompletion);
    await expect(ring).toHaveAttribute('aria-label', '20.0% context used');
    await expect(hover).toContainText('20,000 tokens');
    await expect(hover).toContainText(
      'Compression completed. Context usage refreshed.',
    );
    await expect(panel).toContainText('Remaining 80.0k');
    await expect(historical.locator('[class*="percentage"]')).toHaveText(
      '64.0%',
    );
    await expect(editor).toHaveText('Keep this draft while compressing');
    await expect(compress).toBeEnabled();
    await page.screenshot({
      path: testInfo.outputPath(`context-compressed-${theme}.png`),
    });

    await hover
      .getByRole('button', { name: 'View details', exact: true })
      .click();
    await compress.click();
    await expect.poll(() => submitted.length).toBe(2);
    await ring.hover();
    await expect(hover).toHaveAttribute('data-state', 'open');
    await expect(
      hover.getByRole('button', { name: 'Compressing…', exact: true }),
    ).toBeDisabled();
    await daemon.sendEvent({
      id: 40,
      v: 1,
      type: 'turn_error',
      data: {
        sessionId: scenario.sessionId,
        promptId: 'compression-2',
        message: 'Provider compression failed',
        code: 'internal_error',
      },
    });
    await expect(panel.getByRole('alert')).toHaveText(
      'Compression failed. You can try again.',
    );
    await expect(panel.getByRole('alert')).toHaveCSS('color', errorColor);
    await expect(hover.getByRole('alert')).toHaveText(
      'Compression failed. You can try again.',
    );
    await expect(hover.getByRole('alert')).toHaveCSS('color', errorColor);
    await hover
      .getByRole('button', { name: 'View details', exact: true })
      .click();
    await expect(compress).toBeEnabled();
    await expect(ring).toHaveAttribute('aria-label', '20.0% context used');

    await compress.click();
    await expect.poll(() => submitted.length).toBe(3);
    used = 15_000;
    readFails = true;
    await daemon.sendEvent(
      turnCompleteEvent('compression-3', {
        id: 50,
        sessionId: scenario.sessionId,
      }),
    );
    await expect(panel.getByRole('alert')).toContainText(
      'Compression completed, but usage could not be refreshed.',
    );
    await expect(panel.getByRole('alert')).toHaveCSS('color', errorColor);
    await expect(ring).toHaveAttribute('aria-label', '20.0% context used');
    readFails = false;
    await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(ring).toHaveAttribute('aria-label', '15.0% context used');
    await expect(panel).toContainText('Remaining 85.0k');
    expect(submitted).toHaveLength(3);
    await expect(historical.locator('[class*="percentage"]')).toHaveText(
      '64.0%',
    );
  });
}

for (const key of ['Enter', 'Space']) {
  test(`@smoke context card keeps a settled btw answer when activated with ${key}`, async ({
    page,
  }, testInfo) => {
    const answer = 'Keep this side answer while managing context.';
    const scenario = createWebShellDaemonScenario({
      btwAnswer: answer,
      supportedCommands: {
        availableCommands: [
          {
            name: 'compress',
            description: 'Compress context',
            input: null,
            _meta: { source: 'builtin-command' },
          },
        ],
      },
    });
    const daemon = await installMockDaemon(page, scenario, {
      baseURL: String(testInfo.project.use.baseURL),
    });
    const submitted: unknown[] = [];
    await page.route(/\/session\/[^/]+\/prompt$/, (route) => {
      submitted.push(route.request().postDataJSON());
      return route.fulfill({
        status: 202,
        json: { promptId: 'btw-compression', lastEventId: 20 },
      });
    });
    await page.goto(`/session/${scenario.sessionId}`);
    await daemon.sse.waitForConnection(scenario.sessionId);
    await daemon.sendEvent(
      replayCompleteEvent({ sessionId: scenario.sessionId }),
    );
    await daemon.sendEvent({
      id: 20,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '' },
          _meta: { usage: { inputTokens: 10_000 } },
        },
      },
    });
    const editor = page.locator(
      '[data-web-shell-composer-surface] .cm-content[contenteditable="true"]',
    );
    await editor.fill('/btw keep this answer');
    await editor.press('Enter');
    await expect(page.getByText(answer, { exact: true })).toBeVisible();
    await expect(editor.locator('.cm-placeholder')).toBeVisible();
    const ring = page.locator('[data-web-shell-context-usage]');
    const card = page.locator('[data-web-shell-context-popover]');
    const compress = card.getByRole('button', {
      name: 'Compress context',
      exact: true,
    });
    await ring.focus();
    await ring.press('ArrowDown');
    await expect(compress).toBeFocused();
    await compress.press('Escape');
    await expect(card).not.toBeVisible();
    await expect(ring).toBeFocused();
    await expect(page.getByText(answer, { exact: true })).toBeVisible();
    await ring.press('ArrowDown');
    await expect(compress).toBeFocused();
    await compress.press(key);
    await expect.poll(() => submitted.length).toBe(1);
    expect(submitted[0]).toMatchObject({
      prompt: [{ type: 'text', text: '/compress' }],
    });
    await expect(page.getByText(answer, { exact: true })).toBeVisible();
    await expect(card).toBeFocused();
    await page.keyboard.press(key);
    expect(submitted).toHaveLength(1);
    await expect(page.getByText(answer, { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(card).not.toBeVisible();
    await expect(ring).toBeFocused();
  });
}

test('@smoke a compression outcome replaces the daemon sentence and refreshes the ring', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    supportedCommands: {
      availableCommands: [
        {
          name: 'compress',
          description: 'Compress context',
          input: null,
          _meta: { source: 'builtin-command' },
        },
      ],
    },
    state: {
      models: {
        currentModelId: 'qwen-test',
        availableModels: [
          { modelId: 'qwen-test', name: 'Qwen Test', contextLimit: 100_000 },
        ],
      },
    },
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  let used = 64_000;
  let reads = 0;
  const reading = (): DaemonSessionContextUsageStatus => ({
    v: 1,
    sessionId: scenario.sessionId,
    workspaceCwd: scenario.workspaceCwd,
    formattedText: '',
    usage: {
      modelName: 'Qwen Test',
      totalTokens: used,
      contextWindowSize: 100_000,
      breakdown: {
        systemPrompt: 5_000,
        builtinTools: 5_000,
        mcpTools: 0,
        memoryFiles: 0,
        skills: 0,
        messages: used - 10_000,
        freeSpace: 90_000 - used,
        autocompactBuffer: 10_000,
      },
      builtinTools: [],
      mcpTools: [],
      memoryFiles: [],
      skills: [],
      showDetails: false,
    },
  });
  await page.route(/\/session\/[^/]+\/context-usage(?:\?|$)/, (route) => {
    reads++;
    return route.fulfill({ json: reading() });
  });
  const slashCommandChunk = (
    id: number,
    text: string,
    meta: Record<string, unknown>,
  ) => ({
    id,
    v: 1,
    type: 'session_update',
    data: {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
        _meta: { source: 'slash_command', ...meta },
      },
    },
  });
  await page.goto(`/session/${scenario.sessionId}`);
  await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: scenario.sessionId }),
  );
  await daemon.sendEvent({
    id: 20,
    v: 1,
    type: 'session_update',
    data: {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '' },
        _meta: { usage: { inputTokens: used } },
      },
    },
  });
  const ring = page.locator('[data-web-shell-context-usage]');
  await expect(ring).toHaveAttribute('aria-label', '64.0% context used');

  // Two commands are two turns in production, and the frames of one turn share
  // the record the daemon recorded them under: the reducer splits blocks on a
  // change in that identity (a successful turn_complete normalizes to nothing).
  // Held as one block instead, the fast no-op would overwrite the result payload
  // in place and the result row would only exist between the two commands.
  const compressRecord = {
    qwenTranscript: { sourceRecordIds: ['record-compress'] },
  };
  const compressFastRecord = {
    qwenTranscript: { sourceRecordIds: ['record-compress-fast'] },
  };
  await daemon.sendEvent(
    slashCommandChunk(
      29,
      'Compression instructions were truncated to 2000 characters.',
      {
        ...compressRecord,
        // Its own key, so folding this turn into one block cannot overwrite it
        // with the compression payload that follows.
        contextCompressionNotice: { phase: 'notice', instructionsLimit: 2000 },
      },
    ),
  );
  await daemon.sendEvent(
    slashCommandChunk(30, 'Compressing context...', {
      ...compressRecord,
      contextCompression: { phase: 'progress' },
    }),
  );
  await expect(
    page.getByText(
      'Compression instructions were truncated to 2,000 characters.',
    ),
  ).toBeVisible();
  // The compression reports itself in the conversation while it runs, in the
  // client's own language rather than with the daemon's sentence.
  await expect(page.getByText('Compressing…')).toBeVisible();
  await expect(page.getByText('Compressing context...')).toHaveCount(0);

  used = 20_000;
  await daemon.sendEvent(
    slashCommandChunk(31, 'Context compressed (263195 -> ~99799).', {
      ...compressRecord,
      contextCompression: {
        phase: 'done',
        originalTokenCount: 263_195,
        newTokenCount: 99_799,
        originalTokenCountIsEstimated: false,
        newTokenCountIsEstimated: true,
      },
    }),
  );

  // The result replaces that same row: the client renders the payload in its own
  // language, and the daemon's English sentence stays on the wire only for hosts
  // that render text as-is.
  await expect(
    page.getByText('Context compressed 263,195 → ~99,799'),
  ).toBeVisible();
  await expect(page.getByText('Compressing…')).toHaveCount(0);
  await expect(
    page.getByText('Context compressed (263195 -> ~99799).'),
  ).toHaveCount(0);
  // The notice is its own row and survives the result it precedes.
  await expect(
    page.getByText(
      'Compression instructions were truncated to 2,000 characters.',
    ),
  ).toBeVisible();
  // The daemon emits no usage frame for a compression, so the transcript
  // outcome is what reconciles the composer ring.
  await expect.poll(() => reads).toBeGreaterThan(0);
  await expect(ring).toHaveAttribute('aria-label', '20.0% context used');
  // `/compress-fast` with nothing to strip ends on a terminal no-op: the same
  // row flips to the outcome instead of staying on the pending copy and being
  // dropped once the turn's block stops streaming.
  await daemon.sendEvent(
    slashCommandChunk(32, 'Compressing context (fast)...', {
      ...compressFastRecord,
      contextCompression: { phase: 'progress' },
    }),
  );
  await expect(page.getByText('Compressing…')).toBeVisible();
  await daemon.sendEvent(
    slashCommandChunk(33, 'No compression needed.', {
      ...compressFastRecord,
      contextCompression: { phase: 'noop' },
    }),
  );
  await daemon.sendEvent(
    turnCompleteEvent('compression-4', { sessionId: scenario.sessionId }),
  );
  // Exact, not a substring: the daemon's own sentence is the same string in EN,
  // so a substring match would also pass if the payload stopped rendering.
  await expect(
    page.getByText('No compression needed.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Compressing…')).toHaveCount(0);
  // Two commands, two turns: the fast no-op is its own row and left the first
  // command's rows standing.
  await expect(
    page.getByText('Context compressed 263,195 → ~99,799'),
  ).toBeVisible();
  await expect(
    page.getByText(
      'Compression instructions were truncated to 2,000 characters.',
    ),
  ).toBeVisible();

  await page.screenshot({
    path: testInfo.outputPath('context-compression-transcript.png'),
  });
});
