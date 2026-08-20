/**
 * UI primitives for @craft-agent/ui
 */

export { Spinner, type SpinnerProps, LoadingIndicator, type LoadingIndicatorProps } from './LoadingIndicator'
export {
  SimpleDropdown,
  SimpleDropdownItem,
  type SimpleDropdownProps,
  type SimpleDropdownItemProps,
} from './SimpleDropdown'
export {
  PreviewHeader,
  PreviewHeaderBadge,
  PREVIEW_BADGE_VARIANTS,
  type PreviewHeaderProps,
  type PreviewHeaderBadgeProps,
  type PreviewBadgeVariant,
} from './PreviewHeader'
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuShortcut,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
  StyledDropdownMenuSubTrigger,
  StyledDropdownMenuSubContent,
} from './StyledDropdown'
export { BrowserShader, type BrowserShaderProps } from './BrowserShader'
export { BrowserControls, type BrowserControlsProps } from './BrowserControls'
export {
  BrowserEmptyStateCard,
  type BrowserEmptyStateCardProps,
  type BrowserEmptyPromptSample,
} from './BrowserEmptyStateCard'
export {
  FilterableSelectPopover,
  type FilterableSelectPopoverProps,
  type FilterableSelectRenderState,
} from './FilterableSelectPopover'
export {
  Island,
  IslandContentView,
  type IslandProps,
  type IslandContentViewProps,
  type IslandTransitionConfig,
  type IslandActiveViewSize,
  type IslandMorphTarget,
  type IslandDialogBehavior,
  type AnchorX,
  type AnchorY,
} from './Island'
export {
  IslandFollowUpContentView,
  type IslandFollowUpContentViewProps,
  type IslandFollowUpMode,
} from './IslandFollowUpContentView'
export {
  useIslandNavigation,
  type IslandNavigation,
} from './useIslandNavigation'
