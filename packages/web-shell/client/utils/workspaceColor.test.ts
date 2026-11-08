/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { DaemonCapabilities } from '@qwen-code/sdk/daemon';
import { workspaceAccentColor } from './workspaceColor';

function capabilities(cwds: string[]): DaemonCapabilities {
  return {
    v: 1,
    workspaceCwd: cwds[0],
    workspaces: cwds.map((cwd, index) => ({
      id: `w${index}`,
      cwd,
      primary: index === 0,
      trusted: true,
    })),
  } as DaemonCapabilities;
}

describe('workspaceAccentColor', () => {
  it('keys the color off the workspace position so the primary is always first', () => {
    const caps = capabilities(['/work/api', '/work/web', '/work/infra']);
    expect(workspaceAccentColor('/work/api', caps)).toBe('blue');
    expect(workspaceAccentColor('/work/web', caps)).toBe('green');
    expect(workspaceAccentColor('/work/infra', caps)).toBe('purple');
  });

  it('returns a stable color per cwd and distinct colors for different workspaces', () => {
    const caps = capabilities(['/work/api', '/work/web']);
    expect(workspaceAccentColor('/work/web', caps)).toBe(
      workspaceAccentColor('/work/web', caps),
    );
    expect(workspaceAccentColor('/work/web', caps)).not.toBe(
      workspaceAccentColor('/work/api', caps),
    );
  });

  it('cycles the six-color palette once there are more workspaces', () => {
    const caps = capabilities([
      '/w0',
      '/w1',
      '/w2',
      '/w3',
      '/w4',
      '/w5',
      '/w6',
    ]);
    // The seventh workspace wraps back to the first color.
    expect(workspaceAccentColor('/w6', caps)).toBe(
      workspaceAccentColor('/w0', caps),
    );
  });

  it('falls back to a stable hashed color when the cwd is not advertised', () => {
    const caps = capabilities(['/work/api']);
    const first = workspaceAccentColor('/not/listed/yet', caps);
    expect(first).toBeDefined();
    // Deterministic: the same unlisted cwd always resolves to the same color,
    // so a pane whose runtime resolves after mount doesn't flicker.
    expect(workspaceAccentColor('/not/listed/yet', caps)).toBe(first);
  });

  it('returns undefined for a missing cwd so callers can skip the accent', () => {
    expect(
      workspaceAccentColor(undefined, capabilities(['/w0'])),
    ).toBeUndefined();
    expect(workspaceAccentColor('', capabilities(['/w0']))).toBeUndefined();
  });
});
