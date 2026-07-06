import type { HandlerDeps } from './handler-deps';
import type { RpcServer } from '@craft-agent/server-core/transport';
import {
  registerCoreRpcHandlers,
  type ServerHandlerContext,
} from '@craft-agent/server-core/handlers/rpc';
export { registerCoreRpcHandlers };

// GUI-only handlers remain local (Electron-specific imports)
import { registerSystemGuiHandlers } from './system';
import { registerWorkspaceGuiHandlers } from './workspace';
import { registerBrowserHandlers } from './browser';
import { registerSettingsGuiHandlers } from './settings';
import { registerWindowDragGuiHandlers } from './window-drag';
import { registerPetWindowGuiHandlers } from './pet-window';

export function registerGuiRpcHandlers(
  server: RpcServer,
  deps: HandlerDeps,
): void {
  registerSystemGuiHandlers(server, deps);
  registerWorkspaceGuiHandlers(server, deps);
  registerBrowserHandlers(server, deps);
  registerSettingsGuiHandlers(server, deps);
  registerWindowDragGuiHandlers(server, deps);
  registerPetWindowGuiHandlers(server, deps);
}

export function registerAllRpcHandlers(
  server: RpcServer,
  deps: HandlerDeps,
  serverCtx?: ServerHandlerContext,
): void {
  registerCoreRpcHandlers(server, deps, serverCtx);
  registerGuiRpcHandlers(server, deps);
}
