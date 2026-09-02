import { describe, expect, it, vi } from 'vitest';
import {
  DaemonHttpError,
  STANDALONE_SESSIONS_CAPABILITY,
  type DaemonClient,
  type DaemonCapabilities,
} from '@qwen-code/sdk/daemon';

import { keepWorkspaceSplitSessionIds } from './standalone-session-routing';

const capable = {
  features: [STANDALONE_SESSIONS_CAPABILITY],
} as DaemonCapabilities;

describe('keepWorkspaceSplitSessionIds', () => {
  it('fails closed while capabilities are unresolved', async () => {
    const getStandaloneSession = vi.fn();

    await expect(
      keepWorkspaceSplitSessionIds(
        { getStandaloneSession } as unknown as DaemonClient,
        undefined,
        ['workspace-session'],
      ),
    ).resolves.toEqual([]);
    expect(getStandaloneSession).not.toHaveBeenCalled();
  });

  it('preserves legacy workspace ids when standalone is unsupported', async () => {
    const getStandaloneSession = vi.fn();

    await expect(
      keepWorkspaceSplitSessionIds(
        { getStandaloneSession } as unknown as DaemonClient,
        { features: [] } as unknown as DaemonCapabilities,
        ['one', 'one', 'two'],
      ),
    ).resolves.toEqual(['one', 'two']);
    expect(getStandaloneSession).not.toHaveBeenCalled();
  });

  it('keeps only ids proven absent from the standalone registry', async () => {
    const getStandaloneSession = vi.fn(async (sessionId: string) => {
      if (sessionId === 'standalone') {
        return { state: 'creating', sessionId };
      }
      if (sessionId === 'workspace') {
        throw new DaemonHttpError(
          404,
          { code: 'standalone_session_not_found' },
          'not found',
        );
      }
      throw new DaemonHttpError(500, { code: 'internal_error' }, 'unavailable');
    });

    await expect(
      keepWorkspaceSplitSessionIds(
        { getStandaloneSession } as unknown as DaemonClient,
        capable,
        ['standalone', 'workspace', 'unknown'],
      ),
    ).resolves.toEqual(['workspace']);
  });
});
