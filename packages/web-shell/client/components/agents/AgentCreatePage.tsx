import { useEffect, useMemo, useRef, useState } from 'react';
import { SparklesIcon, XIcon } from 'lucide-react';
import {
  DAEMON_APPROVAL_MODES,
  useAgents,
  useMcp,
  useSettings,
  useTools,
  type DaemonWorkspaceAgentDetail,
  type DaemonWorkspaceMcpToolStatus,
} from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Checkbox } from '../ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../ui/field';
import { Input } from '../ui/input';
import { ManagementNotice } from '../ui/management-notice';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Spinner } from '../ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { Textarea } from '../ui/textarea';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../ui/tooltip';
import {
  selectBuiltInTools,
  selectDiscoverableMcpServerNames,
} from './agent-tool-options';

interface AgentCreatePageProps {
  initialScope?: 'workspace' | 'global';
  agent?: DaemonWorkspaceAgentDetail;
  onCancel: () => void;
  onCreated: (name: string) => void;
}

type Translate = ReturnType<typeof useI18n>['t'];
type GenerationField = 'description' | 'systemPrompt';

function parseRecord(
  value: string,
  label: string,
): Record<string, unknown> | undefined {
  if (!value.trim()) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^[A-Z]+ \/\S+:\s*/, '');
}

function toggleSelection(
  current: Set<string>,
  name: string,
  checked: boolean,
): Set<string> {
  const next = new Set(current);
  if (checked) next.add(name);
  else next.delete(name);
  return next;
}

const approvalModes = ['inherit', ...DAEMON_APPROVAL_MODES];
const MCP_DISCOVERY_POLL_MS = 1_500;
const MCP_DISCOVERY_MAX_ATTEMPTS = 40;

export function AgentCreatePage({
  initialScope = 'global',
  agent,
  onCancel,
  onCreated,
}: AgentCreatePageProps) {
  const { t } = useI18n();
  // @ts-expect-error generateContent exists in webui source, not in stale dist
  const { createAgent, updateAgent, generateContent } = useAgents({
    autoLoad: false,
  });
  const toolsResource = useTools({ autoLoad: false });
  const mcpResource = useMcp({ autoLoad: false });
  const settingsResource = useSettings({ autoLoad: true });
  const loadMcpTools = mcpResource.loadTools;
  const initializeMcp = mcpResource.initialize;
  const reloadMcpConfig = mcpResource.reloadConfig;
  const reloadMcp = mcpResource.reload;
  // @ts-expect-error preheat exists in webui source, not in stale dist
  const preheatAcp = toolsResource.preheat;
  const reloadTools = toolsResource.reload;
  const existingScope = agent?.level === 'user' ? 'global' : 'workspace';
  const [scope, setScope] = useState<'workspace' | 'global'>(
    agent ? existingScope : initialScope,
  );
  const [name, setName] = useState(agent?.name ?? '');
  const [description, setDescription] = useState(agent?.description ?? '');
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? '');
  const [selectedTools, setSelectedTools] = useState(
    () => new Set(agent?.tools?.includes('*') ? [] : (agent?.tools ?? [])),
  );
  const [disallowedTools, setDisallowedTools] = useState(
    () => new Set(agent?.disallowedTools ?? []),
  );
  const [model, setModel] = useState(agent?.model ?? '');
  const [approvalMode, setApprovalMode] = useState(
    agent?.approvalMode ?? 'inherit',
  );
  const selectableApprovalModes =
    approvalMode === 'bubble' ? [...approvalModes, 'bubble'] : approvalModes;
  // @ts-expect-error maxTurns exists in SDK source, not in stale dist
  const [maxTurns, setMaxTurns] = useState(agent?.maxTurns?.toString() ?? '');
  const [color, setColor] = useState(agent?.color ?? 'inherit');
  const [selectedMcpServers, setSelectedMcpServers] = useState(
    // @ts-expect-error mcpServers exists in SDK source, not in stale dist
    () => new Set(Object.keys(agent?.mcpServers ?? {})),
  );
  const [hooks, setHooks] = useState(
    // @ts-expect-error hooks exists in SDK source, not in stale dist
    agent?.hooks ? JSON.stringify(agent.hooks, null, 2) : '',
  );
  const [generationOpen, setGenerationOpen] = useState(false);
  const [generationPrompt, setGenerationPrompt] = useState('');
  const [generatedDescription, setGeneratedDescription] = useState('');
  const [generatedSystemPrompt, setGeneratedSystemPrompt] = useState('');
  const [mcpTools, setMcpTools] = useState<
    Record<string, DaemonWorkspaceMcpToolStatus[]>
  >({});
  const [mcpToolsLoading, setMcpToolsLoading] = useState(false);
  const [mcpToolsError, setMcpToolsError] = useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [generatingFields, setGeneratingFields] = useState(
    () => new Set<GenerationField>(),
  );
  const [error, setError] = useState<string | null>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const generationRunRef = useRef<Record<GenerationField, number>>({
    description: 0,
    systemPrompt: 0,
  });
  const abortRef = useRef<Partial<Record<GenerationField, AbortController>>>(
    {},
  );

  const builtInTools = useMemo(
    () => selectBuiltInTools(toolsResource.tools, mcpTools),
    [mcpTools, toolsResource.tools],
  );
  const mcpServers = useMemo(
    () => mcpResource.status?.servers ?? [],
    [mcpResource.status?.servers],
  );
  const effectiveMcpServers = useMemo(() => {
    const values = settingsResource.settings.find(
      (setting) => setting.key === 'mcpServers',
    )?.values;
    const value = scope === 'global' ? values?.user : values?.effective;
    return isRecord(value) ? value : {};
  }, [scope, settingsResource.settings]);
  const selectableMcpServers = useMemo(
    () =>
      mcpServers.filter((server) => {
        if (isRecord(effectiveMcpServers[server.name])) return true;
        // @ts-expect-error mcpServers exists in SDK source, not in stale dist
        if (isRecord(agent?.mcpServers?.[server.name])) return true;
        return scope === 'workspace' && isRecord(server.config);
      }),
    // @ts-expect-error mcpServers exists in SDK source, not in stale dist
    [agent?.mcpServers, effectiveMcpServers, mcpServers, scope],
  );
  const activeMcpServerNames = useMemo(
    () => selectDiscoverableMcpServerNames(selectableMcpServers),
    [selectableMcpServers],
  );
  const activeMcpServerKey = activeMcpServerNames.join('\0');

  const canSave = Boolean(
    name.trim() && description.trim() && systemPrompt.trim(),
  );

  useEffect(
    () => () => {
      for (const controller of Object.values(abortRef.current)) {
        controller?.abort();
      }
    },
    [],
  );

  useEffect(() => {
    let active = true;
    const initializeCatalogs = async () => {
      setCatalogLoading(true);
      setCatalogError(null);
      try {
        const preheat = await preheatAcp(5_000);
        if (!preheat.ready)
          throw new Error(t('agent.create.tools.preheatFailed'));
        if (!active) return;
        const tools = await reloadTools();
        if (!tools) throw new Error(t('agent.create.tools.loadFailed'));
        if (tools.errors?.length) {
          throw new Error(
            tools.errors
              .map((item) => item.error || item.hint || item.kind)
              .join('\n'),
          );
        }

        const initialization = await initializeMcp();
        if (!initialization.accepted) await reloadMcpConfig();
        let discoveryFinished = false;
        for (
          let attempt = 0;
          attempt < MCP_DISCOVERY_MAX_ATTEMPTS;
          attempt += 1
        ) {
          await new Promise((resolve) =>
            window.setTimeout(resolve, MCP_DISCOVERY_POLL_MS),
          );
          if (!active) return;
          const status = await reloadMcp();
          if (!status) continue;
          if (status.errors?.length) {
            throw new Error(
              status.errors
                .map((item) => item.error || item.hint || item.kind)
                .join('\n'),
            );
          }
          if (
            status.discoveryState === 'completed' ||
            (status.initialized &&
              status.discoveryState === 'not_started' &&
              status.servers.length === 0)
          ) {
            discoveryFinished = true;
            break;
          }
        }
        if (!discoveryFinished) {
          throw new Error(t('mcp.discovery.timeout'));
        }
      } catch (nextError) {
        if (active) {
          setCatalogError(
            nextError instanceof Error ? nextError.message : String(nextError),
          );
        }
      } finally {
        if (active) setCatalogLoading(false);
      }
    };
    void initializeCatalogs();
    return () => {
      active = false;
    };
  }, [initializeMcp, preheatAcp, reloadMcp, reloadMcpConfig, reloadTools, t]);

  useEffect(() => {
    if (catalogLoading) return;
    if (!activeMcpServerKey) {
      setMcpTools({});
      return;
    }
    let active = true;
    setMcpToolsLoading(true);
    setMcpToolsError(null);
    Promise.all(
      activeMcpServerNames.map(async (serverName) => {
        const status = await loadMcpTools(serverName);
        return {
          serverName,
          tools: status.tools.filter((tool) => tool.isValid),
          error: status.errors?.length
            ? `${serverName}: ${status.errors
                .map((item) => item.error || item.hint || item.kind)
                .join(', ')}`
            : undefined,
        };
      }),
    )
      .then((entries) => {
        if (!active) return;
        setMcpTools(
          Object.fromEntries(
            entries.map(({ serverName, tools }) => [serverName, tools]),
          ),
        );
        const errors = entries.flatMap(({ error }) => (error ? [error] : []));
        setMcpToolsError(errors.length > 0 ? errors.join('\n') : null);
      })
      .catch((nextError: unknown) => {
        if (active) {
          setMcpToolsError(
            nextError instanceof Error ? nextError.message : String(nextError),
          );
        }
      })
      .finally(() => {
        if (active) setMcpToolsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [activeMcpServerKey, activeMcpServerNames, catalogLoading, loadMcpTools]);

  function setGenerationDialogOpen(open: boolean): void {
    if (!open) {
      for (const field of ['description', 'systemPrompt'] as const) {
        generationRunRef.current[field] += 1;
        abortRef.current[field]?.abort();
        delete abortRef.current[field];
      }
      setGeneratingFields(new Set());
    }
    setGenerationOpen(open);
  }

  function openGenerationDialog(): void {
    setGeneratedDescription(description);
    setGeneratedSystemPrompt(systemPrompt);
    setGenerationError(null);
    setGenerationOpen(true);
  }

  function cancelGeneration(field: GenerationField): void {
    generationRunRef.current[field] += 1;
    abortRef.current[field]?.abort();
    delete abortRef.current[field];
    setGeneratingFields((current) => {
      const next = new Set(current);
      next.delete(field);
      return next;
    });
  }

  async function handleGenerate(field: GenerationField) {
    const request = generationPrompt.trim();
    if (!request || abortRef.current[field]) return;
    const runId = generationRunRef.current[field] + 1;
    generationRunRef.current[field] = runId;
    const controller = new AbortController();
    abortRef.current[field] = controller;
    setGeneratingFields((current) => new Set(current).add(field));
    setGenerationError(null);
    const setGeneratedValue =
      field === 'description'
        ? setGeneratedDescription
        : setGeneratedSystemPrompt;
    setGeneratedValue('');
    try {
      const suffix =
        field === 'description'
          ? 'Return only a concise one-sentence subagent description explaining when this subagent should be used. Do not return JSON, Markdown, a label, or commentary.'
          : 'Return only the complete subagent system prompt. Do not return JSON, a Markdown code block, a name, a description, or commentary.';
      let generated = '';
      for await (const event of generateContent(`${request}\n\n${suffix}`, {
        signal: controller.signal,
      })) {
        if (generationRunRef.current[field] !== runId) return;
        if (event.type === 'delta') {
          generated += event.text;
          setGeneratedValue(generated);
        } else if (event.type === 'error') {
          throw new Error(event.message);
        }
      }
      if (generationRunRef.current[field] !== runId) return;
      setGeneratedValue(generated.trim());
    } catch (nextError) {
      if (
        generationRunRef.current[field] !== runId ||
        controller.signal.aborted
      )
        return;
      setGenerationError(
        t('agent.create.generateFailed', {
          error:
            nextError instanceof Error ? nextError.message : String(nextError),
        }),
      );
    } finally {
      if (generationRunRef.current[field] === runId) {
        setGeneratingFields((current) => {
          const next = new Set(current);
          next.delete(field);
          return next;
        });
        if (abortRef.current[field] === controller) {
          delete abortRef.current[field];
        }
      }
    }
  }

  function useGeneratedDraft(): void {
    setDescription(generatedDescription.trim());
    setSystemPrompt(generatedSystemPrompt.trim());
    setGenerationDialogOpen(false);
  }

  function mcpServerConfig(
    serverName: string,
  ): Record<string, unknown> | undefined {
    // @ts-expect-error mcpServers exists in SDK source, not in stale dist
    const existing = agent?.mcpServers?.[serverName];
    if (isRecord(existing)) return existing;
    const effective = effectiveMcpServers[serverName];
    if (isRecord(effective)) return effective;
    const statusConfig =
      scope === 'workspace'
        ? mcpServers.find((server) => server.name === serverName)?.config
        : undefined;
    return isRecord(statusConfig) ? statusConfig : undefined;
  }

  async function handleSave() {
    if (!canSave) {
      setError(t('agent.create.required'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const parsedMaxTurns = maxTurns.trim()
        ? Number(maxTurns.trim())
        : undefined;
      if (
        parsedMaxTurns !== undefined &&
        (!Number.isSafeInteger(parsedMaxTurns) || parsedMaxTurns <= 0)
      ) {
        throw new Error(t('agent.create.maxTurnsInvalid'));
      }
      const allowed = [...selectedTools];
      const denied = [...disallowedTools];
      const parsedHooks = parseRecord(hooks, 'hooks');
      const selectedServerConfigs = Object.fromEntries(
        [...selectedMcpServers].flatMap((serverName) => {
          const config = mcpServerConfig(serverName);
          return config ? [[serverName, config]] : [];
        }),
      );
      const fields = {
        description: description.trim(),
        systemPrompt: systemPrompt.trim(),
        tools: agent ? allowed : allowed.length > 0 ? allowed : undefined,
        disallowedTools: agent
          ? denied
          : denied.length > 0
            ? denied
            : undefined,
        mcpServers: agent
          ? selectedServerConfigs
          : Object.keys(selectedServerConfigs).length > 0
            ? selectedServerConfigs
            : undefined,
        hooks: agent ? (parsedHooks ?? {}) : parsedHooks,
      };
      const result = agent
        ? await updateAgent(
            agent.name,
            {
              ...fields,
              // @ts-expect-error null vs undefined mismatch with stale dist
              model: model.trim() || null,
              // @ts-expect-error null vs undefined mismatch with stale dist
              approvalMode: approvalMode === 'inherit' ? null : approvalMode,
              maxTurns: parsedMaxTurns ?? null,
              // @ts-expect-error null vs undefined mismatch with stale dist
              color: color === 'inherit' ? null : color,
            },
            scope,
          )
        : await createAgent({
            name: name.trim(),
            scope,
            ...fields,
            model: model.trim() || undefined,
            approvalMode: approvalMode === 'inherit' ? undefined : approvalMode,
            // @ts-expect-error maxTurns exists in SDK source, not in stale dist
            maxTurns: parsedMaxTurns,
            color: color === 'inherit' ? undefined : color,
          });
      onCreated(result.agent.name);
    } catch (nextError) {
      setError(formErrorMessage(nextError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex w-full max-w-5xl flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <h1 className="text-xl font-semibold text-balance">
          {agent ? t('agent.edit') : t('agent.create')}
        </h1>
        <Button type="button" variant="outline" onClick={openGenerationDialog}>
          <SparklesIcon data-icon="inline-start" />
          {t('agent.create.modelGenerate')}
        </Button>
      </div>

      {error ? (
        <ManagementNotice
          tone="error"
          noticeKey={error}
          closeLabel={t('common.close')}
          onDismiss={() => setError(null)}
        >
          {error}
        </ManagementNotice>
      ) : null}

      <Tabs defaultValue="overview">
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTrigger value="overview">
            {t('agent.detail.overview')}
          </TabsTrigger>
          <TabsTrigger value="prompt">
            {t('agent.detail.systemPrompt')}
          </TabsTrigger>
          <TabsTrigger value="tools">{t('agent.detail.tools')}</TabsTrigger>
          <TabsTrigger value="mcp">{t('agent.detail.mcp')}</TabsTrigger>
          <TabsTrigger value="hooks">{t('agent.detail.hooks')}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="pt-4">
          <FieldGroup className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="agent-scope">
                {t('agent.create.scope')}
              </FieldLabel>
              <Select
                value={scope}
                disabled={Boolean(agent)}
                onValueChange={(value) =>
                  setScope(value as 'workspace' | 'global')
                }
              >
                <SelectTrigger id="agent-scope" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="workspace">
                    {t('agent.create.project.cli')}
                  </SelectItem>
                  <SelectItem value="global">
                    {t('agent.create.user.cli')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <Field>
              <FieldLabel htmlFor="agent-name">
                {t('agent.create.name')}
              </FieldLabel>
              <Input
                id="agent-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('agent.create.namePlaceholder')}
                disabled={Boolean(agent)}
              />
              <FieldDescription>{t('agent.create.nameHelp')}</FieldDescription>
            </Field>

            <Field className="lg:col-span-2">
              <FieldLabel htmlFor="agent-description">
                {t('agent.create.description')}
              </FieldLabel>
              <Textarea
                id="agent-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t('agent.create.manualDescPlaceholder')}
                rows={3}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="agent-model">
                {t('agent.create.model')}
              </FieldLabel>
              <Input
                id="agent-model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="inherit / fast / provider:model"
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="agent-approval">
                {t('agent.create.approvalMode')}
              </FieldLabel>
              <Select value={approvalMode} onValueChange={setApprovalMode}>
                <SelectTrigger id="agent-approval" className="w-full">
                  <SelectValue>
                    {approvalModeLabel(approvalMode, t)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {selectableApprovalModes.map((value) => (
                    <SelectItem
                      key={value}
                      value={value}
                      disabled={value === 'bubble'}
                    >
                      {approvalModeLabel(value, t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                {approvalModeDescription(approvalMode, t)}
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="agent-max-turns">
                {t('agent.create.maxTurns')}
              </FieldLabel>
              <Input
                id="agent-max-turns"
                type="number"
                min="1"
                step="1"
                value={maxTurns}
                onChange={(event) => setMaxTurns(event.target.value)}
              />
              <FieldDescription>
                {t('agent.create.maxTurnsHelp')}
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="agent-color">
                {t('agent.create.color')}
              </FieldLabel>
              <Select value={color} onValueChange={setColor}>
                <SelectTrigger id="agent-color" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[
                    'inherit',
                    'auto',
                    'red',
                    'blue',
                    'green',
                    'yellow',
                    'purple',
                    'orange',
                    'pink',
                    'cyan',
                  ].map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
        </TabsContent>

        <TabsContent value="prompt" className="pt-4">
          <Field>
            <Textarea
              id="agent-prompt"
              aria-label={t('agent.create.prompt')}
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              placeholder={t('agent.create.promptPlaceholder.cli')}
              rows={16}
              className="min-h-80 max-h-[60vh] overflow-y-auto"
            />
            <FieldDescription>{t('agent.create.promptHelp')}</FieldDescription>
          </Field>
        </TabsContent>

        <TabsContent value="tools" className="pt-4">
          <FieldGroup>
            <Field>
              <FieldLabel>{t('agent.create.tools')}</FieldLabel>
              <FieldDescription>
                {t('agent.create.toolsSelectHelp')}
              </FieldDescription>
              <ToolPicker
                idPrefix="agent-allowed-tool"
                selection={selectedTools}
                onSelectionChange={setSelectedTools}
                builtInTools={builtInTools}
                mcpServers={selectableMcpServers}
                mcpTools={mcpTools}
                t={t}
              />
              {catalogLoading || mcpToolsLoading ? (
                <LoadingRow label={t('agent.create.tools.initializing')} />
              ) : null}
              {catalogError || mcpToolsError ? (
                <div className="whitespace-pre-wrap text-sm text-destructive">
                  {catalogError || mcpToolsError}
                </div>
              ) : null}
            </Field>

            <Field>
              <FieldLabel>{t('agent.create.disallowedTools')}</FieldLabel>
              <ToolPicker
                idPrefix="agent-disallowed-tool"
                selection={disallowedTools}
                onSelectionChange={setDisallowedTools}
                builtInTools={builtInTools}
                mcpServers={selectableMcpServers}
                mcpTools={mcpTools}
                t={t}
              />
            </Field>
          </FieldGroup>
        </TabsContent>

        <TabsContent value="mcp" className="pt-4">
          <Field>
            <FieldLabel>{t('agent.create.mcpServers')}</FieldLabel>
            <McpServerPicker
              selection={selectedMcpServers}
              onSelectionChange={setSelectedMcpServers}
              servers={selectableMcpServers}
              t={t}
            />
            {settingsResource.loading ? (
              <LoadingRow label={t('common.loading')} />
            ) : settingsResource.error ? (
              <ErrorRow error={settingsResource.error} />
            ) : null}
          </Field>
        </TabsContent>

        <TabsContent value="hooks" className="pt-4">
          <Field>
            <FieldLabel htmlFor="agent-hooks">Hooks</FieldLabel>
            <Textarea
              id="agent-hooks"
              value={hooks}
              onChange={(event) => setHooks(event.target.value)}
              placeholder={'{"PreToolUse":[...] }'}
              rows={10}
              className="min-h-64 max-h-[60vh] overflow-y-auto font-mono text-xs"
            />
            <FieldDescription>
              {t('agent.create.jsonObjectHelp')}
            </FieldDescription>
          </Field>
        </TabsContent>
      </Tabs>

      <div className="flex justify-end gap-2 border-t pt-4">
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          {t('common.cancel')}
        </Button>
        <Button onClick={() => void handleSave()} disabled={!canSave || busy}>
          {busy ? <Spinner data-icon="inline-start" /> : null}
          {agent ? t('agent.edit.save') : t('agent.create.save')}
        </Button>
      </div>

      <Dialog open={generationOpen} onOpenChange={setGenerationDialogOpen}>
        <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('agent.create.modelGenerate')}</DialogTitle>
            <DialogDescription>
              {t('agent.create.modelGenerate.description')}
            </DialogDescription>
          </DialogHeader>
          {generationError ? (
            <ManagementNotice
              tone="error"
              noticeKey={generationError}
              closeLabel={t('common.close')}
              onDismiss={() => setGenerationError(null)}
            >
              {generationError}
            </ManagementNotice>
          ) : null}
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="agent-generation-requirements">
                {t('agent.create.describeAgent')}
              </FieldLabel>
              <Textarea
                id="agent-generation-requirements"
                value={generationPrompt}
                onChange={(event) => setGenerationPrompt(event.target.value)}
                placeholder={t('agent.create.qwenPlaceholder')}
                rows={4}
              />
              <FieldDescription>{t('agent.create.qwenHint')}</FieldDescription>
            </Field>
            <Field>
              <GenerationFieldLabel
                htmlFor="agent-generated-description"
                label={t('agent.create.generatedDescription')}
                active={generatingFields.has('description')}
                disabled={!generationPrompt.trim()}
                onGenerate={() => void handleGenerate('description')}
                onCancel={() => cancelGeneration('description')}
                t={t}
              />
              <Textarea
                id="agent-generated-description"
                value={generatedDescription}
                onChange={(event) =>
                  setGeneratedDescription(event.target.value)
                }
                rows={3}
                readOnly={generatingFields.has('description')}
              />
            </Field>
            <Field>
              <GenerationFieldLabel
                htmlFor="agent-generated-prompt"
                label={t('agent.create.generatedSystemPrompt')}
                active={generatingFields.has('systemPrompt')}
                disabled={!generationPrompt.trim()}
                onGenerate={() => void handleGenerate('systemPrompt')}
                onCancel={() => cancelGeneration('systemPrompt')}
                t={t}
              />
              <Textarea
                id="agent-generated-prompt"
                value={generatedSystemPrompt}
                onChange={(event) =>
                  setGeneratedSystemPrompt(event.target.value)
                }
                rows={10}
                readOnly={generatingFields.has('systemPrompt')}
                className="min-h-64 max-h-64 overflow-y-auto"
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setGenerationDialogOpen(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              onClick={useGeneratedDraft}
              disabled={
                generatingFields.size > 0 ||
                !generatedDescription.trim() ||
                !generatedSystemPrompt.trim()
              }
            >
              {t('agent.create.useGenerated')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function GenerationFieldLabel({
  htmlFor,
  label,
  active,
  disabled,
  onGenerate,
  onCancel,
  t,
}: {
  htmlFor: string;
  label: string;
  active: boolean;
  disabled: boolean;
  onGenerate: () => void;
  onCancel: () => void;
  t: Translate;
}) {
  return (
    <div className="flex items-center gap-2">
      <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>
      {active ? (
        <>
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Spinner className="size-3" />
            {t('agent.create.generatingPrompt')}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={onCancel}
          >
            {t('common.cancel')}
          </Button>
        </>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto"
          disabled={disabled}
          onClick={onGenerate}
        >
          <SparklesIcon data-icon="inline-start" />
          {t('agent.create.generate')}
        </Button>
      )}
    </div>
  );
}

function ToolPicker({
  idPrefix,
  selection,
  onSelectionChange,
  builtInTools,
  mcpServers,
  mcpTools,
  t,
}: {
  idPrefix: string;
  selection: Set<string>;
  onSelectionChange: (selection: Set<string>) => void;
  builtInTools: Array<{
    name: string;
    displayName?: string;
    description?: string;
  }>;
  mcpServers: Array<{
    name: string;
    disabled: boolean;
    mcpStatus?: 'connected' | 'connecting' | 'disconnected';
  }>;
  mcpTools: Record<string, DaemonWorkspaceMcpToolStatus[]>;
  t: Translate;
}) {
  const [kind, setKind] = useState<'builtin' | 'mcp'>('builtin');
  const [serverName, setServerName] = useState('');
  const availableMcpServers = mcpServers.filter((server) => !server.disabled);
  const availableTools =
    kind === 'builtin' ? builtInTools : (mcpTools[serverName] ?? []);

  const selectedLabels = new Map<string, string>();
  for (const tool of builtInTools) {
    selectedLabels.set(tool.name, tool.displayName || tool.name);
  }
  for (const [currentServer, tools] of Object.entries(mcpTools)) {
    for (const tool of tools) {
      selectedLabels.set(
        tool.name,
        `${currentServer} / ${tool.serverToolName || tool.name}`,
      );
    }
  }

  return (
    <div className="grid gap-3 rounded-lg border p-4">
      <div
        className={`grid gap-3 ${
          kind === 'mcp'
            ? 'sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]'
            : 'sm:grid-cols-[minmax(0,1fr)]'
        }`}
      >
        <Select
          value={kind}
          onValueChange={(value) => {
            setKind(value as 'builtin' | 'mcp');
            setServerName('');
          }}
        >
          <SelectTrigger
            id={`${idPrefix}-kind`}
            className="w-full"
            aria-label={t('agent.create.tools.type')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="builtin">
              {t('agent.create.tools.builtin')}
            </SelectItem>
            <SelectItem value="mcp">{t('agent.create.tools.mcp')}</SelectItem>
          </SelectContent>
        </Select>

        {kind === 'mcp' ? (
          <Select value={serverName || undefined} onValueChange={setServerName}>
            <SelectTrigger
              id={`${idPrefix}-server`}
              className="w-full"
              aria-label={t('agent.create.tools.selectServer')}
            >
              <SelectValue placeholder={t('agent.create.tools.selectServer')} />
            </SelectTrigger>
            <SelectContent>
              {availableMcpServers.map((server) => (
                <SelectItem
                  key={server.name}
                  value={server.name}
                  disabled={
                    server.mcpStatus !== 'connected' &&
                    (mcpTools[server.name]?.length ?? 0) === 0
                  }
                >
                  {server.name}
                  {server.mcpStatus
                    ? ` · ${t(`mcp.status.${server.mcpStatus}`)}`
                    : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>

      <div className="max-h-64 overflow-y-auto rounded-md border">
        {availableTools.length > 0 ? (
          <TooltipProvider delayDuration={300}>
            <div className="divide-y">
              {availableTools.map((tool) => {
                const displayName =
                  kind === 'builtin'
                    ? (tool as { displayName?: string }).displayName ||
                      tool.name
                    : (tool as DaemonWorkspaceMcpToolStatus).serverToolName ||
                      tool.name;
                return (
                  <label
                    key={tool.name}
                    className="flex cursor-pointer items-start gap-3 px-3 py-2.5 hover:bg-accent/30"
                  >
                    <Checkbox
                      id={`${idPrefix}-${tool.name}`}
                      checked={selection.has(tool.name)}
                      onCheckedChange={(checked) =>
                        onSelectionChange(
                          toggleSelection(
                            selection,
                            tool.name,
                            checked === true,
                          ),
                        )
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {displayName}
                      </span>
                      {tool.description ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                              {tool.description}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-sm whitespace-normal">
                            {tool.description}
                          </TooltipContent>
                        </Tooltip>
                      ) : null}
                    </span>
                  </label>
                );
              })}
            </div>
          </TooltipProvider>
        ) : (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            {t('agent.create.tools.empty')}
          </div>
        )}
      </div>

      {selection.size > 0 ? (
        <div className="flex flex-wrap gap-2">
          {[...selection].map((name) => (
            <span
              key={name}
              className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted px-2 py-1 text-sm"
              title={name}
            >
              <span className="truncate">
                {selectedLabels.get(name) || name}
              </span>
              <button
                type="button"
                className="rounded-sm text-muted-foreground hover:text-foreground"
                aria-label={t('agent.create.removeSelection', { name })}
                onClick={() =>
                  onSelectionChange(toggleSelection(selection, name, false))
                }
              >
                <XIcon className="size-3.5" />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <div className="text-sm text-muted-foreground">
          {t('agent.create.tools.noneSelected')}
        </div>
      )}
    </div>
  );
}

function McpServerPicker({
  selection,
  onSelectionChange,
  servers,
  t,
}: {
  selection: Set<string>;
  onSelectionChange: (selection: Set<string>) => void;
  servers: Array<{
    name: string;
    mcpStatus?: 'connected' | 'connecting' | 'disconnected';
  }>;
  t: Translate;
}) {
  return (
    <div className="max-h-64 overflow-y-auto rounded-lg border">
      {servers.length > 0 ? (
        <div className="divide-y">
          {servers.map((server) => (
            <label
              key={server.name}
              className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-accent/30"
            >
              <Checkbox
                id={`agent-mcp-server-${server.name}`}
                checked={selection.has(server.name)}
                onCheckedChange={(checked) =>
                  onSelectionChange(
                    toggleSelection(selection, server.name, checked === true),
                  )
                }
              />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {server.name}
              </span>
              {server.mcpStatus ? (
                <Badge
                  variant="secondary"
                  className={
                    server.mcpStatus === 'connected'
                      ? 'bg-[var(--success-bg)] text-[var(--success-color)]'
                      : undefined
                  }
                >
                  {t(`mcp.status.${server.mcpStatus}`)}
                </Badge>
              ) : null}
            </label>
          ))}
        </div>
      ) : (
        <div className="px-3 py-6 text-center text-sm text-muted-foreground">
          {t('agent.create.mcpServers.empty')}
        </div>
      )}
    </div>
  );
}

function approvalModeLabel(value: string, t: Translate): string {
  if (value === 'inherit' || value === 'bubble') {
    return t(`agent.approval.${value}`);
  }
  return t(`mode.listLabel.${value}`);
}

function approvalModeDescription(value: string, t: Translate): string {
  if (value === 'inherit' || value === 'bubble') {
    return t(`agent.approval.desc.${value}`);
  }
  return t(`mode.desc.${value}`);
}

function LoadingRow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Spinner />
      {label}
    </div>
  );
}

function ErrorRow({ error }: { error: Error | undefined }) {
  return <div className="text-sm text-destructive">{error?.message}</div>;
}
