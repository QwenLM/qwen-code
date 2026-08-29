/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { DaemonWorkspaceCapability } from '@qwen-code/sdk/daemon';
import {
  getDaemonErrorCode,
  isDaemonErrorExplicitlyNonRetryable,
  resolveActionSessionContext,
  resolveLiveSessionWorkspaceCwd,
  resolveProviderSessionContext,
  restoreSessionContextMatches,
  sessionContextKey,
} from './session-context.js';

describe('session context', () => {
  it('normalizes legacy workspace inputs at the provider boundary', () => {
    expect(
      resolveProviderSessionContext(undefined, '/project', '/primary'),
    ).toEqual({ kind: 'workspace', cwd: '/project' });
    expect(
      resolveProviderSessionContext(undefined, undefined, '/primary'),
    ).toEqual({ kind: 'workspace', cwd: '/primary' });
  });

  it('accepts matching explicit workspace inputs after path normalization', () => {
    expect(
      resolveProviderSessionContext(
        { kind: 'workspace', cwd: 'C:\\repo\\' },
        'C:/repo',
        '/primary',
      ),
    ).toEqual({ kind: 'workspace', cwd: 'C:\\repo\\' });
  });

  it('rejects conflicting or workspace-qualified non-workspace contexts', () => {
    expect(() =>
      resolveProviderSessionContext(
        { kind: 'workspace' } as unknown as Parameters<
          typeof resolveProviderSessionContext
        >[0],
        undefined,
        undefined,
      ),
    ).toThrow('Workspace session context requires a cwd');
    expect(() =>
      resolveProviderSessionContext(
        { kind: 'workspace', cwd: '/one' },
        '/two',
        undefined,
      ),
    ).toThrow('sessionContext.cwd conflicts with workspaceCwd');
    expect(() =>
      resolveProviderSessionContext(
        { kind: 'standalone' },
        '/primary',
        undefined,
      ),
    ).toThrow('standalone session context cannot include workspaceCwd');
    expect(() =>
      resolveProviderSessionContext({ kind: 'live' }, '/primary', undefined),
    ).toThrow('live session context cannot include workspaceCwd');
  });

  it('does not treat an inherited workspace as a conflict for explicit non-workspace contexts', () => {
    expect(
      resolveProviderSessionContext(
        { kind: 'standalone' },
        undefined,
        '/primary',
      ),
    ).toEqual({ kind: 'standalone' });
  });

  it('uses the active context only when an action supplies no override', () => {
    expect(
      resolveActionSessionContext(undefined, undefined, {
        kind: 'standalone',
      }),
    ).toEqual({ kind: 'standalone' });
    expect(
      resolveActionSessionContext(undefined, '/project', {
        kind: 'standalone',
      }),
    ).toEqual({ kind: 'workspace', cwd: '/project' });
  });

  it('resolves one uniquely trusted non-primary Live runtime', () => {
    expect(
      resolveLiveSessionWorkspaceCwd({
        v: 1,
        mode: 'native',
        features: ['multi_workspace_sessions'],
        modelServices: [],
        workspaces: [
          {
            id: 'primary',
            cwd: '/project',
            primary: true,
            trusted: true,
          },
          {
            id: 'live',
            cwd: '/conversations',
            primary: false,
            trusted: true,
            kind: 'live',
          },
        ],
      }),
    ).toBe('/conversations');
  });

  it('fails closed for missing, ambiguous, or untrusted Live runtimes', () => {
    expect(() =>
      resolveLiveSessionWorkspaceCwd({
        v: 1,
        mode: 'native',
        features: [],
        modelServices: [],
        workspaces: [
          {
            id: 'live',
            cwd: '/conversations',
            primary: false,
            trusted: true,
            kind: 'live',
          },
        ],
      }),
    ).toThrow('does not advertise multi-workspace session routing');
    expect(() =>
      resolveLiveSessionWorkspaceCwd({
        v: 1,
        mode: 'native',
        features: ['multi_workspace_sessions'],
        modelServices: [],
        workspaces: [],
      }),
    ).toThrow('does not advertise a Live session runtime');
    expect(() =>
      resolveLiveSessionWorkspaceCwd({
        v: 1,
        mode: 'native',
        features: ['multi_workspace_sessions'],
        modelServices: [],
        workspaces: [
          {
            id: 'live-1',
            cwd: '/one',
            primary: false,
            trusted: true,
            kind: 'live',
          },
          {
            id: 'live-2',
            cwd: '/two',
            primary: false,
            trusted: true,
            kind: 'live',
          },
        ],
      }),
    ).toThrow('multiple Live session runtimes');
    expect(() =>
      resolveLiveSessionWorkspaceCwd({
        v: 1,
        mode: 'native',
        features: ['multi_workspace_sessions'],
        modelServices: [],
        workspaces: [
          {
            id: 'live',
            cwd: '/conversations',
            primary: false,
            trusted: false,
            kind: 'live',
          },
        ],
      }),
    ).toThrow('not uniquely trusted');
    expect(() =>
      resolveLiveSessionWorkspaceCwd({
        v: 1,
        mode: 'native',
        features: ['multi_workspace_sessions'],
        modelServices: [],
        workspaces: [
          {
            id: 7,
            cwd: '/conversations',
            primary: false,
            trusted: true,
            kind: 'live',
          } as unknown as DaemonWorkspaceCapability,
        ],
      }),
    ).toThrow('not uniquely trusted');
    expect(() =>
      resolveLiveSessionWorkspaceCwd({
        v: 1,
        mode: 'native',
        features: ['multi_workspace_sessions'],
        modelServices: [],
        workspaces: [
          {
            id: 'live',
            cwd: '/conversations',
            trusted: true,
            kind: 'live',
          } as unknown as DaemonWorkspaceCapability,
        ],
      }),
    ).toThrow('not uniquely trusted');
    expect(() =>
      resolveLiveSessionWorkspaceCwd({
        v: 1,
        mode: 'native',
        features: ['multi_workspace_sessions'],
        modelServices: [],
        workspaces: [
          {
            id: 'live',
            cwd: 'C:\\conversations',
            primary: false,
            trusted: true,
            kind: 'live',
          },
          {
            id: 'other',
            cwd: 'C:/conversations/',
            primary: false,
            trusted: true,
          },
        ],
      }),
    ).toThrow('not uniquely trusted');
    expect(() =>
      resolveLiveSessionWorkspaceCwd({
        v: 1,
        mode: 'native',
        features: ['multi_workspace_sessions'],
        modelServices: [],
        workspaces: [
          {
            id: 'live',
            cwd: '/conversations',
            primary: false,
            trusted: true,
            kind: 'live',
          },
          {
            id: 'live',
            cwd: '/other',
            primary: false,
            trusted: true,
          },
        ],
      }),
    ).toThrow('not uniquely trusted');
    expect(() =>
      resolveLiveSessionWorkspaceCwd({
        v: 1,
        mode: 'native',
        features: ['multi_workspace_sessions'],
        modelServices: [],
        workspaces: [
          {
            id: '',
            cwd: '/conversations',
            primary: false,
            trusted: true,
            kind: 'live',
          },
        ],
      }),
    ).toThrow('not uniquely trusted');
    expect(() =>
      resolveLiveSessionWorkspaceCwd({
        v: 1,
        mode: 'native',
        features: ['multi_workspace_sessions'],
        modelServices: [],
        workspaces: [
          {
            id: 'live',
            cwd: '',
            primary: false,
            trusted: true,
            kind: 'live',
          },
        ],
      }),
    ).toThrow('not uniquely trusted');
    expect(() =>
      resolveLiveSessionWorkspaceCwd({
        v: 1,
        mode: 'native',
        features: ['multi_workspace_sessions'],
        modelServices: [],
        workspaces: [
          {
            id: 'live',
            primary: false,
            trusted: true,
            kind: 'live',
          } as unknown as DaemonWorkspaceCapability,
        ],
      }),
    ).toThrow('not uniquely trusted');
    expect(() =>
      resolveLiveSessionWorkspaceCwd({
        v: 1,
        mode: 'native',
        modelServices: [],
        workspaces: [],
      } as unknown as Parameters<typeof resolveLiveSessionWorkspaceCwd>[0]),
    ).toThrow('does not advertise multi-workspace session routing');
    expect(() =>
      resolveLiveSessionWorkspaceCwd({
        v: 1,
        mode: 'native',
        features: ['multi_workspace_sessions'],
        modelServices: [],
        workspaces: { live: '/conversations' },
      } as unknown as Parameters<typeof resolveLiveSessionWorkspaceCwd>[0]),
    ).toThrow('does not advertise a Live session runtime');
    expect(
      resolveLiveSessionWorkspaceCwd({
        v: 1,
        mode: 'native',
        features: ['multi_workspace_sessions'],
        modelServices: [],
        workspaces: [
          {
            id: 'live',
            cwd: '/conversations',
            primary: false,
            trusted: true,
            kind: 'live',
          },
          {
            id: 'other',
            cwd: 7,
            primary: false,
            trusted: true,
          } as unknown as DaemonWorkspaceCapability,
        ],
      }),
    ).toBe('/conversations');
  });

  it('builds stable keys and reads structured daemon error codes', () => {
    expect(sessionContextKey({ kind: 'workspace', cwd: 'C:\\repo\\' })).toBe(
      'workspace:C:/repo',
    );
    expect(sessionContextKey({ kind: 'standalone' })).toBe('standalone');
    expect(
      restoreSessionContextMatches(undefined, {
        kind: 'workspace',
        cwd: '/primary',
      }),
    ).toBe(true);
    expect(restoreSessionContextMatches(undefined, { kind: 'live' })).toBe(
      false,
    );
    expect(
      restoreSessionContextMatches(
        { kind: 'workspace', cwd: '/same' },
        { kind: 'workspace', cwd: '/same' },
      ),
    ).toBe(true);
    expect(
      restoreSessionContextMatches(
        { kind: 'workspace', cwd: '/one' },
        { kind: 'workspace', cwd: '/two' },
      ),
    ).toBe(false);
    expect(
      restoreSessionContextMatches(
        { kind: 'standalone' },
        { kind: 'standalone' },
      ),
    ).toBe(true);
    expect(
      restoreSessionContextMatches({ kind: 'live' }, { kind: 'live' }),
    ).toBe(true);
    expect(
      restoreSessionContextMatches({ kind: 'standalone' }, undefined),
    ).toBe(false);
    expect(
      getDaemonErrorCode({ body: { code: 'working_directory_missing' } }),
    ).toBe('working_directory_missing');
    expect(getDaemonErrorCode(new Error('no body'))).toBeUndefined();
    expect(
      isDaemonErrorExplicitlyNonRetryable({
        body: { code: 'working_directory_compromised', retryable: false },
      }),
    ).toBe(true);
    expect(
      isDaemonErrorExplicitlyNonRetryable({
        body: { code: 'working_directory_missing', retryable: true },
      }),
    ).toBe(false);
  });
});
