import * as React from 'react'
import { useMemo, useEffect, useRef, useCallback, useState } from 'react'
import i18n from 'i18next'
import { useTranslation } from 'react-i18next'
import type { ToolDisplayMeta, AnnotationV1 } from '@craft-agent/core'
import { normalizePath, pathStartsWith, stripPathPrefix } from '@craft-agent/core/utils'
import { isParentTaskTool } from '@craft-agent/shared/utils/toolNames'
import { motion, AnimatePresence } from 'motion/react'
import {
  ChevronRight,
  CheckCircle2,
  XCircle,
  Circle,
  MessageCircleDashed,
  FileText,
  ArrowUpRight,
  Ban,
  Copy,
  Check,
  Maximize2,
  CircleCheck,
  ListTodo,
  Pencil,
  FilePenLine,
  GitBranch,
  Bot,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { Markdown } from '../markdown'
import { Spinner } from '../ui/LoadingIndicator'
import { type IslandTransitionConfig } from '../ui'
import { AnnotationIslandMenu } from '../annotations/AnnotationIslandMenu'
import {
  type PointerSnapshot,
  buildAnnotationChipEntryTransition,
  buildSelectionEntryTransition,
} from '../annotations/island-motion'
import { Tooltip, TooltipTrigger, TooltipContent } from '../tooltip'
import { parseDiffFromFile, type FileContents } from '@pierre/diffs'
import { getDiffStats, getUnifiedDiffStats } from '../code-viewer'
import { TurnCardActionsMenu } from './TurnCardActionsMenu'
import { computeLastChildSet, groupActivitiesByParent, isActivityGroup, formatDuration, formatTokens, deriveTurnPhase, shouldShowThinkingIndicator, type ActivityGroup, type AssistantTurn } from './turn-utils'
import {
  buildTurnTimelineItems,
  formatProcessedDuration,
  getProcessedDurationMs,
  splitTimelineAtFinalResponse,
  type TurnTimelineItem,
} from './turn-timeline'
import { extractAnnotationSelectedText } from './follow-up-helpers'
import {
  formatAnnotationFollowUpTooltipText,
  getAnnotationNoteText,
} from '../annotations/follow-up-state'
import {
  ANNOTATION_PREFIX_SUFFIX_WINDOW,
  SELECTION_POINTER_MAX_AGE_MS,
  clamp,
  hasExistingTextRangeAnnotation,
  createSelectionPreviewAnnotation,
  createTextSelectionAnnotation,
  collectTextSegments,
  getCanonicalText,
  resolveNodeOffset,
  type AnnotationOverlayRect,
} from '../annotations/annotation-core'
import {
  annotationColorToCss,
} from '../annotations/annotation-style-tokens'
import { clearBlockAnnotationMarkers, applyBlockAnnotationMarker } from '../annotations/block-markers'
import { canAnnotateMessage, shouldRenderAnnotationIslandInPortal } from '../annotations/annotation-host-config'
import { clearDomSelection } from '../annotations/selection-restore'
import {
  shouldIgnoreSelectionMouseUpTarget,
} from '../annotations/interaction-policy'
import { computeAnnotationOverlayGeometry, type AnnotationOverlayChip } from '../annotations/annotation-overlay-geometry'
import { AnnotationOverlayLayer } from '../annotations/AnnotationOverlayLayer'
import {
  getAnnotationInteractionAnchor,
  getAnnotationInteractionSourceKey,
  hasAnnotationInteraction,
} from '../annotations/interaction-selectors'
import {
  type AnnotationIslandMode,
  type AnchoredSelection,
} from '../annotations/interaction-state-machine'
import { useAnnotationInteractionController } from '../annotations/use-annotation-interaction-controller'
import { useAnnotationIslandPresentation } from '../annotations/use-annotation-island-presentation'
import { useAnnotationIslandEvents } from '../annotations/use-annotation-island-events'
import { useAnnotationCancelRestore } from '../annotations/use-annotation-cancel-restore'
import { DocumentFormattedMarkdownOverlay } from '../overlay'
import { AcceptPlanDropdown } from './AcceptPlanDropdown'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '../ui/StyledDropdown'

// ============================================================================
// Utilities
// ============================================================================

/**
 * Simple markdown stripping for preview text.
 * Removes markdown syntax to show plain text preview.
 * Code block content is preserved as plain text.
 */
function stripMarkdown(text: string): string {
  return text
    // Extract content from fenced code blocks (remove ``` and optional language)
    .replace(/```(?:\w+)?\n?([\s\S]*?)```/g, '$1')
    // Extract content from inline code
    .replace(/`([^`]+)`/g, '$1')
    // Remove headers
    .replace(/^#{1,6}\s+/gm, '')
    // Remove bold/italic
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    // Remove links
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove images
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    // Remove blockquotes
    .replace(/^>\s+/gm, '')
    // Remove horizontal rules
    .replace(/^---+$/gm, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Compute diff stats for Edit/Write tool inputs.
 * Uses @pierre/diffs for accurate line-by-line diff calculation.
 *
 * Supports both:
 * - Edit format: { file_path, old_string, new_string }
 * - Codex format: { changes: Array<{ path, kind, diff }> }
 *
 * @param toolName - 'Edit' or 'Write'
 * @param toolInput - The tool input containing old_string/new_string (Edit) or content (Write)
 * @returns { additions, deletions } or null if not applicable
 */
function computeEditWriteDiffStats(
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined
): { additions: number; deletions: number } | null {
  if (!toolInput) return null

  if (toolName === 'Edit' || toolName === 'edit') {
    // Check for Codex format: { changes: Array<{ path, kind, diff }> }
    if (toolInput.changes && Array.isArray(toolInput.changes)) {
      let totalAdditions = 0
      let totalDeletions = 0
      for (const change of toolInput.changes as Array<{ path?: string; diff?: string }>) {
        if (change.diff) {
          const stats = getUnifiedDiffStats(change.diff, change.path || 'file')
          if (stats) {
            totalAdditions += stats.additions
            totalDeletions += stats.deletions
          }
        }
      }
      if (totalAdditions === 0 && totalDeletions === 0) return null
      return { additions: totalAdditions, deletions: totalDeletions }
    }

    // Edit format: { file_path, old_string, new_string }
    const oldString = (toolInput.old_string as string) ?? ''
    const newString = (toolInput.new_string as string) ?? ''
    if (!oldString && !newString) return null

    const oldFile: FileContents = { name: 'file', contents: oldString, lang: 'text' }
    const newFile: FileContents = { name: 'file', contents: newString, lang: 'text' }
    const fileDiff = parseDiffFromFile(oldFile, newFile)
    return getDiffStats(fileDiff)
  }

  if (toolName === 'Write' || toolName === 'write_file') {
    const content = (toolInput.content as string) ?? ''
    if (!content) return null

    // For Write, everything is an addition (new file content)
    const oldFile: FileContents = { name: 'file', contents: '', lang: 'text' }
    const newFile: FileContents = { name: 'file', contents: content, lang: 'text' }
    const fileDiff = parseDiffFromFile(oldFile, newFile)
    return getDiffStats(fileDiff)
  }

  return null
}

// ============================================================================
// Size Configuration
// ============================================================================

/**
 * Global size configuration for TurnCard components.
 * Adjust these values to scale the entire component uniformly.
 */
/** Shared size configuration for activity UI - exported for reuse in inline execution */
export const SIZE_CONFIG = {
  /** Base font size class for all text */
  fontSize: 'text-[13px]',
  /** Icon size class (width and height) */
  iconSize: 'w-3 h-3',
  /** Spinner text size class */
  spinnerSize: 'text-[10px]',
  /** Small spinner for header */
  spinnerSizeSmall: 'text-[8px]',
  /** Activity row height in pixels (approx for calculation) */
  activityRowHeight: 24,
  /** Max visible activities before scrolling (show ~15 items) */
  maxVisibleActivities: 15,
  /** Number of items before which we apply staggered animation */
  staggeredAnimationLimit: 10,
} as const

// ============================================================================
// Types
// ============================================================================

export type ActivityStatus = 'pending' | 'running' | 'completed' | 'error' | 'backgrounded'
export type ActivityType = 'tool' | 'thinking' | 'intermediate' | 'status' | 'plan'
export type AnnotationInteractionMode = 'interactive' | 'tooltip-only'

// ============================================================================
// Todo Types (for TodoWrite tool visualization)
// ============================================================================

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'interrupted'

export interface TodoItem {
  /** Task content/description */
  content: string
  /** Current status */
  status: TodoStatus
  /** Present continuous form shown when in_progress (e.g., "Running tests") */
  activeForm?: string
}

export interface ActivityItem {
  id: string
  type: ActivityType
  status: ActivityStatus
  toolName?: string
  toolUseId?: string  // For matching parent-child relationships
  toolInput?: Record<string, unknown>
  content?: string
  intent?: string
  intermediateKind?: 'commentary' | 'thought'
  /** Optional backing message id (used by plan activities for branching/annotations) */
  messageId?: string
  /** Optional persisted annotations (used by plan activities) */
  annotations?: AnnotationV1[]
  displayName?: string  // LLM-generated human-friendly tool name (for MCP tools)
  toolDisplayMeta?: ToolDisplayMeta  // Embedded metadata with base64 icon (for viewer compatibility)
  timestamp: number
  error?: string
  // Parent-child nesting for Task subagents
  parentId?: string  // Parent activity's toolUseId
  depth?: number     // Nesting level (0 = root, 1 = child, etc.)
  // Status activities (e.g., compacting)
  statusType?: string  // e.g., 'compacting'
  // Background task fields
  taskId?: string         // For background Task tools
  shellId?: string        // For background Bash shells
  elapsedSeconds?: number // Live progress updates
  isBackground?: boolean  // Flag for UI differentiation
}

export interface ResponseContent {
  text: string
  isStreaming: boolean
  streamStartTime?: number
  /** Timestamp of the underlying assistant message, used for timeline ordering */
  timestamp?: number
  /** Whether this response is a plan (renders with plan variant) */
  isPlan?: boolean
  /** ID of the underlying message (for branching + annotations) */
  messageId?: string
  /** Persisted annotations attached to the response message */
  annotations?: AnnotationV1[]
}

// ============================================================================
// TurnCard Props
// ============================================================================

export type OpenAnnotationRequest = {
  messageId: string
  annotationId: string
  mode: 'view' | 'edit'
  anchorX?: number
  anchorY?: number
  nonce: number
}

export interface TurnCardProps {
  /** Session ID for state persistence (optional in shared context) */
  sessionId?: string
  /** Turn ID for state persistence */
  turnId: string
  /** All activities in this turn (tools, thinking, intermediate text) */
  activities: ActivityItem[]
  /** Final response content (may be streaming) */
  response?: ResponseContent
  /** Primary intent/goal for this turn (shown in collapsed preview) */
  intent?: string
  /** Whether content is still being received */
  isStreaming: boolean
  /** Whether this turn is fully complete */
  isComplete: boolean
  /** Start in expanded state */
  defaultExpanded?: boolean
  /** Controlled expansion state (overrides internal state) */
  isExpanded?: boolean
  /** Callback when expansion state changes */
  onExpandedChange?: (expanded: boolean) => void
  /** Controlled expansion state for activity groups */
  expandedActivityGroups?: Set<string>
  /** Callback when activity group expansion changes */
  onExpandedActivityGroupsChange?: (groups: Set<string>) => void
  /** Callback when file path is clicked */
  onOpenFile?: (path: string) => void
  /** Callback when URL is clicked */
  onOpenUrl?: (url: string) => void
  /** Callback to open response in Monaco editor */
  onPopOut?: (text: string) => void
  /** Callback to open turn details in a new window */
  onOpenDetails?: () => void
  /** Callback to open individual activity details in Monaco */
  onOpenActivityDetails?: (activity: ActivityItem) => void
  /** Callback to open all edits/writes in multi-file diff view */
  onOpenMultiFileDiff?: () => void
  /** Whether this turn has any Edit or Write activities */
  hasEditOrWriteActivities?: boolean
  /** TodoWrite tool state - shown at bottom of turn */
  todos?: TodoItem[]
  /** Optional render prop for actions menu (Electron provides dropdown) */
  renderActionsMenu?: () => React.ReactNode
  /** Callback when user accepts the plan (plan responses only) */
  onAcceptPlan?: () => void
  /** Callback when user accepts the plan with compaction (compact conversation first, then execute) */
  onAcceptPlanWithCompact?: () => void
  /** Whether this is the last response in the session (shows Accept Plan button only for last response) */
  isLastResponse?: boolean
  /** Session folder path for stripping from file paths in tool display */
  sessionFolderPath?: string
  /** Display mode: 'detailed' shows all info, 'informative' hides MCP/API names and params */
  displayMode?: 'informative' | 'detailed'
  /** Animate response appearance (for playground demos) */
  animateResponse?: boolean
  /** Hide footers for compact embedding (EditPopover) */
  compactMode?: boolean
  /** Callback to branch the session from a specific message */
  onBranch?: (messageId: string, options?: { newPanel?: boolean }) => void
  /** Callback to add an annotation to a response message */
  onAddAnnotation?: (messageId: string, annotation: AnnotationV1) => void
  /** Callback to remove a persisted annotation from a response message */
  onRemoveAnnotation?: (messageId: string, annotationId: string) => void
  /** Callback to update a persisted annotation */
  onUpdateAnnotation?: (messageId: string, annotationId: string, patch: Partial<AnnotationV1>) => void
  /** Input send key behavior used by follow-up editor */
  sendMessageKey?: 'enter' | 'cmd-enter'
  /** Callback when follow-up is saved via "Save & Send" action */
  onSaveAndSendFollowUp?: (target: { messageId: string; annotationId: string; note: string; selectedText: string }) => void
  /** Whether there are active pending follow-up annotations in the session */
  hasActiveFollowUpAnnotations?: boolean
  /** External request to open a specific annotation in the follow-up island */
  openAnnotationRequest?: OpenAnnotationRequest | null
  /** Annotation interaction mode (viewer uses tooltip-only to suppress the island) */
  annotationInteractionMode?: AnnotationInteractionMode
}

// ============================================================================
// Buffering Constants & Utilities
// ============================================================================

/**
 * Aggressive buffering configuration.
 * Waits until content is suspected to be meaningful "commentary" before showing.
 */
const BUFFER_CONFIG = {
  MIN_WORDS_STANDARD: 40,      // Base threshold for showing content
  MIN_WORDS_CODE: 15,          // Code blocks show faster
  MIN_WORDS_LIST: 20,          // Lists show faster
  MIN_WORDS_QUESTION: 8,       // Questions from AI show faster
  MIN_WORDS_HEADER: 12,        // Headers indicate structure
  MIN_BUFFER_MS: 500,          // Always wait at least 500ms
  MAX_BUFFER_MS: 2500,         // Never buffer longer than 2.5s
  TIMEOUT_MIN_WORDS: 5,        // Show on timeout if at least this many words
  HIGH_WORD_COUNT: 60,         // Show regardless of structure at this count
  CONTENT_THROTTLE_MS: 300,    // Throttle content updates during streaming (perf optimization)
} as const

type BufferReason =
  | 'complete'
  | 'min_time'
  | 'timeout'
  | 'code_block'
  | 'list'
  | 'header'
  | 'question'
  | 'threshold_met'
  | 'high_word_count'
  | 'buffering'

/** Count words in text */
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(w => w.length > 0).length
}

/** Detect code blocks (fenced) */
function hasCodeBlock(text: string): boolean {
  return /```/.test(text)
}

/** Detect markdown lists (bullet or numbered) */
function hasList(text: string): boolean {
  return /^\s*[-*•]\s/m.test(text) || /^\s*\d+\.\s/m.test(text)
}

/** Detect markdown headers */
function hasHeader(text: string): boolean {
  return /^#{1,4}\s/m.test(text)
}

/** Detect structural content (sentences, paragraphs, etc) */
function hasStructure(text: string): boolean {
  // Sentence ending (period, exclamation, question mark, colon)
  if (/[.!?:]\s*$/.test(text.trimEnd())) return true
  // Paragraph breaks
  if (/\n\s*\n/.test(text)) return true
  // Headers anywhere
  if (/\n\s*#{1,4}\s/.test(text)) return true
  // Code blocks
  if (hasCodeBlock(text)) return true
  return false
}

/** Detect if text ends with a question (AI asking for clarification) */
function isQuestion(text: string): boolean {
  return /\?\s*$/.test(text.trim())
}

/**
 * Determine if buffered content should be shown.
 * This is the core buffering decision function.
 *
 * @param text - The accumulated response text
 * @param isStreaming - Whether the response is still streaming
 * @param streamStartTime - When streaming started (for timeout calculation)
 * @returns Decision with reason for debugging
 */
function shouldShowContent(
  text: string,
  isStreaming: boolean,
  streamStartTime?: number
): { shouldShow: boolean; reason: BufferReason; wordCount: number } {
  const wordCount = countWords(text)

  // Always show complete content immediately
  if (!isStreaming) {
    return { shouldShow: true, reason: 'complete', wordCount }
  }

  const elapsed = streamStartTime ? Date.now() - streamStartTime : 0

  // Minimum buffer time - always wait at least 500ms
  if (elapsed < BUFFER_CONFIG.MIN_BUFFER_MS) {
    return { shouldShow: false, reason: 'min_time', wordCount }
  }

  // Maximum buffer time - force show after 2.5s if we have some content
  if (elapsed > BUFFER_CONFIG.MAX_BUFFER_MS && wordCount >= BUFFER_CONFIG.TIMEOUT_MIN_WORDS) {
    return { shouldShow: true, reason: 'timeout', wordCount }
  }

  // High-confidence patterns get expedited treatment

  // Code blocks - developers want to see code early
  if (hasCodeBlock(text) && wordCount >= BUFFER_CONFIG.MIN_WORDS_CODE) {
    return { shouldShow: true, reason: 'code_block', wordCount }
  }

  // Headers indicate structured content
  if (hasHeader(text) && wordCount >= BUFFER_CONFIG.MIN_WORDS_HEADER) {
    return { shouldShow: true, reason: 'header', wordCount }
  }

  // Lists indicate structured content
  if (hasList(text) && wordCount >= BUFFER_CONFIG.MIN_WORDS_LIST) {
    return { shouldShow: true, reason: 'list', wordCount }
  }

  // Questions from AI (clarification) - show quickly
  if (isQuestion(text) && wordCount >= BUFFER_CONFIG.MIN_WORDS_QUESTION) {
    return { shouldShow: true, reason: 'question', wordCount }
  }

  // Standard threshold - 40 words with some structure
  if (wordCount >= BUFFER_CONFIG.MIN_WORDS_STANDARD && hasStructure(text)) {
    return { shouldShow: true, reason: 'threshold_met', wordCount }
  }

  // High word count - show regardless of structure
  if (wordCount >= BUFFER_CONFIG.HIGH_WORD_COUNT) {
    return { shouldShow: true, reason: 'high_word_count', wordCount }
  }

  return { shouldShow: false, reason: 'buffering', wordCount }
}

/**
 * Check if a response is currently in buffering state
 * Used by TurnCard to show subtle indicator instead of big card
 */
function isResponseBuffering(response: ResponseContent | undefined): boolean {
  if (!response) return false
  if (!response.isStreaming) return false
  const decision = shouldShowContent(response.text, response.isStreaming, response.streamStartTime)
  return !decision.shouldShow
}

// ============================================================================
// Helper Functions
// ============================================================================

/** Get display name for a tool (strip MCP prefixes, apply friendly names) */
function getToolDisplayName(name: string): string {
  const stripped = name.replace(/^mcp__[^_]+__/, '')

  // Friendly display names for specific tools
  const displayNames: Record<string, string> = {
    'TodoWrite': 'Todo List Updated',
    'todo_write': 'Todo List Updated',
    'read_file': 'Reading File',
    'write_file': 'Writing File',
    'grep_search': 'Searching Files',
    'run_shell_command': 'Running Command',
    'set_session_labels': 'Set Session Labels',
    'set_session_status': 'Set Session Status',
    'get_session_info': 'Get Session Info',
    'list_sessions': 'List Sessions',
    'task': 'Running Agent',
    'Task': 'Running Agent',
    'agent': 'Running Agent',
    'Agent': 'Running Agent',
  }

  return displayNames[stripped] || stripped
}

/**
 * Strip session/workspace folder paths from file paths for cleaner display.
 * Only strips paths that match the current session folder path.
 * Example: /path/to/sessions/260121-foo/plans/file.md → plans/file.md
 */
function stripSessionFolderPath(filePath: string, sessionFolderPath?: string): string {
  if (!sessionFolderPath) return filePath

  // Get workspace path (parent of sessions folder)
  // sessionFolderPath: /path/workspaces/{uuid}/sessions/{sessionId}
  const workspacePath = normalizePath(sessionFolderPath).replace(/\/sessions\/[^/]+$/, '')

  // Try session folder first (more specific)
  if (pathStartsWith(filePath, sessionFolderPath)) {
    return stripPathPrefix(filePath, sessionFolderPath)
  }

  // Then try workspace folder
  if (pathStartsWith(filePath, workspacePath)) {
    return stripPathPrefix(filePath, workspacePath)
  }

  return filePath
}

/** Format tool input as a concise summary - CSS truncate handles overflow */
function formatToolInput(
  input?: Record<string, unknown>,
  toolName?: string,
  sessionFolderPath?: string
): string {
  if (!input || Object.keys(input).length === 0) return ''

  // For call_llm: model shown as badge, prompt duplicates intent
  if (toolName === 'mcp__session__call_llm') return ''

  const parts: string[] = []

  // For Edit/Write tools, only show file_path (skip old_string, new_string, replace_all, content)
  const isEditOrWrite = toolName === 'Edit' || toolName === 'Write' || toolName === 'edit' || toolName === 'write_file'

  // Handle Codex format: { changes: Array<{ path, kind, diff }> }
  // Extract path from first change if present
  if (isEditOrWrite && input.changes && Array.isArray(input.changes)) {
    const firstChange = input.changes[0] as { path?: string } | undefined
    if (firstChange?.path) {
      const pathStr = stripSessionFolderPath(firstChange.path, sessionFolderPath)
      parts.push(pathStr)
    }
    return parts.join(' ')
  }

  for (const [key, value] of Object.entries(input)) {
    // Skip meta fields and description (shown separately)
    if (key === '_intent' || key === 'description' || value === undefined || value === null) continue

    // For Edit/Write tools, only include file_path
    if (isEditOrWrite && key !== 'file_path') continue

    let valStr = typeof value === 'string'
      ? value.replace(/\s+/g, ' ').trim()
      : JSON.stringify(value)

    // Strip session/workspace paths from file_path for Edit/Write tools
    if (isEditOrWrite && key === 'file_path' && typeof value === 'string') {
      valStr = stripSessionFolderPath(valStr, sessionFolderPath)
    }

    parts.push(valStr)
    if (parts.length >= 2) break // Max 2 values
  }
  return parts.join(' ')
}

/**
 * Extract the action portion from an LLM-provided displayName by stripping
 * a matching icon/tool prefix.
 *
 * Examples:
 *   extractActionFromDisplayName("Git", "Git Status")  → "Status"
 *   extractActionFromDisplayName("npm", "Install Deps") → "Install Deps"
 *   extractActionFromDisplayName("Git", "Check Branch")  → "Check Branch"
 */
function extractActionFromDisplayName(iconName: string, llmName: string): string {
  // If LLM name starts with the icon name, strip the prefix to get the action
  // "Git Status" with icon "Git" → "Status"
  if (llmName.toLowerCase().startsWith(iconName.toLowerCase() + ' ')) {
    return llmName.slice(iconName.length + 1).trim()
  }
  // Otherwise use the full LLM name as the action
  // "Install Dependencies" with icon "npm" → "Install Dependencies"
  return llmName
}

/**
 * Format tool display using embedded toolDisplayMeta.
 * toolDisplayMeta is set at storage time in the main process and includes:
 * - displayName: Human-readable name
 * - iconDataUrl: Base64-encoded icon (for skills/sources)
 * - description: Brief description
 * - category: 'skill' | 'source' | 'native' | 'mcp'
 */
function formatToolDisplay(
  activity: ActivityItem
): { name: string; icon?: string; description?: string } {
  const { toolName, displayName, toolInput, toolDisplayMeta } = activity

  // Primary: Use embedded toolDisplayMeta (works in both Electron and viewer)
  if (toolDisplayMeta) {
    // For MCP tools, append the tool slug to the source name
    if (toolName?.startsWith('mcp__') && toolDisplayMeta.category === 'source') {
      const parts = toolName.match(/^mcp__([^_]+)__(.+)$/)
      if (parts) {
        const toolSlug = parts[2]
        return {
          name: `${toolDisplayMeta.displayName}: ${toolSlug}`,
          icon: toolDisplayMeta.iconDataUrl,
          description: toolDisplayMeta.description,
        }
      }
    }

    // For Bash commands with LLM-provided displayName: merge icon name + action
    // e.g., icon "Git" + LLM "Git Status" → "Git: Status"
    // e.g., icon "npm" + LLM "Install Dependencies" → "npm: Install Dependencies"
    // Special case: for generic "Terminal", show only the action
    // e.g., icon "Terminal" + LLM "Install Dependencies" → "Install Dependencies"
    if (toolName === 'Bash' && displayName) {
      const iconName = toolDisplayMeta.displayName
      const action = extractActionFromDisplayName(iconName, displayName)
      return {
        name: iconName.toLowerCase() === 'terminal' ? action : `${iconName}: ${action}`,
        icon: toolDisplayMeta.iconDataUrl,
        description: toolDisplayMeta.description,
      }
    }

    // For native tools with LLM-provided displayName: use the LLM's name
    // This gives semantic names like "Read Config" instead of generic "Read"
    if (displayName && toolDisplayMeta.category === 'native') {
      return {
        name: displayName,
        icon: toolDisplayMeta.iconDataUrl,
        description: toolDisplayMeta.description,
      }
    }

    return {
      name: toolDisplayMeta.displayName,
      icon: toolDisplayMeta.iconDataUrl,
      description: toolDisplayMeta.description,
    }
  }

  // Fallback for Skill tool without toolDisplayMeta (legacy sessions)
  if (toolName === 'Skill' && toolInput?.skill) {
    const skillId = String(toolInput.skill)
    // Extract slug from qualified name (workspaceId:slug) for display
    const colonIdx = skillId.indexOf(':')
    const slug = colonIdx > 0 ? skillId.slice(colonIdx + 1) : skillId
    return { name: slug }
  }

  // Final fallback: Use LLM-generated displayName or tool name
  const name = displayName || (toolName ? getToolDisplayName(toolName) : i18n.t('turnCard.processing'))
  return { name }
}

/** Get the primary preview text for collapsed state */
function getPreviewText(
  activities: ActivityItem[],
  intent?: string,
  isStreaming?: boolean,
  hasResponse?: boolean,
  isComplete?: boolean
): string {
  // If we have an explicit intent, use it
  if (intent) return intent

  // Find the most relevant activity intent
  const activityWithIntent = activities.find(a => a.intent)
  if (activityWithIntent?.intent) return activityWithIntent.intent

  // Check if we're in responding state
  if (isStreaming && hasResponse) return i18n.t('turnCard.responding')

  // Find running Task tools and show their description
  const runningTask = activities.find(a => isParentTaskTool(a.toolName ?? '') && a.status === 'running')
  if (runningTask?.toolInput?.description) {
    return `Agent: ${runningTask.toolInput.description as string}`
  }

  // While still streaming, show the latest intermediate message content
  // This gives visibility into what the LLM is "thinking"
  if (isStreaming && !isComplete) {
    const latestIntermediate = [...activities]
      .reverse()
      .find(a => a.type === 'intermediate' && a.content)
    if (latestIntermediate?.content) {
      return latestIntermediate.content
    }
  }

  // Get running and completed tools (not intermediate messages)
  const runningTools = activities.filter(a => a.status === 'running' && a.toolName)
  const errorCount = activities.filter(a => a.status === 'error').length

  // Show running tool names
  if (runningTools.length > 0) {
    const toolNames = runningTools
      .map(a => getToolDisplayName(a.toolName!))
      .slice(0, 3) // Max 3 names
    return `${toolNames.join(', ')}...`
  }

  // When complete, show first Task's description if available
  const firstTask = activities.find(a => isParentTaskTool(a.toolName ?? ''))
  if (firstTask?.toolInput?.description) {
    const errorSuffix = errorCount > 0
      ? i18n.t('turnCard.errorCount', { count: errorCount })
      : ''
    return `Agent: ${firstTask.toolInput.description as string}${errorSuffix}`
  }

  // When complete, show summary (badge already shows count)
  if (isComplete || (!isStreaming && activities.length > 0)) {
    const errorSuffix = errorCount > 0
      ? i18n.t('turnCard.errorCount', { count: errorCount })
      : ''
    return `${i18n.t('turnCard.stepsCompleted')}${errorSuffix}`
  }

  return i18n.t('turnCard.starting')
}

// ============================================================================
// Sub-Components
// ============================================================================

interface ProcessedDetailsDisclosureProps {
  duration: string
  isExpanded: boolean
  onToggle: () => void
  children: React.ReactNode
}

function ProcessedDetailsDisclosure({
  duration,
  isExpanded,
  onToggle,
  children,
}: ProcessedDetailsDisclosureProps) {
  return (
    <div className="select-none">
      <button
        type="button"
        aria-expanded={isExpanded}
        onClick={onToggle}
        className={cn(
          "group flex w-full items-center gap-1.5 rounded-[6px] px-0 py-1.5 text-left",
          SIZE_CONFIG.fontSize,
          "text-muted-foreground hover:text-foreground transition-colors",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        )}
      >
        <span className="font-medium tabular-nums">
          {i18n.t('turnCard.processedDuration', { duration })}
        </span>
        <motion.span
          initial={false}
          animate={{ rotate: isExpanded ? 90 : 0 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
          className={cn(SIZE_CONFIG.iconSize, "flex items-center justify-center shrink-0")}
        >
          <ChevronRight className={SIZE_CONFIG.iconSize} />
        </motion.span>
      </button>
      <div className="border-b border-border/60" />

      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{
              height: { duration: 0.25, ease: [0.4, 0, 0.2, 1] },
              opacity: { duration: 0.15 },
            }}
            className="overflow-hidden"
          >
            <div className="space-y-1 py-1.5">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/**
 * Status icon for an activity - exported for reuse in inline execution.
 * Supports custom icons from skill/source metadata when completed.
 * Edit/Write tools show tool-specific icons; others show checkmark or custom icon.
 */
export function ActivityStatusIcon({
  status,
  toolName,
  customIcon
}: {
  status: ActivityStatus
  toolName?: string
  /** Custom icon from tool metadata - emoji or data URL (base64) */
  customIcon?: string
}) {
  // Render the appropriate icon based on status
  const renderIcon = () => {
    // For completed status with custom icon, use it instead of checkmark
    if (status === 'completed' && customIcon) {
      // Check if it's an emoji (short string, not a URL or data URL)
      // Emojis can be 1-4+ characters due to ZWJ sequences
      const isLikelyEmoji = customIcon.length <= 8 && !/^(https?:\/\/|data:)/.test(customIcon)
      if (isLikelyEmoji) {
        return (
          <span className={cn(SIZE_CONFIG.iconSize, "shrink-0 flex items-center justify-center text-[10px] leading-none")}>
            {customIcon}
          </span>
        )
      }
      // Otherwise it's a data URL (base64) or HTTP URL
      return (
        <img
          src={customIcon}
          alt=""
          className={cn(SIZE_CONFIG.iconSize, "shrink-0 rounded-sm object-contain")}
        />
      )
    }

    // Default icon logic
    switch (status) {
      case 'pending':
        return <Circle className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-muted-foreground/50")} />
      case 'running':
        return (
          <div className={cn(SIZE_CONFIG.iconSize, "flex items-center justify-center shrink-0")}>
            <Spinner className={SIZE_CONFIG.spinnerSize} />
          </div>
        )
      case 'backgrounded':
        return (
          <div className={cn(SIZE_CONFIG.iconSize, "flex items-center justify-center shrink-0")}>
            <Spinner className={cn(SIZE_CONFIG.spinnerSize, "text-accent")} />
          </div>
        )
      case 'completed':
        // Edit and Write tools get their own icons with accent color instead of green checkmark
        if (toolName === 'Edit' || toolName === 'edit') {
          return <Pencil className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-accent")} />
        }
        if (toolName === 'Write' || toolName === 'write_file') {
          return <FilePenLine className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-accent")} />
        }
        return <CheckCircle2 className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-success")} />
      case 'error':
        return <XCircle className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-destructive")} />
    }
  }

  // Wrap in AnimatePresence for crossfade between states
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={status}
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.8 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className="shrink-0"
      >
        {renderIcon()}
      </motion.div>
    </AnimatePresence>
  )
}

interface ActivityRowProps {
  activity: ActivityItem
  /** Callback to open activity details in Monaco */
  onOpenDetails?: () => void
  /** Whether this is the last child at its depth level (for └ corner in tree view) */
  isLastChild?: boolean
  /** Session folder path for stripping from file paths in tool display */
  sessionFolderPath?: string
  /** Display mode: 'detailed' shows all info, 'informative' hides MCP/API names and params */
  displayMode?: 'informative' | 'detailed'
}

/**
 * TreeViewConnector is no longer used - the vertical line from the expanded section
 * already provides visual hierarchy. Keeping this as a no-op for now in case
 * we need depth indentation in the future.
 */
function TreeViewConnector({ depth }: { depth: number; isLastChild?: boolean }) {
  if (depth === 0) return null

  // Just add indentation based on depth, no connectors
  return (
    <div className="flex self-stretch">
      {Array.from({ length: depth }).map((_, i) => (
        <div key={i} className="w-4 shrink-0" />
      ))}
    </div>
  )
}

/** Single activity row in expanded view */
function ActivityRow({ activity, onOpenDetails, isLastChild, sessionFolderPath, displayMode = 'detailed' }: ActivityRowProps) {
  const depth = activity.depth || 0

  // Intermediate messages in the expanded activity list keep the compact row
  // treatment used by the rest of the activity timeline.
  if (activity.type === 'intermediate') {
    const isThinking = activity.status === 'running'
    const displayContent = isThinking ? 'Thinking...' : stripMarkdown(activity.content || '')
    const isComplete = activity.status === 'completed'
    return (
      <div className="flex items-stretch">
        <TreeViewConnector depth={depth} isLastChild={isLastChild} />
        <div
          className={cn(
            "group/row flex items-center gap-2 py-0.5 text-foreground/75 flex-1 min-w-0",
            SIZE_CONFIG.fontSize
          )}
          onClick={onOpenDetails && isComplete ? onOpenDetails : undefined}
        >
          {isThinking ? (
            <div className={cn(SIZE_CONFIG.iconSize, "flex items-center justify-center shrink-0")}>
              <Spinner className={SIZE_CONFIG.spinnerSize} />
            </div>
          ) : (
            <MessageCircleDashed className={cn(SIZE_CONFIG.iconSize, "shrink-0")} />
          )}
          <span className={cn("truncate flex-1", onOpenDetails && isComplete && "group-hover/row:underline")}>{displayContent}</span>
          {/* Open details button */}
          {onOpenDetails && isComplete && (
            <div
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation()
                onOpenDetails()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation()
                  onOpenDetails()
                }
              }}
              className={cn(
                "p-0.5 rounded-[3px] opacity-0 group-hover/row:opacity-100 transition-opacity shrink-0",
                "hover:bg-muted/80 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              )}
            >
              <ArrowUpRight className={SIZE_CONFIG.iconSize} />
            </div>
          )}
        </div>
      </div>
    )
  }

  // Status activities (e.g., compacting) - system-level with distinct styling
  if (activity.type === 'status') {
    const isRunning = activity.status === 'running'
    return (
      <div className="flex items-stretch">
        <TreeViewConnector depth={depth} isLastChild={isLastChild} />
        <div
          className={cn(
            "flex items-center gap-2 py-0.5 text-muted-foreground flex-1 min-w-0",
            SIZE_CONFIG.fontSize
          )}
        >
          <div className={cn(SIZE_CONFIG.iconSize, "flex items-center justify-center shrink-0")}>
            {isRunning ? (
              <Spinner className={SIZE_CONFIG.spinnerSizeSmall} />
            ) : (
              <CheckCircle2 className={cn(SIZE_CONFIG.iconSize, "text-success")} />
            )}
          </div>
          <span className="truncate">{activity.content}</span>
        </div>
      </div>
    )
  }

  // Tool activities - show with status icon
  // Format: "[DisplayName] · [Intent/Description] [Params]"
  // - DisplayName: From toolDisplayMeta (embedded in message) or LLM-generated or fallback
  // - Intent: For MCP tools (activity.intent), for Bash (toolInput.description)
  // - Params: Remaining tool input summary
  const toolDisplay = formatToolDisplay(activity)
  const fullDisplayName = toolDisplay.name
    || (activity.type === 'thinking' ? 'Thinking' : 'Processing')

  // Detect MCP/API tools (toolName starts with "mcp__")
  const isMcpOrApiTool = activity.toolName?.startsWith('mcp__') ?? false

  // For MCP/API tools, extract source name and tool slug
  // e.g., "ClickUp: clickup_search" -> sourceName="ClickUp", toolSlug="clickup_search"
  let sourceName = fullDisplayName
  let toolSlug: string | undefined = undefined
  if (isMcpOrApiTool) {
    const colonIndex = fullDisplayName.indexOf(':')
    if (colonIndex > 0) {
      sourceName = fullDisplayName.substring(0, colonIndex).trim()
      toolSlug = fullDisplayName.substring(colonIndex + 1).trim()
    }
  }

  // For non-MCP tools or informative mode, use the appropriate display name
  const displayedName: string = isMcpOrApiTool ? sourceName : fullDisplayName

  // Intent for MCP tools, description for Bash commands
  const intentOrDescription = activity.intent || (activity.toolInput?.description as string | undefined)
  const inputSummary = formatToolInput(activity.toolInput, activity.toolName, sessionFolderPath)
  const diffStats = computeEditWriteDiffStats(activity.toolName, activity.toolInput)
  const isComplete = activity.status === 'completed' || activity.status === 'error'
  const isBackgrounded = activity.status === 'backgrounded'

  // For backgrounded tasks, show task/shell ID and elapsed time
  const backgroundInfo = isBackgrounded
    ? activity.taskId
      ? `Task ID: ${activity.taskId}${activity.elapsedSeconds ? `, ${formatDuration(activity.elapsedSeconds * 1000)} elapsed` : ''}`
      : activity.shellId
        ? `Shell ID: ${activity.shellId}${activity.elapsedSeconds ? `, ${formatDuration(activity.elapsedSeconds * 1000)} elapsed` : ''}`
        : null
    : null

  return (
    <div className="flex items-stretch">
      <TreeViewConnector depth={depth} isLastChild={isLastChild} />
      <div
        className={cn(
          "group/row flex items-center gap-2 py-0.5 text-muted-foreground flex-1 min-w-0",
          SIZE_CONFIG.fontSize
        )}
        onClick={onOpenDetails && isComplete ? onOpenDetails : undefined}
      >
        <ActivityStatusIcon status={activity.status} toolName={activity.toolName} customIcon={toolDisplay.icon} />
        {/* MCP/API tools: Source name (shrink-0) then error badge (if any) then compound label (flex-1) */}
        {isMcpOrApiTool && !isBackgrounded && (
          <>
            <span className="shrink-0">{sourceName}</span>
            {/* Error badge for MCP/API tools */}
            {activity.status === 'error' && activity.error && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className="px-1.5 py-0.5 bg-[color-mix(in_oklab,var(--destructive)_4%,var(--background))] shadow-tinted rounded-[4px] text-[10px] text-destructive font-medium cursor-default shrink-0"
                    style={{ '--shadow-color': 'var(--destructive-rgb)' } as React.CSSProperties}
                  >
                    {i18n.t('common.error')}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-[400px]">
                  {activity.error}
                </TooltipContent>
              </Tooltip>
            )}
            {/* Model badge for LLM Query */}
            {activity.toolName === 'mcp__session__call_llm' && activity.toolInput?.model && (
              <span className="px-1.5 py-0.5 bg-background shadow-minimal rounded-[4px] text-[10px] text-foreground/60 shrink-0">
                {String(activity.toolInput.model)}
              </span>
            )}
            {(intentOrDescription || (displayMode === 'detailed' && (toolSlug || inputSummary))) && (
              <span className={cn("truncate flex-1 min-w-0", onOpenDetails && isComplete && "group-hover/row:underline")}>
                {intentOrDescription && (
                  <>
                    <span className="opacity-60"> · </span>
                    <span>{intentOrDescription}</span>
                  </>
                )}
                {displayMode === 'detailed' && toolSlug && (
                  <>
                    <span className="opacity-60"> · </span>
                    <span className="opacity-70">{toolSlug}</span>
                  </>
                )}
                {displayMode === 'detailed' && inputSummary && (
                  <>
                    <span className="opacity-60"> · </span>
                    <span className="opacity-50">{inputSummary}</span>
                  </>
                )}
              </span>
            )}
          </>
        )}
        {/* Native tools: Tool name (shrink-0) */}
        {!isMcpOrApiTool && (
          <span className={cn("shrink-0", onOpenDetails && isComplete && "group-hover/row:underline")}>{displayedName}</span>
        )}
        {/* Diff stats and filename badges - after tool name */}
        {!isMcpOrApiTool && !isBackgrounded && diffStats && (
          <span className="flex items-center gap-1.5 text-[10px] shrink-0">
            {diffStats.deletions > 0 && (
              <span
                className="px-1.5 py-0.5 bg-[color-mix(in_oklab,var(--destructive)_5%,var(--background))] shadow-tinted rounded-[4px] text-destructive"
                style={{ '--shadow-color': 'var(--destructive-rgb)' } as React.CSSProperties}
              >{diffStats.deletions}</span>
            )}
            {diffStats.additions > 0 && (
              <span
                className="px-1.5 py-0.5 bg-[color-mix(in_oklab,var(--success)_5%,var(--background))] shadow-tinted rounded-[4px] text-success"
                style={{ '--shadow-color': 'var(--success-rgb)' } as React.CSSProperties}
              >{diffStats.additions}</span>
            )}
            {/* Filename badge - supports multiple edit formats */}
            {(() => {
              // file_path format
              if (typeof activity.toolInput?.file_path === 'string') {
                return (
                  <span className="px-1.5 py-0.5 bg-background shadow-minimal rounded-[4px] text-[11px] text-foreground/70">
                    {normalizePath(activity.toolInput.file_path).split('/').pop()}
                  </span>
                )
              }
              // Codex format: changes[0].path
              if (Array.isArray(activity.toolInput?.changes)) {
                const firstChange = activity.toolInput.changes[0] as { path?: string } | undefined
                if (firstChange?.path) {
                  return (
                    <span className="px-1.5 py-0.5 bg-background shadow-minimal rounded-[4px] text-[11px] text-foreground/70">
                      {normalizePath(firstChange.path).split('/').pop()}
                    </span>
                  )
                }
              }
              return null
            })()}
          </span>
        )}
        {/* Filename badge for Read tool (no diff stats) */}
        {!isMcpOrApiTool && !isBackgrounded && !diffStats && (activity.toolName === 'Read' || activity.toolName === 'read_file') && typeof activity.toolInput?.file_path === 'string' && (
          <span className="flex items-center gap-1.5 text-[10px] shrink-0">
            <span className="px-1.5 py-0.5 bg-background shadow-minimal rounded-[4px] text-[11px] text-foreground/70">
              {normalizePath(activity.toolInput.file_path).split('/').pop()}
            </span>
          </span>
        )}
        {/* Error badge for native tools */}
        {!isMcpOrApiTool && activity.status === 'error' && activity.error && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="px-1.5 py-0.5 bg-[color-mix(in_oklab,var(--destructive)_4%,var(--background))] shadow-tinted rounded-[4px] text-[10px] text-destructive font-medium cursor-default shrink-0"
                style={{ '--shadow-color': 'var(--destructive-rgb)' } as React.CSSProperties}
              >
                Error
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[400px]">
              {activity.error}
            </TooltipContent>
          </Tooltip>
        )}
        {/* Native tools: Compound label with description + params (flex-1) */}
        {/* In informative mode, hide inputSummary (command details) - only show description */}
        {!isMcpOrApiTool && !isBackgrounded && (intentOrDescription || (displayMode === 'detailed' && inputSummary)) && (
          <span className={cn("truncate flex-1 min-w-0", onOpenDetails && isComplete && "group-hover/row:underline")}>
            {intentOrDescription && (
              <>
                <span className="opacity-60"> · </span>
                <span>{intentOrDescription}</span>
              </>
            )}
            {displayMode === 'detailed' && inputSummary && (
              <>
                <span className="opacity-60"> · </span>
                <span className="opacity-50">{inputSummary}</span>
              </>
            )}
          </span>
        )}
        {/* Background task info (task/shell ID + elapsed time) */}
        {backgroundInfo && (
          <>
            <span className="opacity-60 shrink-0">·</span>
            <span className="truncate min-w-0 max-w-[300px] text-accent">{backgroundInfo}</span>
          </>
        )}
        {/* No spacer needed - both MCP/API and native tools now have flex-1 on their compound spans */}
        {/* Open details button */}
        {onOpenDetails && isComplete && (
          <div
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation()
              onOpenDetails()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation()
                onOpenDetails()
              }
            }}
            className={cn(
              "p-0.5 rounded-[3px] opacity-0 group-hover/row:opacity-100 transition-opacity shrink-0",
              "hover:bg-muted/80 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            )}
          >
            <ArrowUpRight className={SIZE_CONFIG.iconSize} />
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// Activity Group Component (for Task subagents)
// ============================================================================

interface ActivityGroupRowProps {
  group: ActivityGroup
  /** Controlled expansion state for activity groups */
  expandedGroups?: Set<string>
  /** Callback when expansion changes */
  onExpandedGroupsChange?: (groups: Set<string>) => void
  /** Callback to open activity details in Monaco */
  onOpenActivityDetails?: (activity: ActivityItem) => void
  /** Animation index for staggered animation */
  animationIndex?: number
  /** Session folder path for stripping from file paths in tool display */
  sessionFolderPath?: string
  /** Display mode: 'detailed' shows all info, 'informative' hides MCP/API names and params */
  displayMode?: 'informative' | 'detailed'
}

/**
 * Renders a Task subagent with its child activities grouped together.
 * Provides visual containment and collapsible children.
 */
function ActivityGroupRow({ group, expandedGroups: externalExpandedGroups, onExpandedGroupsChange, onOpenActivityDetails, animationIndex = 0, sessionFolderPath, displayMode = 'detailed' }: ActivityGroupRowProps) {
  // Use local state if no controlled state provided
  const [localExpandedGroups, setLocalExpandedGroups] = useState<Set<string>>(new Set())
  const expandedGroups = externalExpandedGroups ?? localExpandedGroups
  const setExpandedGroups = onExpandedGroupsChange ?? setLocalExpandedGroups

  const groupId = group.parent.id
  const isExpanded = expandedGroups.has(groupId)

  const toggleExpanded = useCallback(() => {
    const next = new Set(expandedGroups)
    if (next.has(groupId)) {
      next.delete(groupId)
    } else {
      next.add(groupId)
    }
    setExpandedGroups(next)
  }, [groupId, expandedGroups, setExpandedGroups])

  const description = group.parent.toolInput?.description as string | undefined
  const prompt = group.parent.toolInput?.prompt as string | undefined
  const subagentType = group.parent.toolInput?.subagent_type as string | undefined
  const agentTitle = description || prompt || 'Running agent'
  const childCount = group.children.length
  const isComplete = group.parent.status === 'completed' || group.parent.status === 'error'
  const hasError = group.parent.status === 'error'

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: animationIndex < SIZE_CONFIG.staggeredAnimationLimit ? animationIndex * 0.03 : 0.3 }}
      className={cn(
        "space-y-1 rounded-[7px] border px-2 py-1.5",
        "border-info/20 bg-[color-mix(in_oklab,var(--info)_4%,transparent)]",
        hasError && "border-destructive/25 bg-[color-mix(in_oklab,var(--destructive)_4%,transparent)]"
      )}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        className={cn(
          "group/row flex w-full items-center gap-2 rounded-[5px] px-0.5 py-0.5 text-left",
          "text-muted-foreground hover:text-foreground transition-colors",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          SIZE_CONFIG.fontSize
        )}
        onClick={toggleExpanded}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggleExpanded()
          }
        }}
      >
        <motion.div
          initial={false}
          animate={{ rotate: isExpanded ? 90 : 0 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
          className={cn(SIZE_CONFIG.iconSize, "flex items-center justify-center shrink-0")}
        >
          <ChevronRight className={SIZE_CONFIG.iconSize} />
        </motion.div>

        <ActivityStatusIcon status={group.parent.status} toolName={group.parent.toolName} />

        <span className="inline-flex shrink-0 items-center gap-1 rounded-[4px] bg-background px-1.5 py-0.5 text-[10px] font-medium text-foreground shadow-minimal">
          <Bot className="h-3 w-3 text-info" />
          Agent
        </span>

        {subagentType && (
          <span className="shrink-0 rounded-[4px] border border-foreground/10 bg-background/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {subagentType}
          </span>
        )}

        <span className={cn(
          "min-w-0 flex-1 truncate font-medium text-foreground/80",
          hasError && "text-destructive"
        )}>
          {agentTitle}
        </span>

        {childCount > 0 && (
          <span className="shrink-0 rounded-[4px] bg-background/70 px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground shadow-minimal">
            {childCount} steps
          </span>
        )}

        {isComplete && group.taskOutputData && (
          <span className="shrink-0 text-muted-foreground/60 tabular-nums">
            {group.taskOutputData.durationMs !== undefined && (
              <span>{formatDuration(group.taskOutputData.durationMs)}</span>
            )}
            {group.taskOutputData.durationMs !== undefined &&
              (group.taskOutputData.inputTokens !== undefined || group.taskOutputData.outputTokens !== undefined) && (
              <span className="mx-1">·</span>
            )}
            {(group.taskOutputData.inputTokens !== undefined || group.taskOutputData.outputTokens !== undefined) && (
              <span>
                {formatTokens((group.taskOutputData.inputTokens || 0) + (group.taskOutputData.outputTokens || 0))} tokens
              </span>
            )}
          </span>
        )}

        {onOpenActivityDetails && isComplete && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation()
              onOpenActivityDetails(group.parent)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation()
                onOpenActivityDetails(group.parent)
              }
            }}
            className={cn(
              "p-0.5 rounded-[3px] opacity-0 group-hover/row:opacity-100 transition-opacity shrink-0",
              "hover:bg-muted/80 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            )}
          >
            <ArrowUpRight className={SIZE_CONFIG.iconSize} />
          </span>
        )}
      </div>

      {/* Children with indentation */}
      <AnimatePresence initial={false}>
        {isExpanded && group.children.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{
              height: { duration: 0.2, ease: [0.4, 0, 0.2, 1] },
              opacity: { duration: 0.15 }
            }}
            className="overflow-hidden"
          >
            <div className="ml-6 space-y-0.5 border-l border-info/25 pl-3">
              {group.children.map((child, idx) => (
                <motion.div
                  key={child.id}
                  initial={{ opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: idx * 0.02 }}
                >
                  <ActivityRow
                    activity={{ ...child, depth: 0 }}
                    onOpenDetails={onOpenActivityDetails ? () => onOpenActivityDetails(child) : undefined}
                    isLastChild={idx === group.children.length - 1}
                    sessionFolderPath={sessionFolderPath}
                    displayMode={displayMode}
                  />
                </motion.div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

// ============================================================================
// Streaming Response Preview Component
// ============================================================================

export interface ResponseCardProps {
  /** The content to display (markdown) */
  text: string
  /** Whether the content is still streaming */
  isStreaming: boolean
  /** When streaming started - used for buffering timeout calculation */
  streamStartTime?: number
  /** Callback to open file in editor */
  onOpenFile?: (path: string) => void
  /** Callback to open URL */
  onOpenUrl?: (url: string) => void
  /** Callback to open response in Monaco editor */
  onPopOut?: () => void
  /** Card variant - 'response' for AI messages, 'plan' for plan messages */
  variant?: 'response' | 'plan'
  /** Parent session ID (used to reset local annotation/island UI state on session switches) */
  sessionId?: string
  /** Underlying message ID for annotation actions */
  messageId?: string
  /** Persisted annotations for this response */
  annotations?: AnnotationV1[]
  /** Callback when user accepts the plan (plan variant only) */
  onAccept?: () => void
  /** Callback when user accepts the plan with compaction (compact first, then execute) */
  onAcceptWithCompact?: () => void
  /** Whether this is the last response in the session (shows Accept Plan button only for last response) */
  isLastResponse?: boolean
  /** Whether to show the Accept Plan button (default: true) */
  showAcceptPlan?: boolean
  /** Hide footer for compact embedding (EditPopover) */
  compactMode?: boolean
  /** Whether to show copy/fullscreen/branch actions for the final response */
  showResponseActions?: boolean
  /** Whether to use the transparent final-response text chrome without implying actions */
  plainChrome?: boolean
  /** Callback to branch the session from this response */
  onBranch?: (options?: { newPanel?: boolean }) => void
  /** Callback to add annotation from selected text */
  onAddAnnotation?: (messageId: string, annotation: AnnotationV1) => void
  /** Callback to remove persisted annotation */
  onRemoveAnnotation?: (messageId: string, annotationId: string) => void
  /** Callback to update persisted annotation */
  onUpdateAnnotation?: (messageId: string, annotationId: string, patch: Partial<AnnotationV1>) => void
  /** Input send key behavior used by follow-up editor */
  sendMessageKey?: 'enter' | 'cmd-enter'
  /** Callback when follow-up is saved via "Save & Send" action */
  onSaveAndSendFollowUp?: (target: { messageId: string; annotationId: string; note: string; selectedText: string }) => void
  /** Whether there are active pending follow-up annotations in the session */
  hasActiveFollowUpAnnotations?: boolean
  /** External request to open a specific annotation in this response */
  openAnnotationRequest?: OpenAnnotationRequest | null
  /** Annotation interaction mode (viewer uses tooltip-only to suppress the island) */
  annotationInteractionMode?: AnnotationInteractionMode
}

interface BranchDropdownProps {
  onBranch: (options?: { newPanel?: boolean }) => void
}

function BranchDropdown({ onBranch }: BranchDropdownProps) {
  const { t } = useTranslation()
  const handleBranchClick = () => {
    onBranch({ newPanel: true })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('chat.branchOptions')}
          title={t('chat.branch')}
          className={cn(
            "p-1 rounded-[4px] transition-colors select-none",
            "text-muted-foreground hover:text-foreground hover:bg-foreground/5",
            "data-[state=open]:text-foreground data-[state=open]:bg-foreground/5",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          )}
        >
          <GitBranch className={SIZE_CONFIG.iconSize} />
        </button>
      </DropdownMenuTrigger>

      <StyledDropdownMenuContent align="end" minWidth="min-w-64" sideOffset={6}>
        <StyledDropdownMenuItem onClick={handleBranchClick} className="items-start py-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-[13px] leading-tight">{t('chat.branchFromThisMessage')}</span>
            <span className="max-w-[220px] whitespace-normal text-xs leading-tight text-muted-foreground">
              {t('chat.branchFromThisMessageDescription')}
            </span>
          </div>
        </StyledDropdownMenuItem>
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}

function ResponseActionButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  const button = (
    <button
      type="button"
      aria-label={label}
      title={label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn(
        "inline-flex size-6 items-center justify-center rounded-[5px] text-muted-foreground transition-colors",
        "hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      {children}
    </button>
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {button}
      </TooltipTrigger>
      <TooltipContent side="top">
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

const MAX_HEIGHT = 540

function clearAnnotationMarks(root: HTMLElement): void {
  const annotatedInlineCodeNodes = root.querySelectorAll<HTMLElement>('code[data-ca-annotation-inline-code="true"]')
  annotatedInlineCodeNodes.forEach((codeNode) => {
    codeNode.removeAttribute('data-ca-annotation-inline-code')
    codeNode.style.backgroundColor = ''
    codeNode.style.boxShadow = ''
  })

  const marks = root.querySelectorAll('span[data-ca-annotation-id]')
  marks.forEach(mark => {
    const parent = mark.parentNode
    if (!parent) return

    const badge = mark.querySelector('[data-ca-annotation-index]')
    if (badge) badge.remove()

    parent.replaceChild(document.createTextNode(mark.textContent || ''), mark)
    parent.normalize()
  })
}

function createAnnotationIndexBadge(index: number): HTMLSpanElement {
  const chip = document.createElement('span')
  chip.setAttribute('data-ca-annotation-index', String(index))
  chip.textContent = String(index)
  chip.style.position = 'absolute'
  chip.style.top = '-7px'
  chip.style.right = '-7px'
  chip.style.minWidth = '16px'
  chip.style.height = '15px'
  chip.style.padding = '0 3px'
  chip.style.borderRadius = '9999px'
  chip.style.backgroundColor = 'var(--info)'
  chip.style.color = 'rgba(15, 23, 42, 0.95)'
  chip.style.fontSize = '10px'
  chip.style.fontWeight = '600'
  chip.style.lineHeight = '15px'
  chip.style.textAlign = 'center'
  chip.classList.add('shadow-tinted')
  chip.style.setProperty('--shadow-color', 'var(--info-rgb)')
  chip.style.pointerEvents = 'none'
  chip.style.userSelect = 'none'
  return chip
}

function applyTextHighlightRange(
  root: HTMLElement,
  range: { start: number; end: number },
  annotation: AnnotationV1,
  annotationIndex?: number,
): void {
  if (range.end <= range.start) return

  // Avoid visually highlighting trailing/leading hard newlines.
  // Those can produce extra apparent blank lines at line boundaries.
  const fullText = getCanonicalText(root)
  let displayStart = range.start
  let displayEnd = range.end
  while (displayStart < displayEnd && /[\n\r]/.test(fullText[displayStart] ?? '')) displayStart += 1
  while (displayEnd > displayStart && /[\n\r]/.test(fullText[displayEnd - 1] ?? '')) displayEnd -= 1
  if (displayEnd <= displayStart) return

  const segments = collectTextSegments(root)
  const createdMarks: HTMLSpanElement[] = []

  for (const segment of segments) {
    if (segment.end <= displayStart || segment.start >= displayEnd) continue

    const localStart = Math.max(displayStart, segment.start) - segment.start
    const localEnd = Math.min(displayEnd, segment.end) - segment.start
    if (localEnd <= localStart) continue

    const source = segment.node
    const after = source.splitText(localEnd)
    const selected = source.splitText(localStart)

    const inlineCodeParent = selected.parentElement?.closest<HTMLElement>('code')
    if (inlineCodeParent) {
      inlineCodeParent.setAttribute('data-ca-annotation-inline-code', 'true')
      inlineCodeParent.style.backgroundColor = annotationColorToCss(annotation.style?.color)
      inlineCodeParent.style.boxShadow = 'none'
    }

    const mark = document.createElement('span')
    mark.setAttribute('data-ca-annotation-id', annotation.id)
    mark.style.backgroundColor = annotationColorToCss(annotation.style?.color)
    mark.style.borderRadius = '0'
    mark.style.padding = '0'
    mark.style.margin = '0'
    mark.style.position = 'relative'
    selected.parentNode?.replaceChild(mark, selected)
    mark.appendChild(selected)
    createdMarks.push(mark)

    // Keep reference alive for TS and clarity
    void after
  }

  if (createdMarks.length > 0) {
    type RowBucket = { top: number; marks: HTMLSpanElement[] }
    const rows: RowBucket[] = []

    for (const mark of createdMarks) {
      const rect = mark.getBoundingClientRect()
      const row = rows.find(candidate => Math.abs(candidate.top - rect.top) <= 2)
      if (row) {
        row.marks.push(mark)
      } else {
        rows.push({ top: rect.top, marks: [mark] })
      }
    }

    for (const row of rows) {
      const rowMarks = row.marks
      const first = rowMarks[0]
      const last = rowMarks[rowMarks.length - 1]
      if (!first || !last) continue

      first.style.borderTopLeftRadius = '6px'
      first.style.borderBottomLeftRadius = '6px'
      last.style.borderTopRightRadius = '6px'
      last.style.borderBottomRightRadius = '6px'
    }
  }

  if (annotationIndex != null && createdMarks.length > 0) {
    // Prefer placing the index badge on non-code marks, then choose the top-right-most
    // mark on the first visible row for stable placement.
    const nonCodeMarks = createdMarks.filter(mark => !mark.closest('code'))
    const badgePool = nonCodeMarks.length > 0 ? nonCodeMarks : createdMarks

    const preferredInitial = badgePool[0]
    if (!preferredInitial) return

    let preferredMark = preferredInitial
    let preferredRect = preferredMark.getBoundingClientRect()

    for (const mark of badgePool.slice(1)) {
      const rect = mark.getBoundingClientRect()
      const isHigherRow = rect.top < preferredRect.top - 1
      const sameRow = Math.abs(rect.top - preferredRect.top) <= 2
      const isMoreRight = rect.right > preferredRect.right

      if (isHigherRow || (sameRow && isMoreRight)) {
        preferredMark = mark
        preferredRect = rect
      }
    }

    preferredMark.appendChild(createAnnotationIndexBadge(annotationIndex))
  }
}

/**
 * ResponseCard - Unified card component for AI responses and plans
 *
 * Variants:
 * - 'response': Buffered streaming response with smart content gating
 * - 'plan': Plan message with header and Accept Plan button
 *
 * Response variant implements smart buffering:
 * - Waits for 40+ words with structure OR
 * - High-confidence patterns (code blocks, headers, lists) with lower threshold OR
 * - Timeout after 2.5 seconds
 *
 * Performance optimization: Uses throttled static snapshots instead of re-rendering
 * on every character. Content updates every 300ms during streaming, avoiding
 * expensive markdown parsing on every delta.
 */
export function ResponseCard({
  text,
  isStreaming,
  streamStartTime,
  onOpenFile,
  onOpenUrl,
  onPopOut,
  variant = 'response',
  sessionId,
  messageId,
  annotations,
  onAccept,
  onAcceptWithCompact,
  isLastResponse = true,
  showAcceptPlan = true,
  compactMode = false,
  showResponseActions = false,
  plainChrome = false,
  onBranch,
  onAddAnnotation,
  onRemoveAnnotation,
  onUpdateAnnotation,
  sendMessageKey = 'enter',
  onSaveAndSendFollowUp,
  hasActiveFollowUpAnnotations = false,
  openAnnotationRequest,
  annotationInteractionMode = 'interactive',
}: ResponseCardProps) {
  const { t } = useTranslation()
  // Throttled content for display - updates every CONTENT_THROTTLE_MS during streaming
  const [displayedText, setDisplayedText] = useState(text)
  const lastUpdateRef = useRef(Date.now())
  // Copy to clipboard state
  const [copied, setCopied] = useState(false)
  // Fullscreen state
  const [isFullscreen, setIsFullscreen] = useState(false)
  // Dark mode detection - scroll fade only shown in dark mode
  const [isDarkMode, setIsDarkMode] = useState(false)
  // Pending text selection waiting for explicit follow-up action
  const interaction = useAnnotationInteractionController()
  const {
    state: interactionState,
    setDraft: setFollowUpDraft,
    openFromSelection,
    openFollowUpFromSelection,
    openFromAnnotation,
    requestEdit,
    cancelFollowUp,
    closeAll,
    markSubmitSuccess,
    markDeleteSuccess,
    consumeExternalOpenRequest,
  } = interaction

  const pendingSelection = interactionState.pendingSelection
  const selectionMenuView = interactionState.selectionMenuView
  const followUpDraft = interactionState.followUpDraft
  const followUpMode = interactionState.followUpMode
  const activeAnnotationDetail = interactionState.activeAnnotationDetail

  const [selectionMenuShowNonce, setSelectionMenuShowNonce] = useState(0)
  const [selectionMenuTransitionConfig, setSelectionMenuTransitionConfig] = useState<IslandTransitionConfig>(
    buildAnnotationChipEntryTransition()
  )
  const [annotationOverlay, setAnnotationOverlay] = useState<{ rects: AnnotationOverlayRect[]; chips: AnnotationOverlayChip[] }>({ rects: [], chips: [] })
  const contentRef = useRef<HTMLDivElement>(null)
  const contentLayerRef = useRef<HTMLDivElement>(null)
  const lastPointerRef = useRef<PointerSnapshot | null>(null)
  const dragStartPointerRef = useRef<PointerSnapshot | null>(null)
  const selectionStartedInContentRef = useRef(false)

  const canAnnotate = canAnnotateMessage({
    hasAddAnnotationHandler: !!onAddAnnotation,
    hasMessageId: !!messageId,
    isStreaming,
  })
  const allowAnnotationIsland = annotationInteractionMode === 'interactive'

  // Detect dark mode from document class and listen for changes
  useEffect(() => {
    const checkDarkMode = () => {
      setIsDarkMode(document.documentElement.classList.contains('dark'))
    }
    checkDarkMode()

    // Observe class changes on documentElement for theme switches
    const observer = new MutationObserver(checkDarkMode)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  const closeSelectionMenu = useCallback(() => {
    closeAll()
  }, [closeAll])

  const isTargetInsideAnnotationIsland = useCallback((target: Node | null): boolean => {
    if (!target) return false
    const element = target instanceof Element ? target : target.parentElement
    if (!element) return false
    return !!element.closest('[data-ca-annotation-island="true"]')
  }, [])

  const triggerSelectionMenuEntryReplay = useCallback(() => {
    setSelectionMenuShowNonce((prev) => prev + 1)
  }, [])

  const activeMenuAnchor = useMemo(() => {
    return getAnnotationInteractionAnchor(interactionState)
  }, [interactionState])

  const selectionMenuSourceKey = useMemo(() => {
    const messageScope = messageId ?? 'no-message'
    return getAnnotationInteractionSourceKey(interactionState, messageScope)
  }, [interactionState, messageId])

  const {
    renderAnchor: selectionMenuRenderAnchor,
    renderSourceKey: selectionMenuRenderSourceKey,
    isVisible: isSelectionMenuVisible,
    openedAtRef: selectionMenuOpenedAtRef,
    handleExitComplete: handleSelectionMenuExitComplete,
    resetPresentation,
  } = useAnnotationIslandPresentation({
    anchor: activeMenuAnchor,
    sourceKey: selectionMenuSourceKey,
  })

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }, [text])

  const renderedAnnotations = useMemo(() => {
    const persisted = annotations ?? []

    if (!pendingSelection || selectionMenuView !== 'confirm-follow-up' || !messageId) {
      return persisted
    }

    if (hasExistingTextRangeAnnotation(persisted, pendingSelection.start, pendingSelection.end)) {
      return persisted
    }

    return [
      ...persisted,
      createSelectionPreviewAnnotation(messageId, pendingSelection, sessionId ?? ''),
    ]
  }, [annotations, pendingSelection, selectionMenuView, messageId])

  const activeAnnotation = useMemo(() => {
    if (!activeAnnotationDetail) return null
    return (annotations ?? []).find(annotation => annotation.id === activeAnnotationDetail.annotationId) ?? null
  }, [annotations, activeAnnotationDetail])

  useEffect(() => {
    if (!activeAnnotationDetail) return
    if (!activeAnnotation) {
      closeSelectionMenu()
    }
  }, [activeAnnotationDetail, activeAnnotation, closeSelectionMenu])

  useEffect(() => {
    const root = contentLayerRef.current
    if (!root) {
      setAnnotationOverlay({ rects: [], chips: [] })
      return
    }

    const recomputeOverlay = () => {
      clearAnnotationMarks(root)
      clearBlockAnnotationMarkers(root)

      if (!renderedAnnotations.length) {
        setAnnotationOverlay({ rects: [], chips: [] })
        return
      }

      const geometry = computeAnnotationOverlayGeometry({
        root,
        renderedAnnotations,
        persistedAnnotations: annotations,
      })

      for (const annotation of renderedAnnotations) {
        applyBlockAnnotationMarker(root, annotation)
      }

      setAnnotationOverlay({ rects: geometry.rects, chips: geometry.chips })

      if (process.env.NODE_ENV !== 'production' && geometry.unresolved.length > 0) {
        console.debug('[annotations] unresolved annotations', {
          count: geometry.unresolved.length,
          ids: geometry.unresolved.map(item => item.annotation.id),
          reasons: geometry.unresolved.map(item => item.reason),
        })
      }
    }

    recomputeOverlay()
    window.addEventListener('resize', recomputeOverlay)
    return () => {
      window.removeEventListener('resize', recomputeOverlay)
    }
  }, [annotations, renderedAnnotations, text, displayedText, isStreaming])

  useEffect(() => {
    if (!canAnnotate) {
      closeSelectionMenu()
    }
  }, [canAnnotate, closeSelectionMenu])

  useEffect(() => {
    // Session switches should fully reset local island UI state to avoid stale
    // "hot" instances suppressing entry animations in the newly focused session.
    closeSelectionMenu()
    resetPresentation()
    dragStartPointerRef.current = null
    lastPointerRef.current = null
  }, [sessionId, closeSelectionMenu, resetPresentation])

  useEffect(() => {
    if (!hasAnnotationInteraction(interactionState) || !isSelectionMenuVisible) return

    const handleSelectionChange = () => {
      if (Date.now() - selectionMenuOpenedAtRef.current < 180) {
        return
      }

      const root = contentLayerRef.current
      if (!root) {
        closeSelectionMenu()
        return
      }

      const selection = window.getSelection()
      // Keep the island open if selection was programmatically cleared by a render update.
      // This happens during streaming/DOM reconciliation and should not dismiss follow-up UI.
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return
      }

      const range = selection.getRangeAt(0)
      const common = range.commonAncestorContainer
      const commonElement = common.nodeType === Node.ELEMENT_NODE
        ? common as Element
        : common.parentElement

      // Selecting text inside the island (e.g. follow-up textarea) should not close it.
      if (commonElement && isTargetInsideAnnotationIsland(commonElement)) {
        return
      }

      if (!root.contains(common)) {
        closeSelectionMenu()
      }
    }

    document.addEventListener('selectionchange', handleSelectionChange)
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange)
    }
  }, [interactionState, isSelectionMenuVisible, closeSelectionMenu, isTargetInsideAnnotationIsland, selectionMenuOpenedAtRef])

  const handleOpenFollowUpView = useCallback(() => {
    if (!pendingSelection) return

    // Native browser selection steals typing focus from the follow-up textarea.
    // Keep semantic selection in pendingSelection and clear only the DOM selection.
    clearDomSelection()
    openFollowUpFromSelection()
  }, [pendingSelection, openFollowUpFromSelection])

  const handleRequestFollowUpEdit = useCallback(() => {
    requestEdit()
  }, [requestEdit])

  const saveFollowUp = useCallback(async (note: string): Promise<{
    messageId: string
    annotationId: string
    note: string
    selectedText: string
  } | null> => {
    const normalizedNote = note.trim()

    if (!messageId) return null

    if (activeAnnotationDetail) {
      if (!onUpdateAnnotation || !activeAnnotation) {
        closeSelectionMenu()
        return null
      }

      const existingOtherBodies = activeAnnotation.body.filter(body => body.type !== 'highlight' && body.type !== 'note')
      const nextBody: AnnotationV1['body'] = [
        { type: 'highlight' },
        ...(normalizedNote.length > 0 ? [{ type: 'note', text: normalizedNote, format: 'plain' } as const] : []),
        ...existingOtherBodies,
      ]

      const nextMeta = { ...(activeAnnotation.meta ?? {}) }
      delete nextMeta.followUp

      try {
        await Promise.resolve(onUpdateAnnotation(messageId, activeAnnotationDetail.annotationId, {
          body: nextBody,
          intent: normalizedNote.length > 0 ? 'comment' : 'highlight',
          updatedAt: Date.now(),
          meta: normalizedNote.length > 0
            ? {
                ...nextMeta,
                followUp: {
                  text: normalizedNote,
                  updatedAt: Date.now(),
                },
              }
            : (Object.keys(nextMeta).length > 0 ? nextMeta : undefined),
        }))
      } catch {
        return null
      }

      markSubmitSuccess()

      if (normalizedNote.length === 0) return null

      return {
        messageId,
        annotationId: activeAnnotationDetail.annotationId,
        note: normalizedNote,
        selectedText: extractAnnotationSelectedText(activeAnnotation, text),
      }
    }

    if (!onAddAnnotation || !pendingSelection) return null

    if (hasExistingTextRangeAnnotation(annotations, pendingSelection.start, pendingSelection.end)) {
      closeSelectionMenu()
      return null
    }

    const annotation = createTextSelectionAnnotation(messageId, pendingSelection, normalizedNote, sessionId ?? '')

    try {
      await Promise.resolve(onAddAnnotation(messageId, annotation))
    } catch {
      return null
    }

    markSubmitSuccess()
    clearDomSelection()

    if (normalizedNote.length === 0) return null

    return {
      messageId,
      annotationId: annotation.id,
      note: normalizedNote,
      selectedText: pendingSelection.selectedText,
    }
  }, [
    messageId,
    activeAnnotationDetail,
    activeAnnotation,
    onUpdateAnnotation,
    onAddAnnotation,
    pendingSelection,
    annotations,
    closeSelectionMenu,
    sessionId,
    markSubmitSuccess,
    text,
  ])

  const handleSubmitFollowUp = useCallback((note: string) => {
    void saveFollowUp(note)
  }, [saveFollowUp])

  const handleSubmitAndSendFollowUp = useCallback((note: string) => {
    void saveFollowUp(note).then((savedFollowUp) => {
      if (!savedFollowUp) return
      onSaveAndSendFollowUp?.(savedFollowUp)
    })
  }, [saveFollowUp, onSaveAndSendFollowUp])

  const handleCancelFollowUp = useAnnotationCancelRestore({
    contentRootRef: contentLayerRef,
    cancelFollowUp,
  })

  const handleOpenAnnotationDetail = useCallback((
    annotationId: string,
    index: number,
    anchorX: number,
    anchorY: number,
    mode: AnnotationIslandMode = 'view'
  ) => {
    if (!allowAnnotationIsland) return

    const annotation = (annotations ?? []).find(item => item.id === annotationId)
    const noteText = annotation ? getAnnotationNoteText(annotation) : ''

    const transition = buildAnnotationChipEntryTransition()

    setSelectionMenuTransitionConfig(transition)
    triggerSelectionMenuEntryReplay()
    openFromAnnotation({ annotationId, index, anchorX, anchorY }, noteText, mode)
  }, [allowAnnotationIsland, annotations, triggerSelectionMenuEntryReplay, openFromAnnotation])

  useEffect(() => {
    if (!allowAnnotationIsland) return

    const contentRect = contentLayerRef.current?.getBoundingClientRect()
    const fallbackAnchor = {
      x: contentRect ? contentRect.left + contentRect.width / 2 : window.innerWidth / 2,
      y: contentRect ? contentRect.top + 20 : Math.max(24, window.innerHeight * 0.2),
    }

    const consumed = consumeExternalOpenRequest(openAnnotationRequest, {
      messageId,
      annotations,
      getNoteText: getAnnotationNoteText,
      fallbackAnchor,
    })

    if (!consumed) return

    setSelectionMenuTransitionConfig(buildAnnotationChipEntryTransition())
    triggerSelectionMenuEntryReplay()
  }, [
    allowAnnotationIsland,
    openAnnotationRequest,
    messageId,
    annotations,
    consumeExternalOpenRequest,
    triggerSelectionMenuEntryReplay,
  ])

  const handleDeleteActiveAnnotation = useCallback(() => {
    if (!onRemoveAnnotation || !messageId || !activeAnnotationDetail) return

    onRemoveAnnotation(messageId, activeAnnotationDetail.annotationId)
    markDeleteSuccess()
  }, [onRemoveAnnotation, messageId, activeAnnotationDetail, markDeleteSuccess])

  const handleSelectionPointerDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    selectionStartedInContentRef.current = true
    const snapshot = {
      x: event.clientX,
      y: event.clientY,
      ts: Date.now(),
    }

    dragStartPointerRef.current = snapshot
    lastPointerRef.current = snapshot
  }, [])

  const showSelectionMenuFromCurrentSelection = useCallback(() => {
    const root = contentLayerRef.current
    if (!root) return

    requestAnimationFrame(() => {
      const selection = window.getSelection()
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        closeSelectionMenu()
        return
      }

      const range = selection.getRangeAt(0)
      if (!root.contains(range.commonAncestorContainer)) {
        closeSelectionMenu()
        return
      }

      const start = resolveNodeOffset(root, range.startContainer, range.startOffset)
      const end = resolveNodeOffset(root, range.endContainer, range.endOffset)
      if (start == null || end == null || end <= start) {
        closeSelectionMenu()
        return
      }

      const selectedText = range.toString()
      if (!selectedText || !/\S/.test(selectedText)) {
        closeSelectionMenu()
        return
      }

      if (hasExistingTextRangeAnnotation(annotations, start, end)) {
        closeSelectionMenu()
        return
      }

      const fullText = getCanonicalText(root)
      const prefix = fullText.slice(Math.max(0, start - ANNOTATION_PREFIX_SUFFIX_WINDOW), start)
      const suffix = fullText.slice(end, end + ANNOTATION_PREFIX_SUFFIX_WINDOW)

      // Prefer fragmented client rects over union bounds for wrapped selections.
      // The union rect often produces an x-axis anchor that feels detached.
      const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0)
      const pointer = lastPointerRef.current
      const hasRecentPointer = Boolean(pointer && (Date.now() - pointer.ts) <= SELECTION_POINTER_MAX_AGE_MS)
      const pointerX = hasRecentPointer && pointer ? pointer.x : null
      const pointerY = hasRecentPointer && pointer ? pointer.y : null

      let anchorRect: DOMRect
      if (rects.length > 0) {
        if (pointerY != null) {
          const rowCandidates = rects.filter(rect => pointerY >= rect.top && pointerY <= rect.bottom)

          if (rowCandidates.length > 0) {
            if (pointerX != null) {
              const xContaining = rowCandidates.filter(rect => pointerX >= rect.left && pointerX <= rect.right)
              if (xContaining.length > 0) {
                anchorRect = xContaining.reduce((best, rect) => (rect.width > best.width ? rect : best))
              } else {
                anchorRect = rowCandidates.reduce((best, rect) => {
                  const bestDistance = Math.min(Math.abs(pointerX - best.left), Math.abs(pointerX - best.right))
                  const rectDistance = Math.min(Math.abs(pointerX - rect.left), Math.abs(pointerX - rect.right))
                  return rectDistance < bestDistance ? rect : best
                })
              }
            } else {
              anchorRect = rowCandidates.reduce((best, rect) => (rect.width > best.width ? rect : best))
            }
          } else {
            anchorRect = rects.reduce((best, rect) => {
              const bestDistance = Math.abs((best.top + best.bottom) / 2 - pointerY)
              const rectDistance = Math.abs((rect.top + rect.bottom) / 2 - pointerY)
              return rectDistance < bestDistance ? rect : best
            })
          }
        } else {
          anchorRect = rects.reduce((best, rect) => (rect.top < best.top ? rect : best))
        }
      } else {
        anchorRect = range.getBoundingClientRect()
      }

      const anchorRowRects = rects.length > 0
        ? rects.filter(rect => Math.abs(rect.top - anchorRect.top) <= 2)
        : []
      const clampRects = anchorRowRects.length > 0 ? anchorRowRects : (rects.length > 0 ? rects : [anchorRect])

      const selectionMinX = Math.min(...clampRects.map(rect => rect.left))
      const selectionMaxX = Math.max(...clampRects.map(rect => rect.right))

      // Prefer mouse-release position, but clamp to the chosen anchor row so
      // multiline selections stay attached to actual text on that line.
      const anchorX = pointerX != null
        ? clamp(pointerX, selectionMinX, selectionMaxX)
        : (anchorRect.left + (anchorRect.width / 2))
      const anchorY = anchorRect.top - 8

      const transition = buildSelectionEntryTransition(dragStartPointerRef.current, pointer)

      setSelectionMenuTransitionConfig(transition)
      triggerSelectionMenuEntryReplay()
      openFromSelection({
        start,
        end,
        selectedText,
        prefix,
        suffix,
        anchorX,
        anchorY,
      })
      dragStartPointerRef.current = null
    })
  }, [annotations, closeSelectionMenu, triggerSelectionMenuEntryReplay, openFromSelection])

  const handleTextSelection = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!canAnnotate || !onAddAnnotation || !messageId) return
    const root = contentLayerRef.current
    if (!root) return

    if (shouldIgnoreSelectionMouseUpTarget(event.target)) {
      selectionStartedInContentRef.current = false
      return
    }

    // Mouseup location reflects the user's final intent for popup anchoring.
    lastPointerRef.current = {
      x: event.clientX,
      y: event.clientY,
      ts: Date.now(),
    }

    // Block annotation gesture: Shift+click on a block wrapper
    if (event.shiftKey) {
      const targetElement = event.target instanceof Element ? event.target : null
      const blockElement = targetElement?.closest<HTMLElement>('[data-ca-block-path]')
      if (blockElement) {
        const blockPath = blockElement.getAttribute('data-ca-block-path') || ''
        const blockType = blockElement.getAttribute('data-ca-block-type') || 'paragraph'
        const blockId = blockElement.getAttribute('data-ca-block-id') || undefined

        if (blockPath) {
          const alreadyExists = (annotations ?? []).some(annotation => {
            const blockSelector = annotation.target.selectors.find(s => s.type === 'block') as Extract<
              AnnotationV1['target']['selectors'][number],
              { type: 'block' }
            > | undefined
            if (!blockSelector) return false
            if (blockId && blockSelector.blockId) return blockSelector.blockId === blockId
            return blockSelector.path === blockPath
          })

          if (!alreadyExists) {
            const annotation: AnnotationV1 = {
              id: `ann-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              schemaVersion: 1,
              createdAt: Date.now(),
              intent: 'highlight',
              body: [{ type: 'highlight' }],
              target: {
                source: {
                  sessionId: '',
                  messageId,
                },
                selectors: [
                  {
                    type: 'block',
                    blockType: blockType as Extract<AnnotationV1['target']['selectors'][number], { type: 'block' }>['blockType'],
                    path: blockPath,
                    ...(blockId ? { blockId } : {}),
                  },
                ],
              },
              style: { color: 'yellow' },
            }
            onAddAnnotation(messageId, annotation)
          }
        }
      }
      selectionStartedInContentRef.current = false
      closeSelectionMenu()
      return
    }

    selectionStartedInContentRef.current = false
    showSelectionMenuFromCurrentSelection()
  }, [canAnnotate, onAddAnnotation, messageId, annotations, showSelectionMenuFromCurrentSelection, closeSelectionMenu])

  useEffect(() => {
    if (!canAnnotate || !onAddAnnotation || !messageId) return

    const handleDocumentMouseUp = (event: MouseEvent) => {
      if (!selectionStartedInContentRef.current) return
      selectionStartedInContentRef.current = false

      // Mouseup location reflects the user's final intent for popup anchoring.
      lastPointerRef.current = {
        x: event.clientX,
        y: event.clientY,
        ts: Date.now(),
      }

      const root = contentLayerRef.current
      if (!root) return

      const target = event.target as Node | null
      if (target && root.contains(target)) {
        // In-bounds mouseup is already handled by onMouseUp on the content container.
        return
      }

      showSelectionMenuFromCurrentSelection()
    }

    document.addEventListener('mouseup', handleDocumentMouseUp)
    return () => {
      document.removeEventListener('mouseup', handleDocumentMouseUp)
    }
  }, [canAnnotate, onAddAnnotation, messageId, showSelectionMenuFromCurrentSelection])

  const handleSelectionMenuRequestBack = useCallback((): boolean => {
    if (selectionMenuView !== 'compact') {
      handleCancelFollowUp()
      return true
    }

    return false
  }, [selectionMenuView, handleCancelFollowUp])

  useAnnotationIslandEvents({
    enabled: allowAnnotationIsland && hasAnnotationInteraction(interactionState) && isSelectionMenuVisible,
    openedAtRef: selectionMenuOpenedAtRef,
    isCompactView: selectionMenuView === 'compact',
    isTargetInsideAnnotationIsland,
    onBack: handleSelectionMenuRequestBack,
    onClose: closeSelectionMenu,
  })

  const selectionMenu = allowAnnotationIsland ? (
    <AnnotationIslandMenu
      anchor={selectionMenuRenderAnchor}
      sourceKey={selectionMenuRenderSourceKey}
      replayNonce={selectionMenuShowNonce}
      isVisible={isSelectionMenuVisible}
      activeView={selectionMenuView}
      mode={followUpMode}
      draft={followUpDraft}
      onDraftChange={setFollowUpDraft}
      onOpenFollowUp={handleOpenFollowUpView}
      onCancel={handleCancelFollowUp}
      onRequestBack={handleSelectionMenuRequestBack}
      onRequestEdit={handleRequestFollowUpEdit}
      onSubmit={handleSubmitFollowUp}
      onSubmitAndSend={handleSubmitAndSendFollowUp}
      onDelete={activeAnnotationDetail ? handleDeleteActiveAnnotation : undefined}
      sendMessageKey={sendMessageKey}
      transitionConfig={selectionMenuTransitionConfig}
      onExitComplete={handleSelectionMenuExitComplete}
      usePortal={shouldRenderAnnotationIslandInPortal('turncard')}
    />
  ) : null

  const annotationOverlayLayer = (
    <AnnotationOverlayLayer
      rects={annotationOverlay.rects}
      chips={annotationOverlay.chips}
      annotations={renderedAnnotations}
      getTooltipText={(annotation) => formatAnnotationFollowUpTooltipText(annotation)}
      allowChipOpen={allowAnnotationIsland}
      onChipOpen={({ annotationId, index, anchorX, anchorY, mode }) => {
        handleOpenAnnotationDetail(annotationId, index, anchorX, anchorY, mode)
      }}
    />
  )

  // Throttle content updates during streaming for performance
  // Updates immediately when streaming ends to show final content
  useEffect(() => {
    if (!isStreaming) {
      // Streaming ended - show final content immediately
      setDisplayedText(text)
      return
    }

    const now = Date.now()
    const elapsed = now - lastUpdateRef.current

    if (elapsed >= BUFFER_CONFIG.CONTENT_THROTTLE_MS) {
      // Enough time passed - update immediately
      setDisplayedText(text)
      lastUpdateRef.current = now
    } else {
      // Schedule update for remaining time
      const timeout = setTimeout(() => {
        setDisplayedText(text)
        lastUpdateRef.current = Date.now()
      }, BUFFER_CONFIG.CONTENT_THROTTLE_MS - elapsed)
      return () => clearTimeout(timeout)
    }
  }, [text, isStreaming])

  // Calculate buffering decision based on current text (not displayed text)
  const bufferDecision = useMemo(() => {
    return shouldShowContent(text, isStreaming, streamStartTime)
  }, [text, isStreaming, streamStartTime])

  const isCompleted = !isStreaming
  const isBuffering = isStreaming && !bufferDecision.shouldShow

  // While buffering, return null - TurnCard will show a subtle indicator instead
  if (isBuffering) {
    return null
  }

  // Completed response or plan.
  if (isCompleted || variant === 'plan') {
    const isPlan = variant === 'plan'
    const usePlainResponseChrome = !isPlan && (plainChrome || showResponseActions)
    const useCardChrome = !usePlainResponseChrome
    const contentFadeStyle =
      useCardChrome && isDarkMode
        ? {
            maskImage:
              'linear-gradient(to bottom, transparent 0%, black 16px, black calc(100% - 16px), transparent 100%)',
            WebkitMaskImage:
              'linear-gradient(to bottom, transparent 0%, black 16px, black calc(100% - 16px), transparent 100%)',
          }
        : {}

    return (
      <>
        <div
          className={cn(
            "relative group/response",
            useCardChrome &&
              "bg-background shadow-minimal rounded-[8px] overflow-hidden",
          )}
        >
          {/* Fullscreen button - desktop only; compact mode keeps message chrome minimal */}
          {!compactMode && isPlan && showResponseActions && (
            <button
              onClick={() => setIsFullscreen(true)}
              className={cn(
                "absolute top-2 right-2 p-1 rounded-[6px] transition-all z-10 select-none",
                "opacity-0 group-hover/response:opacity-100",
                "bg-background shadow-minimal",
                "text-muted-foreground/50 hover:text-foreground",
                "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:opacity-100",
              )}
              title={t('common.viewFullscreen')}
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          )}

          {/* Plan header - only shown for plan variant */}
          {isPlan && (
            <div
              className={cn(
                "px-4 py-2 border-b border-border/30 flex items-center gap-2 bg-success/5 select-none",
                SIZE_CONFIG.fontSize
              )}
            >
              <ListTodo className={cn(SIZE_CONFIG.iconSize, "text-success")} />
              <span className="font-medium text-success">Plan</span>
            </div>
          )}

          {/* Response content. Plain responses grow with the outer scroll; plans keep their card scroll. */}
          <div
            ref={contentRef}
            data-search-root="response"
            onMouseDown={handleSelectionPointerDown}
            onMouseUp={handleTextSelection}
            className={cn(
              "pl-[22px] pr-[16px] py-3 text-sm",
              useCardChrome && "overflow-y-auto scrollbar-hover",
            )}
            style={{
              ...(useCardChrome ? { maxHeight: MAX_HEIGHT } : {}),
              ...contentFadeStyle,
            }}
          >
            <div ref={contentLayerRef} className="relative">
              <Markdown
                mode="minimal"
                onUrlClick={onOpenUrl}
                onFileClick={onOpenFile}
              >
                {text}
              </Markdown>
              {annotationOverlayLayer}
            </div>
          </div>

          {/* Plan footer - hidden in compact mode */}
          {!compactMode && isPlan && (
            <div
              className={cn(
                "pl-4 pr-2.5 py-2 border-t border-border/30 flex items-center justify-between bg-muted/20",
                SIZE_CONFIG.fontSize,
              )}
            >
              {showResponseActions ? (
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleCopy}
                    className={cn(
                      "turn-action-btn flex items-center gap-1.5 transition-colors select-none",
                      copied ? "text-success" : "text-muted-foreground hover:text-foreground",
                      "focus:outline-none focus-visible:underline",
                    )}
                  >
                    {copied ? (
                      <>
                        <Check className={SIZE_CONFIG.iconSize} />
                        <span>{t('common.copied')}</span>
                      </>
                    ) : (
                      <>
                        <Copy className={SIZE_CONFIG.iconSize} />
                        <span>{t('common.copy')}</span>
                      </>
                    )}
                  </button>
                  {onPopOut && (
                    <button
                      onClick={onPopOut}
                      className={cn(
                        "turn-action-btn flex items-center gap-1.5 transition-colors select-none",
                        "text-muted-foreground hover:text-foreground",
                        "focus:outline-none focus-visible:underline",
                      )}
                    >
                      <FileText className={SIZE_CONFIG.iconSize} />
                      <span>Markdown</span>
                    </button>
                  )}
                </div>
              ) : (
                <div />
              )}

              {/* Right side */}
              <div className="flex items-center gap-3">
                {/* Accept Plan dropdown (plan variant only, last response) */}
                {isPlan && showAcceptPlan && onAccept && onAcceptWithCompact && (
                  <div
                    className={cn(
                      "flex items-center gap-3 transition-all duration-200",
                      isLastResponse
                        ? "opacity-100 translate-x-0"
                        : "opacity-0 translate-x-2 pointer-events-none",
                    )}
                  >
                    <AcceptPlanDropdown
                      onAccept={onAccept}
                      onAcceptWithCompact={onAcceptWithCompact}
                      acceptLabel={hasActiveFollowUpAnnotations ? t('plan.acceptAndSendFollowups') : t('plan.acceptPlan')}
                      acceptOptionLabel={hasActiveFollowUpAnnotations ? t('plan.acceptAndSendFollowups') : t('plan.accept')}
                    />
                  </div>
                )}
                {onBranch && <BranchDropdown onBranch={onBranch} />}
              </div>
            </div>
          )}

          {!compactMode && !isPlan && showResponseActions && (
            <div className="flex h-5 items-center justify-start gap-1.5 pl-[22px] pr-0.5 text-[11px] font-medium text-muted-foreground/70 opacity-0 pointer-events-none transition-opacity duration-150 select-none group-hover/response:pointer-events-auto group-hover/response:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
              <ResponseActionButton
                label={copied ? t('common.copied') : t('common.copy')}
                onClick={() => {
                  void handleCopy()
                }}
              >
                {copied ? (
                  <Check className="size-3.5 text-success" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </ResponseActionButton>
              {onPopOut && (
                <ResponseActionButton label="Markdown" onClick={onPopOut}>
                  <FileText className="size-3.5" />
                </ResponseActionButton>
              )}
              <ResponseActionButton
                label={t('common.viewFullscreen')}
                onClick={() => setIsFullscreen(true)}
              >
                <Maximize2 className="size-3.5" />
              </ResponseActionButton>
            </div>
          )}
        </div>

        {/* Fullscreen overlay for reading/annotating response and plan content. */}
        <DocumentFormattedMarkdownOverlay
          content={text}
          isOpen={isFullscreen}
          onClose={() => setIsFullscreen(false)}
          variant={isPlan ? 'plan' : undefined}
          onOpenUrl={onOpenUrl}
          onOpenFile={onOpenFile}
          sessionId={sessionId}
          messageId={messageId}
          annotations={annotations}
          onAddAnnotation={onAddAnnotation}
          onRemoveAnnotation={onRemoveAnnotation}
          onUpdateAnnotation={onUpdateAnnotation}
          sendMessageKey={sendMessageKey}
          openAnnotationRequest={openAnnotationRequest}
          isStreaming={isStreaming}
        />
        {selectionMenu}
      </>
    )
  }

  // Streaming response - show throttled content with spinner
  const usePlainStreamingChrome = plainChrome || showResponseActions
  const streamingContentFadeStyle =
    !usePlainStreamingChrome && isDarkMode
      ? {
          maskImage:
            'linear-gradient(to bottom, transparent 0%, black 16px, black calc(100% - 16px), transparent 100%)',
          WebkitMaskImage:
            'linear-gradient(to bottom, transparent 0%, black 16px, black calc(100% - 16px), transparent 100%)',
        }
      : {}

  return (
    <>
      <div
        className={cn(
          "relative group/response",
          !usePlainStreamingChrome &&
            "bg-background shadow-minimal rounded-[8px] overflow-hidden",
        )}
      >
        {/* Content area - uses displayedText (throttled) for performance */}
        <div
          ref={contentRef}
          data-search-root="response"
          onMouseDown={handleSelectionPointerDown}
          onMouseUp={handleTextSelection}
          className={cn(
            "pl-[22px] pr-4 py-3 text-sm",
            !usePlainStreamingChrome && "overflow-y-auto scrollbar-hover",
          )}
          style={{
            ...(!usePlainStreamingChrome ? { maxHeight: MAX_HEIGHT } : {}),
            ...streamingContentFadeStyle,
          }}
        >
          <div ref={contentLayerRef} className="relative">
            <Markdown
              mode="minimal"
              onUrlClick={onOpenUrl}
              onFileClick={onOpenFile}
            >
              {displayedText}
            </Markdown>
            {annotationOverlayLayer}
          </div>
        </div>

        {/* Footer - hidden in compact mode */}
        {!compactMode && (
          <div
            className={cn(
              usePlainStreamingChrome
                ? "flex h-5 items-center gap-1.5 pl-[22px] text-muted-foreground/70"
                : "px-4 py-2 border-t border-border/30 flex items-center bg-muted/20",
              SIZE_CONFIG.fontSize,
            )}
          >
            <div
              className={cn(
                "flex items-center gap-2",
                !usePlainStreamingChrome && "text-muted-foreground",
              )}
            >
              <Spinner className={SIZE_CONFIG.spinnerSize} />
              <span>Streaming...</span>
            </div>
          </div>
        )}
      </div>
      {selectionMenu}
    </>
  )
}

// ============================================================================
// TodoList Component (for TodoWrite tool visualization)
// ============================================================================

/** Status icon for a todo item - uses purple filled icon for completed */
function TodoStatusIcon({ status }: { status: TodoStatus }) {
  switch (status) {
    case 'pending':
      return <Circle className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-muted-foreground/50")} />
    case 'in_progress':
      return (
        <div className={cn(SIZE_CONFIG.iconSize, "flex items-center justify-center shrink-0")}>
          <Spinner className={SIZE_CONFIG.spinnerSize} />
        </div>
      )
    case 'completed':
      return <CircleCheck className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-accent")} />
    case 'interrupted':
      return <Ban className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-muted-foreground/50")} />
  }
}

/** Single todo row - styled like ActivityRow */
function TodoRow({ todo }: { todo: TodoItem }) {
  const displayText = todo.status === 'in_progress' && todo.activeForm
    ? todo.activeForm
    : todo.content

  return (
    <div className={cn(
      "flex items-center gap-2 py-0.5 text-muted-foreground",
      SIZE_CONFIG.fontSize,
      todo.status === 'completed' && "opacity-50"
    )}>
      <TodoStatusIcon status={todo.status} />
      <span className={cn(
        "truncate flex-1",
        todo.status === 'completed' && "line-through"
      )}>
        {displayText}
      </span>
    </div>
  )
}

interface TodoListProps {
  todos: TodoItem[]
}

/**
 * TodoList - Displays the current state of TodoWrite tool
 * Styled to blend with TurnCard activities
 */
function TodoList({ todos }: TodoListProps) {
  if (todos.length === 0) return null

  return (
    <div className="pl-4 pr-2 pt-2.5 pb-1.5 space-y-0.5 border-l-2 border-muted ml-[13px]">
      {/* Header */}
      <div className={cn("text-muted-foreground pb-1", SIZE_CONFIG.fontSize)}>
        Todo List
      </div>
      {/* Todo items */}
      {todos.map((todo, index) => (
        <motion.div
          key={`${todo.content}-${index}`}
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: index * 0.03 }}
        >
          <TodoRow todo={todo} />
        </motion.div>
      ))}
    </div>
  )
}

interface ActivitySectionProps {
  activities: ActivityItem[]
  previewText: string
  totalActivityCount: number
  isExpanded: boolean
  onToggleExpanded: () => void
  activitiesContainerRef: React.Ref<HTMLDivElement>
  hasUserToggled: React.MutableRefObject<boolean>
  hasMounted: React.MutableRefObject<boolean>
  renderActionsMenu?: () => React.ReactNode
  onOpenDetails?: () => void
  onOpenActivityDetails?: (activity: ActivityItem) => void
  onOpenMultiFileDiff?: () => void
  hasEditOrWriteActivities?: boolean
  expandedActivityGroups: Set<string>
  onExpandedActivityGroupsChange: (groups: Set<string>) => void
  sessionFolderPath?: string
  displayMode?: 'informative' | 'detailed'
  showThinking: boolean
  thinkingText: string
  todos?: TodoItem[]
}

function ActivitySection({
  activities,
  previewText,
  totalActivityCount,
  isExpanded,
  onToggleExpanded,
  activitiesContainerRef,
  hasUserToggled,
  hasMounted,
  renderActionsMenu,
  onOpenDetails,
  onOpenActivityDetails,
  onOpenMultiFileDiff,
  hasEditOrWriteActivities,
  expandedActivityGroups,
  onExpandedActivityGroupsChange,
  sessionFolderPath,
  displayMode = 'detailed',
  showThinking,
  thinkingText,
  todos,
}: ActivitySectionProps) {
  const sortedActivities = useMemo(
    () => [...activities].sort((a, b) => a.timestamp - b.timestamp),
    [activities]
  )

  const hasTaskSubagents = useMemo(
    () => sortedActivities.some(a => isParentTaskTool(a.toolName ?? '')),
    [sortedActivities]
  )

  const groupedActivities = useMemo(
    () => hasTaskSubagents ? groupActivitiesByParent(sortedActivities) : null,
    [sortedActivities, hasTaskSubagents]
  )

  const lastChildSet = useMemo(
    () => !hasTaskSubagents ? computeLastChildSet(sortedActivities) : new Set<string>(),
    [sortedActivities, hasTaskSubagents]
  )

  return (
    <div className="group select-none" data-search-exclude="true">
      <button
        onClick={onToggleExpanded}
        className={cn(
          "flex items-center gap-2 w-full pl-2.5 pr-1.5 py-1.5 rounded-[8px] text-left",
          SIZE_CONFIG.fontSize,
          "text-muted-foreground",
          "hover:bg-muted/50 transition-colors",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        )}
      >
        <motion.div
          initial={false}
          animate={{ rotate: isExpanded ? 90 : 0 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
          className={cn(SIZE_CONFIG.iconSize, "flex items-center justify-center shrink-0")}
        >
          <ChevronRight className={SIZE_CONFIG.iconSize} />
        </motion.div>

        <span className="-ml-0.5 shrink-0 px-1.5 py-0.5 rounded-[4px] bg-background shadow-minimal text-[10px] font-medium tabular-nums">
          {totalActivityCount}
        </span>

        <span className="relative flex-1 min-w-0 h-5 flex items-center">
          <AnimatePresence initial={false}>
            <motion.span
              key={previewText}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="absolute inset-0 truncate"
            >
              {previewText}
            </motion.span>
          </AnimatePresence>
        </span>

        {renderActionsMenu ? renderActionsMenu() : (
          <TurnCardActionsMenu
            onOpenDetails={onOpenDetails}
            onOpenMultiFileDiff={onOpenMultiFileDiff}
            hasEditOrWriteActivities={hasEditOrWriteActivities}
          />
        )}
      </button>

      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{
              height: { duration: 0.25, ease: [0.4, 0, 0.2, 1] },
              opacity: { duration: 0.15 }
            }}
            className="overflow-hidden"
          >
            <div
              ref={activitiesContainerRef}
              className={cn(
                "pl-4 pr-2 py-0 space-y-0.5 border-l-2 border-muted ml-[13px]",
                sortedActivities.length > SIZE_CONFIG.maxVisibleActivities && "rounded-r-md overflow-y-auto scrollbar-hover py-1.5"
              )}
              style={{
                maxHeight: sortedActivities.length > SIZE_CONFIG.maxVisibleActivities
                  ? SIZE_CONFIG.maxVisibleActivities * SIZE_CONFIG.activityRowHeight
                  : undefined
              }}
            >
              <AnimatePresence mode="sync">
                {groupedActivities ? (
                  groupedActivities.map((item, index) => (
                    isActivityGroup(item) ? (
                      <ActivityGroupRow
                        key={item.parent.id}
                        group={item}
                        expandedGroups={expandedActivityGroups}
                        onExpandedGroupsChange={onExpandedActivityGroupsChange}
                        onOpenActivityDetails={onOpenActivityDetails}
                        animationIndex={index}
                        sessionFolderPath={sessionFolderPath}
                        displayMode={displayMode}
                      />
                    ) : (
                      <motion.div
                        key={item.id}
                        initial={
                          hasUserToggled.current || hasMounted.current
                            ? { opacity: 0, x: -8 }
                            : false
                        }
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: hasUserToggled.current ? (index < SIZE_CONFIG.staggeredAnimationLimit ? index * 0.03 : SIZE_CONFIG.staggeredAnimationLimit * 0.03) : 0 }}
                      >
                        <ActivityRow
                          activity={item}
                          onOpenDetails={onOpenActivityDetails ? () => onOpenActivityDetails(item) : undefined}
                          sessionFolderPath={sessionFolderPath}
                          displayMode={displayMode}
                        />
                      </motion.div>
                    )
                  ))
                ) : (
                  sortedActivities.map((activity, index) => (
                    <motion.div
                      key={activity.id}
                      initial={
                        hasUserToggled.current || hasMounted.current
                          ? { opacity: 0, x: -8 }
                          : false
                      }
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: hasUserToggled.current ? (index < SIZE_CONFIG.staggeredAnimationLimit ? index * 0.03 : SIZE_CONFIG.staggeredAnimationLimit * 0.03) : 0 }}
                    >
                      <ActivityRow
                        activity={activity}
                        onOpenDetails={onOpenActivityDetails ? () => onOpenActivityDetails(activity) : undefined}
                        isLastChild={lastChildSet.has(activity.id)}
                        sessionFolderPath={sessionFolderPath}
                        displayMode={displayMode}
                      />
                    </motion.div>
                  ))
                )}

                {showThinking && (
                  <motion.div
                    key="thinking"
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{
                      delay: Math.min(sortedActivities.length, SIZE_CONFIG.staggeredAnimationLimit) * 0.03,
                      duration: 0.3,
                      ease: "easeOut"
                    }}
                    className={cn("flex items-center gap-2 py-0.5 text-muted-foreground/70", SIZE_CONFIG.fontSize)}
                  >
                    <Spinner className={SIZE_CONFIG.spinnerSize} />
                    <span>{thinkingText}</span>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {todos && todos.length > 0 && (
              <TodoList todos={todos} />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * TurnCard - Email-like display for one assistant turn
 *
 * Batches all activities (tools, thinking) into a collapsible section
 * with the final response displayed separately below.
 *
 * Memoized to prevent re-renders of completed turns during session switches.
 * Only complete, non-streaming turns are memoized - active turns always re-render.
 */
export const TurnCard = React.memo(function TurnCard({
  sessionId,
  turnId,
  activities,
  response,
  intent,
  isStreaming,
  isComplete,
  defaultExpanded = false,
  isExpanded: externalIsExpanded,
  onExpandedChange,
  expandedActivityGroups: externalExpandedActivityGroups,
  onExpandedActivityGroupsChange,
  onOpenFile,
  onOpenUrl,
  onPopOut,
  onOpenDetails,
  onOpenActivityDetails,
  onOpenMultiFileDiff,
  hasEditOrWriteActivities,
  todos,
  renderActionsMenu,
  onAcceptPlan,
  onAcceptPlanWithCompact,
  isLastResponse,
  sessionFolderPath,
  displayMode = 'detailed',
  animateResponse = false,
  compactMode = false,
  onBranch,
  onAddAnnotation,
  onRemoveAnnotation,
  onUpdateAnnotation,
  sendMessageKey = 'enter',
  onSaveAndSendFollowUp,
  hasActiveFollowUpAnnotations = false,
  openAnnotationRequest,
  annotationInteractionMode = 'interactive',
}: TurnCardProps) {
  // Derive the turn phase from props using the state machine.
  // This provides a single source of truth for lifecycle state,
  // replacing the old ad-hoc boolean combinations.
  const turnPhase = useMemo(() => {
    // Construct a minimal turn-like object for deriveTurnPhase
    const turnData: Pick<AssistantTurn, 'isComplete' | 'response' | 'activities'> = {
      isComplete,
      response,
      activities,
    }
    return deriveTurnPhase(turnData as AssistantTurn)
  }, [isComplete, response, activities])

  const shouldDefaultExpandSections = externalIsExpanded ?? defaultExpanded
  const [expandedActivitySectionIds, setExpandedActivitySectionIds] = useState<Set<string>>(new Set())
  const hasInitializedActivitySections = useRef(false)

  // Track if user has toggled expansion (skip animation on initial mount)
  const hasUserToggled = useRef(false)

  // Ref for scrollable activities container (to scroll to bottom on expand)
  const activitiesContainerRef = useRef<HTMLDivElement>(null)

  // Track if component has mounted (enable fade-in for new activities after mount)
  const hasMounted = useRef(false)
  useEffect(() => {
    hasMounted.current = true
  }, [])

  useEffect(() => {
    hasInitializedActivitySections.current = false
    hasUserToggled.current = false
    setExpandedActivitySectionIds(new Set())
  }, [sessionId, turnId])

  // Use local state for activity groups if no controlled state provided
  const [localExpandedActivityGroups, setLocalExpandedActivityGroups] = useState<Set<string>>(new Set())
  const expandedActivityGroups = externalExpandedActivityGroups ?? localExpandedActivityGroups
  const handleExpandedActivityGroupsChange = onExpandedActivityGroupsChange ?? setLocalExpandedActivityGroups

  // Check if response is in buffering state
  // No polling needed - parent updates trigger re-evaluation naturally
  const isBuffering = useMemo(
    () => isResponseBuffering(response),
    [response]
  )


  // Sort activities by timestamp for correct chronological order
  // This handles the live streaming case (turn-utils sorts on flush for completed turns)
  const allSortedActivities = useMemo(
    () => [...activities].sort((a, b) => a.timestamp - b.timestamp),
    [activities]
  )

  const timelineItems = useMemo(
    () => buildTurnTimelineItems(allSortedActivities, isBuffering ? undefined : response),
    [allSortedActivities, isBuffering, response]
  )

  const { detailItems, finalResponseItem } = useMemo(
    () => splitTimelineAtFinalResponse(timelineItems),
    [timelineItems]
  )
  const shouldCollapseCompletedDetails = isComplete
    && !animateResponse
    && !!finalResponseItem
    && !finalResponseItem.response.isStreaming
    && detailItems.length > 0
  const processedDuration = useMemo(
    () => formatProcessedDuration(getProcessedDurationMs(detailItems, finalResponseItem)),
    [detailItems, finalResponseItem]
  )
  const [isProcessedDetailsExpanded, setIsProcessedDetailsExpanded] = useState(false)

  useEffect(() => {
    setIsProcessedDetailsExpanded(false)
  }, [sessionId, turnId])

  const activitySectionItems = useMemo(
    () => timelineItems.filter(item => item.type === 'activity-section'),
    [timelineItems]
  )
  const activitySectionIds = useMemo(
    () => activitySectionItems.map(item => item.id),
    [activitySectionItems]
  )
  useEffect(() => {
    setExpandedActivitySectionIds(prev => {
      const validIds = new Set(activitySectionIds)
      const next = new Set([...prev].filter(id => validIds.has(id)))

      if (!hasInitializedActivitySections.current) {
        hasInitializedActivitySections.current = true
        return shouldDefaultExpandSections ? new Set(activitySectionIds) : next
      }

      if (!hasUserToggled.current) {
        return shouldDefaultExpandSections ? new Set(activitySectionIds) : new Set()
      }

      return next
    })
  }, [activitySectionIds, shouldDefaultExpandSections])

  const toggleActivitySection = useCallback((sectionId: string) => {
    hasUserToggled.current = true
    setExpandedActivitySectionIds(prev => {
      const next = new Set(prev)
      if (next.has(sectionId)) {
        next.delete(sectionId)
      } else {
        next.add(sectionId)
      }
      return next
    })
  }, [])

  useEffect(() => {
    if (hasUserToggled.current && onExpandedChange) {
      onExpandedChange(expandedActivitySectionIds.size > 0)
    }
  }, [expandedActivitySectionIds, onExpandedChange])

  // Scroll to bottom of the most recently mounted expanded activity list.
  useEffect(() => {
    if (expandedActivitySectionIds.size > 0 && hasUserToggled.current && activitiesContainerRef.current) {
      const timer = setTimeout(() => {
        activitiesContainerRef.current?.scrollTo({
          top: activitiesContainerRef.current.scrollHeight,
          behavior: 'smooth'
        })
      }, 260)
      return () => clearTimeout(timer)
    }
  }, [expandedActivitySectionIds])

  // Don't render if nothing to show and turn is complete
  if (activities.length === 0 && !response && isComplete) {
    return null
  }

  // Don't render turns that were interrupted before any meaningful work happened.
  // Hide the turn if:
  // - All tool activities are errors (nothing completed successfully)
  // - Any intermediate activities have no meaningful content (empty or just whitespace)
  // - No response text to show
  // - No plan activities
  // The "Response interrupted" info banner alone is sufficient feedback.
  const hasNoMeaningfulWork = activities.length > 0
    && activities.every(a => {
      // Tool activities must be errors (interrupted/failed)
      if (a.type === 'tool') return a.status === 'error'
      // Intermediate activities must have no meaningful content
      if (a.type === 'intermediate') return !a.content?.trim()
      // Plan activities are meaningful work
      if (a.type === 'plan') return false
      // Other activity types - consider as no meaningful work
      return true
    })
    && !response
  if (hasNoMeaningfulWork) {
    return null
  }

  const hasActivitySections = activitySectionItems.length > 0
  const firstActivitySectionId = activitySectionItems[0]?.id
  const lastActivitySectionId = activitySectionItems.at(-1)?.id
  const planItems = timelineItems.filter(item => item.type === 'plan')
  const lastPlanItemId = planItems.at(-1)?.id

  // Determine if thinking indicator should show using the phase-based state machine.
  // This properly handles the "gap" state (awaiting) between tool completion and next action,
  // which was previously causing the turn card to "disappear".
  const isThinking = shouldShowThinkingIndicator(turnPhase, isBuffering)
  const thinkingText = isBuffering ? 'Preparing response...' : 'Thinking...'

  const renderPlanCard = (planActivity: ActivityItem) => (
    <ResponseCard
      text={planActivity.content || ''}
      isStreaming={false}
      sessionId={sessionId}
      onOpenFile={onOpenFile}
      onOpenUrl={onOpenUrl}
      onPopOut={onPopOut ? () => onPopOut(planActivity.content || '') : undefined}
      variant="plan"
      messageId={planActivity.messageId}
      annotations={planActivity.annotations}
      onAddAnnotation={onAddAnnotation}
      onRemoveAnnotation={onRemoveAnnotation}
      onUpdateAnnotation={onUpdateAnnotation}
      onSaveAndSendFollowUp={onSaveAndSendFollowUp}
      onAccept={onAcceptPlan}
      onAcceptWithCompact={onAcceptPlanWithCompact}
      isLastResponse={isLastResponse && planActivity.id === lastPlanItemId}
      compactMode={compactMode}
      onBranch={onBranch ? (options?: { newPanel?: boolean }) => onBranch(planActivity.messageId ?? planActivity.id, options) : undefined}
      sendMessageKey={sendMessageKey}
      hasActiveFollowUpAnnotations={hasActiveFollowUpAnnotations}
      openAnnotationRequest={openAnnotationRequest}
      annotationInteractionMode={annotationInteractionMode}
    />
  )

  const renderResponseCard = (responseContent: ResponseContent) => (
    <ResponseCard
      text={responseContent.text}
      isStreaming={responseContent.isStreaming}
      streamStartTime={responseContent.streamStartTime}
      sessionId={sessionId}
      onOpenFile={onOpenFile}
      onOpenUrl={onOpenUrl}
      onPopOut={onPopOut ? () => onPopOut(responseContent.text) : undefined}
      variant={responseContent.isPlan ? 'plan' : 'response'}
      messageId={responseContent.messageId}
      annotations={responseContent.annotations}
      onAddAnnotation={onAddAnnotation}
      onRemoveAnnotation={onRemoveAnnotation}
      onUpdateAnnotation={onUpdateAnnotation}
      onSaveAndSendFollowUp={onSaveAndSendFollowUp}
      onAccept={onAcceptPlan}
      onAcceptWithCompact={onAcceptPlanWithCompact}
      isLastResponse={isLastResponse}
      compactMode={compactMode}
      plainChrome
      showResponseActions
      onBranch={onBranch && responseContent.messageId ? (options?: { newPanel?: boolean }) => onBranch(responseContent.messageId!, options) : undefined}
      sendMessageKey={sendMessageKey}
      hasActiveFollowUpAnnotations={hasActiveFollowUpAnnotations}
      openAnnotationRequest={openAnnotationRequest}
      annotationInteractionMode={annotationInteractionMode}
    />
  )

  const renderTimelineItem = (item: TurnTimelineItem) => {
    if (item.type === 'commentary') {
      return (
        <div key={item.id} className="select-text">
          <ResponseCard
            text={item.activity.content || ''}
            isStreaming={false}
            plainChrome
            showResponseActions={false}
          />
        </div>
      )
    }

    if (item.type === 'activity-section') {
      return (
        <ActivitySection
          key={item.id}
          activities={item.activities}
          previewText={getPreviewText(
            item.activities,
            item.id === firstActivitySectionId ? intent : undefined,
            isStreaming,
            false,
            isComplete
          )}
          totalActivityCount={item.activities.length}
          isExpanded={expandedActivitySectionIds.has(item.id)}
          onToggleExpanded={() => toggleActivitySection(item.id)}
          activitiesContainerRef={activitiesContainerRef}
          hasUserToggled={hasUserToggled}
          hasMounted={hasMounted}
          renderActionsMenu={renderActionsMenu}
          onOpenDetails={onOpenDetails}
          onOpenActivityDetails={onOpenActivityDetails}
          onOpenMultiFileDiff={onOpenMultiFileDiff}
          hasEditOrWriteActivities={hasEditOrWriteActivities}
          expandedActivityGroups={expandedActivityGroups}
          onExpandedActivityGroupsChange={handleExpandedActivityGroupsChange}
          sessionFolderPath={sessionFolderPath}
          displayMode={displayMode}
          showThinking={isThinking && !animateResponse && item.id === lastActivitySectionId}
          thinkingText={thinkingText}
          todos={item.id === lastActivitySectionId ? todos : undefined}
        />
      )
    }

    if (item.type === 'plan') {
      return (
        <div key={item.id} className="select-text">
          {renderPlanCard(item.activity)}
        </div>
      )
    }

    if (animateResponse) {
      return (
        <AnimatePresence key={item.id}>
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="select-text"
          >
            {renderResponseCard(item.response)}
          </motion.div>
        </AnimatePresence>
      )
    }

    return (
      <div key={item.id} className="select-text">
        {renderResponseCard(item.response)}
      </div>
    )
  }

  return (
    <div className="space-y-1">
      {shouldCollapseCompletedDetails ? (
        <>
          <ProcessedDetailsDisclosure
            duration={processedDuration}
            isExpanded={isProcessedDetailsExpanded}
            onToggle={() => setIsProcessedDetailsExpanded(expanded => !expanded)}
          >
            {detailItems.map(renderTimelineItem)}
          </ProcessedDetailsDisclosure>
          {renderTimelineItem(finalResponseItem!)}
        </>
      ) : (
        timelineItems.map(renderTimelineItem)
      )}

      {!hasActivitySections && isThinking && !animateResponse && (
        <div className={cn("flex items-center gap-2 px-3 py-1.5 text-muted-foreground", SIZE_CONFIG.fontSize)}>
          <Spinner className={SIZE_CONFIG.spinnerSize} />
          <span>{thinkingText}</span>
        </div>
      )}
    </div>
  )
}, (prev, next) => {
  // Conservative memoization: only skip re-render for completed, non-streaming turns
  // Active turns (streaming or incomplete) always re-render to show updates

  // Always re-render streaming turns
  if (prev.isStreaming || next.isStreaming) return false

  // Always re-render incomplete turns
  if (!prev.isComplete || !next.isComplete) return false

  // Re-render if expansion state changed
  if (prev.isExpanded !== next.isExpanded) return false
  if (prev.expandedActivityGroups !== next.expandedActivityGroups) return false

  // Re-render if isLastResponse changed (for Accept Plan button visibility)
  if (prev.isLastResponse !== next.isLastResponse) return false

  // Re-render if displayMode changed
  if (prev.displayMode !== next.displayMode) return false

  // Re-render if annotation interaction mode changed (interactive vs tooltip-only)
  if (prev.annotationInteractionMode !== next.annotationInteractionMode) return false

  // Re-render if activities changed (important for playground/testing scenarios)
  if (prev.activities !== next.activities) return false

  // Re-render when response object changes (e.g., annotation updates)
  if (prev.response !== next.response) return false

  // Re-render when external annotation-open requests change
  if (prev.openAnnotationRequest !== next.openAnnotationRequest) return false

  // Re-render when active follow-up annotation state changes (plan CTA label)
  if (prev.hasActiveFollowUpAnnotations !== next.hasActiveFollowUpAnnotations) return false

  // For complete, non-streaming turns: skip re-render only when both
  // session and turn identities match. Prevents stale local UI state from
  // leaking across session switches that may reuse turn IDs/components.
  return prev.sessionId === next.sessionId && prev.turnId === next.turnId
})
