/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { render } from '../../../test-utils/render.js';
import { TaskNotificationMessage } from './TaskNotificationMessage.js';

describe('<TaskNotificationMessage />', () => {
  it('renders the terminal workflow status and duration', async () => {
    const value = [
      '<task-notification>',
      '<status>completed</status>',
      '<summary>Dynamic workflow "deep-research" completed</summary>',
      '<usage><duration_ms>125000</duration_ms></usage>',
      '</task-notification>',
    ].join('\n');

    const { lastFrame, unmount } = await render(
      <TaskNotificationMessage value={value} />,
    );

    const output = lastFrame();
    expect(output).toContain('Dynamic workflow "deep-research" completed');
    expect(output).toContain('2m 5s');
    unmount();
  });
});
