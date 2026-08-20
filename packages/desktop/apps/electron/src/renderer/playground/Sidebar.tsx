import * as React from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CategoryGroup } from './registry'

interface SidebarProps {
  categories: CategoryGroup[]
  selectedId: string | null
  onSelect: (id: string) => void
}

const STORAGE_KEY = 'playground-expanded-categories'

export function Sidebar({ categories, selectedId, onSelect }: SidebarProps) {
  const [expandedCategories, setExpandedCategories] = React.useState<Set<string>>(() => {
    // Try to restore from localStorage, otherwise collapse all by default
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored) as string[]
        return new Set(parsed)
      }
    } catch {
      // Ignore parse errors
    }
    return new Set<string>()
  })

  // Persist expanded categories to localStorage
  React.useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...expandedCategories]))
    } catch {
      // Ignore storage errors
    }
  }, [expandedCategories])

  const toggleCategory = (name: string) => {
    setExpandedCategories(prev => {
      const next = new Set(prev)
      if (next.has(name)) {
        next.delete(name)
      } else {
        next.add(name)
      }
      return next
    })
  }

  return (
    <nav className="w-56 shrink-0 border-r border-border bg-background overflow-y-auto">
      <div className="p-3 space-y-1">
        {categories.map(category => {
          const isExpanded = expandedCategories.has(category.name)

          return (
            <div key={category.name}>
              {/* Category header */}
              <button
                onClick={() => toggleCategory(category.name)}
                className="w-full flex items-center gap-1.5 px-2 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider hover:text-foreground transition-colors"
              >
                <ChevronRight
                  className={cn(
                    'h-3.5 w-3.5 transition-transform',
                    isExpanded && 'rotate-90'
                  )}
                />
                {category.name}
                <span className="ml-auto text-[10px] font-normal opacity-60">
                  {category.components.length}
                </span>
              </button>

              {/* Component list */}
              {isExpanded && (
                <div className="ml-2 space-y-0.5">
                  {category.components.map(component => (
                    <button
                      key={component.id}
                      onClick={() => onSelect(component.id)}
                      className={cn(
                        'w-full text-left px-3 py-1.5 rounded-md text-sm transition-colors',
                        selectedId === component.id
                          ? 'bg-foreground/10 text-foreground font-medium'
                          : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
                      )}
                    >
                      {component.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </nav>
  )
}
