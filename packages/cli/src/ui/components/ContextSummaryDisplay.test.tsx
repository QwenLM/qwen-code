/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createTestI18nService } from '../../test-utils/i18n.js';

import type React from 'react';
import { renderWithI18n } from '../../test-utils/render.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ContextSummaryDisplay,
  buildContextSummaryString,
} from './ContextSummaryDisplay.js';
import * as useTerminalSize from '../hooks/useTerminalSize.js';
import { createMockSettings } from '../../test-utils/settings.js';

vi.mock('../hooks/useTerminalSize.js', () => ({
  useTerminalSize: vi.fn(),
}));

const useTerminalSizeMock = vi.mocked(useTerminalSize.useTerminalSize);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const renderWithWidth = async (
  width: number,
  props: React.ComponentProps<typeof ContextSummaryDisplay>,
) => {
  useTerminalSizeMock.mockReturnValue({ columns: width, rows: 24 });
  const result = await renderWithI18n(
    <ContextSummaryDisplay {...props} />,
    width,
  );
  return result;
};

describe('<ContextSummaryDisplay />', () => {
  const baseProps = {
    memoryMdFileCount: 0,
    contextFileNames: [],
    mcpServers: {},
    skillCount: 1,
  };

  it('should render on a single line on a wide screen', async () => {
    const props = {
      ...baseProps,
      memoryMdFileCount: 1,
      contextFileNames: ['AGENTS.md'],
      mcpServers: { 'test-server': { command: 'test' } },
    };
    const { lastFrame, unmount } = await renderWithWidth(120, props);
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('localizes labels while preserving context filenames', async () => {
    const settings = createMockSettings({
      user: {
        path: '/read-only/settings.json',
        settings: { ui: { language: 'zh-CN' } },
        originalSettings: { ui: { language: 'zh-CN' } },
        readOnly: true,
      },
    });
    const { lastFrame, unmount } = await renderWithI18n(
      <ContextSummaryDisplay
        {...baseProps}
        memoryMdFileCount={2}
        contextFileNames={['AGENTS.md', 'AGENTS.md']}
      />,
      100,
      1000,
      settings,
    );

    expect(lastFrame()).toContain('2 个 AGENTS.md 文件');
    expect(lastFrame()).toContain('1 个 skill');
    unmount();
  });

  it('localizes the generated fallback for different context filenames', async () => {
    const settings = createMockSettings({
      user: {
        path: '/read-only/settings.json',
        settings: { ui: { language: 'zh-CN' } },
        originalSettings: { ui: { language: 'zh-CN' } },
        readOnly: true,
      },
    });
    const { lastFrame, unmount } = await renderWithI18n(
      <ContextSummaryDisplay
        {...baseProps}
        memoryMdFileCount={2}
        contextFileNames={['AGENTS.md', 'RULES.md']}
      />,
      100,
      1000,
      settings,
    );

    expect(lastFrame()).toContain('2 个上下文文件');
    expect(lastFrame()).not.toContain('2 个 context 文件');
    unmount();
  });

  it('should truncate on one line on a narrow screen', async () => {
    const props = {
      ...baseProps,
      memoryMdFileCount: 1,
      contextFileNames: ['AGENTS.md'],
      mcpServers: { 'test-server': { command: 'test' } },
    };
    const { lastFrame, unmount } = await renderWithWidth(30, props);
    const frame = lastFrame().trimEnd();
    expect(frame.split('\n')).toHaveLength(1);
    expect(frame).toMatch(/…$/);
    unmount();
  });

  it('should not render empty parts', async () => {
    const props = {
      ...baseProps,
      memoryMdFileCount: 0,
      contextFileNames: [],
      mcpServers: {},
      skillCount: 0,
    };
    const { lastFrame, unmount } = await renderWithWidth(60, props);
    expect(lastFrame({ allowEmpty: true }).trim()).toBe('');
    unmount();
  });
});

describe('buildContextSummaryString', () => {
  it('counts rejected configs in the total and separates failures from policy blocks', () => {
    expect(
      buildContextSummaryString(
        {
          memoryMdFileCount: 0,
          contextFileNames: [],
          mcpServers: { Linear: {}, Context7: {}, qca: {} },
          failedMcpServerCount: 2,
          blockedMcpServers: [{ name: 'qca', pluginName: '' }],
          skillCount: 0,
        },
        createTestI18nService().get,
      ),
    ).toBe('3 MCP servers, 2 Failed, 1 Blocked');
  });

  it('joins all segments with " · "', () => {
    expect(
      buildContextSummaryString(
        {
          memoryMdFileCount: 2,
          contextFileNames: ['AGENTS.md', 'AGENTS.md'],
          mcpServers: { a: { command: 'a' } },
          skillCount: 25,
        },
        createTestI18nService().get,
      ),
    ).toBe('2 AGENTS.md files · 1 MCP server · 25 skills');
  });

  it('uses singular forms for single counts', () => {
    expect(
      buildContextSummaryString(
        {
          memoryMdFileCount: 1,
          contextFileNames: ['AGENTS.md'],
          mcpServers: { a: { command: 'a' }, b: { command: 'b' } },
          skillCount: 1,
        },
        createTestI18nService().get,
      ),
    ).toBe('1 AGENTS.md file · 2 MCP servers · 1 skill');
  });

  it('uses the generated English fallback for different context filenames', () => {
    expect(
      buildContextSummaryString(
        {
          memoryMdFileCount: 2,
          contextFileNames: ['AGENTS.md', 'RULES.md'],
          mcpServers: {},
          skillCount: 0,
        },
        createTestI18nService().get,
      ),
    ).toBe('2 context files');
  });

  it('omits empty segments', () => {
    expect(
      buildContextSummaryString(
        {
          memoryMdFileCount: 0,
          contextFileNames: [],
          mcpServers: {},
          skillCount: 3,
        },
        createTestI18nService().get,
      ),
    ).toBe('3 skills');
  });

  it('shows background task count with the management shortcut', () => {
    expect(
      buildContextSummaryString(
        {
          memoryMdFileCount: 0,
          contextFileNames: [],
          mcpServers: {},
          skillCount: 0,
          backgroundProcessCount: 1,
        },
        createTestI18nService().get,
      ),
    ).toBe('1 Background task');

    expect(
      buildContextSummaryString(
        {
          memoryMdFileCount: 0,
          contextFileNames: [],
          mcpServers: {},
          skillCount: 0,
          backgroundProcessCount: 2,
        },
        createTestI18nService().get,
      ),
    ).toBe('2 Background tasks');
  });

  it('returns an empty string when there is nothing to show', () => {
    expect(
      buildContextSummaryString(
        {
          memoryMdFileCount: 0,
          contextFileNames: [],
          mcpServers: {},
          skillCount: 0,
        },
        createTestI18nService().get,
      ),
    ).toBe('');
  });
});
