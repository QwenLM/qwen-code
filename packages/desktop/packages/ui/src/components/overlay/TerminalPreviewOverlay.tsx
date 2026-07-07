/**
 * TerminalPreviewOverlay - Overlay for terminal output (Bash/Grep/Glob tools)
 *
 * Uses PreviewOverlay for presentation and TerminalOutput for display.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal, Search, FolderSearch } from 'lucide-react'
import { PreviewOverlay, type BadgeVariant } from './PreviewOverlay'
import { ContentFrame } from './ContentFrame'
import { TerminalOutput, type ToolType } from '../terminal/TerminalOutput'

export interface TerminalPreviewOverlayProps {
  /** Whether the overlay is visible */
  isOpen: boolean
  /** Callback when the overlay should close */
  onClose: () => void
  /** The command that was executed */
  command: string
  /** The output from the command */
  output: string
  /** Exit code (0 = success) */
  exitCode?: number
  /** Tool type for display styling */
  toolType?: ToolType
  /** Optional description of what the command does */
  description?: string
  /** Theme mode */
  theme?: 'light' | 'dark'
  /** Error message if the command failed to execute */
  error?: string
  /** Render inline without dialog (for playground) */
  embedded?: boolean
}

function getToolConfig(toolType: ToolType): {
  icon: typeof Terminal
  label: string
  variant: BadgeVariant
} {
  switch (toolType) {
    case 'grep':
      return { icon: Search, label: 'Grep', variant: 'green' }
    case 'glob':
      return { icon: FolderSearch, label: 'Glob', variant: 'purple' }
    default:
      return { icon: Terminal, label: 'Bash', variant: 'gray' }
  }
}

export function TerminalPreviewOverlay({
  isOpen,
  onClose,
  command,
  output,
  exitCode,
  toolType = 'bash',
  description,
  theme = 'light',
  error,
  embedded,
}: TerminalPreviewOverlayProps) {
  const { t } = useTranslation()
  const config = getToolConfig(toolType)

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      theme={theme}
      typeBadge={{
        icon: config.icon,
        label: config.label,
        variant: config.variant,
      }}
      title={description || ''}
      error={error ? { label: 'Command Failed', message: error } : undefined}
      embedded={embedded}
      className="bg-foreground-3"
    >
      <ContentFrame title={t('overlay.terminal')}>
        <div className="flex-1 overflow-y-auto min-h-0">
          <TerminalOutput
            command={command}
            output={output}
            exitCode={exitCode}
            toolType={toolType}
            description={description}
            theme={theme}
          />
        </div>
      </ContentFrame>
    </PreviewOverlay>
  )
}
