/**
 * Re-export PreviewHeader components from @craft-agent/ui
 *
 * This provides backwards compatibility for existing Electron components.
 * The actual implementation is now in the shared UI package.
 */

export {
  PreviewHeader as WindowHeader,
  PreviewHeaderBadge as WindowHeaderBadge,
  PREVIEW_BADGE_VARIANTS as BADGE_VARIANTS,
  type PreviewHeaderProps as WindowHeaderProps,
  type PreviewHeaderBadgeProps as WindowHeaderBadgeProps,
  type PreviewBadgeVariant as BadgeVariant,
} from '@craft-agent/ui'
