import type { IconProps } from './types'

/**
 * Custom Folder icon with Lucide-compatible bounds.
 *
 * ADDING NEW ICONS: Ensure paths fill the 2-22 range (Lucide standard).
 * Use strokeWidth={2} to match Lucide visual weight.
 */
export function Icon_Folder({ size, className, ...props }: IconProps) {
  const sizeProps = className ? {} : { width: size ?? 24, height: size ?? 24 }

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...sizeProps}
      {...props}
    >
      <path d="M2.52632 9.88235H21.4737M7.67734 3H6.74984C5.58724 3 5.00595 3 4.53119 3.13676C3.37437 3.46999 2.46999 4.37437 2.13676 5.53119C2 6.00595 2 6.58724 2 7.74984V13C2 16.7712 2 18.6569 3.17157 19.8284C4.34315 21 6.22876 21 10 21H14.3235C17.7811 21 19.5099 21 20.6432 20.0023C20.7704 19.8903 20.8903 19.7704 21.0023 19.6432C22 18.5099 22 16.7811 22 13.3235V12.748C22 9.84284 22 8.39026 21.2812 7.35931C21.0112 6.97215 20.6749 6.63581 20.2878 6.36587C19.2568 5.64706 17.8042 5.64706 14.8991 5.64706H13.1648C12.0963 5.64706 11.0861 5.15978 10.4211 4.32353C9.75597 3.48728 8.74582 3 7.67734 3Z" />
    </svg>
  )
}
