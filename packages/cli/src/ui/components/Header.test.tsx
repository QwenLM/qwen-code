/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  beforeEach(() => {
    useTerminalSizeMock.mockReturnValue({ columns: 120, rows: 24 });
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
    expect(lastFrame()).toContain('╭');
    expect(lastFrame()).toContain('╯');
  });
});
