import * as React from 'react'
import type { ComponentEntry } from './types'
import type { SessionMeta } from '@/atoms/sessions'
import type { SessionStatus } from '@/config/session-status-config'
import type { ContentSearchResult } from '@/hooks/useSessionSearch'
import { Circle } from 'lucide-react'
import { SessionSearchHeader } from '@/components/app-shell/SessionSearchHeader'
import { SessionItem } from '@/components/app-shell/SessionItem'
import { SessionListProvider, type SessionListContextValue } from '@/context/SessionListContext'
import { ActionRegistryProvider } from '@/actions/registry'

// ============================================================================
// Mock Todo States (minimal set for playground)
// ============================================================================

const mockSessionStatuses: SessionStatus[] = [
  {
    id: 'todo',
    label: 'Todo',
    resolvedColor: 'var(--muted-foreground)',
    icon: <Circle className="h-3.5 w-3.5" strokeWidth={1.5} />,
    iconColorable: true,
    category: 'open',
  },
  {
    id: 'in-progress',
    label: 'In Progress',
    resolvedColor: 'var(--info)',
    icon: <Circle className="h-3.5 w-3.5" strokeWidth={1.5} />,
    iconColorable: true,
    category: 'open',
  },
  {
    id: 'done',
    label: 'Done',
    resolvedColor: 'var(--success)',
    icon: <Circle className="h-3.5 w-3.5" strokeWidth={1.5} />,
    iconColorable: true,
    category: 'closed',
  },
]

// ============================================================================
// Sample Session Data
// ============================================================================

const sampleSessions: SessionMeta[] = [
  {
    id: 'session-1',
    name: 'Fix authentication bug in login flow',
    workspaceId: 'workspace-1',
    lastMessageAt: Date.now() - 1000 * 60 * 5, // 5 min ago
    sessionStatus: 'in-progress',
    hasUnread: true,
    isFlagged: true,
  },
  {
    id: 'session-2',
    name: 'Implement search functionality',
    workspaceId: 'workspace-1',
    lastMessageAt: Date.now() - 1000 * 60 * 30, // 30 min ago
    sessionStatus: 'todo',
    isFlagged: true,
    labels: ['feature', 'priority::high'],
  },
  {
    id: 'session-3',
    name: 'Review pull request #42',
    workspaceId: 'workspace-1',
    lastMessageAt: Date.now() - 1000 * 60 * 60, // 1 hour ago
    sessionStatus: 'done',
    isFlagged: true,
    isProcessing: true,
  },
  {
    id: 'session-4',
    name: 'Debug API response handling',
    workspaceId: 'workspace-1',
    lastMessageAt: Date.now() - 1000 * 60 * 60 * 2, // 2 hours ago
    sessionStatus: 'todo',
    isFlagged: true,
  },
]

function createMockContext(overrides: Partial<SessionListContextValue> = {}): SessionListContextValue {
  return {
    onRenameClick: () => {},
    onSessionStatusChange: () => {},
    onMarkUnread: () => {},
    onDelete: async () => true,
    onSelectSessionById: () => {},
    onOpenInNewWindow: () => {},
    onFocusZone: () => {},
    onKeyDown: () => {},
    sessionStatuses: mockSessionStatuses,
    flatLabels: [],
    labels: [],
    isMultiSelectActive: false,
    contentSearchResults: new Map(),
    ...overrides,
  }
}

const noopKeyDown = () => {}

// ============================================================================
// SessionListSearchPreview - Renders REAL SessionItem components with context
// ============================================================================

interface SessionListSearchPreviewProps {
  /** Current search query (highlights matches in titles) */
  searchQuery?: string
  /** Show search input bar */
  showSearchInput?: boolean
  /** Show loading state in status row */
  isSearching?: boolean
  /** Index of currently selected session (0-based) */
  selectedIndex?: number
  /** Match count for selected session (shows yellow badge) */
  chatMatchCount?: number
  /** Whether to show "no results" state */
  showNoResults?: boolean
  /** Explicit result count to display (defaults to filtered session count) */
  resultCount?: number
}

function SessionListSearchPreview({
  searchQuery = '',
  showSearchInput = true,
  isSearching = false,
  selectedIndex = 0,
  chatMatchCount,
  showNoResults = false,
  resultCount,
}: SessionListSearchPreviewProps) {
  // Filter if there's a search query (simple title match for demo)
  const filteredSessions = React.useMemo(() => {
    if (showNoResults) return []
    if (!searchQuery) return sampleSessions
    return sampleSessions.filter(s => (s.name || '').toLowerCase().includes(searchQuery.toLowerCase()))
  }, [showNoResults, searchQuery])

  const selectedSessionId = filteredSessions[selectedIndex]?.id ?? null

  // Build content search results for match badge
  const contentSearchResults = new Map<string, ContentSearchResult>()
  if (chatMatchCount && selectedSessionId) {
    contentSearchResults.set(selectedSessionId, { matchCount: chatMatchCount, snippet: '' })
  }

  const ctx = createMockContext({
    searchQuery,
    selectedSessionId,
    contentSearchResults,
  })

  const displayCount = resultCount ?? filteredSessions.length

  return (
    <ActionRegistryProvider>
      <SessionListProvider value={ctx}>
        <div className="w-[320px] h-[480px] flex flex-col border border-border rounded-lg overflow-hidden bg-background">
          {/* Search header - uses the SAME component as the real app */}
          {showSearchInput && (
            <SessionSearchHeader
              searchQuery={searchQuery}
              isSearching={isSearching}
              resultCount={displayCount}
              readOnly
            />
          )}

          {/* Session list */}
          <div className="flex-1 overflow-auto">
            {showNoResults ? (
              <div className="flex flex-col items-center justify-center py-12 px-4">
                <p className="text-sm text-muted-foreground">No conversations found</p>
                <p className="text-xs text-muted-foreground/60 mt-0.5">
                  Searched titles and message content
                </p>
                <button className="text-xs text-foreground hover:underline mt-2">
                  Clear search
                </button>
              </div>
            ) : (
              <div className="flex flex-col pb-4">
                {/* Date header */}
                <div className="px-4 py-2">
                  <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                    Today
                  </span>
                </div>

                {filteredSessions.map((session, index) => (
                  <SessionItem
                    key={session.id}
                    item={session}
                    index={index}
                    itemProps={{ tabIndex: 0, onKeyDown: noopKeyDown }}
                    isSelected={session.id === selectedSessionId}
                    isFirstInGroup={index === 0}
                    isInMultiSelect={false}
                    onSelect={() => {}}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </SessionListProvider>
    </ActionRegistryProvider>
  )
}

// ============================================================================
// SessionItemPreview - Single real SessionItem with context providers
// ============================================================================

interface SessionItemPreviewProps {
  item?: SessionMeta
  isSelected?: boolean
  searchQuery?: string
  chatMatchCount?: number
  state?: 'none' | 'loading' | 'plan' | 'new'
  flagged?: boolean
}

function SessionItemPreview({
  item = sampleSessions[0],
  isSelected = false,
  searchQuery = '',
  chatMatchCount,
  state = 'none',
  flagged = false,
}: SessionItemPreviewProps) {
  const resolvedItem = React.useMemo(() => {
    const base: SessionMeta = { ...item, isProcessing: false, hasUnread: false, lastMessageRole: undefined, isFlagged: flagged }
    switch (state) {
      case 'loading': base.isProcessing = true; break
      case 'plan': base.lastMessageRole = 'plan'; break
      case 'new': base.hasUnread = true; break
    }
    return base
  }, [item, state, flagged])

  const contentSearchResults = new Map<string, ContentSearchResult>()
  if (chatMatchCount && resolvedItem) {
    contentSearchResults.set(resolvedItem.id, { matchCount: chatMatchCount, snippet: '' })
  }

  const ctx = createMockContext({
    searchQuery,
    selectedSessionId: isSelected ? resolvedItem.id : null,
    contentSearchResults,
  })

  return (
    <ActionRegistryProvider>
      <SessionListProvider value={ctx}>
        <SessionItem
          item={resolvedItem}
          index={0}
          itemProps={{ tabIndex: 0, onKeyDown: noopKeyDown }}
          isSelected={isSelected}
          isFirstInGroup
          isInMultiSelect={false}
          onSelect={() => {}}
        />
      </SessionListProvider>
    </ActionRegistryProvider>
  )
}

// ============================================================================
// Registry Entries
// ============================================================================

export const sessionListComponents: ComponentEntry[] = [
  {
    id: 'session-list-search',
    name: 'SessionList Search States',
    category: 'Session List',
    description: 'Session list using real SessionItem components with search and badges',
    component: SessionListSearchPreview,
    props: [
      {
        name: 'searchQuery',
        description: 'Current search query text',
        control: { type: 'string', placeholder: 'Search...' },
        defaultValue: '',
      },
      {
        name: 'showSearchInput',
        description: 'Show the search input bar',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'isSearching',
        description: 'Show loading spinner while searching',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'selectedIndex',
        description: 'Index of selected session (0-based)',
        control: { type: 'number', min: 0, max: 3, step: 1 },
        defaultValue: 0,
      },
      {
        name: 'chatMatchCount',
        description: 'Number of matches in chat (shows yellow badge)',
        control: { type: 'number', min: 0, max: 50, step: 1 },
        defaultValue: 0,
      },
      {
        name: 'showNoResults',
        description: 'Show empty/no results state',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'resultCount',
        description: 'Explicit result count to display',
        control: { type: 'number', min: 0, max: 999, step: 1 },
        defaultValue: undefined,
      },
    ],
    variants: [
      {
        name: 'Default (No Search)',
        description: 'Normal session list without search active',
        props: {
          searchQuery: '',
          showSearchInput: false,
        },
      },
      {
        name: 'Search Active',
        description: 'Search input visible, no query yet',
        props: {
          searchQuery: '',
          showSearchInput: true,
        },
      },
      {
        name: 'Title Match Highlight',
        description: 'Search query matching session titles',
        props: {
          searchQuery: 'auth',
          showSearchInput: true,
          selectedIndex: 0,
          resultCount: 2,
        },
      },
      {
        name: 'With Match Badge',
        description: 'Selected session with yellow match count badge',
        props: {
          searchQuery: 'auth',
          showSearchInput: true,
          selectedIndex: 0,
          chatMatchCount: 5,
          resultCount: 47,
        },
      },
      {
        name: 'Searching (Loading)',
        description: 'Content search in progress',
        props: {
          searchQuery: 'complex query',
          showSearchInput: true,
          isSearching: true,
        },
      },
      {
        name: 'No Results',
        description: 'Search returned no matches',
        props: {
          searchQuery: 'xyznonexistent',
          showSearchInput: true,
          showNoResults: true,
          resultCount: 0,
        },
      },
    ],
    mockData: () => ({}),
  },
  {
    id: 'session-item-search',
    name: 'SessionItem States',
    category: 'Session List',
    description: 'Individual real SessionItem showing visual states with search and badges',
    component: SessionItemPreview,
    props: [
      {
        name: 'state',
        description: 'Indicator state shown next to status icon',
        control: {
          type: 'select',
          options: [
            { label: 'None', value: 'none' },
            { label: 'Loading', value: 'loading' },
            { label: 'Plan', value: 'plan' },
            { label: 'New', value: 'new' },
          ],
        },
        defaultValue: 'none',
      },
      {
        name: 'searchQuery',
        description: 'Search query for highlighting',
        control: { type: 'string', placeholder: 'Search...' },
        defaultValue: '',
      },
      {
        name: 'isSelected',
        description: 'Whether this session is selected',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'chatMatchCount',
        description: 'Number of matches (shows yellow badge)',
        control: { type: 'number', min: 0, max: 50, step: 1 },
        defaultValue: 0,
      },
      {
        name: 'flagged',
        description: 'Whether the session is flagged',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      {
        name: 'Default',
        description: 'Normal state without indicators',
        props: {
          item: sampleSessions[0],
          state: 'none',
        },
      },
      {
        name: 'Loading',
        description: 'Session is processing (shows spinner)',
        props: {
          item: sampleSessions[0],
          state: 'loading',
        },
      },
      {
        name: 'Plan Pending',
        description: 'Session has a pending plan (shows compass icon)',
        props: {
          item: sampleSessions[0],
          state: 'plan',
        },
      },
      {
        name: 'New / Unread',
        description: 'Session has unread messages (shows accent dot)',
        props: {
          item: sampleSessions[0],
          state: 'new',
        },
      },
      {
        name: 'Flagged',
        description: 'Session is flagged',
        props: {
          item: sampleSessions[0],
          flagged: true,
        },
      },
      {
        name: 'Title Highlighted',
        description: 'Search query highlights in title',
        props: {
          item: sampleSessions[0],
          searchQuery: 'auth',
        },
      },
      {
        name: 'Selected with Match Badge',
        description: 'Selected session with yellow match count badge',
        props: {
          item: sampleSessions[0],
          searchQuery: 'auth',
          isSelected: true,
          chatMatchCount: 5,
        },
      },
    ],
    mockData: () => ({
      item: sampleSessions[0],
    }),
  },
]
