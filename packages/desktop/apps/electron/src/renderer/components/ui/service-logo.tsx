/**
 * ServiceLogo - Displays a logo for an MCP server or API
 *
 * Uses CrossfadeAvatar to show a smooth transition from fallback to logo.
 * Logo URLs are Google Favicon URLs - browser handles caching.
 */

import * as React from 'react'
import { CrossfadeAvatar } from '@/components/ui/avatar'

interface ServiceLogoProps {
  logo?: string | null  // Google Favicon URL
  name: string
  fallbackIcon: React.ReactNode
  className?: string
}

export function ServiceLogo({
  logo,
  name,
  fallbackIcon,
  className = "h-6 w-6 rounded-md ring-1 ring-border/30"
}: ServiceLogoProps) {
  return (
    <CrossfadeAvatar
      src={logo}
      alt={name}
      className={className}
      fallbackClassName="bg-muted"
      fallback={fallbackIcon}
    />
  )
}
