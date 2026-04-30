/**
 * Minimal window-manager interface consumed by server-core handlers.
 *
 * Concrete implementations (e.g. Electron's WindowManager) satisfy this
 * interface structurally — no explicit `implements` clause is required,
 * though adding one is recommended for safety.
 */
export interface IWindowManager {
  /** Map a webContentsId to its owning workspace. */
  getWorkspaceForWindow(webContentsId: number): string | null

  /** Move a window to a different workspace. Returns false if the window is not tracked. */
  updateWindowWorkspace(webContentsId: number, workspaceId: string): boolean

  /** Look up a window by its webContentsId. */
  getWindowByWebContentsId(webContentsId: number): unknown | null

  /** Register (or re-register) a window for a given workspace. */
  registerWindow(window: unknown, workspaceId: string): void

  /** Get all tracked windows for a workspace. */
  getAllWindowsForWorkspace(workspaceId: string): unknown[]
}
