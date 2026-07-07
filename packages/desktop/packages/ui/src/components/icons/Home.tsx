import type { IconProps } from './types'

/**
 * Custom Home icon for the working directory badge.
 * Rounded house outline — clean silhouette.
 *
 * ADDING NEW ICONS: Ensure paths fill the 2-22 range (Lucide standard).
 * Use strokeWidth={2} to match Lucide visual weight.
 */
export function Icon_Home({ size, className, ...props }: IconProps) {
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
      <path d="M2.5 11.9459C2.5 10.0569 2.5 9.11242 2.89471 8.29108C3.28942 7.46974 4.02691 6.87964 5.50188 5.69945L7.00188 4.49923C9.39841 2.58165 10.5967 1.62287 12 1.62287C13.4033 1.62287 14.6016 2.58165 16.9981 4.49923L18.4981 5.69945C19.9731 6.87964 20.7106 7.46974 21.1053 8.29108C21.5 9.11242 21.5 10.0569 21.5 11.946V14C21.5 17.7712 21.5 19.6569 20.3284 20.8284C19.1569 22 17.2712 22 13.5 22H10.5C6.72876 22 4.84315 22 3.67157 20.8284C2.5 19.6569 2.5 17.7712 2.5 14V11.9459Z" />
    </svg>
  )
}
