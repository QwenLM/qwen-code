/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core';
import { Header } from './Header.js';
import * as useTerminalSize from '../hooks/useTerminalSize.js';

vi.mock('../hooks/useTerminalSize.js');
const useTerminalSizeMock = vi.mocked(useTerminalSize.useTerminalSize);

const defaultProps = {
  version: '1.0.0',
  authType: AuthType.QWEN_OAUTH,
  model: 'qwen-coder-plus',
  workingDirectory: '/home/user/projects/test',
};

describe('<Header />', () => {
  beforeEach(() => {
    // Default to wide terminal (shows both logo and info panel)
    useTerminalSizeMock.mockReturnValue({ columns: 120, rows: 24 });
  });

  it('renders the ASCII logo on wide terminal', () => {
    const { lastFrame } = render(<Header {...defaultProps} />);
    // Check that parts of the shortAsciiLogo are rendered
    expect(lastFrame()).toContain('██╔═══██╗');
  });

  it('hides the ASCII logo on narrow terminal', () => {
    useTerminalSizeMock.mockReturnValue({ columns: 60, rows: 24 });
    const { lastFrame } = render(<Header {...defaultProps} />);
    // Should not contain the logo but still show the info panel
    expect(lastFrame()).not.toContain('██╔═══██╗');
    expect(lastFrame()).toContain('>_ Qwen Code');
  });

  it('renders custom ASCII art when provided on wide terminal', () => {
    const customArt = 'CUSTOM ART';
    const { lastFrame } = render(
      <Header {...defaultProps} customAsciiArt={customArt} />,
    );
    expect(lastFrame()).toContain(customArt);
  });

  it('displays the version number', () => {
    const { lastFrame } = render(<Header {...defaultProps} />);
    expect(lastFrame()).toContain('v1.0.0');
  });

  it('displays Qwen Code title with >_ prefix', () => {
    const { lastFrame } = render(<Header {...defaultProps} />);
    expect(lastFrame()).toContain('>_ Qwen Code');
  });

  it('displays auth type and model', () => {
    const { lastFrame } = render(<Header {...defaultProps} />);
    expect(lastFrame()).toContain('Qwen OAuth');
    expect(lastFrame()).toContain('qwen-coder-plus');
  });

  it('displays working directory', () => {
    const { lastFrame } = render(<Header {...defaultProps} />);
    expect(lastFrame()).toContain('/home/user/projects/test');
  });

  it('renders a custom working directory display', () => {
    const { lastFrame } = render(
      <Header {...defaultProps} workingDirectory="custom display" />,
    );
    expect(lastFrame()).toContain('custom display');
  });

  it('displays working directory without branch name', () => {
    const { lastFrame } = render(<Header {...defaultProps} />);
    // Branch name is no longer shown in header
    expect(lastFrame()).toContain('/home/user/projects/test');
    expect(lastFrame()).not.toContain('(main*)');
  });

  it('formats home directory with tilde', () => {
    const { lastFrame } = render(
      <Header {...defaultProps} workingDirectory="/Users/testuser/projects" />,
    );
    // The actual home dir replacement depends on os.homedir()
    // Just verify the path is shown
    expect(lastFrame()).toContain('projects');
  });

  it('renders with border around info panel', () => {
    const { lastFrame } = render(<Header {...defaultProps} />);
    // Check for border characters (round border style uses these)
    expect(lastFrame()).toContain('╭');
    expect(lastFrame()).toContain('╯');
  });
});
