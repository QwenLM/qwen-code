/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from '../../test-utils/render.js';
import { SuggestionsDisplay } from './SuggestionsDisplay.js';
import { describe, it, expect } from 'vitest';
import { CommandKind } from '../commands/types.js';

describe('SuggestionsDisplay', () => {
  const mockSuggestions = [
    { label: 'Command 1', value: 'command1', description: 'Description 1' },
    { label: 'Command 2', value: 'command2', description: 'Description 2' },
    { label: 'Command 3', value: 'command3', description: 'Description 3' },
  ];

  it('renders loading state', async () => {
    const { lastFrame } = await render(
      <SuggestionsDisplay
        suggestions={[]}
        activeIndex={0}
        isLoading={true}
        width={80}
        scrollOffset={0}
        userInput=""
        mode="reverse"
      />,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('renders nothing when empty and not loading', async () => {
    const { lastFrame } = await render(
      <SuggestionsDisplay
        suggestions={[]}
        activeIndex={0}
        isLoading={false}
        width={80}
        scrollOffset={0}
        userInput=""
        mode="reverse"
      />,
    );
    expect(lastFrame({ allowEmpty: true })).toBe('');
  });

  it('renders suggestions list', async () => {
    const { lastFrame } = await render(
      <SuggestionsDisplay
        suggestions={mockSuggestions}
        activeIndex={0}
        isLoading={false}
        width={80}
        scrollOffset={0}
        userInput=""
        mode="reverse"
      />,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('pads to reserved height to avoid shrinking the prompt area', async () => {
    const { lastFrame: naturalFrame } = await render(
      <SuggestionsDisplay
        suggestions={[mockSuggestions[0]]}
        activeIndex={0}
        isLoading={false}
        width={80}
        scrollOffset={0}
        userInput=""
        mode="slash"
      />,
    );
    const { lastFrame } = await render(
      <SuggestionsDisplay
        suggestions={[mockSuggestions[0]]}
        activeIndex={0}
        isLoading={false}
        width={80}
        reservedHeight={5}
        scrollOffset={0}
        userInput=""
        mode="slash"
      />,
    );

    expect(lastFrame().split('\n').length).toBeGreaterThan(
      naturalFrame().split('\n').length,
    );
  });

  it('keeps long CJK descriptions to a single suggestion row', async () => {
    const { lastFrame } = await render(
      <SuggestionsDisplay
        suggestions={[
          {
            label: 'create-changelog',
            value: 'create-changelog',
            description:
              '管理示例项目的 changelog。用于新增版本变更记录，包括在 changelog/ 目录创建版本文件（中英文双语）并同步更新汇总。',
          },
        ]}
        activeIndex={0}
        isLoading={false}
        width={80}
        scrollOffset={0}
        userInput="/c"
        mode="slash"
      />,
    );

    const output = lastFrame();
    expect(output).toContain('create-changelog');
    expect(output).not.toContain('并同步更新汇总');
    expect(output.split('\n').filter((line) => line.trim().length > 0))
      .toHaveLength(2);
  });

  it('highlights active item', async () => {
    // This test relies on visual inspection or implementation details (colors)
    // For now, we just ensure it renders without error and contains the item
    const { lastFrame } = await render(
      <SuggestionsDisplay
        suggestions={mockSuggestions}
        activeIndex={1}
        isLoading={false}
        width={80}
        scrollOffset={0}
        userInput=""
        mode="reverse"
      />,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('handles scrolling', async () => {
    const manySuggestions = Array.from({ length: 20 }, (_, i) => ({
      label: `Cmd ${i}`,
      value: `Cmd ${i}`,
      description: `Description ${i}`,
    }));

    const { lastFrame } = await render(
      <SuggestionsDisplay
        suggestions={manySuggestions}
        activeIndex={10}
        isLoading={false}
        width={80}
        scrollOffset={5}
        userInput=""
        mode="reverse"
      />,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('renders MCP tag for MCP prompts', async () => {
    const mcpSuggestions = [
      {
        label: 'MCP Tool',
        value: 'mcp-tool',
        commandKind: CommandKind.MCP_PROMPT,
      },
    ];

    const { lastFrame } = await render(
      <SuggestionsDisplay
        suggestions={mcpSuggestions}
        activeIndex={0}
        isLoading={false}
        width={80}
        scrollOffset={0}
        userInput=""
        mode="reverse"
      />,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('renders dynamic commands without a kind tag', async () => {
    const { lastFrame } = await render(
      <SuggestionsDisplay
        suggestions={[
          {
            label: 'ask-docs',
            value: 'ask-docs',
            description: 'Ask docs service',
            commandKind: CommandKind.DYNAMIC,
          },
        ]}
        activeIndex={0}
        isLoading={false}
        width={80}
        scrollOffset={0}
        userInput="/ask-doc"
        mode="slash"
      />,
    );

    expect(lastFrame()).toContain('ask-docs   Ask docs service');
    expect(lastFrame()).not.toContain('[Dynamic]');
  });
});
