import { useState, useEffect, useCallback, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { X } from "lucide-react"
import { motion } from "motion/react"
import { Dithering } from "@paper-design/shaders-react"
import { FullscreenOverlayBase } from "@craft-agent/ui"
import { cn } from "@/lib/utils"
import { overlayTransitionIn } from "@/lib/animations"
import { AddWorkspaceStep_Choice } from "./AddWorkspaceStep_Choice"
import { AddWorkspaceStep_CreateNew } from "./AddWorkspaceStep_CreateNew"
import { AddWorkspaceStep_OpenFolder } from "./AddWorkspaceStep_OpenFolder"
import { AddWorkspaceStep_ConnectRemote } from "./AddWorkspaceStep_ConnectRemote"
import type { Workspace } from "../../../shared/types"
import { toast } from "sonner"

type CreationStep = 'choice' | 'create' | 'open' | 'remote'

interface WorkspaceCreationScreenProps {
  /** Callback when a workspace is created successfully */
  onWorkspaceCreated: (workspace: Workspace) => void
  /** Callback when the screen is dismissed */
  onClose: () => void
  className?: string
  /** When set, skip choice step and open ConnectRemote in reconnect mode */
  reconnectWorkspace?: Workspace
  /** Reconnect an existing remote workspace and resolve only on real success. */
  onReconnectWorkspace?: (workspaceId: string, remoteServer: { url: string; token: string; remoteWorkspaceId: string }) => Promise<void>
}

/**
 * WorkspaceCreationScreen - Full-screen overlay for creating workspaces
 *
 * Obsidian-style flow:
 * 1. Choice: Create new workspace OR Open existing folder
 * 2a. Create: Enter name + choose location (default or custom)
 * 2b. Open: Browse folder OR create new folder at location
 */
export function WorkspaceCreationScreen({
  onWorkspaceCreated,
  onClose,
  className,
  reconnectWorkspace,
  onReconnectWorkspace,
}: WorkspaceCreationScreenProps) {
  const { t } = useTranslation()
  // Start at 'remote' step directly when reconnecting
  const [step, setStep] = useState<CreationStep>(reconnectWorkspace ? 'remote' : 'choice')
  const [isCreating, setIsCreating] = useState(false)
  const [dimensions, setDimensions] = useState({ width: 1920, height: 1080 })

  // Track window dimensions for shader
  useEffect(() => {
    const updateDimensions = () => {
      setDimensions({ width: window.innerWidth, height: window.innerHeight })
    }
    updateDimensions()
    window.addEventListener('resize', updateDimensions)
    return () => window.removeEventListener('resize', updateDimensions)
  }, [])

  // Wrap onClose to prevent closing during creation
  // FullscreenOverlayBase handles ESC key, this wrapper prevents closing when busy
  const handleClose = useCallback(() => {
    if (!isCreating) {
      onClose()
    }
  }, [isCreating, onClose])

  const handleCreateWorkspace = useCallback(async (folderPath: string, name: string, remoteServer?: { url: string; token: string; remoteWorkspaceId: string }) => {
    setIsCreating(true)
    try {
      const workspace = await window.electronAPI.createWorkspace(folderPath, name, remoteServer)
      onWorkspaceCreated(workspace)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      toast.error(t('toast.failedToCreateWorkspace'), {
        description: message,
      })
    } finally {
      setIsCreating(false)
    }
  }, [onWorkspaceCreated])

  const handleReconnectWorkspace = useCallback(async (workspaceId: string, remoteServer: { url: string; token: string; remoteWorkspaceId: string }) => {
    if (!onReconnectWorkspace) {
      throw new Error('Reconnect handler not configured')
    }

    setIsCreating(true)
    try {
      await onReconnectWorkspace(workspaceId, remoteServer)
    } finally {
      setIsCreating(false)
    }
  }, [onReconnectWorkspace])

  const renderStep = () => {
    switch (step) {
      case 'choice':
        return (
          <AddWorkspaceStep_Choice
            onCreateNew={() => setStep('create')}
            onOpenFolder={() => setStep('open')}
            onConnectRemote={() => setStep('remote')}
          />
        )

      case 'create':
        return (
          <AddWorkspaceStep_CreateNew
            onBack={() => setStep('choice')}
            onCreate={handleCreateWorkspace}
            isCreating={isCreating}
          />
        )

      case 'open':
        return (
          <AddWorkspaceStep_OpenFolder
            onBack={() => setStep('choice')}
            onCreate={handleCreateWorkspace}
            isCreating={isCreating}
          />
        )

      case 'remote':
        return (
          <AddWorkspaceStep_ConnectRemote
            onBack={reconnectWorkspace ? onClose : () => setStep('choice')}
            onCreate={handleCreateWorkspace}
            isCreating={isCreating}
            initialUrl={reconnectWorkspace?.remoteServer?.url}
            initialToken={reconnectWorkspace?.remoteServer?.token}
            reconnectWorkspace={reconnectWorkspace?.remoteServer ? {
              id: reconnectWorkspace.id,
              name: reconnectWorkspace.name,
              remoteWorkspaceId: reconnectWorkspace.remoteServer.remoteWorkspaceId,
            } : undefined}
            onUpdate={handleReconnectWorkspace}
          />
        )

      default:
        return null
    }
  }

  // Get theme colors from CSS variables for the shader
  const shaderColors = useMemo(() => {
    if (typeof window === 'undefined') return { back: '#00000000', front: '#684e85' }
    const root = document.documentElement
    const isDark = root.classList.contains('dark')
    // Transparent back, accent-tinted front
    return isDark
      ? { back: '#00000000', front: '#9b7bb8' }  // lighter accent for dark mode
      : { back: '#00000000', front: '#684e85' }  // accent color
  }, [])

  // FullscreenOverlayBase handles portal, traffic lights, and ESC key
  return (
    <FullscreenOverlayBase
      isOpen={true}
      onClose={handleClose}
      className={cn("z-splash flex flex-col bg-background", className)}
    >
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={overlayTransitionIn}
        className="flex flex-col flex-1"
      >
        {/* Dithering shader background */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.3 }}
          transition={overlayTransitionIn}
          className="absolute inset-0 pointer-events-none"
        >
          <Dithering
            colorBack={shaderColors.back}
            colorFront={shaderColors.front}
            shape="swirl"
            type="8x8"
            size={2}
            speed={1}
            scale={1}
            width={dimensions.width}
            height={dimensions.height}
          />
        </motion.div>

        {/* Header with drag region and close button */}
        <header className="titlebar-drag-region relative h-[50px] shrink-0 flex items-center justify-end px-6">
          {/* Close button - explicitly no-drag */}
          <motion.button
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={overlayTransitionIn}
            onClick={(e) => {
              e.stopPropagation()
              handleClose()
            }}
            disabled={isCreating}
            className={cn(
              "titlebar-no-drag flex items-center justify-center p-2 rounded-[6px]",
              "bg-background shadow-minimal hover:bg-foreground-5",
              "text-muted-foreground hover:text-foreground",
              "transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "mr-[-8px] mt-2",
              isCreating && "opacity-50 cursor-not-allowed"
            )}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </motion.button>
        </header>

        {/* Main content */}
        <motion.main
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={overlayTransitionIn}
          className="relative flex flex-1 items-center justify-center p-8"
        >
          {renderStep()}
        </motion.main>
      </motion.div>
    </FullscreenOverlayBase>
  )
}
