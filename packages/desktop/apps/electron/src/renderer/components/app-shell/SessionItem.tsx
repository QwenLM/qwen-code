import { Flag, ShieldAlert } from 'lucide-react'
import { useActionLabel } from '@/actions'
import { cn } from '@/lib/utils'
import { rendererPerf } from '@/lib/perf'
import { Spinner } from '@craft-agent/ui'
import { EntityRow } from '@/components/ui/entity-row'
import { EntityListBadge } from '@/components/ui/entity-list-badge'
import { SessionMenu } from './SessionMenu'
import { BatchSessionMenu } from './BatchSessionMenu'
import { SessionStatusIcon } from './SessionStatusIcon'
import { SessionBadges } from './SessionBadges'
import {
  getSessionTitle,
  getSessionPreviewText,
  highlightMatch,
  hasUnreadMeta,
  formatSessionRelativeTime,
} from '@/utils/session'
import { useSessionListContext } from '@/context/SessionListContext'
import { useAppShellContext } from '@/context/AppShellContext'
import { navigate, routes } from '@/lib/navigate'
import type { SessionMeta } from '@/atoms/sessions'
import { messagingBindingsBySessionAtom } from '@/atoms/messaging'
import { useAtomValue } from 'jotai'
import { extractLabelId } from '@craft-agent/shared/labels'
import { FEATURE_FLAGS } from '@craft-agent/shared/feature-flags'

const PLATFORM_PILL: Record<
  'telegram' | 'whatsapp',
  { label: string; colorClass: string }
> = {
  telegram: {
    label: 'Telegram',
    colorClass:
      'bg-sky-500/10 text-sky-600 dark:bg-sky-400/15 dark:text-sky-300',
  },
  whatsapp: {
    label: 'WhatsApp',
    colorClass:
      'bg-emerald-500/10 text-emerald-600 dark:bg-emerald-400/15 dark:text-emerald-300',
  },
}

export interface SessionItemProps {
  item: SessionMeta
  index: number
  itemProps: Record<string, unknown>
  isSelected: boolean
  isFirstInGroup: boolean
  isInMultiSelect: boolean
  onSelect: () => void
  onToggleSelect?: () => void
  onRangeSelect?: () => void
}

export function SessionItem({
  item,
  itemProps,
  isSelected,
  isFirstInGroup,
  isInMultiSelect,
  onSelect,
  onToggleSelect,
  onRangeSelect,
}: SessionItemProps) {
  const ctx = useSessionListContext()
  const { workspaces, isCompactMode } = useAppShellContext()
  const hasRemoteWorkspaces = workspaces?.some((w) => w.remoteServer) ?? false
  const { hotkey: nextHotkey } = useActionLabel('chat.nextSearchMatch')
  const { hotkey: prevHotkey } = useActionLabel('chat.prevSearchMatch')
  const title = getSessionTitle(item)
  // For the active session, prefer logical match count over ripgrep count
  const activeMatch = ctx.activeChatMatchInfo
  const isActiveSession = isSelected && activeMatch?.sessionId === item.id
  const ripgrepMatchCount = ctx.contentSearchResults.get(item.id)?.matchCount
  const chatMatchCount = isActiveSession
    ? activeMatch!.count
    : ripgrepMatchCount
  const hasMatch = chatMatchCount != null && chatMatchCount > 0
  const hasLabels =
    FEATURE_FLAGS.sessionLabelsUi &&
    !!(
      item.labels &&
      item.labels.length > 0 &&
      ctx.flatLabels.length > 0 &&
      item.labels.some((entry) => {
        const labelId = extractLabelId(entry)
        return ctx.flatLabels.some((l) => l.id === labelId)
      })
    )
  const hasPendingPrompt = ctx.hasPendingPrompt?.(item.id) ?? false
  const previewText = isCompactMode ? getSessionPreviewText(item) : null
  const renameTitle = item.name || title
  const messagingBindingsBySession = useAtomValue(
    messagingBindingsBySessionAtom,
  )
  const sessionBindings = messagingBindingsBySession.get(item.id) ?? []
  const hasMessagingBinding = sessionBindings.length > 0

  const handleClick = (e: React.MouseEvent) => {
    ctx.onFocusZone()
    if (e.button === 2) {
      if (ctx.isMultiSelectActive && !isInMultiSelect && onToggleSelect)
        onToggleSelect()
      return
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
      // Cmd+Shift+Click: open session in a new panel
      e.preventDefault()
      navigate(routes.view.allSessions(item.id), { newPanel: true })
      return
    }
    if ((e.metaKey || e.ctrlKey) && onToggleSelect) {
      // Cmd+Click: always toggle multi-select (standard OS behavior)
      e.preventDefault()
      onToggleSelect()
      return
    }
    if (e.shiftKey && onRangeSelect) {
      e.preventDefault()
      onRangeSelect()
      return
    }
    rendererPerf.startSessionSwitch(item.id)
    onSelect()
  }

  return (
    <EntityRow
      className="session-item"
      dataAttributes={{ 'data-session-id': item.id }}
      showSeparator={!isFirstInGroup}
      separatorClassName="pl-[38px] pr-4"
      isSelected={isSelected}
      isInMultiSelect={isInMultiSelect}
      onMouseDown={handleClick}
      buttonProps={{
        ...itemProps,
        onKeyDown: (e: React.KeyboardEvent) => {
          ;(
            itemProps as { onKeyDown: (event: React.KeyboardEvent) => void }
          ).onKeyDown(e)
          ctx.onKeyDown(e, item)
        },
      }}
      menuContent={
        <SessionMenu
          item={item}
          sessionStatuses={ctx.sessionStatuses}
          labels={ctx.labels}
          onLabelsChange={
            ctx.onLabelsChange
              ? (ls) => ctx.onLabelsChange!(item.id, ls)
              : undefined
          }
          onRename={() => ctx.onRenameClick(item.id, renameTitle)}
          onFlag={() => ctx.onFlag?.(item.id)}
          onUnflag={() => ctx.onUnflag?.(item.id)}
          onArchive={() => ctx.onArchive?.(item.id)}
          onUnarchive={() => ctx.onUnarchive?.(item.id)}
          onMarkUnread={() => ctx.onMarkUnread(item.id)}
          onSessionStatusChange={(s) => ctx.onSessionStatusChange(item.id, s)}
          onOpenInNewWindow={() => ctx.onOpenInNewWindow(item)}
          onSendToWorkspace={
            ctx.onSendToWorkspace
              ? () => ctx.onSendToWorkspace!([item.id])
              : undefined
          }
          hasRemoteWorkspaces={hasRemoteWorkspaces}
          onDelete={() => ctx.onDelete(item.id)}
        />
      }
      contextMenuContent={
        ctx.isMultiSelectActive && isInMultiSelect ? (
          <BatchSessionMenu hideMetadataActions />
        ) : (
          <SessionMenu
            item={item}
            hideMetadataActions
            sessionStatuses={ctx.sessionStatuses}
            labels={ctx.labels}
            onLabelsChange={
              ctx.onLabelsChange
                ? (ls) => ctx.onLabelsChange!(item.id, ls)
                : undefined
            }
            onRename={() => ctx.onRenameClick(item.id, renameTitle)}
            onFlag={() => ctx.onFlag?.(item.id)}
            onUnflag={() => ctx.onUnflag?.(item.id)}
            onArchive={() => ctx.onArchive?.(item.id)}
            onUnarchive={() => ctx.onUnarchive?.(item.id)}
            onMarkUnread={() => ctx.onMarkUnread(item.id)}
            onSessionStatusChange={(s) => ctx.onSessionStatusChange(item.id, s)}
            onOpenInNewWindow={() => ctx.onOpenInNewWindow(item)}
            onSendToWorkspace={
              ctx.onSendToWorkspace
                ? () => ctx.onSendToWorkspace!([item.id])
                : undefined
            }
            hasRemoteWorkspaces={hasRemoteWorkspaces}
            onDelete={() => ctx.onDelete(item.id)}
          />
        )
      }
      icon={
        <>
          <SessionStatusIcon item={item} />
          <div
            className={cn(
              'flex items-center justify-center overflow-hidden gap-1',
              'transition-all duration-200 ease-out',
              item.isProcessing ||
                hasUnreadMeta(item) ||
                item.lastMessageRole === 'plan' ||
                hasPendingPrompt
                ? 'opacity-100 ml-0'
                : '!w-0 opacity-0 -ml-[10px]',
            )}
          >
            {item.isProcessing && <Spinner className="text-[10px]" />}
            {hasUnreadMeta(item) && (
              <svg
                className="text-accent h-3.5 w-3.5"
                viewBox="0 0 25 24"
                fill="currentColor"
              >
                <g transform="translate(1.748, 0.7832)">
                  <path
                    fillRule="nonzero"
                    d="M10.9952443,22 C8.89638276,22 7.01311428,21.5426195 5.34543882,20.6278586 C4.85718403,21.0547471 4.29283758,21.3901594 3.65239948,21.6340956 C3.01196138,21.8780319 2.3651823,22 1.71206226,22 C1.5028102,22 1.34111543,21.9466389 1.22697795,21.8399168 C1.11284047,21.7331947 1.05735697,21.6016979 1.06052745,21.4454262 C1.06369794,21.2891545 1.13820435,21.1347886 1.28404669,20.9823285 C1.5693904,20.6621622 1.77547197,20.3400901 1.9022914,20.0161123 C2.02911082,19.6921344 2.09252054,19.3090783 2.09252054,18.8669439 C2.09252054,18.4553015 2.02276985,18.0646223 1.88326848,17.6949064 C1.74376711,17.3251906 1.5693904,16.9383229 1.36013835,16.5343035 C1.15088629,16.1302841 0.941634241,15.6748094 0.732382188,15.1678794 C0.523130134,14.6609494 0.348753423,14.0682606 0.209252054,13.3898129 C0.0697506845,12.7113652 0,11.9147609 0,11 C0,9.40679141 0.271076524,7.93936244 0.813229572,6.5977131 C1.35538262,5.25606376 2.11946966,4.09164934 3.1054907,3.10446985 C4.09151175,2.11729037 5.25507998,1.35308385 6.59619542,0.811850312 C7.93731085,0.270616771 9.40366047,0 10.9952443,0 C12.5868281,0 14.0531777,0.270616771 15.3942931,0.811850312 C16.7354086,1.35308385 17.900562,2.11729037 18.8897536,3.10446985 C19.8789451,4.09164934 20.6446174,5.25606376 21.1867704,6.5977131 C21.7289235,7.93936244 22,9.40679141 22,11 C22,12.5932086 21.7289235,14.0606376 21.1867704,15.4022869 C20.6446174,16.7439362 19.8805303,17.9083507 18.8945093,18.8955301 C17.9084883,19.8827096 16.74492,20.6469161 15.4038046,21.1881497 C14.0626891,21.7293832 12.593169,22 10.9952443,22 Z"
                  />
                </g>
              </svg>
            )}
            {item.lastMessageRole === 'plan' && (
              <svg
                className="text-success h-3.5 w-3.5"
                viewBox="0 0 25 24"
                fill="currentColor"
              >
                <path
                  fillRule="nonzero"
                  d="M13.7207031,22.6523438 C13.264974,22.6523438 12.9361979,22.4895833 12.734375,22.1640625 C12.5325521,21.8385417 12.360026,21.4316406 12.2167969,20.9433594 L10.6640625,15.7871094 C10.5729167,15.4615885 10.5403646,15.1995443 10.5664062,15.0009766 C10.5924479,14.8024089 10.6998698,14.6022135 10.8886719,14.4003906 L20.859375,3.6484375 C20.9179688,3.58984375 20.9472656,3.52473958 20.9472656,3.453125 C20.9472656,3.38151042 20.921224,3.32291667 20.8691406,3.27734375 C20.8170573,3.23177083 20.7568359,3.20735677 20.6884766,3.20410156 C20.6201172,3.20084635 20.5566406,3.22851562 20.4980469,3.28710938 L9.78515625,13.296875 C9.5703125,13.4921875 9.36197917,13.601237 9.16015625,13.6240234 C8.95833333,13.6468099 8.70117188,13.609375 8.38867188,13.5117188 L3.11523438,11.9101562 C2.64648438,11.7669271 2.25911458,11.5960286 1.953125,11.3974609 C1.64713542,11.1988932 1.49414062,10.875 1.49414062,10.4257812 C1.49414062,10.0742188 1.63411458,9.77148438 1.9140625,9.51757812 C2.19401042,9.26367188 2.5390625,9.05859375 2.94921875,8.90234375 L19.7460938,2.46679688 C19.9739583,2.38216146 20.1871745,2.31542969 20.3857422,2.26660156 C20.5843099,2.21777344 20.764974,2.19335938 20.9277344,2.19335938 C21.2467448,2.19335938 21.4973958,2.28450521 21.6796875,2.46679688 C21.8619792,2.64908854 21.953125,2.89973958 21.953125,3.21875 C21.953125,3.38802083 21.9287109,3.5703125 21.8798828,3.765625 C21.8310547,3.9609375 21.7643229,4.17252604 21.6796875,4.40039062 L15.2832031,21.109375 C15.1009115,21.578125 14.8828125,21.952474 14.6289062,22.2324219 C14.375,22.5123698 14.0722656,22.6523438 13.7207031,22.6523438 Z"
                />
              </svg>
            )}
            {hasPendingPrompt && (
              <ShieldAlert className="h-3.5 w-3.5 text-info" />
            )}
          </div>
        </>
      }
      title={ctx.searchQuery ? highlightMatch(title, ctx.searchQuery) : title}
      titleClassName={cn(
        'text-[13px]',
        item.isAsyncOperationOngoing && 'animate-shimmer-text',
      )}
      subtitle={previewText}
      titleSuffix={
        hasMessagingBinding ? (
          <div className="flex items-center gap-1">
            {sessionBindings.map((binding) => {
              const pill =
                PLATFORM_PILL[binding.platform as 'telegram' | 'whatsapp']
              if (!pill) return null
              return (
                <EntityListBadge
                  key={binding.id}
                  variant="text"
                  colorClass={pill.colorClass}
                  tooltip={`Connected to ${pill.label}`}
                >
                  {pill.label}
                </EntityListBadge>
              )
            })}
          </div>
        ) : undefined
      }
      titleTrailing={
        hasMatch ? (
          <span
            className={cn(
              'inline-flex items-center justify-center min-w-[24px] px-1 py-0.5 rounded-[6px] text-[10px] font-medium tabular-nums leading-tight whitespace-nowrap shadow-tinted',
              isSelected
                ? 'bg-yellow-300/50 border border-yellow-500 text-yellow-900'
                : 'bg-yellow-300/10 border border-yellow-600/20 text-yellow-800',
            )}
            style={
              {
                '--shadow-color': isSelected ? '234, 179, 8' : '133, 77, 14',
              } as React.CSSProperties
            }
            title={`Matches found (${nextHotkey} next, ${prevHotkey} prev)`}
          >
            {chatMatchCount}
          </span>
        ) : item.isFlagged ? (
          <div className="p-1 flex items-center justify-center">
            <Flag className="h-3.5 w-3.5 text-info" />
          </div>
        ) : item.lastMessageAt ? (
          <span className="text-[11px] text-foreground/40 whitespace-nowrap">
            {formatSessionRelativeTime(item.lastMessageAt)}
          </span>
        ) : undefined
      }
      badges={hasLabels ? <SessionBadges item={item} /> : undefined}
    />
  )
}
