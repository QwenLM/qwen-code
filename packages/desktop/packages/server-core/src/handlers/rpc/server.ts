import { existsSync } from 'node:fs'
import { join } from 'path'
import { homedir } from 'os'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { addWorkspace, setActiveWorkspace } from '@craft-agent/shared/config'
import { getDefaultWorkspacesDir, ensureDefaultWorkspacesDir } from '@craft-agent/shared/workspaces'
import type { ServerStatus, ServerHealth } from '@craft-agent/core/types'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import type { ServerHandlerContext } from '../../bootstrap/headless-start'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.server.GET_WORKSPACES,
  RPC_CHANNELS.server.CREATE_WORKSPACE,
  RPC_CHANNELS.server.GET_STATUS,
  RPC_CHANNELS.server.GET_HEALTH,
  RPC_CHANNELS.server.GET_ACTIVE_SESSIONS,
  RPC_CHANNELS.server.HOME_DIR,
] as const

export function registerServerHandlers(
  server: RpcServer,
  deps: HandlerDeps,
  ctx: ServerHandlerContext,
): void {
  const { sessionManager } = deps

  // -----------------------------------------------------------------------
  // Workspace discovery (moved from workspace.ts — server-level, no workspace context)
  // -----------------------------------------------------------------------

  server.handle(RPC_CHANNELS.server.GET_WORKSPACES, async () => {
    const workspaces = sessionManager.getWorkspacesInfo()
    deps.platform.logger.info(`[server:getWorkspaces] returning ${workspaces.length} workspaces: ${JSON.stringify(workspaces.map(w => ({ id: w.id, name: w.name })))}`)
    return workspaces
  })

  server.handle(RPC_CHANNELS.server.CREATE_WORKSPACE, async (_ctx, name: string) => {
    if (!name?.trim()) throw new Error('Workspace name is required')
    const trimmed = name.trim()

    const slug = trimmed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      || 'workspace'

    ensureDefaultWorkspacesDir()
    const baseDir = getDefaultWorkspacesDir()
    let rootPath = join(baseDir, slug)
    let uniqueSlug = slug
    let counter = 1
    while (existsSync(rootPath)) {
      uniqueSlug = `${slug}-${counter++}`
      rootPath = join(baseDir, uniqueSlug)
    }

    const workspace = addWorkspace({ name: trimmed, rootPath })
    setActiveWorkspace(workspace.id)
    deps.platform.logger.info(`Created workspace "${trimmed}" at ${rootPath} (server:createWorkspace)`)

    const { rootPath: _rp, createdAt: _ca, ...info } = workspace
    return info
  })

  // -----------------------------------------------------------------------
  // Server Status
  // -----------------------------------------------------------------------

  server.handle(RPC_CHANNELS.server.GET_STATUS, async () => {
    const workspaces = sessionManager.getWorkspacesInfo()
    const workspaceStatuses = workspaces.map(ws => {
      const summary = sessionManager.getWorkspaceAutomationSummary(ws.id)
      return {
        id: ws.id,
        name: ws.name,
        slug: ws.slug,
        activeSessions: sessionManager.getActiveSessionCount(ws.id),
        automationCount: summary.automationCount,
        schedulerRunning: summary.schedulerRunning,
      }
    })

    const mem = process.memoryUsage()
    const status: ServerStatus = {
      serverId: ctx.serverId,
      version: deps.platform.appVersion,
      uptime: Math.round((Date.now() - ctx.startedAt) / 1000),
      connectedClients: ctx.getConnectedClientCount(),
      workspaces: workspaceStatuses,
      memory: {
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        rss: mem.rss,
      },
    }

    return status
  })

  // -----------------------------------------------------------------------
  // Server Health
  // -----------------------------------------------------------------------

  server.handle(RPC_CHANNELS.server.GET_HEALTH, async () => {
    return getHealthCheck(deps)
  })

  // -----------------------------------------------------------------------
  // Active Session Discovery
  // -----------------------------------------------------------------------

  server.handle(RPC_CHANNELS.server.GET_ACTIVE_SESSIONS, async () => {
    return sessionManager.getActiveSessionsInfo()
  })

  // -----------------------------------------------------------------------
  // Server Home Directory (REMOTE_ELIGIBLE — returns this server's home)
  // -----------------------------------------------------------------------

  server.handle(RPC_CHANNELS.server.HOME_DIR, async () => {
    return homedir()
  })
}

// ---------------------------------------------------------------------------
// Health check logic (reusable by both RPC handler and HTTP endpoint)
// ---------------------------------------------------------------------------

export function getHealthCheck(deps: Pick<HandlerDeps, 'sessionManager'>): ServerHealth {
  const checks: ServerHealth['checks'] = []

  // Check 1: SessionManager is operational (has loaded workspaces)
  try {
    const workspaces = deps.sessionManager.getWorkspaces()
    checks.push({
      name: 'session_manager',
      status: 'pass',
      message: `${workspaces.length} workspace(s) loaded`,
    })
  } catch {
    checks.push({
      name: 'session_manager',
      status: 'fail',
      message: 'SessionManager not initialized',
    })
  }

  // Check 2: Memory usage (warn if heap exceeds 1.5GB)
  const mem = process.memoryUsage()
  const heapGB = mem.heapUsed / (1024 * 1024 * 1024)
  checks.push({
    name: 'memory',
    status: heapGB < 1.5 ? 'pass' : 'fail',
    message: `Heap: ${Math.round(heapGB * 100) / 100} GB`,
  })

  // Aggregate status
  const allPass = checks.every(c => c.status === 'pass')
  const anyFail = checks.some(c => c.status === 'fail')

  return {
    status: allPass ? 'ok' : anyFail ? 'unhealthy' : 'degraded',
    checks,
  }
}
