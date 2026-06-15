/**
 * DiffIcons - SVG icons for diff viewer controls
 *
 * Icons sourced from diffs.com for visual consistency with @pierre/diffs
 */

import * as React from 'react'

interface IconProps {
  className?: string
}

/**
 * Split view icon - shows two panels side by side
 * Used when currently in unified mode, click to switch to split
 */
export function DiffSplitIcon({ className }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      className={className}
    >
      <path d="M14 0H8.5v16H14a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2m-1.5 6.5v1h1a.5.5 0 0 1 0 1h-1v1a.5.5 0 0 1-1 0v-1h-1a.5.5 0 0 1 0-1h1v-1a.5.5 0 0 1 1 0" />
      <path
        d="M2 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5.5V0zm.5 7.5h3a.5.5 0 0 1 0 1h-3a.5.5 0 0 1 0-1"
        opacity="0.3"
      />
    </svg>
  )
}

/**
 * Unified view icon - shows stacked panels (additions below deletions)
 * Used when currently in split mode, click to switch to unified
 */
export function DiffUnifiedIcon({ className }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      className={className}
    >
      <path
        fillRule="evenodd"
        d="M16 14a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V8.5h16zm-8-4a.5.5 0 0 0-.5.5v1h-1a.5.5 0 0 0 0 1h1v1a.5.5 0 0 0 1 0v-1h1a.5.5 0 0 0 0-1h-1v-1A.5.5 0 0 0 8 10"
        clipRule="evenodd"
      />
      <path
        fillRule="evenodd"
        d="M14 0a2 2 0 0 1 2 2v5.5H0V2a2 2 0 0 1 2-2zM6.5 3.5a.5.5 0 0 0 0 1h3a.5.5 0 0 0 0-1z"
        clipRule="evenodd"
        opacity="0.4"
      />
    </svg>
  )
}

/**
 * Background toggle icon - lines with a highlighted box in the middle
 * Toggles background highlighting on changed lines
 */
export function DiffBackgroundIcon({ className }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      className={className}
    >
      <path
        d="M0 2.25a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H.75A.75.75 0 0 1 0 2.25"
        opacity="0.4"
      />
      <path
        fillRule="evenodd"
        d="M15 5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H1a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM2.5 9a.5.5 0 0 0 0 1h8a.5.5 0 0 0 0-1zm0-2a.5.5 0 0 0 0 1h11a.5.5 0 0 0 0-1z"
        clipRule="evenodd"
      />
      <path
        d="M0 14.75A.75.75 0 0 1 .75 14h5.5a.75.75 0 0 1 0 1.5H.75a.75.75 0 0 1-.75-.75"
        opacity="0.4"
      />
    </svg>
  )
}
