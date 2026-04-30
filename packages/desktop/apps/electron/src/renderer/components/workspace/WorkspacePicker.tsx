/**
 * WorkspacePicker — shown when a thin client connects without a workspace ID.
 * Lists remote server workspaces and allows selection or creation.
 */

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import { Spinner } from '@craft-agent/ui'
import { getWorkspaceDisplayName, getWorkspaceInitial } from '@/utils/workspace'
import type { WorkspaceInfo } from '../../../shared/types'
import {
  AddWorkspaceContainer,
  AddWorkspaceStepHeader,
  AddWorkspacePrimaryButton,
} from './primitives'

interface WorkspacePickerProps {
  onSelectWorkspace: (workspaceId: string) => void
}

export function WorkspacePicker({ onSelectWorkspace }: WorkspacePickerProps) {
  const { t } = useTranslation()
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  // Load workspaces from server
  useEffect(() => {
    window.electronAPI.getServerWorkspaces()
      .then(ws => {
        setWorkspaces(ws)
        setLoading(false)
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : 'Failed to load workspaces')
        setLoading(false)
      })
  }, [])

  const handleCreate = useCallback(async () => {
    if (!newName.trim()) return
    setCreating(true)
    try {
      const ws = await window.electronAPI.createServerWorkspace(newName.trim())
      onSelectWorkspace(ws.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace')
      setCreating(false)
    }
  }, [newName, onSelectWorkspace])

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-sidebar px-4">
        <AddWorkspaceContainer>
          <Spinner className="h-6 w-6" />
          <p className="mt-3 text-sm text-muted-foreground">{t("workspace.loadingWorkspaces")}</p>
        </AddWorkspaceContainer>
      </div>
    )
  }

  return (
    <div className="flex h-screen items-center justify-center bg-sidebar px-4">
      <AddWorkspaceContainer>
        <AddWorkspaceStepHeader
          title={t("workspace.selectWorkspace")}
          description={t("workspace.selectWorkspaceDesc")}
        />

        {error && (
          <p className="mt-3 w-full text-center text-sm text-destructive">{error}</p>
        )}

        {/* Workspace list */}
        {workspaces.length > 0 && (
          <div className="mt-5 w-full space-y-1.5">
            {workspaces.map(ws => {
              const displayName = getWorkspaceDisplayName(ws, t)
              return (
                <button
                  key={ws.id}
                  onClick={() => onSelectWorkspace(ws.id)}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-foreground/5"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent text-xs font-semibold uppercase">
                    {getWorkspaceInitial(ws, t)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{displayName}</div>
                    <div className="truncate text-xs text-muted-foreground">{ws.slug}</div>
                  </div>
                </button>
              )
            })}
          </div>
        )}

        {/* Divider */}
        <div className="mt-5 mb-4 w-full border-t" />

        {/* Create new */}
        <div className="w-full space-y-2">
          <input
            type="text"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
            placeholder={t("workspace.newWorkspaceName")}
            className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
          <AddWorkspacePrimaryButton
            onClick={handleCreate}
            disabled={!newName.trim()}
            loading={creating}
            loadingText={t("workspace.creating")}
            className="bg-accent hover:bg-accent/90 text-white"
          >
            <Plus className="mr-1.5 h-4 w-4" />
            {t("workspace.createWorkspace")}
          </AddWorkspacePrimaryButton>
        </div>
      </AddWorkspaceContainer>
    </div>
  )
}
