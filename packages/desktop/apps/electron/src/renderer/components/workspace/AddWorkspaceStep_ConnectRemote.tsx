import { useState, useEffect, useCallback, useRef } from "react"
import { useTranslation } from "react-i18next"
import { ArrowLeft, CheckCircle, XCircle, Plus } from "lucide-react"
import { cn } from "@/lib/utils"
import { slugify } from "@/lib/slugify"
import { Input } from "../ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select"
import { AddWorkspaceContainer, AddWorkspaceStepHeader, AddWorkspacePrimaryButton, AddWorkspaceSecondaryButton } from "./primitives"

const CREATE_NEW_VALUE = '__create_new__'

interface AddWorkspaceStep_ConnectRemoteProps {
  onBack: () => void
  onCreate: (folderPath: string, name: string, remoteServer: { url: string; token: string; remoteWorkspaceId: string }) => Promise<void>
  isCreating: boolean
  /** Pre-fill the server URL (for reconnect flow) */
  initialUrl?: string
  /** Pre-fill the token (for reconnect flow) */
  initialToken?: string
  /** When set, updating an existing workspace's remote config instead of creating */
  reconnectWorkspace?: { id: string; name: string; remoteWorkspaceId: string }
  /** Called when reconnect updates the remote server config */
  onUpdate?: (workspaceId: string, remoteServer: { url: string; token: string; remoteWorkspaceId: string }) => Promise<void>
}

/**
 * Resolve a unique local workspace slug by appending suffixes if needed.
 * Tries: baseName → baseName-remote → baseName-2 → baseName-3 → ...
 */
async function resolveUniqueSlug(baseName: string): Promise<{ slug: string; path: string }> {
  const baseSlug = slugify(baseName)
  if (!baseSlug) return { slug: 'remote', path: '' }

  let slug = baseSlug
  let attempt = 0

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await window.electronAPI.checkWorkspaceSlug(slug)
    if (!result.exists) {
      return { slug, path: result.path }
    }
    attempt++
    slug = attempt === 1 ? `${baseSlug}-remote` : `${baseSlug}-${attempt}`
    if (attempt > 20) {
      // Safety valve — shouldn't happen in practice
      return { slug: `${baseSlug}-${Date.now()}`, path: result.path.replace(baseSlug, `${baseSlug}-${Date.now()}`) }
    }
  }
}

/**
 * AddWorkspaceStep_ConnectRemote - Connect to a remote Craft Agent Server
 *
 * Two paths:
 * 1. Connect to existing workspace — select from dropdown, no name needed, auto-resolve local slug
 * 2. Create new workspace — type a name, creates on server, then connects
 */
export function AddWorkspaceStep_ConnectRemote({
  onBack,
  onCreate,
  isCreating,
  initialUrl,
  initialToken,
  reconnectWorkspace,
  onUpdate,
}: AddWorkspaceStep_ConnectRemoteProps) {
  const { t } = useTranslation()
  const isReconnectMode = !!reconnectWorkspace
  const [serverUrl, setServerUrl] = useState(initialUrl ?? '')
  const [token, setToken] = useState(initialToken ?? '')
  const [homeDir, setHomeDir] = useState('')
  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle')
  const [testError, setTestError] = useState<string | null>(null)
  const [remoteWorkspaces, setRemoteWorkspaces] = useState<Array<{ id: string; name: string }>>([])
  const [selectedValue, setSelectedValue] = useState<string | null>(null) // workspace ID or CREATE_NEW_VALUE
  const [newWorkspaceName, setNewWorkspaceName] = useState('')
  const [serverVersion, setServerVersion] = useState<string | null>(null)
  const selectPortalRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.electronAPI.getHomeDir().then(setHomeDir)
  }, [])

  const isCreateNew = selectedValue === CREATE_NEW_VALUE
  const selectedWorkspace = !isCreateNew ? remoteWorkspaces.find(w => w.id === selectedValue) : null
  // Fresh server (no workspaces at all) — always in create mode
  const isFreshServer = testState === 'ok' && remoteWorkspaces.length === 0

  // Reset test state when URL or token changes
  useEffect(() => {
    setTestState('idle')
    setTestError(null)
    setRemoteWorkspaces([])
    setSelectedValue(null)
    setNewWorkspaceName('')
  }, [serverUrl, token])

  const handleTestConnection = useCallback(async () => {
    if (!serverUrl || !token) return
    setTestState('testing')
    setTestError(null)
    try {
      const result = await window.electronAPI.testRemoteConnection(serverUrl, token)
      console.log('[ConnectRemote] testRemoteConnection result:', JSON.stringify(result, null, 2))
      if (result.ok) {
        setTestState('ok')
        setServerVersion(result.serverVersion ?? null)
        if (result.needsWorkspace) {
          // Fresh server — no workspaces, go straight to create mode
          setRemoteWorkspaces([])
          setSelectedValue(null)
        } else {
          const workspaces = result.remoteWorkspaces ?? []
          setRemoteWorkspaces(workspaces)
          if (workspaces.length === 1) {
            setSelectedValue(workspaces[0]!.id)
          }
        }
      } else {
        setTestState('error')
        setTestError(result.error || 'Connection failed')
      }
    } catch (err) {
      setTestState('error')
      setTestError(err instanceof Error ? err.message : 'Connection failed')
    }
  }, [serverUrl, token])

  const handleConnect = useCallback(async () => {
    if (!serverUrl || !token) return

    // Reconnect mode — update existing workspace config
    if (isReconnectMode && onUpdate) {
      try {
        await onUpdate(reconnectWorkspace!.id, {
          url: serverUrl,
          token,
          remoteWorkspaceId: reconnectWorkspace!.remoteWorkspaceId,
        })
        return
      } catch (err) {
        setTestState('error')
        setTestError(err instanceof Error ? err.message : 'Failed to reconnect workspace')
        return
      }
    }

    if (!homeDir) return
    const defaultBasePath = `${homeDir}/.craft-agent/workspaces`

    if (isCreateNew || isFreshServer) {
      // Create new workspace on remote server via direct RPC, then connect locally
      const name = newWorkspaceName.trim()
      if (!name) return

      try {
        const created = await window.electronAPI.invokeOnServer(
          serverUrl, token, 'server:createWorkspace', name
        ) as { id: string; name: string }

        const { slug, path } = await resolveUniqueSlug(name)
        const finalPath = path || `${defaultBasePath}/${slug}`
        await onCreate(finalPath, name, { url: serverUrl, token, remoteWorkspaceId: created.id })
      } catch (err) {
        setTestState('error')
        setTestError(err instanceof Error ? err.message : 'Failed to create workspace on remote server')
        return
      }
    } else if (selectedWorkspace) {
      // Connect to existing workspace — auto-resolve local slug
      const { slug, path } = await resolveUniqueSlug(selectedWorkspace.name)
      const finalPath = path || `${defaultBasePath}/${slug}`
      await onCreate(finalPath, selectedWorkspace.name, { url: serverUrl, token, remoteWorkspaceId: selectedWorkspace.id })
    }
  }, [serverUrl, token, homeDir, isCreateNew, isFreshServer, newWorkspaceName, selectedWorkspace, onCreate, isReconnectMode, onUpdate, reconnectWorkspace])

  const canConnect = testState === 'ok' && !isCreating && (
    isReconnectMode ? true :
    (isFreshServer || isCreateNew) ? !!newWorkspaceName.trim() : !!selectedWorkspace
  )

  const showCreateMode = !isReconnectMode && (isCreateNew || isFreshServer)
  const buttonLabel = isReconnectMode ? 'Reconnect' : showCreateMode ? 'Create and Connect' : 'Connect'
  const buttonLoadingLabel = isReconnectMode ? 'Reconnecting...' : showCreateMode ? 'Creating...' : 'Connecting...'

  return (
    <AddWorkspaceContainer>
      {/* Back button */}
      <button
        onClick={onBack}
        disabled={isCreating}
        className={cn(
          "self-start flex items-center gap-1 text-sm text-muted-foreground",
          "hover:text-foreground transition-colors mb-4",
          isCreating && "opacity-50 cursor-not-allowed"
        )}
      >
        <ArrowLeft className="h-4 w-4" />
        Back
      </button>

      <AddWorkspaceStepHeader
        title={isReconnectMode ? t("workspace.reconnect", { name: reconnectWorkspace!.name }) : "Connect to remote server"}
        description={isReconnectMode
          ? "Update the server URL or token to restore the connection."
          : "Connect to a remote Craft Agent Server for this workspace."}
      />

      <div className="mt-6 w-full space-y-5">
        {/* Server URL */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">
            Server URL
          </label>
          <div className="bg-background shadow-minimal rounded-lg">
            <Input
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="ws://192.168.1.100:9100"
              disabled={isCreating}
              autoFocus
              className="border-0 bg-transparent shadow-none font-mono text-sm"
            />
          </div>
        </div>

        {/* Token */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">
            Token
          </label>
          <div className="bg-background shadow-minimal rounded-lg">
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={t("workspace.serverAuthToken")}
              disabled={isCreating}
              className="border-0 bg-transparent shadow-none"
            />
          </div>
        </div>

        {/* Test Connection */}
        <div className="flex items-center gap-3">
          <AddWorkspaceSecondaryButton
            onClick={handleTestConnection}
            disabled={!serverUrl || !token || testState === 'testing' || isCreating}
          >
            {testState === 'testing' ? 'Testing...' : 'Test Connection'}
          </AddWorkspaceSecondaryButton>
          {testState === 'ok' && !isFreshServer && (
            <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
              <CheckCircle className="h-3.5 w-3.5" />
              Connected{serverVersion ? ` — v${serverVersion}` : ''}
            </span>
          )}
          {testState === 'ok' && isFreshServer && (
            <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
              <CheckCircle className="h-3.5 w-3.5" />
              Connected{serverVersion ? ` — v${serverVersion}` : ''} — no workspaces yet
            </span>
          )}
          {testState === 'error' && (
            <span className="flex items-center gap-1 text-xs text-destructive">
              <XCircle className="h-3.5 w-3.5" />
              {testError || 'Failed'}
            </span>
          )}
        </div>

        {/* Old server warning */}
        {testState === 'ok' && !serverVersion && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-xs text-yellow-700 dark:text-yellow-400">
            <XCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{t("workspace.olderServerWarning")}</span>
          </div>
        )}

        {/* Portal container for Select — must be inside the Dialog to receive pointer events */}
        <div ref={selectPortalRef} />

        {/* Workspace selector — pick existing or create new (hidden in reconnect mode) */}
        {!isReconnectMode && testState === 'ok' && remoteWorkspaces.length > 0 && !isCreateNew && (
          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">
              Workspace
            </label>
            <div className="bg-background shadow-minimal rounded-lg">
              <Select
                value={selectedValue ?? ''}
                onValueChange={setSelectedValue}
                disabled={isCreating}
              >
                <SelectTrigger className="border-0 bg-transparent shadow-none">
                  <SelectValue placeholder={t("workspace.selectWorkspacePlaceholder")} />
                </SelectTrigger>
                <SelectContent container={selectPortalRef.current}>
                  {remoteWorkspaces.map(ws => (
                    <SelectItem key={ws.id} value={ws.id}>
                      {ws.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <button
              type="button"
              onClick={() => setSelectedValue(CREATE_NEW_VALUE)}
              disabled={isCreating}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <Plus className="h-3 w-3" />
              Create new workspace on server
            </button>
          </div>
        )}

        {/* New workspace name — shown for fresh servers or "Create new" selection (hidden in reconnect mode) */}
        {!isReconnectMode && testState === 'ok' && showCreateMode && (
          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">
              Workspace name
            </label>
            <div className="bg-background shadow-minimal rounded-lg">
              <Input
                value={newWorkspaceName}
                onChange={(e) => setNewWorkspaceName(e.target.value)}
                placeholder={t("workspace.myRemoteWorkspace")}
                disabled={isCreating}
                className="border-0 bg-transparent shadow-none"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              A workspace will be created on the remote server with this name.
            </p>
            {isCreateNew && remoteWorkspaces.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setSelectedValue(remoteWorkspaces.length === 1 ? remoteWorkspaces[0]!.id : null)
                  setNewWorkspaceName('')
                }}
                disabled={isCreating}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <ArrowLeft className="h-3 w-3" />
                Use existing workspace
              </button>
            )}
          </div>
        )}

        {/* Connect / Create and Connect */}
        <AddWorkspacePrimaryButton
          onClick={handleConnect}
          disabled={!canConnect}
          loading={isCreating}
          loadingText={buttonLoadingLabel}
        >
          {buttonLabel}
        </AddWorkspacePrimaryButton>
      </div>
    </AddWorkspaceContainer>
  )
}
