import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
import type { RpcServer } from '@craft-agent/server-core/transport';
import type { HandlerDeps } from '../handler-deps';
import { registerWindowDragGuiHandlers } from '../window-drag';

type Handler = (ctx: { webContentsId?: number }, ...args: number[]) => void;

type MockWindow = {
  getPosition: ReturnType<typeof mock>;
  setPosition: ReturnType<typeof mock>;
  isDestroyed: ReturnType<typeof mock>;
  once: ReturnType<typeof mock>;
  emitClosed: () => void;
};

const handlers = new Map<string, Handler>();

function createMockServer(): RpcServer {
  return {
    handle(channel: string, handler: unknown) {
      handlers.set(channel, handler as Handler);
    },
    push() {},
    async invokeClient() {},
  };
}

function createMockWindow(position: [number, number]): MockWindow {
  let closedHandler: (() => void) | undefined;

  return {
    getPosition: mock(() => position),
    setPosition: mock(() => {}),
    isDestroyed: mock(() => false),
    once: mock((eventName: string, handler: () => void) => {
      if (eventName === 'closed') {
        closedHandler = handler;
      }
    }),
    emitClosed: () => {
      closedHandler?.();
    },
  };
}

function createMockDeps(window: MockWindow): HandlerDeps {
  return {
    windowManager: {
      getWindowByWebContentsId: mock(() => window),
    },
  } as unknown as HandlerDeps;
}

describe('window drag handlers', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('clears drag state when the source window is closed', () => {
    const sourceWindow = createMockWindow([10, 20]);
    const replacementWindow = createMockWindow([100, 200]);
    const deps = createMockDeps(sourceWindow);

    registerWindowDragGuiHandlers(createMockServer(), deps);

    handlers.get(RPC_CHANNELS.window.BEGIN_DRAG)?.(
      { webContentsId: 1 },
      50,
      60,
    );
    sourceWindow.emitClosed();
    (
      deps.windowManager?.getWindowByWebContentsId as ReturnType<typeof mock>
    ).mockImplementation(() => replacementWindow);

    handlers.get(RPC_CHANNELS.window.MOVE_DRAG)?.(
      { webContentsId: 1 },
      55,
      65,
    );

    expect(replacementWindow.setPosition).not.toHaveBeenCalled();
  });
});
