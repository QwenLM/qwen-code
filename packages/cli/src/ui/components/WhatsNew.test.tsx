/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { history } = vi.hoisted(() => ({
  history: {
    hasSeenVersion: vi.fn(),
    markVersionSeen: vi.fn(),
  },
}));

vi.mock('../../services/tips/index.js', () => ({
  getTipHistory: () => history,
}));

vi.mock('../../i18n/index.js', () => ({
  t: (value: string, variables: Record<string, string> = {}) =>
    value.replace(
      /{{(\w+)}}/g,
      (match, key: string) => variables[key] ?? match,
    ),
}));

vi.mock('../semantic-colors.js', () => ({
  theme: {
    border: { default: 'gray' },
    text: { accent: 'cyan', primary: 'white' },
  },
}));

import { WhatsNew } from './WhatsNew.js';

describe('<WhatsNew />', () => {
  beforeEach(() => {
    history.hasSeenVersion.mockReset();
    history.markVersionSeen.mockReset();
  });

  it('renders curated highlights for a newly seen known version', async () => {
    history.hasSeenVersion.mockReturnValue(false);

    const { lastFrame } = render(<WhatsNew version="0.20.1" />);

    await vi.waitFor(() => {
      expect(history.hasSeenVersion).toHaveBeenCalledWith('0.20.1');
      expect(history.markVersionSeen).toHaveBeenCalledWith('0.20.1');
    });
    expect(lastFrame()).toContain("What's new in v0.20.1");
    expect(lastFrame()).toContain(
      'Fork subagents with the context of the current conversation.',
    );
  });

  it('does not render a version that history has already seen', async () => {
    history.hasSeenVersion.mockReturnValue(true);

    const { lastFrame } = render(<WhatsNew version="0.20.1" />);

    await vi.waitFor(() =>
      expect(history.hasSeenVersion).toHaveBeenCalledWith('0.20.1'),
    );
    expect(lastFrame()).not.toContain("What's new in");
    expect(history.markVersionSeen).not.toHaveBeenCalled();
  });

  it('does not read or mark an unknown version', () => {
    const { lastFrame } = render(<WhatsNew version="0.20.2" />);

    expect(lastFrame()).not.toContain("What's new in");
    expect(history.hasSeenVersion).not.toHaveBeenCalled();
    expect(history.markVersionSeen).not.toHaveBeenCalled();
  });
});
