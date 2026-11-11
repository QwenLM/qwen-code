/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, expect, it } from 'vitest';
import { act, useState } from 'react';
import { cleanup, renderWithProviders } from '../../test-utils/render.js';
import { AskUserPreview } from './AskUserPreview.js';
afterEach(cleanup);
it('shares the widest preview width before focus changes, and respects resizing', async () => {
  const long = 'W'.repeat(80);
  const previews = ['Short preview', long];
  let update!: (text: string, maxWidth: number) => void;
  function Fixture() {
    const [view, setView] = useState({ text: previews[0], maxWidth: 120 });
    update = (text, maxWidth) => setView({ text, maxWidth });
    return <AskUserPreview {...view} previews={previews} maxLines={8} />;
  }
  const result = await renderWithProviders(<Fixture />, { width: 140 });
  await result.waitUntilReady();
  const borderWidth = () => {
    const line = result
      .lastFrame()!
      .split('\n')
      .find((line) => line.includes('┌'))!;
    expect(line).toBeDefined();
    return line.indexOf('┐') - line.indexOf('┌') + 1;
  };
  expect(borderWidth()).toBe(84);
  expect(result.lastFrame()).not.toContain(long);
  act(() => update(long, 120));
  await result.waitUntilReady();
  expect(borderWidth()).toBe(84);
  expect(result.lastFrame()).toContain(long);
  act(() => update(long, 44));
  await result.waitUntilReady();
  expect(borderWidth()).toBe(44);
  act(() => update(previews[0], 120));
  await result.waitUntilReady();
  expect(borderWidth()).toBe(84);
  await expect(result).toMatchSvgSnapshot();
});
