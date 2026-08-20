/**
 * Client capabilities — named actions a client can perform on behalf of the server.
 *
 * See docs/adr-transport-locality.md for the locality boundary definition.
 */

import type { RpcServer } from './types'

/** Capability: open a URL in the client's default browser. */
export const CLIENT_OPEN_EXTERNAL = 'client:openExternal'

/** Capability: open a file with the OS default application. */
export const CLIENT_OPEN_PATH = 'client:openPath'

/** Capability: reveal a file in Finder / Explorer. */
export const CLIENT_SHOW_IN_FOLDER = 'client:showItemInFolder'

/** Capability: show a confirmation dialog (message box) on the client. */
export const CLIENT_CONFIRM_DIALOG = 'client:confirmDialog'

/** Capability: show a native file/folder picker on the client. */
export const CLIENT_OPEN_FILE_DIALOG = 'client:openFileDialog'

/** All capabilities a local Electron client advertises on handshake. */
export const LOCAL_CLIENT_CAPABILITIES: readonly string[] = [
  CLIENT_OPEN_EXTERNAL,
  CLIENT_OPEN_PATH,
  CLIENT_SHOW_IN_FOLDER,
  CLIENT_CONFIRM_DIALOG,
  CLIENT_OPEN_FILE_DIALOG,
]

// ---------------------------------------------------------------------------
// Helper wrappers — thin error-handling around server.invokeClient()
// ---------------------------------------------------------------------------

/**
 * Ask a specific client to open a URL in its default browser.
 *
 * Returns `{ opened: true }` on success.
 * Returns `{ opened: false, error, authUrl }` on failure — caller can
 * show authUrl to user for manual "copy link / open" action.
 */
export async function requestClientOpenExternal(
  server: RpcServer,
  clientId: string,
  url: string,
): Promise<{ opened: boolean; error?: string; authUrl?: string }> {
  try {
    await server.invokeClient(clientId, CLIENT_OPEN_EXTERNAL, url)
    return { opened: true }
  } catch (err) {
    const code = (err as any)?.code
    const message = err instanceof Error ? err.message : String(err)
    return { opened: false, error: `${code ?? 'UNKNOWN'}: ${message}`, authUrl: url }
  }
}

/**
 * Ask the client to open a file with the OS default application.
 * Equivalent to Electron's `shell.openPath()`.
 */
export async function requestClientOpenPath(
  server: RpcServer,
  clientId: string,
  path: string,
): Promise<{ error?: string }> {
  try {
    const result = await server.invokeClient(clientId, CLIENT_OPEN_PATH, path)
    return result ?? {}
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { error: message }
  }
}

/**
 * Ask the client to reveal a file in Finder / Explorer.
 * Equivalent to Electron's `shell.showItemInFolder()`.
 */
export async function requestClientShowInFolder(
  server: RpcServer,
  clientId: string,
  path: string,
): Promise<void> {
  await server.invokeClient(clientId, CLIENT_SHOW_IN_FOLDER, path)
}

/** Spec for a confirmation dialog (maps to Electron's MessageBoxOptions). */
export interface ConfirmDialogSpec {
  type?: 'none' | 'info' | 'warning' | 'error' | 'question'
  title: string
  message: string
  detail?: string
  buttons: string[]
  defaultId?: number
  cancelId?: number
}

/**
 * Ask the client to show a confirmation dialog.
 * Returns the index of the clicked button.
 */
export async function requestClientConfirmDialog(
  server: RpcServer,
  clientId: string,
  spec: ConfirmDialogSpec,
): Promise<{ response: number }> {
  return await server.invokeClient(clientId, CLIENT_CONFIRM_DIALOG, spec)
}

/** Spec for a file/folder picker dialog (maps to Electron's OpenDialogOptions). */
export interface FileDialogSpec {
  title?: string
  defaultPath?: string
  properties?: string[]
  filters?: Array<{ name: string; extensions: string[] }>
}

/**
 * Ask the client to show a native file/folder picker.
 * Returns the selection result (canceled + filePaths).
 */
export async function requestClientOpenFileDialog(
  server: RpcServer,
  clientId: string,
  spec: FileDialogSpec,
): Promise<{ canceled: boolean; filePaths: string[] }> {
  return await server.invokeClient(clientId, CLIENT_OPEN_FILE_DIALOG, spec)
}
