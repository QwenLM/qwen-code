/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import {
  HookEventName,
  HooksConfigSource,
  HookType,
} from '@qwen-code/qwen-code-core';
import { HookMatcherDetailStep } from './HookMatcherDetailStep.js';
import type {
  HookConfigDisplayInfo,
  HookEventDisplayInfo,
  HookMatcherDisplayInfo,
} from './types.js';

vi.mock('../../../i18n/index.js', () => ({
  t: vi.fn((key: string) => key),
}));

vi.mock('../../hooks/useTerminalSize.js', () => ({
  useTerminalSize: vi.fn(() => ({ columns: 100, rows: 24 })),
}));

vi.mock('../../semantic-colors.js', () => ({
  theme: {
    text: {
      primary: 'white',
      secondary: 'gray',
      accent: 'cyan',
    },
    status: {
      success: 'green',
      error: 'red',
    },
  },
}));

function makeEvent(
  overrides: Partial<HookEventDisplayInfo> = {},
): HookEventDisplayInfo {
  return {
    event: HookEventName.PreToolUse,
    shortDescription: 'short',
    description: 'Input to command is JSON of tool call arguments.',
    exitCodes: [
      { code: 0, description: 'stdout/stderr not shown' },
      { code: 2, description: 'show stderr to model and block tool call' },
      {
        code: 'Other',
        description: 'show stderr to user only but continue with tool call',
      },
    ],
    matcherGroups: [],
    ...overrides,
  };
}

function makeConfig(
  command: string,
  source: HooksConfigSource = HooksConfigSource.User,
): HookConfigDisplayInfo {
  return {
    config: { command, type: HookType.Command },
    source,
    sourceDisplay:
      source === HooksConfigSource.User ? 'User Settings' : 'Local Settings',
    matcher: 'Bash',
    enabled: true,
  };
}

describe('HookMatcherDetailStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the "Event - Matcher: <value>" title', () => {
    const hookEvent = makeEvent();
    const matcherGroup: HookMatcherDisplayInfo = {
      matcher: 'Bash',
      configs: [makeConfig('/x.sh')],
    };

    const { lastFrame } = render(
      <HookMatcherDetailStep
        hookEvent={hookEvent}
        matcherGroup={matcherGroup}
        selectedIndex={0}
      />,
    );

    expect(lastFrame()).toContain(
      `${HookEventName.PreToolUse} - Matcher: Bash`,
    );
  });

  it('keeps the "Matcher:" prefix when the matcher is the * fallback', () => {
    const hookEvent = makeEvent();
    const matcherGroup: HookMatcherDisplayInfo = {
      matcher: '*',
      configs: [makeConfig('/x.sh')],
    };

    const { lastFrame } = render(
      <HookMatcherDetailStep
        hookEvent={hookEvent}
        matcherGroup={matcherGroup}
        selectedIndex={0}
      />,
    );

    expect(lastFrame()).toContain(`${HookEventName.PreToolUse} - Matcher: *`);
  });

  it('keeps the event description visible on the matcher detail page', () => {
    const hookEvent = makeEvent();
    const matcherGroup: HookMatcherDisplayInfo = {
      matcher: 'Bash',
      configs: [makeConfig('/x.sh')],
    };

    const out =
      render(
        <HookMatcherDetailStep
          hookEvent={hookEvent}
          matcherGroup={matcherGroup}
          selectedIndex={0}
        />,
      ).lastFrame() ?? '';

    expect(out).toContain('Input to command is JSON of tool call arguments.');
  });

  it('renders inline exit code descriptions on the matcher detail page', () => {
    const hookEvent = makeEvent();
    const matcherGroup: HookMatcherDisplayInfo = {
      matcher: 'Bash',
      configs: [makeConfig('/x.sh')],
    };

    const out =
      render(
        <HookMatcherDetailStep
          hookEvent={hookEvent}
          matcherGroup={matcherGroup}
          selectedIndex={0}
        />,
      ).lastFrame() ?? '';

    expect(out).toContain('Exit code 0');
    expect(out).toContain('stdout/stderr not shown');
    expect(out).toContain('Exit code 2');
    expect(out).toContain('show stderr to model and block tool call');
    expect(out).toContain('Other exit codes');
    expect(out).toContain(
      'show stderr to user only but continue with tool call',
    );
  });

  it('renders the handler command for command hooks', () => {
    const hookEvent = makeEvent();
    const matcherGroup: HookMatcherDisplayInfo = {
      matcher: 'Bash',
      configs: [makeConfig('/check.sh')],
    };

    const { lastFrame } = render(
      <HookMatcherDetailStep
        hookEvent={hookEvent}
        matcherGroup={matcherGroup}
        selectedIndex={0}
      />,
    );

    const out = lastFrame() ?? '';
    expect(out).toContain('[command]');
    expect(out).toContain('/check.sh');
  });

  it('renders multiple handler rows with numbering', () => {
    const hookEvent = makeEvent();
    const matcherGroup: HookMatcherDisplayInfo = {
      matcher: 'Edit|Write',
      configs: [
        makeConfig('/first.sh'),
        makeConfig('/second.sh', HooksConfigSource.Project),
      ],
    };

    const { lastFrame } = render(
      <HookMatcherDetailStep
        hookEvent={hookEvent}
        matcherGroup={matcherGroup}
        selectedIndex={1}
      />,
    );

    const out = lastFrame() ?? '';
    expect(out).toContain('1.');
    expect(out).toContain('2.');
    expect(out).toContain('/first.sh');
    expect(out).toContain('/second.sh');
    expect(out).toContain('User Settings');
    expect(out).toContain('Local Settings');
  });

  it('places the selection arrow on the selected handler row', () => {
    const hookEvent = makeEvent();
    const matcherGroup: HookMatcherDisplayInfo = {
      matcher: 'Bash',
      configs: [makeConfig('/first.sh'), makeConfig('/second.sh')],
    };

    const { lastFrame } = render(
      <HookMatcherDetailStep
        hookEvent={hookEvent}
        matcherGroup={matcherGroup}
        selectedIndex={1}
      />,
    );

    const out = lastFrame() ?? '';
    const arrowLine = out.split('\n').find((line) => line.includes('❯'));
    expect(arrowLine).toBeDefined();
    expect(arrowLine).toContain('/second.sh');
  });

  it('renders empty state when the matcher group has no handlers', () => {
    const hookEvent = makeEvent();
    const matcherGroup: HookMatcherDisplayInfo = {
      matcher: 'Bash',
      configs: [],
    };

    const { lastFrame } = render(
      <HookMatcherDetailStep
        hookEvent={hookEvent}
        matcherGroup={matcherGroup}
        selectedIndex={0}
      />,
    );

    const out = lastFrame() ?? '';
    expect(out).toContain('No hooks configured for this matcher');
    expect(out).toContain('Esc to go back');
  });
});
