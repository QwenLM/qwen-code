/**
 * Reproduction for a user-reported bug on multi-workspace daemons:
 *
 * With workspace A running a session that has an active prompt ("running
 * task"), clicking the "New task" button on workspace B's sidebar section
 * should make the next lazily-created session belong to workspace B. The
 * report says the FIRST click lands in workspace A instead (or on session A
 * itself), while a SECOND click produces the correct workspace-B session.
 *
 * The daemon session is created lazily on first prompt (`POST /session` with
 * a `cwd` field), so the test drives the real UI flow — sidebar click,
 * composer input, submit — and asserts which workspace the recorded
 * `POST /session` request targeted (or whether the prompt was admitted to
 * the still-running session A instead of creating a new session).
 *
 * Both provider modes are exercised: legacy daemons (no `client_identity`
 * feature) and transactional daemons (`client_identity` advertised), because
 * `WorkspaceSessionProvider` keys `DaemonSessionProvider` differently in each.
 */
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  turnCompleteEvent,
  userTextEvent,
  type DaemonRequestRecord,
  type MockDaemonController,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';

const WS_A = '/tmp/ws-a';
const WS_B = '/tmp/ws-b';
const SESSION_A = 'session-a-busy';
const SESSION_B = 'session-b-idle';

const SUBMIT_BUTTON = '[data-web-shell-composer-submit]';
const SEND_LABEL = 'Send message';
const CANCEL_LABEL = 'esc to cancel';
const NEW_TASK_LABEL = 'New task';

type DaemonMode = 'legacy' | 'transactional';

function buildTwoWorkspaceScenario(
  mode: DaemonMode,
  options: { sessionABusy: boolean },
): WebShellDaemonScenario {
  return createWebShellDaemonScenario({
    workspaceCwd: WS_A,
    sessionId: SESSION_A,
    displayName: 'Task in workspace A',
    capabilities: {
      workspaceCwd: WS_A,
      features: [
        'session_events',
        'permission_vote',
        'session_permission_vote',
        'session_scope_override',
        'session_source_metadata',
        'workspace_settings',
        'workspace_voice',
        ...(mode === 'transactional' ? ['client_identity'] : []),
      ],
      workspaces: [
        { id: 'ws-a', cwd: WS_A, primary: true, trusted: true },
        { id: 'ws-b', cwd: WS_B, primary: false, trusted: true },
      ],
    },
    sessions: [
      {
        sessionId: SESSION_A,
        workspaceCwd: WS_A,
        createdAt: '2026-08-14T00:00:00.000Z',
        updatedAt: '2026-08-14T00:05:00.000Z',
        displayName: 'Task in workspace A',
        clientCount: 1,
        hasActivePrompt: options.sessionABusy,
      },
      {
        sessionId: SESSION_B,
        workspaceCwd: WS_B,
        createdAt: '2026-08-13T00:00:00.000Z',
        updatedAt: '2026-08-13T00:10:00.000Z',
        displayName: 'Idle task in workspace B',
        clientCount: 0,
        hasActivePrompt: false,
      },
    ],
    // Replayed turn of workspace A's task. When A is busy there is
    // deliberately no `turn_complete` — the prompt stays in flight.
    events: options.sessionABusy
      ? [
          userTextEvent('Long-running task in workspace A', {
            id: 1,
            sessionId: SESSION_A,
          }),
          assistantTextEvent('Still working on it...', {
            id: 2,
            sessionId: SESSION_A,
          }),
        ]
      : [
          userTextEvent('Finished task in workspace A', {
            id: 1,
            sessionId: SESSION_A,
          }),
          assistantTextEvent('Done with it.', {
            id: 2,
            sessionId: SESSION_A,
          }),
          turnCompleteEvent('prompt-a-done', { id: 3, sessionId: SESSION_A }),
        ],
    busySessionIds: options.sessionABusy ? [SESSION_A] : [],
  });
}

async function installScenario(
  page: Page,
  scenario: WebShellDaemonScenario,
  testInfo: TestInfo,
  routeDelay?: (method: string, path: string) => number,
): Promise<MockDaemonController> {
  return installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
    routeDelay,
  });
}

async function loadSessionA(
  page: Page,
  scenario: WebShellDaemonScenario,
  daemon: MockDaemonController,
  sessionABusy: boolean,
): Promise<void> {
  await page.goto(`/session/${encodeURIComponent(SESSION_A)}`);
  await expect(page.locator('[data-web-shell-root]')).toBeVisible();
  await daemon.sse.waitForConnection(SESSION_A);
  // Keep completing the replay until the loading indicator clears: dev-mode
  // StrictMode remounts can resubscribe the event stream after a single
  // broadcast landed, dropping the one-shot `replay_complete`.
  const loading = page.getByText('Loading...');
  const deadline = Date.now() + 15_000;
  for (;;) {
    await daemon.sendEvent(
      replayCompleteEvent({
        sessionId: SESSION_A,
        replayedCount: scenario.events.length,
      }),
    );
    try {
      await expect(loading).toHaveCount(0, { timeout: 1_000 });
      break;
    } catch {
      if (Date.now() > deadline) {
        throw new Error('Session A loading indicator never cleared');
      }
    }
  }
  // Sanity: an in-flight prompt of session A is visible as the running
  // (cancel) state of the composer; an idle session shows the send state.
  await expect(page.locator(SUBMIT_BUTTON)).toHaveAttribute(
    'aria-label',
    sessionABusy ? CANCEL_LABEL : SEND_LABEL,
  );
}

async function clickWorkspaceNewTask(page: Page, label: string): Promise<void> {
  const header = page.getByRole('button', { name: label, exact: true });
  await expect(header).toBeVisible();
  const headerRow = header.locator('xpath=..');
  // The header actions render visibility:hidden until the row is hovered.
  await headerRow.hover();
  await headerRow.getByRole('button', { name: NEW_TASK_LABEL }).click();
}

async function waitForSessionDetach(
  daemon: MockDaemonController,
  sessionId: string,
): Promise<void> {
  await expect
    .poll(() =>
      daemon.requests.some(
        (request) =>
          request.method === 'POST' &&
          request.path === `/session/${sessionId}/detach`,
      ),
    )
    .toBe(true);
}

async function fillComposer(page: Page, text: string): Promise<void> {
  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  await editor.click();
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+A' : 'Control+A',
  );
  await page.keyboard.type(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Set QC_E2E_TRACE=1 to print intermediate observations on stdout. */
const TRACE = process.env['QC_E2E_TRACE'] === '1';

function trace(label: string, data: Record<string, unknown>): void {
  if (TRACE) {
    console.log(`[trace] ${label}: ${JSON.stringify(data)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCreateRequest(request: DaemonRequestRecord): boolean {
  return request.method === 'POST' && request.path === '/session';
}

function isPromptRequest(request: DaemonRequestRecord): boolean {
  return (
    request.method === 'POST' &&
    /^\/session\/[^/]+\/prompt\/?$/.test(request.path)
  );
}

function promptSessionId(request: DaemonRequestRecord): string {
  return decodeURIComponent(request.path.split('/')[2] ?? '');
}

function extractPromptText(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const prompt = body['prompt'];
  if (!Array.isArray(prompt)) return undefined;
  const block = prompt.find(
    (item) => isRecord(item) && item['type'] === 'text',
  );
  return isRecord(block) ? String(block['text']) : undefined;
}

/** The composer's workspace chip reflects `selectedWorkspaceCwd` state. */
async function composerWorkspaceChip(page: Page): Promise<string | null> {
  const chip = page.locator(
    '[data-toolbar-measure="workspaceSelect:collapsed"]',
  );
  if ((await chip.count()) === 0) return null;
  return chip.textContent();
}

/** The header banner shows the display name of the session the UI believes is active. */
async function headerTitle(page: Page): Promise<string | null> {
  const banner = page.locator('header > div').first();
  if ((await banner.count()) === 0) return null;
  return banner.textContent();
}

interface AdmissionOutcome {
  /** Number of `POST /session` requests in the round. */
  creates: number;
  /** The `cwd` field of each create body, in order. */
  createdCwds: Array<string | undefined>;
  /** Every `POST /session/:id/prompt` in the round. */
  prompts: Array<{ sessionId: string; text: string | undefined }>;
  /** Composer workspace chip sampled just before the submit click. */
  chipLabel: string | null;
  /** SSE streams open just before the submit click (session ids). */
  streamsBeforeSubmit: string[];
  /** Header session title sampled after the round settled. */
  headerLabel: string | null;
  summary: string;
}

function summarizeRequests(requests: readonly DaemonRequestRecord[]): string {
  const lines = requests.map((request) => {
    let detail = '';
    if (isCreateRequest(request) && isRecord(request.body)) {
      detail = ` cwd=${JSON.stringify(request.body['cwd'])}`;
    } else if (isPromptRequest(request)) {
      detail = ` text=${JSON.stringify(extractPromptText(request.body))}`;
    }
    return `  ${request.method} ${request.path}${detail}`;
  });
  return `\n--- daemon requests this round ---\n${lines.join('\n')}\n---`;
}

/**
 * Drives the lazy create -> attach -> prompt chain until the prompt is
 * admitted (a `POST /session/:id/prompt` lands) or the deadline passes.
 * Completes the (empty) replay of the created session whenever a new SSE
 * connection for it appears — a real daemon finishes that replay instantly,
 * but the mock waits for an explicit `replay_complete`. The event is scoped
 * to the created session's own stream, matching the daemon's per-session
 * delivery (another session's stream never carries it).
 */
async function waitForPromptAdmission(
  daemon: MockDaemonController,
  scenario: WebShellDaemonScenario,
  fromIndex: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const replayedConnections = new Set<string>();
  const promptAdmitted = () =>
    daemon.requests.slice(fromIndex).some(isPromptRequest);
  while (Date.now() < deadline) {
    if (promptAdmitted()) return true;
    const createdIds = Object.keys(scenario.createdSessions);
    const latestCreatedId = createdIds[createdIds.length - 1];
    if (latestCreatedId) {
      const connections = await daemon.sse.connections();
      for (const connection of connections) {
        if (connection.sessionId !== latestCreatedId) continue;
        const key = `${connection.connectedAt}:${connection.url}`;
        if (replayedConnections.has(key)) continue;
        replayedConnections.add(key);
        await daemon.sendEventTo(
          latestCreatedId,
          replayCompleteEvent({
            sessionId: latestCreatedId,
            replayedCount: 0,
          }),
        );
      }
    }
    await sleep(200);
  }
  return promptAdmitted();
}

async function openStreamIds(daemon: MockDaemonController): Promise<string[]> {
  return (await daemon.sse.connections()).map(
    (connection) => connection.sessionId,
  );
}

function admissionOutcome(
  daemon: MockDaemonController,
  fromIndex: number,
  chipLabel: string | null,
  streamsBeforeSubmit: string[],
  headerLabel: string | null,
): AdmissionOutcome {
  const requests = daemon.requests.slice(fromIndex);
  const createRequests = requests.filter(isCreateRequest);
  const prompts = requests.filter(isPromptRequest).map((request) => ({
    sessionId: promptSessionId(request),
    text: extractPromptText(request.body),
  }));
  return {
    creates: createRequests.length,
    createdCwds: createRequests.map((request) =>
      isRecord(request.body)
        ? (request.body['cwd'] as string | undefined)
        : undefined,
    ),
    prompts,
    chipLabel,
    streamsBeforeSubmit,
    headerLabel,
    summary:
      `composer workspace chip before submit: ${JSON.stringify(chipLabel)}; ` +
      `open SSE streams before submit: ${JSON.stringify(streamsBeforeSubmit)}; ` +
      `header session after round: ${JSON.stringify(headerLabel)}` +
      summarizeRequests(requests),
  };
}

type TurnCompleteTiming = 'never' | 'after-click' | 'during-admission';

/**
 * Round-2 realism axes for the transactional scenario. Round 1 ran with zero
 * traffic from session A after its replay; a real running task keeps emitting
 * SSE events while the user clicks New task, types, and submits.
 */
interface TrafficOptions {
  /** When session A's in-flight turn completes relative to the flow. */
  turnComplete: TurnCompleteTiming;
  /**
   * Slow the mock daemon's POST /session (400ms), .../load (300ms) and
   * .../detach (250ms) routes to widen admission race windows.
   */
  slowDaemon?: boolean;
}

/** Assistant text delta cadence for session A (ms). */
const TRICKLE_INTERVAL_MS = 150;

interface TrickleHandle {
  stop(): void;
}

/**
 * Emits a steady trickle of assistant text deltas for `sessionId` on that
 * session's own SSE stream, modeling a running task. The daemon scopes
 * events per session stream, so delivery is targeted via `sendEventTo`.
 */
function startTrickle(
  daemon: MockDaemonController,
  sessionId: string,
  intervalMs: number,
): TrickleHandle {
  let counter = 0;
  const timer = setInterval(() => {
    counter += 1;
    void daemon.sendEventTo(
      sessionId,
      assistantTextEvent(` still working ${counter}...`, {
        id: 100 + counter,
        sessionId,
      }),
    );
  }, intervalMs);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

function slowDaemonDelay(method: string, path: string): number {
  if (method !== 'POST') return 0;
  if (path === '/session') return 400;
  if (/^\/session\/[^/]+\/load\/?$/.test(path)) return 300;
  if (/^\/session\/[^/]+\/detach\/?$/.test(path)) return 250;
  return 0;
}

/**
 * The two-round contract under test, shared by every scenario runner: click
 * workspace B's New-task button while session A is the connected session,
 * submit a prompt, then do it again. Both rounds assert the same outcome —
 * one fresh session created in workspace B, and the prompt admitted to it.
 */
async function runWorkspaceBRounds(
  page: Page,
  daemon: MockDaemonController,
  scenario: WebShellDaemonScenario,
  traffic: TrafficOptions | undefined,
  finishSessionA: () => Promise<void>,
): Promise<void> {
  // ---- Round 1: first click on workspace B's "New task" button.
  await clickWorkspaceNewTask(page, 'ws-b');
  if (traffic?.turnComplete === 'after-click') {
    // The task finishes while the user is about to type.
    await finishSessionA();
  }
  // Wait for the clear of session A to land (detach ack) and the composer
  // to return to its idle send state before typing, like a user.
  await waitForSessionDetach(daemon, SESSION_A);
  await expect(page.locator(SUBMIT_BUTTON)).toHaveAttribute(
    'aria-label',
    SEND_LABEL,
  );

  const round1Start = daemon.requests.length;
  const round1Chip = await composerWorkspaceChip(page);
  const round1Streams = await openStreamIds(daemon);
  trace('round1 after-click', {
    chip: round1Chip,
    streams: round1Streams,
    header: await headerTitle(page),
  });
  await fillComposer(page, 'First prompt after clicking workspace B');
  await page.locator(SUBMIT_BUTTON).click();
  if (traffic?.turnComplete === 'during-admission') {
    // The task finishes while the new session's admission chain runs.
    await expect
      .poll(() => daemon.requests.some(isCreateRequest), {
        timeout: 15_000,
      })
      .toBe(true);
    await finishSessionA();
  }

  // Let the admission chain settle: the create request lands before attach
  // finishes, so wait (bounded) for the prompt itself.
  const round1Admitted = await waitForPromptAdmission(
    daemon,
    scenario,
    round1Start,
    15_000,
  );
  const round1 = admissionOutcome(
    daemon,
    round1Start,
    round1Chip,
    round1Streams,
    await headerTitle(page),
  );
  trace('round1 outcome', {
    admitted: round1Admitted,
    createdCwds: round1.createdCwds,
    prompts: round1.prompts,
    header: round1.headerLabel,
    streams: await openStreamIds(daemon),
  });

  // Expected behavior: one fresh session, created in workspace B, and the
  // prompt admitted to it. Bug variants: the prompt is admitted to session
  // A instead of a create (S2), the create targets workspace A / omits cwd
  // (S1), or the prompt is dropped entirely. Soft assertions so both
  // rounds run and the full picture lands in the failure output.
  expect
    .soft(
      round1.prompts.filter((prompt) => prompt.sessionId === SESSION_A),
      `round 1: the prompt must not be admitted to session A\n${round1.summary}`,
    )
    .toHaveLength(0);
  expect
    .soft(
      round1.creates,
      `round 1: the submission must create a new session\n${round1.summary}`,
    )
    .toBe(1);
  expect
    .soft(
      round1.createdCwds,
      `round 1: the created session must belong to workspace B (${WS_B})\n${round1.summary}`,
    )
    .toEqual([WS_B]);
  expect
    .soft(
      round1Admitted,
      `round 1: the submitted prompt must be admitted after session creation\n${round1.summary}`,
    )
    .toBe(true);

  // ---- Settle before round two. When the prompt was admitted, finish its
  // turn; when it was dropped, just wait for the composer to come back to
  // an idle send state.
  const createdSessionId = round1.prompts[0]?.sessionId;
  if (round1Admitted && createdSessionId) {
    await daemon.sendEventTo(
      createdSessionId,
      turnCompleteEvent('prompt-e2e', {
        id: 11,
        sessionId: createdSessionId,
      }),
    );
  }
  await expect(page.locator(SUBMIT_BUTTON)).toHaveAttribute(
    'aria-label',
    SEND_LABEL,
  );

  // ---- Round 2: second click on workspace B's "New task" button.
  await clickWorkspaceNewTask(page, 'ws-b');
  if (createdSessionId) {
    await waitForSessionDetach(daemon, createdSessionId);
  }
  await expect(page.locator(SUBMIT_BUTTON)).toHaveAttribute(
    'aria-label',
    SEND_LABEL,
  );

  const round2Start = daemon.requests.length;
  const round2Chip = await composerWorkspaceChip(page);
  const round2Streams = await openStreamIds(daemon);
  await fillComposer(page, 'Second prompt after clicking workspace B again');
  await page.locator(SUBMIT_BUTTON).click();

  const round2Admitted = await waitForPromptAdmission(
    daemon,
    scenario,
    round2Start,
    15_000,
  );
  const round2 = admissionOutcome(
    daemon,
    round2Start,
    round2Chip,
    round2Streams,
    await headerTitle(page),
  );

  expect
    .soft(
      round2.prompts.filter(
        (prompt) =>
          prompt.sessionId === SESSION_A ||
          prompt.sessionId === createdSessionId,
      ),
      `round 2: the prompt must not reuse an existing session\n${round2.summary}`,
    )
    .toHaveLength(0);
  expect
    .soft(
      round2.creates,
      `round 2: the submission must create a new session\n${round2.summary}`,
    )
    .toBe(1);
  expect
    .soft(
      round2.createdCwds,
      `round 2: the created session must belong to workspace B (${WS_B})\n${round2.summary}`,
    )
    .toEqual([WS_B]);
  expect
    .soft(
      round2Admitted,
      `round 2: the submitted prompt must be admitted\n${round2.summary}`,
    )
    .toBe(true);
}

async function runNewSessionScenario(
  page: Page,
  testInfo: TestInfo,
  mode: DaemonMode,
  sessionABusy: boolean,
  traffic?: TrafficOptions,
): Promise<void> {
  const scenario = buildTwoWorkspaceScenario(mode, { sessionABusy });
  const daemon = await installScenario(
    page,
    scenario,
    testInfo,
    traffic?.slowDaemon ? slowDaemonDelay : undefined,
  );

  await loadSessionA(page, scenario, daemon, sessionABusy);
  // Session A's replay is consumed; lazily created sessions load empty.
  scenario.events = [];

  // The running task keeps streaming while the user clicks, types, submits.
  let trickle: TrickleHandle | undefined;
  if (traffic && sessionABusy) {
    trickle = startTrickle(daemon, SESSION_A, TRICKLE_INTERVAL_MS);
  }
  const finishSessionA = async () => {
    trickle?.stop();
    trickle = undefined;
    await daemon.sendEventTo(
      SESSION_A,
      turnCompleteEvent('prompt-a-done', { id: 200, sessionId: SESSION_A }),
    );
  };

  try {
    await runWorkspaceBRounds(page, daemon, scenario, traffic, finishSessionA);
  } finally {
    trickle?.stop();
  }
}

for (const mode of ['legacy', 'transactional'] as const) {
  test(`new task on workspace B targets B while session A has a running task (${mode} daemon)`, async ({
    page,
  }, testInfo) => {
    await runNewSessionScenario(page, testInfo, mode, true);
  });
}

// Control: does the outcome depend on session A being busy (suspect S3)?
test('new task on workspace B targets B while session A is idle (legacy daemon control)', async ({
  page,
}, testInfo) => {
  await runNewSessionScenario(page, testInfo, 'legacy', false);
});

/**
 * Marks session A's busy state in the catalog the sidebar reads, so the
 * section renders the way it does while a task is genuinely in flight.
 */
function setSessionABusy(
  scenario: WebShellDaemonScenario,
  busy: boolean,
): void {
  scenario.sessions = scenario.sessions.map((session) =>
    session.sessionId === SESSION_A
      ? { ...session, hasActivePrompt: busy }
      : session,
  );
}

/**
 * Same flow as `runNewSessionScenario`, but session A's running task is a
 * prompt submitted FROM THIS TAB (a locally active prompt waiting on its
 * turn), rather than a busy state restored from the load envelope. This is
 * the most common real-world shape of "session A has a running task": the
 * composer sat in cancel state because the user's own prompt is in flight
 * and SSE deltas keep arriving for it.
 */
async function runLocalPromptScenario(
  page: Page,
  testInfo: TestInfo,
  traffic: TrafficOptions,
): Promise<void> {
  const scenario = buildTwoWorkspaceScenario('transactional', {
    sessionABusy: false,
  });
  const daemon = await installScenario(
    page,
    scenario,
    testInfo,
    traffic.slowDaemon ? slowDaemonDelay : undefined,
  );

  await loadSessionA(page, scenario, daemon, false);
  // Session A's replay is consumed; lazily created sessions load empty.
  scenario.events = [];

  // ---- Start a real running task in session A from this tab.
  await fillComposer(page, 'Long-running task in workspace A');
  await page.locator(SUBMIT_BUTTON).click();
  await expect
    .poll(
      () =>
        daemon.requests.some(
          (request) =>
            isPromptRequest(request) && promptSessionId(request) === SESSION_A,
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
  setSessionABusy(scenario, true);
  // The locally active prompt puts the composer in its cancel state.
  await expect(page.locator(SUBMIT_BUTTON)).toHaveAttribute(
    'aria-label',
    CANCEL_LABEL,
  );

  // The running task keeps streaming while the user clicks, types, submits.
  let trickle: TrickleHandle | undefined = startTrickle(
    daemon,
    SESSION_A,
    TRICKLE_INTERVAL_MS,
  );
  const finishSessionA = async () => {
    trickle?.stop();
    trickle = undefined;
    setSessionABusy(scenario, false);
    await daemon.sendEventTo(
      SESSION_A,
      turnCompleteEvent('prompt-a-done', { id: 200, sessionId: SESSION_A }),
    );
  };

  try {
    await runWorkspaceBRounds(page, daemon, scenario, traffic, finishSessionA);
  } finally {
    trickle?.stop();
  }
}

// ---------------------------------------------------------------------------
// Round 2: realistic traffic from the busy session A (transactional daemon).
//
// A real running task keeps emitting SSE events while the user clicks New
// task, types, and submits, and eventually sends `turn_complete`. These
// variants add that traffic — plus daemon latency — to the scenario that
// passed silently in round 1.
// ---------------------------------------------------------------------------

test('traffic: steady trickle from busy session A, turn never completes (transactional daemon)', async ({
  page,
}, testInfo) => {
  await runNewSessionScenario(page, testInfo, 'transactional', true, {
    turnComplete: 'never',
  });
});

test('traffic: steady trickle, turn completes right after the new-task click (transactional daemon)', async ({
  page,
}, testInfo) => {
  await runNewSessionScenario(page, testInfo, 'transactional', true, {
    turnComplete: 'after-click',
  });
});

test('traffic: steady trickle, turn completes during the admission chain (transactional daemon)', async ({
  page,
}, testInfo) => {
  await runNewSessionScenario(page, testInfo, 'transactional', true, {
    turnComplete: 'during-admission',
  });
});

test('traffic: steady trickle + slow daemon routes, turn never completes (transactional daemon)', async ({
  page,
}, testInfo) => {
  await runNewSessionScenario(page, testInfo, 'transactional', true, {
    turnComplete: 'never',
    slowDaemon: true,
  });
});

// The remount-suppression fix targets legacy daemons specifically; widen its
// admission race windows with daemon latency too, not just transactional's.
test('traffic: steady trickle + slow daemon routes, turn never completes (legacy daemon)', async ({
  page,
}, testInfo) => {
  await runNewSessionScenario(page, testInfo, 'legacy', true, {
    turnComplete: 'never',
    slowDaemon: true,
  });
});

// ---------------------------------------------------------------------------
// Local-prompt variants: the running task in session A was submitted from
// this tab (a locally active prompt), the most common real-world shape.
// ---------------------------------------------------------------------------

test('local prompt in A: steady trickle, turn never completes (transactional daemon)', async ({
  page,
}, testInfo) => {
  await runLocalPromptScenario(page, testInfo, { turnComplete: 'never' });
});

test('local prompt in A: turn completes right after the new-task click (transactional daemon)', async ({
  page,
}, testInfo) => {
  await runLocalPromptScenario(page, testInfo, { turnComplete: 'after-click' });
});

test('local prompt in A: turn completes during the admission chain (transactional daemon)', async ({
  page,
}, testInfo) => {
  await runLocalPromptScenario(page, testInfo, {
    turnComplete: 'during-admission',
  });
});

test('local prompt in A: steady trickle + slow daemon routes, turn never completes (transactional daemon)', async ({
  page,
}, testInfo) => {
  await runLocalPromptScenario(page, testInfo, {
    turnComplete: 'never',
    slowDaemon: true,
  });
});
