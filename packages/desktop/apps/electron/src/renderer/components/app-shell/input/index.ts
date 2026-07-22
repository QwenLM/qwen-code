// Main components
export { InputContainer } from './InputContainer'
export { ChatInputZone } from './ChatInputZone'
export { FreeFormInput } from './FreeFormInput'
export { StructuredInput } from './StructuredInput'
export { GoalStatusBar } from './GoalStatusBar'
export type { GoalStatusBarLabels } from './GoalStatusBar'

// Structured input components
export { PermissionRequest } from './structured/PermissionRequest'

// Hooks
export { useAutoGrow } from './useAutoGrow'

// Types
export type {
  InputMode,
  StructuredInputType,
  StructuredInputState,
  StructuredInputData,
  StructuredResponse,
  PermissionResponse,
  AdminApprovalResponse,
  AskUserQuestionResponse,
} from './structured/types'
