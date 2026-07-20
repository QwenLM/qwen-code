import type { IconProps } from './types'

/**
 * Custom Inbox icon with Lucide-compatible bounds.
 *
 * ADDING NEW ICONS: Ensure paths fill the 2-22 range (Lucide standard).
 * Use strokeWidth={2} to match Lucide visual weight.
 */
export function Icon_Inbox({ size, className, ...props }: IconProps) {
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
      <path d="M2.52632 11.2258H6.7674C7.62255 11.2258 8.31579 11.919 8.31579 12.7742C8.31579 13.6293 9.00903 14.3226 9.86418 14.3226H14.1358C14.991 14.3226 15.6842 13.6293 15.6842 12.7742C15.6842 11.919 16.3774 11.2258 17.2326 11.2258H21.4737M21.0606 9.61363L20.1041 7.97226C18.9743 6.03328 18.4094 5.06379 17.4838 4.5319C16.5583 4 15.4362 4 13.192 4H10.808C8.56383 4 7.44175 4 6.5162 4.5319C5.59065 5.06379 5.02572 6.03328 3.89586 7.97226L2.93943 9.61363C2.54662 10.2877 2.35021 10.6248 2.22342 10.9881C2.16012 11.1694 2.10997 11.3551 2.07335 11.5437C2 11.9214 2 12.3115 2 13.0917C2 15.8133 2 17.1742 2.63464 18.162C2.9448 18.6448 3.35519 19.0552 3.83797 19.3654C4.82584 20 6.18665 20 8.90828 20H15.0917C17.8133 20 19.1742 20 20.162 19.3654C20.6448 19.0552 21.0552 18.6448 21.3654 18.162C22 17.1742 22 15.8133 22 13.0917C22 12.3115 22 11.9214 21.9266 11.5437C21.89 11.3551 21.8399 11.1694 21.7766 10.9881C21.6498 10.6248 21.4534 10.2877 21.0606 9.61363Z" />
    </svg>
  )
}
