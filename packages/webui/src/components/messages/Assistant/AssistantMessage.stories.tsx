/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { AssistantMessage } from './AssistantMessage.js';

/**
 * AssistantMessage displays AI responses with markdown formatting.
 * Supports different status states for timeline bullet coloring.
 */
const meta: Meta<typeof AssistantMessage> = {
  title: 'Messages/AssistantMessage',
  component: AssistantMessage,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  argTypes: {
    content: {
      control: 'text',
      description: 'The markdown content to display',
    },
    status: {
      control: 'select',
      options: ['default', 'success', 'error', 'warning', 'loading'],
      description: 'Status determines the bullet point color',
    },
    hideStatusIcon: {
      control: 'boolean',
      description: 'Hide the status bullet point',
    },
    isFirst: {
      control: 'boolean',
      description: 'First item in timeline sequence',
    },
    isLast: {
      control: 'boolean',
      description: 'Last item in timeline sequence',
    },
  },
  decorators: [
    (Story) => (
      <div
        style={{
          background: 'var(--app-background, #1e1e1e)',
          padding: '20px',
          minHeight: '200px',
        }}
      >
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    content: 'This is a default assistant message with **markdown** support.',
    status: 'default',
    isFirst: true,
    isLast: true,
  },
};

export const Success: Story = {
  args: {
    content: 'Task completed successfully! All tests passed.',
    status: 'success',
    isFirst: true,
    isLast: true,
  },
};

export const Error: Story = {
  args: {
    content:
      'An error occurred while processing your request. Please try again.',
    status: 'error',
    isFirst: true,
    isLast: true,
  },
};

export const Warning: Story = {
  args: {
    content:
      'Warning: This operation may take a long time. Consider using a smaller dataset.',
    status: 'warning',
    isFirst: true,
    isLast: true,
  },
};

export const Loading: Story = {
  args: {
    content: 'Processing your request...',
    status: 'loading',
    isFirst: true,
    isLast: true,
  },
};

export const WithMarkdown: Story = {
  args: {
    content: `Here's a detailed response with various markdown elements:

## Code Example

\`\`\`typescript
const greeting = (name: string) => {
  return \`Hello, \${name}!\`;
};
\`\`\`

## Key Points

- First point with **bold** text
- Second point with \`inline code\`
- Third point with *italic* text

> This is a blockquote for emphasis.

Check the [documentation](https://example.com) for more details.`,
    status: 'success',
    isFirst: true,
    isLast: true,
  },
};

export const LongContent: Story = {
  args: {
    content: `This is a very long message that demonstrates how the component handles extensive content.

The assistant can provide detailed explanations, code examples, and step-by-step instructions.

### Step 1: Setup

First, initialize your project:

\`\`\`bash
npm init -y
npm install react react-dom
\`\`\`

### Step 2: Create Components

Create your main component file:

\`\`\`tsx
import { FC } from 'react';

export const App: FC = () => {
  return <div>Hello World</div>;
};
\`\`\`

### Step 3: Run

Start the development server and verify everything works correctly.`,
    status: 'default',
    isFirst: true,
    isLast: true,
  },
};

export const HiddenStatusIcon: Story = {
  args: {
    content: 'This message has no status bullet point.',
    hideStatusIcon: true,
    isFirst: true,
    isLast: true,
  },
};

// Timeline demonstration
export const TimelineFirst: Story = {
  args: {
    content: 'This is the first message in a sequence.',
    status: 'default',
    isFirst: true,
    isLast: false,
  },
};

export const TimelineMiddle: Story = {
  args: {
    content: 'This is a middle message in a sequence.',
    status: 'default',
    isFirst: false,
    isLast: false,
  },
};

export const TimelineLast: Story = {
  args: {
    content: 'This is the last message in a sequence.',
    status: 'success',
    isFirst: false,
    isLast: true,
  },
};
