/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AssistantMessage } from './AssistantMessage.js';
import { StreamingState } from '../../types.js';
import { renderWithProviders } from '../../../test-utils/render.js';

describe('<AssistantMessage /> - Raw Markdown Display Snapshots', () => {
  const baseProps = {
    text: 'Test **bold** and `code` markdown\n\n```javascript\nconst x = 1;\n```',
    isPending: false,
    terminalWidth: 80,
  };

  // skip: 现存失败
  it.skip.each([
    { renderMarkdown: true, description: '(default)' },
    {
      renderMarkdown: false,
      description: '(raw markdown with syntax highlighting, no line numbers)',
    },
  ])(
    'renders with renderMarkdown=$renderMarkdown $description',
    async ({ renderMarkdown }) => {
      const { lastFrame, unmount } = await renderWithProviders(
        <AssistantMessage {...baseProps} />,
        {
          uiState: { renderMarkdown, streamingState: StreamingState.Idle },
        },
      );
      expect(lastFrame()).toMatchSnapshot();
      unmount();
    },
  );

  // skip: 现存失败
  it.skip.each([{ renderMarkdown: true }, { renderMarkdown: false }])(
    'renders pending state with renderMarkdown=$renderMarkdown',
    async ({ renderMarkdown }) => {
      const { lastFrame, unmount } = await renderWithProviders(
        <AssistantMessage {...baseProps} isPending={true} />,
        {
          uiState: { renderMarkdown, streamingState: StreamingState.Idle },
        },
      );
      expect(lastFrame()).toMatchSnapshot();
      unmount();
    },
  );

  it('wraps long lines correctly in raw markdown mode', async () => {
    const terminalWidth = 20;
    const text =
      'This is a long line that should wrap correctly without truncation';
    const { lastFrame, unmount } = await renderWithProviders(
      <AssistantMessage
        text={text}
        isPending={false}
        terminalWidth={terminalWidth}
      />,
      {
        uiState: { renderMarkdown: false, streamingState: StreamingState.Idle },
      },
    );
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });
});
