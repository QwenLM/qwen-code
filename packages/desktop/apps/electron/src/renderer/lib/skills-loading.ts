export interface ShouldLoadWorkspaceSkillsOptions {
  isSkillsNavigation: boolean
  llmConnectionCount: number
  providerType?: string
}

/**
 * Skills back the sidebar count and mention metadata, so keep them loaded once
 * connection config is available. The Skills navigator also loads them directly
 * so the page works before connection state finishes hydrating.
 */
export function shouldLoadWorkspaceSkills({
  isSkillsNavigation,
  llmConnectionCount,
}: ShouldLoadWorkspaceSkillsOptions): boolean {
  return isSkillsNavigation || llmConnectionCount > 0
}
