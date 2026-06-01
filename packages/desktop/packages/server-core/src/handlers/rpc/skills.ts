import { dirname, join } from 'path'
import { existsSync, readdirSync, statSync } from 'fs'
import {
  RPC_CHANNELS,
  type SkillFile,
  type SkillMarketplaceInstallResult,
  type SkillMarketplaceItem,
} from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import {
  getSkillMarketplaceDefinition,
  SKILL_MARKETPLACE_DEFINITIONS,
} from '@craft-agent/shared/skills'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import type { LoadedSkill } from '@craft-agent/shared/skills/types'
import type { AvailableSkillDetail } from '@craft-agent/core/types'

type AvailableCommandsPayload = {
  availableCommands?: Array<{ name: string; description?: string }>
  availableSkills?: string[]
  availableSkillDetails?: AvailableSkillDetail[]
}

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.skills.GET,
  RPC_CHANNELS.skills.GET_FILES,
  RPC_CHANNELS.skills.DELETE,
  RPC_CHANNELS.skills.SET_ENABLED,
  RPC_CHANNELS.skills.MARKETPLACE_LIST,
  RPC_CHANNELS.skills.MARKETPLACE_INSTALL,
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
    enabled: detail.modelInvocable !== false,
    providerLevel: detail.level,
  }
}

function providerSkillFromName(
  name: string,
  description?: string,
): LoadedSkill {
  return providerSkillFromDetail({
    name,
    ...(description !== undefined ? { description } : {}),
  })
}

function getMarketplaceDefinition(
  skillId: string,
): Omit<SkillMarketplaceItem, 'installed'> | undefined {
  return getSkillMarketplaceDefinition(skillId)
}

function skillAcpSessionId(
  fallbackPrefix: string,
  workspaceId: string,
  activeSessionId?: string,
): string {
  const trimmedSessionId = activeSessionId?.trim()
  return trimmedSessionId || `${fallbackPrefix}:${workspaceId}`
}

function hasActiveAcpSession(activeSessionId?: string): boolean {
  return Boolean(activeSessionId?.trim())
}

function normalizeSkillIdentifier(identifier: string): string {
  return identifier
    .trim()
    .replace(/^[@/]+/, '')
    .toLowerCase()
}

function providerSkillsFromAvailableCommands(
  payload: AvailableCommandsPayload,
): LoadedSkill[] {
  const commandDescriptions = new Map(
    (payload.availableCommands ?? []).map((command) => [
      command.name,
      command.description,
    ]),
  )
  return payload.availableSkillDetails?.length
    ? payload.availableSkillDetails.map(providerSkillFromDetail)
    : (payload.availableSkills ?? []).map((name) =>
        providerSkillFromName(name, commandDescriptions.get(name)),
      )
}

async function getInstalledMarketplaceSkillSlugs(
  deps: HandlerDeps,
  workspaceId: string,
  workingDirectory?: string,
  activeSessionId?: string,
): Promise<Set<string>> {
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) {
    return new Set()
  }

  const shouldTryQwenAcp =
    hasActiveAcpSession(activeSessionId) ||
    (await shouldLoadSkillsFromQwenAcp(workspace.rootPath))
  if (!shouldTryQwenAcp) return new Set()

  const effectiveWorkingDir =
    workingDirectory && existsSync(workingDirectory)
      ? workingDirectory
      : undefined
  const result = await deps.sessionManager.refreshAvailableCommands(
    skillAcpSessionId('skills-marketplace', workspaceId, activeSessionId),
    {
      workspaceId,
      workingDirectory: effectiveWorkingDir,
    },
  )
  if (!result.success) {
    deps.platform.logger?.warn(
      `SKILLS_MARKETPLACE_LIST: Qwen ACP skill discovery failed for ${workspaceId}: ${result.error ?? 'unknown error'}`,
    )
    return new Set()
  }

  return new Set([
    ...(result.availableSkills ?? []).map(normalizeSkillIdentifier),
    ...(result.availableSkillDetails ?? []).map((skill) =>
      normalizeSkillIdentifier(skill.name),
    ),
  ])
}

async function listMarketplaceSkills(
  deps: HandlerDeps,
  workspaceId: string,
  workingDirectory?: string,
  activeSessionId?: string,
): Promise<SkillMarketplaceItem[]> {
  const installedSlugs = await getInstalledMarketplaceSkillSlugs(
    deps,
    workspaceId,
    workingDirectory,
    activeSessionId,
  )
  return SKILL_MARKETPLACE_DEFINITIONS.map((skill) => ({
    ...skill,
    installed:
      installedSlugs.has(normalizeSkillIdentifier(skill.slug)) ||
      installedSlugs.has(normalizeSkillIdentifier(skill.name)),
  }))
}

async function broadcastAvailableSkills(
  server: RpcServer,
  deps: HandlerDeps,
  workspaceId: string,
  workingDirectory?: string,
  activeSessionId?: string,
): Promise<void> {
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) return

  const effectiveWorkingDir =
    workingDirectory && existsSync(workingDirectory)
      ? workingDirectory
      : undefined
  const result = await deps.sessionManager.refreshAvailableCommands(
    skillAcpSessionId('skills-discovery', workspaceId, activeSessionId),
    {
      workspaceId,
      workingDirectory: effectiveWorkingDir,
    },
  )
  if (!result.success) {
    deps.platform.logger?.warn(
      `SKILLS_MARKETPLACE_INSTALL: Qwen ACP skill refresh failed for ${workspaceId}: ${result.error ?? 'unknown error'}`,
    )
    return
  }

  const skills = providerSkillsFromAvailableCommands(result)
  pushTyped(
    server,
    RPC_CHANNELS.skills.CHANGED,
    { to: 'workspace', workspaceId },
    workspaceId,
    skills,
  )
}

async function shouldLoadSkillsFromQwenAcp(
  workspaceRootPath: string,
): Promise<boolean> {
  const { loadWorkspaceConfig } = await import('@craft-agent/shared/workspaces')
  const {
    getDefaultLlmConnection,
    getLlmConnection,
    QWEN_CODE_CONNECTION_SLUG,
  } = await import('@craft-agent/shared/config')

  const workspaceConfig = loadWorkspaceConfig(workspaceRootPath)
  const connectionSlug =
    workspaceConfig?.defaults?.defaultLlmConnection ??
    getDefaultLlmConnection() ??
    undefined
  if (!connectionSlug) return false

  const connection = getLlmConnection(connectionSlug)
  return (
    connectionSlug === QWEN_CODE_CONNECTION_SLUG ||
    connection?.providerType === 'qwen'
  )
}

export function registerSkillsHandlers(
  server: RpcServer,
  deps: HandlerDeps,
): void {
  // Get all skills for a workspace (and optionally project-level skills from workingDirectory)
  server.handle(
    RPC_CHANNELS.skills.GET,
    async (
      _ctx,
      workspaceId: string,
      workingDirectory?: string,
      activeSessionId?: string,
    ) => {
      deps.platform.logger?.info(
        `SKILLS_GET: Loading skills for workspace: ${workspaceId}${workingDirectory ? `, workingDirectory: ${workingDirectory}` : ''}`,
      )
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) {
        deps.platform.logger?.error(
          `SKILLS_GET: Workspace not found: ${workspaceId}`,
        )
        return []
      }
      // Validate workingDirectory exists on this server — a thin client may pass
      // its local path which doesn't exist on the remote server's filesystem.
      const effectiveWorkingDir =
        workingDirectory && existsSync(workingDirectory)
          ? workingDirectory
          : undefined

      const shouldTryQwenAcp =
        hasActiveAcpSession(activeSessionId) ||
        (await shouldLoadSkillsFromQwenAcp(workspace.rootPath))

      if (shouldTryQwenAcp) {
        const result = await deps.sessionManager.refreshAvailableCommands(
          skillAcpSessionId('skills-discovery', workspaceId, activeSessionId),
          {
            workspaceId,
            workingDirectory: effectiveWorkingDir,
          },
        )
        if (!result.success) {
          deps.platform.logger?.warn(
            `SKILLS_GET: Qwen ACP skill discovery failed for ${workspaceId}: ${result.error ?? 'unknown error'}`,
          )
          return []
        }

        const skills = providerSkillsFromAvailableCommands(result)
        deps.platform.logger?.info(
          `SKILLS_GET: Loaded ${skills.length} skills from Qwen ACP for ${workspaceId}`,
        )
        return skills
      }

      const { loadAllSkills } = await import('@craft-agent/shared/skills')
      const skills = loadAllSkills(workspace.rootPath, effectiveWorkingDir)
      deps.platform.logger?.info(
        `SKILLS_GET: Loaded ${skills.length} skills from ${workspace.rootPath}`,
      )
      return skills
    },
  )

  server.handle(
    RPC_CHANNELS.skills.MARKETPLACE_LIST,
    async (
      _ctx,
      workspaceId: string,
      workingDirectory?: string,
      activeSessionId?: string,
    ) =>
      listMarketplaceSkills(
        deps,
        workspaceId,
        workingDirectory,
        activeSessionId,
      ),
  )

  server.handle(
    RPC_CHANNELS.skills.MARKETPLACE_INSTALL,
    async (
      _ctx,
      workspaceId: string,
      skillId: string,
      workingDirectory?: string,
      activeSessionId?: string,
    ): Promise<SkillMarketplaceInstallResult> => {
      const marketplaceSkill = getMarketplaceDefinition(skillId)
      if (!marketplaceSkill) {
        throw new Error(`Unknown marketplace skill: ${skillId}`)
      }

      const result = await deps.sessionManager.installQwenSkill(
        skillAcpSessionId('skills-marketplace', workspaceId, activeSessionId),
        {
          id: marketplaceSkill.id,
          slug: marketplaceSkill.slug,
          name: marketplaceSkill.name,
          description: marketplaceSkill.description,
          sourceUrl: marketplaceSkill.sourceUrl,
          scope: 'global',
        },
        {
          workspaceId,
          workingDirectory,
        },
      )
      if (!result.success || !result.skill) {
        throw new Error(result.error ?? 'Qwen ACP skill installation failed')
      }
      await broadcastAvailableSkills(
        server,
        deps,
        workspaceId,
        workingDirectory,
        activeSessionId,
      )

      deps.platform.logger?.info(
        `Installed marketplace skill: ${marketplaceSkill.slug}`,
      )
      return {
        id: marketplaceSkill.id,
        slug: result.skill.slug ?? marketplaceSkill.slug,
        installedPath: result.skill.installedPath,
        source: 'qwen-acp',
      }
    },
  )

  // Get files in a skill directory
  server.handle(
    RPC_CHANNELS.skills.GET_FILES,
    async (_ctx, workspaceId: string, skillSlug: string) => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) {
        deps.platform.logger?.error(
          `SKILLS_GET_FILES: Workspace not found: ${workspaceId}`,
        )
        return []
      }

      const { getWorkspaceSkillsPath } = await import(
        '@craft-agent/shared/workspaces'
      )

      const skillsDir = getWorkspaceSkillsPath(workspace.rootPath)
      const skillDir = join(skillsDir, skillSlug)

      function scanDirectory(dirPath: string): SkillFile[] {
        try {
          const entries = readdirSync(dirPath, { withFileTypes: true })
          return entries
            .filter((entry) => !entry.name.startsWith('.')) // Skip hidden files
            .map((entry) => {
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
          deps.platform.logger?.error(
            `SKILLS_GET_FILES: Error scanning ${dirPath}:`,
            err,
          )
          return []
        }
      }

      return scanDirectory(skillDir)
    },
  )

  // Delete a skill from a workspace
  server.handle(
    RPC_CHANNELS.skills.DELETE,
    async (
      _ctx,
      workspaceId: string,
      skillSlug: string,
      workingDirectory?: string,
      activeSessionId?: string,
    ) => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) throw new Error('Workspace not found')

      const shouldTryQwenAcp =
        hasActiveAcpSession(activeSessionId) ||
        (await shouldLoadSkillsFromQwenAcp(workspace.rootPath))

      if (shouldTryQwenAcp) {
        const result = await deps.sessionManager.deleteQwenSkill(
          skillAcpSessionId('skills-discovery', workspaceId, activeSessionId),
          { slug: skillSlug, scope: 'global' },
          { workspaceId, workingDirectory },
        )
        if (!result.success) {
          throw new Error(result.error ?? 'Qwen ACP skill deletion failed')
        }
        await broadcastAvailableSkills(
          server,
          deps,
          workspaceId,
          workingDirectory,
          activeSessionId,
        )
        deps.platform.logger?.info(`Deleted Qwen skill: ${skillSlug}`)
        return
      }

      const { deleteSkill } = await import('@craft-agent/shared/skills')
      deleteSkill(workspace.rootPath, skillSlug)
      deps.platform.logger?.info(`Deleted skill: ${skillSlug}`)
    },
  )

  server.handle(
    RPC_CHANNELS.skills.SET_ENABLED,
    async (
      _ctx,
      workspaceId: string,
      skillSlug: string,
      enabled: boolean,
      workingDirectory?: string,
      activeSessionId?: string,
      scope?: 'global' | 'project',
    ) => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) throw new Error('Workspace not found')
      const shouldTryQwenAcp =
        hasActiveAcpSession(activeSessionId) ||
        (await shouldLoadSkillsFromQwenAcp(workspace.rootPath))
      if (!shouldTryQwenAcp) {
        throw new Error('Skill enablement is only supported for Qwen skills')
      }

      const result = await deps.sessionManager.setQwenSkillEnabled(
        skillAcpSessionId('skills-discovery', workspaceId, activeSessionId),
        { slug: skillSlug, enabled, scope: scope ?? 'global' },
        { workspaceId, workingDirectory },
      )
      if (!result.success) {
        throw new Error(result.error ?? 'Qwen ACP skill update failed')
      }
      await broadcastAvailableSkills(
        server,
        deps,
        workspaceId,
        workingDirectory,
        activeSessionId,
      )
      deps.platform.logger?.info(
        `Set Qwen skill ${skillSlug} enabled=${enabled}`,
      )
    },
  )

  // Open skill SKILL.md in editor
  server.handle(
    RPC_CHANNELS.skills.OPEN_EDITOR,
    async (_ctx, workspaceId: string, skillSlug: string) => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) throw new Error('Workspace not found')
      if (workspace.remoteServer)
        throw new Error('Open in editor is not available for remote workspaces')

      const { getWorkspaceSkillsPath } = await import(
        '@craft-agent/shared/workspaces'
      )

      const skillsDir = getWorkspaceSkillsPath(workspace.rootPath)
      const skillFile = join(skillsDir, skillSlug, 'SKILL.md')
      await deps.platform.openPath?.(skillFile)
    },
  )

  // Open skill folder in Finder/Explorer
  server.handle(
    RPC_CHANNELS.skills.OPEN_FINDER,
    async (_ctx, workspaceId: string, skillSlug: string) => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) throw new Error('Workspace not found')
      if (workspace.remoteServer)
        throw new Error('Show in Finder is not available for remote workspaces')

      const { getWorkspaceSkillsPath } = await import(
        '@craft-agent/shared/workspaces'
      )

      const skillsDir = getWorkspaceSkillsPath(workspace.rootPath)
      const skillDir = join(skillsDir, skillSlug)
      await deps.platform.showItemInFolder?.(skillDir)
    },
  )
}
