import * as React from 'react'

interface CollapsibleMarkdownContextValue {
  /** Set of section IDs that are currently collapsed */
  collapsedSections: Set<string>
  /** Toggle a section's collapsed state */
  toggleSection: (sectionId: string) => void
  /** Expand all sections */
  expandAll: () => void
}

const CollapsibleMarkdownContext = React.createContext<CollapsibleMarkdownContextValue | null>(null)

/**
 * Hook to access collapsible markdown context.
 * Returns null if not within a provider (for non-collapsible mode).
 */
export function useCollapsibleMarkdown(): CollapsibleMarkdownContextValue | null {
  return React.useContext(CollapsibleMarkdownContext)
}

interface CollapsibleMarkdownProviderProps {
  children: React.ReactNode
}

/**
 * CollapsibleMarkdownProvider
 *
 * Provides state management for collapsible markdown sections.
 * All sections start expanded (empty collapsed set).
 */
export function CollapsibleMarkdownProvider({ children }: CollapsibleMarkdownProviderProps) {
  const [collapsedSections, setCollapsedSections] = React.useState<Set<string>>(() => new Set())

  const toggleSection = React.useCallback((sectionId: string) => {
    setCollapsedSections(prev => {
      const next = new Set(prev)
      if (next.has(sectionId)) {
        next.delete(sectionId)
      } else {
        next.add(sectionId)
      }
      return next
    })
  }, [])

  const expandAll = React.useCallback(() => {
    setCollapsedSections(new Set())
  }, [])

  const value = React.useMemo(
    () => ({ collapsedSections, toggleSection, expandAll }),
    [collapsedSections, toggleSection, expandAll]
  )

  return (
    <CollapsibleMarkdownContext.Provider value={value}>
      {children}
    </CollapsibleMarkdownContext.Provider>
  )
}
