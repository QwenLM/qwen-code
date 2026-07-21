/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import {
  ThinkMessage,
  ThinkMessageContent,
  toggleKeyHint,
} from './ConversationMessages.js';

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
    expect(output).not.toContain(`${toggleKeyHint} to expand`);
  });

  it('should render collapsed line when committed and not expanded', () => {
    const { lastFrame } = render(
      <ThinkMessage {...defaultProps} isPending={false} expanded={false} />,
    );
    const output = lastFrame();
    expect(output).toContain('Thinking');
    expect(output).toContain(`${toggleKeyHint} to expand`);
    expect(output).not.toContain('Analyzing the code structure');
  });

  it('advertises click in the collapsed hint only when clickable (VP mode)', () => {
    const withoutClick = render(
      <ThinkMessage {...defaultProps} isPending={false} expanded={false} />,
    ).lastFrame();
    expect(withoutClick).not.toContain('click');
    expect(withoutClick).toContain(`${toggleKeyHint} to expand`);

    const withClick = render(
      <ThinkMessage
        {...defaultProps}
        isPending={false}
        expanded={false}
        clickable={true}
      />,
    ).lastFrame();
    expect(withClick).toContain('click');
    expect(withClick).toContain(`${toggleKeyHint} to expand`);
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
    expect(output).toContain(`${toggleKeyHint} to expand`);
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
    expect(output).toContain(`${toggleKeyHint} to expand`);
  });

  it.each([0, 999])(
    'should describe a %dms completed thought as brief',
    (durationMs) => {
      for (const expanded of [false, true]) {
        const { lastFrame } = render(
          <ThinkMessage
            {...defaultProps}
            isPending={false}
            expanded={expanded}
            durationMs={durationMs}
          />,
        );
        const output = lastFrame();
        expect(output).toContain('Thought briefly');
        expect(output).not.toContain('Thought for');
        expect(output).not.toContain('0s');
      }
    },
  );

  it('should show a numeric duration at the one-second boundary', () => {
    const { lastFrame } = render(
      <ThinkMessage
        {...defaultProps}
        isPending={false}
        expanded={false}
        durationMs={1000}
      />,
    );
    const output = lastFrame();
    expect(output).toContain('Thought for 1s');
    expect(output).not.toContain('Thought briefly');
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

  it('should render full streaming content when pending and expanded', () => {
    const longText =
      'Line 1: initial analysis\nLine 2: deeper reasoning\nLine 3: more thought\nLine 4: conclusions';
    const { lastFrame } = render(
      <ThinkMessage
        {...defaultProps}
        text={longText}
        isPending={true}
        expanded={true}
      />,
    );
    const output = lastFrame();
    expect(output).toContain('Thinking');
    expect(output).toContain('Line 1');
    expect(output).toContain('Line 2');
    expect(output).toContain('Line 3');
    expect(output).toContain('Line 4');
  });

  it('should only show tail lines when pending and not expanded', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`);
    const longText = lines.join('\n');
    const { lastFrame } = render(
      <ThinkMessage
        {...defaultProps}
        text={longText}
        isPending={true}
        expanded={false}
        contentWidth={40}
      />,
    );
    const output = lastFrame();
    expect(output).toContain('Thinking');
    expect(output).toContain('Line 20');
    expect(output).not.toContain('Line 1\n');
  });

  it('should not shrink the streaming window when the visible tail momentarily drops', () => {
    // A long unbroken run pushes the tail window to its full height. When the
    // next chunk introduces a newline near the char-budget boundary, the tail
    // slice can momentarily collapse to a single line even though the buffer
    // only grew. Grow-only height must pad that back up so the block does not
    // flicker down and then up again.
    const wide = 'X'.repeat(400);
    const { lastFrame, rerender } = render(
      <ThinkMessage
        {...defaultProps}
        text={wide}
        isPending={true}
        expanded={false}
        contentWidth={40}
      />,
    );
    const tallHeight = (lastFrame() ?? '').split('\n').length;

    rerender(
      <ThinkMessage
        {...defaultProps}
        text={`${wide}\nY`}
        isPending={true}
        expanded={false}
        contentWidth={40}
      />,
    );
    const afterFrame = lastFrame() ?? '';
    expect(afterFrame).toContain('Y');
    // Height is preserved (grow-only), not collapsed to the 1-line natural tail.
    expect(afterFrame.split('\n').length).toBe(tallHeight);
  });

  it('should reset the grow-only window when a new thought replaces the buffer', () => {
    const tall = Array.from({ length: 10 }, (_, i) => `Row ${i + 1}`).join(
      '\n',
    );
    const { lastFrame, rerender } = render(
      <ThinkMessage
        {...defaultProps}
        text={tall}
        isPending={true}
        expanded={false}
        contentWidth={40}
      />,
    );
    const tallHeight = (lastFrame() ?? '').split('\n').length;

    // A shorter buffer signals a fresh thought; the window should shrink back.
    rerender(
      <ThinkMessage
        {...defaultProps}
        text={'short'}
        isPending={true}
        expanded={false}
        contentWidth={40}
      />,
    );
    expect((lastFrame() ?? '').split('\n').length).toBeLessThan(tallHeight);
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

  it('should render full streaming content when pending and expanded', () => {
    const longText =
      'Line 1: step one\nLine 2: step two\nLine 3: step three\nLine 4: step four';
    const { lastFrame } = render(
      <ThinkMessageContent
        {...defaultProps}
        text={longText}
        isPending={true}
        expanded={true}
      />,
    );
    const output = lastFrame();
    expect(output).toContain('Line 1');
    expect(output).toContain('Line 2');
    expect(output).toContain('Line 3');
    expect(output).toContain('Line 4');
  });
});
