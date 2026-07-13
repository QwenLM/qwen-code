import type { DaemonClient } from '@qwen-code/sdk/daemon';
import { describe, expect, it, vi } from 'vitest';
import { createDaemonWorkspaceActions } from './actions';

describe('createDaemonWorkspaceActions extension interactions', () => {
  it('forwards an extension interaction response to the daemon client', async () => {
    const respondToExtensionInteraction = vi
      .fn()
      .mockResolvedValue({ accepted: true });
    const actions = createDaemonWorkspaceActions({
      getClient: () =>
        ({ respondToExtensionInteraction }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/workspace',
      baseUrl: 'http://daemon',
    });

    await expect(
      actions.respondToExtensionInteraction(
        'op-1',
        'interaction-1',
        { value: 'answer' },
        'client-1',
      ),
    ).resolves.toEqual({ accepted: true });
    expect(respondToExtensionInteraction).toHaveBeenCalledWith(
      'op-1',
      'interaction-1',
      { value: 'answer' },
      'client-1',
    );
  });

  it('rejects when no daemon client is connected', async () => {
    const actions = createDaemonWorkspaceActions({
      getClient: () => undefined,
      getWorkspaceCwd: () => '/workspace',
      baseUrl: 'http://daemon',
    });

    await expect(
      actions.respondToExtensionInteraction('op-1', 'interaction-1', {
        cancelled: true,
      }),
    ).rejects.toThrow('Respond to extension interaction failed');
  });
});
