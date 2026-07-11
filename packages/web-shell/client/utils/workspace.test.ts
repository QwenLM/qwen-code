/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type {
  DaemonCapabilities,
  DaemonSessionSummary,
  DaemonWorkspaceCapability,
} from '@qwen-code/sdk/daemon';
import {
  hasMultipleWorkspaces,
  isNonPrimaryWorkspaceSession,
  mergeSessionsById,
  workspaceBasename,
} from './workspace';

function caps(workspaces?: DaemonWorkspaceCapability[]): DaemonCapabilities {
  return {
    v: 1,
    mode: 'workspace',
    features: [],
    modelServices: [],
    ...(workspaces ? { workspaces } : {}),
  } as unknown as DaemonCapabilities;
}

function ws(cwd: string): DaemonWorkspaceCapability {
  return { id: cwd, cwd, primary: false, trusted: true };
}

function session(id: string, cwd: string): DaemonSessionSummary {
  return { sessionId: id, workspaceCwd: cwd };
}

describe('workspaceBasename', () => {
  it('returns the last path segment', () => {
    expect(workspaceBasename('/home/me/projects/api')).toBe('api');
    expect(workspaceBasename('/home/me/projects/api/')).toBe('api');
    expect(workspaceBasename('C:\\Users\\me\\web')).toBe('web');
  });

  it('falls back to the whole string when there are no segments', () => {
    expect(workspaceBasename('/')).toBe('/');
    expect(workspaceBasename('')).toBe('');
  });
});

describe('hasMultipleWorkspaces', () => {
  it('is false without a workspaces list or with a single entry', () => {
    expect(hasMultipleWorkspaces(undefined)).toBe(false);
    expect(hasMultipleWorkspaces(caps())).toBe(false);
    expect(hasMultipleWorkspaces(caps([ws('/w')]))).toBe(false);
  });

  it('is true with more than one workspace', () => {
    expect(hasMultipleWorkspaces(caps([ws('/w'), ws('/b')]))).toBe(true);
  });
});

describe('isNonPrimaryWorkspaceSession', () => {
  it('is true only when both cwds are known and differ', () => {
    expect(isNonPrimaryWorkspaceSession('/b', '/w')).toBe(true);
    expect(isNonPrimaryWorkspaceSession('/w', '/w')).toBe(false);
    expect(isNonPrimaryWorkspaceSession(undefined, '/w')).toBe(false);
    expect(isNonPrimaryWorkspaceSession('/b', undefined)).toBe(false);
  });
});

describe('mergeSessionsById', () => {
  it('returns the primary list unchanged (same ref) when there are no others', () => {
    const primary = [session('a', '/w')];
    expect(mergeSessionsById(primary, [])).toBe(primary);
  });

  it('appends other-workspace sessions', () => {
    const merged = mergeSessionsById(
      [session('a', '/w')],
      [session('b', '/b')],
    );
    expect(merged.map((s) => s.sessionId)).toEqual(['a', 'b']);
  });

  it('keeps the primary entry on an id collision', () => {
    const merged = mergeSessionsById(
      [session('a', '/w')],
      [session('a', '/b')],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].workspaceCwd).toBe('/w');
  });
});
