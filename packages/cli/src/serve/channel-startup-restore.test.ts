/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  resolveStartupChannelSelection,
  type StartupChannelWorkspace,
} from './channel-startup-restore.js';

const PRIMARY = '/ws/primary';
const SECOND = '/ws/second';
const THIRD = '/ws/third';

const workspaces: StartupChannelWorkspace[] = [
  { workspaceCwd: PRIMARY, primary: true },
  { workspaceCwd: SECOND, primary: false },
  { workspaceCwd: THIRD, primary: false },
];

function loader(byWorkspace: Record<string, unknown>) {
  return (cwd: string): unknown => {
    const value = byWorkspace[cwd];
    if (value instanceof Error) throw value;
    return value;
  };
}

describe('resolveStartupChannelSelection', () => {
  it('restores the primary workspace alone exactly as before', () => {
    const result = resolveStartupChannelSelection({
      workspaces,
      loadStartupChannels: loader({ [PRIMARY]: ['feishu', 'telegram'] }),
    });
    expect(result.selection).toEqual({
      mode: 'names',
      names: ['feishu', 'telegram'],
    });
    expect([...result.ownerHints]).toEqual([]);
    expect([...result.tolerantNames]).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('unions every workspace, primary first, and attributes the rest', () => {
    const result = resolveStartupChannelSelection({
      workspaces,
      loadStartupChannels: loader({
        [PRIMARY]: ['feishu'],
        [SECOND]: ['telegram'],
        [THIRD]: ['dingtalk'],
      }),
    });
    expect(result.selection).toEqual({
      mode: 'names',
      names: ['feishu', 'telegram', 'dingtalk'],
    });
    expect([...result.ownerHints]).toEqual([
      ['telegram', SECOND],
      ['dingtalk', THIRD],
    ]);
    expect([...result.tolerantNames]).toEqual(['telegram', 'dingtalk']);
    expect(result.diagnostics).toEqual([]);
  });

  it('keeps a primary "all" and reports the workspaces it shadows', () => {
    const result = resolveStartupChannelSelection({
      workspaces,
      loadStartupChannels: loader({
        [PRIMARY]: ['all'],
        [SECOND]: ['telegram'],
      }),
    });
    expect(result.selection).toEqual({ mode: 'all' });
    expect([...result.ownerHints]).toEqual([]);
    expect(result.diagnostics).toEqual([
      {
        code: 'all_is_primary_only',
        workspaceCwd: PRIMARY,
        message: expect.stringContaining('telegram'),
      },
    ]);
  });

  it('ignores "all" outside the primary workspace', () => {
    const result = resolveStartupChannelSelection({
      workspaces,
      loadStartupChannels: loader({
        [PRIMARY]: ['feishu'],
        [SECOND]: ['all'],
      }),
    });
    expect(result.selection).toEqual({ mode: 'names', names: ['feishu'] });
    expect(result.diagnostics).toEqual([
      {
        code: 'all_is_primary_only',
        workspaceCwd: SECOND,
        message: expect.stringContaining(SECOND),
      },
    ]);
  });

  it('drops only the workspace whose settings cannot be read', () => {
    const result = resolveStartupChannelSelection({
      workspaces,
      loadStartupChannels: loader({
        [PRIMARY]: ['feishu'],
        [SECOND]: new Error('EACCES: permission denied'),
        [THIRD]: ['dingtalk'],
      }),
    });
    expect(result.selection).toEqual({
      mode: 'names',
      names: ['feishu', 'dingtalk'],
    });
    expect(result.diagnostics).toEqual([
      {
        code: 'settings_unreadable',
        workspaceCwd: SECOND,
        message: 'EACCES: permission denied',
      },
    ]);
  });

  it('drops a workspace whose serve.channels is not a string array', () => {
    const result = resolveStartupChannelSelection({
      workspaces,
      loadStartupChannels: loader({
        [PRIMARY]: ['feishu'],
        [SECOND]: { telegram: true },
      }),
    });
    expect(result.selection).toEqual({ mode: 'names', names: ['feishu'] });
    expect(result.diagnostics).toEqual([
      {
        code: 'invalid_setting',
        workspaceCwd: SECOND,
        message: 'serve.channels must be a string array.',
      },
    ]);
  });

  it('drops a workspace that combines "all" with channel names', () => {
    const result = resolveStartupChannelSelection({
      workspaces,
      loadStartupChannels: loader({
        [PRIMARY]: ['feishu'],
        [SECOND]: ['all', 'telegram'],
      }),
    });
    expect(result.selection).toEqual({ mode: 'names', names: ['feishu'] });
    expect(result.diagnostics).toEqual([
      {
        code: 'invalid_setting',
        workspaceCwd: SECOND,
        message: expect.stringContaining('cannot be combined'),
      },
    ]);
  });

  it('reports and skips unusable entries without losing the rest', () => {
    const result = resolveStartupChannelSelection({
      workspaces,
      loadStartupChannels: loader({
        [SECOND]: [' padded', 'telegram', ''],
      }),
    });
    expect(result.selection).toEqual({ mode: 'names', names: ['telegram'] });
    expect(result.diagnostics.map((item) => item.message)).toEqual([
      'ignored invalid workspace serve.channels entry at index 0',
      'ignored invalid workspace serve.channels entry at index 2',
    ]);
  });

  it('does not hint a name several workspaces claim', () => {
    const result = resolveStartupChannelSelection({
      workspaces,
      loadStartupChannels: loader({
        [SECOND]: ['telegram'],
        [THIRD]: ['telegram'],
      }),
    });
    expect(result.selection).toEqual({ mode: 'names', names: ['telegram'] });
    expect([...result.ownerHints]).toEqual([]);
    expect([...result.tolerantNames]).toEqual(['telegram']);
    expect(result.diagnostics).toEqual([
      {
        code: 'claimed_by_multiple_workspaces',
        workspaceCwd: SECOND,
        channel: 'telegram',
        message: expect.stringContaining(THIRD),
      },
    ]);
  });

  it('treats a name the primary also claims as droppable but unhinted', () => {
    const result = resolveStartupChannelSelection({
      workspaces,
      loadStartupChannels: loader({
        [PRIMARY]: ['telegram'],
        [SECOND]: ['telegram'],
      }),
    });
    expect(result.selection).toEqual({ mode: 'names', names: ['telegram'] });
    expect([...result.ownerHints]).toEqual([]);
    expect([...result.tolerantNames]).toEqual(['telegram']);
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      'claimed_by_multiple_workspaces',
    ]);
  });

  it('deduplicates repeated names within one workspace', () => {
    const result = resolveStartupChannelSelection({
      workspaces,
      loadStartupChannels: loader({ [SECOND]: ['telegram', 'telegram'] }),
    });
    expect(result.selection).toEqual({ mode: 'names', names: ['telegram'] });
    expect(result.diagnostics).toEqual([]);
  });

  it('selects nothing when no workspace configures startup channels', () => {
    const result = resolveStartupChannelSelection({
      workspaces,
      loadStartupChannels: loader({}),
    });
    expect(result.selection).toBeUndefined();
    expect(result.diagnostics).toEqual([]);
  });
});
