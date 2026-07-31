import type { Workspace } from '../../shared/types'

type TFunctionLike = (key: string, defaultValue: string) => string
type WorkspaceKindLike = Pick<Workspace, 'kind'>
type WorkspaceProtectedLike = Pick<Workspace, 'kind' | 'isProtected'>
type WorkspaceDisplayLike = Pick<Workspace, 'name' | 'kind' | 'isProtected'>

export function isConversationWorkspace(workspace: WorkspaceKindLike | null | undefined): boolean {
  return workspace?.kind === 'conversation'
}

export function isProtectedWorkspace(workspace: WorkspaceProtectedLike | null | undefined): boolean {
  return workspace?.isProtected === true || isConversationWorkspace(workspace)
}

export function getWorkspaceDisplayName(workspace: WorkspaceDisplayLike | null | undefined, t: TFunctionLike): string {
  if (!workspace) return t('workspace.selectWorkspace', 'Select workspace')
  if (isConversationWorkspace(workspace)) return t('workspace.defaultConversation', 'Chats')
  return workspace.name
}

export function getWorkspaceInitial(workspace: WorkspaceDisplayLike | null | undefined, t: TFunctionLike): string {
  const name = getWorkspaceDisplayName(workspace, t)
  return name.charAt(0) || 'W'
}
