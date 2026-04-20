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
    // dataworks "DATA AGENT" ASCII logo is ~81 cols wide (vs official Qwen
    // logo which is narrower); need a wider terminal for the wide-mode test.
    useTerminalSizeMock.mockReturnValue({ columns: 200, rows: 24 });
  });

  // NOTE: dataworks fork rebrands the Header to "DataWorks DataAgent" and
  // removes the auth/model info panel from Header.tsx. The assertions below
  // reflect that. When merging from official, expect conflicts here — the
  // auth-related tests upstream test functionality that no longer exists in
  // this fork's Header.tsx.

  it('renders the ASCII logo on wide terminal', () => {
    const { lastFrame } = render(<Header {...defaultProps} />);
    // dataworks "DATA AGENT" ASCII art — first row of the new logo
    expect(lastFrame()).toContain('██████╗  █████╗ ████████╗');
  });

  it('hides the ASCII logo on narrow terminal', () => {
    useTerminalSizeMock.mockReturnValue({ columns: 60, rows: 24 });
    const { lastFrame } = render(<Header {...defaultProps} />);
    expect(lastFrame()).not.toContain('██████╗  █████╗ ████████╗');
    expect(lastFrame()).toContain('>_ DataWorks DataAgent');
  });

  it('displays the version number', () => {
    const { lastFrame } = render(<Header {...defaultProps} />);
    expect(lastFrame()).toContain('v1.0.0');
  });

  it('displays the DataWorks branding line', () => {
    const { lastFrame } = render(<Header {...defaultProps} />);
    expect(lastFrame()).toContain('DataWorks DataAgent');
    expect(lastFrame()).toContain('Built-in DataWorks Official Skills');
  });

  it('displays model name', () => {
    const { lastFrame } = render(<Header {...defaultProps} />);
    expect(lastFrame()).toContain('qwen-coder-plus');
  });

  it('shows model change hint on wide terminal', () => {
    const { lastFrame } = render(<Header {...defaultProps} />);
    expect(lastFrame()).toContain('/model to change');
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
});
