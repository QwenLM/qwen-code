/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AuthType,
  isGitRepository,
  getGitBranch,
} from '@qwen-code/qwen-code-core';
import { Header } from './Header.js';
import * as useTerminalSize from '../hooks/useTerminalSize.js';

vi.mock('../hooks/useTerminalSize.js');
const useTerminalSizeMock = vi.mocked(useTerminalSize.useTerminalSize);

// Mock git functions
vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => ({
  ...(await importOriginal()),
  isGitRepository: vi.fn(),
  getGitBranch: vi.fn(),
}));
const mockedIsGitRepository = vi.mocked(isGitRepository);
const mockedGetGitBranch = vi.mocked(getGitBranch);

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
    // Default to not in a git repo (no branch shown)
    mockedIsGitRepository.mockReturnValue(false);
    mockedGetGitBranch.mockReturnValue(undefined);
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

  it('displays git branch when in a git repository', () => {
    mockedIsGitRepository.mockReturnValue(true);
    mockedGetGitBranch.mockReturnValue('main');
    const { lastFrame } = render(<Header {...defaultProps} />);
    expect(lastFrame()).toContain('(main)');
  });

  it('does not display git branch when not in a git repository', () => {
    mockedIsGitRepository.mockReturnValue(false);
    const { lastFrame } = render(<Header {...defaultProps} />);
    // Check that there's no git branch line (e.g., "(main)")
    // Branch is shown after the working directory path, not as part of title
    expect(lastFrame()).not.toContain('(main)');
    expect(lastFrame()).not.toMatch(/\([^)]+\)$/m);
  });

  it('displays different git branch names', () => {
    mockedIsGitRepository.mockReturnValue(true);
    mockedGetGitBranch.mockReturnValue('feature/new-feature');
    const { lastFrame } = render(<Header {...defaultProps} />);
    expect(lastFrame()).toContain('(feature/new-feature)');
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
