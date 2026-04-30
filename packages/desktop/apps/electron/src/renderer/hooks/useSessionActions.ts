import { useCallback } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

interface UseSessionActionsOptions {
  onFlag?: (sessionId: string) => void
  onUnflag?: (sessionId: string) => void
  onArchive?: (sessionId: string) => void
  onUnarchive?: (sessionId: string) => void
  onDelete: (sessionId: string, skipConfirmation?: boolean) => Promise<boolean>
}

export function useSessionActions({
  onFlag,
  onUnflag,
  onArchive,
  onUnarchive,
  onDelete,
}: UseSessionActionsOptions) {
  const { t } = useTranslation()

  const handleFlagWithToast = useCallback((sessionId: string) => {
    if (!onFlag) return
    onFlag(sessionId)
    toast(t('toast.sessionFlagged'), {
      description: t('toast.sessionFlaggedDesc'),
      action: onUnflag ? {
        label: t('toast.undo'),
        onClick: () => onUnflag(sessionId),
      } : undefined,
    })
  }, [onFlag, onUnflag, t])

  const handleUnflagWithToast = useCallback((sessionId: string) => {
    if (!onUnflag) return
    onUnflag(sessionId)
    toast(t('toast.sessionFlagRemoved'), {
      description: t('toast.sessionFlagRemovedDesc'),
      action: onFlag ? {
        label: t('toast.undo'),
        onClick: () => onFlag(sessionId),
      } : undefined,
    })
  }, [onFlag, onUnflag, t])

  const handleArchiveWithToast = useCallback((sessionId: string) => {
    if (!onArchive) return
    onArchive(sessionId)
    toast(t('toast.sessionArchived'), {
      description: t('toast.sessionArchivedDesc'),
      action: onUnarchive ? {
        label: t('toast.undo'),
        onClick: () => onUnarchive(sessionId),
      } : undefined,
    })
  }, [onArchive, onUnarchive, t])

  const handleUnarchiveWithToast = useCallback((sessionId: string) => {
    if (!onUnarchive) return
    onUnarchive(sessionId)
    toast(t('toast.sessionRestored'), {
      description: t('toast.sessionRestoredDesc'),
      action: onArchive ? {
        label: t('toast.undo'),
        onClick: () => onArchive(sessionId),
      } : undefined,
    })
  }, [onArchive, onUnarchive, t])

  const handleDeleteWithToast = useCallback(async (sessionId: string): Promise<boolean> => {
    // Confirmation dialog is shown by handleDeleteSession in App.tsx
    // We await so toast only shows after successful deletion (if user confirmed)
    const deleted = await onDelete(sessionId)
    if (deleted) {
      toast(t('toast.sessionDeleted'))
    }
    return deleted
  }, [onDelete, t])

  return {
    handleFlagWithToast,
    handleUnflagWithToast,
    handleArchiveWithToast,
    handleUnarchiveWithToast,
    handleDeleteWithToast,
  }
}
