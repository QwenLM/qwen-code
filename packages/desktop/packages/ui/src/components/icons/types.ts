import type { SVGProps } from 'react'

export interface IconProps extends SVGProps<SVGSVGElement> {
  /**
   * Icon size. Only used when className doesn't include size classes.
   * For Tailwind, prefer using className="size-4" etc.
   */
  size?: number | string
}
