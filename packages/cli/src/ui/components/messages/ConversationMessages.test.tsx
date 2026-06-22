/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { ThinkMessage, ThinkMessageContent } from './ConversationMessages.js';

describe('<ThinkMessage />', () => {
  const defaultProps = {
    text: 'Analyzing the code structure',
    contentWidth: 80,
  };

  it('should render content when pending (streaming)', () => {
    const { lastFrame } = render(
      <ThinkMessage {...defaultProps} isPending={true} />,
    );
    const output = lastFrame();
    expect(output).toContain('Thinking');
    expect(output).not.toContain('alt+t to expand');
  });

  it('should render collapsed line when committed and not expanded', () => {
    const { lastFrame } = render(
      <ThinkMessage {...defaultProps} isPending={false} expanded={false} />,
    );
    const output = lastFrame();
    expect(output).toContain('Thinking');
    expect(output).toContain('alt+t to expand');
    expect(output).not.toContain('Analyzing the code structure');
  });

  it('should render full text when committed and expanded', () => {
    const { lastFrame } = render(
      <ThinkMessage {...defaultProps} isPending={false} expanded={true} />,
    );
    const output = lastFrame();
    expect(output).toContain('Analyzing the code structure');
  });

  it('should default to collapsed when expanded is omitted', () => {
    const { lastFrame } = render(
      <ThinkMessage {...defaultProps} isPending={false} />,
    );
    const output = lastFrame();
    expect(output).toContain('alt+t to expand');
    expect(output).not.toContain('Analyzing the code structure');
  });

  it('should show past-tense duration when collapsed', () => {
    const { lastFrame } = render(
      <ThinkMessage
        {...defaultProps}
        isPending={false}
        expanded={false}
        durationMs={15200}
      />,
    );
    const output = lastFrame();
    expect(output).toContain('Thought for');
    expect(output).toContain('15s');
    expect(output).toContain('alt+t to expand');
  });

  it('should show present-tense duration while pending (streaming)', () => {
    const { lastFrame } = render(
      <ThinkMessage {...defaultProps} isPending={true} durationMs={8000} />,
    );
    const output = lastFrame();
    expect(output).toContain('Thinking');
    expect(output).toContain('8s');
    expect(output).not.toContain('Thought for');
  });

  it('should format minutes and seconds for long durations', () => {
    const { lastFrame } = render(
      <ThinkMessage
        {...defaultProps}
        isPending={false}
        expanded={false}
        durationMs={125000}
      />,
    );
    const output = lastFrame();
    expect(output).toContain('Thought for');
    expect(output).toContain('2m 5s');
  });
});

describe('<ThinkMessageContent />', () => {
  const defaultProps = {
    text: 'Continuation of the reasoning',
    contentWidth: 80,
  };

  it('should render when pending (streaming)', () => {
    const { lastFrame } = render(
      <ThinkMessageContent {...defaultProps} isPending={true} />,
    );
    const output = lastFrame();
    expect(output).not.toBe('');
  });

  it('should render nothing when committed and not expanded', () => {
    const { lastFrame } = render(
      <ThinkMessageContent
        {...defaultProps}
        isPending={false}
        expanded={false}
      />,
    );
    expect(lastFrame()).toBe('');
  });

  it('should render when committed and expanded', () => {
    const { lastFrame } = render(
      <ThinkMessageContent
        {...defaultProps}
        isPending={false}
        expanded={true}
      />,
    );
    const output = lastFrame();
    expect(output).toContain('Continuation of the reasoning');
  });
});
