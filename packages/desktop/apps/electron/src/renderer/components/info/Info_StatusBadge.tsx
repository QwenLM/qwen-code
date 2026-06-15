/**
 * Info_StatusBadge
 *
 * Status badge for permission states using Info_Badge.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Info_Badge, type BadgeColor } from './Info_Badge'

type PermissionStatus = 'allowed' | 'blocked' | 'requires-permission'

const statusColors: Record<PermissionStatus, BadgeColor> = {
  allowed: 'success',
  blocked: 'destructive',
  'requires-permission': 'warning',
}

const statusI18nKeys: Record<PermissionStatus, string> = {
  allowed: 'table.statusAllowed',
  blocked: 'table.statusBlocked',
  'requires-permission': 'table.statusAsk',
}

export interface Info_StatusBadgeProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  /** Status type */
  status?: PermissionStatus | null
  /** Override the default label */
  label?: string
}

export function Info_StatusBadge({
  status,
  label,
  ...props
}: Info_StatusBadgeProps) {
  const { t } = useTranslation()
  const key: PermissionStatus = status ?? 'allowed'
  const displayLabel = label ?? t(statusI18nKeys[key])

  return (
    <Info_Badge {...props} color={statusColors[key]}>
      {displayLabel}
    </Info_Badge>
  )
}
