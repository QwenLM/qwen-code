// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDaemonTranscriptStore,
  DaemonHttpError,
  type DaemonTranscriptStore,
} from '@qwen-code/sdk/daemon';
import type { Message } from '../adapters/types';
import { McpAppGeneratedUiOwnerContext } from '../mcpAppHostContext';
import { useMessageDeletion } from './useMessageDeletion';

const mocks = vi.hoisted(() => ({
  store: undefined as unknown as DaemonTranscriptStore,
  client: {
    getMessageGroups: vi.fn(),
    deleteMessageGroups: vi.fn(),
  },
  actions: { reloadSession: vi.fn() },
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useConnection: () => ({
    status: 'connected',
    sessionId: 'original-session',
    clientId: 'client-1',
    workspaceCwd: '/workspace',
    capabilities: { features: ['session_message_deletion'] },
  }),
  useActions: () => mocks.actions,
  useTranscriptStore: () => mocks.store,
  useWorkspace: () => ({ client: mocks.client }),
}));
vi.mock('../i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../interactionBlockContext', () => ({
  useInteractionBlocker: () => () => () => undefined,
}));

let root: Root;
let container: HTMLDivElement;
const message: Message = {
  id: 'message-1',
  role: 'user',
  content: 'create a view',
  promptId: 'prompt-1',
};

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mocks.store = createDaemonTranscriptStore();
  mocks.client.getMessageGroups.mockReset().mockResolvedValue({
    snapshot: 'snapshot-1',
    groups: [{ id: 'group-1', promptId: 'prompt-1', recordIds: [] }],
  });
  mocks.client.deleteMessageGroups.mockReset().mockResolvedValue({});
  mocks.actions.reloadSession.mockReset().mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Generated UI message deletion invalidation', () => {
  it.each([
    'success',
    'persisted-context-failure',
    'not-persisted-context-failure',
    'refused',
  ] as const)(
    'uses the real deletion result before invalidating: %s',
    async (outcome) => {
      if (outcome !== 'success') {
        mocks.client.deleteMessageGroups.mockRejectedValue(
          new DaemonHttpError(
            409,
            {
              code: outcome.endsWith('context-failure')
                ? 'message_deletion_context_unavailable'
                : 'session_busy',
              persisted: outcome === 'persisted-context-failure',
            },
            'deletion failed',
          ),
        );
      }
      const invalidate = vi.fn();
      let controls: ReturnType<typeof useMessageDeletion>;
      function Harness() {
        controls = useMessageDeletion([message], false);
        return null;
      }
      act(() =>
        root.render(
          <McpAppGeneratedUiOwnerContext.Provider
            value={{
              scopeId: 'original-scope',
              workspaceCwd: '/workspace',
              subscribeInvalidation: () => () => undefined,
              captureSessionDeletion: () => () => undefined,
              invalidate,
            }}
          >
            <Harness />
          </McpAppGeneratedUiOwnerContext.Provider>,
        ),
      );
      await act(async () => {
        await controls!.start(message);
      });
      expect(invalidate).not.toHaveBeenCalled();
      await act(async () => {
        await controls!.submit();
      });
      expect(mocks.client.deleteMessageGroups).toHaveBeenCalledOnce();
      if (
        outcome === 'refused' ||
        outcome === 'not-persisted-context-failure'
      ) {
        expect(invalidate).not.toHaveBeenCalled();
        expect(mocks.actions.reloadSession).not.toHaveBeenCalled();
      } else {
        expect(invalidate).toHaveBeenCalledWith({
          scopeId: 'original-scope',
          sessionId: 'original-session',
          reason: 'deleted',
        });
        expect(mocks.actions.reloadSession).toHaveBeenCalledOnce();
      }
    },
  );

  it('deletes only local command output without invalidating Generated UI', async () => {
    mocks.client.getMessageGroups.mockResolvedValue({
      snapshot: '',
      groups: [],
    });
    mocks.store = createDaemonTranscriptStore({
      blocks: [
        {
          id: 'local-output',
          kind: 'user',
          text: '/stats',
          promptId: 'local-command:stats',
          meta: { localCommandId: 'local-1' },
          clientReceivedAt: 0,
          createdAt: 0,
          updatedAt: 0,
        },
        {
          id: 'persisted-output',
          kind: 'user',
          text: 'Keep this message',
          promptId: 'persisted-prompt',
          clientReceivedAt: 0,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });
    const localMessage: Message = {
      id: 'local-message',
      role: 'user',
      content: '/stats',
      localCommandId: 'local-1',
      sourceBlockIds: ['local-output'],
    };
    const invalidate = vi.fn();
    let controls: ReturnType<typeof useMessageDeletion>;
    function Harness() {
      controls = useMessageDeletion([localMessage], false);
      return null;
    }
    await act(async () =>
      root.render(
        <McpAppGeneratedUiOwnerContext.Provider
          value={{
            scopeId: 'original-scope',
            workspaceCwd: '/workspace',
            subscribeInvalidation: () => () => undefined,
            captureSessionDeletion: () => () => undefined,
            invalidate,
          }}
        >
          <Harness />
        </McpAppGeneratedUiOwnerContext.Provider>,
      ),
    );
    await act(async () => {
      await controls!.start(localMessage);
    });
    expect(controls!.active).toBe(true);
    expect(controls!.selected.size).toBe(1);
    await act(async () => {
      await controls!.submit();
    });
    expect(mocks.store.getSnapshot().blocks.map((block) => block.id)).toEqual([
      'persisted-output',
    ]);
    expect(controls!.active).toBe(false);
    expect(controls!.error).toBeUndefined();
    expect(mocks.client.deleteMessageGroups).not.toHaveBeenCalled();
    expect(mocks.actions.reloadSession).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });
});
