import {
  memo,
  useEffect,
  useCallback,
  useMemo,
  useState,
  type CSSProperties,
} from 'react';
import {
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleSlashIcon,
  CircleXIcon,
  Clock3Icon,
  RefreshCwIcon,
} from 'lucide-react';
import {
  useConnection,
  usePromptStatus,
  useTurnNavigationState,
  useTranscriptBlocks,
  useWorkspace,
} from '@qwen-code/web-shell/daemon-react-sdk';
import type {
  DaemonToolTranscriptBlock,
  DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import { isShellResultDisplay } from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import { useSharedNow } from '../../hooks/useSharedNow';
import { WEB_SHELL_TURN_INDEX_PAGE_SIZE } from '../../constants/sessions';
import type { ACPToolCall } from '../../adapters/types';
import { daemonToolBlockToToolCall } from '../../adapters/transcriptToMessages';
import {
  isSubAgentToolCall,
  resolveToolCallName,
} from '../../adapters/toolClassification';
import {
  localizeToolDisplayName,
  getToolSummaryDescription,
  getSubagentDetailsUnavailableReason,
  extractText,
  isShellToolName,
  isActiveToolStatus,
  sanitizeControlChars,
  truncateText,
} from '../messages/toolFormatting';
import { formatDurationMs } from '../messages/tools/toolDisplay';
import { ToolFilePreviewButton } from '../messages/ToolFilePreviewButton';
import {
  extractDiff,
  fencedCodeBlock,
  ToolSummaryIcon,
} from '../messages/ToolGroup';
import { Markdown } from '../messages/Markdown';
import { DiffView } from '../messages/tools/DiffView';
import { parseShellLiveOutput } from '../messages/tools/shellLiveOutput';
import type { TurnOutputOpenRequest } from './TurnOutputs';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Spinner } from '../ui/spinner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../ui/tooltip';
import { formatTimestamp } from '../MessageTimestamp';
import { loadTurnCalls, toolCallDepths } from './loadTurnCalls';
import { isTurnCallsPrompt, type OpenTurnCalls } from '../../turnCallsContext';
import styles from './TurnCallsPanel.module.css';
import { TurnCallPromptSelect } from './TurnCallPromptSelect';

/**
 * Strong ceiling for a single expanded field. Tool arguments and results can be
 * arbitrarily large; the panel keeps them readable instead of letting a
 * multi-megabyte payload reach the DOM.
 */
const MAX_DETAIL_LENGTH = 4000;

export interface TurnCallRow {
  block: DaemonToolTranscriptBlock;
  /** 0 for a top-level call, 1 for a call made by a sub-agent, and so on. */
  depth: number;
  durationMs?: number;
  startedAt?: number;
  recordedStatus?: string;
  live?: true;
}

function isPromptStart(block: DaemonTranscriptBlock): boolean {
  return (
    block.kind === 'user' &&
    isTurnCallsPrompt(block.meta?.['source'], block.text)
  );
}

function isTerminalStatus(status: string): boolean {
  switch (status) {
    case 'completed':
    case 'success':
    case 'failed':
    case 'error':
    case 'cancelled':
    case 'canceled':
      return true;
    default:
      return false;
  }
}

/**
 * The tool calls one turn made, in execution order, each with its nesting depth.
 *
 * `turnId` is the id of the turn's leading user message, which is also the id of
 * that user's transcript block — the same turn identity the transcript's own
 * per-turn grouping uses. A turn's calls are therefore the tool blocks between
 * that block and the next user block. That keeps the panel working for a turn
 * which is still running, and it does not depend on a per-turn stamp landing on
 * tool blocks.
 *
 * A call whose parent is not part of the turn is treated as top-level rather
 * than guessed into a parent.
 */
export function collectTurnCallRows(
  blocks: readonly DaemonTranscriptBlock[],
  turnId: string | undefined,
  promptId?: string,
): TurnCallRow[] {
  const startIndex = blocks.findIndex((block) => block.id === turnId);
  if (startIndex < 0 && !promptId) return [];
  const span: DaemonToolTranscriptBlock[] = [];
  for (let index = startIndex + 1; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!block) break;
    if (startIndex >= 0 && isPromptStart(block)) break;
    if (block.kind !== 'tool') continue;
    if (startIndex < 0 && block.promptId !== promptId) continue;
    // A background task's calls belong to that task, not to this turn.
    if (block.backgroundTurn) continue;
    span.push(block);
  }
  if (span.length === 0) return [];
  const depths = toolCallDepths(span);

  return span.map((block) => ({
    block,
    depth: depths.get(block.toolCallId) ?? 0,
    startedAt: block.startedAt,
    durationMs: block.durationMs,
    live: true,
  }));
}

function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'string' ? value : safeJson(value);
  return text.trim();
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return '';
  }
}

function ToolCallDetail({ text }: { text: string }) {
  const json = useMemo(() => {
    try {
      JSON.parse(text);
      return text;
    } catch {
      return undefined;
    }
  }, [text]);
  const displayed = truncateText(json ?? text, MAX_DETAIL_LENGTH);
  return json !== undefined ? (
    <div className="max-h-60 overflow-auto">
      <Markdown content={fencedCodeBlock('json', displayed)} />
    </div>
  ) : (
    <pre className={styles.detailBody}>{displayed}</pre>
  );
}

function shellDetails(tool: ACPToolCall) {
  const raw = tool.rawOutput;
  const result = isShellResultDisplay(raw) ? raw : undefined;
  const live = parseShellLiveOutput(raw);
  const command =
    typeof tool.args?.command === 'string' ? tool.args.command : '';
  const unknownVersion =
    raw &&
    typeof raw === 'object' &&
    'type' in raw &&
    raw.type === 'shell_result' &&
    !result;
  const output =
    result?.output ??
    (live
      ? (live.segments?.map((segment) => segment.text).join('') ?? '')
      : typeof raw === 'string'
        ? raw
        : unknownVersion
          ? 'text' in raw && typeof raw.text === 'string'
            ? raw.text
            : stringifyValue(raw)
          : (extractText(tool) ?? stringifyValue(raw)));
  const args = Object.fromEntries(
    Object.entries(tool.args ?? {}).filter(([key]) => key !== 'command'),
  );
  const metadata = result
    ? Object.fromEntries(
        Object.entries(result).filter(
          ([key]) => !['type', 'version', 'text', 'output'].includes(key),
        ),
      )
    : live
      ? Object.fromEntries(
          Object.entries(live).filter(
            ([key, value]) => key !== 'segments' && value !== undefined,
          ),
        )
      : undefined;
  const other = {
    ...(Object.keys(args).length ? { arguments: args } : {}),
    ...(metadata && Object.keys(metadata).length ? { result: metadata } : {}),
  };
  return {
    command: sanitizeControlChars(command),
    output: sanitizeControlChars(output),
    other: Object.keys(other).length
      ? truncateText(stringifyValue(other), MAX_DETAIL_LENGTH)
      : '',
  };
}

export function TurnCallsPanel({
  turnId,
  ownerSessionId,
  recordId,
  promptId,
  promptLabel,
  onSelectPrompt,
  workspaceCwd,
  onOpenFile,
  onOpenAgent,
}: {
  turnId: string;
  ownerSessionId?: string;
  recordId?: string;
  promptId?: string;
  promptLabel?: string;
  onSelectPrompt?: OpenTurnCalls;
  onOpenAgent?: (
    tool: ACPToolCall,
    sessionId: string,
    workspaceCwd?: string,
  ) => void;
  workspaceCwd?: string;
  onOpenFile?: (request: TurnOutputOpenRequest) => void;
}) {
  const { t } = useI18n();
  const { client: daemonClient } = useWorkspace();
  const connection = useConnection();
  const { sessionId } = connection;
  const cwd = connection.workspaceCwd ?? workspaceCwd;
  const client = useMemo(
    () => (cwd ? daemonClient.workspaceByCwd(cwd) : undefined),
    [daemonClient, cwd],
  );
  const ownerMatches =
    ownerSessionId === undefined || ownerSessionId === sessionId;
  const idle = usePromptStatus() === 'idle';
  const navigation = useTurnNavigationState();
  const blocks = useTranscriptBlocks();
  const user = blocks.find(
    (block) =>
      block.kind === 'user' &&
      ((recordId && block.sourceRecordIds?.includes(recordId)) ||
        (promptId && block.promptId === promptId) ||
        (!recordId && !promptId && block.id === turnId)),
  );
  const indexedTurn = [...navigation.indexPages.values()]
    .flatMap((page) => page.turns)
    .find((turn) =>
      recordId
        ? turn.turnId === recordId
        : promptId && turn.promptId === promptId,
    );
  const selectedRecordId =
    recordId ?? user?.sourceRecordIds?.[0] ?? indexedTurn?.turnId;
  const selectedPromptId = promptId ?? user?.promptId ?? indexedTurn?.promptId;
  // Sender echoes are suppressed; navigation still tracks their local block.
  const adoptedPromptId =
    recordId || promptId
      ? undefined
      : navigation.provisionalTurns.find((turn) => turn.blockId === turnId)
          ?.promptId;
  const adoptedRecordId =
    recordId || promptId || adoptedPromptId
      ? undefined
      : [...navigation.locations.values()].find(
          (location) => location.view === 'live' && location.blockId === turnId,
        )?.turnId;
  useEffect(() => {
    if (ownerMatches && (adoptedPromptId || adoptedRecordId))
      onSelectPrompt?.(turnId, adoptedRecordId, adoptedPromptId, promptLabel);
  }, [
    ownerMatches,
    adoptedPromptId,
    adoptedRecordId,
    onSelectPrompt,
    turnId,
    promptLabel,
  ]);
  const latestUser = [...blocks].reverse().find(isPromptStart);
  const latestPromptId =
    navigation.provisionalTurns.at(-1)?.promptId ??
    [...blocks]
      .reverse()
      .find(
        (block) =>
          isPromptStart(block) ||
          (block.kind === 'tool' && !block.backgroundTurn && block.promptId),
      )?.promptId;
  const running =
    !idle &&
    Boolean(
      (user && user.id === latestUser?.id) ||
        (selectedPromptId &&
          navigation.provisionalTurns.some(
            (turn) => turn.promptId === selectedPromptId,
          )) ||
        (!user && selectedPromptId && latestPromptId === selectedPromptId),
    );
  const [saved, setSaved] = useState<{
    recordId: string;
    sessionId: string;
    owner: object;
    turnId: string;
    rows: TurnCallRow[];
  }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<
    'turnCalls.loadError' | 'turnCalls.unresolved'
  >();
  const [indexError, setIndexError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [toolFilter, setToolFilter] = useState('all');
  useEffect(() => {
    if (
      !ownerMatches ||
      running ||
      !sessionId ||
      (!selectedRecordId && !promptId)
    ) {
      setLoading(false);
      setError(
        ownerMatches &&
          sessionId &&
          !running &&
          !user &&
          !selectedRecordId &&
          !promptId
          ? 'turnCalls.unresolved'
          : undefined,
      );
      return;
    }
    if (!client) {
      setLoading(false);
      setError('turnCalls.loadError');
      return;
    }
    let current = true;
    setLoading(true);
    setError(undefined);
    void (async () => {
      let resolvedRecordId = selectedRecordId;
      if (!resolvedRecordId) {
        let index = await client.getSessionTurnIndexPage(sessionId, {
          limit: WEB_SHELL_TURN_INDEX_PAGE_SIZE,
        });
        for (let page = 0; current && !resolvedRecordId; page += 1) {
          resolvedRecordId = index.turns.find(
            (turn) => turn.promptId === promptId,
          )?.turnId;
          if (resolvedRecordId || index.turns.length === 0 || index.start === 0)
            break;
          if (page >= 99) throw new Error('Turn index loading limit exceeded');
          index = await client.getSessionTurnIndexPage(sessionId, {
            snapshot: index.snapshot,
            start: Math.max(0, index.start - WEB_SHELL_TURN_INDEX_PAGE_SIZE),
            limit: Math.min(WEB_SHELL_TURN_INDEX_PAGE_SIZE, index.start),
          });
        }
      }
      if (!current) return;
      if (!resolvedRecordId) {
        setError('turnCalls.unresolved');
        return;
      }
      const calls = await loadTurnCalls(
        () => client.getSessionToolCalls(sessionId, resolvedRecordId),
        resolvedRecordId,
      );
      if (current)
        setSaved({
          recordId: resolvedRecordId,
          sessionId,
          owner: client,
          turnId,
          rows: calls.map((row) => ({
            block: row.block,
            depth: row.depth,
            durationMs: row.timing?.durationMs,
            startedAt: row.timing?.startedAt,
            recordedStatus: row.toolStatus,
          })),
        });
    })()
      .catch(() => {
        if (current) setError('turnCalls.loadError');
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [
    client,
    sessionId,
    turnId,
    selectedRecordId,
    promptId,
    running,
    retry,
    ownerMatches,
    user,
  ]);
  const rows = useMemo(() => {
    const savedRows =
      saved &&
      saved.turnId === turnId &&
      (!selectedRecordId || saved.recordId === selectedRecordId) &&
      saved.sessionId === sessionId &&
      saved.owner === client
        ? saved.rows
        : [];
    const merged = new Map(savedRows.map((row) => [row.block.toolCallId, row]));
    for (const row of collectTurnCallRows(blocks, user?.id, selectedPromptId)) {
      const saved = merged.get(row.block.toolCallId);
      if (
        saved &&
        isTerminalStatus(saved.recordedStatus ?? saved.block.status)
      ) {
        merged.set(row.block.toolCallId, {
          ...saved,
          startedAt: saved.startedAt ?? row.startedAt,
          durationMs: saved.durationMs ?? row.durationMs,
        });
        continue;
      }
      merged.set(row.block.toolCallId, {
        ...row,
        durationMs: saved?.durationMs ?? row.durationMs,
        startedAt: saved?.startedAt ?? row.startedAt,
        recordedStatus: saved?.recordedStatus,
      });
    }
    const children = new Map<string, TurnCallRow[]>();
    const roots: TurnCallRow[] = [];
    for (const row of merged.values()) {
      const parentId = row.block.parentToolCallId;
      if (parentId && merged.has(parentId)) {
        const siblings = children.get(parentId) ?? [];
        siblings.push(row);
        children.set(parentId, siblings);
      } else roots.push(row);
    }
    const ordered: TurnCallRow[] = [];
    const seen = new Set<string>();
    const stack = roots.reverse();
    while (stack.length) {
      const row = stack.pop()!;
      const id = row.block.toolCallId;
      if (seen.has(id)) continue;
      seen.add(id);
      ordered.push(row);
      for (const child of (children.get(id) ?? []).reverse()) stack.push(child);
    }
    // Malformed parent cycles must not hide calls.
    for (const [id, row] of merged) if (!seen.has(id)) ordered.push(row);
    return ordered;
  }, [
    blocks,
    user,
    saved,
    turnId,
    selectedRecordId,
    selectedPromptId,
    sessionId,
    client,
  ]);
  const typedRows = useMemo(
    () =>
      rows.map((row) => {
        const toolName =
          resolveToolCallName(row.block.toolName, row.block.rawInput) ||
          'unknown';
        const type =
          row.block.preview.kind === 'mcp_invocation' ||
          toolName.startsWith('mcp__')
            ? 'MCP'
            : localizeToolDisplayName(toolName, t);
        return { row, type };
      }),
    [rows, t],
  );
  const toolTypes = useMemo(
    () => [...new Set(typedRows.map(({ type }) => type))],
    [typedRows],
  );
  const selectedType = toolTypes.includes(toolFilter) ? toolFilter : 'all';
  useEffect(() => {
    if (toolFilter !== 'all' && !loading && !toolTypes.includes(toolFilter))
      setToolFilter('all');
  }, [toolFilter, toolTypes, loading]);
  const visibleRows = useMemo(
    () =>
      typedRows
        .filter(({ type }) => selectedType === 'all' || type === selectedType)
        .map(({ row }) => row),
    [typedRows, selectedType],
  );
  const openAgent = useCallback(
    (tool: ACPToolCall) => {
      if (sessionId) onOpenAgent?.(tool, sessionId, cwd);
    },
    [sessionId, onOpenAgent, cwd],
  );
  const notice =
    error || indexError ? (
      <div className={styles.notice} role="alert">
        {error && <span>{t(error)}</span>}
        {indexError && <span>{t('turnCalls.indexError')}</span>}
        <Button
          size="sm"
          variant="outline"
          onClick={() => setRetry((value) => value + 1)}
        >
          {t('history.retry')}
        </Button>
      </div>
    ) : loading ? (
      <div className={styles.notice} role="status">
        {t('turnCalls.loading')}
      </div>
    ) : null;
  if (!ownerMatches) return null;
  return (
    <section className={styles.panel} aria-label={t('turnCalls.title')}>
      <div className="flex min-w-0 items-center gap-2 pb-2">
        <TurnCallPromptSelect
          recordId={selectedRecordId}
          promptId={promptId}
          label={
            indexedTurn?.label ??
            promptLabel ??
            (user?.kind === 'user' ? user.text : undefined)
          }
          onSelect={onSelectPrompt}
          refreshKey={retry}
          onLoadError={setIndexError}
        />
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto shrink-0"
          disabled={loading}
          onClick={() => setRetry((value) => value + 1)}
        >
          <RefreshCwIcon size={14} aria-hidden="true" />
          {t('turnCalls.refresh')}
        </Button>
      </div>
      <div className={styles.summary}>
        <span className="shrink-0 whitespace-nowrap">
          {t('turnCalls.count', { count: rows.length })}
        </span>
        <Select value={selectedType} onValueChange={setToolFilter}>
          <SelectTrigger
            size="sm"
            className="ml-auto min-w-0 max-w-32 border-0 text-foreground"
            aria-label={t('turnCalls.filter')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('turnCalls.all')}</SelectItem>
            {toolTypes.map((type) => (
              <SelectItem key={type} value={type}>
                {type}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {notice}
      {rows.length === 0 && !notice && (
        <div className={styles.empty} data-web-shell-turn-calls-empty>
          {t('turnCalls.empty')}
        </div>
      )}
      <ul className={styles.list} data-web-shell-turn-calls>
        {visibleRows.map((row) => (
          <TurnCallRowItem
            key={`${turnId}:${row.block.toolCallId}`}
            {...row}
            workspaceCwd={cwd}
            onOpenFile={onOpenFile}
            onOpenAgent={sessionId && onOpenAgent ? openAgent : undefined}
          />
        ))}
      </ul>
    </section>
  );
}

const TurnCallRowItem = memo(function TurnCallRowItem({
  block,
  depth,
  durationMs,
  startedAt: recordedStart,
  recordedStatus,
  live,
  workspaceCwd,
  onOpenFile,
  onOpenAgent,
}: TurnCallRow & {
  onOpenAgent?: (tool: ACPToolCall) => void;
  workspaceCwd?: string;
  onOpenFile?: (request: TurnOutputOpenRequest) => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const status = recordedStatus ?? block.status;
  const tool = useMemo(() => daemonToolBlockToToolCall(block, false), [block]);
  const name =
    tool.toolName !== 'unknown'
      ? localizeToolDisplayName(tool.toolName, t)
      : t('turnCalls.tool');
  const isMcp =
    block.preview.kind === 'mcp_invocation' ||
    tool.toolName.startsWith('mcp__');
  const opensAgent = Boolean(
    onOpenAgent &&
      isSubAgentToolCall(tool) &&
      !getSubagentDetailsUnavailableReason(tool),
  );
  const fileTool =
    /^(read|read_file|readfile|edit|editfile|write|write_file|writefile)$/.test(
      tool.toolName.toLowerCase(),
    );
  const editTool = /^(edit|editfile|write|write_file|writefile)$/.test(
    tool.toolName.toLowerCase(),
  );
  const explicitDescription = tool.args?.description;
  const description = truncateText(
    sanitizeControlChars(
      (typeof explicitDescription === 'string' && explicitDescription.trim()) ||
        getToolSummaryDescription(tool, workspaceCwd),
    ),
    2000,
  );
  const isShell = isShellToolName(tool.toolName);
  const { diff, shell, argumentsText, resultText } = useMemo(() => {
    if (!expanded) return { diff: '', argumentsText: '', resultText: '' };
    const diff = editTool ? extractDiff(tool) : '';
    const shell = isShell ? shellDetails(tool) : undefined;
    return {
      diff,
      shell,
      argumentsText: shell ? shell.command : stringifyValue(block.rawInput),
      resultText: diff
        ? ''
        : shell
          ? shell.output
          : stringifyValue(block.rawOutput ?? block.content),
    };
  }, [
    expanded,
    editTool,
    isShell,
    tool,
    block.rawInput,
    block.rawOutput,
    block.content,
  ]);
  const hasDetails = Boolean(
    isShell ||
      block.rawInput != null ||
      block.rawOutput != null ||
      (Array.isArray(block.content)
        ? block.content.length
        : block.content != null),
  );
  const running = status === 'in_progress' || status === 'running';
  const terminal = isTerminalStatus(status);
  const startedAt = live ? block.clientReceivedAt : undefined;
  const hasLiveClock = startedAt !== undefined && startedAt > 0;
  const now = useSharedNow(Boolean(running && hasLiveClock));
  const duration =
    durationMs ??
    Math.max(0, (running ? now : block.updatedAt) - (startedAt ?? 0));
  const elapsed =
    running || terminal
      ? durationMs !== undefined || hasLiveClock
        ? duration < 1000
          ? `${Math.round(duration)}ms`
          : formatDurationMs(duration)
        : '—'
      : '';

  const timestamp = (value: number) =>
    `${formatTimestamp(value)}.${String(new Date(value).getMilliseconds()).padStart(3, '0')}`;
  const timingDescription =
    terminal && recordedStart !== undefined && durationMs !== undefined
      ? [
          t('turnCalls.startedAt', { time: timestamp(recordedStart) }),
          t('turnCalls.endedAt', {
            time: timestamp(recordedStart + durationMs),
          }),
        ]
      : [];
  const elapsedLabel = (
    <span
      className={styles.elapsed}
      aria-label={t('turnCalls.elapsed', { duration: elapsed })}
    >
      <Clock3Icon size={12} aria-hidden="true" />
      {elapsed}
    </span>
  );

  const header = (
    <>
      <span className={styles.rowContent}>
        <span className={styles.metadata}>
          <span className="shrink-0 text-foreground">
            <ToolSummaryIcon tool={tool} />
          </span>
          <span className={styles.tool}>{name}</span>
          {elapsed &&
            (timingDescription.length > 0 ? (
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>{elapsedLabel}</TooltipTrigger>
                  <TooltipContent side="top">
                    <div className="space-y-1">
                      {timingDescription.map((line) => (
                        <div key={line}>{line}</div>
                      ))}
                    </div>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : (
              elapsedLabel
            ))}
          <span className="ml-auto inline-flex shrink-0 items-center gap-1.5">
            {isMcp && (
              <Badge variant="outline" className="text-[11px] font-normal">
                MCP
              </Badge>
            )}
            <TurnCallStatusLabel status={status} />
          </span>
          {(hasDetails || opensAgent) && (
            <ChevronRightIcon
              size={14}
              strokeWidth={1.5}
              aria-hidden="true"
              className={`${styles.chevron}${expanded ? ` ${styles.chevronExpanded}` : ''}`}
            />
          )}
        </span>
      </span>
    </>
  );

  return (
    <li
      className={styles.item}
      style={{ '--turn-call-depth': depth } as CSSProperties}
      data-expanded={expanded || undefined}
    >
      {hasDetails || opensAgent ? (
        <button
          type="button"
          className={`${styles.header} ${styles.headerButton}`}
          aria-expanded={opensAgent ? undefined : expanded}
          aria-description={
            timingDescription.length ? timingDescription.join('\n') : undefined
          }
          onClick={() =>
            opensAgent ? onOpenAgent?.(tool) : setExpanded((value) => !value)
          }
        >
          {header}
        </button>
      ) : (
        <div className={styles.header}>{header}</div>
      )}
      {description && (
        <div className={styles.descriptionRow}>
          <span className={styles.object} title={description}>
            {description}
          </span>
          {fileTool && (
            <ToolFilePreviewButton
              iconOnly
              tool={tool}
              workspaceCwd={workspaceCwd}
              onOpen={onOpenFile}
            />
          )}
        </div>
      )}
      {expanded && hasDetails && (
        <div className={styles.details}>
          {argumentsText && (
            <>
              <div className={styles.detailLabel}>
                {t('turnCalls.arguments')}
              </div>
              <ToolCallDetail text={argumentsText} />
            </>
          )}
          {(shell || diff || resultText) && (
            <>
              <div
                className={`${styles.detailLabel} flex items-center gap-1.5`}
              >
                {t('turnCalls.result')}
              </div>
              {diff ? (
                <>
                  <DiffView diff={diff.slice(0, MAX_DETAIL_LENGTH)} />
                  {diff.length > MAX_DETAIL_LENGTH && (
                    <p className="text-xs text-muted-foreground">
                      {t('gitDiff.truncated')}
                    </p>
                  )}
                </>
              ) : (
                <ToolCallDetail
                  text={
                    resultText ||
                    t(
                      isActiveToolStatus(tool.status)
                        ? 'shell.result.waiting'
                        : 'shell.result.empty',
                    )
                  }
                />
              )}
            </>
          )}
          {shell?.other && (
            <details className={styles.other}>
              <summary>{t('turnCalls.other')}</summary>
              <pre className={styles.detailBody}>{shell.other}</pre>
            </details>
          )}
        </div>
      )}
    </li>
  );
});

/**
 * Show the reported outcome, including cancellation recorded as a failed tool block.
 */
function TurnCallStatusLabel({ status }: { status: string }) {
  const { t } = useI18n();
  if (status === 'completed' || status === 'success')
    return (
      <span className={`${styles.status} ${styles.completed}`}>
        <CheckCircle2Icon size={12} aria-hidden="true" />
        {t('turnCalls.completed')}
      </span>
    );
  if (status === 'failed' || status === 'error')
    return (
      <span className={`${styles.status} ${styles.failed}`}>
        <CircleXIcon size={12} aria-hidden="true" />
        {t('tool.status.failed')}
      </span>
    );
  if (status === 'in_progress' || status === 'running') {
    return (
      <span className={styles.status}>
        <Spinner className="size-3" aria-hidden="true" />
        {t('turnCalls.running')}
      </span>
    );
  }
  if (status === 'cancelled' || status === 'canceled') {
    return (
      <span className={`${styles.status} text-[var(--warning-color)]`}>
        <CircleSlashIcon size={12} aria-hidden="true" />
        {t('turnCalls.cancelled')}
      </span>
    );
  }
  if (status === 'pending') {
    return (
      <span className={styles.status}>
        <Clock3Icon size={12} aria-hidden="true" />
        {t('turnCalls.pending')}
      </span>
    );
  }
  return <span className={styles.status}>{t('turnCalls.unknown')}</span>;
}
