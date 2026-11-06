import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  canonicalQuestionAnswers,
  questionResponseKey,
} from './managed-question-response';
import { pendingQuestion } from './managed-question.test-fixtures';

afterEach(() => vi.unstubAllGlobals());

it('keeps the same SHA-256 key on ordinary HTTP without Web Crypto', () => {
  vi.stubGlobal('crypto', undefined);
  const action = pendingQuestion();
  const answers = canonicalQuestionAnswers(action, [
    { questionId: 'q1', text: 'Custom 中😀 / "quoted"\n' },
    { questionId: 'q2', optionIds: ['q2o2', 'q2o1'] },
  ]);
  const expected = createHash('sha256')
    .update(
      JSON.stringify([
        action.sessionId,
        action.actionId,
        action.inputRevision,
        action.policyRevision,
        answers,
      ]),
    )
    .digest('hex');
  expect(questionResponseKey(action, answers)).toBe(`question:${expected}`);
});

it('canonicalizes by immutable IDs and produces a bounded key independent of selection order', async () => {
  const action = pendingQuestion();
  const first = canonicalQuestionAnswers(action, [
    { questionId: 'q2', optionIds: ['q2o2', 'q2o1'], text: '  my answer  ' },
    { questionId: 'q1', optionIds: ['q1o2'] },
  ]);
  const second = canonicalQuestionAnswers(action, [
    { questionId: 'q1', optionIds: ['q1o2'] },
    { questionId: 'q2', optionIds: ['q2o1', 'q2o2'], text: '  my answer  ' },
  ]);
  expect(first).toEqual(second);
  const key = await questionResponseKey(action, first);
  expect(key).toMatch(/^question:[0-9a-f]{64}$/);
  expect(key).not.toContain('my answer');
  expect(await questionResponseKey(structuredClone(action), second)).toBe(key);
  expect(
    await questionResponseKey({ ...action, inputRevision: 2 }, second),
  ).not.toBe(key);
  expect(
    await questionResponseKey(
      { ...action, sessionId: 'other-session' },
      second,
    ),
  ).not.toBe(key);
  expect(
    await questionResponseKey(action, [{ questionId: 'q1', text: 'changed' }]),
  ).not.toBe(key);
});

it('retains invalid IDs for server rejection instead of silently discarding answers', () => {
  expect(
    canonicalQuestionAnswers(pendingQuestion(), [
      { questionId: 'q1', optionIds: ['unknown', 'q1o1', 'q1o1'] },
      { questionId: 'unknown', text: 'not discarded' },
    ]),
  ).toEqual([
    { questionId: 'q1', optionIds: ['q1o1', 'q1o1', 'unknown'] },
    { questionId: 'unknown', text: 'not discarded' },
  ]);
});

it('bounds serialized UTF-8 answers without trimming or truncating them', () => {
  const answers = [{ questionId: 'q1', text: '界'.repeat(12_000) }];
  expect(() => canonicalQuestionAnswers(pendingQuestion(), answers)).toThrow(
    'exceed 32 KiB',
  );
  expect(answers[0].text.length).toBe(12_000);
});
