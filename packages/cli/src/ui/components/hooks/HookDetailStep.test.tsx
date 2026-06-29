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
import { HookDetailStep } from './HookDetailStep.js';
import type { HookConfigDisplayInfo, HookEventDisplayInfo } from './types.js';

vi.mock('../../../i18n/index.js', () => ({
  t: vi.fn((key: string, options?: { count?: string }) => {
    if (key === '{{count}} hook' && options?.count) {
      return `${options.count} hook`;
    }
    if (key === '{{count}} hooks' && options?.count) {
      return `${options.count} hooks`;
    }
    return key;
  }),
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

function makeConfig(
  command: string,
  source: HooksConfigSource = HooksConfigSource.User,
  matcher = '*',
): HookConfigDisplayInfo {
  return {
    config: { command, type: HookType.Command },
    source,
    sourceDisplay:
      source === HooksConfigSource.User ? 'User Settings' : 'Local Settings',
    matcher,
    enabled: true,
  };
}

function makeHookInfo(
  groups: Array<{
    matcher: string;
    configs: HookConfigDisplayInfo[];
    sequential?: boolean;
  }>,
  opts: {
    event?: HookEventName;
    description?: string;
    exitCodes?: HookEventDisplayInfo['exitCodes'];
    flatConfigs?: HookConfigDisplayInfo[];
  } = {},
): HookEventDisplayInfo {
  const matcherGroups = opts.flatConfigs
    ? [{ matcher: '*', configs: opts.flatConfigs, sequential: false }]
    : groups;
  return {
    event: opts.event ?? HookEventName.PreToolUse,
    shortDescription: 'short',
    description: opts.description ?? '',
    exitCodes: opts.exitCodes ?? [
      { code: 0, description: 'Success' },
      { code: 2, description: 'Block' },
    ],
    matcherGroups,
  };
}

describe('HookDetailStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the "Event - Matchers" title', () => {
    const hook = makeHookInfo([
      { matcher: '*', configs: [makeConfig('/x.sh')] },
    ]);

    const { lastFrame } = render(
      <HookDetailStep hook={hook} selectedIndex={0} />,
    );

    expect(lastFrame()).toContain(`${HookEventName.PreToolUse} - Matchers`);
  });

  it('renders event description when present', () => {
    const hook = makeHookInfo(
      [{ matcher: '*', configs: [makeConfig('/x.sh')] }],
      { description: 'desc-for-event' },
    );

    const { lastFrame } = render(
      <HookDetailStep hook={hook} selectedIndex={0} />,
    );

    expect(lastFrame()).toContain('desc-for-event');
  });

  it('renders inline exit code descriptions', () => {
    const hook = makeHookInfo([
      { matcher: '*', configs: [makeConfig('/x.sh')] },
    ]);

    const out =
      render(<HookDetailStep hook={hook} selectedIndex={0} />).lastFrame() ??
      '';
    expect(out).toContain('Exit code');
    expect(out).toContain('Success');
    expect(out).toContain('Block');
    const hook2 = makeHookInfo(
      [{ matcher: '*', configs: [makeConfig('/x.sh')] }],
      {
        exitCodes: [{ code: 'Other', description: 'other-desc' }],
      },
    );
    const out2 =
      render(<HookDetailStep hook={hook2} selectedIndex={0} />).lastFrame() ??
      '';
    expect(out2).toContain('Other exit codes');
    expect(out2).toContain('other-desc');
  });

  it('shows empty state when no matcher groups', () => {
    const hook = makeHookInfo([]);

    const out =
      render(<HookDetailStep hook={hook} selectedIndex={0} />).lastFrame() ??
      '';
    expect(out).toContain('No hooks configured for this event');
    expect(out).toContain('Esc to go back');
  });

  it('renders matcher rows with [Source] label and matcher', () => {
    const hook = makeHookInfo([
      {
        matcher: '*',
        configs: [makeConfig('/star.sh', HooksConfigSource.User, '*')],
      },
      {
        matcher: 'Bash',
        configs: [makeConfig('/bash.sh', HooksConfigSource.User, 'Bash')],
      },
    ]);

    const out =
      render(<HookDetailStep hook={hook} selectedIndex={0} />).lastFrame() ??
      '';
    expect(out).toContain('[User] *');
    expect(out).toContain('[User] Bash');
  });

  it('uses Project label for workspace-source matcher groups', () => {
    const hook = makeHookInfo([
      {
        matcher: 'Bash',
        configs: [makeConfig('/bash.sh', HooksConfigSource.Project, 'Bash')],
      },
    ]);

    const out =
      render(<HookDetailStep hook={hook} selectedIndex={0} />).lastFrame() ??
      '';
    expect(out).toContain('[Project] Bash');
  });

  it('renders all unique source labels for mixed-source matcher groups', () => {
    const hook = makeHookInfo([
      {
        matcher: 'Bash',
        configs: [
          makeConfig('/user.sh', HooksConfigSource.User, 'Bash'),
          makeConfig('/project.sh', HooksConfigSource.Project, 'Bash'),
          makeConfig('/user-two.sh', HooksConfigSource.User, 'Bash'),
        ],
      },
    ]);

    const out =
      render(<HookDetailStep hook={hook} selectedIndex={0} />).lastFrame() ??
      '';
    expect(out).toContain('[User, Project] Bash');
  });

  it('renders singular "1 hook" and plural "N hooks"', () => {
    const hook = makeHookInfo([
      {
        matcher: '*',
        configs: [makeConfig('/a.sh', HooksConfigSource.User, '*')],
      },
      {
        matcher: 'Bash',
        configs: [
          makeConfig('/b.sh', HooksConfigSource.User, 'Bash'),
          makeConfig('/c.sh', HooksConfigSource.User, 'Bash'),
        ],
      },
    ]);

    const out =
      render(<HookDetailStep hook={hook} selectedIndex={0} />).lastFrame() ??
      '';
    expect(out).toContain('1 hook');
    expect(out).toContain('2 hooks');
  });

  it('does not render specific command text on the matcher list page', () => {
    const hook = makeHookInfo([
      {
        matcher: 'Bash',
        configs: [
          makeConfig(
            '/very-specific-command.sh',
            HooksConfigSource.User,
            'Bash',
          ),
        ],
      },
    ]);

    const out =
      render(<HookDetailStep hook={hook} selectedIndex={0} />).lastFrame() ??
      '';
    expect(out).not.toContain('/very-specific-command.sh');
  });

  it('places the selection arrow on the selected matcher row', () => {
    const hook = makeHookInfo([
      {
        matcher: '*',
        configs: [makeConfig('/a.sh', HooksConfigSource.User, '*')],
      },
      {
        matcher: 'Bash',
        configs: [makeConfig('/b.sh', HooksConfigSource.User, 'Bash')],
      },
    ]);

    const out =
      render(<HookDetailStep hook={hook} selectedIndex={1} />).lastFrame() ??
      '';
    const arrowLine = out.split('\n').find((line) => line.includes('❯'));
    expect(arrowLine).toBeDefined();
    expect(arrowLine).toContain('Bash');
  });

  it('renders the Enter/Esc footer hint', () => {
    const hook = makeHookInfo([
      { matcher: '*', configs: [makeConfig('/x.sh')] },
    ]);

    const out =
      render(<HookDetailStep hook={hook} selectedIndex={0} />).lastFrame() ??
      '';
    expect(out).toContain('Enter to select');
    expect(out).toContain('Esc to go back');
  });

  describe('non-matcher events (e.g. Stop)', () => {
    it('does not append " - Matchers" to the title', () => {
      const hook = makeHookInfo([], {
        event: HookEventName.Stop,
        flatConfigs: [makeConfig('/stop.sh', HooksConfigSource.User, '*')],
      });

      const out =
        render(<HookDetailStep hook={hook} selectedIndex={0} />).lastFrame() ??
        '';
      expect(out).toContain(HookEventName.Stop);
      expect(out).not.toContain('- Matchers');
    });

    it('renders the handler list directly (with command and source)', () => {
      const hook = makeHookInfo([], {
        event: HookEventName.Stop,
        flatConfigs: [
          makeConfig('/stop-one.sh', HooksConfigSource.User, '*'),
          makeConfig('/stop-two.sh', HooksConfigSource.Project, '*'),
        ],
      });

      const out =
        render(<HookDetailStep hook={hook} selectedIndex={0} />).lastFrame() ??
        '';
      expect(out).toContain('[command]');
      expect(out).toContain('/stop-one.sh');
      expect(out).toContain('/stop-two.sh');
      expect(out).toContain('User Settings');
      expect(out).toContain('Local Settings');
      expect(out).toContain('Enter to select');
    });

    it('shows empty state when a non-matcher event has no handlers', () => {
      const hook = makeHookInfo([], {
        event: HookEventName.Stop,
        flatConfigs: [],
      });

      const out =
        render(<HookDetailStep hook={hook} selectedIndex={0} />).lastFrame() ??
        '';
      expect(out).toContain('No hooks configured for this event');
    });
  });
});
