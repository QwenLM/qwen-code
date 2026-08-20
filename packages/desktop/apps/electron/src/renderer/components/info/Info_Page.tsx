/**
 * Info_Page
 *
 * Compound page layout component for Info pages.
 * Handles loading, error, and empty states with consistent styling.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle } from 'lucide-react'
import { PanelHeader, type PanelHeaderProps } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@craft-agent/ui'
import { cn } from '@/lib/utils'
import { CHAT_LAYOUT } from '@/config/layout'

export interface Info_PageProps {
  children: React.ReactNode
  /** Show loading spinner */
  loading?: boolean
  /** Show error state with message */
  error?: string
  /** Show empty state with message */
  empty?: string
  className?: string
}

export interface Info_PageHeaderProps extends Omit<PanelHeaderProps, 'className'> {
  className?: string
}

export interface Info_PageHeroProps {
  /** Avatar element */
  avatar: React.ReactNode
  /** Title displayed next to avatar */
  title?: string
  /** Tagline/description text below title */
  tagline?: string | null
  className?: string
}

export interface Info_PageContentProps {
  children: React.ReactNode
  className?: string
}

function Info_PageRoot({
  children,
  loading,
  error,
  empty,
  className,
}: Info_PageProps) {
  const { t } = useTranslation()
  // Extract header from children for consistent structure
  let header: React.ReactNode = null
  const otherChildren: React.ReactNode[] = []

  React.Children.forEach(children, (child) => {
    if (React.isValidElement(child) && child.type === Info_PageHeader) {
      header = child
    } else {
      otherChildren.push(child)
    }
  })

  // Loading state
  if (loading) {
    return (
      <div className={cn('h-full flex flex-col', className)}>
        {header}
        <div className="flex-1 flex items-center justify-center">
          <Spinner className="text-lg text-muted-foreground" />
        </div>
      </div>
    )
  }

  // Error state
  if (error) {
    return (
      <div className={cn('h-full flex flex-col', className)}>
        {header}
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground p-4">
          <AlertCircle className="h-10 w-10 text-destructive" />
          <p className="text-sm font-medium">{t('common.errorLoadingContent')}</p>
          <p className="text-xs text-center max-w-md">{error}</p>
        </div>
      </div>
    )
  }

  // Empty state
  if (empty) {
    return (
      <div className={cn('h-full flex flex-col', className)}>
        {header}
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <p className="text-sm">{empty}</p>
        </div>
      </div>
    )
  }

  // Normal content
  return (
    <div className={cn('h-full flex flex-col', className)}>
      {header}
      {otherChildren}
    </div>
  )
}

function Info_PageHeader({ className, ...props }: Info_PageHeaderProps) {
  return <PanelHeader className={className} {...props} />
}

function Info_PageHero({ avatar, title, tagline, className }: Info_PageHeroProps) {
  return (
    <div className={cn('flex items-start gap-3', className)}>
      <div className="h-[32px] w-[32px] shrink-0 mt-[2px] rounded-[4px] ring-1 ring-border/30 overflow-hidden">
        {avatar}
      </div>
      <div className="flex-1 min-w-0">
        {title && (
          <h2 className="text-base font-semibold text-foreground leading-tight">
            {title}
          </h2>
        )}
        {tagline && (
          <p className={cn('text-sm text-foreground/60 leading-snug line-clamp-1', title ? 'mt-0.5' : 'mt-0')}>
            {tagline}
          </p>
        )}
      </div>
    </div>
  )
}

function Info_PageContent({ children, className }: Info_PageContentProps) {
  return (
    <div className="relative flex-1 min-h-0">
      {/* Mask wrapper - fades content at top and bottom over transparent/image backgrounds */}
      <div
        className="h-full"
        style={{
          maskImage: 'linear-gradient(to bottom, transparent 0%, black 32px, black calc(100% - 32px), transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 32px, black calc(100% - 32px), transparent 100%)'
        }}
      >
        <ScrollArea className="h-full">
          <div className={cn(CHAT_LAYOUT.maxWidth, 'mx-auto px-5 pt-6 pb-10')}>
            <div className={cn('space-y-6', className)}>{children}</div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}

export const Info_Page = Object.assign(Info_PageRoot, {
  Header: Info_PageHeader,
  Hero: Info_PageHero,
  Content: Info_PageContent,
})
