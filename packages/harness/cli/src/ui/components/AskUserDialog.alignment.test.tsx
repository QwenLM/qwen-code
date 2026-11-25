/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { makeFakeConfig, type Question } from '@qwen-code/core';
import { createMockSettings } from '../../test-utils/settings.js';
import { cleanup, renderWithProviders } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { AskUserDialog } from './AskUserDialog.js';
import { TerminalSizeContext } from '../../ink/components/TerminalSizeContext.js';

beforeEach(() => {
  let time = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => (time += 50));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const first: Question = {
  question: 'Which implementation should we choose?',
  header: 'Implementation',
  options: [
    { label: 'Alpha, Beta', description: '' },
    { label: 'Gamma', description: '' },
  ],
  multiSelect: false,
};
const second: Question = {
  ...first,
  question: 'Which secondary implementation?',
  header: 'Second',
};
async function fixture(questions: Question[]) {
  const submit = vi.fn();
  const cancel = vi.fn();
  const result = await renderWithProviders(
    <AskUserDialog
      questions={questions}
      onSubmit={submit}
      onCancel={cancel}
      width={100}
    />,
    { width: 100 },
  );
  await result.waitUntilReady();
  const keys = async (...values: string[]) => {
    for (const key of values) {
      act(() => result.stdin.write(key));
      await result.waitUntilReady();
    }
  };
  return { ...result, keys, submit, cancel };
}

it('clamps both tab endpoints and reviews full answered questions only', async () => {
  const r = await fixture([first, second]);
  await r.keys('\x1b[Z');
  expect(r.lastFrame()).toContain(first.question);
  expect(r.lastFrame()).not.toContain('Review your answers');
  await r.keys('\r', '\t', '\t');
  expect(r.lastFrame()).toContain('Review your answers');
  expect(r.lastFrame()).toContain(first.question);
  expect(r.lastFrame()).not.toContain(second.question);
  expect(r.lastFrame()).toContain('You have not answered all questions');
  await expect(r).toMatchSvgSnapshot();
});

it('keeps confirmed selection distinct from focus when revisiting a question', async () => {
  const r = await fixture([first, second]);
  await r.keys('2', '\x1b[Z');
  expect(r.lastFrame()).toContain('❯ 1. Alpha, Beta');
  expect(r.lastFrame()).toContain('2. Gamma ✓');
  await expect(r).toMatchSvgSnapshot();
});

it('keeps a draft visible when blurred and blocks tab while editing', async () => {
  const r = await fixture([first, second]);
  await r.keys('3', 'Draft answer', '\t');
  expect(r.lastFrame()).toContain(first.question);
  expect(r.lastFrame()).not.toContain(second.question);
  await r.keys('\x1b[A');
  expect(r.lastFrame()).toContain('3. Draft answer');
  await r.keys('\t', '\t');
  expect(r.lastFrame()).not.toContain('Draft answer');
  expect(r.lastFrame()).toContain('You have not answered all questions');
});

it('retains multi-select identities across tabs and supports number and space toggles', async () => {
  const r = await fixture([{ ...first, multiSelect: true }, second]);
  await r.keys('1');
  expect(r.lastFrame()).toContain('[✓] Alpha, Beta');
  await r.keys('\t', '\x1b[Z');
  expect(r.lastFrame()).toContain('[✓] Alpha, Beta');
  await r.keys(' ');
  expect(r.lastFrame()).toContain('[ ] Alpha, Beta');
  expect(r.lastFrame()).not.toContain('All of the above');
  await expect(r).toMatchSvgSnapshot();
});

it('uses a separate multi-select submit control and does not submit custom input on Enter', async () => {
  const r = await fixture([{ ...first, multiSelect: true }]);
  await r.keys('\x1b[B', '\x1b[B', 'Custom choice', '\r');
  expect(r.lastFrame()).not.toContain('Review your answers');
  expect(r.submit).not.toHaveBeenCalled();
  await r.keys('\t');
  expect(r.lastFrame()).toMatch(/❯ +Submit/);
  await r.keys('\x1b[C');
  expect(r.lastFrame()).not.toContain('Review your answers');
  await r.keys('\r');
  expect(r.lastFrame()).toContain('Review your answers');
  expect(r.lastFrame()).toContain('Custom choice');
  await r.keys('\r');
  await waitFor(() =>
    expect(r.submit).toHaveBeenCalledWith({
      [first.question]: 'Custom choice',
    }),
  );
});

it('shows the saved custom response without a second pointer while Chat is focused', async () => {
  const r = await fixture([first]);
  await r.keys('3', 'Discuss this', '\x1b[B');
  expect(r.lastFrame()).toContain('3. Discuss this');
  expect(r.lastFrame()).toContain('❯ 4. Chat about this');
  expect(r.lastFrame().match(/❯/g)).toHaveLength(1);
  await expect(r).toMatchSvgSnapshot();
});

it('preserves multiline custom text on submit', async () => {
  const r = await fixture([first]);
  await r.keys('3', '\x1b[200~first line\nsecond line\x1b[201~');
  expect(r.lastFrame()).toContain('first line');
  expect(r.lastFrame()).toContain('second line');
  await r.keys('\r');
  await waitFor(() =>
    expect(r.submit).toHaveBeenCalledWith({
      [first.question]: 'first line\nsecond line',
    }),
  );
});

it('uses Ctrl+Enter to continue a multi-select custom response', async () => {
  const r = await fixture([{ ...first, multiSelect: true }]);
  await r.keys('\x1b[B', '\x1b[B', 'Keyboard submit', '\x1b[13;5u');
  expect(r.lastFrame()).toContain('Review your answers');
  expect(r.lastFrame()).toContain('Keyboard submit');
});

it.each([false, true])(
  'keeps long choice lists navigable with scroll indicators (alternate=%s)',
  async (alternate) => {
    const question = {
      ...first,
      options: Array.from({ length: 6 }, (_, index) => ({
        label: `Choice ${index + 1}`,
        description: '',
      })),
    };
    const result = await renderWithProviders(
      <AskUserDialog
        questions={[question]}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        width={50}
        availableHeight={16}
      />,
      {
        width: 50,
        config: makeFakeConfig({ useAlternateBuffer: alternate }),
        settings: createMockSettings({ ui: { useAlternateBuffer: alternate } }),
      },
    );
    await result.waitUntilReady();
    expect(result.lastFrame()).toContain('↓');
    for (let i = 0; i < 5; i++) {
      act(() => result.stdin.write('\x1b[B'));
      await result.waitUntilReady();
    }
    expect(result.lastFrame()).toContain('↑');
    expect(result.lastFrame()).toContain('❯ 6. Choice 6');
    await expect(result).toMatchSvgSnapshot();
  },
);

it('uses terminal rows to bound choices when no body height is supplied', async () => {
  const question = {
    ...first,
    options: Array.from({ length: 6 }, (_, index) => ({
      label: `Choice ${index + 1}`,
      description: '',
    })),
  };
  const result = await renderWithProviders(
    <TerminalSizeContext.Provider value={{ columns: 80, rows: 12 }}>
      <AskUserDialog
        questions={[question]}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        width={80}
      />
    </TerminalSizeContext.Provider>,
    { width: 80 },
  );
  await result.waitUntilReady();
  expect(result.lastFrame()).toContain('Choice 1');
  expect(result.lastFrame()).toContain('Choice 2');
  expect(result.lastFrame()).not.toContain('Choice 3');
  expect(result.lastFrame()).toContain('↓');
  await expect(result).toMatchSvgSnapshot();
});
