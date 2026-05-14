import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { PanelHeader } from '@/components/app-shell/PanelHeader';
import { HeaderMenu } from '@/components/ui/HeaderMenu';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  SettingsTextarea,
  SettingsToggle,
} from '@/components/settings';
import { useAppShellContext } from '@/context/AppShellContext';
import { routes } from '@/lib/navigate';
import type { DetailsPageMeta } from '@/lib/navigation-registry';
import type {
  QwenCoreSettingKey,
  QwenCoreSettingsSnapshot,
  QwenExtensionSettingsEntry,
  QwenHookDefinition,
  QwenHookEntry,
  QwenHookEvent,
  QwenMcpServerConfig,
  QwenMcpServerEntry,
  QwenMcpTransport,
  QwenSettingValue,
  QwenSettingsScope,
  SessionCommand,
} from '@craft-agent/shared/protocol';

export type QwenSettingsTab = 'general' | 'mcpServers' | 'hooks' | 'extensions';

type PageCopy = {
  title: string;
  description: string;
  slug: QwenSettingsTab;
};

type RunQwenSettingsCommand = (
  command: SessionCommand,
) => Promise<QwenCoreSettingsSnapshot | null>;

const PAGE_COPY: Record<QwenSettingsTab, PageCopy> = {
  general: {
    title: 'General',
    description: 'Response language, approvals, updates, and file search.',
    slug: 'general',
  },
  mcpServers: {
    title: 'MCP Servers',
    description: 'Connect Qwen Code to local and remote MCP tools.',
    slug: 'mcpServers',
  },
  hooks: {
    title: 'Hooks',
    description:
      'Run commands or HTTP calls at key Qwen Code lifecycle events.',
    slug: 'hooks',
  },
  extensions: {
    title: 'Extensions',
    description: 'Review installed extensions and configure their settings.',
    slug: 'extensions',
  },
};

const SCOPE_OPTIONS = [
  { value: 'user', label: 'User' },
  { value: 'workspace', label: 'Project' },
];

const OUTPUT_LANGUAGE_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'en', label: 'English' },
  { value: 'zh-Hans', label: 'Chinese (Simplified)' },
  { value: 'ja', label: 'Japanese' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
];

const APPROVAL_MODE_OPTIONS = [
  { value: 'plan', label: 'Plan' },
  { value: 'default', label: 'Default' },
  { value: 'auto-edit', label: 'Auto Edit' },
  { value: 'yolo', label: 'YOLO' },
];

const FILE_ENCODING_OPTIONS = [
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'utf-8-bom', label: 'UTF-8 with BOM' },
];

const TRANSPORT_OPTIONS: Array<{ value: QwenMcpTransport; label: string }> = [
  { value: 'http', label: 'HTTP' },
  { value: 'stdio', label: 'Stdio' },
  { value: 'sse', label: 'SSE' },
];

const HOOK_EVENTS: QwenHookEvent[] = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'Notification',
  'PreCompact',
  'SubagentStart',
  'SubagentStop',
];

const HOOK_EVENT_OPTIONS = HOOK_EVENTS.map((event) => ({
  value: event,
  label: event,
}));

function createMeta(slug: QwenSettingsTab): DetailsPageMeta {
  return { navigator: 'settings', slug };
}

export const generalMeta = createMeta('general');
export const mcpServersMeta = createMeta('mcpServers');
export const hooksMeta = createMeta('hooks');
export const extensionsMeta = createMeta('extensions');

function valueOf(
  snapshot: QwenCoreSettingsSnapshot | null,
  key: QwenCoreSettingKey,
  fallback: QwenSettingValue,
): QwenSettingValue {
  return snapshot?.merged.values[key] ?? fallback;
}

function boolValue(
  snapshot: QwenCoreSettingsSnapshot | null,
  key: QwenCoreSettingKey,
  fallback: boolean,
): boolean {
  const value = valueOf(snapshot, key, fallback);
  return typeof value === 'boolean' ? value : fallback;
}

function stringValue(
  snapshot: QwenCoreSettingsSnapshot | null,
  key: QwenCoreSettingKey,
  fallback = '',
): string {
  const value = valueOf(snapshot, key, fallback);
  return typeof value === 'string' ? value : fallback;
}

function numberValue(
  snapshot: QwenCoreSettingsSnapshot | null,
  key: QwenCoreSettingKey,
  fallback: number,
): number {
  const value = valueOf(snapshot, key, fallback);
  return typeof value === 'number' ? value : fallback;
}

function parseLines(value: string): string[] | undefined {
  const lines = value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines : undefined;
}

function stringifyLines(value?: string[]): string {
  return value?.join('\n') ?? '';
}

function parseKeyValueLines(value: string): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const line of value.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const item = trimmed.slice(index + 1).trim();
    if (key) result[key] = item;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function stringifyKeyValueLines(value?: Record<string, string>): string {
  return Object.entries(value ?? {})
    .map(([key, item]) => `${key}=${item}`)
    .join('\n');
}

function createEmptyMcpDraft(): McpDraft {
  return {
    scope: 'user',
    name: '',
    transport: 'http',
    commandOrUrl: '',
    args: '',
    cwd: '',
    env: '',
    headers: '',
    timeout: '',
    trust: false,
    description: '',
    includeTools: '',
    excludeTools: '',
  };
}

type McpDraft = {
  scope: QwenSettingsScope;
  name: string;
  transport: QwenMcpTransport;
  commandOrUrl: string;
  args: string;
  cwd: string;
  env: string;
  headers: string;
  timeout: string;
  trust: boolean;
  description: string;
  includeTools: string;
  excludeTools: string;
};

function serverToDraft(entry: QwenMcpServerEntry): McpDraft {
  const { server } = entry;
  return {
    scope: entry.scope === 'workspace' ? 'workspace' : 'user',
    name: entry.name,
    transport: server.transport,
    commandOrUrl:
      server.transport === 'stdio'
        ? (server.command ?? '')
        : server.transport === 'http'
          ? (server.httpUrl ?? '')
          : (server.url ?? ''),
    args: stringifyLines(server.args),
    cwd: server.cwd ?? '',
    env: stringifyKeyValueLines(server.env),
    headers: stringifyKeyValueLines(server.headers),
    timeout: server.timeout === undefined ? '' : String(server.timeout),
    trust: server.trust ?? false,
    description: server.description ?? '',
    includeTools: stringifyLines(server.includeTools),
    excludeTools: stringifyLines(server.excludeTools),
  };
}

function draftToServer(draft: McpDraft): QwenMcpServerConfig {
  const timeout = draft.timeout.trim()
    ? Number(draft.timeout.trim())
    : undefined;
  const base = {
    transport: draft.transport,
    timeout,
    trust: draft.trust,
    description: draft.description.trim() || undefined,
    includeTools: parseLines(draft.includeTools),
    excludeTools: parseLines(draft.excludeTools),
  };
  if (draft.transport === 'stdio') {
    return {
      ...base,
      command: draft.commandOrUrl.trim(),
      args: parseLines(draft.args),
      cwd: draft.cwd.trim() || undefined,
      env: parseKeyValueLines(draft.env),
    };
  }
  if (draft.transport === 'http') {
    return {
      ...base,
      httpUrl: draft.commandOrUrl.trim(),
      headers: parseKeyValueLines(draft.headers),
    };
  }
  return {
    ...base,
    url: draft.commandOrUrl.trim(),
    headers: parseKeyValueLines(draft.headers),
  };
}

type HookDraft = {
  scope: QwenSettingsScope;
  event: QwenHookEvent;
  index?: number;
  matcher: string;
  type: 'command' | 'http';
  commandOrUrl: string;
  name: string;
  description: string;
  timeout: string;
  statusMessage: string;
  env: string;
  headers: string;
  allowedEnvVars: string;
  async: boolean;
  once: boolean;
  sequential: boolean;
};

function createEmptyHookDraft(): HookDraft {
  return {
    scope: 'user',
    event: 'PreToolUse',
    matcher: '*',
    type: 'command',
    commandOrUrl: '',
    name: '',
    description: '',
    timeout: '',
    statusMessage: '',
    env: '',
    headers: '',
    allowedEnvVars: '',
    async: false,
    once: false,
    sequential: false,
  };
}

function hookToDraft(entry: QwenHookEntry): HookDraft {
  const config = entry.hook.hooks[0];
  const type = config?.type ?? 'command';
  return {
    scope: entry.scope === 'workspace' ? 'workspace' : 'user',
    event: entry.event,
    index: entry.index,
    matcher: entry.hook.matcher ?? '*',
    sequential: entry.hook.sequential ?? false,
    type,
    commandOrUrl:
      type === 'command' ? (config?.command ?? '') : (config?.url ?? ''),
    name: config?.name ?? '',
    description: config?.description ?? '',
    timeout: config?.timeout === undefined ? '' : String(config.timeout),
    statusMessage: config?.statusMessage ?? '',
    env: stringifyKeyValueLines(config?.env),
    headers: stringifyKeyValueLines(config?.headers),
    allowedEnvVars: stringifyLines(config?.allowedEnvVars),
    async: config?.async ?? false,
    once: config?.once ?? false,
  };
}

function draftToHook(draft: HookDraft): QwenHookDefinition {
  const timeout = draft.timeout.trim()
    ? Number(draft.timeout.trim())
    : undefined;
  const common = {
    name: draft.name.trim() || undefined,
    description: draft.description.trim() || undefined,
    timeout,
    statusMessage: draft.statusMessage.trim() || undefined,
  };
  return {
    matcher: draft.matcher,
    sequential: draft.sequential || undefined,
    hooks: [
      draft.type === 'command'
        ? {
            ...common,
            type: 'command',
            command: draft.commandOrUrl.trim(),
            env: parseKeyValueLines(draft.env),
            async: draft.async || undefined,
          }
        : {
            ...common,
            type: 'http',
            url: draft.commandOrUrl.trim(),
            headers: parseKeyValueLines(draft.headers),
            allowedEnvVars: parseLines(draft.allowedEnvVars),
            once: draft.once || undefined,
          },
    ],
  };
}

export default function QwenSettingsPage({ tab }: { tab: QwenSettingsTab }) {
  const copy = PAGE_COPY[tab];
  const { activeSessionId } = useAppShellContext();
  const [snapshot, setSnapshot] = useState<QwenCoreSettingsSnapshot | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const runCommand = useCallback(
    async (command: SessionCommand) => {
      if (!activeSessionId || !window.electronAPI) return null;
      const result = await window.electronAPI.sessionCommand(
        activeSessionId,
        command,
      );
      return result as QwenCoreSettingsSnapshot;
    },
    [activeSessionId],
  );

  const load = useCallback(async () => {
    if (!activeSessionId || !window.electronAPI) {
      setSnapshot(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await runCommand({ type: 'getQwenCoreSettings' });
      setSnapshot(result);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError),
      );
      setSnapshot(null);
    } finally {
      setLoading(false);
    }
  }, [activeSessionId, runCommand]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveSetting = useCallback(
    async (
      key: QwenCoreSettingKey,
      value: QwenSettingValue,
      scope: QwenSettingsScope = 'user',
    ) => {
      try {
        const result = await runCommand({
          type: 'setQwenCoreSetting',
          scope,
          key,
          value,
        });
        if (result) setSnapshot(result);
      } catch (saveError) {
        toast.error('Failed to save setting', {
          description:
            saveError instanceof Error ? saveError.message : String(saveError),
        });
      }
    },
    [runCommand],
  );

  return (
    <div className="h-full flex flex-col">
      <PanelHeader
        title={copy.title}
        actions={<HeaderMenu route={routes.view.settings(copy.slug)} />}
      />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            <div className="space-y-8">
              <SettingsSection
                title={copy.title}
                description={copy.description}
              >
                {error ? (
                  <SettingsCard className="px-4 py-3 text-sm text-destructive flex gap-2">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>{error}</span>
                  </SettingsCard>
                ) : null}
              </SettingsSection>

              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : !activeSessionId ? (
                <EmptyState
                  title="Open a Qwen session to edit settings"
                  description="These settings are read and written through Qwen ACP."
                />
              ) : !snapshot ? (
                <EmptyState
                  title="Settings unavailable"
                  description="Qwen ACP did not return settings."
                />
              ) : tab === 'general' ? (
                <GeneralTab snapshot={snapshot} onSave={saveSetting} />
              ) : tab === 'mcpServers' ? (
                <McpServersTab
                  snapshot={snapshot}
                  runCommand={runCommand}
                  setSnapshot={setSnapshot}
                />
              ) : tab === 'hooks' ? (
                <HooksTab
                  snapshot={snapshot}
                  runCommand={runCommand}
                  setSnapshot={setSnapshot}
                  onSave={saveSetting}
                />
              ) : (
                <ExtensionsTab
                  snapshot={snapshot}
                  runCommand={runCommand}
                  setSnapshot={setSnapshot}
                />
              )}

              {snapshot ? (
                <div className="flex justify-end">
                  <Button variant="ghost" size="sm" onClick={() => void load()}>
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Refresh
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <SettingsCard className="px-4 py-8">
      <div className="text-center">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground mt-1">{description}</p>
      </div>
    </SettingsCard>
  );
}

function GeneralTab({
  snapshot,
  onSave,
}: {
  snapshot: QwenCoreSettingsSnapshot;
  onSave: (
    key: QwenCoreSettingKey,
    value: QwenSettingValue,
    scope?: QwenSettingsScope,
  ) => Promise<void>;
}) {
  return (
    <>
      <SettingsSection
        title="Response Language"
        description="Control the language Qwen should prefer when answering."
      >
        <SettingsCard>
          <SettingsSelect
            inCard
            label="Output language"
            description="Preferred language for Qwen responses."
            value={stringValue(snapshot, 'general.outputLanguage', 'auto')}
            options={OUTPUT_LANGUAGE_OPTIONS}
            onValueChange={(value) =>
              void onSave('general.outputLanguage', value)
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Everyday Behavior"
        description="Common preferences from Qwen Code settings."
      >
        <SettingsCard>
          <SettingsSelect
            inCard
            label="Tool approval mode"
            description="Default approval policy for tool requests."
            value={stringValue(snapshot, 'tools.approvalMode', 'default')}
            options={APPROVAL_MODE_OPTIONS}
            onValueChange={(value) => void onSave('tools.approvalMode', value)}
          />
          <SettingsToggle
            label="Auto update"
            description="Check for Qwen Code updates on startup."
            checked={boolValue(snapshot, 'general.enableAutoUpdate', true)}
            onCheckedChange={(checked) =>
              void onSave('general.enableAutoUpdate', checked)
            }
          />
          <SettingsToggle
            label="Session recap"
            description="Show a short recap when returning after being away."
            checked={boolValue(snapshot, 'general.showSessionRecap', false)}
            onCheckedChange={(checked) =>
              void onSave('general.showSessionRecap', checked)
            }
          />
          <NumberSetting
            label="Recap threshold"
            description="Minutes away before an automatic recap can appear."
            value={numberValue(
              snapshot,
              'general.sessionRecapAwayThresholdMinutes',
              5,
            )}
            min={1}
            onSave={(value) =>
              onSave('general.sessionRecapAwayThresholdMinutes', value)
            }
          />
          <SettingsToggle
            label="Commit attribution"
            description="Add Qwen Code attribution to commits created through Qwen Code."
            checked={boolValue(snapshot, 'general.gitCoAuthor.commit', true)}
            onCheckedChange={(checked) =>
              void onSave('general.gitCoAuthor.commit', checked)
            }
          />
          <SettingsToggle
            label="PR attribution"
            description="Add Qwen Code attribution to pull request descriptions."
            checked={boolValue(snapshot, 'general.gitCoAuthor.pr', true)}
            onCheckedChange={(checked) =>
              void onSave('general.gitCoAuthor.pr', checked)
            }
          />
          <SettingsSelect
            inCard
            label="Default file encoding"
            description="Only change this when your project requires UTF-8 with BOM."
            value={stringValue(
              snapshot,
              'general.defaultFileEncoding',
              'utf-8',
            )}
            options={FILE_ENCODING_OPTIONS}
            onValueChange={(value) =>
              void onSave('general.defaultFileEncoding', value)
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="File Search"
        description="High-impact context search defaults."
      >
        <SettingsCard>
          <SettingsToggle
            label="Respect .gitignore"
            description="Exclude files ignored by Git when searching."
            checked={boolValue(
              snapshot,
              'context.fileFiltering.respectGitIgnore',
              true,
            )}
            onCheckedChange={(checked) =>
              void onSave('context.fileFiltering.respectGitIgnore', checked)
            }
          />
          <SettingsToggle
            label="Respect .qwenignore"
            description="Exclude files listed in .qwenignore."
            checked={boolValue(
              snapshot,
              'context.fileFiltering.respectQwenIgnore',
              true,
            )}
            onCheckedChange={(checked) =>
              void onSave('context.fileFiltering.respectQwenIgnore', checked)
            }
          />
          <SettingsToggle
            label="Fuzzy file search"
            description="Improve file matching for @ mentions and search."
            checked={boolValue(
              snapshot,
              'context.fileFiltering.enableFuzzySearch',
              true,
            )}
            onCheckedChange={(checked) =>
              void onSave('context.fileFiltering.enableFuzzySearch', checked)
            }
          />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}

function NumberSetting({
  label,
  description,
  value,
  min,
  onSave,
}: {
  label: string;
  description: string;
  value: number;
  min: number;
  onSave: (value: number) => Promise<void>;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const parsed = Number(draft);
  return (
    <SettingsInput
      inCard
      label={label}
      description={description}
      value={draft}
      onChange={setDraft}
      action={
        <Button
          size="sm"
          onClick={() => void onSave(parsed)}
          disabled={
            !Number.isFinite(parsed) || parsed < min || parsed === value
          }
        >
          <Save className="w-4 h-4" />
        </Button>
      }
    />
  );
}

function McpServersTab({
  snapshot,
  runCommand,
  setSnapshot,
}: {
  snapshot: QwenCoreSettingsSnapshot;
  runCommand: RunQwenSettingsCommand;
  setSnapshot: (snapshot: QwenCoreSettingsSnapshot) => void;
}) {
  const [draft, setDraft] = useState<McpDraft>(createEmptyMcpDraft);
  const entries = useMemo(
    () => [...snapshot.user.mcpServers, ...snapshot.workspace.mcpServers],
    [snapshot],
  );

  const save = async () => {
    if (!draft.name.trim() || !draft.commandOrUrl.trim()) return;
    const result = await runCommand({
      type: 'setQwenMcpServer',
      scope: draft.scope,
      name: draft.name.trim(),
      server: draftToServer(draft),
    });
    if (result) {
      setSnapshot(result);
      setDraft(createEmptyMcpDraft());
    }
  };

  const remove = async (entry: QwenMcpServerEntry) => {
    if (entry.scope !== 'user' && entry.scope !== 'workspace') return;
    const result = await runCommand({
      type: 'removeQwenMcpServer',
      scope: entry.scope,
      name: entry.name,
    });
    if (result) setSnapshot(result);
  };

  return (
    <>
      <SettingsSection
        title="Add or Edit Server"
        description="Project servers apply only to this workspace. User servers apply everywhere."
      >
        <SettingsCard className="p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <SettingsSelect
              label="Scope"
              value={draft.scope}
              options={SCOPE_OPTIONS}
              onValueChange={(scope) =>
                setDraft((current) => ({
                  ...current,
                  scope: scope as QwenSettingsScope,
                }))
              }
            />
            <SettingsSelect
              label="Transport"
              value={draft.transport}
              options={TRANSPORT_OPTIONS}
              onValueChange={(transport) =>
                setDraft((current) => ({
                  ...current,
                  transport: transport as QwenMcpTransport,
                }))
              }
            />
            <SettingsInput
              label="Name"
              value={draft.name}
              onChange={(name) => setDraft((current) => ({ ...current, name }))}
              placeholder="my-server"
            />
          </div>
          <SettingsInput
            label={draft.transport === 'stdio' ? 'Command' : 'URL'}
            value={draft.commandOrUrl}
            onChange={(commandOrUrl) =>
              setDraft((current) => ({ ...current, commandOrUrl }))
            }
            placeholder={
              draft.transport === 'stdio' ? 'node' : 'http://localhost:3000/mcp'
            }
          />
          {draft.transport === 'stdio' ? (
            <SettingsTextarea
              label="Arguments"
              description="One argument per line."
              value={draft.args}
              onChange={(args) => setDraft((current) => ({ ...current, args }))}
              placeholder={'-m\nmy_mcp_server'}
              rows={3}
            />
          ) : (
            <SettingsTextarea
              label="Headers"
              description="One KEY=value pair per line."
              value={draft.headers}
              onChange={(headers) =>
                setDraft((current) => ({ ...current, headers }))
              }
              placeholder="Authorization=Bearer ${TOKEN}"
              rows={3}
            />
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <SettingsInput
              label="Timeout"
              value={draft.timeout}
              onChange={(timeout) =>
                setDraft((current) => ({ ...current, timeout }))
              }
              placeholder="15000"
            />
            <SettingsInput
              label="Description"
              value={draft.description}
              onChange={(description) =>
                setDraft((current) => ({ ...current, description }))
              }
              placeholder="Internal tools"
            />
          </div>
          {draft.transport === 'stdio' ? (
            <SettingsTextarea
              label="Environment"
              description="One KEY=value pair per line."
              value={draft.env}
              onChange={(env) => setDraft((current) => ({ ...current, env }))}
              placeholder="API_KEY=${API_KEY}"
              rows={3}
            />
          ) : null}
          <SettingsToggle
            inCard={false}
            label="Trust this server"
            description="Skip confirmations for tools from this server."
            checked={draft.trust}
            onCheckedChange={(trust) =>
              setDraft((current) => ({ ...current, trust }))
            }
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => setDraft(createEmptyMcpDraft())}
            >
              Clear
            </Button>
            <Button
              onClick={() => void save()}
              disabled={!draft.name.trim() || !draft.commandOrUrl.trim()}
            >
              <Plus className="w-4 h-4 mr-2" />
              Save Server
            </Button>
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Configured Servers"
        description="Servers saved in User and Project Qwen settings."
      >
        <div className="space-y-3">
          {entries.length === 0 ? (
            <EmptyState
              title="No MCP servers configured"
              description="Add an HTTP, SSE, or stdio server above."
            />
          ) : (
            entries.map((entry) => (
              <SettingsCard
                key={`${entry.scope}:${entry.name}`}
                className="px-4 py-3.5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{entry.name}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {entry.scope} · {entry.server.transport} ·{' '}
                      {entry.server.command ??
                        entry.server.httpUrl ??
                        entry.server.url}
                    </div>
                    {entry.server.description ? (
                      <div className="text-xs text-muted-foreground mt-1">
                        {entry.server.description}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setDraft(serverToDraft(entry))}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void remove(entry)}
                    >
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              </SettingsCard>
            ))
          )}
        </div>
      </SettingsSection>
    </>
  );
}

function HooksTab({
  snapshot,
  runCommand,
  setSnapshot,
  onSave,
}: {
  snapshot: QwenCoreSettingsSnapshot;
  runCommand: RunQwenSettingsCommand;
  setSnapshot: (snapshot: QwenCoreSettingsSnapshot) => void;
  onSave: (
    key: QwenCoreSettingKey,
    value: QwenSettingValue,
    scope?: QwenSettingsScope,
  ) => Promise<void>;
}) {
  const [draft, setDraft] = useState<HookDraft>(createEmptyHookDraft);
  const entries = useMemo(
    () => [...snapshot.user.hooks, ...snapshot.workspace.hooks],
    [snapshot],
  );

  const save = async () => {
    if (!draft.commandOrUrl.trim()) return;
    const result = await runCommand({
      type: 'setQwenHook',
      scope: draft.scope,
      event: draft.event,
      index: draft.index,
      hook: draftToHook(draft),
    });
    if (result) {
      setSnapshot(result);
      setDraft(createEmptyHookDraft());
    }
  };

  const remove = async (entry: QwenHookEntry) => {
    if (entry.scope !== 'user' && entry.scope !== 'workspace') return;
    const result = await runCommand({
      type: 'removeQwenHook',
      scope: entry.scope,
      event: entry.event,
      index: entry.index,
    });
    if (result) setSnapshot(result);
  };

  return (
    <>
      <SettingsSection
        title="Hook Control"
        description="Disable hooks without deleting configured hook definitions."
      >
        <SettingsCard>
          <SettingsToggle
            label="Disable all hooks"
            description="Temporarily skip every configured hook."
            checked={boolValue(snapshot, 'disableAllHooks', false)}
            onCheckedChange={(checked) =>
              void onSave('disableAllHooks', checked)
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Add or Edit Hook"
        description="Command hooks receive JSON through stdin. HTTP hooks receive a POST body."
      >
        <SettingsCard className="p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <SettingsSelect
              label="Scope"
              value={draft.scope}
              options={SCOPE_OPTIONS}
              onValueChange={(scope) =>
                setDraft((current) => ({
                  ...current,
                  scope: scope as QwenSettingsScope,
                }))
              }
            />
            <SettingsSelect
              label="Event"
              value={draft.event}
              options={HOOK_EVENT_OPTIONS}
              onValueChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  event: event as QwenHookEvent,
                }))
              }
            />
            <SettingsSelect
              label="Type"
              value={draft.type}
              options={[
                { value: 'command', label: 'Command' },
                { value: 'http', label: 'HTTP' },
              ]}
              onValueChange={(type) =>
                setDraft((current) => ({
                  ...current,
                  type: type as 'command' | 'http',
                }))
              }
            />
          </div>
          <SettingsInput
            label="Matcher"
            value={draft.matcher}
            onChange={(matcher) =>
              setDraft((current) => ({ ...current, matcher }))
            }
            placeholder="*"
          />
          <SettingsInput
            label={draft.type === 'command' ? 'Command' : 'URL'}
            value={draft.commandOrUrl}
            onChange={(commandOrUrl) =>
              setDraft((current) => ({ ...current, commandOrUrl }))
            }
            placeholder={
              draft.type === 'command'
                ? '$QWEN_PROJECT_DIR/.qwen/hooks/check.sh'
                : 'http://127.0.0.1:8080/hook'
            }
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <SettingsInput
              label="Name"
              value={draft.name}
              onChange={(name) => setDraft((current) => ({ ...current, name }))}
            />
            <SettingsInput
              label="Timeout"
              value={draft.timeout}
              onChange={(timeout) =>
                setDraft((current) => ({ ...current, timeout }))
              }
              placeholder="10000"
            />
          </div>
          <SettingsInput
            label="Description"
            value={draft.description}
            onChange={(description) =>
              setDraft((current) => ({ ...current, description }))
            }
          />
          {draft.type === 'command' ? (
            <SettingsTextarea
              label="Environment"
              description="One KEY=value pair per line."
              value={draft.env}
              onChange={(env) => setDraft((current) => ({ ...current, env }))}
              rows={3}
            />
          ) : (
            <>
              <SettingsTextarea
                label="Headers"
                description="One KEY=value pair per line."
                value={draft.headers}
                onChange={(headers) =>
                  setDraft((current) => ({ ...current, headers }))
                }
                rows={3}
              />
              <SettingsTextarea
                label="Allowed env vars"
                description="One variable name per line for URL/header interpolation."
                value={draft.allowedEnvVars}
                onChange={(allowedEnvVars) =>
                  setDraft((current) => ({ ...current, allowedEnvVars }))
                }
                rows={3}
              />
            </>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <SettingsToggle
              inCard={false}
              label="Sequential"
              description="Run hooks in order."
              checked={draft.sequential}
              onCheckedChange={(sequential) =>
                setDraft((current) => ({ ...current, sequential }))
              }
            />
            <SettingsToggle
              inCard={false}
              label={draft.type === 'command' ? 'Async' : 'Once'}
              description={
                draft.type === 'command'
                  ? 'Run without blocking the session.'
                  : 'Run once per session.'
              }
              checked={draft.type === 'command' ? draft.async : draft.once}
              onCheckedChange={(checked) =>
                setDraft((current) =>
                  draft.type === 'command'
                    ? { ...current, async: checked }
                    : { ...current, once: checked },
                )
              }
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => setDraft(createEmptyHookDraft())}
            >
              Clear
            </Button>
            <Button
              onClick={() => void save()}
              disabled={!draft.commandOrUrl.trim()}
            >
              <Save className="w-4 h-4 mr-2" />
              Save Hook
            </Button>
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Configured Hooks"
        description="User and Project hook definitions. Extension hooks are shown in Extensions."
      >
        <div className="space-y-3">
          {entries.length === 0 ? (
            <EmptyState
              title="No hooks configured"
              description="Add a command or HTTP hook above."
            />
          ) : (
            entries.map((entry) => {
              const config = entry.hook.hooks[0];
              return (
                <SettingsCard
                  key={`${entry.scope}:${entry.event}:${entry.index}`}
                  className="px-4 py-3.5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{entry.event}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {entry.scope} · {config?.type} ·{' '}
                        {entry.hook.matcher || '*'}
                      </div>
                      <div className="text-xs font-mono text-muted-foreground mt-1 truncate">
                        {config?.command ?? config?.url}
                      </div>
                    </div>
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDraft(hookToDraft(entry))}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void remove(entry)}
                      >
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                </SettingsCard>
              );
            })
          )}
        </div>
      </SettingsSection>
    </>
  );
}

function ExtensionsTab({
  snapshot,
  runCommand,
  setSnapshot,
}: {
  snapshot: QwenCoreSettingsSnapshot;
  runCommand: RunQwenSettingsCommand;
  setSnapshot: (snapshot: QwenCoreSettingsSnapshot) => void;
}) {
  return (
    <SettingsSection
      title="Installed Extensions"
      description="Settings exposed by loaded Qwen Code extensions. Sensitive values are never displayed."
    >
      <div className="space-y-3">
        {snapshot.merged.extensions.length === 0 ? (
          <EmptyState
            title="No extensions loaded"
            description="Installed extensions will appear here when Qwen Code loads them."
          />
        ) : (
          snapshot.merged.extensions.map((extension) => (
            <ExtensionCard
              key={extension.id}
              extension={extension}
              runCommand={runCommand}
              setSnapshot={setSnapshot}
            />
          ))
        )}
      </div>
    </SettingsSection>
  );
}

function ExtensionCard({
  extension,
  runCommand,
  setSnapshot,
}: {
  extension: QwenExtensionSettingsEntry;
  runCommand: RunQwenSettingsCommand;
  setSnapshot: (snapshot: QwenCoreSettingsSnapshot) => void;
}) {
  return (
    <SettingsCard className="px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">{extension.name}</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {extension.version} · {extension.isActive ? 'Active' : 'Inactive'}
          </div>
          <div className="text-[11px] text-muted-foreground/70 mt-1 truncate font-mono">
            {extension.path}
          </div>
        </div>
      </div>
      <div className="mt-3 text-xs text-muted-foreground">
        {extension.commands.length} commands · {extension.skills.length} skills
        · {extension.mcpServers.length} MCP servers
      </div>
      <div className="mt-3 divide-y divide-border/60">
        {extension.settings.length === 0 ? (
          <div className="py-3 text-xs text-muted-foreground">
            No configurable settings.
          </div>
        ) : (
          extension.settings.map((setting) => (
            <ExtensionSettingRow
              key={setting.envVar}
              extension={extension}
              setting={setting}
              runCommand={runCommand}
              setSnapshot={setSnapshot}
            />
          ))
        )}
      </div>
    </SettingsCard>
  );
}

function ExtensionSettingRow({
  extension,
  setting,
  runCommand,
  setSnapshot,
}: {
  extension: QwenExtensionSettingsEntry;
  setting: QwenExtensionSettingsEntry['settings'][number];
  runCommand: RunQwenSettingsCommand;
  setSnapshot: (snapshot: QwenCoreSettingsSnapshot) => void;
}) {
  const [scope, setScope] = useState<QwenSettingsScope>(
    setting.effectiveScope ?? 'user',
  );
  const [draft, setDraft] = useState(
    setting.sensitive ? '' : String(setting.effectiveValue ?? ''),
  );

  useEffect(() => {
    setScope(setting.effectiveScope ?? 'user');
    setDraft(setting.sensitive ? '' : String(setting.effectiveValue ?? ''));
  }, [setting]);

  const save = async () => {
    const result = await runCommand({
      type: 'setQwenExtensionSetting',
      extensionId: extension.id,
      settingKey: setting.envVar,
      scope,
      value: draft,
    });
    if (result) setSnapshot(result);
  };

  return (
    <div className="py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">{setting.name}</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {setting.description}
          </div>
          <div className="text-[11px] text-muted-foreground/70 mt-1 font-mono">
            {setting.envVar}
          </div>
        </div>
        <SettingsSelect
          value={scope}
          options={SCOPE_OPTIONS}
          onValueChange={(value) => setScope(value as QwenSettingsScope)}
          className="w-32"
        />
      </div>
      <div className="flex gap-2 mt-2">
        <Input
          value={draft}
          type={setting.sensitive ? 'password' : 'text'}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={
            setting.sensitive &&
            (setting.hasUserValue || setting.hasWorkspaceValue)
              ? 'Stored securely'
              : 'Value'
          }
          className="h-8 bg-muted/50"
        />
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={!draft && setting.sensitive}
        >
          <Save className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
