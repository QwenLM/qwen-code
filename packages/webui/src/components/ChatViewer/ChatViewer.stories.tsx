/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useRef, useState, useCallback, useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  ChatViewer,
  type ChatMessageData,
  type ChatViewerHandle,
  type ToolCallData,
} from './ChatViewer.js';

/**
 * ChatViewer component displays a read-only conversation flow.
 * It accepts JSONL-formatted chat messages and renders them using
 * UserMessage and AssistantMessage components with timeline styling.
 *
 * Features:
 * - Auto-scroll to bottom when new messages arrive
 * - Programmatic scroll control via ref
 * - Light/dark/auto theme support
 * - Empty state with customizable message
 */
const meta: Meta<typeof ChatViewer> = {
  title: 'Chat/ChatViewer',
  component: ChatViewer,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  argTypes: {
    messages: {
      control: 'object',
      description: 'Array of chat messages in JSONL format',
    },
    className: {
      control: 'text',
      description: 'Additional CSS class name',
    },
    onFileClick: { action: 'fileClicked' },
    emptyMessage: {
      control: 'text',
      description: 'Message to show when there are no messages',
    },
    autoScroll: {
      control: 'boolean',
      description: 'Whether to auto-scroll to bottom when new messages arrive',
    },
    theme: {
      control: 'select',
      options: ['dark', 'light', 'auto'],
      description: 'Theme variant for the viewer',
    },
    showEmptyIcon: {
      control: 'boolean',
      description: 'Whether to show the icon in empty state',
    },
  },
  decorators: [
    (Story) => (
      <div
        style={{
          background: 'var(--app-background, #1e1e1e)',
          padding: '20px',
          height: '500px',
        }}
      >
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

// Helper function to create message data
const createMessage = (
  uuid: string,
  type: 'user' | 'assistant',
  text: string,
  timestamp: string,
  model?: string,
): ChatMessageData => ({
  uuid,
  parentUuid: null,
  sessionId: 'story-session',
  timestamp,
  type,
  message: {
    role: type === 'user' ? 'user' : 'model',
    parts: [{ text }],
  },
  model,
});

export const Default: Story = {
  args: {
    messages: [
      createMessage(
        '1',
        'user',
        'How do I create a React component?',
        '2026-01-19T10:00:00.000Z',
      ),
      createMessage(
        '2',
        'assistant',
        "To create a React component, you can use either a function or a class. Here's a simple example of a functional component:\n\n```tsx\nimport React from 'react';\n\nconst MyComponent: React.FC = () => {\n  return <div>Hello, World!</div>;\n};\n\nexport default MyComponent;\n```\n\nThis creates a basic component that renders \"Hello, World!\". You can then use it in other components like `<MyComponent />`.",
        '2026-01-19T10:00:05.000Z',
        'coder-model',
      ),
    ],
  },
};

export const MultiTurn: Story = {
  args: {
    messages: [
      createMessage(
        '1',
        'user',
        'What is TypeScript?',
        '2026-01-19T10:00:00.000Z',
      ),
      createMessage(
        '2',
        'assistant',
        'TypeScript is a strongly typed programming language that builds on JavaScript. It adds optional static typing and class-based object-oriented programming to the language.',
        '2026-01-19T10:00:05.000Z',
        'coder-model',
      ),
      createMessage(
        '3',
        'user',
        'How do I define an interface?',
        '2026-01-19T10:00:30.000Z',
      ),
      createMessage(
        '4',
        'assistant',
        'You can define an interface in TypeScript like this:\n\n```typescript\ninterface User {\n  id: number;\n  name: string;\n  email?: string; // optional property\n}\n\nconst user: User = {\n  id: 1,\n  name: "John Doe"\n};\n```\n\nInterfaces help you define the shape of objects and enable better type checking.',
        '2026-01-19T10:00:35.000Z',
        'coder-model',
      ),
      createMessage(
        '5',
        'user',
        'Can interfaces extend other interfaces?',
        '2026-01-19T10:01:00.000Z',
      ),
      createMessage(
        '6',
        'assistant',
        'Yes! Interfaces can extend one or more interfaces. Here\'s an example:\n\n```typescript\ninterface Person {\n  name: string;\n  age: number;\n}\n\ninterface Employee extends Person {\n  employeeId: string;\n  department: string;\n}\n\n// Employee now has: name, age, employeeId, and department\nconst employee: Employee = {\n  name: "Jane",\n  age: 30,\n  employeeId: "E001",\n  department: "Engineering"\n};\n```\n\nYou can also extend multiple interfaces: `interface Manager extends Person, Employee { ... }`',
        '2026-01-19T10:01:05.000Z',
        'coder-model',
      ),
    ],
  },
};

export const WithCodeBlocks: Story = {
  args: {
    messages: [
      createMessage(
        '1',
        'user',
        'Show me how to implement a debounce function',
        '2026-01-19T10:00:00.000Z',
      ),
      createMessage(
        '2',
        'assistant',
        `Here's a debounce function implementation in TypeScript:

\`\`\`typescript
function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return function (...args: Parameters<T>) {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    timeoutId = setTimeout(() => {
      func.apply(this, args);
      timeoutId = null;
    }, wait);
  };
}
\`\`\`

**Usage example:**

\`\`\`typescript
const handleSearch = debounce((query: string) => {
  console.log('Searching for:', query);
  // Make API call here
}, 300);

// This will only execute once, 300ms after the last call
handleSearch('h');
handleSearch('he');
handleSearch('hel');
handleSearch('hello');
\`\`\`

The debounce function delays the execution until there's a pause in calls for the specified wait time (300ms in this case).`,
        '2026-01-19T10:00:10.000Z',
        'coder-model',
      ),
    ],
  },
};

export const LongConversation: Story = {
  args: {
    messages: [
      createMessage(
        '1',
        'user',
        'I need to build a REST API. What framework should I use?',
        '2026-01-19T10:00:00.000Z',
      ),
      createMessage(
        '2',
        'assistant',
        'For building a REST API, there are several excellent options depending on your needs:\n\n1. **Express.js** - Minimal and flexible, great for small to medium projects\n2. **Fastify** - High performance, excellent for high-throughput APIs\n3. **NestJS** - Full-featured framework with TypeScript, great for enterprise applications\n4. **Hono** - Ultra-fast and lightweight, perfect for edge computing\n\nWhat language/runtime are you planning to use?',
        '2026-01-19T10:00:05.000Z',
        'coder-model',
      ),
      createMessage(
        '3',
        'user',
        'I want to use TypeScript with Node.js. The API will handle about 10k requests per second.',
        '2026-01-19T10:00:30.000Z',
      ),
      createMessage(
        '4',
        'assistant',
        "For high throughput (10k req/s) with TypeScript, I recommend **Fastify**. It's designed for performance and has excellent TypeScript support out of the box.\n\nHere's a quick setup:\n\n```bash\nnpm init -y\nnpm install fastify\nnpm install -D typescript @types/node\n```\n\n```typescript\nimport Fastify from 'fastify';\n\nconst app = Fastify({ logger: true });\n\napp.get('/health', async () => {\n  return { status: 'ok' };\n});\n\napp.listen({ port: 3000 }, (err) => {\n  if (err) throw err;\n});\n```\n\nFastify benchmarks show it can handle 30k+ req/s on modest hardware.",
        '2026-01-19T10:00:35.000Z',
        'coder-model',
      ),
      createMessage(
        '5',
        'user',
        'How do I add request validation?',
        '2026-01-19T10:01:00.000Z',
      ),
      createMessage(
        '6',
        'assistant',
        "Fastify has built-in JSON Schema validation. Here's how to add it:\n\n```typescript\nconst createUserSchema = {\n  body: {\n    type: 'object',\n    required: ['email', 'name'],\n    properties: {\n      email: { type: 'string', format: 'email' },\n      name: { type: 'string', minLength: 2 },\n      age: { type: 'integer', minimum: 0 }\n    }\n  },\n  response: {\n    201: {\n      type: 'object',\n      properties: {\n        id: { type: 'string' },\n        email: { type: 'string' },\n        name: { type: 'string' }\n      }\n    }\n  }\n};\n\napp.post('/users', { schema: createUserSchema }, async (req, reply) => {\n  const { email, name, age } = req.body;\n  // Create user...\n  reply.code(201).send({ id: '123', email, name });\n});\n```\n\nInvalid requests automatically return 400 with detailed error messages.",
        '2026-01-19T10:01:10.000Z',
        'coder-model',
      ),
    ],
  },
};

export const Empty: Story = {
  args: {
    messages: [],
    emptyMessage: 'Start a conversation to see messages here',
  },
};

export const CustomEmptyMessage: Story = {
  args: {
    messages: [],
    emptyMessage: 'No chat history available',
  },
};

export const SingleUserMessage: Story = {
  args: {
    messages: [
      createMessage(
        '1',
        'user',
        'This is a single user message without any response yet.',
        '2026-01-19T10:00:00.000Z',
      ),
    ],
  },
};

export const SingleAssistantMessage: Story = {
  args: {
    messages: [
      createMessage(
        '1',
        'assistant',
        'This is a standalone assistant message, perhaps from a system prompt or welcome message.',
        '2026-01-19T10:00:00.000Z',
        'coder-model',
      ),
    ],
  },
};

// Real conversation example - Chrome Extension Native Host debugging session
export const RealConversation: Story = {
  args: {
    messages: [
      {
        uuid: '20fb9426-40ca-4e85-92a1-7add59082167',
        parentUuid: null,
        sessionId: 'f05dd1fc-2947-44e0-9f31-cbddce461844',
        timestamp: '2026-01-09T02:58:32.415Z',
        type: 'user',
        message: {
          role: 'user',
          content: `Message received: Object from: Object
service-worker.js:137 Attempting to connect to Native Host: com.qwen.cli.bridge
service-worker.js:202 Sending handshake...
service-worker.js:175 Native host disconnected
service-worker.js:177 Disconnect error: Object
service-worker.js:178 Disconnect error message: Native host has exited.
service-worker.js:207 Handshake timeout - no response from Native Host

Cannot receive host info. Expected output:
service-worker.js:150 [Native Event] host_info Object
service-worker.js:552 [Qwen] host_info Object
service-worker.js:617 [Host] Info Object
service-worker.js:164 [Native Message] handshake_response Object
service-worker.js:231 Handshake successful: Object`,
        },
      },
      {
        uuid: '86f72c75-4626-4292-a26f-13db6f80d4be',
        parentUuid: '20fb9426-40ca-4e85-92a1-7add59082167',
        sessionId: 'f05dd1fc-2947-44e0-9f31-cbddce461844',
        timestamp: '2026-01-09T02:58:45.239Z',
        type: 'assistant',
        model: 'claude-opus-4-5-20251101',
        message: {
          role: 'assistant',
          content: `I can see you're experiencing an issue with the Chrome extension's native host connection. The error shows that the native host is disconnecting with "Native host has exited" and there's a handshake timeout. However, the logs also show that sometimes the handshake is successful when the host_info is received properly.

Let me help you troubleshoot this issue. First, I'll explore the codebase to understand how the native host communication works.`,
        },
      },
      {
        uuid: '6ffff579-8020-4ccb-9b79-7c1da76bbf82',
        parentUuid: '86f72c75-4626-4292-a26f-13db6f80d4be',
        sessionId: 'f05dd1fc-2947-44e0-9f31-cbddce461844',
        timestamp: '2026-01-09T02:58:52.409Z',
        type: 'assistant',
        model: 'claude-opus-4-5-20251101',
        message: {
          role: 'assistant',
          content: `Let me create a todo list to track the troubleshooting steps:

1. **Explore the codebase** to understand the native host implementation
2. **Check the native host configuration** and setup
3. **Analyze the service worker code** that handles native messaging
4. **Identify why the native host exits** unexpectedly
5. **Propose fixes** for the native host connection issue`,
        },
      },
      {
        uuid: '8fd3dc96-1d34-4dae-845a-4827f435b890',
        parentUuid: '6ffff579-8020-4ccb-9b79-7c1da76bbf82',
        sessionId: 'f05dd1fc-2947-44e0-9f31-cbddce461844',
        timestamp: '2026-01-09T02:58:57.366Z',
        type: 'assistant',
        model: 'claude-opus-4-5-20251101',
        message: {
          role: 'assistant',
          content: `Let me start by exploring the codebase to understand the native host implementation.

Looking at the project structure, I found the following relevant files:

\`\`\`
packages/chrome-extension/
├── src/
│   ├── service-worker.ts      # Main service worker
│   ├── native-messaging/
│   │   ├── host.ts            # Native host communication
│   │   └── protocol.ts        # Message protocol
│   └── manifest.json          # Extension manifest
└── native-host/
    ├── index.js               # Native host entry
    └── com.qwen.cli.bridge.json  # Host manifest
\`\`\`

The issue appears to be in the handshake timing. The native host is exiting before the handshake completes.`,
        },
      },
      {
        uuid: 'user-follow-up-1',
        parentUuid: '8fd3dc96-1d34-4dae-845a-4827f435b890',
        sessionId: 'f05dd1fc-2947-44e0-9f31-cbddce461844',
        timestamp: '2026-01-09T03:00:15.000Z',
        type: 'user',
        message: {
          role: 'user',
          content: 'How should I fix this issue?',
        },
      },
      {
        uuid: 'assistant-fix-1',
        parentUuid: 'user-follow-up-1',
        sessionId: 'f05dd1fc-2947-44e0-9f31-cbddce461844',
        timestamp: '2026-01-09T03:00:45.000Z',
        type: 'assistant',
        model: 'claude-opus-4-5-20251101',
        message: {
          role: 'assistant',
          content: `Based on my analysis, here's how to fix the native host connection issue:

## Root Cause
The native host process is exiting prematurely because it's not keeping the stdin stream open for communication.

## Solution

Update the native host's \`index.js\`:

\`\`\`javascript
// native-host/index.js
const { stdin, stdout } = process;

// Keep the process alive by not closing stdin
stdin.resume();

// Handle incoming messages
stdin.on('data', (data) => {
  try {
    const length = data.readUInt32LE(0);
    const message = JSON.parse(data.slice(4, 4 + length).toString());
    
    if (message.type === 'handshake') {
      sendMessage({ type: 'handshake_response', status: 'ok' });
    }
    // Handle other messages...
  } catch (err) {
    console.error('Error parsing message:', err);
  }
});

function sendMessage(msg) {
  const json = JSON.stringify(msg);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(json.length, 0);
  stdout.write(Buffer.concat([length, Buffer.from(json)]));
}

// Send host info on startup
sendMessage({
  type: 'host_info',
  pid: process.pid,
  node: process.execPath
});
\`\`\`

## Key Changes
1. Added \`stdin.resume()\` to prevent the process from exiting
2. Properly handle the native messaging protocol (4-byte length prefix)
3. Send \`host_info\` immediately on startup

Would you like me to apply these changes to your codebase?`,
        },
      },
    ],
  },
  parameters: {
    docs: {
      description: {
        story:
          'A real debugging conversation about Chrome extension native host connection issues. Demonstrates multi-turn conversation with code blocks and mixed languages (English and Chinese).',
      },
    },
  },
};

// Helper to create tool call data
const createToolCall = (
  id: string,
  kind: string,
  title: string,
  status: 'pending' | 'in_progress' | 'completed' | 'failed',
  content?: ToolCallData['content'],
  locations?: ToolCallData['locations'],
): ToolCallData => ({
  toolCallId: id,
  kind,
  title,
  status,
  content,
  locations,
});

// Conversation with tool calls - File reading and editing
export const WithToolCalls: Story = {
  args: {
    messages: [
      {
        uuid: 'tc-1',
        timestamp: '2026-01-15T14:00:00.000Z',
        type: 'user',
        message: {
          role: 'user',
          parts: [
            {
              text: 'Please check the package.json file and add a lodash dependency',
            },
          ],
        },
      },
      {
        uuid: 'tc-2',
        timestamp: '2026-01-15T14:00:05.000Z',
        type: 'assistant',
        message: {
          role: 'assistant',
          content:
            'Sure, let me read the package.json file to check the current dependency configuration.',
        },
      },
      {
        uuid: 'tc-3',
        timestamp: '2026-01-15T14:00:06.000Z',
        type: 'tool_call',
        toolCall: createToolCall(
          'read-1',
          'read',
          'package.json',
          'completed',
          [
            {
              type: 'content',
              content: {
                type: 'text',
                text: `{
  "name": "my-project",
  "version": "1.0.0",
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "vite": "^5.0.0"
  }
}`,
              },
            },
          ],
          [{ path: 'package.json', line: 1 }],
        ),
      },
      {
        uuid: 'tc-4',
        timestamp: '2026-01-15T14:00:10.000Z',
        type: 'assistant',
        message: {
          role: 'assistant',
          content:
            'I see the project uses React 18 and TypeScript. Now let me add the lodash dependency.',
        },
      },
      {
        uuid: 'tc-5',
        timestamp: '2026-01-15T14:00:11.000Z',
        type: 'tool_call',
        toolCall: createToolCall(
          'edit-1',
          'edit',
          'package.json',
          'completed',
          [
            {
              type: 'diff',
              path: 'package.json',
              oldText: `  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },`,
              newText: `  "dependencies": {
    "lodash": "^4.17.21",
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },`,
            },
          ],
          [{ path: 'package.json', line: 4 }],
        ),
      },
      {
        uuid: 'tc-6',
        timestamp: '2026-01-15T14:00:15.000Z',
        type: 'assistant',
        message: {
          role: 'assistant',
          content: `Successfully added lodash dependency to package.json.

You need to run the following command to install the new dependency:

\`\`\`bash
npm install
\`\`\`

Or if you use pnpm:

\`\`\`bash
pnpm install
\`\`\``,
        },
      },
    ],
  },
  parameters: {
    docs: {
      description: {
        story:
          'Demonstrates a conversation with Read and Edit tool calls, showing file reading and modification.',
      },
    },
  },
};

// Conversation with Shell commands
export const WithShellCommands: Story = {
  args: {
    messages: [
      {
        uuid: 'sh-1',
        timestamp: '2026-01-15T15:00:00.000Z',
        type: 'user',
        message: {
          role: 'user',
          parts: [
            { text: 'Help me create a new React component folder structure' },
          ],
        },
      },
      {
        uuid: 'sh-2',
        timestamp: '2026-01-15T15:00:05.000Z',
        type: 'assistant',
        message: {
          role: 'assistant',
          content:
            'Sure, let me create a standard React component folder structure.',
        },
      },
      {
        uuid: 'sh-3',
        timestamp: '2026-01-15T15:00:06.000Z',
        type: 'tool_call',
        toolCall: createToolCall(
          'shell-1',
          'bash',
          'mkdir -p src/components/Button',
          'completed',
          [
            {
              type: 'content',
              content: {
                type: 'text',
                text: '',
              },
            },
          ],
        ),
      },
      {
        uuid: 'sh-4',
        timestamp: '2026-01-15T15:00:08.000Z',
        type: 'tool_call',
        toolCall: createToolCall(
          'write-1',
          'write',
          'src/components/Button/Button.tsx',
          'completed',
          [
            {
              type: 'content',
              content: {
                type: 'text',
                text: `import React from 'react';
import './Button.css';

interface ButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary';
}

export const Button: React.FC<ButtonProps> = ({
  children,
  onClick,
  variant = 'primary',
}) => {
  return (
    <button className={\`button button--\${variant}\`} onClick={onClick}>
      {children}
    </button>
  );
};`,
              },
            },
          ],
          [{ path: 'src/components/Button/Button.tsx' }],
        ),
      },
      {
        uuid: 'sh-5',
        timestamp: '2026-01-15T15:00:10.000Z',
        type: 'tool_call',
        toolCall: createToolCall(
          'write-2',
          'write',
          'src/components/Button/Button.css',
          'completed',
          [
            {
              type: 'content',
              content: {
                type: 'text',
                text: `.button {
  padding: 8px 16px;
  border-radius: 4px;
  border: none;
  cursor: pointer;
  font-size: 14px;
  transition: background-color 0.2s;
}

.button--primary {
  background-color: #3b82f6;
  color: white;
}

.button--secondary {
  background-color: #e5e7eb;
  color: #1f2937;
}`,
              },
            },
          ],
          [{ path: 'src/components/Button/Button.css' }],
        ),
      },
      {
        uuid: 'sh-6',
        timestamp: '2026-01-15T15:00:12.000Z',
        type: 'tool_call',
        toolCall: createToolCall(
          'write-3',
          'write',
          'src/components/Button/index.ts',
          'completed',
          [
            {
              type: 'content',
              content: {
                type: 'text',
                text: `export { Button } from './Button';
export type { ButtonProps } from './Button';`,
              },
            },
          ],
          [{ path: 'src/components/Button/index.ts' }],
        ),
      },
      {
        uuid: 'sh-7',
        timestamp: '2026-01-15T15:00:15.000Z',
        type: 'assistant',
        message: {
          role: 'assistant',
          content: `Created complete Button component structure:

\`\`\`
src/components/Button/
├── Button.tsx      # Main component
├── Button.css      # Styles
└── index.ts        # Exports
\`\`\`

You can use it like this:

\`\`\`tsx
import { Button } from './components/Button';

<Button variant="primary" onClick={() => alert('Clicked!')}>
  Click me
</Button>
\`\`\``,
        },
      },
    ],
  },
  parameters: {
    docs: {
      description: {
        story:
          'Shows a conversation with Shell and Write tool calls, creating a complete component structure.',
      },
    },
  },
};

// Conversation with Search and multiple file reads
export const WithSearchAndRead: Story = {
  args: {
    messages: [
      {
        uuid: 'sr-1',
        timestamp: '2026-01-15T16:00:00.000Z',
        type: 'user',
        message: {
          role: 'user',
          parts: [
            { text: 'Help me find all files that use useState in the project' },
          ],
        },
      },
      {
        uuid: 'sr-2',
        timestamp: '2026-01-15T16:00:05.000Z',
        type: 'assistant',
        message: {
          role: 'assistant',
          content:
            'Sure, let me search for all files that use useState in the project.',
        },
      },
      {
        uuid: 'sr-3',
        timestamp: '2026-01-15T16:00:06.000Z',
        type: 'tool_call',
        toolCall: createToolCall(
          'search-1',
          'grep',
          'useState',
          'completed',
          [
            {
              type: 'content',
              content: {
                type: 'text',
                text: `src/App.tsx:3:import { useState } from 'react';
src/components/Counter.tsx:1:import { useState } from 'react';
src/components/Form.tsx:2:import { useState, useEffect } from 'react';
src/hooks/useLocalStorage.ts:1:import { useState, useEffect } from 'react';`,
              },
            },
          ],
          [
            { path: 'src/App.tsx', line: 3 },
            { path: 'src/components/Counter.tsx', line: 1 },
            { path: 'src/components/Form.tsx', line: 2 },
            { path: 'src/hooks/useLocalStorage.ts', line: 1 },
          ],
        ),
      },
      {
        uuid: 'sr-4',
        timestamp: '2026-01-15T16:00:10.000Z',
        type: 'assistant',
        message: {
          role: 'assistant',
          content: `Found **4 files** using \`useState\`:

| File | Line |
|------|------|
| \`src/App.tsx\` | 3 |
| \`src/components/Counter.tsx\` | 1 |
| \`src/components/Form.tsx\` | 2 |
| \`src/hooks/useLocalStorage.ts\` | 1 |

Would you like me to look at any specific file in detail?`,
        },
      },
      {
        uuid: 'sr-5',
        timestamp: '2026-01-15T16:00:30.000Z',
        type: 'user',
        message: {
          role: 'user',
          parts: [{ text: 'Show me Counter.tsx' }],
        },
      },
      {
        uuid: 'sr-6',
        timestamp: '2026-01-15T16:00:31.000Z',
        type: 'tool_call',
        toolCall: createToolCall(
          'read-2',
          'read',
          'src/components/Counter.tsx',
          'completed',
          [
            {
              type: 'content',
              content: {
                type: 'text',
                text: `import { useState } from 'react';

export const Counter = () => {
  const [count, setCount] = useState(0);

  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => setCount(c => c + 1)}>+</button>
      <button onClick={() => setCount(c => c - 1)}>-</button>
    </div>
  );
};`,
              },
            },
          ],
          [{ path: 'src/components/Counter.tsx' }],
        ),
      },
      {
        uuid: 'sr-7',
        timestamp: '2026-01-15T16:00:35.000Z',
        type: 'assistant',
        message: {
          role: 'assistant',
          content: `This is a simple counter component that uses \`useState\` to manage the count state.

**Code Analysis:**
- Uses functional update \`c => c + 1\` to ensure correct state updates
- Simple component structure with only one state variable

**Potential Improvements:**
1. Could add TypeScript type annotations
2. Could add min/max limits
3. Could add a step parameter

Would you like me to optimize this component?`,
        },
      },
    ],
  },
  parameters: {
    docs: {
      description: {
        story:
          'Demonstrates Search (grep) and Read tool calls in a code exploration conversation.',
      },
    },
  },
};

// Conversation with Todo/Plan updates
export const WithPlanUpdates: Story = {
  args: {
    messages: [
      {
        uuid: 'plan-1',
        timestamp: '2026-01-15T17:00:00.000Z',
        type: 'user',
        message: {
          role: 'user',
          parts: [
            {
              text: 'Help me refactor the authentication module of this project',
            },
          ],
        },
      },
      {
        uuid: 'plan-2',
        timestamp: '2026-01-15T17:00:05.000Z',
        type: 'assistant',
        message: {
          role: 'assistant',
          content:
            'Sure, this is a complex task. Let me first create a plan to track progress.',
        },
      },
      {
        uuid: 'plan-3',
        timestamp: '2026-01-15T17:00:06.000Z',
        type: 'tool_call',
        toolCall: createToolCall(
          'todo-1',
          'todowrite',
          'Create refactoring plan',
          'completed',
          [
            {
              type: 'content',
              content: {
                type: 'text',
                text: JSON.stringify([
                  {
                    content: 'Analyze existing auth code structure',
                    status: 'in_progress',
                  },
                  {
                    content: 'Design new auth architecture',
                    status: 'pending',
                  },
                  {
                    content: 'Implement JWT token management',
                    status: 'pending',
                  },
                  { content: 'Add refresh token mechanism', status: 'pending' },
                  { content: 'Update related tests', status: 'pending' },
                ]),
              },
            },
          ],
        ),
      },
      {
        uuid: 'plan-4',
        timestamp: '2026-01-15T17:00:10.000Z',
        type: 'assistant',
        message: {
          role: 'assistant',
          content:
            'I have created the refactoring plan. Now let me analyze the existing auth code.',
        },
      },
      {
        uuid: 'plan-5',
        timestamp: '2026-01-15T17:00:11.000Z',
        type: 'tool_call',
        toolCall: createToolCall(
          'search-2',
          'glob',
          '**/auth/**',
          'completed',
          undefined,
          [
            { path: 'src/auth/index.ts' },
            { path: 'src/auth/login.ts' },
            { path: 'src/auth/logout.ts' },
            { path: 'src/auth/middleware.ts' },
            { path: 'src/auth/types.ts' },
          ],
        ),
      },
      {
        uuid: 'plan-6',
        timestamp: '2026-01-15T17:00:15.000Z',
        type: 'tool_call',
        toolCall: createToolCall(
          'read-3',
          'read',
          'src/auth/index.ts',
          'completed',
          [
            {
              type: 'content',
              content: {
                type: 'text',
                text: `// Legacy auth module
export { login } from './login';
export { logout } from './logout';
export { authMiddleware } from './middleware';
export type { AuthUser, AuthToken } from './types';`,
              },
            },
          ],
          [{ path: 'src/auth/index.ts' }],
        ),
      },
      {
        uuid: 'plan-7',
        timestamp: '2026-01-15T17:00:20.000Z',
        type: 'assistant',
        message: {
          role: 'assistant',
          content: `Analysis complete! Existing auth module structure:

\`\`\`
src/auth/
├── index.ts      # Export entry
├── login.ts      # Login logic
├── logout.ts     # Logout logic
├── middleware.ts # Auth middleware
└── types.ts      # Type definitions
\`\`\`

**Issues Found:**
1. No token refresh mechanism
2. Missing auth state persistence
3. Incomplete error handling

**Suggested New Architecture:**
- Add \`tokenManager.ts\` for JWT management
- Add \`storage.ts\` for persistence handling
- Add \`errors.ts\` for unified error handling

Should I continue with the implementation?`,
        },
      },
    ],
  },
  parameters: {
    docs: {
      description: {
        story:
          'Shows a complex refactoring task with Todo/Plan updates, file search, and code analysis.',
      },
    },
  },
};

export const LightTheme: Story = {
  args: {
    messages: [
      createMessage(
        '1',
        'user',
        'Show me how to use the light theme.',
        '2026-01-19T10:00:00.000Z',
      ),
      createMessage(
        '2',
        'assistant',
        'The ChatViewer supports light, dark, and auto themes. Set `theme="light"` for light mode styling.',
        '2026-01-19T10:00:05.000Z',
        'coder-model',
      ),
    ],
    theme: 'light',
  },
  decorators: [
    (Story) => (
      <div
        style={{
          background: '#ffffff',
          padding: '20px',
          height: '500px',
        }}
      >
        <Story />
      </div>
    ),
  ],
};

export const AutoScrollDisabled: Story = {
  args: {
    messages: [
      createMessage(
        '1',
        'user',
        'This story has auto-scroll disabled.',
        '2026-01-19T10:00:00.000Z',
      ),
      createMessage(
        '2',
        'assistant',
        'When `autoScroll={false}`, the viewer will not automatically scroll to the bottom when new messages arrive. This is useful when you want users to manually control the scroll position.',
        '2026-01-19T10:00:05.000Z',
        'coder-model',
      ),
    ],
    autoScroll: false,
  },
};

export const EmptyWithoutIcon: Story = {
  args: {
    messages: [],
    emptyMessage: 'No messages yet',
    showEmptyIcon: false,
  },
};

// Interactive story demonstrating ref functionality
const WithRefControlTemplate = () => {
  const chatRef = useRef<ChatViewerHandle>(null);

  const messages: ChatMessageData[] = Array.from({ length: 20 }, (_, i) =>
    createMessage(
      String(i + 1),
      i % 2 === 0 ? 'user' : 'assistant',
      i % 2 === 0
        ? `Question ${Math.floor(i / 2) + 1}: How does feature ${Math.floor(i / 2) + 1} work?`
        : `This is the answer to question ${Math.floor(i / 2) + 1}. The feature works by processing data through multiple stages and returning the result to the caller.`,
      new Date(2026, 0, 19, 10, i).toISOString(),
      i % 2 === 1 ? 'coder-model' : undefined,
    ),
  );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '500px',
        gap: '10px',
      }}
    >
      <div style={{ display: 'flex', gap: '10px' }}>
        <button
          onClick={() => chatRef.current?.scrollToTop('smooth')}
          style={{ padding: '8px 16px', cursor: 'pointer' }}
        >
          Scroll to Top
        </button>
        <button
          onClick={() => chatRef.current?.scrollToBottom('smooth')}
          style={{ padding: '8px 16px', cursor: 'pointer' }}
        >
          Scroll to Bottom
        </button>
      </div>
      <div style={{ flex: 1 }}>
        <ChatViewer ref={chatRef} messages={messages} autoScroll={false} />
      </div>
    </div>
  );
};

export const WithRefControl: Story = {
  render: () => <WithRefControlTemplate />,
  parameters: {
    docs: {
      description: {
        story:
          'Demonstrates programmatic scroll control using the `ref` prop. The `ChatViewerHandle` provides `scrollToTop()`, `scrollToBottom()`, and `getScrollContainer()` methods.',
      },
    },
  },
};

// Comprehensive sample data for playground with all tool types
const PLAYGROUND_SAMPLE = `[
  {
    "uuid": "1",
    "timestamp": "2026-01-15T14:00:00.000Z",
    "type": "user",
    "message": {
      "role": "user",
      "parts": [{ "text": "Help me create a React component and add it to the project" }]
    }
  },
  {
    "uuid": "2",
    "timestamp": "2026-01-15T14:00:05.000Z",
    "type": "assistant",
    "message": {
      "role": "assistant",
      "content": "Sure, let me help you create a React component. First, let me search for the project structure."
    }
  },
  {
    "uuid": "3",
    "timestamp": "2026-01-15T14:00:06.000Z",
    "type": "tool_call",
    "toolCall": {
      "toolCallId": "search-1",
      "kind": "grep",
      "title": "Searching for component patterns",
      "status": "completed",
      "rawInput": "export.*Component",
      "content": [{
        "type": "content",
        "content": {
          "type": "text",
          "text": "src/components/Button.tsx:export const Button: FC = () => {\\nsrc/components/Card.tsx:export const Card: FC = () => {"
        }
      }],
      "locations": [
        { "path": "src/components/Button.tsx", "line": 5 },
        { "path": "src/components/Card.tsx", "line": 8 }
      ]
    }
  },
  {
    "uuid": "4",
    "timestamp": "2026-01-15T14:00:08.000Z",
    "type": "tool_call",
    "toolCall": {
      "toolCallId": "read-1",
      "kind": "read",
      "title": "src/components/Button.tsx",
      "status": "completed",
      "content": [{
        "type": "content",
        "content": {
          "type": "text",
          "text": "import type { FC } from 'react';\\n\\nexport interface ButtonProps {\\n  label: string;\\n  onClick?: () => void;\\n}\\n\\nexport const Button: FC<ButtonProps> = ({ label, onClick }) => (\\n  <button onClick={onClick}>{label}</button>\\n);"
        }
      }],
      "locations": [{ "path": "src/components/Button.tsx" }]
    }
  },
  {
    "uuid": "5",
    "timestamp": "2026-01-15T14:00:10.000Z",
    "type": "assistant",
    "message": {
      "role": "assistant",
      "content": "I found the project's component structure. Now let me create the new component file."
    }
  },
  {
    "uuid": "6",
    "timestamp": "2026-01-15T14:00:12.000Z",
    "type": "tool_call",
    "toolCall": {
      "toolCallId": "write-1",
      "kind": "write",
      "title": "Creating src/components/Modal.tsx",
      "status": "completed",
      "content": [{
        "type": "diff",
        "path": "src/components/Modal.tsx",
        "oldText": null,
        "newText": "import type { FC, ReactNode } from 'react';\\nimport './Modal.css';\\n\\nexport interface ModalProps {\\n  isOpen: boolean;\\n  onClose: () => void;\\n  title: string;\\n  children: ReactNode;\\n}\\n\\nexport const Modal: FC<ModalProps> = ({\\n  isOpen,\\n  onClose,\\n  title,\\n  children,\\n}) => {\\n  if (!isOpen) return null;\\n\\n  return (\\n    <div className=\\"modal-overlay\\">\\n      <div className=\\"modal-content\\">\\n        <header className=\\"modal-header\\">\\n          <h2>{title}</h2>\\n          <button onClick={onClose}>×</button>\\n        </header>\\n        <div className=\\"modal-body\\">\\n          {children}\\n        </div>\\n      </div>\\n    </div>\\n  );\\n};"
      }],
      "locations": [{ "path": "src/components/Modal.tsx" }]
    }
  },
  {
    "uuid": "7",
    "timestamp": "2026-01-15T14:00:15.000Z",
    "type": "tool_call",
    "toolCall": {
      "toolCallId": "edit-1",
      "kind": "edit",
      "title": "Updating src/components/index.ts",
      "status": "completed",
      "content": [{
        "type": "diff",
        "path": "src/components/index.ts",
        "oldText": "export { Button } from './Button';\\nexport { Card } from './Card';",
        "newText": "export { Button } from './Button';\\nexport { Card } from './Card';\\nexport { Modal } from './Modal';"
      }],
      "locations": [{ "path": "src/components/index.ts", "line": 3 }]
    }
  },
  {
    "uuid": "8",
    "timestamp": "2026-01-15T14:00:18.000Z",
    "type": "assistant",
    "message": {
      "role": "assistant",
      "content": "Component created. Let me run tests to make sure there are no issues."
    }
  },
  {
    "uuid": "9",
    "timestamp": "2026-01-15T14:00:20.000Z",
    "type": "tool_call",
    "toolCall": {
      "toolCallId": "bash-1",
      "kind": "bash",
      "title": "Running tests",
      "status": "completed",
      "rawInput": "npm run test -- --coverage",
      "content": [{
        "type": "content",
        "content": {
          "type": "text",
          "text": "PASS src/components/Modal.test.tsx\\n  Modal Component\\n    ✓ renders when isOpen is true (15ms)\\n    ✓ does not render when isOpen is false (3ms)\\n    ✓ calls onClose when close button clicked (8ms)\\n\\nTest Suites: 1 passed, 1 total\\nTests:       3 passed, 3 total\\nCoverage:    92.5%"
        }
      }]
    }
  },
  {
    "uuid": "10",
    "timestamp": "2026-01-15T14:00:25.000Z",
    "type": "tool_call",
    "toolCall": {
      "toolCallId": "plan-1",
      "kind": "todowrite",
      "title": "Updating task progress",
      "status": "completed",
      "content": [{
        "type": "content",
        "content": {
          "type": "plan",
          "entries": [
            { "content": "Search project structure", "status": "completed" },
            { "content": "Create Modal component", "status": "completed" },
            { "content": "Update exports", "status": "completed" },
            { "content": "Run tests", "status": "completed" },
            { "content": "Add documentation", "status": "pending" }
          ]
        }
      }]
    }
  },
  {
    "uuid": "11",
    "timestamp": "2026-01-15T14:00:30.000Z",
    "type": "assistant",
    "message": {
      "role": "assistant",
      "content": "Modal component created successfully and passed all tests!\\n\\n**Created Files:**\\n- \`src/components/Modal.tsx\` - Main component file\\n- \`src/components/Modal.css\` - Styles file\\n\\n**Features:**\\n- Supports open/close state control\\n- Customizable title and content\\n- Close button triggers callback\\n\\nWould you like me to add documentation?"
    }
  }
]`;

// Playground component for testing JSON input with auto-render
const PlaygroundTemplate = () => {
  const [jsonInput, setJsonInput] = useState(PLAYGROUND_SAMPLE);
  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [autoRender, setAutoRender] = useState(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const parseAndRender = useCallback((input: string) => {
    try {
      const parsed = JSON.parse(input);
      if (!Array.isArray(parsed)) {
        throw new Error('JSON must be an array of messages');
      }
      setMessages(parsed);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid JSON');
      setMessages([]);
    }
  }, []);

  // Auto-render with debounce when JSON input changes
  useEffect(() => {
    if (!autoRender) return;

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      parseAndRender(jsonInput);
    }, 300);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [jsonInput, autoRender, parseAndRender]);

  // Parse on initial load
  useEffect(() => {
    parseAndRender(jsonInput);
  }, [parseAndRender, jsonInput]);

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '16px',
        height: '700px',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      {/* Left Panel - JSON Input */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          minWidth: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>
            JSON Input (Messages Array)
          </h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: '12px',
                color: 'var(--app-secondary-foreground, #a1a1aa)',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={autoRender}
                onChange={(e) => setAutoRender(e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              Auto Render
            </label>
            {!autoRender && (
              <button
                onClick={() => parseAndRender(jsonInput)}
                style={{
                  padding: '6px 12px',
                  background: '#3b82f6',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  fontWeight: 500,
                }}
              >
                Render
              </button>
            )}
          </div>
        </div>
        <textarea
          value={jsonInput}
          onChange={(e) => setJsonInput(e.target.value)}
          style={{
            flex: 1,
            padding: '12px',
            fontFamily: 'ui-monospace, monospace',
            fontSize: '12px',
            border: '1px solid var(--app-border, #3f3f46)',
            borderRadius: '6px',
            background: 'var(--app-input-background, #3c3c3c)',
            color: 'var(--app-primary-foreground, #e4e4e7)',
            resize: 'none',
            outline: 'none',
          }}
          placeholder="Paste your JSON messages array here..."
        />
        {error && (
          <div
            style={{
              padding: '8px 12px',
              background: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid #ef4444',
              borderRadius: '4px',
              color: '#ef4444',
              fontSize: '13px',
            }}
          >
            Error: {error}
          </div>
        )}
        <div
          style={{
            fontSize: '11px',
            color: 'var(--app-secondary-foreground, #a1a1aa)',
            lineHeight: 1.5,
          }}
        >
          <strong>Supported message types:</strong>
          <br />• <code>user</code> - User messages with{' '}
          <code>message.parts[].text</code> or <code>message.content</code>
          <br />• <code>assistant</code> - AI responses
          <br />• <code>tool_call</code> - Tool calls with{' '}
          <code>toolCall.kind</code> (read, write, edit, bash, grep, etc.)
        </div>
      </div>

      {/* Right Panel - ChatViewer Preview */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          minWidth: 0,
        }}
      >
        <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>
          ChatViewer Preview
        </h3>
        <div
          style={{
            flex: 1,
            border: '1px solid var(--app-border, #3f3f46)',
            borderRadius: '6px',
            overflow: 'hidden',
          }}
        >
          <ChatViewer
            messages={messages}
            emptyMessage="Paste JSON to preview"
          />
        </div>
      </div>
    </div>
  );
};

export const Playground: Story = {
  render: () => <PlaygroundTemplate />,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        story: `
**Interactive Playground** for testing ChatViewer with custom JSON data.

Paste your chat history JSON (array of messages) on the left, click "Render" to see the result.

### Message Format

\`\`\`json
{
  "uuid": "unique-id",
  "timestamp": "2026-01-15T14:00:00.000Z",
  "type": "user" | "assistant" | "tool_call",
  "message": {
    "role": "user" | "assistant",
    "parts": [{ "text": "..." }],  // Qwen format
    "content": "..."               // Claude format
  },
  "toolCall": {                    // For tool_call type
    "toolCallId": "...",
    "kind": "read" | "write" | "edit" | "bash" | "grep" | ...,
    "title": "...",
    "status": "completed" | "in_progress" | "failed",
    "content": [...],
    "locations": [...]
  }
}
\`\`\`
        `,
      },
    },
  },
  decorators: [
    (Story) => (
      <div
        style={{
          background: 'var(--app-background, #1e1e1e)',
          padding: '20px',
          minHeight: '100vh',
        }}
      >
        <Story />
      </div>
    ),
  ],
};
