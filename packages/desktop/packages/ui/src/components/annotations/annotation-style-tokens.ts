import { cn } from '../../lib/utils'

export function annotationColorToCss(color?: string): string {
  switch ((color ?? 'yellow').toLowerCase()) {
    case 'green':
      return 'rgba(74, 222, 128, 0.10)'
    case 'blue':
      return 'rgba(96, 165, 250, 0.10)'
    case 'pink':
      return 'rgba(244, 114, 182, 0.10)'
    case 'purple':
      return 'rgba(168, 85, 247, 0.10)'
    case 'yellow':
    default:
      return 'color-mix(in srgb, var(--info) 10%, transparent)'
  }
}

export function getAnnotationRectVisual(rect: { pendingFollowUp?: boolean; sentFollowUp?: boolean }) {
  const isPendingFollowUp = !!rect.pendingFollowUp

  return {
    className: cn('absolute', isPendingFollowUp ? 'shadow-tinted' : undefined),
    style: {
      opacity: rect.sentFollowUp ? 0.58 : 1,
      ['--shadow-color' as string]: 'var(--info-rgb)',
      ['--shadow-border-opacity' as string]: isPendingFollowUp ? '0.14' : '0.08',
      ['--shadow-blur-opacity' as string]: isPendingFollowUp ? '0.10' : '0.05',
    },
  }
}

export function getAnnotationChipVisual(chip: { pendingFollowUp?: boolean; sentFollowUp?: boolean }) {
  const pending = !!chip.pendingFollowUp
  const sent = !!chip.sentFollowUp

  return {
    className: cn(
      'absolute pointer-events-auto focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
      pending ? 'shadow-tinted cursor-pointer hover:bg-foreground/10' : undefined,
      sent ? 'cursor-default hover:bg-foreground/5' : undefined,
      !pending && !sent ? 'cursor-pointer hover:bg-foreground/6' : undefined,
    ),
    style: {
      backgroundColor: pending
        ? 'color-mix(in srgb, var(--info) 34%, var(--background))'
        : sent
          ? 'color-mix(in srgb, var(--info) 14%, var(--background))'
          : 'color-mix(in srgb, var(--info) 30%, var(--background))',
      color: sent
        ? 'var(--foreground)'
        : 'rgba(15, 23, 42, 0.95)',
      ['--shadow-color' as string]: 'var(--info-rgb)',
      ['--shadow-border-opacity' as string]: pending ? '0.14' : '0.05',
      ['--shadow-blur-opacity' as string]: pending ? '0.10' : '0.03',
    },
  }
}
