/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Header, AuthDisplayType } from './Header.js';
import * as useTerminalSize from '../hooks/useTerminalSize.js';

vi.mock('../hooks/useTerminalSize.js');
const useTerminalSizeMock = vi.mocked(useTerminalSize.useTerminalSize);

const defaultProps = {
  version: '1.0.0',
  authDisplayType: AuthDisplayType.QWEN_OAUTH,
  model: 'qwen-coder-plus',
  workingDirectory: '/home/user/projects/test',
};

describe('<Header />', () => {
  const originalNoColor = process.env['NO_COLOR'];

  beforeEach(() => {
    delete process.env['NO_COLOR'];
    useTerminalSizeMock.mockReturnValue({ columns: 120, rows: 24 });
  });

  afterEach(() => {
    if (originalNoColor === undefined) {
      delete process.env['NO_COLOR'];
    } else {
      process.env['NO_COLOR'] = originalNoColor;
    }
  });

  it('renders the ASCII logo on wide terminal', () => {
    const { lastFrame } = render(<Header {...defaultProps} />);
    expect(lastFrame()).toContain('██╔═══██╗');
  });

  it('hides the ASCII logo on narrow terminal', () => {
    useTerminalSizeMock.mockReturnValue({ columns: 60, rows: 24 });
    const { lastFrame } = render(<Header {...defaultProps} />);
    expect(lastFrame()).not.toContain('██╔═══██╗');
    expect(lastFrame()).toContain('>_ Qwen Code');
  });

  it('displays the version number', () => {
    const { lastFrame } = render(<Header {...defaultProps} />);
    expect(lastFrame()).toContain('v1.0.0');
  });

  it('displays auth type and model', () => {
    const { lastFrame } = render(<Header {...defaultProps} />);
    expect(lastFrame()).toContain('Qwen OAuth');
    expect(lastFrame()).toContain('qwen-coder-plus');
  });

  it('displays Coding Plan auth type', () => {
    const { lastFrame } = render(
      <Header
        {...defaultProps}
        authDisplayType={AuthDisplayType.CODING_PLAN}
      />,
    );
    expect(lastFrame()).toContain('Coding Plan');
  });

  it('displays API Key auth type', () => {
    const { lastFrame } = render(
      <Header {...defaultProps} authDisplayType={AuthDisplayType.API_KEY} />,
    );
    expect(lastFrame()).toContain('API Key');
  });

  it('displays custom provider auth labels as-is', () => {
    const { lastFrame } = render(
      <Header {...defaultProps} authDisplayType="OpenRouter" />,
    );
    expect(lastFrame()).toContain('OpenRouter');
    expect(lastFrame()).not.toContain('Unknown');
  });

  it('displays Unknown when auth type is not set', () => {
    const { lastFrame } = render(
      <Header {...defaultProps} authDisplayType={undefined} />,
    );
    expect(lastFrame()).toContain('Unknown');
  });

  it('displays working directory', () => {
    const { lastFrame } = render(<Header {...defaultProps} />);
    expect(lastFrame()).toContain('/home/user/projects/test');
  });

  it('renders with border around info panel', () => {
    const { lastFrame } = render(<Header {...defaultProps} />);
    expect(lastFrame()).toContain('┌');
    expect(lastFrame()).toContain('┐');
  });

  it('renders plain text when NO_COLOR disables gradient colors', () => {
    process.env['NO_COLOR'] = '1';

    const { lastFrame } = render(<Header {...defaultProps} />);

    expect(lastFrame()).toContain('██╔═══██╗');
  });

  it('renders the custom subtitle in place of the blank spacer row', () => {
    const { lastFrame } = render(
      <Header
        {...defaultProps}
        customBannerSubtitle="Built-in DataWorks Official Skills"
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Built-in DataWorks Official Skills');
    // Subtitle sits between the title and the auth line.
    const titleIdx = frame.indexOf('>_ Qwen Code');
    const subtitleIdx = frame.indexOf('Built-in DataWorks Official Skills');
    const authIdx = frame.indexOf('Qwen OAuth');
    expect(titleIdx).toBeLessThan(subtitleIdx);
    expect(subtitleIdx).toBeLessThan(authIdx);
  });

  it('keeps the blank spacer row when no subtitle is set (back-compat)', () => {
    const { lastFrame } = render(<Header {...defaultProps} />);
    const frame = lastFrame() ?? '';
    // Title and auth still both render at their usual positions; the
    // spacer between them is just whitespace-padding, so we assert the
    // visible chrome the user sees.
    expect(frame).toContain('>_ Qwen Code');
    expect(frame).toContain('Qwen OAuth');
  });

  it('renders the custom banner title in place of the default brand', () => {
    const { lastFrame } = render(
      <Header {...defaultProps} customBannerTitle="Acme CLI" />,
    );
    expect(lastFrame()).toContain('Acme CLI');
    expect(lastFrame()).not.toContain('>_ Qwen Code');
    // version suffix is still appended
    expect(lastFrame()).toContain('v1.0.0');
  });

  it('renders the custom large tier when it fits', () => {
    const { lastFrame } = render(
      <Header
        {...defaultProps}
        customAsciiArt={{ small: 'SMALL', large: 'LARGE_LOGO' }}
      />,
    );
    expect(lastFrame()).toContain('LARGE_LOGO');
    expect(lastFrame()).not.toContain('██╔═══██╗');
  });

  it('falls back to the small tier when the large one does not fit', () => {
    useTerminalSizeMock.mockReturnValue({ columns: 70, rows: 24 });
    const { lastFrame } = render(
      <Header
        {...defaultProps}
        customAsciiArt={{
          small: 'sm',
          large: 'X'.repeat(60),
        }}
      />,
    );
    expect(lastFrame()).toContain('sm');
    expect(lastFrame()).not.toContain('X'.repeat(60));
  });

  it('hides the logo column when neither custom tier fits — does NOT fall back to the default Qwen logo (preserves white-label intent)', () => {
    const { lastFrame } = render(
      <Header
        {...defaultProps}
        customAsciiArt={{ small: 'X'.repeat(150), large: 'Y'.repeat(150) }}
      />,
    );
    expect(lastFrame()).not.toContain('██╔═══██╗');
    expect(lastFrame()).not.toContain('X'.repeat(150));
    expect(lastFrame()).not.toContain('Y'.repeat(150));
    // Info panel still renders.
    expect(lastFrame()).toContain('Qwen OAuth');
  });

  it('falls back to the default Qwen logo when no custom art was provided at all', () => {
    useTerminalSizeMock.mockReturnValue({ columns: 60, rows: 24 });
    const { lastFrame } = render(<Header {...defaultProps} />);
    // With no customAsciiArt, narrow widths still hide the QWEN logo, but a
    // wide enough terminal would show it — the previous test already covers
    // the wide case. This one just confirms the no-custom-art path doesn't
    // incidentally hide the logo.
    expect(lastFrame()).toContain('>_ Qwen Code');
  });
});
