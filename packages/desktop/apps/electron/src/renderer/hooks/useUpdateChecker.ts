import { useCallback, useEffect, useMemo, useState } from 'react'
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
  /** Whether a manual update check is running */
  isChecking: boolean
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
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo>(DISABLED_UPDATE_INFO)
  const [isChecking, setIsChecking] = useState(false)

  useEffect(() => {
    let cancelled = false

    window.electronAPI.getUpdateInfo()
      .then((info) => {
        if (!cancelled) setUpdateInfo(info)
      })
      .catch((error) => {
        if (cancelled) return
        setUpdateInfo({
          ...DISABLED_UPDATE_INFO,
          downloadState: 'error',
          error: error instanceof Error ? error.message : 'Unable to read update state',
        })
      })

    const unsubscribeInfo = window.electronAPI.onUpdateAvailable((info) => {
      setUpdateInfo(info)
    })

    const unsubscribeProgress = window.electronAPI.onUpdateDownloadProgress((progress) => {
      setUpdateInfo((current) => ({
        ...current,
        downloadState: current.downloadState === 'ready' ? 'ready' : 'downloading',
        downloadProgress: progress,
      }))
    })

    return () => {
      cancelled = true
      unsubscribeInfo()
      unsubscribeProgress()
    }
  }, [])

  const installUpdate = useCallback(async () => {
    try {
      await window.electronAPI.installUpdate()
    } catch (error) {
      setUpdateInfo((current) => ({
        ...current,
        downloadState: 'error',
        error: error instanceof Error ? error.message : 'Unable to install update',
      }))
      throw error
    }
  }, [])

  const checkForUpdates = useCallback(async () => {
    setIsChecking(true)
    try {
      const info = await window.electronAPI.checkForUpdates()
      setUpdateInfo(info)
    } catch (error) {
      setUpdateInfo((current) => ({
        ...current,
        downloadState: 'error',
        error: error instanceof Error ? error.message : 'Unable to check for updates',
      }))
    } finally {
      setIsChecking(false)
    }
  }, [])

  const derived = useMemo(() => ({
    updateAvailable: updateInfo.available,
    isDownloading: updateInfo.downloadState === 'downloading',
    isReadyToInstall: updateInfo.downloadState === 'ready',
    downloadProgress: updateInfo.downloadProgress,
  }), [updateInfo])

  return {
    updateInfo,
    ...derived,
    isChecking,
    checkForUpdates,
    installUpdate,
  }
}
