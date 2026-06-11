/**
 * Playground Adapters for Input Components
 *
 * Provides mock data generators and wrapper components that allow
 * the main app's input components to work in the playground context.
 */

import type { PermissionRequest } from '../../../shared/types'
import type { AdminApprovalRequestData } from '@/components/app-shell/input/structured/AdminApprovalRequest'

// ============================================================================
// Mock Data Generators
// ============================================================================

/**
 * Generate mock PermissionRequest data for playground
 */
export function mockPermissionRequest(overrides?: Partial<PermissionRequest>): PermissionRequest {
  return {
    requestId: 'mock-permission-1',
    sessionId: 'mock-session',
    toolName: 'Bash',
    description: 'Execute a shell command to list files in the current directory',
    command: 'ls -la /Users/demo/projects',
    ...overrides,
  }
}

/**
 * Generate mock AdminApprovalRequest data for playground
 */
export function mockAdminApprovalRequest(overrides?: Partial<AdminApprovalRequestData>): AdminApprovalRequestData {
  return {
    appName: 'Docker Desktop',
    reason: 'Homebrew needs admin access to complete post-install steps.',
    command: 'brew install --cask docker',
    impact: 'May install files in /Applications and system-managed directories.',
    requiresSystemPrompt: true,
    rememberForMinutes: 10,
    ...overrides,
  }
}


// ============================================================================
// Playground Wrapper Props
// ============================================================================

/**
 * Props for PermissionRequest in playground context
 */
export interface PermissionRequestPlaygroundProps {
  toolName?: string
  description?: string
  command?: string
  onAction?: () => void
  unstyled?: boolean
}

/**
 * Props for AdminApprovalRequest in playground context
 */
export interface AdminApprovalRequestPlaygroundProps {
  appName?: string
  reason?: string
  command?: string
  impact?: string
  requiresSystemPrompt?: boolean
  rememberForMinutes?: number
  onAction?: () => void
  unstyled?: boolean
}


// ============================================================================
// Adapter Functions
// ============================================================================

/**
 * Convert playground props to PermissionRequest type
 */
export function toPermissionRequest(props: PermissionRequestPlaygroundProps): PermissionRequest {
  return mockPermissionRequest({
    toolName: props.toolName,
    description: props.description,
    command: props.command,
  })
}


/**
 * Create a no-op response handler that calls onAction
 */
export function createNoOpHandler<T>(onAction?: () => void): (response: T) => void {
  return () => {
    onAction?.()
  }
}
