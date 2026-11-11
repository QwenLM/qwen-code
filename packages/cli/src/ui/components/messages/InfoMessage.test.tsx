/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  render,
  renderWithProviders,
} from '../../../test-utils/render.js';
import { InfoMessage } from './InfoMessage.js';
import { describe, it, expect } from 'vitest';
import stripAnsi from 'strip-ansi';
import '../../../test-utils/customMatchers.js';

describe('InfoMessage', () => {
  it('renders with the correct default prefix and text', async () => {
    const { lastFrame, unmount } = await render(
      <InfoMessage text="Just so you know" />,
    );
    const output = lastFrame();

    expect(output).toMatchSnapshot();
    unmount();
  });

  it('renders cancellation notices quietly', async () => {
    const { lastFrame, unmount } = await render(
      <InfoMessage text="Request cancelled." />,
    );
    const output = lastFrame();

    expect(output).toMatchSnapshot();
    unmount();
  });

  it('matches SVG snapshot for default info presentation', async () => {
    const renderResult = await render(<InfoMessage text="Just so you know" />);

    await expect(renderResult).toMatchSvgSnapshot();
    renderResult.unmount();
  });

  it('renders info messages with inline code', async () => {
    const { lastFrame, unmount } = await render(
      <InfoMessage text="Use `qwen init` to continue" />,
    );
    const output = lastFrame();

    expect(output).toMatchSnapshot();
    unmount();
  });

  it('matches SVG snapshot for cancellation notice presentation', async () => {
    const renderResult = await render(<InfoMessage text="Request cancelled." />);

    await expect(renderResult).toMatchSvgSnapshot();
    renderResult.unmount();
  });

  it('renders with a custom icon', async () => {
    const { lastFrame, unmount } = await render(
      <InfoMessage text="Custom icon test" icon="★" />,
    );
    const output = lastFrame();

    expect(output).toMatchSnapshot();
    unmount();
  });

  it('does not render the default marker for an explicit empty icon', async () => {
    const { lastFrame, unmount } = await render(
      <InfoMessage text="Configured display" icon="" color="yellow" />,
    );
    const output = stripAnsi(lastFrame() ?? '');

    expect(output).toContain('Configured display');
    expect(output).not.toContain('●');
    unmount();
  });

  it('renders an animated marker for live activity', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <InfoMessage
        text="Waiting for 1 background agent to finish"
        activity
      />,
    );
    const output = stripAnsi(lastFrame() ?? '');

    expect(output).toContain('Waiting for 1 background agent to finish');
    expect(output).toMatch(/[✶✸✹✺✷]/);
    unmount();
  });

  it('renders multiline info messages', async () => {
    const message = 'Info line 1\nInfo line 2';
    const { lastFrame, unmount } = await render(<InfoMessage text={message} />);
    const output = lastFrame();

    expect(output).toMatchSnapshot();
    unmount();
  });

  it('preserves spaces around inline links', async () => {
    const sessionUrl = 'https://example.com/remote/qs_123';
    const { lastFrame, unmount } = await render(
      <InfoMessage
        text={`/remote-control is active · Code in Mobile App or at ${sessionUrl}`}
        links={[
          { text: 'Mobile App', href: 'https://example.com/mobile' },
          { text: sessionUrl, href: sessionUrl },
        ]}
      />,
    );
    const output = stripAnsi(lastFrame() ?? '');

    expect(output).toContain(
      `/remote-control is active · Code in Mobile App or at ${sessionUrl}`,
    );
    expect(output).not.toContain('Code inMobile App');
    unmount();
  });
});
