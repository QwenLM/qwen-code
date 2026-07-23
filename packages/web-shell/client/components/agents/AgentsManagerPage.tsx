import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeftIcon,
  BotIcon,
  EllipsisVerticalIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
} from 'lucide-react';
import {
  DAEMON_APPROVAL_MODES,
  useAgents,
  type DaemonWorkspaceAgentDetail,
} from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../../i18n';
import {
  canModifyAgent,
  filterAgents,
  isOverridden,
  preserveAgentSelection,
  scopeForLevel,
  type AgentSelection,
  type AgentLevelFilter,
} from './agents-manager-logic';
import { AgentCreatePage } from './AgentCreatePage';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import { Badge } from '../ui/badge';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '../ui/breadcrumb';
import { Button } from '../ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '../ui/empty';
import { Input } from '../ui/input';
import { ManagementNotice } from '../ui/management-notice';
import { Spinner } from '../ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../ui/tooltip';
import type { EmbeddedManagerPage } from '../plugins/manager-page';
import styles from './AgentsManagerPage.module.css';

interface AgentsManagerPageProps {
  onClose: () => void;
  embedded?: EmbeddedManagerPage;
  initialCreateScope?: 'workspace' | 'global' | null;
}

function levelLabel(level: string, t: ReturnType<typeof useI18n>['t']): string {
  if (level === 'project') return t('agent.level.project');
  if (level === 'user') return t('agent.level.user');
  if (level === 'builtin') return t('agent.level.builtin');
  if (level === 'extension') return t('agent.level.extension');
  return level;
}

function approvalModeLabel(
  mode: string | undefined,
  t: ReturnType<typeof useI18n>['t'],
): string {
  if (!mode) return '—';
  if (mode === 'inherit' || mode === 'bubble') {
    return t(`agent.approval.${mode}`);
  }
  if (DAEMON_APPROVAL_MODES.some((value) => value === mode)) {
    return t(`mode.listLabel.${mode}`);
  }
  return mode;
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="text-sm font-medium">{label}</div>
      <div className="break-words text-sm text-muted-foreground">{value}</div>
    </div>
  );
}

function jsonText(value: Record<string, unknown> | undefined): string {
  return value ? JSON.stringify(value, null, 2) : '—';
}

function unwrapPlainText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(
      /(?<!\n)\n(?!\n|[ \t]*(?:#{1,6}\s|[-*+]\s|\d+\.\s|```|>\s|\*\*[^*\n]+\*\*:))/g,
      ' ',
    );
}

export function AgentsManagerPage({
  onClose,
  embedded,
  initialCreateScope,
}: AgentsManagerPageProps) {
  const { t } = useI18n();
  const {
    agents,
    loading,
    error: agentsError,
    reload,
    getAgent,
    deleteAgent,
  } = useAgents({ autoLoad: true });

  const [query, setQuery] = useState('');
  const [levelFilter, setLevelFilter] = useState<AgentLevelFilter>('all');
  const [selection, setSelection] = useState<AgentSelection | null>(null);
  const [detail, setDetail] = useState<DaemonWorkspaceAgentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(() =>
    Boolean(initialCreateScope),
  );
  const [editOpen, setEditOpen] = useState(false);
  const [listNotice, setListNotice] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [listErrorDismissed, setListErrorDismissed] = useState(false);

  const filteredAgents = useMemo(
    () => filterAgents(agents, query, levelFilter),
    [agents, query, levelFilter],
  );

  const selectedAgent = useMemo(
    () => preserveAgentSelection(selection, agents),
    [agents, selection],
  );
  const selectedName = selection?.name ?? null;

  useEffect(() => {
    setSelection((current) => preserveAgentSelection(current, agents));
  }, [agents]);

  useEffect(() => {
    embedded?.onDetailChange(Boolean(selectedName || createOpen || editOpen));
  }, [createOpen, editOpen, embedded, selectedName]);

  useEffect(() => {
    if (!selection) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    let active = true;
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    getAgent(selection.name, scopeForLevel(selection.level))
      .then((nextDetail) => {
        if (active) setDetail(nextDetail);
      })
      .catch((e: unknown) => {
        if (active) setDetailError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selection, getAgent]);

  useEffect(() => {
    setListErrorDismissed(false);
  }, [agentsError]);

  useEffect(() => {
    if (initialCreateScope) setCreateOpen(true);
  }, [initialCreateScope]);

  function returnToList(): void {
    setCreateOpen(false);
    setEditOpen(false);
    setSelection(null);
    setDetail(null);
    setMutationError(null);
    void reload();
  }

  async function handleDelete(): Promise<void> {
    if (!detail || !selectedAgent) return;
    const scope = scopeForLevel(selectedAgent.level);
    if (!scope) return;
    setBusy(true);
    try {
      await deleteAgent(selectedAgent.name, scope);
      setDeleteOpen(false);
      setSelection(null);
      setDetail(null);
      setListNotice(t('agent.deleted', { name: detail.name }));
      await reload();
    } catch (e) {
      setDeleteOpen(false);
      setMutationError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const levelOptions: Array<{ value: AgentLevelFilter; label: string }> = [
    { value: 'all', label: t('skills.filter.all') },
    { value: 'project', label: t('agent.level.project') },
    { value: 'user', label: t('agent.level.user') },
    { value: 'builtin', label: t('agent.level.builtin') },
    { value: 'extension', label: t('agent.level.extension') },
  ];
  const subpageTitle = editOpen
    ? t('agent.edit')
    : (selectedName ?? (createOpen ? t('agent.create.button') : null));

  const standaloneNavigation = (
    <Breadcrumb className="sticky -top-4 z-10 -mx-5 -mt-4 border-b bg-background px-5 py-3">
      <BreadcrumbList className="text-base">
        <BreadcrumbItem>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label={t('common.back')}
          >
            <ArrowLeftIcon />
          </Button>
        </BreadcrumbItem>
        <BreadcrumbItem>
          {subpageTitle ? (
            <BreadcrumbLink asChild>
              <button type="button" onClick={returnToList}>
                {t('agents.title')}
              </button>
            </BreadcrumbLink>
          ) : (
            <BreadcrumbPage>{t('agents.title')}</BreadcrumbPage>
          )}
        </BreadcrumbItem>
        {subpageTitle ? <BreadcrumbSeparator /> : null}
        {subpageTitle ? (
          <BreadcrumbItem>
            <BreadcrumbPage>{subpageTitle}</BreadcrumbPage>
          </BreadcrumbItem>
        ) : null}
      </BreadcrumbList>
    </Breadcrumb>
  );

  const navigation = embedded ? (
    subpageTitle ? (
      <Breadcrumb className="sticky -top-4 z-10 -mx-5 -mt-4 border-b bg-background px-5 py-3">
        <BreadcrumbList className="h-8 text-sm">
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <button
                type="button"
                onClick={() => {
                  returnToList();
                  embedded.onDetailChange(false);
                }}
              >
                {t('agents.title')}
              </button>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{subpageTitle}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    ) : null
  ) : (
    standaloneNavigation
  );

  // ── Create view ──
  if (createOpen) {
    return (
      <div className="flex w-full flex-col gap-6 pb-8">
        {navigation}
        <AgentCreatePage
          initialScope={initialCreateScope ?? 'global'}
          onCancel={returnToList}
          onCreated={(name) => {
            setCreateOpen(false);
            setListNotice(t('agent.created', { name }));
            void reload();
          }}
        />
      </div>
    );
  }

  if (editOpen && detail) {
    return (
      <div className="flex w-full flex-col gap-6 pb-8">
        {navigation}
        <AgentCreatePage
          agent={detail}
          onCancel={() => setEditOpen(false)}
          onCreated={(name) => {
            setEditOpen(false);
            setSelection(null);
            setDetail(null);
            setListNotice(t('agent.updated', { name }));
            void reload();
          }}
        />
      </div>
    );
  }

  // ── Detail view ──
  if (selectedName && detail) {
    const mutable = canModifyAgent(detail);
    const toolsText =
      !detail.tools || detail.tools.length === 0 || detail.tools.includes('*')
        ? t('agent.create.tools.all')
        : detail.tools.join(', ');
    const disallowedToolsText = detail.disallowedTools?.join(', ') || '—';

    return (
      <div className="flex w-full flex-col gap-6 pb-8">
        {navigation}
        <div className="flex w-full flex-col gap-6">
          <div className="flex items-center gap-4">
            <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-muted">
              <BotIcon />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="break-words text-xl font-semibold text-balance">
                  {detail.name}
                </h1>
                <Badge variant="outline">{levelLabel(detail.level, t)}</Badge>
                {isOverridden(detail, agents) ? (
                  <Badge variant="secondary">
                    {t('agent.overriddenBadge')}
                  </Badge>
                ) : null}
              </div>
            </div>
            {mutable ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={busy}
                    aria-label={t('agent.chooseAction', {
                      name: detail.name,
                    })}
                  >
                    {busy ? <Spinner /> : <EllipsisVerticalIcon />}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  onCloseAutoFocus={(event) => event.preventDefault()}
                >
                  <DropdownMenuGroup>
                    <DropdownMenuItem onSelect={() => setEditOpen(true)}>
                      <PencilIcon data-icon="inline-start" />
                      {t('agent.edit')}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={busy}
                      onSelect={() => setDeleteOpen(true)}
                    >
                      <Trash2Icon data-icon="inline-start" />
                      {t('agent.delete')}
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>

          {mutationError ? (
            <ManagementNotice
              tone="error"
              noticeKey={mutationError}
              closeLabel={t('common.close')}
              onDismiss={() => setMutationError(null)}
            >
              {mutationError}
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
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">
                    {t('agent.descriptionLabel')}
                  </CardTitle>
                  <CardDescription>{detail.description || '—'}</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-6 sm:grid-cols-2">
                  <DetailField
                    label={t('agent.filePathLabel')}
                    value={detail.filePath || '—'}
                  />
                  <DetailField
                    label={t('agent.modelLabel')}
                    value={detail.model || '—'}
                  />
                  <DetailField
                    label={t('agent.level.label')}
                    value={levelLabel(detail.level, t)}
                  />
                  <DetailField
                    label={t('agent.create.approvalMode')}
                    value={approvalModeLabel(
                      detail.approvalMode || detail.permissionMode,
                      t,
                    )}
                  />
                  <DetailField
                    label={t('agent.create.maxTurns')}
                    value={detail.maxTurns?.toString() || '—'}
                  />
                  <DetailField
                    label={t('agent.create.color')}
                    value={detail.color || '—'}
                  />
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="prompt" className="pt-4">
              <Card>
                <CardContent>
                  <div className="max-h-[60vh] w-full overflow-auto break-words whitespace-pre-line text-sm leading-6 text-muted-foreground">
                    {detail.systemPrompt
                      ? unwrapPlainText(detail.systemPrompt)
                      : '—'}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="tools" className="pt-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">
                    {t('agent.toolsLabel')}
                  </CardTitle>
                  <CardDescription>{toolsText}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-6">
                  <DetailField
                    label={t('agent.create.disallowedTools')}
                    value={disallowedToolsText}
                  />
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="mcp" className="pt-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">
                    {t('agent.create.mcpServers')}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
                    {jsonText(detail.mcpServers)}
                  </pre>
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="hooks" className="pt-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">
                    {t('agent.detail.hooks')}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
                    {jsonText(detail.hooks)}
                  </pre>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>

          <AlertDialog
            open={deleteOpen}
            onOpenChange={(open) => {
              if (!open && busy) return;
              setDeleteOpen(open);
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t('agent.delete.title', { name: detail.name })}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t('agent.delete.confirm', { name: detail.name })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={busy}>
                  {t('common.cancel')}
                </AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  disabled={busy}
                  onClick={(event) => {
                    event.preventDefault();
                    void handleDelete();
                  }}
                >
                  {busy ? <Spinner data-icon="inline-start" /> : null}
                  {t('agent.delete.yes')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    );
  }

  // ── Detail loading ──
  if (selectedName && detailLoading) {
    return (
      <div className="flex w-full flex-col gap-6 pb-8">
        {navigation}
        <div className="flex items-center justify-center py-12">
          <Spinner className="size-6" />
        </div>
      </div>
    );
  }

  if (selectedName && detailError) {
    return (
      <div className="flex w-full flex-col gap-6 pb-8">
        {navigation}
        <ManagementNotice
          tone="error"
          noticeKey={detailError}
          closeLabel={t('common.close')}
          onDismiss={returnToList}
        >
          {detailError}
        </ManagementNotice>
      </div>
    );
  }

  // ── List view ──
  return (
    <div className="flex w-full flex-col gap-6 pb-8">
      {navigation}
      <div className="flex w-full flex-col gap-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-balance">
              {t('agents.title')}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground tabular-nums">
              {t('agent.count', { count: agents.length })}
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={loading}
              onClick={() => void reload()}
            >
              {loading ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <RefreshCwIcon data-icon="inline-start" />
              )}
              {t('common.refresh')}
            </Button>
            <Button onClick={() => setCreateOpen(true)}>
              <PlusIcon data-icon="inline-start" />
              {t('agent.create.button')}
            </Button>
          </div>
        </div>

        {agentsError && !listErrorDismissed ? (
          <ManagementNotice
            tone="error"
            noticeKey={agentsError.message}
            closeLabel={t('common.close')}
            onDismiss={() => setListErrorDismissed(true)}
          >
            {agentsError.message}
          </ManagementNotice>
        ) : null}

        {listNotice ? (
          <ManagementNotice
            tone="success"
            noticeKey={listNotice}
            closeLabel={t('common.close')}
            onDismiss={() => setListNotice(null)}
          >
            {listNotice}
          </ManagementNotice>
        ) : null}

        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            name="agent-search"
            aria-label={t('common.search')}
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('common.search')}
            className="pl-9"
          />
        </div>

        <ToggleGroup
          type="single"
          value={levelFilter}
          onValueChange={(value) => {
            if (value) setLevelFilter(value as AgentLevelFilter);
          }}
          variant="outline"
          size="sm"
          aria-label={t('agent.level.project')}
        >
          {levelOptions.map((option) => (
            <ToggleGroupItem key={option.value} value={option.value}>
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        {filteredAgents.length ? (
          <div
            className={styles.agentGrid}
            data-column-count={Math.min(filteredAgents.length, 4)}
          >
            {filteredAgents.map((agent) => (
              <Card
                key={`${agent.level}:${agent.name}`}
                size="sm"
                role="button"
                tabIndex={0}
                aria-label={agent.name}
                className="cursor-pointer transition-colors hover:bg-accent/30 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                onClick={() => {
                  setListNotice(null);
                  setMutationError(null);
                  setSelection({ name: agent.name, level: agent.level });
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setListNotice(null);
                    setMutationError(null);
                    setSelection({ name: agent.name, level: agent.level });
                  }
                }}
              >
                <CardHeader className="block">
                  <div className="flex items-start gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <BotIcon className="size-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-start justify-between gap-2">
                        <CardTitle className="min-w-0 flex-1 truncate">
                          {agent.name}
                        </CardTitle>
                        <div className="flex shrink-0 gap-1">
                          <Badge variant="outline" className="text-[10px]">
                            {levelLabel(agent.level, t)}
                          </Badge>
                          {isOverridden(agent, agents) ? (
                            <Badge variant="secondary" className="text-[10px]">
                              {t('agent.overriddenBadge')}
                            </Badge>
                          ) : null}
                        </div>
                      </div>
                      <CardDescription className="mt-1 min-w-0 text-xs">
                        <TooltipProvider delayDuration={300}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="block truncate">
                                {agent.description || '—'}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              {agent.description || '—'}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
              </Card>
            ))}
          </div>
        ) : (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                {query || levelFilter !== 'all' ? <SearchIcon /> : <BotIcon />}
              </EmptyMedia>
              <EmptyTitle>
                {query || levelFilter !== 'all'
                  ? t('agent.noMatches')
                  : t('agent.empty')}
              </EmptyTitle>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </div>
  );
}
