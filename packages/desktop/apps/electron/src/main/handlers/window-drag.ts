import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
import type { RpcServer } from '@craft-agent/server-core/transport';
import type { HandlerDeps } from './handler-deps';

type WindowDragState = {
  startScreenX: number;
  startScreenY: number;
  startWindowX: number;
  startWindowY: number;
};

export const GUI_HANDLED_CHANNELS = [
  RPC_CHANNELS.window.BEGIN_DRAG,
  RPC_CHANNELS.window.MOVE_DRAG,
  RPC_CHANNELS.window.END_DRAG,
] as const;

const dragStates = new Map<number, WindowDragState>();

function isFinitePoint(screenX: number, screenY: number): boolean {
  return Number.isFinite(screenX) && Number.isFinite(screenY);
}

export function registerWindowDragGuiHandlers(
  server: RpcServer,
  deps: HandlerDeps,
): void {
  server.handle(
    RPC_CHANNELS.window.BEGIN_DRAG,
    (ctx, screenX: number, screenY: number) => {
      const webContentsId = ctx.webContentsId;
      if (webContentsId == null || !isFinitePoint(screenX, screenY)) return;

      const window =
        deps.windowManager?.getWindowByWebContentsId(webContentsId);
      if (!window || window.isDestroyed()) return;

      const [startWindowX, startWindowY] = window.getPosition();
      dragStates.set(webContentsId, {
        startScreenX: screenX,
        startScreenY: screenY,
        startWindowX,
        startWindowY,
      });
    },
  );

  server.handle(
    RPC_CHANNELS.window.MOVE_DRAG,
    (ctx, screenX: number, screenY: number) => {
      const webContentsId = ctx.webContentsId;
      if (webContentsId == null || !isFinitePoint(screenX, screenY)) return;

      const window =
        deps.windowManager?.getWindowByWebContentsId(webContentsId);
      const state = dragStates.get(webContentsId);
      if (!window || !state || window.isDestroyed()) return;

      window.setPosition(
        Math.round(state.startWindowX + screenX - state.startScreenX),
        Math.round(state.startWindowY + screenY - state.startScreenY),
      );
    },
  );

  server.handle(RPC_CHANNELS.window.END_DRAG, (ctx) => {
    if (ctx.webContentsId != null) {
      dragStates.delete(ctx.webContentsId);
    }
  });
}
