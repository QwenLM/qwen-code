/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { CodeBlock } from './LayoutComponents.js';

/**
 * CodeBlock displays formatted code or command output.
 */
const meta: Meta<typeof CodeBlock> = {
  title: 'ToolCalls/Shared/CodeBlock',
  component: CodeBlock,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const ShortCode: Story = {
  args: {
    children: 'const greeting = "Hello, World!";',
  },
};

export const MultilineCode: Story = {
  args: {
    children: `function fibonacci(n) {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

console.log(fibonacci(10));`,
  },
};

export const CommandOutput: Story = {
  args: {
    children: `$ npm run build
> @qwen-code/webui@0.1.0 build
> vite build

vite v5.4.21 building for production...
✓ 131 modules transformed.
✓ built in 2.34s`,
  },
};
