import { expect, test } from '@playwright/test';
import {
  createTranscriptToolCallResultUpdate,
  createTranscriptToolCallStartUpdate,
} from '@qwen-code/acp-bridge/transcriptReplay';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  toolCallEvent,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

test('completed questions stay visible outside Processed after reload', async ({
  page,
}, testInfo) => {
  const answer = 'const greeting = "hello";\nconsole.log(greeting);';
  const resultText = `User has provided the following answers:\n\n**Destination**: Staging\n**Example**: ${answer}`;
  const legacyText =
    'User has provided the following answers:\n\n**Legacy**: Legacy answer';
  const partialAnswer = 'first\n**B**: embedded';
  const scenario = createWebShellDaemonScenario({
    events: [
      userTextEvent('Please confirm the destination and example code.', {
        id: 1,
      }),
      toolCallEvent(
        'before',
        'grep_search',
        { pattern: 'before-question' },
        { id: 2 },
      ),
      {
        id: 3,
        v: 1,
        type: 'session_update',
        data: {
          update: createTranscriptToolCallStartUpdate({
            toolName: 'ask_user_question',
            callId: 'ask',
            status: 'in_progress',
            metadata: {
              title: 'Ask user 2 questions',
              kind: 'think',
              locations: [],
            },
            args: {
              questions: [
                {
                  header: 'Destination',
                  question: 'Where should this deploy?',
                  options: [{ label: 'Staging' }, { label: 'Production' }],
                },
                {
                  header: 'Example',
                  question: 'What code should we use?',
                  options: [{ label: 'Example' }, { label: 'Other' }],
                },
              ],
            },
          }),
        },
      },
      {
        id: 4,
        v: 1,
        type: 'session_update',
        data: {
          update: createTranscriptToolCallResultUpdate({
            toolName: 'ask_user_question',
            callId: 'ask',
            success: true,
            resultDisplay: {
              type: 'ask_user_question_answers',
              text: resultText,
              answers: [
                { question: 'Where should this deploy?', answer: 'Staging' },
                { question: 'What code should we use?', answer },
              ],
            },
            message: [
              {
                functionResponse: {
                  name: 'ask_user_question',
                  response: { output: resultText },
                },
              },
            ],
          }),
        },
      },
      {
        id: 5,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            ...createTranscriptToolCallStartUpdate({
              toolName: 'ask_user_question',
              callId: 'legacy-ask',
              status: 'completed',
              metadata: {
                title: 'Ask user 1 question',
                kind: 'think',
                locations: [],
              },
              args: {
                questions: [
                  {
                    header: 'Legacy',
                    question: 'Legacy question?',
                    options: [{ label: 'Legacy answer' }, { label: 'Other' }],
                  },
                ],
              },
            }),
            rawOutput: legacyText,
          },
        },
      },
      toolCallEvent(
        'partial-ask',
        'ask_user_question',
        {
          questions: [
            { header: 'A', question: 'Question A?' },
            { header: 'B', question: 'Question B?' },
          ],
        },
        {
          id: 6,
          rawOutput: {
            type: 'ask_user_question_answers',
            text: `User has provided the following answers:\n\n**A**: ${partialAnswer}`,
            answers: [{ question: 'Question A?', answer: partialAnswer }],
          },
        },
      ),
      toolCallEvent(
        'after',
        'grep_search',
        { pattern: 'after-question' },
        { id: 7 },
      ),
      assistantTextEvent('Confirmed. I will use those answers.', { id: 8 }),
      turnCompleteEvent('prompt-question', { id: 9 }),
    ],
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);

  for (const reloaded of [false, true]) {
    if (reloaded) await page.reload();
    await expect(page.locator('[data-web-shell-root]')).toBeVisible();
    const connection = await daemon.sse.waitForConnection(scenario.sessionId);
    await daemon.sendEvent(
      replayCompleteEvent({
        sessionId: connection.sessionId,
        replayedCount: scenario.events.length,
      }),
    );
    await expect(page.getByText('Loading...')).toHaveCount(0);
    const list = page.locator('[data-web-shell-message-list]');
    const question = list.getByText('Where should this deploy?', {
      exact: true,
    });
    await expect(question).toBeVisible();
    await expect(
      list.getByText('What code should we use?', { exact: true }),
    ).toBeVisible();
    await expect(list.getByText('Staging', { exact: true })).toBeVisible();
    const questionRow = list.locator('[data-transcript-tool-call-id="ask"]');
    const codeAnswer = questionRow.locator('dd').nth(1);
    await expect(codeAnswer).toHaveText(answer);
    await expect(codeAnswer).toHaveCSS('white-space', 'pre-wrap');
    const questionBox = await question.boundingBox();
    const answerBox = await questionRow.locator('dd').first().boundingBox();
    expect(answerBox!.y).toBeGreaterThanOrEqual(
      questionBox!.y + questionBox!.height,
    );
    const userBubble = await list
      .locator('[data-web-shell-user-bubble]')
      .boundingBox();
    const answerBubble = await questionRow
      .locator('dl')
      .locator('..')
      .boundingBox();
    expect(
      Math.abs(
        userBubble!.x +
          userBubble!.width -
          answerBubble!.x -
          answerBubble!.width,
      ),
    ).toBeLessThanOrEqual(1);
    await expect(
      list.getByRole('button', { name: 'Expand steps', exact: true }),
    ).toBeVisible();
    await expect(list).not.toContainText(
      'User has provided the following answers:',
    );
    await expect(
      list.getByRole('button', { name: 'Expand steps', exact: true }),
    ).toContainText('2 tool calls');
    const partialRow = list.locator(
      '[data-transcript-tool-call-id="partial-ask"]',
    );
    await expect(partialRow.locator('dt')).toHaveText(['Question A?']);
    await expect(partialRow.locator('dd')).toHaveText([partialAnswer]);
    await expect(partialRow).not.toContainText('Question B?');
    const legacySummary = list
      .getByRole('button')
      .filter({ hasText: 'Asked 1 question' });
    await expect(legacySummary).toHaveAttribute('aria-expanded', 'false');
    const legacyBox = await legacySummary.boundingBox();
    expect(legacyBox!.x).toBeLessThan(answerBubble!.x);
    await legacySummary.click();
    const legacyRow = list.locator(
      '[data-transcript-tool-call-id="legacy-ask"]',
    );
    await expect(legacyRow).toContainText(
      'User has provided the following answers:',
    );
    await expect(legacyRow).toContainText('Legacy answer');
    await expect(legacyRow.locator('dt')).toHaveCount(0);
    await legacySummary.click();
    await expect(legacySummary).toHaveAttribute('aria-expanded', 'false');
    await expect(list).not.toContainText('before-question');
    await expect(list).not.toContainText('after-question');
    await list
      .getByRole('button', { name: 'Expand steps', exact: true })
      .click();
    await expect(question).toBeVisible();
    await expect(question).toHaveCount(1);
    await list
      .getByRole('button', { name: 'Collapse steps', exact: true })
      .click();
    await expect(question).toBeVisible();
    await expect(question).toHaveCount(1);
  }
  const liveQuestion = {
    sessionUpdate: 'tool_call',
    toolCallId: 'live-ask',
    toolName: 'ask_user_question',
    title: 'Ask user 1 question',
    kind: 'think',
    status: 'in_progress',
    rawInput: {
      questions: [
        {
          header: 'Confirm',
          question: 'Should I continue?',
          options: [{ label: 'Yes' }, { label: 'No' }],
        },
      ],
    },
  };
  await daemon.sendEvent(userTextEvent('One more confirmation.', { id: 10 }));
  await daemon.sendEvent({
    id: 11,
    v: 1,
    type: 'session_update',
    data: { update: liveQuestion },
  });
  const liveRow = page.locator('[data-transcript-tool-call-id="live-ask"]');
  await expect(liveRow.locator('dt')).toHaveCount(0);
  await daemon.sendEvent({
    id: 12,
    v: 1,
    type: 'session_update',
    data: {
      update: {
        ...liveQuestion,
        sessionUpdate: 'tool_call_update',
        status: 'completed',
        rawOutput: {
          type: 'ask_user_question_answers',
          text: 'User has provided the following answers:\n\n**Confirm**: Yes',
          answers: [{ question: 'Should I continue?', answer: 'Yes' }],
        },
      },
    },
  });
  await expect(
    liveRow.getByText('Should I continue?', { exact: true }),
  ).toBeVisible();
  await expect(liveRow.getByText('Yes', { exact: true })).toBeVisible();
  await daemon.sendEvent(turnCompleteEvent('prompt-live-question', { id: 13 }));
  await expect(
    liveRow.getByText('Should I continue?', { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('question-message.png'),
    fullPage: true,
  });
  await daemon.sendEvent({
    id: 14,
    v: 1,
    type: 'session_update',
    data: {
      update: createTranscriptToolCallStartUpdate({
        toolName: 'ask_user_question',
        callId: 'pending-question',
        args: {},
        status: 'pending',
        metadata: {
          title: 'Ask user 1 question',
          kind: 'think',
          locations: [],
        },
        extra: { phase: 'preparing' },
      }),
    },
  });
  await daemon.sendEvent({
    id: 15,
    v: 1,
    type: 'permission_request',
    data: {
      requestId: 'pending-question',
      sessionId: scenario.sessionId,
      toolCall: {
        toolCallId: 'pending-question',
        title: 'Ask user 1 question',
        kind: 'think',
        rawInput: liveQuestion.rawInput,
        _meta: { toolName: 'ask_user_question' },
      },
      options: [{ optionId: 'submit', label: 'Submit', kind: 'allow_once' }],
    },
  });
  const panel = page.locator('[data-web-shell-ask-panel]');
  const collapse = panel.getByRole('button', { name: 'Collapse', exact: true });
  await expect(collapse).toHaveText('Collapse');
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  await collapse.click();
  const expand = panel.getByRole('button', { name: 'Expand', exact: true });
  await expect(expand).toHaveText('Expand');
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expand.click();
  await expect(
    panel.getByText('Should I continue?', { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('question-toggle.png'),
    fullPage: true,
  });
  await daemon.sendEvent({
    id: 16,
    v: 1,
    type: 'permission_resolved',
    data: {
      requestId: 'pending-question',
      outcome: { outcome: 'selected', optionId: 'submit' },
    },
  });
  const pendingResult =
    'User has provided the following answers:\n\n**Confirm**: Yes';
  await daemon.sendEvent({
    id: 17,
    v: 1,
    type: 'session_update',
    data: {
      update: createTranscriptToolCallResultUpdate({
        toolName: 'ask_user_question',
        callId: 'pending-question',
        success: true,
        resultDisplay: {
          type: 'ask_user_question_answers',
          text: pendingResult,
          answers: [{ question: 'Should I continue?', answer: 'Yes' }],
        },
        message: [
          {
            functionResponse: {
              name: 'ask_user_question',
              response: { output: pendingResult },
            },
          },
        ],
      }),
    },
  });
  const submittedRow = page.locator(
    '[data-transcript-tool-call-id="pending-question"]',
  );
  await expect(submittedRow.locator('dt')).toHaveText('Should I continue?');
  await expect(submittedRow.locator('dd')).toHaveText('Yes');
  await expect(submittedRow).not.toContainText(
    'User has provided the following answers:',
  );
});
