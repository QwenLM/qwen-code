import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { useTransportConnectionState } from './useTransportConnectionState'
import { toast } from 'sonner'

type ServerBrowserMode = 'browse' | 'manual'

interface DirectoryPickerResult {
  /** Open the picker (native dialog in local mode, ServerDirectoryBrowser in remote mode). */
  pickDirectory: () => void
  /** Whether the ServerDirectoryBrowser modal should be rendered. */
  showServerBrowser: boolean
  /** Which mode the ServerDirectoryBrowser should use. */
  serverBrowserMode: ServerBrowserMode
  /** Close the server browser without selecting. */
  cancelServerBrowser: () => void
  /** Called when a path is selected from the server browser. */
  confirmServerBrowser: (path: string) => void
  /** Whether we're in remote mode (informational). */
  isRemote: boolean
}

export function useDirectoryPicker(
  onSelect: (path: string) => void
): DirectoryPickerResult {
  const { t } = useTranslation()
  const connectionState = useTransportConnectionState()
  const isRemote = connectionState?.mode === 'remote'
  const canBrowse = isRemote &&
    window.electronAPI.isChannelAvailable(RPC_CHANNELS.fs.LIST_DIRECTORY)

  const [showServerBrowser, setShowServerBrowser] = useState(false)

  const serverBrowserMode: ServerBrowserMode = canBrowse ? 'browse' : 'manual'

  const pickDirectory = useCallback(async () => {
    if (isRemote) {
      // Remote mode — open ServerDirectoryBrowser (browse or manual depending on server support)
      setShowServerBrowser(true)
      return
    }

    // Local mode — native OS dialog
    try {
      const path = await window.electronAPI.openFolderDialog()
      if (path) onSelect(path)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      toast.error(t('toast.failedToOpenFolderPicker'), {
        description: message,
      })
    }
  }, [isRemote, onSelect])

  const cancelServerBrowser = useCallback(() => {
    setShowServerBrowser(false)
  }, [])

  const confirmServerBrowser = useCallback((path: string) => {
    setShowServerBrowser(false)
    onSelect(path)
  }, [onSelect])

  return {
    pickDirectory,
    showServerBrowser,
    serverBrowserMode,
    cancelServerBrowser,
    confirmServerBrowser,
    isRemote,
  }
}
