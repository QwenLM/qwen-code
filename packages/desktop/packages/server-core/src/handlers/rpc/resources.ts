/**
 * Resources RPC Handlers
 *
 * Handles workspace resource export/import (sources, skills, automations).
 */

import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { getCredentialManager, SOURCE_CREDENTIAL_TYPES } from '@craft-agent/shared/credentials'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import type {
  ResourceBundle,
  ResourceImportMode,
  ExportResourcesOptions,
} from '@craft-agent/shared/resources'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.resources.EXPORT,
  RPC_CHANNELS.resources.IMPORT,
] as const

export function registerResourcesHandlers(server: RpcServer, deps: HandlerDeps): void {
  // Export workspace resources to a portable bundle
  server.handle(
    RPC_CHANNELS.resources.EXPORT,
    async (_ctx, workspaceId: string, options: ExportResourcesOptions) => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)

      const { exportResources } = await import('@craft-agent/shared/resources')
      const result = exportResources(workspace.rootPath, options)

      deps.platform.logger?.info(
        `RESOURCES_EXPORT: Exported from ${workspaceId}: ` +
        `${result.bundle.resources.sources?.length ?? 0} sources, ` +
        `${result.bundle.resources.skills?.length ?? 0} skills, ` +
        `${result.bundle.resources.automations?.length ?? 0} automations` +
        (result.warnings.length > 0 ? ` (${result.warnings.length} warnings)` : ''),
      )

      return result
    },
  )

  // Import a resource bundle into a workspace
  server.handle(
    RPC_CHANNELS.resources.IMPORT,
    async (_ctx, workspaceId: string, bundle: ResourceBundle, mode: ResourceImportMode) => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)

      const { importResources } = await import('@craft-agent/shared/resources')
      const credManager = getCredentialManager()

      const result = await importResources(workspace.rootPath, bundle, mode, {
        // Clear all credential types for a source slug on overwrite
        clearSourceCredentials: async (wsId: string, sourceSlug: string) => {
          for (const credType of SOURCE_CREDENTIAL_TYPES) {
            try {
              await credManager.delete({
                type: credType,
                workspaceId: wsId,
                sourceId: sourceSlug,
              })
            } catch {
              // Ignore errors for credential types that don't exist
            }
          }
        },
      })

      deps.platform.logger?.info(
        `RESOURCES_IMPORT: Imported into ${workspaceId} (mode=${mode}): ` +
        `sources=${result.sources.imported.length} imported, ${result.sources.skipped.length} skipped, ${result.sources.failed.length} failed; ` +
        `skills=${result.skills.imported.length} imported, ${result.skills.skipped.length} skipped, ${result.skills.failed.length} failed; ` +
        `automations=${result.automations.imported.length} imported, ${result.automations.skipped.length} skipped, ${result.automations.failed.length} failed`,
      )

      // Notify ConfigWatcher of imported files so UI refreshes on Linux
      // (Bun's fs.watch doesn't reliably detect atomic renames)
      if (result.automations.imported.length > 0 || result.automations.skipped.length === 0 && bundle.resources.automations?.length) {
        deps.sessionManager.notifyConfigFileChange(workspace.rootPath, 'automations.json')
      }
      for (const slug of result.sources.imported) {
        deps.sessionManager.notifyConfigFileChange(workspace.rootPath, `sources/${slug}/config.json`)
      }
      for (const slug of result.skills.imported) {
        deps.sessionManager.notifyConfigFileChange(workspace.rootPath, `skills/${slug}/SKILL.md`)
      }

      return result
    },
  )
}
