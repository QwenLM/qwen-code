/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  render,
  renderWithProviders,
  cleanup,
} from '../../../test-utils/render.js';
import { SubagentProgressDisplay } from './SubagentProgressDisplay.js';
import {
  AgentTerminateMode,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  type SubagentProgress,
} from '@qwen-code/core';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Text } from 'ink';

describe('<SubagentProgressDisplay />', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('renders correctly with description in args', async () => {
    const progress: SubagentProgress = {
      isSubagentProgress: true,
      agentName: 'TestAgent',
      recentActivity: [
        {
          id: '1',
          type: 'tool_call',
          content: 'Bash',
          args: '{"command": "echo hello", "description": "Say hello"}',
          status: 'running',
        },
      ],
    };

    const { lastFrame } = await render(
      <SubagentProgressDisplay progress={progress} terminalWidth={80} />,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('renders prompt when progress includes the agent prompt', async () => {
    const progress: SubagentProgress = {
      isSubagentProgress: true,
      agentName: 'TestAgent',
      prompt: 'Search the codebase for TODO comments.',
      recentActivity: [
        {
          id: '1',
          type: 'tool_call',
          content: 'Grep',
          args: '{"pattern": "TODO"}',
          status: 'running',
        },
      ],
    };

    const { lastFrame } = await render(
      <SubagentProgressDisplay progress={progress} terminalWidth={80} />,
    );

    expect(lastFrame()).toContain(
      'Prompt: Search the codebase for TODO comments.',
    );
    expect(lastFrame()).toContain("▫ Grep 'TODO' within ./");
  });

  it('renders correctly with displayName and description from item', async () => {
    const progress: SubagentProgress = {
      isSubagentProgress: true,
      agentName: 'TestAgent',
      recentActivity: [
        {
          id: '1',
          type: 'tool_call',
          content: 'Bash',
          displayName: 'RunShellCommand',
          description: 'Executing echo hello',
          args: '{"command": "echo hello"}',
          status: 'running',
        },
      ],
    };

    const { lastFrame } = await render(
      <SubagentProgressDisplay progress={progress} terminalWidth={80} />,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('renders correctly with command fallback', async () => {
    const progress: SubagentProgress = {
      isSubagentProgress: true,
      agentName: 'TestAgent',
      recentActivity: [
        {
          id: '2',
          type: 'tool_call',
          content: 'Bash',
          args: '{"command": "echo hello"}',
          status: 'running',
        },
      ],
    };

    const { lastFrame } = await render(
      <SubagentProgressDisplay progress={progress} terminalWidth={80} />,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('renders correctly with file_path', async () => {
    const progress: SubagentProgress = {
      isSubagentProgress: true,
      agentName: 'TestAgent',
      recentActivity: [
        {
          id: '3',
          type: 'tool_call',
          content: 'Write',
          args: '{"file_path": "/tmp/test.txt", "content": "foo"}',
          status: 'completed',
        },
      ],
    };

    const { lastFrame } = await render(
      <SubagentProgressDisplay progress={progress} terminalWidth={80} />,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('truncates long args', async () => {
    const longDesc =
      'This is a very long description that should definitely be truncated because it exceeds the limit of sixty characters.';
    const progress: SubagentProgress = {
      isSubagentProgress: true,
      agentName: 'TestAgent',
      recentActivity: [
        {
          id: '4',
          type: 'tool_call',
          content: 'Bash',
          args: JSON.stringify({ description: longDesc }),
          status: 'running',
        },
      ],
    };

    const { lastFrame } = await render(
      <SubagentProgressDisplay progress={progress} terminalWidth={80} />,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('renders thought bubbles correctly', async () => {
    const progress: SubagentProgress = {
      isSubagentProgress: true,
      agentName: 'TestAgent',
      recentActivity: [
        {
          id: '5',
          type: 'thought',
          content: 'Thinking about life',
          status: 'running',
        },
      ],
    };

    const { lastFrame } = await render(
      <SubagentProgressDisplay progress={progress} terminalWidth={80} />,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('renders cancelled state correctly', async () => {
    const progress: SubagentProgress = {
      isSubagentProgress: true,
      agentName: 'TestAgent',
      recentActivity: [],
      state: 'cancelled',
    };

    const { lastFrame } = await render(
      <SubagentProgressDisplay progress={progress} terminalWidth={80} />,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('renders an actionable maxTurns termination notice', async () => {
    const progress: SubagentProgress = {
      isSubagentProgress: true,
      agentName: 'TestAgent',
      recentActivity: [],
      state: 'completed',
      result: 'Partial review result',
      terminateReason: AgentTerminateMode.MAX_TURNS,
      terminationDetails: { maxTurns: 150 },
    };

    const { lastFrame } = await renderWithProviders(
      <SubagentProgressDisplay progress={progress} terminalWidth={100} />,
    );

    expect(lastFrame()).toContain('Reached the maximum turn limit (150).');
    expect(lastFrame()).toContain('Increase maxTurns');
    expect(lastFrame()).toContain('configuration and retry.');
    expect(lastFrame()).toContain('Partial review result');
  });

  it('renders "Request cancelled." as a quiet activity row', async () => {
    const progress: SubagentProgress = {
      isSubagentProgress: true,
      agentName: 'TestAgent',
      recentActivity: [
        {
          id: '6',
          type: 'thought',
          content: 'Request cancelled.',
          status: 'error',
        },
      ],
    };

    const { lastFrame } = await render(
      <SubagentProgressDisplay progress={progress} terminalWidth={80} />,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('renders error tool status correctly', async () => {
    const progress: SubagentProgress = {
      isSubagentProgress: true,
      agentName: 'TestAgent',
      recentActivity: [
        {
          id: '7',
          type: 'tool_call',
          content: 'Bash',
          args: '{"command": "echo hello"}',
          status: 'error',
        },
      ],
    };

    const { lastFrame } = await render(
      <SubagentProgressDisplay progress={progress} terminalWidth={80} />,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('projects structured tool results through the supplied renderer', async () => {
    const progress: SubagentProgress = {
      isSubagentProgress: true,
      agentName: 'TestAgent',
      recentActivity: [
        {
          id: '8',
          type: 'tool_call',
          content: WEB_FETCH_TOOL_NAME,
          toolInput: {
            url: 'https://example.com',
            prompt: 'summarize',
          },
          toolResult: {
            content: 'raw content',
            isError: false,
            toolUseResult: {
              summary: 'Fetched example.com',
              payload: 'Full fetched page content',
            },
          },
          status: 'completed',
        },
      ],
    };

    const { lastFrame } = await render(
      <SubagentProgressDisplay
        progress={progress}
        terminalWidth={80}
        renderToolResult={(tool) => {
          const result = tool.resultDisplay;
          return (
            <Text>
              {typeof result === 'object' &&
              result !== null &&
              'summary' in result
                ? result.summary
                : ''}
            </Text>
          );
        }}
      />,
    );

    expect(lastFrame()).toContain('WebFetch');
    expect(lastFrame()).toContain('└ Fetched example.com');
    expect(lastFrame()).toContain('Fetched example.com');
  });

  it('projects structured grep and glob results through the supplied renderer', async () => {
    const progress: SubagentProgress = {
      isSubagentProgress: true,
      agentName: 'TestAgent',
      recentActivity: [
        {
          id: 'grep-1',
          type: 'tool_call',
          content: GREP_TOOL_NAME,
          toolInput: {
            pattern: 'render',
            path: 'src',
          },
          toolResult: {
            content: 'Found 2 files\nsrc/a.ts\nsrc/b.ts',
            isError: false,
            toolUseResult: {
              mode: 'files_with_matches',
              numFiles: 2,
              filenames: ['src/a.ts', 'src/b.ts'],
            },
          },
          status: 'completed',
        },
        {
          id: 'glob-1',
          type: 'tool_call',
          content: GLOB_TOOL_NAME,
          toolInput: {
            pattern: '*.ts',
          },
          toolResult: {
            content: 'src/a.ts',
            isError: false,
            toolUseResult: {
              durationMs: 3,
              numFiles: 1,
              filenames: ['src/a.ts'],
              truncated: false,
            },
          },
          status: 'completed',
        },
      ],
    };

    const { lastFrame } = await render(
      <SubagentProgressDisplay
        progress={progress}
        terminalWidth={80}
        renderToolResult={(tool) => {
          const result = tool.resultDisplay;
          return (
            <Text>
              {typeof result === 'object' && result !== null
                ? JSON.stringify(result)
                : result}
            </Text>
          );
        }}
      />,
    );

    expect(lastFrame()).toContain('Grep');
    expect(lastFrame()).toContain('"mode":"files_with_matches"');
    expect(lastFrame()).toContain('Glob');
    expect(lastFrame()).toContain('"durationMs":3');
  });
});
