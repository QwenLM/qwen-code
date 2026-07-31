/**
 * Server-level types for headless server operations.
 *
 * These types are used by the `server:` RPC namespace for
 * server status, health checks, active session discovery,
 * and headless configuration bootstrap.
 */

// ---------------------------------------------------------------------------
// Server Status & Health
// ---------------------------------------------------------------------------

export interface ServerStatus {
  serverId: string
  version: string
  uptime: number              // seconds since bootstrap
  connectedClients: number
  workspaces: {
    id: string
    name: string
    slug: string
    activeSessions: number
    automationCount: number
    schedulerRunning: boolean
  }[]
  memory: {
    heapUsed: number          // bytes
    heapTotal: number
    rss: number
  }
}

export interface ServerHealth {
  status: 'ok' | 'degraded' | 'unhealthy'
  checks: {
    name: string
    status: 'pass' | 'fail'
    message?: string
  }[]
}

// ---------------------------------------------------------------------------
// Active Session Discovery
// ---------------------------------------------------------------------------

/** Session processing state — typed union, not stringly. */
export type SessionProcessingStatus =
  | 'idle'
  | 'processing'
  | 'waiting_input'
  | 'error'
  | 'completed'

/** Server-level active session info (cross-workspace, client-safe). */
export interface ActiveSessionInfo {
  sessionId: string
  workspaceId: string
  workspaceName: string
  title?: string
  status: SessionProcessingStatus
  triggeredBy?: {
    automationName: string
    timestamp: number
  }
  createdAt: number
}

