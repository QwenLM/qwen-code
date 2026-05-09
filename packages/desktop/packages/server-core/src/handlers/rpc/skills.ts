import { dirname, join } from 'path'
import { existsSync, readdirSync, statSync } from 'fs'
import { RPC_CHANNELS, type SkillFile } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import type { LoadedSkill } from '@craft-agent/shared/skills/types'
import type { AvailableSkillDetail } from '@craft-agent/core/types'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.skills.GET,
  RPC_CHANNELS.skills.GET_FILES,
  RPC_CHANNELS.skills.DELETE,
  RPC_CHANNELS.skills.OPEN_EDITOR,
  RPC_CHANNELS.skills.OPEN_FINDER,
] as const

function providerSkillFromDetail(detail: AvailableSkillDetail): LoadedSkill {
  const skillDir = detail.filePath ? dirname(detail.filePath) : ''

  return {
    slug: detail.name,
    metadata: {
      name: detail.name,
      description: detail.description ?? 'Qwen Code skill',
    },
    content: detail.body ?? '',
    path: skillDir,
    source: 'provider',
  }
}

function providerSkillFromName(name: string, description?: string): LoadedSkill {
  return providerSkillFromDetail({
    name,
    ...(description !== undefined ? { description } : {}),
  })
}

async function shouldLoadSkillsFromQwenAcp(workspaceRootPath: string): Promise<boolean> {
  const { loadWorkspaceConfig } = await import('@craft-agent/shared/workspaces')
  const { getDefaultLlmConnection, getLlmConnection, QWEN_CODE_CONNECTION_SLUG } = await import('@craft-agent/shared/config')

  const workspaceConfig = loadWorkspaceConfig(workspaceRootPath)
  const connectionSlug = workspaceConfig?.defaults?.defaultLlmConnection ?? getDefaultLlmConnection() ?? undefined
  if (!connectionSlug) return false

  const connection = getLlmConnection(connectionSlug)
  return connectionSlug === QWEN_CODE_CONNECTION_SLUG || connection?.providerType === 'qwen'
}

export function registerSkillsHandlers(server: RpcServer, deps: HandlerDeps): void {
  // Get all skills for a workspace (and optionally project-level skills from workingDirectory)
  server.handle(RPC_CHANNELS.skills.GET, async (_ctx, workspaceId: string, workingDirectory?: string) => {
    deps.platform.logger?.info(`SKILLS_GET: Loading skills for workspace: ${workspaceId}${workingDirectory ? `, workingDirectory: ${workingDirectory}` : ''}`)
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      deps.platform.logger?.error(`SKILLS_GET: Workspace not found: ${workspaceId}`)
      return []
    }
    // Validate workingDirectory exists on this server — a thin client may pass
    // its local path which doesn't exist on the remote server's filesystem.
    const effectiveWorkingDir = workingDirectory && existsSync(workingDirectory)
      ? workingDirectory
      : undefined

    if (await shouldLoadSkillsFromQwenAcp(workspace.rootPath)) {
      const result = await deps.sessionManager.refreshAvailableCommands(`skills-discovery:${workspaceId}`, {
        workspaceId,
        workingDirectory: effectiveWorkingDir,
      })
      if (!result.success) {
        deps.platform.logger?.warn(`SKILLS_GET: Qwen ACP skill discovery failed for ${workspaceId}: ${result.error ?? 'unknown error'}`)
        return []
      }

      const commandDescriptions = new Map(
        (result.availableCommands ?? []).map(command => [command.name, command.description]),
      )
      const skills = result.availableSkillDetails?.length
        ? result.availableSkillDetails.map(providerSkillFromDetail)
        : (result.availableSkills ?? []).map(name =>
          providerSkillFromName(name, commandDescriptions.get(name)),
        )
      deps.platform.logger?.info(`SKILLS_GET: Loaded ${skills.length} skills from Qwen ACP for ${workspaceId}`)
      return skills
    }

    const { loadAllSkills } = await import('@craft-agent/shared/skills')
    const skills = loadAllSkills(workspace.rootPath, effectiveWorkingDir)
    deps.platform.logger?.info(`SKILLS_GET: Loaded ${skills.length} skills from ${workspace.rootPath}`)
    return skills
  })

  // Get files in a skill directory
  server.handle(RPC_CHANNELS.skills.GET_FILES, async (_ctx, workspaceId: string, skillSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      deps.platform.logger?.error(`SKILLS_GET_FILES: Workspace not found: ${workspaceId}`)
      return []
    }

    const { getWorkspaceSkillsPath } = await import('@craft-agent/shared/workspaces')

    const skillsDir = getWorkspaceSkillsPath(workspace.rootPath)
    const skillDir = join(skillsDir, skillSlug)

    function scanDirectory(dirPath: string): SkillFile[] {
      try {
        const entries = readdirSync(dirPath, { withFileTypes: true })
        return entries
          .filter(entry => !entry.name.startsWith('.')) // Skip hidden files
          .map(entry => {
            const fullPath = join(dirPath, entry.name)
            if (entry.isDirectory()) {
              return {
                name: entry.name,
                type: 'directory' as const,
                children: scanDirectory(fullPath),
              }
            } else {
              const stats = statSync(fullPath)
              return {
                name: entry.name,
                type: 'file' as const,
                size: stats.size,
              }
            }
          })
          .sort((a, b) => {
            // Directories first, then files
            if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
            return a.name.localeCompare(b.name)
          })
      } catch (err) {
        deps.platform.logger?.error(`SKILLS_GET_FILES: Error scanning ${dirPath}:`, err)
        return []
      }
    }

    return scanDirectory(skillDir)
  })

  // Delete a skill from a workspace
  server.handle(RPC_CHANNELS.skills.DELETE, async (_ctx, workspaceId: string, skillSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    const { deleteSkill } = await import('@craft-agent/shared/skills')
    deleteSkill(workspace.rootPath, skillSlug)
    deps.platform.logger?.info(`Deleted skill: ${skillSlug}`)
  })

  // Open skill SKILL.md in editor
  server.handle(RPC_CHANNELS.skills.OPEN_EDITOR, async (_ctx, workspaceId: string, skillSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')
    if (workspace.remoteServer) throw new Error('Open in editor is not available for remote workspaces')

    const { getWorkspaceSkillsPath } = await import('@craft-agent/shared/workspaces')

    const skillsDir = getWorkspaceSkillsPath(workspace.rootPath)
    const skillFile = join(skillsDir, skillSlug, 'SKILL.md')
    await deps.platform.openPath?.(skillFile)
  })

  // Open skill folder in Finder/Explorer
  server.handle(RPC_CHANNELS.skills.OPEN_FINDER, async (_ctx, workspaceId: string, skillSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')
    if (workspace.remoteServer) throw new Error('Show in Finder is not available for remote workspaces')

    const { getWorkspaceSkillsPath } = await import('@craft-agent/shared/workspaces')

    const skillsDir = getWorkspaceSkillsPath(workspace.rootPath)
    const skillDir = join(skillsDir, skillSlug)
    await deps.platform.showItemInFolder?.(skillDir)
  })
}
