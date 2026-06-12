import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
import type { RpcServer } from '@craft-agent/server-core/transport';
import type { HandlerDeps } from './handler-deps';

export const GUI_HANDLED_CHANNELS = [
  RPC_CHANNELS.window.PET_SET_ENABLED,
  RPC_CHANNELS.window.PET_SET_IGNORE_MOUSE,
  RPC_CHANNELS.window.PET_FOCUS_SESSION,
] as const;

/**
 * GUI handlers for the floating desktop-pet window. The renderer that hosts the
 * main UI toggles the window on/off (and reloads it on pet change); the pet
 * window itself toggles click-through as the cursor enters/leaves the pet.
 */
export function registerPetWindowGuiHandlers(
  server: RpcServer,
  deps: HandlerDeps,
): void {
  server.handle(
    RPC_CHANNELS.window.PET_SET_ENABLED,
    (ctx, enabled: boolean) => {
      const wm = deps.windowManager;
      if (!wm) return;
      const workspaceId =
        ctx.webContentsId != null
          ? (wm.getWorkspaceForWindow(ctx.webContentsId) ?? '')
          : '';
      wm.setPetWindowEnabled(Boolean(enabled), workspaceId);
    },
  );

  server.handle(
    RPC_CHANNELS.window.PET_SET_IGNORE_MOUSE,
    (_ctx, ignore: boolean) => {
      deps.windowManager?.setPetWindowIgnoreMouse(Boolean(ignore));
    },
  );

  // Clicking a pet notification card focuses the main window and navigates to
  // the originating session (reuses the OS-notification click path).
  server.handle(
    RPC_CHANNELS.window.PET_FOCUS_SESSION,
    async (ctx, sessionId: string) => {
      const wm = deps.windowManager;
      if (!wm || !sessionId || ctx.webContentsId == null) return;
      const workspaceId = wm.getWorkspaceForWindow(ctx.webContentsId);
      if (!workspaceId) return;
      const { handleNotificationClick } = await import('../notifications');
      handleNotificationClick(workspaceId, sessionId);
    },
  );
}
