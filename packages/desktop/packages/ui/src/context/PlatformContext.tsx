/**
 * PlatformContext - Abstraction layer for platform-specific actions
 *
 * This context allows UI components to work in both Electron and web environments.
 * Electron provides actual implementations, web viewer provides no-ops or alternatives.
 *
 * Pattern: Dependency injection via context
 * - Components call usePlatform() to get actions
 * - Actions are optional - components check before calling
 * - Web viewer can provide inline modals instead of new windows
 */

import { createContext, useContext, type ReactNode } from 'react'

/**
 * Platform-specific actions that components may need
 * All actions are optional - platforms only implement what they support
 */
export interface PlatformActions {
  /**
   * Open a file in the default application (Electron: shell.openPath)
   * Web: Could show file contents inline or provide download
   */
  onOpenFile?: (path: string) => void

  /**
   * Open a file directly in the system editor, bypassing the link interceptor.
   * Used by overlay header badges — when already viewing a file, "Open" should
   * launch an external editor, not re-trigger the in-app preview.
   */
  onOpenFileExternal?: (path: string) => void

  /**
   * Open a URL in the default browser (Electron: shell.openExternal)
   * Web: window.open or navigation
   */
  onOpenUrl?: (url: string) => void

  /**
   * Open a code preview in a new window (Electron: opens Monaco window)
   * Web: Could show inline modal with syntax highlighting
   */
  onOpenCodePreview?: (sessionId: string, toolUseId: string) => void

  /**
   * Open a terminal output preview (Electron: opens terminal window)
   * Web: Could show inline modal with monospace output
   */
  onOpenTerminalPreview?: (sessionId: string, toolUseId: string) => void

  /**
   * Open a markdown preview window
   * Web: Could show fullscreen modal
   */
  onOpenMarkdownPreview?: (content: string) => void

  /**
   * Open a multi-file diff view
   * Web: Could show inline diff viewer
   */
  onOpenMultiFileDiff?: (sessionId: string, turnId: string) => void

  /**
   * Copy text to clipboard
   * Works in both environments via navigator.clipboard
   */
  onCopyToClipboard?: (text: string) => Promise<void>

  /**
   * Open turn details in a new window/modal
   */
  onOpenTurnDetails?: (sessionId: string, turnId: string) => void

  /**
   * Open activity details in a new window/modal
   */
  onOpenActivityDetails?: (sessionId: string, activityId: string) => void

  /**
   * Read a file's contents as UTF-8 string (Electron: fs.readFile via IPC)
   * Used by datatable/spreadsheet/html-preview blocks to load file-backed content
   */
  onReadFile?: (path: string) => Promise<string>

  /**
   * Read a file as data URL (Electron: fs.readFile via IPC + base64 encode)
   * Used by image-preview blocks and image overlays
   */
  onReadFileDataUrl?: (path: string) => Promise<string>

  /**
   * Read a file as binary Uint8Array (Electron: fs.readFile via IPC)
   * Used by PDF preview blocks that need raw binary data
   */
  onReadFileBinary?: (path: string) => Promise<Uint8Array>

  /**
   * Reveal a file in the system file manager (Electron: shell.showItemInFolder)
   * Web: Not available (menu items hidden when undefined)
   */
  onRevealInFinder?: (path: string) => void

  /**
   * Platform-specific file manager name for display labels.
   * macOS → "Finder", Windows → "Explorer", Linux → "File Manager"
   * Defaults to "Finder" if not provided.
   */
  fileManagerName?: string

  /**
   * Show/hide macOS traffic light buttons (close/minimize/maximize).
   * Used to hide them when fullscreen overlays are open to prevent accidental clicks.
   * No-op on non-macOS platforms or in web viewer.
   */
  onSetTrafficLightsVisible?: (visible: boolean) => void
}

const PlatformContext = createContext<PlatformActions>({})

export interface PlatformProviderProps {
  children: ReactNode
  actions?: PlatformActions
}

/**
 * PlatformProvider - Wraps components with platform-specific actions
 *
 * Usage in Electron:
 * ```tsx
 * <PlatformProvider actions={{
 *   onOpenFile: (path) => window.electronAPI.openFile(path),
 *   onOpenUrl: (url) => window.electronAPI.openUrl(url),
 *   onCopyToClipboard: (text) => navigator.clipboard.writeText(text),
 * }}>
 *   <SessionViewer session={session} />
 * </PlatformProvider>
 * ```
 *
 * Usage in Web Viewer:
 * ```tsx
 * <PlatformProvider actions={{
 *   onOpenUrl: (url) => window.open(url, '_blank'),
 *   onCopyToClipboard: (text) => navigator.clipboard.writeText(text),
 *   // onOpenFile not provided - clicks do nothing or show inline
 * }}>
 *   <SessionViewer session={session} mode="readonly" />
 * </PlatformProvider>
 * ```
 */
export function PlatformProvider({ children, actions = {} }: PlatformProviderProps) {
  return (
    <PlatformContext.Provider value={actions}>
      {children}
    </PlatformContext.Provider>
  )
}

/**
 * usePlatform - Access platform-specific actions in components
 *
 * Components should check if actions exist before calling:
 * ```tsx
 * const { onOpenFile } = usePlatform()
 * const handleClick = () => onOpenFile?.(filePath)
 * ```
 *
 * Or provide fallback behavior:
 * ```tsx
 * const { onOpenCodePreview } = usePlatform()
 * const handleClick = () => {
 *   if (onOpenCodePreview) {
 *     onOpenCodePreview(sessionId, toolUseId)
 *   } else {
 *     setShowInlineModal(true)
 *   }
 * }
 * ```
 */
export function usePlatform(): PlatformActions {
  return useContext(PlatformContext)
}

export default PlatformContext
