/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { ThinkingMessage } from './ThinkingMessage.js';

/**
 * ThinkingMessage 组件用于显示 AI 的内部思考过程。
 * 支持折叠/展开功能，默认收起状态，点击可展开查看详细内容。
 *
 * 样式参考 Claude Code 的 thinking 消息设计：
 * - 收起状态：灰色圆点 + "Thinking" + 向下箭头
 * - 展开状态：实心圆点 + "Thinking" + 向上箭头 + 思考内容
 * - 与其他消息项对齐，有 status icon 和连接线
 */
const meta: Meta<typeof ThinkingMessage> = {
  title: 'Messages/ThinkingMessage',
  component: ThinkingMessage,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  argTypes: {
    content: {
      control: 'text',
      description: '思考内容',
    },
    timestamp: {
      control: 'number',
      description: '消息时间戳',
    },
    defaultExpanded: {
      control: 'boolean',
      description: '是否默认展开',
    },
    status: {
      control: 'select',
      options: ['default', 'loading'],
      description: '状态: loading 表示正在思考, default 表示思考完成',
    },
    onFileClick: { action: 'fileClicked' },
  },
  decorators: [
    (Story) => (
      <div
        style={{
          background: 'var(--app-background, #1e1e1e)',
          padding: '20px',
        }}
      >
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * 默认状态 - 收起
 */
export const Default: Story = {
  args: {
    content: 'Let me analyze this code and think about the best approach...',
    timestamp: Date.now(),
    defaultExpanded: false,
    status: 'default',
  },
};

/**
 * 默认展开状态
 */
export const Expanded: Story = {
  args: {
    content: 'Let me analyze this code and think about the best approach...',
    timestamp: Date.now(),
    defaultExpanded: true,
    status: 'default',
  },
};

/**
 * 正在思考状态 - 带脉冲动画
 */
export const Loading: Story = {
  args: {
    content: 'Analyzing the codebase structure...',
    timestamp: Date.now(),
    defaultExpanded: false,
    status: 'loading',
  },
};

/**
 * 正在思考状态 - 展开
 */
export const LoadingExpanded: Story = {
  args: {
    content: 'Analyzing the codebase structure...',
    timestamp: Date.now(),
    defaultExpanded: true,
    status: 'loading',
  },
};

/**
 * 长思考内容 - 多行文本
 */
export const LongThought: Story = {
  args: {
    content: `I need to consider several factors here:
1. The function structure and its dependencies
2. The type annotations and their implications
3. How this integrates with the rest of the codebase
4. Performance implications of the proposed changes

Let me work through each of these systematically...`,
    timestamp: Date.now(),
    defaultExpanded: true,
    status: 'default',
  },
};

/**
 * 包含文件路径的思考
 */
export const WithFilePath: Story = {
  args: {
    content:
      'Looking at the code in `src/utils/helpers.ts` to understand the pattern...',
    timestamp: Date.now(),
    defaultExpanded: true,
    status: 'default',
  },
};
