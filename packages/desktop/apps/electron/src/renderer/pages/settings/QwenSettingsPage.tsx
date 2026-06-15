import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Settings2,
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
import { routes } from '@/lib/navigate';
import type { DetailsPageMeta } from '@/lib/navigation-registry';
import { normalizeQwenSettingsSnapshot } from '@/lib/qwen-settings-snapshot';
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
  titleKey: string;
  descriptionKey: string;
  slug: QwenSettingsTab;
};

type RunQwenSettingsCommand = (
  command: SessionCommand,
) => Promise<QwenCoreSettingsSnapshot | null>;

const PAGE_COPY: Record<QwenSettingsTab, PageCopy> = {
  general: {
    titleKey: 'settings.general.title',
    descriptionKey: 'settings.general.description',
    slug: 'general',
  },
  mcpServers: {
    titleKey: 'settings.mcpServers.title',
    descriptionKey: 'settings.mcpServers.description',
    slug: 'mcpServers',
  },
  hooks: {
    titleKey: 'settings.hooks.title',
    descriptionKey: 'settings.hooks.description',
    slug: 'hooks',
  },
  extensions: {
    titleKey: 'settings.extensions.title',
    descriptionKey: 'settings.extensions.description',
    slug: 'extensions',
  },
};

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

async function runSharedQwenSettingsCommand(
  command: SessionCommand,
): Promise<QwenCoreSettingsSnapshot | null> {
  if (!window.electronAPI) return null;

  switch (command.type) {
    case 'getQwenCoreSettings':
      return window.electronAPI.getQwenCoreSettings();
    case 'setQwenCoreSetting':
      return window.electronAPI.setQwenCoreSetting(
        command.scope,
        command.key,
        command.value,
      );
    case 'setQwenMcpServer':
      return window.electronAPI.setQwenMcpServer(
        command.scope,
        command.name,
        command.server,
      );
    case 'removeQwenMcpServer':
      return window.electronAPI.removeQwenMcpServer(
        command.scope,
        command.name,
      );
    case 'setQwenHook':
      return window.electronAPI.setQwenHook(
        command.scope,
        command.event,
        command.index,
        command.hook,
      );
    case 'removeQwenHook':
      return window.electronAPI.removeQwenHook(
        command.scope,
        command.event,
        command.index,
      );
    case 'setQwenExtensionSetting':
      return window.electronAPI.setQwenExtensionSetting(
        command.extensionId,
        command.settingKey,
        command.scope,
        command.value,
      );
    default:
      return null;
  }
}

export default function QwenSettingsPage({ tab }: { tab: QwenSettingsTab }) {
  const { t } = useTranslation();
  const copy = PAGE_COPY[tab];
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const [snapshot, setSnapshot] = useState<QwenCoreSettingsSnapshot | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const runCommand = useCallback(
    async (command: SessionCommand) => {
      if (!window.electronAPI) return null;
      const result = await runSharedQwenSettingsCommand(command);
      return normalizeQwenSettingsSnapshot(result as QwenCoreSettingsSnapshot);
    },
    [],
  );

  const load = useCallback(async () => {
    if (!window.electronAPI) {
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
  }, [runCommand]);

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
        toast.error(t('settings.qwen.failedToSaveSetting'), {
          description:
            saveError instanceof Error ? saveError.message : String(saveError),
        });
      }
    },
    [runCommand, t],
  );

  return (
    <div className="h-full flex flex-col">
      <PanelHeader
        title={t(copy.titleKey)}
        actions={<HeaderMenu route={routes.view.settings(copy.slug)} />}
      />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full" viewportRef={scrollViewportRef}>
          <div className="px-5 py-7 max-w-3xl mx-auto">
            <div className="space-y-8">
              <SettingsSection
                title={t(copy.titleKey)}
                description={t(copy.descriptionKey)}
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
              ) : !snapshot ? (
                <EmptyState
                  title={t('settings.qwen.settingsUnavailableTitle')}
                  description={t('settings.qwen.settingsUnavailableDesc')}
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
                  scrollViewportRef={scrollViewportRef}
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
                    {t('settings.qwen.refresh')}
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
  const { t } = useTranslation();
  const outputLanguage = stringValue(
    snapshot,
    'general.outputLanguage',
    'auto',
  );
  const [outputLanguageDraft, setOutputLanguageDraft] =
    useState(outputLanguage);
  useEffect(() => setOutputLanguageDraft(outputLanguage), [outputLanguage]);
  const approvalModeOptions = useMemo(
    () => [
      { value: 'plan', label: t('settings.qwen.approvalMode.plan') },
      { value: 'default', label: t('settings.qwen.approvalMode.default') },
      { value: 'auto-edit', label: t('settings.qwen.approvalMode.autoEdit') },
      { value: 'yolo', label: t('settings.qwen.approvalMode.yolo') },
    ],
    [t],
  );
  const fileEncodingOptions = useMemo(
    () => [
      { value: 'utf-8', label: 'UTF-8' },
      { value: 'utf-8-bom', label: t('settings.qwen.fileEncoding.utf8Bom') },
    ],
    [t],
  );

  return (
    <>
      <SettingsSection
        title={t('settings.qwen.general.responseLanguage')}
        description={t('settings.qwen.general.responseLanguageDesc')}
      >
        <SettingsCard>
          <SettingsInput
            inCard
            label={t('settings.qwen.general.outputLanguage')}
            description={t('settings.qwen.general.outputLanguageDesc')}
            value={outputLanguageDraft}
            placeholder={t('settings.qwen.option.auto')}
            onChange={(value) => {
              setOutputLanguageDraft(value);
              void onSave('general.outputLanguage', value);
            }}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={t('settings.qwen.general.everydayBehavior')}
        description={t('settings.qwen.general.everydayBehaviorDesc')}
      >
        <SettingsCard>
          <SettingsSelect
            inCard
            label={t('settings.qwen.general.toolApprovalMode')}
            description={t('settings.qwen.general.toolApprovalModeDesc')}
            value={stringValue(snapshot, 'tools.approvalMode', 'default')}
            options={approvalModeOptions}
            onValueChange={(value) => void onSave('tools.approvalMode', value)}
          />
          <SettingsToggle
            label={t('settings.qwen.general.commitAttribution')}
            description={t('settings.qwen.general.commitAttributionDesc')}
            checked={boolValue(snapshot, 'general.gitCoAuthor.commit', true)}
            onCheckedChange={(checked) =>
              void onSave('general.gitCoAuthor.commit', checked)
            }
          />
          <SettingsToggle
            label={t('settings.qwen.general.prAttribution')}
            description={t('settings.qwen.general.prAttributionDesc')}
            checked={boolValue(snapshot, 'general.gitCoAuthor.pr', true)}
            onCheckedChange={(checked) =>
              void onSave('general.gitCoAuthor.pr', checked)
            }
          />
          <SettingsSelect
            inCard
            label={t('settings.qwen.general.defaultFileEncoding')}
            description={t('settings.qwen.general.defaultFileEncodingDesc')}
            value={stringValue(
              snapshot,
              'general.defaultFileEncoding',
              'utf-8',
            )}
            options={fileEncodingOptions}
            onValueChange={(value) =>
              void onSave('general.defaultFileEncoding', value)
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={t('settings.qwen.general.fileSearch')}
        description={t('settings.qwen.general.fileSearchDesc')}
      >
        <SettingsCard>
          <SettingsToggle
            label={t('settings.qwen.general.respectGitIgnore')}
            description={t('settings.qwen.general.respectGitIgnoreDesc')}
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
            label={t('settings.qwen.general.respectQwenIgnore')}
            description={t('settings.qwen.general.respectQwenIgnoreDesc')}
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
            label={t('settings.qwen.general.fuzzyFileSearch')}
            description={t('settings.qwen.general.fuzzyFileSearchDesc')}
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

function McpServersTab({
  snapshot,
  runCommand,
  setSnapshot,
}: {
  snapshot: QwenCoreSettingsSnapshot;
  runCommand: RunQwenSettingsCommand;
  setSnapshot: (snapshot: QwenCoreSettingsSnapshot) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<McpDraft>(createEmptyMcpDraft);
  const [showEditor, setShowEditor] = useState(false);
  const scopeOptions = useMemo(
    () => [
      { value: 'user', label: t('settings.qwen.scope.user') },
      { value: 'workspace', label: t('settings.qwen.scope.project') },
    ],
    [t],
  );
  const entries = useMemo(
    () => [
      ...snapshot.user.mcpServers,
      ...snapshot.workspace.mcpServers,
      ...snapshot.merged.mcpServers.filter(
        (entry) => entry.scope === 'extension',
      ),
    ],
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
      setShowEditor(false);
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
        title={t('settings.qwen.mcp.configuredServers')}
        description={t('settings.qwen.mcp.configuredServersDesc')}
      >
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            onClick={() => {
              setDraft(createEmptyMcpDraft());
              setShowEditor(true);
            }}
          >
            <Plus className="w-4 h-4" />
            {t('settings.qwen.mcp.addServer')}
          </Button>
        </div>
        <div className="mt-3 space-y-3">
          {entries.length === 0 ? (
            <EmptyState
              title={t('settings.qwen.mcp.noServersTitle')}
              description={t('settings.qwen.mcp.noServersDesc')}
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
                  {entry.scope === 'extension' ? null : (
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setDraft(serverToDraft(entry));
                          setShowEditor(true);
                        }}
                        aria-label={t('common.edit')}
                      >
                        <Settings2 className="w-4 h-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void remove(entry)}
                      >
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    </div>
                  )}
                </div>
              </SettingsCard>
            ))
          )}
        </div>
      </SettingsSection>

      {showEditor ? (
        <SettingsSection
          title={t('settings.qwen.mcp.addOrEditServer')}
          description={t('settings.qwen.mcp.addOrEditServerDesc')}
        >
          <SettingsCard className="p-4 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <SettingsSelect
                label={t('settings.qwen.common.scope')}
                value={draft.scope}
                options={scopeOptions}
                onValueChange={(scope) =>
                  setDraft((current) => ({
                    ...current,
                    scope: scope as QwenSettingsScope,
                  }))
                }
              />
              <SettingsSelect
                label={t('settings.qwen.mcp.transport')}
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
                label={t('settings.qwen.common.name')}
                value={draft.name}
                onChange={(name) =>
                  setDraft((current) => ({ ...current, name }))
                }
                placeholder="my-server"
              />
            </div>
            <SettingsInput
              label={
                draft.transport === 'stdio'
                  ? t('settings.qwen.common.command')
                  : t('settings.qwen.common.url')
              }
              value={draft.commandOrUrl}
              onChange={(commandOrUrl) =>
                setDraft((current) => ({ ...current, commandOrUrl }))
              }
              placeholder={
                draft.transport === 'stdio'
                  ? 'node'
                  : 'http://localhost:3000/mcp'
              }
            />
            {draft.transport === 'stdio' ? (
              <SettingsTextarea
                label={t('settings.qwen.mcp.arguments')}
                description={t('settings.qwen.mcp.oneArgumentPerLine')}
                value={draft.args}
                onChange={(args) =>
                  setDraft((current) => ({ ...current, args }))
                }
                placeholder={'-m\nmy_mcp_server'}
                rows={3}
              />
            ) : (
              <SettingsTextarea
                label={t('settings.qwen.common.headers')}
                description={t('settings.qwen.common.oneKeyValuePerLine')}
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
                label={t('settings.qwen.common.timeout')}
                value={draft.timeout}
                onChange={(timeout) =>
                  setDraft((current) => ({ ...current, timeout }))
                }
                placeholder="15000"
              />
              <SettingsInput
                label={t('settings.qwen.common.description')}
                value={draft.description}
                onChange={(description) =>
                  setDraft((current) => ({ ...current, description }))
                }
                placeholder="Internal tools"
              />
            </div>
            {draft.transport === 'stdio' ? (
              <SettingsTextarea
                label={t('settings.qwen.common.environment')}
                description={t('settings.qwen.common.oneKeyValuePerLine')}
                value={draft.env}
                onChange={(env) => setDraft((current) => ({ ...current, env }))}
                placeholder="API_KEY=${API_KEY}"
                rows={3}
              />
            ) : null}
            <SettingsToggle
              inCard={false}
              label={t('settings.qwen.mcp.trustThisServer')}
              description={t('settings.qwen.mcp.trustThisServerDesc')}
              checked={draft.trust}
              onCheckedChange={(trust) =>
                setDraft((current) => ({ ...current, trust }))
              }
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  setDraft(createEmptyMcpDraft());
                  setShowEditor(false);
                }}
              >
                {t('common.clear')}
              </Button>
              <Button
                onClick={() => void save()}
                disabled={!draft.name.trim() || !draft.commandOrUrl.trim()}
              >
                <Save className="w-4 h-4 mr-2" />
                {t('settings.qwen.mcp.saveServer')}
              </Button>
            </div>
          </SettingsCard>
        </SettingsSection>
      ) : null}
    </>
  );
}

function HooksTab({
  snapshot,
  runCommand,
  setSnapshot,
  onSave,
  scrollViewportRef,
}: {
  snapshot: QwenCoreSettingsSnapshot;
  runCommand: RunQwenSettingsCommand;
  setSnapshot: (snapshot: QwenCoreSettingsSnapshot) => void;
  onSave: (
    key: QwenCoreSettingKey,
    value: QwenSettingValue,
    scope?: QwenSettingsScope,
  ) => Promise<void>;
  scrollViewportRef: RefObject<HTMLDivElement>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<HookDraft>(createEmptyHookDraft);
  const [showEditor, setShowEditor] = useState(false);
  const [editorScrollRequest, setEditorScrollRequest] = useState(0);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const scopeOptions = useMemo(
    () => [
      { value: 'user', label: t('settings.qwen.scope.user') },
      { value: 'workspace', label: t('settings.qwen.scope.project') },
    ],
    [t],
  );
  const hookTypeOptions = useMemo(
    () => [
      { value: 'command', label: t('settings.qwen.common.command') },
      { value: 'http', label: 'HTTP' },
    ],
    [t],
  );
  const entries = useMemo(
    () => [
      ...snapshot.user.hooks,
      ...snapshot.workspace.hooks,
      ...snapshot.merged.hooks.filter((entry) => entry.scope === 'extension'),
    ],
    [snapshot],
  );

  const openEditor = useCallback((nextDraft: HookDraft) => {
    setDraft(nextDraft);
    setShowEditor(true);
    setEditorScrollRequest((count) => count + 1);
  }, []);

  useEffect(() => {
    if (!showEditor) return;
    const frameId = requestAnimationFrame(() => {
      const viewport = scrollViewportRef.current;
      const editor = editorRef.current;
      if (!viewport || !editor) return;
      const viewportRect = viewport.getBoundingClientRect();
      const editorRect = editor.getBoundingClientRect();
      viewport.scrollTo({
        top: Math.max(
          0,
          viewport.scrollTop + editorRect.top - viewportRect.top - 8,
        ),
        behavior: 'smooth',
      });
    });
    return () => cancelAnimationFrame(frameId);
  }, [editorScrollRequest, scrollViewportRef, showEditor]);

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
      setShowEditor(false);
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
        title={t('settings.qwen.hooks.hookControl')}
        description={t('settings.qwen.hooks.hookControlDesc')}
      >
        <SettingsCard>
          <SettingsToggle
            label={t('settings.qwen.hooks.disableAllHooks')}
            description={t('settings.qwen.hooks.disableAllHooksDesc')}
            checked={boolValue(snapshot, 'disableAllHooks', false)}
            onCheckedChange={(checked) =>
              void onSave('disableAllHooks', checked)
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={t('settings.qwen.hooks.configuredHooks')}
        description={t('settings.qwen.hooks.configuredHooksDesc')}
      >
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            onClick={() => {
              openEditor(createEmptyHookDraft());
            }}
          >
            <Plus className="w-4 h-4" />
            {t('settings.qwen.hooks.addHook')}
          </Button>
        </div>
        <div className="mt-3 space-y-3">
          {entries.length === 0 ? (
            <EmptyState
              title={t('settings.qwen.hooks.noHooksTitle')}
              description={t('settings.qwen.hooks.noHooksDesc')}
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
                    {entry.scope === 'extension' ? null : (
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            openEditor(hookToDraft(entry));
                          }}
                          aria-label={t('common.edit')}
                        >
                          <Settings2 className="w-4 h-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void remove(entry)}
                        >
                          <Trash2 className="w-4 h-4 text-destructive" />
                        </Button>
                      </div>
                    )}
                  </div>
                </SettingsCard>
              );
            })
          )}
        </div>
      </SettingsSection>

      {showEditor ? (
        <div ref={editorRef}>
          <SettingsSection
            title={t('settings.qwen.hooks.addOrEditHook')}
            description={t('settings.qwen.hooks.addOrEditHookDesc')}
          >
            <SettingsCard className="p-4 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <SettingsSelect
                label={t('settings.qwen.common.scope')}
                value={draft.scope}
                options={scopeOptions}
                onValueChange={(scope) =>
                  setDraft((current) => ({
                    ...current,
                    scope: scope as QwenSettingsScope,
                  }))
                }
              />
              <SettingsSelect
                label={t('settings.qwen.hooks.event')}
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
                label={t('settings.qwen.hooks.type')}
                value={draft.type}
                options={hookTypeOptions}
                onValueChange={(type) =>
                  setDraft((current) => ({
                    ...current,
                    type: type as 'command' | 'http',
                  }))
                }
              />
            </div>
            <SettingsInput
              label={t('settings.qwen.hooks.matcher')}
              value={draft.matcher}
              onChange={(matcher) =>
                setDraft((current) => ({ ...current, matcher }))
              }
              placeholder="*"
            />
            <SettingsInput
              label={
                draft.type === 'command'
                  ? t('settings.qwen.common.command')
                  : t('settings.qwen.common.url')
              }
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
                label={t('settings.qwen.common.name')}
                value={draft.name}
                onChange={(name) =>
                  setDraft((current) => ({ ...current, name }))
                }
              />
              <SettingsInput
                label={t('settings.qwen.common.timeout')}
                value={draft.timeout}
                onChange={(timeout) =>
                  setDraft((current) => ({ ...current, timeout }))
                }
                placeholder="10000"
              />
            </div>
            <SettingsInput
              label={t('settings.qwen.common.description')}
              value={draft.description}
              onChange={(description) =>
                setDraft((current) => ({ ...current, description }))
              }
            />
            {draft.type === 'command' ? (
              <SettingsTextarea
                label={t('settings.qwen.common.environment')}
                description={t('settings.qwen.common.oneKeyValuePerLine')}
                value={draft.env}
                onChange={(env) => setDraft((current) => ({ ...current, env }))}
                rows={3}
              />
            ) : (
              <>
                <SettingsTextarea
                  label={t('settings.qwen.common.headers')}
                  description={t('settings.qwen.common.oneKeyValuePerLine')}
                  value={draft.headers}
                  onChange={(headers) =>
                    setDraft((current) => ({ ...current, headers }))
                  }
                  rows={3}
                />
                <SettingsTextarea
                  label={t('settings.qwen.hooks.allowedEnvVars')}
                  description={t('settings.qwen.hooks.allowedEnvVarsDesc')}
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
                label={t('settings.qwen.hooks.sequential')}
                description={t('settings.qwen.hooks.sequentialDesc')}
                checked={draft.sequential}
                onCheckedChange={(sequential) =>
                  setDraft((current) => ({ ...current, sequential }))
                }
              />
              <SettingsToggle
                inCard={false}
                label={
                  draft.type === 'command'
                    ? t('settings.qwen.hooks.async')
                    : t('settings.qwen.hooks.once')
                }
                description={
                  draft.type === 'command'
                    ? t('settings.qwen.hooks.asyncDesc')
                    : t('settings.qwen.hooks.onceDesc')
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
                onClick={() => {
                  setDraft(createEmptyHookDraft());
                  setShowEditor(false);
                }}
              >
                {t('common.clear')}
              </Button>
              <Button
                onClick={() => void save()}
                disabled={!draft.commandOrUrl.trim()}
              >
                <Save className="w-4 h-4 mr-2" />
                {t('settings.qwen.hooks.saveHook')}
              </Button>
            </div>
            </SettingsCard>
          </SettingsSection>
        </div>
      ) : null}
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
  const { t } = useTranslation();
  return (
    <SettingsSection
      title={t('settings.qwen.extensions.installedExtensions')}
      description={t('settings.qwen.extensions.installedExtensionsDesc')}
    >
      <div className="space-y-3">
        {snapshot.merged.extensions.length === 0 ? (
          <EmptyState
            title={t('settings.qwen.extensions.noExtensionsTitle')}
            description={t('settings.qwen.extensions.noExtensionsDesc')}
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
  const { t } = useTranslation();
  return (
    <SettingsCard className="px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">{extension.name}</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {extension.version} ·{' '}
            {extension.isActive
              ? t('settings.qwen.extensions.active')
              : t('settings.qwen.extensions.inactive')}
          </div>
          <div className="text-[11px] text-muted-foreground/70 mt-1 truncate font-mono">
            {extension.path}
          </div>
        </div>
      </div>
      <div className="mt-3 text-xs text-muted-foreground">
        {t('settings.qwen.extensions.summary', {
          commands: extension.commands.length,
          skills: extension.skills.length,
          mcpServers: extension.mcpServers.length,
        })}
      </div>
      <div className="mt-3 divide-y divide-border/60">
        {extension.settings.length === 0 ? (
          <div className="py-3 text-xs text-muted-foreground">
            {t('settings.qwen.extensions.noConfigurableSettings')}
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
  const { t } = useTranslation();
  const [scope, setScope] = useState<QwenSettingsScope>(
    setting.effectiveScope ?? 'user',
  );
  const scopeOptions = useMemo(
    () => [
      { value: 'user', label: t('settings.qwen.scope.user') },
      { value: 'workspace', label: t('settings.qwen.scope.project') },
    ],
    [t],
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
          options={scopeOptions}
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
              ? t('settings.qwen.extensions.storedSecurely')
              : t('settings.qwen.extensions.value')
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
