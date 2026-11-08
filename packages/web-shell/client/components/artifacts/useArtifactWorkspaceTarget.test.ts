import { describe, expect, it } from 'vitest';
import type {
  DaemonCapabilities,
  DaemonWorkspaceCapability,
} from '@qwen-code/sdk/daemon';
import { resolveArtifactWorkspaceOwner } from './useArtifactWorkspaceTarget';

function capabilities(
  workspaces?: DaemonWorkspaceCapability[],
): DaemonCapabilities {
  return {
    v: 1,
    mode: 'http-bridge',
    features: [],
    modelServices: [],
    workspaceCwd: '/primary',
    ...(workspaces ? { workspaces } : {}),
  };
}

const primary: DaemonWorkspaceCapability = {
  id: 'primary-id',
  cwd: '/primary',
  primary: true,
  trusted: true,
};
const secondary: DaemonWorkspaceCapability = {
  id: 'secondary-id',
  cwd: '/secondary',
  primary: false,
  trusted: true,
};

describe('resolveArtifactWorkspaceOwner', () => {
  it('resolves one exact trusted workspace owner', () => {
    expect(
      resolveArtifactWorkspaceOwner(
        capabilities([primary, secondary]),
        '/secondary',
      ),
    ).toMatchObject({
      cwd: '/secondary',
      id: 'secondary-id',
      primary: false,
    });
  });

  it('supports only an exact primary match for legacy capabilities', () => {
    expect(
      resolveArtifactWorkspaceOwner(capabilities(), '/primary'),
    ).toMatchObject({ cwd: '/primary', primary: true });
    expect(
      resolveArtifactWorkspaceOwner(capabilities(), '/secondary'),
    ).toBeUndefined();
  });

  it.each([
    {
      name: 'unknown cwd',
      caps: capabilities([primary, secondary]),
      cwd: '/unknown',
    },
    {
      name: 'explicit empty workspace list',
      caps: capabilities([]),
      cwd: '/primary',
    },
    {
      name: 'untrusted owner',
      caps: capabilities([primary, { ...secondary, trusted: false }]),
      cwd: '/secondary',
    },
    {
      name: 'empty owner id',
      caps: capabilities([primary, { ...secondary, id: '' }]),
      cwd: '/secondary',
    },
    {
      name: 'duplicate cwd',
      caps: capabilities([
        primary,
        secondary,
        { ...secondary, id: 'other-id' },
      ]),
      cwd: '/secondary',
    },
    {
      name: 'duplicate id',
      caps: capabilities([primary, secondary, { ...secondary, cwd: '/other' }]),
      cwd: '/secondary',
    },
    {
      name: 'inconsistent primary marker',
      caps: capabilities([primary, { ...secondary, primary: true }]),
      cwd: '/secondary',
    },
  ])('fails closed for $name', ({ caps, cwd }) => {
    expect(resolveArtifactWorkspaceOwner(caps, cwd)).toBeUndefined();
  });
});
