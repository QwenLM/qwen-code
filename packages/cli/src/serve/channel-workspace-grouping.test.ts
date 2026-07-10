/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveChannelOwnerCwd,
  resolveChannelWorkspaceGroups,
  type ChannelWorkspaceInput,
} from './channel-workspace-grouping.js';

const PRIMARY = path.resolve('/ws/primary');
const SECONDARY = path.resolve('/ws/secondary');
const UNREGISTERED = path.resolve('/ws/other');

function workspaces(
  overrides: Partial<Record<'primary' | 'secondary', boolean>> = {},
): ChannelWorkspaceInput[] {
  return [
    {
      workspaceCwd: PRIMARY,
      primary: true,
      trusted: overrides.primary ?? true,
    },
    {
      workspaceCwd: SECONDARY,
      primary: false,
      trusted: overrides.secondary ?? true,
    },
  ];
}

function loader(byWorkspace: Record<string, Record<string, unknown>>) {
  return (cwd: string): Record<string, unknown> => byWorkspace[cwd] ?? {};
}

describe('resolveChannelOwnerCwd', () => {
  it('defaults an unset cwd to the loading workspace', () => {
    expect(resolveChannelOwnerCwd(undefined, PRIMARY)).toBe(PRIMARY);
  });

  it('canonicalizes an explicit cwd independently of the workspace', () => {
    expect(resolveChannelOwnerCwd(SECONDARY, PRIMARY)).toBe(SECONDARY);
  });

  it('resolves a relative cwd against the loading workspace', () => {
    expect(resolveChannelOwnerCwd('../secondary', PRIMARY)).toBe(SECONDARY);
  });
});

describe('resolveChannelWorkspaceGroups', () => {
  it('rejects a registry with no primary workspace', () => {
    const result = resolveChannelWorkspaceGroups({
      workspaces: [{ workspaceCwd: SECONDARY, primary: false, trusted: true }],
      selection: { mode: 'all' },
      loadChannelsConfig: loader({}),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('no_primary_workspace');
    }
  });

  it('assigns an explicit-cwd channel to the workspace it targets', () => {
    // Same user-scope entry is visible in every workspace's merged config, but
    // its explicit cwd pins ownership to SECONDARY.
    const entry = { telegram: { type: 'telegram', cwd: SECONDARY } };
    const result = resolveChannelWorkspaceGroups({
      workspaces: workspaces(),
      selection: { mode: 'names', names: ['telegram'] },
      loadChannelsConfig: loader({ [PRIMARY]: entry, [SECONDARY]: entry }),
    });
    expect(result).toEqual({
      ok: true,
      groups: [
        {
          workspaceCwd: SECONDARY,
          selection: { mode: 'names', names: ['telegram'] },
        },
      ],
    });
  });

  it('assigns a workspace-scoped cwdless channel to that workspace', () => {
    const result = resolveChannelWorkspaceGroups({
      workspaces: workspaces(),
      selection: { mode: 'names', names: ['telegram'] },
      loadChannelsConfig: loader({
        [SECONDARY]: { telegram: { type: 'telegram' } },
      }),
    });
    expect(result).toEqual({
      ok: true,
      groups: [
        {
          workspaceCwd: SECONDARY,
          selection: { mode: 'names', names: ['telegram'] },
        },
      ],
    });
  });

  it('groups distinct channels by their owning workspace', () => {
    const result = resolveChannelWorkspaceGroups({
      workspaces: workspaces(),
      selection: { mode: 'names', names: ['telegram', 'feishu'] },
      loadChannelsConfig: loader({
        [PRIMARY]: { feishu: { type: 'feishu' } },
        [SECONDARY]: { telegram: { type: 'telegram' } },
      }),
    });
    expect(result).toEqual({
      ok: true,
      groups: [
        {
          workspaceCwd: SECONDARY,
          selection: { mode: 'names', names: ['telegram'] },
        },
        {
          workspaceCwd: PRIMARY,
          selection: { mode: 'names', names: ['feishu'] },
        },
      ],
    });
  });

  it('rejects a cwdless channel defined in user/system scope as ambiguous', () => {
    const entry = { telegram: { type: 'telegram' } };
    const result = resolveChannelWorkspaceGroups({
      workspaces: workspaces(),
      selection: { mode: 'names', names: ['telegram'] },
      loadChannelsConfig: loader({ [PRIMARY]: entry, [SECONDARY]: entry }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('ambiguous_channel_workspace');
      expect(result.error.channel).toBe('telegram');
    }
  });

  it('rejects a channel whose cwd is not a registered workspace', () => {
    const result = resolveChannelWorkspaceGroups({
      workspaces: workspaces(),
      selection: { mode: 'names', names: ['telegram'] },
      loadChannelsConfig: loader({
        [PRIMARY]: { telegram: { type: 'telegram', cwd: UNREGISTERED } },
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('channel_workspace_mismatch');
    }
  });

  it('treats a cwd canonicalization failure as a workspace mismatch', () => {
    const result = resolveChannelWorkspaceGroups({
      workspaces: workspaces(),
      selection: { mode: 'names', names: ['telegram'] },
      loadChannelsConfig: loader({
        [PRIMARY]: { telegram: { type: 'telegram', cwd: '\0' } },
      }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: 'channel_workspace_mismatch',
        channel: 'telegram',
      });
    }
  });

  it('rejects a channel unknown to every registered workspace', () => {
    const result = resolveChannelWorkspaceGroups({
      workspaces: workspaces(),
      selection: { mode: 'names', names: ['telegram'] },
      loadChannelsConfig: loader({}),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('channel_workspace_mismatch');
    }
  });

  it('rejects a channel owned by an untrusted workspace', () => {
    const result = resolveChannelWorkspaceGroups({
      workspaces: workspaces({ secondary: false }),
      selection: { mode: 'names', names: ['telegram'] },
      loadChannelsConfig: loader({
        [SECONDARY]: { telegram: { type: 'telegram' } },
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('untrusted_workspace');
    }
  });

  it('keeps --channel all primary-only', () => {
    const result = resolveChannelWorkspaceGroups({
      workspaces: workspaces(),
      selection: { mode: 'all' },
      loadChannelsConfig: loader({
        [PRIMARY]: { feishu: { type: 'feishu' } },
        [SECONDARY]: { telegram: { type: 'telegram' } },
      }),
    });
    expect(result).toEqual({
      ok: true,
      groups: [{ workspaceCwd: PRIMARY, selection: { mode: 'all' } }],
    });
  });

  it('rejects --channel all when the primary workspace is untrusted', () => {
    const result = resolveChannelWorkspaceGroups({
      workspaces: workspaces({ primary: false }),
      selection: { mode: 'all' },
      loadChannelsConfig: loader({}),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('untrusted_workspace');
    }
  });

  it('produces a single primary group in single-workspace mode', () => {
    const result = resolveChannelWorkspaceGroups({
      workspaces: [{ workspaceCwd: PRIMARY, primary: true, trusted: true }],
      selection: { mode: 'names', names: ['telegram'] },
      loadChannelsConfig: loader({
        [PRIMARY]: { telegram: { type: 'telegram' } },
      }),
    });
    expect(result).toEqual({
      ok: true,
      groups: [
        {
          workspaceCwd: PRIMARY,
          selection: { mode: 'names', names: ['telegram'] },
        },
      ],
    });
  });
});
