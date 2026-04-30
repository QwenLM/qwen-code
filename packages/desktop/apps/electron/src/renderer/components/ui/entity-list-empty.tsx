/**
 * EntityListEmptyScreen — Unified empty state for entity lists.
 *
 * Wraps the Empty primitives into a single configurable component
 * used by SessionList, SourcesListPanel, and SkillsListPanel.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent } from './empty'
import { getDocUrl, type DocFeature } from '@craft-agent/shared/docs/doc-links'

export interface EntityListEmptyScreenProps {
  icon: React.ReactNode
  title: string
  description: string
  /** Auto-renders a "Learn more" button linking to this doc key */
  docKey?: DocFeature
  /** Extra action buttons rendered after "Learn more" */
  children?: React.ReactNode
  className?: string
}

export function EntityListEmptyScreen({
  icon,
  title,
  description,
  docKey,
  children,
  className = 'flex-1',
}: EntityListEmptyScreenProps) {
  const { t } = useTranslation()
  const hasActions = docKey || children

  return (
    <Empty className={className}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          {icon}
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {hasActions && (
        <EmptyContent>
          {docKey && (
            <button
              onClick={() => window.electronAPI.openUrl(getDocUrl(docKey))}
              className="inline-flex items-center h-7 px-3 text-xs font-medium rounded-[8px] bg-foreground/[0.02] shadow-minimal hover:bg-foreground/[0.05] transition-colors"
            >
              {t("common.learnMore")}
            </button>
          )}
          {children}
        </EmptyContent>
      )}
    </Empty>
  )
}
