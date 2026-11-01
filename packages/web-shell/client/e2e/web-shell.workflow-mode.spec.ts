/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test, type Page } from '@playwright/test';
import type { DaemonEvent } from '@qwen-code/sdk/daemon';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  type MockDaemonController,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';
import { gotoEmptyMobileWelcomeHarness } from './utils/emptyMobileComposer';

const workflowOption = (requested = false, available = true) => ({
  id: 'workflow_mode',
  name: 'Workflow mode',
  type: 'select',
  currentValue: requested ? 'on' : 'off',
  options: [
    { value: 'off', name: 'Off' },
    { value: 'on', name: 'On' },
  ],
  _meta: {
    'qwen.workflowMode': {
      available,
      effective: requested && available,
      ...(!available ? { reason: 'workflow_unavailable' } : {}),
    },
  },
});

const reasoningOption = (currentValue = 'medium') => ({
  id: 'reasoning_effort',
  name: 'Reasoning effort',
  type: 'select',
  currentValue,
  options: [
    { value: 'low', name: 'Low' },
    { value: 'medium', name: 'Medium' },
    { value: 'high', name: 'High' },
  ],
  _meta: {
    'qwenCode/reasoning': {
      defaultEffort: 'medium',
      thinkingMandatory: true,
    },
  },
});

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function modeSwitch(page: Page) {
  return page.getByRole('switch', { name: 'Workflow mode', exact: true });
}

function configUpdate(
  scenario: WebShellDaemonScenario,
  id: number,
  wrapped = true,
): DaemonEvent {
  const update = {
    sessionUpdate: 'config_option_update',
    configOptions: structuredClone(scenario.state.configOptions),
  };
  return {
    v: 1,
    id,
    type: 'session_update',
    originatorClientId: scenario.clientId,
    data: wrapped ? { sessionId: scenario.sessionId, update } : update,
  };
}

async function openSession(
  page: Page,
  daemon: MockDaemonController,
  sessionId = daemon.scenario.sessionId,
) {
  await page.goto(`/session/${sessionId}`);
  await daemon.sse.waitForConnection(sessionId);
  await daemon.sendEvent(replayCompleteEvent({ sessionId }));
  await expect(page.locator('[data-web-shell-composer-editor]')).toBeVisible();
}

test('keeps new-chat Workflow informational without creating a session @smoke', async ({
  page,
  baseURL,
}) => {
  const daemon = await installMockDaemon(page, createWebShellDaemonScenario(), {
    baseURL,
  });
  await gotoEmptyMobileWelcomeHarness(page);
  const control = page.locator('[data-web-shell-workflow-mode-control]');
  await expect(control).toBeVisible();
  await expect(modeSwitch(page)).toHaveCount(0);
  await control.getByRole('button').click();
  await expect(
    page.getByRole('dialog', { name: 'Workflow mode', exact: true }),
  ).toContainText('Create or resume a session to check availability.');
  expect(daemon.configOptionRequests()).toHaveLength(0);
  expect(daemon.promptRequests()).toHaveLength(0);
  expect(
    daemon.requests.filter(
      (request) => request.method === 'POST' && request.path === '/session',
    ),
  ).toHaveLength(0);
});

test('toggles only session Workflow, remains usable while busy, and preserves effort @smoke', async ({
  page,
  baseURL,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    state: { configOptions: [workflowOption(), reasoningOption()] },
  });
  const daemon = await installMockDaemon(page, scenario, { baseURL });
  await openSession(page, daemon);
  const toggle = modeSwitch(page);
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(toggle).toBeChecked();
  expect(daemon.configOptionRequests().map((request) => request.body)).toEqual([
    { configId: 'workflow_mode', value: 'on' },
  ]);
  expect(daemon.promptRequests()).toHaveLength(0);
  expect(scenario.state.configOptions).toContainEqual(reasoningOption());

  await page.locator('[data-web-shell-model-button]').click();
  await page.locator('[data-web-shell-effort="low"]').click();
  await expect.poll(() => daemon.configOptionRequests().length).toBe(2);
  await page.keyboard.press('Escape');
  await expect(toggle).toBeChecked();
  expect(daemon.configOptionRequests()[1]?.body).toEqual({
    configId: 'reasoning_effort',
    value: 'low',
    persist: true,
  });
  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  await editor.fill('DW04B busy fixture');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  expect(daemon.configOptionRequests()[2]?.body).toEqual({
    configId: 'workflow_mode',
    value: 'off',
  });
  expect(scenario.state.configOptions).toContainEqual(reasoningOption('low'));
  expect(daemon.promptRequests()).toHaveLength(1);
  expect(
    daemon.requests.filter((request) => /\/cancel$/.test(request.path)),
  ).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath('workflow-busy-off.png') });
});

test('preserves requested on when unavailable, permits off, and clears omitted support @smoke', async ({
  page,
  baseURL,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    state: { configOptions: [workflowOption(true, false)] },
  });
  const daemon = await installMockDaemon(page, scenario, { baseURL });
  await openSession(page, daemon);
  const toggle = modeSwitch(page);
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath('workflow-unavailable-on.png'),
  });
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeDisabled();
  scenario.state.configOptions = [];
  await daemon.sendEvent(configUpdate(scenario, 1, false));
  await expect(
    page.locator('[data-web-shell-workflow-mode-control]'),
  ).toHaveCount(0);
  expect(daemon.configOptionRequests().map((request) => request.body)).toEqual([
    { configId: 'workflow_mode', value: 'off' },
  ]);
});

test('a live config push beats an already pending context response', async ({
  page,
  baseURL,
}) => {
  const scenario = createWebShellDaemonScenario({
    state: { configOptions: [workflowOption()] },
  });
  const daemon = await installMockDaemon(page, scenario, { baseURL });
  await openSession(page, daemon);
  await expect(modeSwitch(page)).toBeEnabled();
  const readStarted = barrier();
  const releaseRead = barrier();
  const delivered = barrier();
  let holdNextRead = true;
  await page.route('**/session/*/context', async (route) => {
    if (!holdNextRead) return route.fallback();
    holdNextRead = false;
    const oldState = structuredClone(scenario.state);
    readStarted.release();
    await releaseRead.promise;
    await route.fulfill({
      json: {
        v: 1,
        sessionId: scenario.sessionId,
        workspaceCwd: scenario.workspaceCwd,
        state: oldState,
      },
    });
    delivered.release();
  });
  try {
    await daemon.sendEvent({
      v: 1,
      id: 1,
      type: 'settings_reloaded',
      data: { workspaceCwd: scenario.workspaceCwd },
    });
    await readStarted.promise;
    scenario.state.configOptions = [workflowOption(true)];
    await daemon.sendEvent(configUpdate(scenario, 2));
    await expect(modeSwitch(page)).toBeChecked();
    const response = page.waitForResponse('**/session/*/context');
    releaseRead.release();
    await delivered.promise;
    await (await response).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(modeSwitch(page)).toBeChecked();
    expect(daemon.configOptionRequests()).toHaveLength(0);
  } finally {
    releaseRead.release();
  }
});

for (const outcome of ['success', 'rejected'] as const) {
  test(`a late ${outcome} mode ACK cannot reverse a newer remote push`, async ({
    page,
    baseURL,
  }) => {
    const scenario = createWebShellDaemonScenario({
      state: { configOptions: [workflowOption()] },
    });
    const daemon = await installMockDaemon(page, scenario, { baseURL });
    await openSession(page, daemon);
    await expect(modeSwitch(page)).toBeEnabled();
    const ackStarted = barrier();
    const releaseAck = barrier();
    const delivered = barrier();
    const writes: unknown[] = [];
    await page.route('**/session/*/config-option', async (route) => {
      writes.push(route.request().postDataJSON());
      ackStarted.release();
      await releaseAck.promise;
      await route.fulfill({
        status: outcome === 'success' ? 200 : 403,
        json:
          outcome === 'success'
            ? { configOptions: [workflowOption(true)], persisted: true }
            : { error: 'Workflow update rejected by owner' },
      });
      delivered.release();
    });
    try {
      await modeSwitch(page).click();
      await ackStarted.promise;
      await expect(modeSwitch(page)).toBeDisabled();
      scenario.state.configOptions = [workflowOption(true)];
      await daemon.sendEvent(configUpdate(scenario, 1));
      await expect(modeSwitch(page)).toBeChecked();
      scenario.state.configOptions = [workflowOption()];
      await daemon.sendEvent(configUpdate(scenario, 2));
      await expect(modeSwitch(page)).not.toBeChecked();
      releaseAck.release();
      await delivered.promise;
      await expect(modeSwitch(page)).toBeEnabled();
      await expect(modeSwitch(page)).not.toBeChecked();
      expect(writes).toEqual([{ configId: 'workflow_mode', value: 'on' }]);
      expect(daemon.promptRequests()).toHaveLength(0);
    } finally {
      releaseAck.release();
    }
  });
}

test('accepts a successful ACK without configOptions and reads the current owner state', async ({
  page,
  baseURL,
}) => {
  const scenario = createWebShellDaemonScenario({
    state: { configOptions: [workflowOption()] },
  });
  const daemon = await installMockDaemon(page, scenario, { baseURL });
  await openSession(page, daemon);
  let writes = 0;
  await page.route('**/session/*/config-option', async (route) => {
    writes += 1;
    expect(route.request().postDataJSON()).toEqual({
      configId: 'workflow_mode',
      value: 'on',
    });
    scenario.state.configOptions = [workflowOption(true)];
    await route.fulfill({ json: { persisted: true } });
  });
  await expect(modeSwitch(page)).toBeEnabled();
  await modeSwitch(page).click();
  await expect(modeSwitch(page)).toBeChecked();
  await expect(modeSwitch(page)).toBeEnabled();
  expect(writes).toBe(1);
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('reconciles after reconnect without installing historical mode or synthetic omission', async ({
  page,
  baseURL,
}) => {
  const scenario = createWebShellDaemonScenario({
    state: { configOptions: [workflowOption(true)] },
  });
  const daemon = await installMockDaemon(page, scenario, { baseURL });
  await openSession(page, daemon);
  await expect(modeSwitch(page)).toBeChecked();
  await daemon.sendEvent(configUpdate(scenario, 1));
  await daemon.sendEvent({
    v: 1,
    id: 2,
    type: 'session_snapshot',
    data: {
      sessionId: scenario.sessionId,
      currentModelId: scenario.currentModel,
    },
  });
  await expect(modeSwitch(page)).toBeChecked();
  await daemon.sse.close();
  await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent({
    ...configUpdate(scenario, 1),
    data: {
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: [workflowOption()],
      },
    },
  });
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: scenario.sessionId }),
  );
  await expect(modeSwitch(page)).toBeEnabled();
  await expect(modeSwitch(page)).toBeChecked();
  expect(daemon.configOptionRequests()).toHaveLength(0);
});

test('isolates an old mode ACK across A to B to a new A attachment', async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const scenario = createWebShellDaemonScenario({
    sessionId: 'workflow-a',
    displayName: 'Workflow session A',
    state: { configOptions: [workflowOption()] },
  });
  scenario.sessions.push({
    ...scenario.sessions[0]!,
    sessionId: 'workflow-b',
    displayName: 'Workflow session B',
  });
  const daemon = await installMockDaemon(page, scenario, { baseURL });
  const values = new Map([
    ['workflow-a', false],
    ['workflow-b', false],
  ]);
  await page.route('**/session/*/context', (route) => {
    const sessionId = new URL(route.request().url()).pathname.split('/')[2]!;
    return route.fulfill({
      json: {
        v: 1,
        sessionId,
        workspaceCwd: scenario.workspaceCwd,
        state: {
          ...scenario.state,
          configOptions: [workflowOption(values.get(sessionId))],
        },
      },
    });
  });
  await openSession(page, daemon);
  await expect(modeSwitch(page)).toBeEnabled();
  const started = barrier();
  const release = barrier();
  const writes: Array<{ sessionId: string; body: unknown }> = [];
  await page.route('**/session/*/config-option', async (route) => {
    const sessionId = new URL(route.request().url()).pathname.split('/')[2]!;
    const body = route.request().postDataJSON();
    writes.push({ sessionId, body });
    values.set(sessionId, body.value === 'on');
    if (sessionId === 'workflow-a') {
      started.release();
      await release.promise;
    }
    await route.fulfill({
      json: { configOptions: [workflowOption(true)], persisted: true },
    });
  });
  const sidebar = page.locator('[data-sidebar-shell]');
  try {
    await modeSwitch(page).click();
    await started.promise;
    await sidebar.getByText('Workflow session B', { exact: true }).click();
    await daemon.sse.waitForConnection('workflow-b');
    await daemon.sendEvent(replayCompleteEvent({ sessionId: 'workflow-b' }));
    await expect(modeSwitch(page)).toBeEnabled();
    await expect(modeSwitch(page)).not.toBeChecked();
    await modeSwitch(page).click();
    await expect(modeSwitch(page)).toBeChecked();
    values.set('workflow-a', false);
    await sidebar.getByText('Workflow session A', { exact: true }).click();
    await daemon.sse.waitForConnection('workflow-a');
    await daemon.sendEvent(replayCompleteEvent({ sessionId: 'workflow-a' }));
    await expect(modeSwitch(page)).toBeEnabled();
    await expect(modeSwitch(page)).not.toBeChecked();
    const ack = page.waitForResponse('**/session/workflow-a/config-option');
    release.release();
    const response = await ack;
    expect(response.status()).toBe(200);
    await response.finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(modeSwitch(page)).not.toBeChecked();
    await expect(modeSwitch(page)).toBeEnabled();
    expect(writes).toEqual([
      {
        sessionId: 'workflow-a',
        body: { configId: 'workflow_mode', value: 'on' },
      },
      {
        sessionId: 'workflow-b',
        body: { configId: 'workflow_mode', value: 'on' },
      },
    ]);
    expect(daemon.promptRequests()).toHaveLength(0);
  } finally {
    release.release();
  }
});

test('split panes read and write their own Workflow owner', async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const scenario = createWebShellDaemonScenario({
    sessionId: 'workflow-left',
    state: { configOptions: [workflowOption()] },
  });
  scenario.sessions.push({
    ...scenario.sessions[0]!,
    sessionId: 'workflow-right',
    displayName: 'Workflow right',
  });
  const daemon = await installMockDaemon(page, scenario, { baseURL });
  const values = new Map([
    ['workflow-left', false],
    ['workflow-right', true],
  ]);
  await page.route('**/session/*/context', (route) => {
    const sessionId = new URL(route.request().url()).pathname.split('/')[2]!;
    return route.fulfill({
      json: {
        v: 1,
        sessionId,
        workspaceCwd: scenario.workspaceCwd,
        state: {
          ...scenario.state,
          configOptions: [workflowOption(values.get(sessionId))],
        },
      },
    });
  });
  const writes: string[] = [];
  await page.route('**/session/*/config-option', (route) => {
    const sessionId = new URL(route.request().url()).pathname.split('/')[2]!;
    expect(route.request().postDataJSON()).toEqual({
      configId: 'workflow_mode',
      value: 'on',
    });
    values.set(sessionId, true);
    writes.push(sessionId);
    return route.fulfill({
      json: { configOptions: [workflowOption(true)], persisted: true },
    });
  });
  await page.goto('/?split=workflow-left,workflow-right');
  for (const sessionId of values.keys()) {
    await daemon.sse.waitForConnection(sessionId);
    await daemon.sendEvent(replayCompleteEvent({ sessionId }));
  }
  const left = page
    .locator('[data-pane-session-id="workflow-left"]')
    .getByRole('switch', { name: 'Workflow mode', exact: true });
  const right = page
    .locator('[data-pane-session-id="workflow-right"]')
    .getByRole('switch', { name: 'Workflow mode', exact: true });
  await expect(left).toBeEnabled();
  await expect(left).not.toBeChecked();
  await expect(right).toBeChecked();
  await left.click();
  await expect(left).toBeChecked();
  await expect(right).toBeChecked();
  expect(writes).toEqual(['workflow-left']);
  expect(daemon.promptRequests()).toHaveLength(0);
});
