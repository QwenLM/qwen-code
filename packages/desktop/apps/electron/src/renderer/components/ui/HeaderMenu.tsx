/**
 * HeaderMenu
 *
 * A "..." dropdown menu for panel headers with built-in Open in New Window action.
 * Pass page-specific menu items as children; they appear above the separator.
 * Optionally includes a "Learn More" link to documentation when helpFeature is provided.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { MoreHorizontal, AppWindow, ExternalLink } from 'lucide-react'
import { HeaderIconButton } from './HeaderIconButton'
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from './dropdown-menu'
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
} from './styled-dropdown'
import { type DocFeature, getDocUrl } from '@craft-agent/shared/docs/doc-links'

interface HeaderMenuProps {
  /** Route string for Open in New Window action */
  route: string
  /** Page-specific menu items (rendered before Open in New Window) */
  children?: React.ReactNode
  /** Documentation feature - when provided, adds a "Learn More" link to docs */
  helpFeature?: DocFeature
}

export function HeaderMenu({ route, children, helpFeature }: HeaderMenuProps) {
  const { t } = useTranslation()
  const handleOpenInNewWindow = async () => {
    const separator = route.includes('?') ? '&' : '?'
    const url = `craftagents://${route}${separator}window=focused`
    try {
      await window.electronAPI?.openUrl(url)
    } catch (error) {
      console.error('[HeaderMenu] openUrl failed:', error)
    }
  }

  const handleLearnMore = helpFeature ? () => {
    window.electronAPI?.openUrl(getDocUrl(helpFeature))
  } : undefined

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <HeaderIconButton icon={<MoreHorizontal className="h-4 w-4" />} />
      </DropdownMenuTrigger>
      <StyledDropdownMenuContent align="end">
        {children}
        {children && <StyledDropdownMenuSeparator />}
        <StyledDropdownMenuItem onClick={handleOpenInNewWindow}>
          <AppWindow className="h-3.5 w-3.5" />
          <span className="flex-1">{t("sessionMenu.openInNewWindow")}</span>
        </StyledDropdownMenuItem>
        {helpFeature && (
          <>
            <StyledDropdownMenuSeparator />
            <StyledDropdownMenuItem onClick={handleLearnMore}>
              <ExternalLink className="h-3.5 w-3.5" />
              <span className="flex-1">{t("common.learnMore")}</span>
            </StyledDropdownMenuItem>
          </>
        )}
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}
