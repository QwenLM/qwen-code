/**
 * @craft-agent/ui - Shared React UI components for Craft Agent
 *
 * This package provides platform-agnostic UI components that work in both:
 * - Electron desktop app (full interactive mode)
 * - Web session viewer (read-only mode)
 *
 * Key components:
 * - SessionViewer: Read-only session transcript viewer (used by web viewer)
 * - TurnCard: Email-like display for assistant turns
 * - Markdown: Customizable markdown renderer with syntax highlighting
 *
 * Platform abstraction:
 * - PlatformProvider/usePlatform: Inject platform-specific actions
 */

// Context
export {
  PlatformProvider,
  usePlatform,
  type PlatformActions,
  type PlatformProviderProps,
  ShikiThemeProvider,
  useShikiTheme,
  type ShikiThemeProviderProps,
} from './context'

// Chat components
export {
  SessionViewer,
  TurnCard,
  TurnCardActionsMenu,
  ResponseCard,
  UserMessageBubble,
  SystemMessage,
  FileTypeIcon,
  getFileTypeLabel,
  asRecord,
  getAnnotationNoteText,
  getAnnotationFollowUpState,
  isAnnotationFollowUpSent,
  extractAnnotationSelectedText,
  normalizeFollowUpText,
  // Inline execution for EditPopover
  InlineExecution,
  mapToolEventToActivity,
  SIZE_CONFIG,
  ActivityStatusIcon,
  type SessionViewerProps,
  type SessionViewerMode,
  type TurnCardProps,
  type TurnCardActionsMenuProps,
  type ResponseCardProps,
  type UserMessageBubbleProps,
  type SystemMessageProps,
  type SystemMessageType,
  type FileTypeIconProps,
  type ActivityItem,
  type ActivityStatus,
  type ResponseContent,
  type TodoItem,
  type InlineExecutionProps,
  type InlineExecutionStatus,
  type InlineActivityItem,
} from './components/chat'

// Markdown
export {
  Markdown,
  MemoizedMarkdown,
  CodeBlock,
  InlineCode,
  CollapsibleMarkdownProvider,
  useCollapsibleMarkdown,
  MarkdownDatatableBlock,
  MarkdownSpreadsheetBlock,
  MarkdownImageBlock,
  ImageCardStack,
  type MarkdownProps,
  type RenderMode,
  TiptapMarkdownEditor,
  type TiptapMarkdownEditorProps,
  type MarkdownEngine,
  type MarkdownDatatableBlockProps,
  type MarkdownSpreadsheetBlockProps,
  type MarkdownImageBlockProps,
  type ImageCardStackProps,
  type ImageCardStackItem,
} from './components/markdown'

// UI primitives
export {
  Spinner,
  SimpleDropdown,
  SimpleDropdownItem,
  PreviewHeader,
  PreviewHeaderBadge,
  PREVIEW_BADGE_VARIANTS,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuShortcut,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
  StyledDropdownMenuSubTrigger,
  StyledDropdownMenuSubContent,
  BrowserShader,
  BrowserControls,
  BrowserEmptyStateCard,
  FilterableSelectPopover,
  Island,
  IslandContentView,
  IslandFollowUpContentView,
  useIslandNavigation,
  type SpinnerProps,
  type SimpleDropdownProps,
  type SimpleDropdownItemProps,
  type PreviewHeaderProps,
  type PreviewHeaderBadgeProps,
  type PreviewBadgeVariant,
  type BrowserShaderProps,
  type BrowserControlsProps,
  type BrowserEmptyStateCardProps,
  type BrowserEmptyPromptSample,
  type FilterableSelectPopoverProps,
  type FilterableSelectRenderState,
  type IslandProps,
  type IslandContentViewProps,
  type IslandTransitionConfig,
  type IslandActiveViewSize,
  type IslandMorphTarget,
  type IslandFollowUpContentViewProps,
  type IslandFollowUpMode,
  type IslandNavigation,
  type IslandDialogBehavior,
  type AnchorX,
  type AnchorY,
} from './components/ui'

// Tooltip
export {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from './components/tooltip'

// Code viewer components
export {
  ShikiCodeViewer,
  ShikiDiffViewer,
  getDiffStats,
  UnifiedDiffViewer,
  getUnifiedDiffStats,
  DiffViewerControls,
  DiffSplitIcon,
  DiffUnifiedIcon,
  DiffBackgroundIcon,
  LANGUAGE_MAP,
  getLanguageFromPath,
  formatFilePath,
  truncateFilePath,
  type ShikiCodeViewerProps,
  type ShikiDiffViewerProps,
  type UnifiedDiffViewerProps,
  type DiffViewerControlsProps,
} from './components/code-viewer'

// Terminal components
export {
  TerminalOutput,
  parseAnsi,
  stripAnsi,
  isGrepContentOutput,
  parseGrepOutput,
  ANSI_COLORS,
  type TerminalOutputProps,
  type ToolType,
  type AnsiSpan,
  type GrepLine,
} from './components/terminal'

// Overlay components
export {
  // Base overlay components
  FullscreenOverlayBase,
  FullscreenOverlayBaseHeader,
  PreviewOverlay,
  ContentFrame,
  CopyButton,
  type FullscreenOverlayBaseProps,
  type FullscreenOverlayBaseHeaderProps,
  type OverlayTypeBadge,
  type PreviewOverlayProps,
  type ContentFrameProps,
  type BadgeVariant,
  type CopyButtonProps,
  // Specialized overlays
  CodePreviewOverlay,
  MultiDiffPreviewOverlay,
  TerminalPreviewOverlay,
  GenericOverlay,
  JSONPreviewOverlay,
  DataTableOverlay,
  DocumentFormattedMarkdownOverlay,
  ImagePreviewOverlay,
  PDFPreviewOverlay,
  detectLanguage,
  detectLanguageFromPath,
  type CodePreviewOverlayProps,
  type MultiDiffPreviewOverlayProps,
  type FileChange,
  type DiffViewerSettings,
  type TerminalPreviewOverlayProps,
  type GenericOverlayProps,
  type JSONPreviewOverlayProps,
  type DataTableOverlayProps,
  type DocumentFormattedMarkdownOverlayProps,
  type ImagePreviewOverlayProps,
  type PDFPreviewOverlayProps,
  ActivityCardsOverlay,
  type ActivityCardsOverlayProps,
} from './components/overlay'

// File classification (for link interceptor)
export {
  classifyFile,
  type FilePreviewType,
  type FileClassification,
} from './lib/file-classification'

// Utilities
export { cn } from './lib/utils'
export {
  openExternalUrl,
  type OpenExternalUrlResult,
} from './lib/open-external-url'
export {
  setDismissibleLayerBridge,
  getDismissibleLayerBridge,
  type DismissibleLayerBridge,
  type DismissibleLayerRegistration,
  type DismissibleLayerSnapshot,
  type DismissibleLayerType,
} from './lib/dismissible-layer-bridge'

// Layout constants and hooks
export {
  CHAT_LAYOUT,
  CHAT_CLASSES,
  OVERLAY_LAYOUT,
  useOverlayMode,
  type OverlayMode,
} from './lib/layout'

// Tool result parsers
export {
  parseReadResult,
  parseBashResult,
  parseGrepResult,
  parseGlobResult,
  extractOverlayData,
  extractOverlayCards,
  type ReadResult,
  type BashResult,
  type GrepResult,
  type GlobResult,
  type CodeOverlayData,
  type TerminalOverlayData,
  type GenericOverlayData,
  type JSONOverlayData,
  type DocumentOverlayData,
  type OverlayData,
  type OverlayCard,
} from './lib/tool-parsers'

// Turn utilities (pure functions)
export * from './components/chat/turn-utils'

// Icons
export {
  Icon_Folder,
  Icon_Home,
  Icon_Inbox,
  type IconProps,
} from './components/icons'
