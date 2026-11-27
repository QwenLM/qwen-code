/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { render } from '../../../test-utils/render.js';
import { Text } from 'ink';
import { act } from 'react';
import {
  isShellTool,
  McpProgressIndicator,
  ToolStatusPulseFrames,
} from './ToolShared.js';

vi.mock('../ModelRespondingSpinner.js', () => ({
  ModelRespondingSpinner: () => <Text>MockSpinner</Text>,
}));

afterEach(() => {
  vi.useRealTimers();
});

describe('shell tool classification', () => {
  it.each(['PowerShell', 'Bash', 'Shell'])(
    'uses the shared shell view for %s',
    (name) => {
      expect(isShellTool(name)).toBe(true);
    },
  );
  it('keeps unrelated tools outside the shell view', () => {
    expect(isShellTool('Read')).toBe(false);
  });
});

describe('ToolStatusPulseFrames', () => {
  it('does not advance its local animation while offscreen', async () => {
    vi.useFakeTimers();
    let visible = false;
    const result = await render(
      <Text>
        <ToolStatusPulseFrames shouldAnimate={true} isVisible={() => visible} />
      </Text>,
    );

    expect(result.lastFrame()).toContain('▫');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });
    expect(result.lastFrame()).toContain('▫');

    visible = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });
    await result.waitUntilReady();
    expect(result.lastFrame()).toContain('▪');
    result.unmount();
  });
});

describe('McpProgressIndicator', () => {
  it('renders determinate progress at 50%', async () => {
    const { lastFrame } = await render(
      <McpProgressIndicator progress={50} total={100} barWidth={20} />,
    );
    const output = lastFrame();
    expect(output).toMatchSnapshot();
    expect(output).toContain('50%');
  });

  it('renders complete progress at 100%', async () => {
    const { lastFrame } = await render(
      <McpProgressIndicator progress={100} total={100} barWidth={20} />,
    );
    const output = lastFrame();
    expect(output).toMatchSnapshot();
    expect(output).toContain('100%');
  });

  it('renders indeterminate progress with raw count', async () => {
    const { lastFrame } = await render(
      <McpProgressIndicator progress={7} barWidth={20} />,
    );
    const output = lastFrame();
    expect(output).toMatchSnapshot();
    expect(output).toContain('7');
    expect(output).not.toContain('%');
  });

  it('renders progress with a message', async () => {
    const { lastFrame } = await render(
      <McpProgressIndicator
        progress={30}
        total={100}
        message="Downloading..."
        barWidth={20}
      />,
    );
    const output = lastFrame();
    expect(output).toMatchSnapshot();
    expect(output).toContain('Downloading...');
  });

  it('clamps progress exceeding total to 100%', async () => {
    const { lastFrame } = await render(
      <McpProgressIndicator progress={150} total={100} barWidth={20} />,
    );
    const output = lastFrame();
    expect(output).toContain('100%');
    expect(output).not.toContain('150%');
  });
});
