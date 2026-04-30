import type { SVGProps } from "react"

/**
 * Todo State Icons - SF Symbols / Linear inspired
 * Used for todo filter dropdown in session list
 */

/**
 * CircleDashed - Empty circle with dashed stroke (Todo/Not started)
 * Inspired by SF Symbol "circle.dashed"
 */
export function CircleDashed(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <circle cx="12" cy="12" r="9" strokeDasharray="4 3" />
    </svg>
  )
}

/**
 * CalendarClock - Calendar with clock indicator (Planned/Scheduled)
 * Inspired by SF Symbol "calendar.badge.clock"
 */
export function CalendarClock(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {/* Calendar base */}
      <rect x="3" y="4" width="14" height="16" rx="2" />
      <path d="M7 2v4" />
      <path d="M13 2v4" />
      <path d="M3 9h14" />
      {/* Clock badge */}
      <circle cx="18" cy="17" r="4" fill="currentColor" stroke="none" />
      <path d="M18 15v2l1 1" stroke="var(--background, white)" strokeWidth="1.5" />
    </svg>
  )
}

/**
 * CircleDot - Circle with dot in center (Needs Review)
 * Inspired by SF Symbol "circle.circle" / target icon
 */
export function CircleEye(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <circle cx="12" cy="12" r="9" />
      {/* Center dot */}
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
    </svg>
  )
}

/**
 * CircleHalfFilled - Half-filled circle (In Progress)
 * Inspired by SF Symbol "circle.lefthalf.filled" and Linear's in-progress icon
 */
export function CircleProgress(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <circle cx="12" cy="12" r="9" />
      {/* Half fill on the left side */}
      <path
        d="M12 3a9 9 0 0 0 0 18"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  )
}

/**
 * CircleCheck - Filled circle with checkmark (Completed)
 * Inspired by SF Symbol "checkmark.circle.fill" and Linear's done icon
 */
export function CircleCheckFilled(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      {...props}
    >
      <circle cx="12" cy="12" r="10" />
      <path
        d="M8 12l3 3 5-5"
        fill="none"
        stroke="var(--background, white)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * CircleXFilled - Filled circle with X mark (Cancelled)
 * Inspired by SF Symbol "xmark.circle.fill" and Linear's cancelled icon
 */
export function CircleXFilled(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      {...props}
    >
      <circle cx="12" cy="12" r="10" />
      <path
        d="M9 9l6 6M15 9l-6 6"
        fill="none"
        stroke="var(--background, white)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * FilterLines - Horizontal filter lines icon (for "All" state)
 * Inspired by SF Symbol "line.3.horizontal.decrease"
 */
export function FilterLines(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="6" y1="12" x2="18" y2="12" />
      <line x1="9" y1="18" x2="15" y2="18" />
    </svg>
  )
}
