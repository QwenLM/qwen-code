import { useCallback } from 'react'
import { APP_VERSION } from '@craft-agent/shared/branding'
import type { UpdateInfo } from '../../shared/types'

interface UseUpdateCheckerResult {
  /** Current update info */
  updateInfo: UpdateInfo | null
  /** Whether an update is available */
  updateAvailable: boolean
  /** Whether update is currently downloading */
  isDownloading: boolean
  /** Whether update is ready to install */
  isReadyToInstall: boolean
  /** Download progress (0-100) */
  downloadProgress: number
  /** Check for updates manually */
  checkForUpdates: () => Promise<void>
  /** Install the downloaded update and restart */
  installUpdate: () => Promise<void>
}

const DISABLED_UPDATE_INFO: UpdateInfo = {
  available: false,
  currentVersion: APP_VERSION,
  latestVersion: null,
  downloadState: 'idle',
  downloadProgress: 0,
}

export function useUpdateChecker(): UseUpdateCheckerResult {
  const installUpdate = useCallback(async () => {
    throw new Error('Auto-update is disabled')
  }, [])

  const checkForUpdates = useCallback(async () => undefined, [])

  return {
    updateInfo: DISABLED_UPDATE_INFO,
    updateAvailable: false,
    isDownloading: false,
    isReadyToInstall: false,
    downloadProgress: 0,
    checkForUpdates,
    installUpdate,
  }
}
