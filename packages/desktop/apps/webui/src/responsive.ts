/**
 * responsive.ts — Thin mobile detection for webui
 *
 * Layout responsiveness is now handled by container queries and isAutoCompact
 * in the shared electron renderer components. This module only provides
 * viewport-level mobile detection for the few places that need it
 * (touch events, virtual keyboard handling, safe-area insets).
 */

import { useState, useEffect } from 'react'

const MOBILE_MEDIA_QUERY = '(max-width: 768px)'

/**
 * Hook that returns true when viewport is at mobile width.
 *
 * Use sparingly — prefer container queries (@container) for layout decisions.
 * This is for viewport-level concerns like touch handling and virtual keyboard.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => {
    return typeof window !== 'undefined'
      ? window.matchMedia(MOBILE_MEDIA_QUERY).matches
      : false
  })

  useEffect(() => {
    const media = window.matchMedia(MOBILE_MEDIA_QUERY)
    const onChange = () => setIsMobile(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  return isMobile
}
