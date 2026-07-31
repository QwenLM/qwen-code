/**
 * Playground registry for EntityRow and EntityList primitives.
 *
 * Demonstrates all three entity types (Sessions, Sources, Skills)
 * composed through the same EntityRow/EntityList building blocks.
 */

import * as React from 'react'
import { useState } from 'react'
import { Circle, Flag, Globe, HardDrive, Zap, DatabaseZap, Plug, Search } from 'lucide-react'
import { Spinner, Tooltip, TooltipTrigger, TooltipContent } from '@craft-agent/ui'
import { cn } from '@/lib/utils'
import { EntityRow } from '@/components/ui/entity-row'
import { EntityList } from '@/components/ui/entity-list'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from '@/components/ui/empty'
import { useMenuComponents } from '@/components/ui/menu-context'
import { useEntityListInteractions } from '@/hooks/useEntityListInteractions'
import type { ComponentEntry } from './types'
import type { SessionMeta } from '@/atoms/sessions'

// ============================================================================
// Mock Icons (simple colored squares to avoid IPC-dependent avatars)
// ============================================================================

function MockAvatar({ icon: Icon, color, label }: { icon: React.ComponentType<{ className?: string }>; color: string; label: string }) {
  return (
    <div
      className="w-5 h-5 rounded-[4px] ring-1 ring-border/30 shrink-0 flex items-center justify-center bg-muted"
      title={label}
    >
      <Icon className={cn("w-3 h-3", color)} />
    </div>
  )
}

// ============================================================================
// Badge Primitives
// ============================================================================

function TypeBadge({ label, colorClass }: { label: string; colorClass: string }) {
  return (
    <span className={cn("shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded", colorClass)}>
      {label}
    </span>
  )
}

function StatusBadge({ label, colorClass }: { label: string; colorClass: string }) {
  return (
    <span className={cn("shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded cursor-default", colorClass)}>
      {label}
    </span>
  )
}

// ============================================================================
// Sample Session Data
// ============================================================================

interface MockSessionStatus {
  id: string
  label: string
  color: string
  icon: React.ReactNode
}

const mockStatuses: MockSessionStatus[] = [
  { id: 'todo', label: 'Todo', color: 'var(--muted-foreground)', icon: <Circle className="h-3.5 w-3.5" strokeWidth={1.5} /> },
  { id: 'in-progress', label: 'In Progress', color: 'var(--info)', icon: <Circle className="h-3.5 w-3.5" strokeWidth={1.5} /> },
  { id: 'done', label: 'Done', color: 'var(--success)', icon: <Circle className="h-3.5 w-3.5" strokeWidth={1.5} /> },
]

const sampleSessions: (SessionMeta & { _status: MockSessionStatus })[] = [
  {
    id: 'session-1',
    name: 'Fix authentication bug in login flow',
    workspaceId: 'ws-1',
    lastMessageAt: Date.now() - 1000 * 60 * 5,
    sessionStatus: 'in-progress',
    hasUnread: true,
    isFlagged: true,
    _status: mockStatuses[1],
  },
  {
    id: 'session-2',
    name: 'Implement search functionality across sessions',
    workspaceId: 'ws-1',
    lastMessageAt: Date.now() - 1000 * 60 * 30,
    sessionStatus: 'todo',
    labels: ['feature', 'priority::high'],
    _status: mockStatuses[0],
  },
  {
    id: 'session-3',
    name: 'Review pull request #42',
    workspaceId: 'ws-1',
    lastMessageAt: Date.now() - 1000 * 60 * 60,
    sessionStatus: 'done',
    isProcessing: true,
    _status: mockStatuses[2],
  },
  {
    id: 'session-4',
    name: 'Debug API response handling and error states',
    workspaceId: 'ws-1',
    lastMessageAt: Date.now() - 1000 * 60 * 60 * 2,
    sessionStatus: 'todo',
    _status: mockStatuses[0],
  },
]

// ============================================================================
// Sample Source Data
// ============================================================================

interface MockSource {
  id: string
  name: string
  type: 'mcp' | 'api' | 'local'
  tagline: string
  status: 'connected' | 'needs_auth' | 'failed' | 'untested'
  icon: React.ComponentType<{ className?: string }>
}

const sampleSources: MockSource[] = [
  { id: 'github', name: 'GitHub', type: 'mcp', tagline: 'Repositories, issues, and pull requests', status: 'connected', icon: Globe },
  { id: 'linear', name: 'Linear', type: 'api', tagline: 'Issue tracking and project management', status: 'connected', icon: Globe },
  { id: 'slack', name: 'Slack', type: 'mcp', tagline: 'Channels, messages, and search', status: 'needs_auth', icon: Globe },
  { id: 'local-files', name: 'Project Files', type: 'local', tagline: '~/Documents/projects', status: 'connected', icon: HardDrive },
  { id: 'stripe', name: 'Stripe', type: 'api', tagline: 'Payments and subscriptions', status: 'untested', icon: Globe },
]

// ============================================================================
// Sample Skill Data
// ============================================================================

interface MockSkill {
  id: string
  name: string
  description: string
  icon?: string // emoji
}

const sampleSkills: MockSkill[] = [
  { id: 'commit', name: 'Commit', description: 'Create well-structured git commits with conventional messages', icon: '📝' },
  { id: 'review-pr', name: 'Review PR', description: 'Thorough code review with security and performance analysis', icon: '🔍' },
  { id: 'refactor', name: 'Refactor', description: 'Safely restructure code while preserving behavior' },
  { id: 'test', name: 'Write Tests', description: 'Generate comprehensive unit and integration tests', icon: '🧪' },
]

// ============================================================================
// Relative Time Formatter
// ============================================================================

function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

// ============================================================================
// Source Type Badge Config
// ============================================================================

const SOURCE_TYPE_CONFIG: Record<string, { label: string; colorClass: string }> = {
  mcp: { label: 'MCP', colorClass: 'bg-accent/10 text-accent' },
  api: { label: 'API', colorClass: 'bg-success/10 text-success' },
  local: { label: 'Local', colorClass: 'bg-info/10 text-info' },
}

const SOURCE_STATUS_CONFIG: Record<string, { label: string; colorClass: string } | null> = {
  connected: null,
  needs_auth: { label: 'Auth Required', colorClass: 'bg-warning/10 text-warning' },
  failed: { label: 'Disconnected', colorClass: 'bg-destructive/10 text-destructive' },
  untested: { label: 'Not Tested', colorClass: 'bg-foreground/10 text-foreground/50' },
}

// ============================================================================
// Mock Menu Content (minimal, just for visual)
// ============================================================================

function MockMenuItems() {
  const { MenuItem, Separator } = useMenuComponents()
  return (
    <>
      <MenuItem onClick={() => console.log('[Playground] Open in New Window')}>Open in New Window</MenuItem>
      <MenuItem onClick={() => console.log('[Playground] Show in Finder')}>Show in Finder</MenuItem>
      <Separator />
      <MenuItem variant="destructive" onClick={() => console.log('[Playground] Delete')}>Delete</MenuItem>
    </>
  )
}

// ============================================================================
// Preview: EntityRow with all slots
// ============================================================================

interface EntityRowPreviewProps {
  title?: string
  subtitle?: string
  showIcon?: boolean
  showBadges?: boolean
  showTrailing?: boolean
  showMenu?: boolean
  isSelected?: boolean
  isInMultiSelect?: boolean
  showSeparator?: boolean
}

function EntityRowPreview({
  title = 'Sample Entity',
  subtitle = 'A short description',
  showIcon = true,
  showBadges = true,
  showTrailing = false,
  showMenu = true,
  isSelected = false,
  isInMultiSelect = false,
  showSeparator = false,
}: EntityRowPreviewProps) {
  return (
    <div className="w-[320px] border border-border rounded-lg overflow-hidden bg-background py-2">
      <EntityRow
        icon={showIcon ? <MockAvatar icon={Zap} color="text-accent" label="Entity" /> : undefined}
        title={title}
        badges={showBadges ? (
          <>
            <TypeBadge label="MCP" colorClass="bg-accent/10 text-accent" />
            <span className="truncate">{subtitle}</span>
          </>
        ) : subtitle ? <span className="truncate text-xs text-foreground/70">{subtitle}</span> : undefined}
        trailing={showTrailing ? <span className="text-[11px] text-foreground/40">3m</span> : undefined}
        isSelected={isSelected}
        isInMultiSelect={isInMultiSelect}
        showSeparator={showSeparator}
        menuContent={showMenu ? <MockMenuItems /> : undefined}
      />
    </div>
  )
}

// ============================================================================
// Preview: Session Rows via EntityRow
// ============================================================================

interface SessionEntityListPreviewProps {
  selectedIndex?: number
  showMultiSelect?: boolean
}

function SessionEntityListPreview({
  selectedIndex = 0,
  showMultiSelect = false,
}: SessionEntityListPreviewProps) {
  return (
    <div className="w-[320px] h-[480px] flex flex-col border border-border rounded-lg overflow-hidden bg-background">
      <EntityList
        items={sampleSessions}
        getKey={(s) => s.id}
        renderItem={(session, index, isFirst) => {
          const isSelected = index === selectedIndex
          return (
            <EntityRow
              icon={
                <div
                  className="w-4 h-4 flex items-center justify-center [&>svg]:w-full [&>svg]:h-full"
                  style={{ color: session._status.color }}
                >
                  {session._status.icon}
                </div>
              }
              title={session.name || 'Untitled'}
              badges={
                <>
                  {session.isProcessing && (
                    <Spinner className="text-[8px] text-foreground shrink-0" />
                  )}
                  {!session.isProcessing && session.hasUnread && (
                    <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded bg-accent text-white">
                      New
                    </span>
                  )}
                  <div
                    className="flex-1 flex items-center gap-1 min-w-0 overflow-x-auto scrollbar-hide pr-4"
                    style={{ maskImage: 'linear-gradient(to right, black calc(100% - 16px), transparent 100%)', WebkitMaskImage: 'linear-gradient(to right, black calc(100% - 16px), transparent 100%)' }}
                  >
                    {session.isFlagged && (
                      <span className="shrink-0 h-[18px] w-[18px] flex items-center justify-center rounded bg-foreground/5">
                        <Flag className="h-[10px] w-[10px] text-info fill-info" />
                      </span>
                    )}
                    {session.labels?.map((label, i) => (
                      <span
                        key={i}
                        className="shrink-0 h-[18px] max-w-[120px] px-1.5 text-[10px] font-medium rounded flex items-center whitespace-nowrap"
                        style={{
                          backgroundColor: 'rgba(var(--foreground-rgb), 0.05)',
                          color: 'rgba(var(--foreground-rgb), 0.8)',
                        }}
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                </>
              }
              trailing={
                session.lastMessageAt ? (
                  <span className="shrink-0 text-[11px] text-foreground/40 whitespace-nowrap">
                    {formatRelativeTime(session.lastMessageAt)}
                  </span>
                ) : undefined
              }
              isSelected={isSelected}
              isInMultiSelect={showMultiSelect && (index === 0 || index === 1)}
              showSeparator={!isFirst}
              menuContent={<MockMenuItems />}
              dataAttributes={{ 'data-session-id': session.id }}
            />
          )
        }}
      />
    </div>
  )
}

// ============================================================================
// Preview: Source Rows via EntityRow
// ============================================================================

interface SourceEntityListPreviewProps {
  selectedIndex?: number
  typeFilter?: string
}

function SourceEntityListPreview({
  selectedIndex = -1,
  typeFilter = 'all',
}: SourceEntityListPreviewProps) {
  const filtered = typeFilter === 'all'
    ? sampleSources
    : sampleSources.filter(s => s.type === typeFilter)

  return (
    <div className="w-[320px] h-[480px] flex flex-col border border-border rounded-lg overflow-hidden bg-background">
      <EntityList
        items={filtered}
        getKey={(s) => s.id}
        emptyState={
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon"><DatabaseZap /></EmptyMedia>
              <EmptyTitle>No sources configured</EmptyTitle>
              <EmptyDescription>Sources connect your agent to external data.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        }
        renderItem={(source, index, isFirst) => {
          const typeConfig = SOURCE_TYPE_CONFIG[source.type]
          const statusConfig = SOURCE_STATUS_CONFIG[source.status]
          return (
            <EntityRow
              icon={<MockAvatar icon={source.icon} color="text-muted-foreground" label={source.name} />}
              title={source.name}
              badges={
                <>
                  {typeConfig && <TypeBadge label={typeConfig.label} colorClass={typeConfig.colorClass} />}
                  {statusConfig && <StatusBadge label={statusConfig.label} colorClass={statusConfig.colorClass} />}
                  <span className="truncate">{source.tagline}</span>
                </>
              }
              isSelected={index === selectedIndex}
              showSeparator={!isFirst}
              menuContent={<MockMenuItems />}
            />
          )
        }}
      />
    </div>
  )
}

// ============================================================================
// Preview: Skill Rows via EntityRow
// ============================================================================

interface SkillEntityListPreviewProps {
  selectedIndex?: number
}

function SkillEntityListPreview({
  selectedIndex = -1,
}: SkillEntityListPreviewProps) {
  return (
    <div className="w-[320px] h-[480px] flex flex-col border border-border rounded-lg overflow-hidden bg-background">
      <EntityList
        items={sampleSkills}
        getKey={(s) => s.id}
        emptyState={
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon"><Zap /></EmptyMedia>
              <EmptyTitle>No skills configured</EmptyTitle>
              <EmptyDescription>Skills teach your agent specialized behaviors.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        }
        renderItem={(skill, index, isFirst) => (
          <EntityRow
            icon={
              skill.icon ? (
                <div className="w-5 h-5 rounded-[4px] ring-1 ring-border/30 shrink-0 flex items-center justify-center bg-muted text-sm leading-none">
                  {skill.icon}
                </div>
              ) : (
                <MockAvatar icon={Zap} color="text-muted-foreground" label={skill.name} />
              )
            }
            title={skill.name}
            badges={<span className="truncate">{skill.description}</span>}
            isSelected={index === selectedIndex}
            showSeparator={!isFirst}
            menuContent={<MockMenuItems />}
          />
        )}
      />
    </div>
  )
}

// ============================================================================
// Preview: Mixed Entity List (all three types grouped)
// ============================================================================

interface MixedEntityListPreviewProps {
  showGroups?: boolean
  selectedIndex?: number
  showEmpty?: boolean
}

type MixedEntity =
  | { kind: 'session'; data: typeof sampleSessions[0] }
  | { kind: 'source'; data: MockSource }
  | { kind: 'skill'; data: MockSkill }

function MixedEntityListPreview({
  showGroups = true,
  selectedIndex = -1,
  showEmpty = false,
}: MixedEntityListPreviewProps) {
  if (showEmpty) {
    return (
      <div className="w-[320px] h-[480px] flex flex-col border border-border rounded-lg overflow-hidden bg-background">
        <EntityList
          items={[]}
          getKey={() => ''}
          renderItem={() => null}
          emptyState={
            <Empty className="flex-1">
              <EmptyHeader>
                <EmptyMedia variant="icon"><DatabaseZap /></EmptyMedia>
                <EmptyTitle>Nothing here yet</EmptyTitle>
                <EmptyDescription>Add sessions, sources, or skills to get started.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          }
        />
      </div>
    )
  }

  // Build flat or grouped items
  const allItems: MixedEntity[] = [
    ...sampleSessions.slice(0, 2).map(s => ({ kind: 'session' as const, data: s })),
    ...sampleSources.slice(0, 2).map(s => ({ kind: 'source' as const, data: s })),
    ...sampleSkills.slice(0, 2).map(s => ({ kind: 'skill' as const, data: s })),
  ]

  const getKey = (item: MixedEntity) => `${item.kind}-${item.data.id}`

  let flatIndex = -1
  const renderItem = (item: MixedEntity, index: number, isFirst: boolean) => {
    flatIndex++
    const currentFlatIndex = flatIndex
    switch (item.kind) {
      case 'session': {
        const session = item.data
        return (
          <EntityRow
            icon={
              <div className="w-4 h-4 flex items-center justify-center [&>svg]:w-full [&>svg]:h-full" style={{ color: session._status.color }}>
                {session._status.icon}
              </div>
            }
            title={session.name || 'Untitled'}
            badges={
              <>
                {session.hasUnread && <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded bg-accent text-white">New</span>}
                {session.isFlagged && (
                  <span className="shrink-0 h-[18px] w-[18px] flex items-center justify-center rounded bg-foreground/5">
                    <Flag className="h-[10px] w-[10px] text-info fill-info" />
                  </span>
                )}
              </>
            }
            trailing={session.lastMessageAt ? <span className="text-[11px] text-foreground/40">{formatRelativeTime(session.lastMessageAt)}</span> : undefined}
            isSelected={currentFlatIndex === selectedIndex}
            showSeparator={!isFirst}
            menuContent={<MockMenuItems />}
          />
        )
      }
      case 'source': {
        const source = item.data
        const typeConfig = SOURCE_TYPE_CONFIG[source.type]
        const statusConfig = SOURCE_STATUS_CONFIG[source.status]
        return (
          <EntityRow
            icon={<MockAvatar icon={source.icon} color="text-muted-foreground" label={source.name} />}
            title={source.name}
            badges={
              <>
                {typeConfig && <TypeBadge label={typeConfig.label} colorClass={typeConfig.colorClass} />}
                {statusConfig && <StatusBadge label={statusConfig.label} colorClass={statusConfig.colorClass} />}
                <span className="truncate">{source.tagline}</span>
              </>
            }
            isSelected={currentFlatIndex === selectedIndex}
            showSeparator={!isFirst}
            menuContent={<MockMenuItems />}
          />
        )
      }
      case 'skill': {
        const skill = item.data
        return (
          <EntityRow
            icon={
              skill.icon ? (
                <div className="w-5 h-5 rounded-[4px] ring-1 ring-border/30 shrink-0 flex items-center justify-center bg-muted text-sm leading-none">
                  {skill.icon}
                </div>
              ) : (
                <MockAvatar icon={Zap} color="text-muted-foreground" label={skill.name} />
              )
            }
            title={skill.name}
            badges={<span className="truncate">{skill.description}</span>}
            isSelected={currentFlatIndex === selectedIndex}
            showSeparator={!isFirst}
            menuContent={<MockMenuItems />}
          />
        )
      }
    }
  }

  if (showGroups) {
    const groups = [
      { key: 'sessions', label: 'Sessions', items: allItems.filter(i => i.kind === 'session') },
      { key: 'sources', label: 'Sources', items: allItems.filter(i => i.kind === 'source') },
      { key: 'skills', label: 'Skills', items: allItems.filter(i => i.kind === 'skill') },
    ]

    // Reset flatIndex for grouped rendering
    flatIndex = -1

    return (
      <div className="w-[320px] h-[480px] flex flex-col border border-border rounded-lg overflow-hidden bg-background">
        <EntityList
          groups={groups}
          getKey={getKey}
          renderItem={renderItem}
        />
      </div>
    )
  }

  flatIndex = -1
  return (
    <div className="w-[320px] h-[480px] flex flex-col border border-border rounded-lg overflow-hidden bg-background">
      <EntityList
        items={allItems}
        getKey={getKey}
        renderItem={renderItem}
      />
    </div>
  )
}

// ============================================================================
// Interactive Demo: keyboard nav + multi-select + search
// ============================================================================

type AnyMockEntity =
  | { kind: 'session'; id: string; name: string; status: MockSessionStatus; hasUnread?: boolean; isFlagged?: boolean; lastMessageAt?: number }
  | { kind: 'source'; id: string; name: string; type: string; tagline: string; status: string; icon: React.ComponentType<{ className?: string }> }
  | { kind: 'skill'; id: string; name: string; description: string; emoji?: string }

const interactiveItems: AnyMockEntity[] = [
  // Sessions
  ...sampleSessions.map(s => ({
    kind: 'session' as const,
    id: s.id,
    name: s.name || 'Untitled',
    status: s._status,
    hasUnread: s.hasUnread,
    isFlagged: s.isFlagged,
    lastMessageAt: s.lastMessageAt,
  })),
  // Sources
  ...sampleSources.map(s => ({
    kind: 'source' as const,
    id: s.id,
    name: s.name,
    type: s.type,
    tagline: s.tagline,
    status: s.status,
    icon: s.icon,
  })),
  // Skills
  ...sampleSkills.map(s => ({
    kind: 'skill' as const,
    id: s.id,
    name: s.name,
    description: s.description,
    emoji: s.icon,
  })),
]

interface InteractiveEntityListPreviewProps {
  enableSearch?: boolean
  enableMultiSelect?: boolean
  enableKeyboard?: boolean
}

function InteractiveEntityListPreview({
  enableSearch = true,
  enableMultiSelect = true,
  enableKeyboard = true,
}: InteractiveEntityListPreviewProps) {
  const [query, setQuery] = useState('')
  const [activatedItem, setActivatedItem] = useState<string | null>(null)

  const { items, listProps, getRowProps, searchInputProps, keyboard, selection } = useEntityListInteractions({
    items: interactiveItems,
    getId: (item) => item.id,
    keyboard: enableKeyboard ? {
      onActivate: (item) => {
        setActivatedItem(item.name)
        setTimeout(() => setActivatedItem(null), 1500)
      },
      virtualFocus: enableSearch && query.length > 0,
    } : undefined,
    multiSelect: enableMultiSelect,
    search: enableSearch ? {
      query,
      fn: (item, q) => item.name.toLowerCase().includes(q.toLowerCase()),
    } : undefined,
  })

  const renderEntityRow = (item: AnyMockEntity, index: number, isFirst: boolean) => {
    const rowProps = getRowProps(item, index)

    switch (item.kind) {
      case 'session': {
        return (
          <EntityRow
            {...rowProps}
            icon={
              <div className="w-4 h-4 flex items-center justify-center [&>svg]:w-full [&>svg]:h-full" style={{ color: item.status.color }}>
                {item.status.icon}
              </div>
            }
            title={item.name}
            badges={
              <>
                {item.hasUnread && <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded bg-accent text-white">New</span>}
                {item.isFlagged && (
                  <span className="shrink-0 h-[18px] w-[18px] flex items-center justify-center rounded bg-foreground/5">
                    <Flag className="h-[10px] w-[10px] text-info fill-info" />
                  </span>
                )}
              </>
            }
            trailing={item.lastMessageAt ? <span className="text-[11px] text-foreground/40">{formatRelativeTime(item.lastMessageAt)}</span> : undefined}
            showSeparator={!isFirst}
            menuContent={<MockMenuItems />}
          />
        )
      }
      case 'source': {
        const typeConfig = SOURCE_TYPE_CONFIG[item.type]
        const statusConfig = SOURCE_STATUS_CONFIG[item.status]
        return (
          <EntityRow
            {...rowProps}
            icon={<MockAvatar icon={item.icon} color="text-muted-foreground" label={item.name} />}
            title={item.name}
            badges={
              <>
                {typeConfig && <TypeBadge label={typeConfig.label} colorClass={typeConfig.colorClass} />}
                {statusConfig && <StatusBadge label={statusConfig.label} colorClass={statusConfig.colorClass} />}
                <span className="truncate">{item.tagline}</span>
              </>
            }
            showSeparator={!isFirst}
            menuContent={<MockMenuItems />}
          />
        )
      }
      case 'skill': {
        return (
          <EntityRow
            {...rowProps}
            icon={
              item.emoji ? (
                <div className="w-5 h-5 rounded-[4px] ring-1 ring-border/30 shrink-0 flex items-center justify-center bg-muted text-sm leading-none">
                  {item.emoji}
                </div>
              ) : (
                <MockAvatar icon={Zap} color="text-muted-foreground" label={item.name} />
              )
            }
            title={item.name}
            badges={<span className="truncate">{item.description}</span>}
            showSeparator={!isFirst}
            menuContent={<MockMenuItems />}
          />
        )
      }
    }
  }

  return (
    <div className="w-[340px] flex flex-col gap-3">
      {/* Status bar */}
      <div className="flex items-center gap-2 text-xs text-foreground/50 px-1">
        <span>{items.length} items</span>
        {selection.isMultiSelectActive && (
          <>
            <span className="text-foreground/20">|</span>
            <span className="text-accent">{selection.selectedIds.size} selected</span>
            <button
              className="text-accent hover:underline cursor-pointer"
              onClick={selection.clear}
            >
              Clear
            </button>
          </>
        )}
        {activatedItem && (
          <>
            <span className="text-foreground/20">|</span>
            <span className="text-success animate-in fade-in">Activated: {activatedItem}</span>
          </>
        )}
      </div>

      {/* List */}
      <div className="h-[520px] flex flex-col border border-border rounded-lg overflow-hidden bg-background">
        <EntityList
          {...listProps}
          items={items}
          getKey={(item) => item.id}
          header={enableSearch ? (
            <div className="px-3 py-2 border-b border-border">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-foreground/40" />
                <input
                  className="w-full h-8 pl-8 pr-3 text-sm bg-foreground/3 rounded-md border border-transparent focus:border-border focus:outline-none placeholder:text-foreground/30"
                  placeholder="Search entities..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  {...searchInputProps}
                />
              </div>
            </div>
          ) : undefined}
          emptyState={
            <Empty className="flex-1">
              <EmptyHeader>
                <EmptyMedia variant="icon"><Search /></EmptyMedia>
                <EmptyTitle>No results</EmptyTitle>
                <EmptyDescription>Try a different search term.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          }
          renderItem={renderEntityRow}
        />
      </div>

      {/* Instructions */}
      <div className="text-[11px] text-foreground/40 space-y-0.5 px-1">
        {enableKeyboard && <div>Arrow keys to navigate, Enter to activate</div>}
        {enableMultiSelect && <div>Cmd+Click to toggle, Shift+Click to range select</div>}
        {enableSearch && <div>Type in the search box to filter</div>}
      </div>
    </div>
  )
}

// ============================================================================
// Registry Entries
// ============================================================================

export const entityListComponents: ComponentEntry[] = [
  // ---- EntityRow primitive ----
  {
    id: 'entity-row',
    name: 'EntityRow',
    category: 'Entity Lists',
    description: 'Base row primitive with icon, title, badges, trailing, and menu slots',
    component: EntityRowPreview,
    layout: 'centered',
    props: [
      { name: 'title', description: 'Title text', control: { type: 'string', placeholder: 'Entity name...' }, defaultValue: 'Sample Entity' },
      { name: 'subtitle', description: 'Subtitle/description text', control: { type: 'string', placeholder: 'Description...' }, defaultValue: 'A short description' },
      { name: 'showIcon', description: 'Show left icon', control: { type: 'boolean' }, defaultValue: true },
      { name: 'showBadges', description: 'Show badge row (overrides subtitle)', control: { type: 'boolean' }, defaultValue: true },
      { name: 'showTrailing', description: 'Show trailing timestamp', control: { type: 'boolean' }, defaultValue: false },
      { name: 'showMenu', description: 'Show more menu on hover', control: { type: 'boolean' }, defaultValue: true },
      { name: 'isSelected', description: 'Selected state', control: { type: 'boolean' }, defaultValue: false },
      { name: 'isInMultiSelect', description: 'Multi-select state (accent bar)', control: { type: 'boolean' }, defaultValue: false },
      { name: 'showSeparator', description: 'Show separator above', control: { type: 'boolean' }, defaultValue: false },
    ],
    variants: [
      {
        name: 'Minimal',
        description: 'Title only — no icon, badges, or menu',
        props: { showIcon: false, showBadges: false, showMenu: false },
      },
      {
        name: 'Source-like',
        description: 'Icon + type badge + description',
        props: { showIcon: true, showBadges: true, showTrailing: false, showMenu: true },
      },
      {
        name: 'Session-like',
        description: 'Icon + badges + trailing timestamp',
        props: { showIcon: true, showBadges: true, showTrailing: true, showMenu: true },
      },
      {
        name: 'Selected',
        description: 'Selected state with tinted background',
        props: { isSelected: true },
      },
      {
        name: 'Multi-select',
        description: 'Multi-select state with left accent bar',
        props: { isInMultiSelect: true },
      },
    ],
  },

  // ---- Session List (via EntityRow) ----
  {
    id: 'entity-list-sessions',
    name: 'Session List',
    category: 'Entity Lists',
    description: 'Session items composed with EntityRow — status icon, badges, timestamps',
    component: SessionEntityListPreview,
    layout: 'centered',
    props: [
      { name: 'selectedIndex', description: 'Selected session index', control: { type: 'number', min: -1, max: 3, step: 1 }, defaultValue: 0 },
      { name: 'showMultiSelect', description: 'Show multi-select on first two items', control: { type: 'boolean' }, defaultValue: false },
    ],
    variants: [
      {
        name: 'Default',
        description: 'First session selected',
        props: { selectedIndex: 0 },
      },
      {
        name: 'Multi-select',
        description: 'Two sessions in multi-select',
        props: { selectedIndex: 0, showMultiSelect: true },
      },
      {
        name: 'No Selection',
        description: 'No session selected',
        props: { selectedIndex: -1 },
      },
    ],
  },

  // ---- Source List (via EntityRow) ----
  {
    id: 'entity-list-sources',
    name: 'Source List',
    category: 'Entity Lists',
    description: 'Source items composed with EntityRow — type badge, status badge, tagline',
    component: SourceEntityListPreview,
    layout: 'centered',
    props: [
      { name: 'selectedIndex', description: 'Selected source index (-1 for none)', control: { type: 'number', min: -1, max: 4, step: 1 }, defaultValue: -1 },
      {
        name: 'typeFilter',
        description: 'Filter by source type',
        control: {
          type: 'select',
          options: [
            { label: 'All', value: 'all' },
            { label: 'MCP', value: 'mcp' },
            { label: 'API', value: 'api' },
            { label: 'Local', value: 'local' },
          ],
        },
        defaultValue: 'all',
      },
    ],
    variants: [
      {
        name: 'All Sources',
        description: 'All source types shown',
        props: { typeFilter: 'all' },
      },
      {
        name: 'MCP Only',
        description: 'Filtered to MCP sources',
        props: { typeFilter: 'mcp' },
      },
      {
        name: 'With Selection',
        description: 'First source selected',
        props: { selectedIndex: 0 },
      },
    ],
  },

  // ---- Skill List (via EntityRow) ----
  {
    id: 'entity-list-skills',
    name: 'Skill List',
    category: 'Entity Lists',
    description: 'Skill items composed with EntityRow — emoji icon, description',
    component: SkillEntityListPreview,
    layout: 'centered',
    props: [
      { name: 'selectedIndex', description: 'Selected skill index (-1 for none)', control: { type: 'number', min: -1, max: 3, step: 1 }, defaultValue: -1 },
    ],
    variants: [
      {
        name: 'Default',
        description: 'No selection',
        props: { selectedIndex: -1 },
      },
      {
        name: 'With Selection',
        description: 'First skill selected',
        props: { selectedIndex: 0 },
      },
    ],
  },

  // ---- Mixed Entity List (all three grouped) ----
  {
    id: 'entity-list-mixed',
    name: 'Mixed Entity List',
    category: 'Entity Lists',
    description: 'All entity types in one list, demonstrating grouped sections',
    component: MixedEntityListPreview,
    layout: 'centered',
    props: [
      { name: 'showGroups', description: 'Group by entity type', control: { type: 'boolean' }, defaultValue: true },
      { name: 'selectedIndex', description: 'Selected item index (flat, -1 for none)', control: { type: 'number', min: -1, max: 5, step: 1 }, defaultValue: -1 },
      { name: 'showEmpty', description: 'Show empty state', control: { type: 'boolean' }, defaultValue: false },
    ],
    variants: [
      {
        name: 'Grouped',
        description: 'Items grouped by Sessions, Sources, Skills',
        props: { showGroups: true },
      },
      {
        name: 'Flat List',
        description: 'All items in a single flat list',
        props: { showGroups: false },
      },
      {
        name: 'Empty State',
        description: 'No items — shows empty placeholder',
        props: { showEmpty: true },
      },
      {
        name: 'With Selection',
        description: 'Third item selected in grouped view',
        props: { showGroups: true, selectedIndex: 2 },
      },
    ],
  },

  // ---- Interactive Entity List (keyboard + multi-select + search) ----
  {
    id: 'entity-list-interactive',
    name: 'Interactive Entity List',
    category: 'Entity Lists',
    description: 'Full interactive demo — keyboard nav, multi-select, search filtering via useEntityListInteractions',
    component: InteractiveEntityListPreview,
    layout: 'centered',
    props: [
      { name: 'enableSearch', description: 'Enable search filtering', control: { type: 'boolean' }, defaultValue: true },
      { name: 'enableMultiSelect', description: 'Enable Cmd+Click / Shift+Click multi-select', control: { type: 'boolean' }, defaultValue: true },
      { name: 'enableKeyboard', description: 'Enable arrow key navigation', control: { type: 'boolean' }, defaultValue: true },
    ],
    variants: [
      {
        name: 'Full Interactive',
        description: 'All interactions enabled — search, keyboard, multi-select',
        props: { enableSearch: true, enableMultiSelect: true, enableKeyboard: true },
      },
      {
        name: 'Search Only',
        description: 'Just search filtering, no keyboard or multi-select',
        props: { enableSearch: true, enableMultiSelect: false, enableKeyboard: false },
      },
      {
        name: 'Keyboard Only',
        description: 'Arrow keys + Enter, no search or multi-select',
        props: { enableSearch: false, enableMultiSelect: false, enableKeyboard: true },
      },
      {
        name: 'Multi-select Only',
        description: 'Click-based multi-select, no search or keyboard',
        props: { enableSearch: false, enableMultiSelect: true, enableKeyboard: false },
      },
    ],
  },
]
