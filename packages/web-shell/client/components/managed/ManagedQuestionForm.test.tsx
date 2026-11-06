// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { ManagedQuestionForm } from './ManagedQuestionForm';
import { pendingQuestion } from './managed-question.test-fixtures';

let root: Root;
let container: HTMLDivElement;
let onSubmit: ReturnType<typeof vi.fn>;
let action: ReturnType<typeof pendingQuestion>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  onSubmit = vi.fn().mockResolvedValue(undefined);
  action = pendingQuestion();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function render(disabled = false) {
  await act(async () =>
    root.render(
      <I18nProvider language="en">
        <ManagedQuestionForm
          key={`${action.actionId}:${action.inputRevision}`}
          action={action}
          onSubmit={onSubmit}
          disabled={disabled}
        />
      </I18nProvider>,
    ),
  );
}

function submitButton() {
  return container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
}

async function clickOption(role: 'radio' | 'checkbox', index: number) {
  await act(async () =>
    container
      .querySelectorAll<HTMLButtonElement>(`[role="${role}"]`)
      [index]!.click(),
  );
}

async function fill(index: number, value: string) {
  const input = container.querySelectorAll('textarea')[index]!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit() {
  await act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

it('requires every answer and preserves option identities with duplicate and comma labels', async () => {
  await render();
  expect(submitButton().disabled).toBe(true);
  await clickOption('radio', 1);
  expect(submitButton().disabled).toBe(true);
  await clickOption('checkbox', 1);
  await clickOption('checkbox', 0);
  await fill(1, 'also: review, publish');
  expect(submitButton().disabled).toBe(false);
  await submit();
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
    kind: 'question',
    answers: [
      { questionId: 'q1', optionIds: ['q1o2'] },
      {
        questionId: 'q2',
        optionIds: ['q2o1', 'q2o2'],
        text: 'also: review, publish',
      },
    ],
  });
});

it('uses either a single option or text and preserves drafts through refresh and failed delivery', async () => {
  onSubmit.mockRejectedValueOnce(new Error('unconfirmed'));
  await render();
  await clickOption('radio', 0);
  await fill(0, '  A different library  ');
  expect(
    container.querySelectorAll('[role="radio"][aria-checked="true"]').length,
  ).toBe(0);
  await fill(1, 'Only a custom feature');
  action = { ...action, questions: structuredClone(action.questions) };
  await render();
  expect(container.querySelector('textarea')?.value).toBe(
    '  A different library  ',
  );
  await submit();
  expect(submitButton().disabled).toBe(false);
  await submit();
  expect(onSubmit).toHaveBeenCalledTimes(2);
  expect(onSubmit.mock.calls[0]).toEqual(onSubmit.mock.calls[1]);
  expect(onSubmit.mock.calls[0][0].answers[0]).toEqual({
    questionId: 'q1',
    text: '  A different library  ',
  });
});

it('clears custom text when a single option is selected and fences duplicate submissions', async () => {
  let settle!: () => void;
  onSubmit.mockImplementation(
    () => new Promise<void>((resolve) => (settle = resolve)),
  );
  await render();
  await fill(0, 'custom');
  await clickOption('radio', 0);
  expect(container.querySelector('textarea')?.value).toBe('');
  await fill(1, 'custom feature');
  await submit();
  await submit();
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(submitButton().disabled).toBe(true);
  expect(
    [...container.querySelectorAll('textarea')].every(
      (input) => input.disabled,
    ),
  ).toBe(true);
  await act(async () => settle());
});

it('blocks forbidden or expired questions and enforces UTF-8 answer bounds without truncation', async () => {
  await render(true);
  await submit();
  expect(onSubmit).not.toHaveBeenCalled();
  await render();
  await fill(0, '界'.repeat(8192));
  await fill(1, '界'.repeat(8192));
  expect(container.querySelector('textarea')?.maxLength).toBe(8192);
  expect(container.querySelector('textarea')?.value.length).toBe(8192);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    '32 KiB',
  );
  await submit();
  expect(onSubmit).not.toHaveBeenCalled();
  action = { ...action, expiresAt: Date.now() - 1 };
  await render();
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    'expired',
  );
  expect(submitButton().disabled).toBe(true);
  await submit();
  expect(onSubmit).not.toHaveBeenCalled();
});
